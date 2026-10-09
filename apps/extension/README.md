# HandsFreeOS Social: the browser extension

The extension that works beside a person on Facebook, and later LinkedIn and Instagram, for the Social Outreach
add-on (docs/outreach.md). It connects to HandsFreeOS only for businesses that have that add-on on.

**This is the eighth test build (0.8.0).** It reads the Facebook page you have open and shows what it found in
Chrome's side panel. Signed in to HandsFreeOS, it marks the people and chats already saved there, saves the profile or
chat you have open when you press its button, and notes the friend requests, likes, comments and messages you send
yourself, with the group you found each person in. It saves your friends and the friend requests you've got or sent,
puts the requests in order of how they fit your playbooks, notes when you confirm or delete one, and marks the people
to keep and the ones nobody pitches. It reads your Messenger chats for the AI, saves groups and their members with how
each group fits, and gives you a list for the day with the AI's drafts to copy. It gets your Facebook download file
for you and brings it in, and cancels old friend requests and unfriends the people you tick. It stops for the day on
any Facebook warning. It never sends anything on Facebook, and never clicks, scrolls or changes the page, except on
Facebook's own download pages, in Messenger's chat list, and on the profiles you ticked, once you ask it to.

## What it reads

| Page                                        | What it shows                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A profile                                   | Name, bio and details, whether you're friends, mutual friends, recent posts                          |
| Friends, followers, following, friends list | Each person, with the line under their name                                                          |
| Your friend requests                        | Each request in the list beside the page, how long ago and their mutual friends; answered ones too   |
| A group's People tab                        | The group, and each member with the list they're in; admins and moderators are marked to leave alone |
| A group                                     | The group (public or private, members, joined or not) and its posts                                  |
| Your groups                                 | Each group, with the line under its name                                                             |
| Search results                              | People, groups and posts                                                                             |
| Chats, and an open chat                     | Each chat with its last message; an open chat's messages, who sent each, when                        |
| Notifications                               | Who accepted your request, reacted, commented or mentioned you                                       |
| Any page                                    | Facebook's warnings: a temporary block, a limit, a security check                                    |

Facebook loads lists as you scroll, so the extension only sees what's on the page. With **Read when the page
changes** on, the panel reads again as Facebook adds to the page, and when you reload it or go somewhere new;
otherwise press **Read this page**. A group's People tab shows only a few of each list, admins and moderators too:
its **See all** pages are read the same way.

Facebook draws some pages two ways, and both are read. Since 2026 a profile can have its name, bio and details at the
top instead of an Intro card, a group's People tab has a row of faces above its tabs (left out: the lists below say
who each person is), an open chat repeats each message at the end of it for screen readers, saying who sent it
(read once, and used to tell whose it is), and posts in the News Feed aren't articles while their comments are
(comments are never read as posts). A friend request shows the faces of mutual friends, which link to them: each
request is about the one person it names in words, and the faces aren't requests. Facebook keeps a hidden copy of
each request's Confirm and Delete beside the ones shown (left out), and a request you've just answered says so in
place of them ("Request accepted") until the page loads again. **View sent requests** opens the ones you've sent
in a box over the page, and Facebook hides the page behind it: while the box is open, it's the list that's read.
Picking someone in the list opens their profile beside it, with **Confirm request** and **Delete request** under its
intro and the same two in its **Respond** menu; its address has their number and its tabs their username, and the
answer is noted with both. A chat open in a small window over another page is known by its messages, labelled as the
conversation, and is with whoever its header links to.

## Signing in and saving

The panel signs in the way the phone app does: an emailed 6-digit code, or a password, for an account that already
exists (new accounts start on the web). It then saves to one business, picked at the top of the panel when there are
several. Only businesses where Social Outreach is on and the person has **Use Social Outreach** are listed; with none,
the panel still reads pages and says there's nowhere to save.

