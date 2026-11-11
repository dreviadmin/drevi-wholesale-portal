#!/usr/bin/env python3
"""Drevi Wallet end-to-end check, against a running portal and the live store.

  python3 scripts/wallet-e2e/wallet_e2e.py --target dev            # portal on http://localhost:3000, dev Supabase
  python3 scripts/wallet-e2e/wallet_e2e.py --target prod           # the prod portal and prod Supabase
  python3 scripts/wallet-e2e/wallet_e2e.py --target dev --cleanup  # only sweep leftovers of earlier runs

It creates two throwaway Shopify customers (wallet-test+<run><a|b>@drevifashion.com,
tag wallet-test), opens their wallets through the portal, reserves and
releases wallet discounts, drives two real storefront carts, and checks what
Shopify and the database say at each step. Then it deletes everything it
made: the discounts, the wallet rows, and the customers (phone and tags
stripped first). See README.md next to this file for what it checks and what
it touches. It reads secrets from env files and never prints them; it holds
no secrets and no customer data itself.
"""
import argparse
import concurrent.futures
import hashlib
import hmac
import http.cookiejar
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGETS = {
    # env files are read in order; the first file that sets a name wins.
    'dev': {'base': 'http://localhost:3000', 'ref': 'qvnvxcdyvcsgxulbcmzm', 'env': ['.env.development.local']},
    'prod': {'base': 'https://drevi-wholesale-portal-swart.vercel.app', 'ref': 'cofarxgywnrdjbizxbxw', 'env': ['.env.local', '.env.development.local']},
}
NEEDED = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WALLET_STOREFRONT_SECRET',
          'SHOPIFY_STORE_DOMAIN', 'WALLET_SHOPIFY_CLIENT_ID', 'WALLET_SHOPIFY_CLIENT_SECRET']
STOREFRONT = 'https://drevifashion.com'
API = '2026-01'
TEST_TAG = 'wallet-test'
EMAIL_PREFIX = 'wallet-test+'
EMAIL_DOMAIN = '@drevifashion.com'
TEST_NAMES = ('Wallet E2E A', 'Wallet E2E B')
OLD_TEST_NAMES = ('Test Wallet', 'Test Second')  # the October runs
WALLET_TITLE = 'Drevi Wallet'
TOKEN_MAX_AGE_H = 2  # src/lib/wallet-token.ts TOKEN_MAX_AGE_S
RNG = random.SystemRandom()

ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
ap.add_argument('--target', choices=sorted(TARGETS), required=True)
ap.add_argument('--env', action='append', metavar='FILE', help='env file to read (repeatable; replaces the defaults; relative paths are from the repo root)')
ap.add_argument('--base', help='portal base URL (default: the target\'s)')
ap.add_argument('--cleanup', action='store_true', help='sweep leftovers of earlier runs and exit')
ap.add_argument('--skip-bag', action='store_true', help='skip the 8 checks on real storefront carts (when drevifashion.com answers the script with 429)')
args = ap.parse_args()
T = TARGETS[args.target]


def load_env(files):
    env = {}
    for f in files:
        p = Path(f) if Path(f).is_absolute() else REPO / f
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            m = re.match(r'^\s*([A-Z0-9_]+)\s*=\s*(.*)$', line)
            if m and m[1] not in env:
                env[m[1]] = m[2].strip().strip('"').strip("'")
    return env


ENV = load_env(args.env or T['env'])
missing = [k for k in NEEDED if not ENV.get(k)]
if missing:
    sys.exit(f"missing {', '.join(missing)} in {args.env or T['env']} (from {REPO}); pass --env <file>")
SB, SK = ENV['NEXT_PUBLIC_SUPABASE_URL'], ENV['SUPABASE_SERVICE_ROLE_KEY']
# Never run the dev suite against prod data or the other way round.
assert T['ref'] in SB, f"{args.target} needs the Supabase project {T['ref']}; the env files point elsewhere"
SECRET = ENV['WALLET_STOREFRONT_SECRET']
SHOP = ENV['SHOPIFY_STORE_DOMAIN']
BASE = (args.base or T['base']).rstrip('/')
ORIGIN = STOREFRONT
RUN = str(int(time.time()))[-6:]


