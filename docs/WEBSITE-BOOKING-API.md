# Website booking API

The booking box on drevifashion.com (first: store visits on `/pages/visit`)
talks to the portal through two public routes. Bookings land in the same
tables as staff bookings and show up at once in the portal under
**Home › Appointments**, marked "Website".

- **Prod portal origin:** `https://drevi-wholesale-portal-swart.vercel.app`
- **Dev portal origin (dev database, for testing):** `https://drevi-wholesale-dev.vercel.app`

The origin belongs in a theme setting, never in visible page text or a link.
Golden rule 7: the portal is never linked from the website. The wallet
already works this way, with `settings.drevi_wallet_api`.

## Who may call it (CORS)

The browser may read the responses only from these origins:

- `https://drevifashion.com`
- `https://www.drevifashion.com`
- `https://uqc34b-5y.myshopify.com`

If the `WALLET_ALLOWED_ORIGINS` env var is set on the Vercel project, its
list replaces these three. Shopify "share preview" links
(`https://<id>.shopifypreview.com`) are allowed as well.

A theme preview opened as `drevifashion.com/?preview_theme_id=…` counts as
`https://drevifashion.com`, so it works against both dev and prod.

Rules for `POST /api/appointments/book`:

- It must send `Content-Type: application/json`, or it gets `415`.
- It must carry an allowed `Origin`, which a browser on the site always
  does. A missing or unlisted `Origin` gets `403`.

## Times

- Every time is India time (`Asia/Kolkata`).
- A day is a `YYYY-MM-DD` string.
- A time is `min`: minutes after midnight (for example `840` is 2 pm).
- Each day's and slot's `label`, `long`, `hours`, `time` and `when` are
  ready-made English for display.

## GET /api/appointments/availability

Query parameters:

| param | default | |
|---|---|---|
| `type` | `store` | `store` (store visit), `video` (video call shopping) or `design` (custom design consultation) |
| `party` | `solo` | `solo` is "just me" (30 min). `group` is "me + family or friends" (45 min for a store visit). |
| `place` | the type's first | `store`. Video calls take `wa` or `meet`. |
| `from` | today | `YYYY-MM-DD`. A date before today counts as today. |
| `days` | `14` | 1 to 31. The list stops at the type's booking window (60 days). |

**200** example:

```json
{
  "ok": true,
  "today": "2026-11-16",
  "timezone": "Asia/Kolkata",
  "type": { "id": "store", "name": "Store visit", "minutes": 30, "group_minutes": 45, "notice_hours": 1, "window_days": 60, "places": ["store"] },
  "place": "store",
  "party": "solo",
  "duration_minutes": 30,
  "last_day": "2027-01-15",
  "confirm": "instant",
  "days": [
    { "day": "2026-11-16", "label": "Mon 16 Nov", "long": "Monday 16 November", "closed": false, "note": null, "hours": "12 pm to 8 pm",
      "slots": [ { "min": 840, "time": "2 pm", "free": true }, { "min": 870, "time": "2:30 pm", "free": false } ], "free": 11 },
    { "day": "2026-11-22", "label": "Sun 22 Nov", "long": "Sunday 22 November", "closed": false, "note": null, "hours": "1 pm to 7 pm", "slots": [], "free": 0 }
  ]
}
```

- `slots` lists every start time the website may offer that day: inside
  opening hours, at least `notice_hours` from now, and ending by closing.
  `free: false` means that time is taken. You can grey it out or hide it.
- On a day that has already closed, `slots` is empty and `free` is `0`.
- On a closed day, `closed` is `true`. `note` carries special-day text such
  as "Diwali", when there is any.
- `confirm`:
  - `"instant"`: a booking is confirmed straight away (the default).
  - `"staff"`: a booking is "pencilled in", and the team confirms it on
    WhatsApp.
- Errors return `{ "ok": false, "code": "...", "error": "<a sentence you can show>" }`:
  - `404 type_off`: online booking for that type is switched off.
  - `400 bad_request`
  - `503 not_set_up`

