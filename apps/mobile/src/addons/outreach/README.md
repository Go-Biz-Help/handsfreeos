# Social Outreach on the phone

Decision 44 in `docs/outreach.md` (part 5 of the settings work): the whole add-on as one item under More, at the
web's own addresses, so a link or a push to `/a/outreach?view=…` or a playbook opens here.

## Where things go

- **Routes** sit inside More: `src/app/app/w/[workspaceId]/(tabs)/(more)/a/outreach/`. `index.tsx` is the page,
  whichever screen `?view=` names (`page.tsx` picks it), and `playbooks/[playbookId].tsx` one playbook. With no
  `?view=`, the add-on's first screen (`home.tsx`) lists its pages in the web's side-menu order (decision 127: Needs
  you, Today, People, Groups, Results, Playbooks and Settings, core's `pages.ts`), each opening as its own screen
  with its name at the top (`frame.tsx`). Needs you is `?view=waiting` (`NeedsYouScreen` in `waiting.tsx`).
  `_layout.tsx` is the gate: only someone holding `outreach.use`, which they hold only while the add-on runs here.
- **Screens** are in this folder, one file a page: `waiting.tsx`, `hub.tsx` (Today), `live.tsx`, `today.tsx`, `groups.tsx`, `chats.tsx`,
  `playbooks.tsx`, `playbook.tsx`, `settings.tsx`; `more.tsx` is the one row in More, `asks.tsx` the buttons
  that ask the computer, and `person-menu.tsx` the person menu on every name. Each has a pure `…Body` the
  tests draw with props, and a `…Screen` that asks for what it shows. Only the routes and `src/addons/registry.ts`
  import from here.
- **Settings is a menu with a page for each part** (Chris, 2026-10-16; core's `settings-parts.ts`): `settings.tsx` is
  the menu (General, each network with whether it's on, the networks still to come, and Your computer, and
  Settings for, for owners and admins) and a part's page, opened over it with `?part=` (`openSettingsPart` in
  `kit.tsx`, which puts the part on the screen's address itself, since the manifest's link keeps only the query it
  lists); an address with no part opens the menu. `settings-general.tsx` is General and its For your team,
  `settings-network.tsx` a network's page and the team's say on it, `settings-bits.tsx` the controls and choices they
  share. Every change saves as it's made, with no Save button (`autosave.ts`): a tap at once, a stepper after a short
  pause, one save at a time, the page's line under its title saying how the latest went; a refused save goes back to
  what's kept with the server's words. Only the extension's link has its own button. General's countries
  (`country-setting.tsx`) wait while Only these countries has none picked (`useAutosave`'s `hold`), and lead to the
  lists they make, each its own screen (`countries.tsx`, `?view=countries&show=unsure|skipped`). Your computer opens
  the Live screen, where the person's computers are renamed or removed (`computers.tsx`).
- **Words** are core's: `@hfos/core/addons/outreach/words` (`OUTREACH_WORDS`, which the web's pages read too), and the
  add-on's own (`waiting-words.ts`, `live.ts`, `automation.ts`, `today.ts`, `groups.ts`, `chat-read.ts`,
  `playbooks.ts`, `asks.ts`) first. `phone-words.ts` holds the few the web still writes in its screens, word for
  word, until they move into core. Don't write a sentence in a screen.
