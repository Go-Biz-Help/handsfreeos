# App Store listing

Copy into App Store Connect. Character limits are Apple's, and each heading says the one it has to stay inside.

## App Information

| Field               | Value                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| Bundle ID           | `com.gobizhelp.handsfreeos`                                                        |
| SKU                 | `handsfreeos-ios`                                                                  |
| Primary language    | English (U.S.)                                                                     |
| Seller / legal name | Go Biz Help LLC                                                                    |
| Apple team          | `8246H5FJ42` (Go Biz Help LLC — the same team the app-site-association file names) |
| Primary category    | Business                                                                           |
| Secondary category  | Productivity                                                                       |
| Copyright           | `2026 Go Biz Help LLC`                                                             |
| Price               | Free (the business already pays for HandsFreeOS; the app buys nothing)             |
| In-app purchases    | None                                                                               |
| Account required    | Yes — see [`reviewer-demo.md`](reviewer-demo.md)                                   |

## The line everything leads with

The website's headline, **“The CRM that doesn’t want you to use it.”** (`apps/site/src/app/page.tsx`), leads here too:
the promotional text, the description, the first screenshot, the header and Play's feature graphic all open with it,
and each puts the answer to its little puzzle straight after it. It is 40 characters, too long for the 30-character
subtitle, so the subtitle carries its short form from the pricing page, “The CRM that does the work”.

## Name (30 characters)

```
HandsFreeOS
```

## Subtitle (30 characters)

```
The CRM that does the work
```

## Promotional text (170 characters — editable without review)

```
The CRM that doesn’t want you to use it. It answers new leads in seconds, books the job and keeps the record current. Works from your truck, even with no signal.
```

## Keywords (100 characters, comma separated, no spaces)

```
crm,home services,hvac,plumbing,roofing,contractor,invoice,estimate,scheduling,leads,texting,jobs
```

## Description (4000 characters)

```
The CRM that doesn’t want you to use it.

Other CRMs make you remember, look things up, type it in and follow up. HandsFreeOS answers new leads in seconds, books the job, keeps the record current, and brings you in when something actually needs you. The less you use it, the better it’s working.

Everything in one place
• Home shows what needs you today, in order, and handles the small things itself.
• Inbox: every text, call and email with a customer in one thread. Reply with a photo, add a note, hand a
  conversation to someone else, or take one back from your AI teammate.
• Calls: tap a customer to have your own cell ring, then be connected showing the business number. The call log,
  voicemails and their transcripts are all there.
• Customers and leads: the whole history of a customer on one screen — appointments, messages, notes, tags, files and
  photos. Move a lead along the pipeline with a tap.
• Calendar: your day and your week, with appointment details and directions. Ask for a time or a change and it shows
  as "Not booked yet" until it is confirmed.
• Money: invoices, estimates, payments and plans, exactly as much as your role is allowed to see. Record a cash or
  cheque payment on the spot, or send a payment link.
• Ask HandsFreeOS anything about the business, and confirm anything that reaches a customer before it goes.

It works with no signal
A crawl space, a metal roof, a basement: the app keeps its own encrypted copy of the business, so every screen still
opens and every change you make waits in a queue you can see. When the signal comes back, the queue empties. Nothing
is sent twice, and anything that sat too long asks "Still send?" before it goes.

Notifications you can act on
A customer waiting on a reply, an urgent lead, an approval, a booking. Reply from the lock screen, call, or let
HandsFreeOS handle it. Anything that reaches a customer asks for Face ID first, so a phone left in a truck can't text
anyone.

Built for a crew
Each person sees only what their role allows. Switch between businesses from the top of the screen. Unlock with Face
ID.

HandsFreeOS is for businesses that already use HandsFreeOS. Sign in with the email you use at the desk.
```

## URLs

| Field              | Value                                        | State                                                                    |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| Support URL        | `https://handsfreeos.com/support`            | Built (`apps/site`), live once the site is deployed — Stage 0 of go-live |
| Marketing URL      | `https://handsfreeos.com/app`                | Built (`apps/site`), the phone-app page, live with the site              |
| Privacy Policy URL | `https://handsfreeos.com/privacy`            | Built (`apps/site`), live with the site                                  |
| Account deletion   | `https://app.handsfreeos.com/delete-account` | Built (step 7), live with the web app                                    |

Apple wants the account-deletion URL in App Review Information when an app makes accounts. The page is public: it
explains what deleting removes, and signs you in first if you aren't.

## App Review Information

```
Sign-in: this app is for businesses that already use HandsFreeOS, so a demo business is kept for review.
Email and password are in the App Review sign-in fields above. On the sign-in screen, enter the email,
then tap Use my password.

The demo business is "Bright Path Home Services". It has customers, leads, appointments, tasks, estimates,
invoices and a payment already in it, so most tabs have something to look at. It has no phone number of its
own, so its inbox is empty. Every customer has a made-up 555 number and an example.com email, so nothing the
demo business sends can reach a real person.

Notes for review:
• Face ID is offered to unlock the app and to confirm anything that reaches a customer. Skip is always
  offered, and the demo login has no unlock set, so the reviewer is never stopped by it.
• Background location is used only while the person is checked in for their safety (More → Settings →
  My safety; Check in on an appointment) with Share where I am on, and stops when they check out. The
  blue location indicator shows throughout. The app never requests Always authorization.
• The microphone is used only while the person talks out loud to the Assistant or records a voice note.
• Anything you ask the Assistant is sent to Anthropic's Claude, or to OpenAI as a backup when Claude is
  unavailable. The first use explains that and asks for permission; the demo login has already said yes.
• The app never takes a card number. Payments happen on the payment provider's own hosted page in the
  browser.
• Some desk work — workflow editors, business settings, members, payment connections — opens the web app in
  Safari on purpose. It is the same account.
• Account deletion is in More → Settings → Delete my account. If you try it, please use a new account
  (Create an account on the sign-in screen), so the demo account stays for later reviews.
```

## What Apple still asks in the console

- **Age rating** — answers in [`age-rating.md`](age-rating.md).
- **App Privacy** — answers in [`privacy-app-store.md`](privacy-app-store.md).
- **Export compliance** — `ITSAppUsesNonExemptEncryption` is `false` in `app.json`, so the per-build question stops
  being asked. That answer says the app uses only encryption exempt from U.S. export rules: HTTPS, Apple's own data
  protection, and SQLCipher's AES for the phone's copy of the business, all standard algorithms used to protect the
  business's own data. **Chris should confirm this with whoever does his compliance before the first submission**, and
  whether France's separate declaration applies.
- **Content rights** — the app shows only the business's own content. No third-party content.