| Page      | What it adds                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A profile | **Save to HandsFreeOS**: adds them to Contacts (source Facebook) with their intro and where you stand, or brings a saved one up to date. Customers with the same name are offered first: **It’s them** links the profile to one                                                        |
| A chat    | **Save this chat**: the messages on the page join what was saved before, the latest 100 kept, each with the day it was sent spelled out ("Today" becomes the date)                                                                                                                     |
| Lists     | **In HandsFreeOS** beside each person saved there, and **Saved** beside each chat you've saved                                                                                                                                                                                         |
| Friends   | **Save my friends**, **Save these requests** or **Save these sent requests**: everyone loaded on the page, 500 at a time, for the Friends tab in Social Outreach, but no request already answered. Nobody is added to Contacts                                                         |
| Groups    | **Save these groups** on your groups or a search for groups, each shown with how it fits your playbooks (Work these, Maybe or Skip, and why). On a group, **Save this group**; on its People tab, **Save this group and 40 people**, admins and moderators kept as such, 500 at a time |
| Admins    | On a group's **Admins and moderators** page (People, then **See all** beside them): **Save 3 admins and moderators**. Everyone there runs the group; Today suggests the group's members only once this page is saved                                                                   |

Saved people link to their page in HandsFreeOS, where a **Social** card shows their profile and chats. Each save says
what it did in the line under **Read this page**. If Social Outreach is turned off while the panel is open, the next
save or look-up says so and the business leaves the list.

On a profile, **Don't pitch** puts them on the business's list: nobody there sends them outreach, and a step you take
with them isn't counted (it shows as **Not saved**, with why). Customers tagged **Friend or family** in Contacts count
too. Only whoever added someone, or an owner or admin, takes them off. For a friend, **Keep** means they're never
suggested for unfriending. Lists mark both. Your requests are put in order of how they fit the playbooks in use, the
best first, with why: the words a playbook puts in quotes found in their profile, its area, mutual friends, and the
group they were found in (`packages/core/src/addons/outreach/fit.ts`).

## What it notes

Signed in, the extension notes four steps as you take them on Facebook yourself, in any Facebook tab, with the panel
open or not (decision 8 in docs/outreach.md), and your answers to the friend requests you get. It notes who each step
was to, never what you wrote.

| Step           | Noted when you…                                                                   | To                                                                  |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Friend request | press **Add friend**                                                              | the profile it's at the top of, or the one person its card links to |
| Like           | press **Like** on a post or a comment (not when you take a like back)             | whoever wrote the post or the comment                               |
| Comment        | press Enter or the send button in a comment box with something in it              | whoever wrote the post, or the comment you're replying to           |
| Message        | press Enter or the send button in a chat, or in a small chat window over a page   | who the chat is with                                                |
| Confirm        | press **Confirm** on a friend request you got, or in a profile's **Respond** menu | who asked: they're your friend in HandsFreeOS too                   |
| Delete         | press **Delete** on a friend request you got, or in the same menu                 | who asked: their request is kept as deleted                         |

Each step is kept with the group you found the person in: the group whose page or post it was on, or the group you
opened their profile from earlier (remembered until Chrome closes). HandsFreeOS works out whether a message started a
chat, followed one up on a later day, or answered them. Noting adds nobody to Contacts: a person reached is kept with
their profile until you save them.

Left out: other reactions than Like, steps to yourself, and a step it can't tie to one person, such as a button on a
card with several people. Popups and Facebook's other layouts may slip past; tell us what it missed, with an outline.
Answers to requests aren't outreach, so they don't count toward the daily limits.

**Today on Facebook**, in the panel, shows today's steps against the daily limits, the people reached and who wrote
back, and the last few steps noted, with **See all** opening the activity on the Social Outreach page. **Note what I
do on Facebook** turns noting off and on; it starts on. When HandsFreeOS can't be reached, steps wait in the extension,
up to 200, and go in order when it's back.

## Your chats, for the AI

Facebook's file can take hours to be ready, so the panel reads your chats in Messenger too. With **Read chats I
open** on (it starts on), each one-to-one chat you open with the panel beside it has its latest messages sent for the
AI to read. **Read my chats**, on a Messenger page, opens your chats one at a time from the list, 7 to 14 seconds
apart, and scrolls the list for more: up to 150 a run, skipping any read in the last day that hasn't changed, and
stopping at once on any Facebook warning. **Stop** ends it. Group chats are left out. Each chat's latest 20 messages
join what the file brought in, one chat per person, and the Chats tab on the web shows what the AI made of them, with
**Open in Messenger** (`src/panel/chats.ts`, `outreach.chats.collect`).

## Your list for today

Under **Today on Facebook**, **Your list for today** (`outreach.today`) is what to do next, worked out from what
HandsFreeOS knows each time it's asked:

- **Send a friend request**: people saved from your groups who fit a playbook, best first, as many as today's limit
  has left. Never anyone who runs a group, is on Don't pitch or tagged Friend or family, is in Contacts, or has had a
  request from the business, and only from groups whose admins and moderators are saved.
- **Say hi**: friends who accepted your request a day or more ago and haven't had a message.
- **Follow up**: likely prospects whose chat ends with your message, a few quiet days ago.
- **Reply**: likely prospects who wrote last, lately.

Each opens their profile or chat on Facebook, and a message has **Draft a message**: the AI writes three to pick from,
in the playbook's tone and never with its words to avoid, and **Copy** puts one on the clipboard to paste and send
yourself. Drafts count against the business's daily AI limit. The step you then take is noted as usual, which takes
it off the list. The Today tab on the web shows the same list.

## Tidying up your friends

**Tidy up your friends**, under your list for today, lists the friend requests you sent that nobody answered after
the business's wait (3 weeks to start; Add-ons → Social Outreach), and, once your Facebook file is in, friends to
unfriend: never kept, not in Contacts, not on Don't pitch, with no likely-prospect chat, friends for over six months
and with no message either way in six months (`outreach.friends.tidy`). Tick who, then **Cancel the ticked
requests** or **Unfriend the ticked** (decision 17 in docs/outreach.md).

It opens each profile in a tab you can see, checks it's the one you ticked and where you stand, presses **Cancel
request** (or **Friends**, **Unfriend** and **Confirm**), and checks the profile says **Add friend** after before
noting it (`outreach.friend.end`). One person every 20 to 40 seconds, up to 30 cancelled and 20 unfriended a day.
A step it can't find, it hands to you: press it, then **Carry on**, or **Skip** them. **Stop** ends it
(`src/panel/tidy.ts`, `src/facebook/tidy.ts`).

## Facebook's warnings

Any warning the panel sees on a page ("You’re temporarily blocked", "going too fast", a security check) is noted in HandsFreeOS once a day
(`src/panel/warnings.ts`, `outreach.warning.note`, decision 25). The extension then stops for the day: no more chats
read, nobody cancelled or unfriended. For 7 days your daily limits are halved, and for 2 friend requests are off your
list. A red note says so under **Today on Facebook**, and on the web's Today tab and activity panel.

## Getting your Facebook file

**Your Facebook file**, in the panel, gets Facebook's own copy of your friends, requests and chats for the Friends
tab in Social Outreach (decision 16 in docs/outreach.md). Each button opens the page in a tab you can see and presses
Facebook's buttons there, one step at a time:

| Button             | What it does                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask Facebook       | In Accounts Center's Export your information: keeps only Messages, Friends and Followers, sets All time, JSON and Lower quality, and starts the export; stops if Facebook is making one already |
| Download my file   | Once Facebook has emailed you, presses Download beside the file                                                                                                                                 |
| Get my chat backup | From ⋯ beside Chats, Privacy & safety, End-to-end encrypted chats, Message storage: downloads the backup from all time without media, for chats newer than the download has                     |

Facebook asks for your password before it hands over the file, and your PIN for the chat backup: you type them in
the tab, and the panel carries on once they're in. When it can't find a step (Facebook draws these pages differently
for different accounts), it says which button to press; press it yourself, then **Carry on**. **Stop** ends it.

The zips Facebook gives you show under **Files in your downloads**, however they were downloaded. The first time,
Chrome needs your OK to let the extension open them: **Open the extension's settings** goes to its card, where you
turn on **Allow access to file URLs**. Then **Read** opens them where they are, shows what's in them, and **Bring them
in** sends HandsFreeOS names and dates, plus each one-to-one chat's latest 20 messages for the AI to read (the Chats
tab on the web), as the Friends tab's card does.

## Load it in Chrome

1. Build it: `pnpm --filter @hfos/extension build`. It lands in `apps/extension/dist/chrome`. To sign in, the build
   needs HandsFreeOS's publishable Supabase key in `HFOS_SUPABASE_PUBLISHABLE_KEY` (see "Where it signs in" below);
   without it the panel reads pages and doesn't sign in.
2. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick that folder.
3. Pin it from the puzzle-piece menu, open facebook.com, and press its button: the side panel opens beside the page.
4. To bring in your Facebook file from your downloads, press **Details** on its card and turn on **Allow access to
   file URLs**.

After a rebuild, press the reload arrow on the extension's card. A Facebook tab that was open before the extension was
loaded gets the reader the first time the panel asks.

