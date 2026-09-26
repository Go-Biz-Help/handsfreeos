# Google Play — Data Safety answers

What to click in Play Console → App content → Data safety. Same facts as
[`privacy-app-store.md`](privacy-app-store.md), in Google's shape.

## The section Google asks first

| Question                                                               | Answer | Why                                                                                                                                           |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Does your app collect or share any of the required user data types?    | Yes    | The business's own records, listed below                                                                                                      |
| Is all of the user data collected by your app encrypted in transit?    | Yes    | Everything goes over HTTPS/TLS — the API, the sync stream and Supabase Auth. The phone's own copy is encrypted at rest with SQLCipher as well |
| Do you provide a way for users to request that their data is deleted?  | Yes    | In the app, on the web, and at `https://app.handsfreeos.com/delete-account`                                                                   |
| Has your app been independently validated against a security standard? | No     | Not audited                                                                                                                                   |
| Is your app's data collection reviewed by a third party?               | No     | —                                                                                                                                             |

## Data collected

Google asks four things per type: collected or shared, required or optional, why, and whether it's processed
ephemerally. Nothing here is **shared**: it goes to HandsFreeOS's own servers, and from there only to the service
providers that carry it out on the business's behalf (the carrier that sends a text, the payment provider that takes a
payment, Google's Routes API that works out an On my way drive time), which Google's own rules exclude from "shared". The screen counts go to Matomo, which runs Go Biz Help's
analytics for it and is a service provider in the same way. Nothing is processed ephemerally — the point of the app is
that the business keeps its records.

| Google's category → type                  | Collected | Shared | Required? | Purpose                               | Where in the code                                                                                                                                                                                                                                                      |
| ----------------------------------------- | --------- | ------ | --------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal info → Name                      | Yes       | No     | Required  | App functionality, Account management | `app.users`; `app.people`, `app.companies`                                                                                                                                                                                                                             |
| Personal info → Email address             | Yes       | No     | Required  | App functionality, Account management | Supabase Auth; `app.people.email`                                                                                                                                                                                                                                      |
| Personal info → Phone number              | Yes       | No     | Optional  | App functionality                     | Settings → My cell phone; customers' numbers                                                                                                                                                                                                                           |
| Personal info → Address                   | Yes       | No     | Optional  | App functionality                     | Customers' and appointments' addresses                                                                                                                                                                                                                                 |
| Location → Precise location               | Yes       | No     | Optional  | App functionality                     | `src/components/calendar/visit-job.tsx`: one reading when a tech taps On my way, never in the background, for the arrival time in the customer's text. The server rounds it to about 100 m (`packages/core/src/commands/job.ts`), which Google still counts as precise |
| Location → Approximate location           | Yes       | No     | Optional  | App functionality                     | The same reading when the tech allows only approximate location                                                                                                                                                                                                        |
| Personal info → User IDs                  | Yes       | No     | Required  | App functionality, Account management | The account id every change is credited to                                                                                                                                                                                                                             |
| Photos and videos → Photos                | Yes       | No     | Optional  | App functionality                     | `expo-image-picker` → a customer's files, or a reply                                                                                                                                                                                                                   |
| Messages → Other in-app messages          | Yes       | No     | Required  | App functionality                     | The inbox: texts and emails with customers, notes                                                                                                                                                                                                                      |
| Financial info → Other financial info     | Yes       | No     | Optional  | App functionality                     | Invoice, estimate, payment and plan amounts                                                                                                                                                                                                                            |
| Device or other IDs → Device or other IDs | Yes       | No     | Optional  | App functionality, Analytics          | `src/push/device.ts`: the push token for this install, so notifications arrive; `src/lib/analytics.ts`: a random id for this install that Matomo counts screens by                                                                                                     |
| App activity → App interactions           | Yes       | No     | Required  | Analytics                             | `src/lib/analytics.ts`: which screens are opened — the route, never an id, a name or anything typed                                                                                                                                                                    |
| Audio → Voice or sound recordings         | Yes       | No     | Optional  | App functionality                     | `src/voice/`: talking out loud to the Assistant, or on a test call of the AI teammate. Processed ephemerally: turned into words and not kept                                                                                                                           |

Voice recordings are in the table because talking out loud sends them off the phone, which is what Google's "collect"
means, even though nothing keeps them: the Assistant's mic, and Talk out loud on a test call, record what the person
says one turn at a time and send it to HandsFreeOS to be turned into words (`src/voice/`). Each recording is deleted
from the phone once it's been heard, and neither HandsFreeOS nor the speech service it uses keeps it, so the form's
"processed ephemerally" answer is yes. Voicemails are different: they travel the other way, recorded by the carrier and
only played by the app (`src/components/inbox/voicemail-player.tsx`), which is data arriving, not data collected.

## Data **not** collected

| Google's category                                                                   | Answer | Why                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| Personal info → Race, ethnicity, political or religious beliefs, sexual orientation | No     | Never asked                                                                                                               |
| Personal info → Other info                                                          | No     | —                                                                                                                         |
| Financial info → Payment info, purchase history, credit score                       | No     | The app never sees a card; paying happens on the provider's own hosted page                                               |
| Health and fitness                                                                  | No     | —                                                                                                                         |
| Contacts                                                                            | No     | The app never reads the phone's contacts (`src/inbox/contact-card.ts` hands the number to the phone's New Contact screen) |
| Calendar                                                                            | No     | The business's calendar is HandsFreeOS's own; the phone's calendar is never read                                          |
| App activity → In-app search history, installed apps, other actions                 | No     | Only screen names are counted (App interactions, above); searches are worked out on the phone and never sent              |
| Web browsing                                                                        | No     | No in-app browser                                                                                                         |
| App info and performance (crash logs, diagnostics, other)                           | No     | No crash reporter. Nothing is sent when the app fails                                                                     |
| Files and docs                                                                      | No     | Files a person attaches are already the business's records, counted under Photos above                                    |
| Audio files → Music, other audio                                                    | No     | The app records only voice, above. Voicemails it plays are data arriving, not data collected                              |

## Not in Data safety, but asked next to it

| Question                                    | Answer                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Ads                                         | The app contains no ads and shows no third-party ad content                                                                                    |
| Advertising ID permission (`AD_ID`)         | Not declared and not used — check the merged manifest in [`permissions.md`](permissions.md)                                                    |
| Target audience & content                   | 18 and over; it is a tool for business owners and their crews                                                                                  |
| News app                                    | No                                                                                                                                             |
| Data deletion (App content → Data deletion) | `https://app.handsfreeos.com/delete-account`, which deletes an account without the app                                                         |
| Financial features declaration              | None — the app is not a lending, banking, crypto or tax app, and takes no payments itself. The business's customers pay on the provider's page |
| Health apps declaration                     | Not a health app                                                                                                                               |
| Photo and video permissions declaration     | `CAMERA` only, and only after a person taps to take a photo. No storage permission is asked (both are blocked in `app.json`)                   |
| Location permissions declaration            | Not needed: Play asks only about background location, and the app has none (`isAndroidBackgroundLocationEnabled: false` in `app.json`)         |
