# Filling both consoles with Claude in Chrome

Prompts to paste into the Claude in Chrome extension, one at a time, in order. Each one stands alone, because the
extension can't read this repository: every value it needs is written into the prompt, copied from the files beside
this one. When one of those files changes, change the prompt here too.

The extension works in your own signed-in browser. It doesn't type passwords, pay, accept agreements, upload files from
your computer, or press anything that sends the app for review. Each prompt says where it stops and hands back to you.

## Before any prompt: three things only you can do

1. **Seed the demo business.** Both stores refuse an app they can't sign into, and the hosted project still has no
   `app-review@handsfreeos.com` user (checked 2026-10-16). Pick a password of 12 characters or more, then from the
   repository on your Mac, with the hosted project's connection variables set (see
   [`reviewer-demo.md`](reviewer-demo.md)):

   ```sh
   HFOS_DEMO_PASSWORD="…" pnpm db:seed:demo
   ```

2. **Sign in with it on a real build.** Install fresh from TestFlight, tap **Use my password**, and get in. Do the same
   on Android once Prompt G7 has put a build on internal testing.

3. **Have the newest builds.** The commit that added this file changed the iPhone's privacy manifest, so once it is
   merged to `main` a fresh build goes to TestFlight and a fresh `.aab` is made, by themselves (Phone Part 4 in
   `docs/operations.md`). Pick those builds in the prompts below, not older ones.

## Google Play

### G1. Check the developer account

Do this first: Google's identity checks have taken days.

```
I'm getting my company's Android app onto Google Play. Please check the state of my Google Play developer account. I'm already signed in to Chrome.

Rules for this whole task: never type a password or a sign-in code (if a sign-in screen appears, stop and ask me). Don't pay for anything, don't accept any agreement, and don't create anything. Only look and report.

Go to https://play.google.com/console and tell me:
1. Whether a developer account exists, and its developer name (it should be "Go Biz Help LLC").
2. Whether it's an Organization account or a Personal account.
3. Whether identity verification is done, pending, or not started, and anything Google still asks for (a D-U-N-S number, a phone number, website verification, an ID).
4. Whether an app called HandsFreeOS, package name com.gobizhelp.handsfreeos, already exists in it.
5. Any red banners or "action required" messages, in Google's own words.

If there's no account at all, say so and stop.
```

**If you have to make the account:** choose **Organization**, as Go Biz Help LLC. It needs a D-U-N-S number (free from
Dun & Bradstreet, a few days), and it skips Google's rule for new **personal** accounts: a closed test with at least 12
testers for 14 days before an app may go to production. The fee is $25, once.

### G2. Create the app

```
Please create a new app in Google Play Console for my company. I'm signed in already.

Rules: never type a password or a sign-in code; if a sign-in appears, stop and ask me. Don't pay for anything. Before you tick any declaration or agreement checkbox, read its words to me and wait for me to say yes.

Go to https://play.google.com/console, then "Create app", and fill in:
- App name: HandsFreeOS
- Default language: English (United States) – en-US
- App or game: App
- Free or paid: Free

Then read me the declarations, wait for my OK, tick them, and press Create app.

When it's made, tell me the app's ID or link, and list the tasks Play shows under "Set up your app" on the dashboard.
```

### G3. App content: the declarations