- **Activity and Friends stay on the web** (the manifest's `ui.phone` `web`): the route map opens them there, and
  `WebOnlyScreen` says so if one is opened here anyway.
- **Each network on its own** (docs/outreach.md, "Each network is in the app"): Today has a card for each
  network the person works, with its own bars (`useNetworksOn` in `networks.tsx`), each with its own live answer and its own Start my
  day and Stop for today (`useLiveProps(full, platform)`, `startDay(ws, platform)`); the list below is the network
  picked there (`useTodayProps(platform)`), with its own helpful post (on LinkedIn, the person's own feed) and its
  own Get ready (`useReadyProps(platform, onReady)`: LinkedIn's profile list, headlines and About); each other row's
  Start my day waits on its own readiness. The live screen shows one network's day, picked by name (`?net=`). The
  pipeline and chats show each row's network by name and narrow to one (`NetworkName`, `NetworkFilter`); Settings
  has a page for each network, with the team's say on it; a playbook has its networks part. A network's words
  are core's (`@hfos/core/addons/outreach/network-words`, `profileWordsOn`, `helpfulWordsOn`).

## What works with no signal

- **Waiting for you's messages** come from the phone's copy (`copy.ts`, `addon_phone_rows` source `sends`), kept to
  their person by HandsFreeOS (`private.addon_phone_own_table`, 20261027001800) and read by core's `waitingOfCopy`.
  OK, change, skip and Approve all (`actions.ts`) go through the queue: each writes the message's new state into the
  copy in the same transaction (SQLite's `json_set`, checked by `src/sync/__tests__/phone-sql.test.ts`), so it
  leaves the list at once, and stays off it while the change hasn't gone (`OUTREACH_PENDING_SQL`), even once
  HandsFreeOS's row comes back. An OK waits 30 minutes, then asks "Still send?"; a skip waits as long as it takes. The
  Change sheet checks the words as HandsFreeOS will (`SendText`) before the OK waits on the phone.
  Approve all names what the screen showed, with `partial`, so one handled elsewhere meanwhile is passed over.
- **Start my day and Stop for today** wait on the phone too, and the Live screen says "It goes when you're back
  online." under them. A press shows only while it waits on the phone (`pressShown`); once it has gone, HandsFreeOS's
  answer shows, whatever it says.
- **Asking the computer** (decision 43, `asks.tsx`) needs signal: the Groups and Chats screens' buttons
  (`outreach.ask.make`, online, so never queued), the line under each with **Carry on**, **Skip** and **Stop**, the
  Live screen's **Asked of your computer** and Waiting for you's **Your computer needs you**. `outreach.asks` is asked
  again every 15 seconds while a screen with asks is open, and a screen reloads its list once an ask ends done.
- **The person menu on every name** (decision 91, `person-menu.tsx`, as the web's): on Waiting for you's cards,
  Today's list, the Pipeline and Chats, the name is a button (labelled with the name, 44 points tall, with a hint
  saying what it opens) that opens the person's menu. A screen makes its names buttons by putting `PersonMenuScope`
  around them (the business, the signal, `writesContacts` from `records.write`, and what to reload after a change);
  with none, or no profile (the phone's copy of a message gives ''), the name is words. Core's `personMenuItems`
  decides the order, what shows and the words, the web's too. **Open on {Network}** comes first and **Open in
  {messages}** second when the chat is known: both work with no signal. Everything else needs signal, and with none
  shows greyed out under a note saying so: where they stand (`outreach.profile.marks`, asked each time the menu
  opens, its switches waiting till it answers); **Add to Contacts**, asking for the customers with the same name
  first (`outreach.lookup`, `sameNamePeople`) with **It’s them** or **Add as new** (`outreach.profile.contact`);
  **Mark as client**, through the same same-name step when they aren't in Contacts, or **Not a client after all**
  (`outreach.client.set`), or a line saying why Contacts counts them a client; **Demo booked**
  (`outreach.demo.mark`); **Don’t pitch** and **Never contact**, or taking them off, or who put them on
  (`outreach.friend.set`). Add to Contacts and Mark as client show only for someone who may add and edit customers.
  Partners' names on Today stay words, and Chats leaves out Don’t pitch and Never contact, which each chat has as
  switches. The Pipeline's cards keep their own marks, so its menu has no moves. Each card keeps its own Open
  button. All of these are online commands, so nothing is queued.
- **Get ready** (decision 63, `ready.tsx`) shows above Today's list until the person is ready, as the web's card,
  and Start my day waits, saying beside it what holds the day and where it's done (`notReadyWords`), on every row of
  the strip. Their profile never holds it (decision 90): once nothing else is left, the card stays while the profile
  is, as advice beside a Start that works. Their profile list and their goal are done right there, with signal
  (`outreach.readiness.profile`, `.numbers`), and so are their messages (`ready-messages.tsx`): written and written
  again by the AI, changed, and OK'd; the main offer is built on a computer (core's Settings → Main offer reviews it
  on the phone). The same profile list is **Your profile** on each
  network's page of Settings (decision 80, `useProfileProps`), a network still looked at among them.
- **The AI** (AI help on a playbook's parts in `ai-help.tsx`, the short video's script in `playbook.tsx`, and the
  sample messages) is the worker's add-on actions (`workerPost` to `/v1/addons/outreach/actions/<name>`:
  `outreach.playbook.assist`, `outreach.video.script`, `outreach.messages.samples`, `.rewrite`), with signal. What a
  playbook's help writes is only offered, and saved with the part.
- **Everything else** asks HandsFreeOS (`useOutreachAnswer`, on `@/lib/live-answer`), and with no signal says
  "… needs signal. Try again when you're back online." The Live screen asks again every minute
  (`LIVE_REFETCH_SECONDS`) and keeps the last answer, "As of 2:14 PM".

## Changing it

- A query a screen asks is listed in `QUERIES`, and a command it sends in `PHONE_COMMANDS` (`src/changes/commands.ts`)
  and the contract (`packages/core/test/mobile-contract.test.ts`, `UPDATE_CONTRACT=1`).
- What the phone keeps of the add-on is the manifest's `offline` and the migration together; `outreach-phone.test.ts`
  holds them equal, and holds `waitingOfCopy` to `outreach.waiting`.
- A playbook is saved a part at a time: the screen asks for the playbook again and puts only the part changed on it
  (`mergeSection`), so a change made meanwhile on the web stays.
- No clipboard package is in the app, so a message's words are selectable text rather than a Copy button.