# ---- Shopify Admin (the Drevi Admin Automation app, as the portal uses) ----

_tok = {}


def admin_token():
    if 'v' not in _tok:
        body = urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': ENV['WALLET_SHOPIFY_CLIENT_ID'],
                                       'client_secret': ENV['WALLET_SHOPIFY_CLIENT_SECRET']}).encode()
        req = urllib.request.Request(f'https://{SHOP}/admin/oauth/access_token', data=body, method='POST',
                                     headers={'Content-Type': 'application/x-www-form-urlencoded'})
        with urllib.request.urlopen(req, timeout=60) as r:
            _tok['v'] = json.load(r)['access_token']
    return _tok['v']


def gql(q, v=None):
    req = urllib.request.Request(f'https://{SHOP}/admin/api/{API}/graphql.json', method='POST',
                                 data=json.dumps({'query': q, 'variables': v or {}}).encode(),
                                 headers={'X-Shopify-Access-Token': admin_token(), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if d.get('errors'):
        raise RuntimeError(json.dumps(d['errors'])[:300])
    return d['data']


def auto(gid):
    n = gql('query($id:ID!){ automaticDiscountNode(id:$id){ id automaticDiscount{ __typename ... on DiscountAutomaticBasic{ title status startsAt endsAt'
            ' context{ __typename ... on DiscountCustomers{ customers{ id } } } minimumRequirement{ ... on DiscountMinimumSubtotal{ greaterThanOrEqualToSubtotal{ amount } } }'
            ' customerGets{ value{ ... on DiscountAmount{ amount{ amount } appliesOnEachItem } } } combinesWith{ orderDiscounts productDiscounts shippingDiscounts } } } } }', {'id': gid})
    return n['automaticDiscountNode']


def customer(cid):
    return gql('query($id:ID!){ customer(id:$id){ id email phone tags numberOfOrders } }', {'id': cid})['customer']


def create_test_customer(letter):
    email = f'{EMAIL_PREFIX}{RUN}{letter}{EMAIL_DOMAIN}'
    r = gql('mutation($i:CustomerInput!){ customerCreate(input:$i){ customer{ id } userErrors{ message } } }',
            {'i': {'email': email, 'tags': [TEST_TAG]}})['customerCreate']
    if not r['customer']:
        raise RuntimeError(f"customerCreate: {r['userErrors']}")
    return r['customer']['id']


def strip_and_delete(cid):
    """Take the phone and every tag off the customer, then delete it.

    Stripping first means anything synced from Shopify (the AiSensy app) last
    sees the record without a phone or wa-opt-in.
    """
    problems = []
    c = customer(cid)
    if not c:
        return problems
    if c.get('phone'):
        e = gql('mutation($i:CustomerInput!){ customerUpdate(input:$i){ userErrors{ message } } }', {'i': {'id': cid, 'phone': None}})['customerUpdate']['userErrors']
        problems += [f"clear phone: {x['message']}" for x in e]
    if c.get('tags'):
        e = gql('mutation($id:ID!,$t:[String!]!){ tagsRemove(id:$id, tags:$t){ userErrors{ message } } }', {'id': cid, 't': c['tags']})['tagsRemove']['userErrors']
        problems += [f"remove tags: {x['message']}" for x in e]
    e = gql('mutation($i:CustomerDeleteInput!){ customerDelete(input:$i){ userErrors{ message } } }', {'i': {'id': cid}})['customerDelete']['userErrors']
    problems += [f"delete: {x['message']}" for x in e]
    return problems


def delete_discount(gid):
    if gid and auto(gid):
        gql('mutation($id:ID!){ discountAutomaticDelete(id:$id){ userErrors{ message } } }', {'id': gid})


def wallet_discounts():
    """Every wallet automatic discount that still exists: (id, title, status, customer ids)."""
    out, after = [], None
    while True:
        d = gql('query($a:String){ automaticDiscountNodes(first:100, after:$a){ nodes{ id automaticDiscount{ ... on DiscountAutomaticBasic{ title status'
                ' context{ __typename ... on DiscountCustomers{ customers{ id } } } } } } pageInfo{ hasNextPage endCursor } } }', {'a': after})['automaticDiscountNodes']
        for n in d['nodes']:
            a = n['automaticDiscount'] or {}
            title = a.get('title') or ''
            if title == WALLET_TITLE or title.startswith(WALLET_TITLE + ' '):
                ctx = a.get('context') or {}
                out.append((n['id'], title, a.get('status'), [c['id'] for c in ctx.get('customers', [])] if ctx.get('__typename') == 'DiscountCustomers' else None))
        if not d['pageInfo']['hasNextPage']:
            break
        after = d['pageInfo']['endCursor']
    # The list comes from a search index that lags a second or two; keep only nodes that really exist.
    return [x for x in out if auto(x[0])]


def test_customers():
    """Customers made by this script: tag wallet-test and a wallet-test+…@drevifashion.com email."""
    found = {}
    for q in (f'tag:{TEST_TAG}', 'email:wallet-test*'):
        d = gql('query($q:String!){ customers(first:100, query:$q){ nodes{ id email tags numberOfOrders } } }', {'q': q})['customers']['nodes']
        for c in d:
            email = (c.get('email') or '').lower()
            if email.startswith(EMAIL_PREFIX) and email.endswith(EMAIL_DOMAIN):
                found[c['id']] = c
    return found


# ---- Supabase (service role, the target's project) ----

def sb(path, method='GET'):
    if '?' in path:
        b, q = path.split('?', 1)
        path = b + '?' + '&'.join(k + '=' + urllib.parse.quote(v, safe='.,*()') for k, v in (x.split('=', 1) for x in q.split('&')))
    req = urllib.request.Request(f'{SB}/rest/v1/{path}', method=method, headers={'apikey': SK, 'Authorization': 'Bearer ' + SK, 'Prefer': 'return=representation'})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def drop_wallet_rows(account_ids):
    for aid in account_ids:
        for r in sb(f'wallet_redemptions?account_id=eq.{aid}&select=shopify_discount_id') or []:
            delete_discount(r['shopify_discount_id'])
        sb(f'wallet_redemptions?account_id=eq.{aid}', 'DELETE')
        sb(f'wallet_ledger?account_id=eq.{aid}', 'DELETE')
        sb(f'wallet_accounts?id=eq.{aid}', 'DELETE')


# ---- Phones: never a number someone already has ----

def phone_taken(ten):
    """Whether +91<ten> is on any Shopify customer, or on a wallet in the target database."""
    full = '91' + ten
    hits = gql('query($q:String!){ customers(first:5, query:$q){ nodes{ id } } }', {'q': f'phone:+{full} OR phone:{full}'})['customers']['nodes']
    if hits:
        return 'shopify'
    if sb(f'wallet_accounts?phone=eq.{full}&select=id'):
        return 'wallet'
    return None


def fresh_phone():
    for _ in range(20):
        p = RNG.choice('6789') + ''.join(RNG.choice('0123456789') for _ in range(9))
        if not phone_taken(p):
            return p
    raise RuntimeError('no unused phone number after 20 tries')


# ---- The portal, as the theme calls it ----

def tok(cid_tail, age_s=0):
    ts = int(time.time()) - age_s
    msg = f'{cid_tail}.{ts}'
    return msg + '.' + hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()


def call(method, path, body=None, token=None):
    h = {'Content-Type': 'application/json', 'Origin': ORIGIN}
    if token:
        h['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b'{}')
        except Exception:
            return e.code, {'raw': raw[:200].decode(errors='replace')}


def shopper():
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def s(path, body=None):
        for attempt in range(3):
            req = urllib.request.Request(ORIGIN + path, method='POST' if body is not None else 'GET', data=json.dumps(body).encode() if body is not None else None,
                                         headers={'User-Agent': 'Mozilla/5.0 (wallet e2e)', 'Accept': 'application/json', **({'Content-Type': 'application/json'} if body is not None else {})})
            try:
                with op.open(req, timeout=60) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                # The cart API rate-limits a burst (429 with Retry-After): wait as asked, then try again.
                if e.code != 429 or attempt == 2:
                    raise
                wait = min(65.0, float(e.headers.get('Retry-After') or 30))
                print(f'  (storefront asked to wait {wait:.0f} s on {path.split("?")[0]})')
                time.sleep(wait)
    return s


def bag_variant():
    """(variant id, price in paise) of an in-stock ₹5,000+ variant on the store.

    From the Admin API: since November 2026 the storefront's /products.json
    answers a script with 429 (the cart endpoints still work).
    """
    d = gql('{ products(first:50, query:"status:active AND published_status:published", sortKey:UPDATED_AT, reverse:true){'
            ' nodes{ variants(first:20){ nodes{ legacyResourceId price availableForSale } } } } }')['products']['nodes']
    for p in d:
        for v in p['variants']['nodes']:
            if v['availableForSale'] and float(v['price']) >= 5000:
                return int(v['legacyResourceId']), round(float(v['price']) * 100)
    raise RuntimeError('no in-stock variant of ₹5,000 or more among the 50 latest products')


def wallet_on(s):
    c = s('/cart/update.js', {'attributes': {'_drevi_wallet': 'e2e-' + str(time.time())}})
    # /cart/update.js wraps each entry ({amount, discount_application:{title…}}); /cart.js returns them flat
    apps = [(a.get('discount_application') or a) for a in c.get('cart_level_discount_applications', [])]
    return [(a.get('title'), a.get('total_allocated_amount')) for a in apps if (a.get('title') or '').startswith(WALLET_TITLE)], c['total_price']


results = []
SKIPPED = 0


def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + (('  | ' + json.dumps(detail, default=str)[:400]) if detail and not cond else ''))


def leftovers():
    """(wallet-test customers, active wallet discounts, of those on test customers), retried while Shopify's index catches up."""
    for attempt in range(6):
        tc = test_customers()
        wd = [d for d in wallet_discounts() if d[2] == 'ACTIVE']
        on_test = [d for d in wd if d[3] and all(c in tc for c in d[3])]
        if not tc and not on_test:
            break
        time.sleep(3)
    return tc, wd, on_test


def sweep():
    """--cleanup: remove what earlier runs left behind. Touches only this script's own customers."""
    tc = test_customers()
    removed = {'customers': 0, 'discounts': 0, 'wallets': 0}
    # Wallet discounts that belong only to test customers.
    for gid, title, status, cust in wallet_discounts():
        if cust and all(c in tc for c in cust):
            delete_discount(gid)
            removed['discounts'] += 1
            print(f'deleted discount {title} ({status})')
        elif cust == []:
            print(f'NOT deleted, check by hand: {title} ({status}) has no customer left; it may belong to a deleted test customer or to a real one')
    # Wallet rows of test customers, and test-named rows whose customer is gone.
    ids = set()
    if tc:
        for a in sb('wallet_accounts?shopify_customer_id=in.(' + ','.join(tc) + ')&select=id') or []:
            ids.add(a['id'])
    names = ','.join('"' + n + '"' for n in TEST_NAMES + OLD_TEST_NAMES)
    for a in sb(f'wallet_accounts?name=in.({names})&select=id,shopify_customer_id') or []:
        if a['shopify_customer_id'] in tc or (a['shopify_customer_id'] and not customer(a['shopify_customer_id'])):
            ids.add(a['id'])
    drop_wallet_rows(ids)
    removed['wallets'] = len(ids)
    for cid, c in tc.items():
        if str(c.get('numberOfOrders') or '0') != '0':
            print(f"NOT deleted: {c['email']} has orders")
            continue
        problems = strip_and_delete(cid)
        removed['customers'] += 1
        if problems:
            print(f"{c['email']}: {'; '.join(problems)}")
    return removed


if args.cleanup:
    print(f'cleanup ({args.target}, Supabase {T["ref"]})')
    r = sweep()
    tc, wd, on_test = leftovers()
    print(f"removed {r['customers']} test customers, {r['discounts']} wallet discounts, {r['wallets']} wallet rows; "
          f"left: {len(tc)} wallet-test customers, {len(wd)} active 'Drevi Wallet' discounts ({len(on_test)} on test customers)")
    sys.exit(0 if not tc and not on_test else 1)

print(f'wallet e2e ({args.target}): portal {BASE}, Supabase {T["ref"]}, store {SHOP}')
created = []
try:
    # --- joining: a throwaway customer, an unused number, no WhatsApp consent ---
    cid = create_test_customer('a')
    created.append(cid)
    n = cid.rsplit('/', 1)[1]
    phone = fresh_phone()
    st, b = call('POST', '/api/wallet/join', {'name': TEST_NAMES[0], 'phone': phone, 'consent': False}, token=tok(n))
    check('wallet opened for test customer', st == 200 and b['wallet']['balance_paise'] == 100000, (st, b))
    c = customer(cid)
    acc = sb(f'wallet_accounts?shopify_customer_id=eq.{cid}&select=id,phone,wa_opt_in_at')[0]
    check('the test customer carries no wa-opt-in, and the wallet no WhatsApp consent', 'wa-opt-in' not in c['tags'] and acc['wa_opt_in_at'] is None, (c['tags'], acc['wa_opt_in_at']))
    taken = phone_taken(phone)
    check('the phone pre-check rejects a number in use (planted: this customer\'s own)', taken in ('shopify', 'wallet'), taken)
    other = fresh_phone()
    st, b = call('POST', '/api/wallet/join', {'name': 'Someone Else', 'phone': other, 'consent': False}, token=tok(n))
    c2 = customer(cid)
    acc2 = sb(f'wallet_accounts?shopify_customer_id=eq.{cid}&select=id,phone')[0]
    check('joining again with another number changes nothing', st == 200 and b.get('created') is False and c2['phone'] == c['phone'] == '+91' + phone
          and acc2['phone'] == '91' + phone and c2['tags'] == c['tags'], (st, b.get('created'), c2['phone'], acc2['phone']))
    st, b = call('GET', '/api/wallet/me?orders=0', token=tok(n, age_s=(TOKEN_MAX_AGE_H + 1) * 3600))
    check(f'a token older than {TOKEN_MAX_AGE_H} h is refused', st == 401, (st, b))

    # --- the reservation: a customer-limited automatic discount ---
    st, b = call('POST', '/api/wallet/redeem', {'subtotal_paise': 1599900, 'amount_paise': 100000, 'cart_token': 'auto-e2e'}, token=tok(n))
    check('use wallet -> ok', st == 200 and b.get('ok'), (st, b))
    red = sb(f"wallet_redemptions?account_id=eq.{acc['id']}&status=eq.open&select=id,code,shopify_discount_id,expires_at")
    did = red[0]['shopify_discount_id'] if red else None
    check('redemption open, linked to an AUTOMATIC discount', did and 'DiscountAutomaticNode' in did, red)
    a = auto(did)['automaticDiscount'] if did else {}
    check('discount is ACTIVE and titled "Drevi Wallet · <code>"', a.get('status') == 'ACTIVE' and a.get('title') == 'Drevi Wallet · ' + red[0]['code'], (a.get('title'), red and red[0]['code']))
    check('limited to this customer only', a.get('context', {}).get('__typename') == 'DiscountCustomers' and [x['id'] for x in a['context']['customers']] == [cid], a.get('context'))
    check('₹1,000 off the order, ₹5,000 minimum', a.get('customerGets', {}).get('value', {}).get('amount', {}).get('amount') in ('1000.0', '1000.00')
          and a['customerGets']['value']['appliesOnEachItem'] is False and float(a['minimumRequirement']['greaterThanOrEqualToSubtotal']['amount']) == 5000.0, a)
    hrs = (time.mktime(time.strptime(a['endsAt'][:19], '%Y-%m-%dT%H:%M:%S')) - time.mktime(time.strptime(a['startsAt'][:19], '%Y-%m-%dT%H:%M:%S'))) / 3600 if a.get('endsAt') else 0
    check('ends two hours after it starts', abs(hrs - 2.0) < 0.02, (a.get('startsAt'), a.get('endsAt')))
    check('does not stack with other order discounts', a.get('combinesWith', {}).get('orderDiscounts') is False, a.get('combinesWith'))

    # --- the 3 Oct bag failure: Shopify shows a customer-limited discount only on an identified cart ---
    if args.skip_bag:
        SKIPPED += 8
        print('SKIP 8 checks on real storefront carts (--skip-bag)')
    else:
        vid, price = bag_variant()
        sA = shopper()
        sA('/cart/add.js', {'items': [{'id': vid, 'quantity': 1}]})
        tokA = sA('/cart.js')['token']
        st, b = call('POST', '/api/wallet/redeem', {'subtotal_paise': price, 'amount_paise': 100000, 'cart_token': tokA}, token=tok(n))
        check('use wallet with a real cart -> identified', st == 200 and b.get('identified') is True, (st, b))
        apps, total = wallet_on(sA)
        check('the cart shows "Drevi Wallet · <code>" −₹1,000 after one update', apps == [('Drevi Wallet · ' + b.get('code', ''), 100000)] and total == price - 100000, (apps, total, price))
        st, m = call('GET', '/api/wallet/me?orders=0', token=tok(n))
        check('/me reports the open reservation and ₹0 available', st == 200 and (m.get('redemption') or {}).get('code') == b.get('code') and m.get('wallet', {}).get('available_paise') == 0, (st, m.get('redemption'), m.get('wallet')))
        sB = shopper()
        sB('/cart/add.js', {'items': [{'id': vid, 'quantity': 1}]})
        tokB = sB('/cart.js')['token']
        check('a second device does not show it by itself', wallet_on(sB)[0] == [])
        st, x = call('POST', '/api/wallet/cart', {'cart_token': tokB}, token=tok(n))
        check('/api/wallet/cart identifies the second cart', st == 200 and x.get('identified') is True and (x.get('redemption') or {}).get('code') == b.get('code'), (st, x))
        check('...and now it shows the line too', wallet_on(sB)[0] == [('Drevi Wallet · ' + b.get('code', ''), 100000)])
        st, _ = call('DELETE', '/api/wallet/redeem', token=tok(n))
        check('remove clears it from both carts on their next update', st == 200 and wallet_on(sA)[0] == [] and wallet_on(sB)[0] == [])
        st, x = call('POST', '/api/wallet/cart', {'cart_token': tokA}, token=tok(n))
        check('/api/wallet/cart with nothing open says so', st == 200 and x.get('identified') is False and x.get('redemption') is None, (st, x))
    st, b = call('POST', '/api/wallet/redeem', {'subtotal_paise': 1599900, 'amount_paise': 100000, 'cart_token': 'auto-e2e'}, token=tok(n))
    check('a label instead of a token: still ok, just not identified', st == 200 and b.get('ok') and b.get('identified') is False, (st, b))
    red = sb(f"wallet_redemptions?account_id=eq.{acc['id']}&status=eq.open&select=id,code,shopify_discount_id,expires_at")
    did = red[0]['shopify_discount_id']
    if not args.skip_bag:
        sA('/cart/clear.js', {})
        sB('/cart/clear.js', {})
    # re-apply replaces
    st, b = call('POST', '/api/wallet/redeem', {'subtotal_paise': 1599900, 'amount_paise': 50000}, token=tok(n))
    red2 = sb(f"wallet_redemptions?account_id=eq.{acc['id']}&status=eq.open&select=shopify_discount_id")
    gone = auto(did) is None
    check('applying again replaces it (old deleted, one open)', st == 200 and len(red2) == 1 and red2[0]['shopify_discount_id'] != did and gone, (st, red2, gone))

    # --- the 3 Oct failure: a second shopper applies while the first still holds a discount ---
    cid2 = create_test_customer('b')
    created.append(cid2)
    n2 = cid2.rsplit('/', 1)[1]
    call('POST', '/api/wallet/join', {'name': TEST_NAMES[1], 'phone': fresh_phone(), 'consent': False}, token=tok(n2))
    with concurrent.futures.ThreadPoolExecutor(2) as ex:
        f1 = ex.submit(call, 'POST', '/api/wallet/redeem', {'subtotal_paise': 1200000, 'amount_paise': 100000, 'cart_token': 'two-a'}, tok(n))
        f2 = ex.submit(call, 'POST', '/api/wallet/redeem', {'subtotal_paise': 1300000, 'amount_paise': 100000, 'cart_token': 'two-b'}, tok(n2))
        (sa, ba), (sbb, bb) = f1.result(), f2.result()
    check('two shoppers can hold wallet discounts at once', sa == 200 and sbb == 200 and ba.get('ok') and bb.get('ok'), (sa, ba, sbb, bb))
    acc_b = sb(f'wallet_accounts?shopify_customer_id=eq.{cid2}&select=id')[0]
    ids = [r['shopify_discount_id'] for r in sb(f"wallet_redemptions?account_id=in.({acc['id']},{acc_b['id']})&status=eq.open&select=shopify_discount_id")]
    nodes = [auto(i) for i in ids]
    titles = [(x or {}).get('automaticDiscount', {}).get('title') for x in nodes]
    sts = [(x or {}).get('automaticDiscount', {}).get('status') for x in nodes]
    check('both discounts exist in Shopify, ACTIVE, with distinct titles', len(titles) == 2 and len(set(titles)) == 2 and all(t and t.startswith('Drevi Wallet · WLT-') for t in titles) and sts == ['ACTIVE', 'ACTIVE'], (titles, sts))
    call('DELETE', '/api/wallet/redeem', token=tok(n2))
    red2 = sb(f"wallet_redemptions?account_id=eq.{acc['id']}&status=eq.open&select=shopify_discount_id")
    did2 = red2[0]['shopify_discount_id']
    st, b = call('DELETE', '/api/wallet/redeem', token=tok(n))
    check('remove deletes the discount', st == 200 and auto(did2) is None and not sb(f"wallet_redemptions?account_id=eq.{acc['id']}&status=eq.open&select=id"))
    st, b = call('POST', '/api/wallet/redeem', {'subtotal_paise': 499900, 'amount_paise': 50000}, token=tok(n))
    check('₹4,999 bag still refused', st == 422, (st, b))
finally:
    # Everything this run made: the wallets' discounts and rows, then the customers (stripped first).
    if created:
        rows = sb('wallet_accounts?shopify_customer_id=in.(' + ','.join(created) + ')&select=id') or []
        drop_wallet_rows([r['id'] for r in rows])
    for c in created:
        for p in strip_and_delete(c):
            print(f'cleanup {c}: {p}')
    tc, wd, on_test = leftovers()
    print(f"\n{sum(results)}/{len(results)} passed ({args.target}){f', {SKIPPED} skipped' if SKIPPED else ''}; test data removed; "
          f"active 'Drevi Wallet' automatic discounts left: {len(wd)} (on test customers: {len(on_test)}); wallet-test customers left: {len(tc)}")
    if tc or on_test:
        print('leftovers found: run again with --cleanup')
# 0: every check passed; 1: a check failed; 3: all that ran passed, some were skipped.
sys.exit(1 if not results or not all(results) else 3 if SKIPPED else 0)
