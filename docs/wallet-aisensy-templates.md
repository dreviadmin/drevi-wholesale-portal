# AiSensy templates for the Drevi Wallet — drafts

Three templates to submit in AiSensy → Templates, then one **API campaign**
each (AiSensy → Campaigns → API Campaign), whose names go into the portal env
as `AISENSY_CAMPAIGN_OTP`, `AISENSY_CAMPAIGN_WELCOME`, `AISENSY_CAMPAIGN_BALANCE`.

Meta approves templates by category, and the category decides two things: an
**Authentication** template is the only kind allowed to carry a one-time code
(and its body is fixed by Meta — you pick the options, not the words); a
**Marketing** template can only go to numbers that have opted in. The welcome
is marketing. The balance reply is a utility, because the customer asked.

Parameters are positional: `{{1}}`, `{{2}}`, … in the order the portal sends
them (`src/lib/wallet-whatsapp.ts`).

---

## 1. `drevi_wallet_otp` — category **Authentication**

Meta's fixed authentication body. In AiSensy choose:

- Code delivery: **Copy code** button
- Add security recommendation: on
- Code expiry: **10 minutes**
- Language: English

Renders roughly as:

> **{{1}}** is your Drevi verification code. For your security, do not share this code.
> This code expires in 10 minutes.
> [ Copy code ]

Portal sends: `templateParams: [code]`.

---

## 2. `drevi_wallet_welcome` — category **Marketing**

**Header:** none (or the gold-on-black logo as an image header, optional)

**Body:**

> Hello {{1}}, welcome to the Drevi Wallet.
>
> There is **{{2}}** in it, from us — use it on any order of ₹5,000 or more, on drevifashion.com. Just enter this number in the bag.
>
> Every order you receive adds 10% of what you paid back into the wallet. It stays yours for 12 months from your last credit.

**Footer:** Reply STOP to opt out.

**Buttons:**
- URL: **Open my wallet** → `https://drevifashion.com/pages/wallet`
- Quick reply: **Balance**

Portal sends: `templateParams: [name, "₹1,000"]`.

---

## 3. `drevi_wallet_balance` — category **Utility**

**Body:**

> Hello {{1}}. Your Drevi Wallet balance is **{{2}}**, valid until {{3}}.
>
> Use it on any order of ₹5,000 or more — enter your number in the bag on drevifashion.com.

**Buttons:**
- URL: **See statement** → `https://drevifashion.com/pages/wallet`

Portal sends: `templateParams: [name, balance, expiryDate]`.

To answer a customer who taps **Balance** or types it, the AiSensy flow needs
a webhook step that calls the portal — that lookup endpoint isn't built yet
(it needs a shared secret between AiSensy and the portal); until then the
wallet page is the balance check.

---

## Notes for submission

- Keep the marketing body under ~1,000 characters and avoid words Meta's
  reviewers flag ("free", "guaranteed", all-caps).
- Sample values help approval: `{{1}}` = *Priya*, `{{2}}` = *₹1,000*,
  `{{3}}` = *26 Sep 2027*.
- Approval usually lands within a day, sometimes a few hours. Nothing sends
  from the portal until `WALLET_WA_LIVE=true`, so the templates can be
  created and approved well before launch.