`node scripts/build.mjs --watch` rebuilds on every change.

## Where it signs in

The build writes where it signs in and saves into the bundle, from these settings in the environment, or in `.env.local`
or `.env` beside `package.json` (both gitignored; `.env.example` lists them):

| Setting                         | Left out                                      |
| ------------------------------- | --------------------------------------------- |
| `HFOS_API_URL`                  | `https://api.handsfreeos.com`                 |
| `HFOS_WORKER_URL`               | `https://hooks.handsfreeos.com`, for drafts   |
| `HFOS_WEB_URL`                  | `https://app.handsfreeos.com`                 |
| `HFOS_SUPABASE_URL`             | `https://ybupfghakoszfcxhyrby.supabase.co`    |
| `HFOS_SUPABASE_PUBLISHABLE_KEY` | none: the build reads pages and can't sign in |

The publishable key is public, like the web app's `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and still stays out of the
repo. **Point it at your own computer:** `pnpm env:local` writes `.env.local` with your local stack's values, so a
build after it signs in to the API on port 4000.

## When it reads a page wrong

**Copy page outline** and **Save page outline**, at the foot of the panel, give the page's structure as plain text:
tags, roles, Facebook's own words and labels, and the shape of every link. Everything a person wrote becomes
`[2 words]`, and the people, groups and chats that links lead to become `{1}`, `{2}`…, the same number each time the
same one comes up. With the reader's counts at the top, that's enough to see what Facebook changed and fix the reader.

## Rules worth knowing before changing anything

- **Addresses first.** `src/facebook/urls.ts` decides what kind of page it is and what each link points to. Facebook
  changes its page code every week and its addresses hardly ever, so anything a link can tell, a link tells.
- **Never a class name.** Facebook's are scrambled and change constantly. The readers use links, roles, ARIA labels,
  headings and Facebook's own words (`src/facebook/vocabulary.ts`), in English for now.
- **Found by its link.** A person, group or chat is found by the link to it, and read from the largest box around that
  link that holds no link to anything else of the same sort (`collectLinked` in `src/facebook/dom.ts`).
- **Page order, not the boxes around things.** An outline leaves out the bare boxes Facebook wraps around everything,
  so a reader never counts on what sits directly inside or beside an element: it goes by what comes before or after
  it on the page (`isBefore`, `elementsAfter`). `test/boxes.test.ts` reads every test page again with a bare box around
  each element and expects the same.
- **Reading only when asked, and noticing only the person.** The content script reads when the panel asks, and while
  the panel watches its tab it says when the page has changed, so the panel can ask again. Besides that it only
  listens for the person's own clicks and Enter presses (`isTrusted`, never the page's), works out from the page
  around them whether one was a step and who to (`src/facebook/actions.ts`), and tells the background. It never reads
  what was written, writes to the page, clicks, scrolls or sends anything, but for the next rule. Later phases keep
  the owner's decisions:
  you press send by default, daily limits, and a stop for the day on any Facebook warning.
- **Opening chats only when asked, slowly.** **Read my chats** (`src/panel/chats.ts`) clicks the chat links in
  Messenger's own list and scrolls that list (`src/facebook/browse.ts`), nothing else: never a button, never a box to
  type in. One chat every 7 to 14 seconds, at most 150 a run, and it stops at once on a Facebook warning.
- **Pressing only on the download pages, only when asked.** `src/facebook/fetch.ts` presses Facebook's buttons only
  on Accounts Center's download pages and the chats (`fetchPage`), only for a job the person started in the panel,
  and only what's in the box on top, never behind it. It never types: a password or PIN box on the page makes it
  wait for the person. Each step lists the words it may go by, the likeliest first, and one it can't find is handed
  to the person rather than guessed. `test/fetch.test.ts` walks a made-up Accounts Center, and again with bare boxes.
- **Pressing on profiles only for the people ticked.** Cancelling and unfriending (`src/facebook/tidy.ts`) press only
  on a profile (`tidyPage`) the person ticked in the panel, after checking it's them (`sameProfile`) and where things
  stand. The first press is a button under their name, never a link or the Friends tab (`buttonsOnly`); Unfriend and
  Confirm are pressed only in Facebook's box on top (`inBox`). It re-reads the profile after and hands anything else
  to the person. `test/tidy.test.ts` walks a made-up profile's menu and box, and again with bare boxes.