```
Please fill in the "App content" declarations for my app HandsFreeOS in Google Play Console. I'm signed in already.

Rules: never type a password or a sign-in code. Don't pay, don't accept agreements, and never press "Send for review", "Publish" or "Start rollout". Save each section as you finish it. The console's wording may not match mine exactly, so match by meaning. If a question doesn't fit any answer below, stop and ask me rather than guess. Skip Data safety and Content rating: I'll give you separate instructions for those.

Go to https://play.google.com/console, open HandsFreeOS, then Policy and programs (or "Monitor and improve") → App content. Fill each section:

1. Privacy policy: https://handsfreeos.com/privacy

2. App access: "All or some functionality is restricted". Add one set of instructions:
   - Name: Demo business
   - Username: app-review@handsfreeos.com
   - Password: leave it empty and stop. I'll type it myself, then tell you to carry on.
   - Any other information: "On the sign-in screen, enter the email, then tap Use my password. The account owns a demo business, Bright Path Home Services, with customers, leads, appointments, conversations and invoices already in it. There is no second factor and no code to receive."

3. Ads: No, my app does not contain ads.

4. Target audience and content: 18 and over only. Nothing in the app is aimed at children, and it should not appeal to children.

5. News apps: No, it's not a news app.

6. COVID-19 contact tracing and status apps (if it's still there): it's not one of those apps.

7. Government apps: No.

8. Financial features: my app doesn't provide any financial features. (It isn't a banking, lending, payments, crypto or tax app; businesses record their own invoices, and customers pay on a payment provider's own web page.)

9. Health apps: my app has no health features.

10. Advertising ID: No, the app doesn't use an advertising ID.

11. Foreground service permissions (this may only show after a build is uploaded): choose the Location type, and describe it as: "Shares the person's location with the safety contacts they chose, only while they are checked in at an appointment, until they check out." It also asks for a video link: stop and ask me for it.

12. If you see any other declaration (photo and video permissions, exact alarms, accessibility, anything else), don't answer it. Tell me exactly what it asks.

At the end, list each section with Done, Skipped or Needs me, and anything the console flagged.
```

**The video for item 11** is a short screen recording on an Android phone: check in on an appointment with **Share where
I am until I check out** on, show the "Sharing where you are" notification, then check out. Upload it to YouTube as
**Unlisted** and give that link.

### G4. Data safety

```
Please fill in the Data safety form for my app HandsFreeOS in Google Play Console. I'm signed in already.

Rules: never type a password or a sign-in code. Don't accept agreements, and never press "Send for review", "Publish" or "Start rollout". Saving the form is fine; submitting the form itself is fine too. Match the console's wording by meaning. If a question doesn't fit any answer below, stop and ask me.

Go to https://play.google.com/console → HandsFreeOS → App content → Data safety.

First questions:
- Does your app collect or share any of the required user data types? Yes
- Is all of the user data collected by your app encrypted in transit? Yes
- Account creation: yes, the app lets people create an account. Login methods: username (email) and password; username and other authentication (an emailed one-time code). If "OAuth" or Google sign-in is offered as a choice, ask me before ticking it.
- Delete account URL: https://app.handsfreeos.com/delete-account
- Can users request that some or all of their data is deleted without deleting their account? Ask me.
- Has your app been independently validated against a security standard? No

Data types. For every type below: Collected = Yes, Shared = No, Processed ephemerally = No. Then Required or Optional, and the purposes, as given:
- Personal info → Name: Required. App functionality, Account management.
- Personal info → Email address: Required. App functionality, Account management.
- Personal info → User IDs: Required. App functionality, Account management, Analytics.
- Personal info → Address: Optional. App functionality.
- Personal info → Phone number: Optional. App functionality.
- Financial info → Other financial info: Optional. App functionality.
- Location → Approximate location: Optional. App functionality.
- Location → Precise location: Optional. App functionality.
- Messages → Other in-app messages: Required. App functionality.
- Photos and videos → Photos: Optional. App functionality.
- Audio → Voice or sound recordings: Optional. App functionality.
- Contacts → Contacts: Optional. App functionality.
- App activity → App interactions: Required. Analytics.
- Device or other IDs → Device or other IDs: Optional. App functionality, Analytics.

Leave every other data type unticked: race and ethnicity, political or religious beliefs, sexual orientation, other personal info; payment info, purchase history, credit score; health and fitness; Emails and SMS or MMS (those mean the phone's own mailbox and texts, which the app never reads; the business's texts with its customers are Other in-app messages); calendar events; videos; music and other audio files; files and docs; in-app search history, installed apps, other user-generated content, other actions; web browsing history; crash logs, diagnostics, other app performance data.

At the end, show me the preview Play makes of the Data safety section, and tell me anything it flagged.
```