## POST /api/appointments/book

Request body (JSON):

```json
{
  "type": "store",
  "party": "solo",
  "place": "store",
  "day": "2026-11-18",
  "min": 840,
  "name": "Ananya Mehta",
  "phone": "98765 43210",
  "country": "+91",
  "email": "",
  "functions": ["Sangeet", "Reception or wedding day"],
  "function_date": "mid-December",
  "looking_for": "Pastel lehenga for my sangeet",
  "whatsapp_ok": true,
  "offers_ok": false,
  "idempotency_key": "f3b2c9e0a1d84c7e9b6a",
  "hp": "",
  "elapsed_ms": 41250,
  "campaign": { "utm_source": "instagram", "utm_medium": "paid", "utm_campaign": "visit-nov", "utm_content": "reel-3", "fbclid": "IwAR…", "landing": "/pages/visit?utm_source=instagram", "referrer": "https://l.instagram.com/" }
}
```

Required fields:

- `type`, `day`, `min`
- `name`: 2 to 80 characters, just a name
- `phone`: a 10-digit Indian mobile when `country` is `+91` (the default).
  Any other `country` (`"+44"`, `"+971"`…) takes the local number.

Optional fields:

- `party`, `place`
- `email`
- `functions`: only these values count: `Haldi`, `Mehendi`, `Carnival`,
  `Sangeet`, `Cocktail`, `Reception or wedding day`, `Other`.
- `function_date`: free text, up to 60 characters.
- `looking_for`: up to 600 characters.
- `whatsapp_ok`: default `true`. The customer agrees to WhatsApp messages
  about this booking. It must be a JSON boolean; a string such as
  `"false"` is refused.
- `offers_ok`: default `false`, and also a JSON boolean.

About `name`: any script is fine, but only letters, spaces and `. ' -`.
Digits, links and anything that looks like a web address are refused with
`name_required`. Web addresses typed into `looking_for` or `function_date`
are replaced with "[link removed]".

How the theme should fill the rest:

- **`idempotency_key`:**
  - Make one when the form is shown, for example
    `crypto.randomUUID().replace(/-/g, "")`, using only `A–Z a–z 0–9 _ -`
    and 8 to 80 characters.
  - Send the same key on every tap and retry.
  - The server ties the key to the day, time, number and kind of visit:
    - The same key with the same choices always returns the same booking,
      never a second one.
    - If the customer changes their choices, the same key simply makes the
      new booking.
  - Make a fresh key after a successful booking, and when the reply is
    `key_reused`.
- **`hp`:** a hidden trap field.
  - Render an input named `hp` off-screen (not `display: none`), with
    `tabindex="-1"`, `autocomplete="new-password"` and `aria-hidden="true"`,
    and send its value.
  - People leave it empty. A filled-in value is refused.
  - Don't call it `company`, `email` or anything else browser autofill
    recognises.
- **`elapsed_ms`:** required. Send it as a number: milliseconds since the
  form was shown. Missing, or under 2 seconds, is refused as a bot.
- **`campaign`:**
  - On landing, copy any `utm_*`, `fbclid` and `gclid` from the URL, plus
    `location.pathname + location.search` and `document.referrer`, into
    `sessionStorage`. Send them with the booking.
  - The team then sees which ad brought the visit. It is shown in the
    booking's history and stored on the booking.

**200** example:

```json
{
  "ok": true,
  "number": "A-1043",
  "status": "confirmed",
  "replayed": false,
  "type": { "id": "store", "name": "Store visit" },
  "place": "store", "party": "solo",
  "day": "2026-11-18", "min": 840, "time": "2 pm", "when": "Wednesday 18 November at 2 pm",
  "starts_at": "2026-11-18T08:30:00.000Z", "ends_at": "2026-11-18T09:00:00.000Z", "duration_minutes": 30,
  "address": "Shop No. 11, Sai Ganesh Sadan, Ground floor, Senapati Bapat Marg, Dadar West, Mumbai 400028",
  "auto_whatsapp": false,
  "shop_whatsapp": {
    "number": "+918433659684",
    "text": "Hi Drevi, I have booked a store visit for Wednesday 18 November at 2 pm (booking A-1043). My name is Ananya.",
    "link": "https://wa.me/918433659684?text=Hi%20Drevi%2C…"
  }
}
```