- **A warning stops the day.** The panel keeps the day's warnings itself (`hfos.warned`), so reading chats and tidying
  refuse to start, or stop, even when HandsFreeOS can't be reached.
- **Saving only when pressed; steps noted as they happen.** Reading a page asks HandsFreeOS which people and chats on
  it are saved (the add-on's `outreach.lookup`), and nothing is saved until the person presses a button. The four
  steps are the exception, noted with `outreach.touch.save` as they're taken, and adding nobody to Contacts. Both go
  through the add-on's commands like any other client: `x-hfos-client: extension`, its version in
  `x-hfos-app-version`, and a command id and moment on every save, so the API can hold old builds to
  `MIN_EXTENSION_VERSION` and the audit log says "via browser extension".
- **Friends are each person's; Don't pitch is the business's.** Where your Facebook stands with someone (friends,
  asked, deleted) is kept for you alone, while the Don't pitch list is shared and says who added each person
  (`outreach.friend.set`). Older news never undoes newer: a list saved before an answer leaves the answer standing.
- **A step is counted once.** It gets its command id and moment when it's noted and keeps both while it waits, so
  sending it again gets the first answer (`src/hfos/noting.ts`). Waiting steps live in the extension's storage and
  go oldest first; one HandsFreeOS refuses is let go and shown as **Not saved**, with why.
- **Steps are found like pages are read:** by the button's label, the links around it and page order, never class
  names. `test/actions.test.ts` takes each step on the hand-written pages, and again with bare boxes around everything.
- **The background worker holds the sign-in.** It keeps the Supabase session in the extension's own storage and
  makes every call to HandsFreeOS (`src/hfos/session.ts`); the panel asks it (`src/hfos/messages.ts`), and it
  answers only the extension's own pages. One holder means panels in two windows never refresh the sign-in at once.
- **Cut to fit before sending.** `src/hfos/saves.ts` builds each save from the read, cut to what the commands take
  (`packages/core/src/addons/outreach/limits.ts`, which has no zod so the panel stays small), and keeps a chat's save
  under the API's 256 KB limit by sending the newest messages that fit.
- **Each reader checks itself.** When a page should have something and the reader finds none, the panel says so and
  asks for the outline (`src/facebook/page.ts`).
- **An outline never holds what a person wrote.** `test/outline.test.ts` checks that no name, message or id survives.
- **No remote code.** Everything ships in the bundle; the stores forbid downloading code.
- **No real Facebook pages in the repo.** The pages in `test/fixtures` are written by hand to look like Facebook's.
  A saved real page holds other people's names and messages, so tune the readers from outlines instead.

## Where things are

| Path                    | What it is                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/facebook/`         | The readers: one file per kind of page, the steps, the address rules, Facebook's words, the outline, the download steps                                  |
| `src/content.ts`        | The script in each Facebook tab: reads the page when the panel asks, and notices your steps and your Confirm and Delete                                  |
| `src/panel/`, `public/` | The side panel; `hfos.ts` is signing in, what's saved, the Save buttons, Keep and Don't pitch, `today.ts` the day and its list, `chats.ts` reading chats |
| `src/hfos/`             | HandsFreeOS: the sign-in and calls (background), the saves, the steps noted, Facebook's times, its zips in downloads                                     |
| `src/panel/fbfile.ts`   | Your Facebook file: the jobs on Facebook's download pages, the zips found, reading and bringing them in                                                  |
| `src/panel/tidy.ts`     | Tidy up your friends: the lists, and cancelling and unfriending in a tab you can see (`tab.ts`)                                                          |
| `src/panel/warnings.ts` | Facebook's warnings: noted once a day, and the extension stopping for the day                                                                            |
| `src/background.ts`     | Opens the side panel, answers the panel's HandsFreeOS asks, and notes the steps the tabs tell it                                                         |
| `scripts/build.mjs`     | Bundles with esbuild and writes `manifest.json`, with the version from `package.json`                                                                    |
| `test/`                 | The readers and steps on the hand-written pages, the addresses, the outline's hiding, the saves                                                          |

## Next

In the owner's order (decisions 18 to 24 in docs/outreach.md): openers on posts in your groups, with **Find posts**,
posts asking for help, and looking people up before drafting; then phone alerts, which openers work, and the demo
link. Then leads and results by group. Safari on Mac follows in Phase 2.
