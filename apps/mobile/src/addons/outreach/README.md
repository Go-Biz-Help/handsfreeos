# Social Outreach on the phone

Decision 44 in `docs/outreach.md` (part 5 of the settings work): the whole add-on as one item under More, at the
web's own addresses, so a link or a push to `/a/outreach?view=…` or a playbook opens here.

## Where things go

- **Routes** sit inside More: `src/app/app/w/[workspaceId]/(tabs)/(more)/a/outreach/`. `index.tsx` is the page,
  whichever tab `?view=` names (`page.tsx` picks the screen), and `playbooks/[playbookId].tsx` one playbook.
  `_layout.tsx` is the gate: only someone holding `outreach.use`, which they hold only while the add-on runs here.
- **Screens** are in this folder, one file a tab: `waiting.tsx`, `live.tsx`, `today.tsx`, `groups.tsx`, `chats.tsx`,
  `playbooks.tsx`, `playbook.tsx`, `settings.tsx`; `more.tsx` is the one row in More, `asks.tsx` the buttons
  that ask the computer, and `person-menu.tsx` the menu on each of Today's people. Each has a pure `…Body` the
  tests draw with props, and a `…Screen` that asks for what it shows. Only the routes and `src/addons/registry.ts`
  import from here.
- **Words** are core's: `@hfos/core/addons/outreach/words` (`OUTREACH_WORDS`, which the web's tabs read too), and the
  add-on's own (`waiting-words.ts`, `live.ts`, `automation.ts`, `today.ts`, `groups.ts`, `chat-read.ts`,
  `playbooks.ts`, `asks.ts`) first.
  Don't write a sentence in a screen.
- **Activity and Friends stay on the web** (the manifest's `ui.phone` `web`): the route map opens them there, and
  `WebOnlyScreen` says so if one is opened here anyway.

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
- **The person menu on Today** (`person-menu.tsx`, as the web's) needs signal: **Add to Contacts** asks for the
  customers with the same name first (`outreach.lookup`, `sameNamePeople`) and offers **It’s them** or **Add as new**
  (`outreach.profile.contact`); **Demo booked** (`outreach.demo.mark`) and **Don’t pitch** (`outreach.friend.set`).
  All three are online commands, so never queued.
- **Get ready** (decision 63, `ready.tsx`) shows above Today's list until the person is ready, as the web's card,
  and Start my day waits. Their profile list and their goal are done right there, with signal
  (`outreach.readiness.profile`, `.numbers`); the main offer and the playbooks are written on a computer.
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