- **`status`:** `"confirmed"`, or `"requested"` when the shop has chosen
  "staff confirm first". For `"requested"`, say "We'll confirm on WhatsApp
  shortly" rather than "Confirmed".
- **`replayed: true`:** the same booking was returned. Either the same key
  came again, or the same number and name already had this exact time.
  Every field then describes the stored booking. Show it as a normal
  success.
- **`auto_whatsapp`:**
  - `true` only when the shop's automatic WhatsApp confirmations are
    really on, and so the customer is about to get one.
  - **Today it is `false`.** The page must then ask the customer to tap
    **"Send us your booking on WhatsApp"**, which opens `shop_whatsapp.link`.
  - That message reaches the team's phone at once and gives the customer a
    chat with the shop. Do not promise "you'll get a WhatsApp" while
    `auto_whatsapp` is `false`.
- **Calendar file:** build "Add to calendar" (an .ics file) from
  `starts_at`, `ends_at` and `address`. Use the title "Drevi: store visit"
  and put the booking number in the description.

Errors all come back as `{ "ok": false, "code": "...", "error": "<a sentence you can show as is>" }`:

| HTTP | `code` | what to do |
|---|---|---|
| 400 | `bad_request` | Show `error`. A missing field, the trap field filled, or the form sent too fast. |
| 400 | `name_required` | Show `error` under the name field. |
| 400 | `invalid_phone` | Show `error` under the number field. |
| 400 | `invalid_email` | Show `error` under the email field, or let them clear it. |
| 404 | `type_off` | Online booking is switched off. Show the WhatsApp button. |
| 409 | `slot_taken` | That time just went. The reply carries `day`, that day's fresh list in the same shape as `availability.days[n]`. Re-draw the times, keep everything they typed, and ask them to pick again. |
| 409 | `too_soon` / `outside_hours` / `closed` / `too_far` | Show `error` and send them back to the time picker. |
| 409 | `already_booked` | That number already has a booking at that time, under another name. Show `error` and the WhatsApp button. |
| 409 | `key_reused` | Rare: the key belongs to a booking that has since been cancelled. Make a new `idempotency_key`, then show `error` ("Please tap Book again"). |
| 429 | `rate_limited` | Show `error` and the WhatsApp button. |
| 403 / 415 / 413 | `forbidden` / `bad_request` | A bug in the theme call. |
| 503 | `not_set_up` | Booking is not available. Show the WhatsApp button. |
| 500 | `server_error` | Show `error` and the WhatsApp button. Every unexpected error has this shape. |

**On any network failure**, offer the same WhatsApp fallback:
`https://wa.me/918433659684` with the visitor's chosen day, time and name
prefilled. Nobody should ever be left without a way to book.

## Limits

These are generous for people and tight for bots. They are checked under one
database lock, so parallel requests cannot slip past them:

- **Per WhatsApp number:** at most 3 upcoming website bookings.
- **Same number, same time:** returns the existing booking if the name
  matches. Otherwise the reply is `already_booked`.
- **Per network:** at most 6 website bookings an hour. A network is an IPv4
  address or an IPv6 /64. The address is stored only as a salted one-way
  hash.
- **Overall:** at most 60 website bookings an hour.

The website books only free times. Two people tapping the same last place
at the same moment get one booking and one `slot_taken`.

## What happens after a booking

These happen in the portal, not on the website:

- The booking appears in Appointments: the Overview, Today, Calendar and
  All bookings lists.
- WhatsApp alerts are planned for the team's alert list, along with the
  customer's confirmation and reminders.
- Nothing is sent until the owner connects AiSensy and turns automatic
  messages on. Until then the team sends confirmations from the booking
  page with one tap.