### G5. Content rating

```
Please fill in the content rating questionnaire (IARC) for my app HandsFreeOS in Google Play Console. I'm signed in already.

Rules: never type a password or a sign-in code. Never press "Send for review", "Publish" or "Start rollout". Submitting the questionnaire itself is fine. Match the console's wording by meaning; if a question doesn't fit, stop and ask me.

Go to https://play.google.com/console → HandsFreeOS → App content → Content rating → Start questionnaire.

- Email address for the rating: support@handsfreeos.com
- Category: the closest of Utility, Productivity, Communication or Other (it's a business tool: customers, texts, calls, jobs, invoices).

Answers:
- Violence, blood, sexuality, nudity, profanity or crude humour, drugs, alcohol, tobacco, horror or fear, gambling or simulated gambling: No to every one.
- Does the app let users interact or exchange content with other users? Yes. (A business texts and emails its own customers; teammates share the business's records.)
- Can users interact with people they don't know? No. Everyone in a business is invited by it, and every customer is one the business already has. There's no public feed, directory or chat with strangers.
- Does the app let users share their location with other users? Yes. A check-in shares where the person is with the safety contacts they chose, until they check out.
- Does the app allow the purchase of digital goods? No.
- Does the app contain unrestricted internet access, like a browser or search engine? No.
- Does the app share user-provided personal information with third parties? No.
- Is the app a news app? No. Is it made for children? No.

Before you submit, read me the summary of answers. After I say yes, submit and tell me the ratings it gives (ESRB, PEGI and the rest) and any notices like "Users Interact" or "Shares Location".
```

### G6. Store listing

```
Please fill in the store listing for my app HandsFreeOS in Google Play Console. I'm signed in already.

Rules: never type a password or a sign-in code. Never press "Send for review", "Publish" or "Start rollout". Save when you're done. You can't upload files from my computer: when you reach the graphics, stop and tell me which slots are empty.

Go to https://play.google.com/console → HandsFreeOS → Grow users (or "Grow") → Store presence → Main store listing.

App name:
HandsFreeOS

Short description (80 characters at most):
The CRM that doesn’t want you to use it. And it works with no signal.

Full description. Type it exactly, keeping each paragraph and each bullet on its own line and a blank line between sections:

The CRM that doesn’t want you to use it.

Other CRMs make you remember, look things up, type it in and follow up. HandsFreeOS answers new leads in seconds, books the job, keeps the record current, and brings you in when something actually needs you. The less you use it, the better it’s working.

EVERYTHING IN ONE PLACE
• Home shows what needs you today, in order, and handles the small things itself.
• Inbox — every text, call and email with a customer in one thread. Reply with a photo, add a note, hand a conversation to a teammate, or take one back from your AI teammate.
• Calls — tap a customer and your own cell rings; answer, and you are connected showing the business number. The call log, voicemails and their transcripts are all there.
• Customers and leads — the whole history of a customer on one screen: appointments, messages, notes, tags, files and photos. Move a lead along the pipeline with a tap.
• Calendar — your day and your week, with appointment details and directions. Ask for a time or a change and it shows as "Not booked yet" until it is confirmed.
• Money — invoices, estimates, payments and plans, exactly as much as your role is allowed to see. Record a cash or cheque payment on the spot, or send a payment link.
• Ask HandsFreeOS anything about the business. Anything that reaches a customer is confirmed by you first.

IT WORKS WITH NO SIGNAL
A crawl space, a metal roof, a basement. The app keeps its own encrypted copy of the business, so every screen still opens and every change you make waits in a queue you can see. When the signal comes back, the queue empties. Nothing is sent twice, and anything that sat too long asks "Still send?" before it goes.

NOTIFICATIONS YOU CAN ACT ON
A customer waiting on a reply, an urgent lead, an approval, a booking. Reply from the notification, call, or let HandsFreeOS handle it. Anything that reaches a customer asks for your fingerprint or unlock first, so a phone left in a truck cannot text anyone.

BUILT FOR A CREW
Each person sees only what their role allows. Switch between businesses from the top of the screen. Unlock with your fingerprint or face.

HandsFreeOS is for businesses that already use HandsFreeOS. Sign in with the email you use at the desk.

Save, then go to Store presence → Store settings and fill in:
- App category: Business
- Tags: Business, Productivity, Communication (pick the closest ones Play offers, up to five)
- Email address: support@handsfreeos.com
- Phone number: leave empty
- Website: https://handsfreeos.com
- External marketing: leave as it is

Save, and tell me which graphics slots are still empty.
```

