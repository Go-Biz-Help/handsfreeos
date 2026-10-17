# Google Play listing

Copy into Play Console. Character limits are Google's.

## App details

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| Package name         | `com.gobizhelp.handsfreeos`                                       |
| Default language     | English (United States)                                           |
| Developer name       | Go Biz Help LLC                                                   |
| App category         | Business                                                          |
| Tags                 | Business, Productivity, Communication                             |
| Contact email        | `support@handsfreeos.com`                                         |
| Contact phone        | Optional — leave empty unless Chris wants a number in the listing |
| Contact website      | `https://handsfreeos.com` — built (`apps/site`), live with it     |
| Privacy policy       | `https://handsfreeos.com/privacy` — built (`apps/site`)           |
| Ads                  | No — the app has none, and nothing in it is advertising           |
| In-app purchases     | No                                                                |
| Price                | Free                                                              |
| Government app       | No                                                                |
| Target audience      | 18 and over (it is a tool for business owners and their crews)    |
| Contains news        | No                                                                |
| COVID-19 app         | No                                                                |
| Data safety          | Answers in [`privacy-play.md`](privacy-play.md)                   |
| Content rating       | Answers in [`age-rating.md`](age-rating.md)                       |
| Account deletion URL | `https://app.handsfreeos.com/delete-account`                      |

Play requires the account-deletion URL when an app makes accounts, in **App content → Data deletion**. The page is
public and explains what deleting removes, so it satisfies the "delete without reinstalling the app" rule.

## App name (30 characters)

```
HandsFreeOS
```

## Short description (80 characters)

```
The CRM that doesn’t want you to use it. And it works with no signal.
```

## Full description (4000 characters)

```
The CRM that doesn’t want you to use it.

Other CRMs make you remember, look things up, type it in and follow up. HandsFreeOS answers new leads in seconds, books the job, keeps the record current, and brings you in when something actually needs you. The less you use it, the better it’s working.

EVERYTHING IN ONE PLACE
• Home shows what needs you today, in order, and handles the small things itself.
• Inbox — every text, call and email with a customer in one thread. Reply with a photo, add a note, hand a
conversation to a teammate, or take one back from your AI teammate.
• Calls — tap a customer and your own cell rings; answer, and you are connected showing the business number. The call
log, voicemails and their transcripts are all there.
• Customers and leads — the whole history of a customer on one screen: appointments, messages, notes, tags, files and
photos. Move a lead along the pipeline with a tap.
• Calendar — your day and your week, with appointment details and directions. Ask for a time or a change and it shows
as "Not booked yet" until it is confirmed.
• Money — invoices, estimates, payments and plans, exactly as much as your role is allowed to see. Record a cash or
cheque payment on the spot, or send a payment link.
• Ask HandsFreeOS anything about the business. Anything that reaches a customer is confirmed by you first.

IT WORKS WITH NO SIGNAL
A crawl space, a metal roof, a basement. The app keeps its own encrypted copy of the business, so every screen still
opens and every change you make waits in a queue you can see. When the signal comes back, the queue empties. Nothing
is sent twice, and anything that sat too long asks "Still send?" before it goes.

NOTIFICATIONS YOU CAN ACT ON
A customer waiting on a reply, an urgent lead, an approval, a booking. Reply from the notification, call, or let
HandsFreeOS handle it. Anything that reaches a customer asks for your fingerprint or unlock first, so a phone left in
a truck cannot text anyone.

BUILT FOR A CREW
Each person sees only what their role allows. Switch between businesses from the top of the screen. Unlock with your
fingerprint or face.

HandsFreeOS is for businesses that already use HandsFreeOS. Sign in with the email you use at the desk.
```

## Graphics

| Slot              | File                                       | Notes                                     |
| ----------------- | ------------------------------------------ | ----------------------------------------- |
| App icon          | `assets/play-icon-512.png`                 | 512×512, 32-bit PNG                       |
| Feature graphic   | `assets/play-feature-graphic-1024x500.png` | 1024×500, no transparency                 |
| Phone screenshots | See [`screenshots.md`](screenshots.md)     | Between 2 and 8; none are Play-shaped yet |

## Release tracks

`eas.json`'s `submit.production.android` sends to the **internal testing** track as a **draft**. Internal testing needs
no review and no tester list beyond the emails added in the console, which is where TestFlight's opposite number
begins. Promotion to closed, open, or production waits for Chris's go-live.