**Then upload the graphics yourself**, from `apps/mobile/store/assets/`:

| Slot              | File                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App icon          | `play-icon-512.png`                                                                                                                                                                               |
| Feature graphic   | `play-feature-graphic-1024x500.png`                                                                                                                                                               |
| Phone screenshots | `screenshots/android-1-home.png`, `-2-pipeline`, `-3-customer`, `-4-calendar`, `-5-invoice`, `-5b-record-cash`, `-6-offline-queue`, `-7-money-list`, in that order (eight is the most Play takes) |

### G7. Internal testing: the first Android build

Internal testing is private: only the emails you add can install it, and Google doesn't review it.

```
Please help me put the first Android build of HandsFreeOS on Google Play's internal testing track. I'm signed in already.

Rules: never type a password or a sign-in code. You can't upload files from my computer, so when the upload box appears, stop and tell me. Never touch the Production, Open testing or Closed testing tracks. Rolling out to Internal testing is fine, but read me the summary first and wait for my OK.

Step 1, get the build. Go to https://expo.dev/accounts/gobizhelp/projects/handsfreeos/builds. Find the newest Android build with the "production" profile that finished successfully. Tell me its build number, version, commit and date, then download its .aab file. Tell me when it's in my Downloads.

Step 2, testers. Go to https://play.google.com/console → HandsFreeOS → Test and release (or "Testing") → Internal testing → Testers. Make an email list called "HandsFreeOS team" and ask me which email addresses to put in it. Save, and copy the "Join on the web" opt-in link for me.

Step 3, the release. Releases tab → Create new release.
- If Play asks about app signing, choose to let Google manage and protect the app signing key (the recommended choice).
- Stop at "App bundles" and tell me to upload the .aab. Carry on when I say it's uploaded.
- Release name: leave what Play fills in.
- Release notes, English (United States): First internal test of HandsFreeOS.

Press Next, and read me every error and warning on the review screen. If one mentions the foreground service or location permission declaration, tell me: that's App content → Foreground service permissions. After I say OK, save and roll out to internal testing.

Step 4: tell me the opt-in link again, and the build's version code.
```

Then open the opt-in link on an Android phone, install, sign in with the demo login, and run a real day through the app.

### G8. Optional: let releases upload themselves

Only worth it if you want each Android build to reach internal testing without you. It needs a Google Cloud service
account key in EAS first (`npx --yes eas-cli@latest credentials --platform android` → Google Service Account), and
Google often blocks key creation on new organizations. Skip it if it fights you.

```
Please give a Google service account access to my app HandsFreeOS in Google Play Console, so my build service can upload builds. I'm signed in already.

Rules: never type a password or a sign-in code. Don't give it Admin, and don't change anyone else's access.

First ask me for the service account's email address (it ends in .iam.gserviceaccount.com). Then go to https://play.google.com/console → Users and permissions → Invite new users. Paste the address exactly. Under App permissions, add HandsFreeOS with only these:
- View app information (read-only)
- Edit and delete draft apps
- Release apps to testing tracks
- Manage testing tracks and edit tester lists
- Release to production, exclude devices, and use Play App Signing
- Manage store presence

Invite, then tell me whether the account shows as "Active" or "Invite sent". (It should be Active. "Invite sent" means the address is wrong.)
```

Then set the GitHub repository variable `MOBILE_SUBMIT_ANDROID` to `true`.

## App Store

The app record exists already (App Store Connect id `6813606312`), and TestFlight works.

### A1. App information, price and where it's sold

```
Please fill in the app information for my iPhone app HandsFreeOS in App Store Connect. I'm signed in already.

Rules: never type a password or a sign-in code; if a sign-in appears, stop and ask me. Don't accept any agreement, and never press "Add for Review" or "Submit for Review". Save each page. Match Apple's wording by meaning, and if a question doesn't fit, stop and ask me.

Go to https://appstoreconnect.apple.com/apps/6813606312.

1. General → App Information:
   - Name: HandsFreeOS
   - Subtitle: The CRM that does the work
   - Primary language: English (U.S.)
   - Category: Business. Secondary category: Productivity.
   - Content rights: No, it doesn't contain, show or access third-party content.
   Save.

2. Pricing and Availability:
   - Price: Free (USD 0.00).
   - Availability: before you change anything, tell me which countries it's set to now and ask me which ones I want.
   - No in-app purchases.
   Save.

3. If Apple asks for the EU Digital Services Act trader status, don't answer it. Tell me what it asks; I'll decide.

4. Go to https://appstoreconnect.apple.com/business (or Agreements, Tax, and Banking) and tell me whether the Free Apps agreement is active and whether any agreement is waiting to be accepted. Don't accept one.

Tell me what you filled in and anything Apple flagged.
```

### A2. App Privacy

```
Please fill in the App Privacy section for my iPhone app HandsFreeOS in App Store Connect. I'm signed in already.

Rules: never type a password or a sign-in code. Never press "Add for Review" or "Submit for Review". Pressing Publish on the App Privacy page is fine: it only shows on the store once the app is live. Match Apple's wording by meaning; if a question doesn't fit, stop and ask me.

Go to https://appstoreconnect.apple.com/apps/6813606312 → App Privacy.

Privacy Policy URL: https://handsfreeos.com/privacy

Data collection: Yes, we collect data from this app.

Tick exactly these data types:
- Contact Info: Name, Email Address, Phone Number, Physical Address
- Contacts
- Location: Precise Location, Coarse Location
- User Content: Emails or Text Messages, Photos or Videos, Audio Data, Other User Content
- Identifiers: User ID, Device ID
- Financial Info: Other Financial Info
- Usage Data: Product Interaction

Leave every other type unticked: Health and Fitness, Payment Info, Credit Info, Other Contact Info, Sensitive Info, Browsing History, Search History, Purchases, Advertising Data, Other Usage Data, Customer Support, Gameplay Content, and every Diagnostics type.

For every ticked type, answer:
- Linked to the user's identity: Yes
- Used for tracking: No
- Purpose: App Functionality only, except:
  - User ID: App Functionality and Analytics
  - Device ID: App Functionality and Analytics
  - Product Interaction: Analytics only

Save, show me the summary Apple builds, and after I say yes, press Publish.
```

### A3. The 1.0 version page

```
Please fill in the version 1.0 page for my iPhone app HandsFreeOS in App Store Connect, so it's ready for me to send for review. I'm signed in already.

Rules: never type a password or a sign-in code; when you reach the reviewer's password, stop and let me type it. You can't upload files from my computer: when you reach screenshots, stop and tell me. NEVER press "Add for Review" or "Submit for Review"; that's my decision. Save as you go. Match Apple's wording by meaning; if a question doesn't fit, stop and ask me.

Go to https://appstoreconnect.apple.com/apps/6813606312 and open the iOS app's version 1.0 (Prepare for Submission). If there's no version yet, make it as 1.0.0.

1. Screenshots, iPhone 6.9" display: stop and tell me to upload them.

2. Promotional text:
The CRM that doesn’t want you to use it. It answers new leads in seconds, books the job and keeps the record current. Works from your truck, even with no signal.

3. Description. Type it exactly, keeping each paragraph and each bullet on its own line and a blank line between sections:

The CRM that doesn’t want you to use it.

Other CRMs make you remember, look things up, type it in and follow up. HandsFreeOS answers new leads in seconds, books the job, keeps the record current, and brings you in when something actually needs you. The less you use it, the better it’s working.

Everything in one place
• Home shows what needs you today, in order, and handles the small things itself.
• Inbox: every text, call and email with a customer in one thread. Reply with a photo, add a note, hand a conversation to someone else, or take one back from your AI teammate.
• Calls: tap a customer to have your own cell ring, then be connected showing the business number. The call log, voicemails and their transcripts are all there.
• Customers and leads: the whole history of a customer on one screen — appointments, messages, notes, tags, files and photos. Move a lead along the pipeline with a tap.
• Calendar: your day and your week, with appointment details and directions. Ask for a time or a change and it shows as "Not booked yet" until it is confirmed.
• Money: invoices, estimates, payments and plans, exactly as much as your role is allowed to see. Record a cash or cheque payment on the spot, or send a payment link.
• Ask HandsFreeOS anything about the business, and confirm anything that reaches a customer before it goes.

It works with no signal
A crawl space, a metal roof, a basement: the app keeps its own encrypted copy of the business, so every screen still opens and every change you make waits in a queue you can see. When the signal comes back, the queue empties. Nothing is sent twice, and anything that sat too long asks "Still send?" before it goes.

Notifications you can act on
A customer waiting on a reply, an urgent lead, an approval, a booking. Reply from the lock screen, call, or let HandsFreeOS handle it. Anything that reaches a customer asks for Face ID first, so a phone left in a truck can't text anyone.

Built for a crew
Each person sees only what their role allows. Switch between businesses from the top of the screen. Unlock with Face ID.

HandsFreeOS is for businesses that already use HandsFreeOS. Sign in with the email you use at the desk.

4. Keywords:
crm,home services,hvac,plumbing,roofing,contractor,invoice,estimate,scheduling,leads,texting,jobs

5. Support URL: https://handsfreeos.com/support
   Marketing URL: https://handsfreeos.com/app
   Version: 1.0.0
   Copyright: 2026 Go Biz Help LLC

6. Build: press the button to add a build and pick the newest one with a status of Complete or Ready to Submit. Tell me its build number and date before you pick it. If Apple asks about encryption, the answer is that the app uses only exempt encryption (standard HTTPS and data protection), which is already declared in the build; tell me if it asks anyway.

7. Age rating: open it and answer:
   - Every content question (violence, sexual content or nudity, profanity or crude humour, horror or fear, mature or suggestive themes, alcohol, tobacco or drugs, medical or treatment information, gambling, simulated gambling, contests): None, or No.
   - Unrestricted web access: No. (Links open specific HandsFreeOS pages in Safari; there's no address bar.)
   - User-generated content, or messaging and chat: Yes. (A business texts and emails its own customers. There's no public feed and nothing between strangers.)
   - Advertising: No. Parental controls: No. Age assurance: No.
   - Made for Kids: No.
   - If Apple asks how that messaging content is moderated, stop and ask me.
   Tell me the rating Apple works out.

8. App Review Information:
   - Sign-in required: Yes. User name: app-review@handsfreeos.com. Password: stop and let me type it.
   - Contact: ask me for the first name, last name, phone number and email to use.
   - Notes. Type exactly, one bullet per line:

Sign-in: this app is for businesses that already use HandsFreeOS, so a demo business is kept for review. Email and password are in the sign-in fields above. On the sign-in screen, enter the email, then tap Use my password.

The demo business is "Bright Path Home Services". It has customers, leads, appointments, conversations, invoices and payments already in it, so every tab has something to look at. No real phone number and no real card are involved: nothing the demo business sends leaves our servers.

Notes for review:
• Face ID is offered to unlock the app and to confirm anything that reaches a customer. Skip is always offered, and the demo login has no unlock set, so the reviewer is never stopped by it.
• Background location is used only while the person is checked in for their safety (More → Settings → My safety; Check in on an appointment) with Share where I am on, and stops when they check out. The blue location indicator shows throughout. The app never requests Always authorization.
• The microphone is used only while the person talks out loud to the Assistant or records a voice note.
• Anything you ask the Assistant is sent to Anthropic's Claude, or to OpenAI as a backup when Claude is unavailable. The first use explains that and asks for permission; the demo login has not yet given it, so the consent screen can be seen.
• The app never takes a card number. Payments happen on the payment provider's own hosted page in the browser.
• Some desk work — workflow editors, business settings, members, payment connections — opens the web app in Safari on purpose. It is the same account.
• Account deletion is in More → Settings → Delete my account. If you try it, please use a new account (Create an account on the sign-in screen), so the demo account stays for later reviews.

9. Version release: Manually release this version.

Save. Then list every section on the page as Done or Needs me, and anything Apple marks as missing. Don't press Add for Review.
```

**Then upload the screenshots yourself**, from `apps/mobile/store/assets/screenshots/`: the eight `ios-…` files, in
order 1, 2, 3, 4, 5, 5b, 6, 7, into the iPhone 6.9" slot.

## Going live

Only once both apps work from TestFlight and internal testing, and you've decided to go.

### L1. Send the iPhone app for review

```
Please send my iPhone app HandsFreeOS for App Review in App Store Connect. I've decided to go. I'm signed in already.

Rules: never type a password or a sign-in code. Read me anything Apple asks before you answer it.

Go to https://appstoreconnect.apple.com/apps/6813606312 and open version 1.0. Check, and tell me, that:
- a build is attached, and its number;
- screenshots, description, keywords, support URL, age rating and App Privacy are all filled;
- App Review Information has the sign-in user name app-review@handsfreeos.com and a password (don't show me the password);
- Version release is set to Manually release this version.

If anything is missing, stop and tell me. If it's all there, press Add for Review, read me the summary, and after I say yes, press Submit for Review. Tell me the status it shows afterwards.
```

Apple usually answers in a day or two. When it's approved, it waits for you: press **Release This Version** yourself
when you're ready.

### L2. Send the Android app to production

```
Please get my Android app HandsFreeOS ready for a production release on Google Play. I've decided to go. I'm signed in already.

Rules: never type a password or a sign-in code. Don't pay or accept agreements. Read me the summary before anything is sent for review, and wait for my OK.

Go to https://play.google.com/console → HandsFreeOS.

1. Dashboard: tell me whether Play lets this app go to production yet. If it asks for a closed test with a number of testers over a number of days, or for "Apply for production", stop and tell me exactly what it asks.

2. Publishing overview: tell me whether Managed publishing is on. If it's off, turn it on, so an approved release waits for me to publish it.

3. Production → Countries/regions: tell me what's set and ask me which ones I want.

4. Production → Create new release → Add from library: pick the build that's on Internal testing now, and tell me its version code. Release notes, English (United States): First release of HandsFreeOS.

5. Press Next and read me every error and warning. Then, after I say yes, save and send the changes for review. Tell me the status afterwards.
```

### L3. When a store says no

```
One of the app stores sent back my app HandsFreeOS. I'm signed in already. Please don't reply to the reviewer, change anything, or resubmit.

Open App Store Connect (https://appstoreconnect.apple.com/apps/6813606312, the App Review messages) or Google Play Console (HandsFreeOS → Inbox, or Policy status), whichever has the rejection. Tell me:
1. The guideline or policy it names, and the reviewer's words exactly.
2. Any screenshots or steps the reviewer attached, described in plain words.
3. In plain words, what you think they want changed.
4. A short, polite reply I could send, for me to read first.
```

Bring the rejection back to a Claude Code session on this repository too: most fixes are a change to the app or to the
files beside this one, and the reply is better once the fix is real.
