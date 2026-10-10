# Social Outreach

Social Outreach is an add-on (id `outreach`, in Sales) and a browser extension (`apps/extension`) that work beside a
person on Facebook, and later LinkedIn and Instagram. The extension reads the page they have open and notes the steps
they take there; the add-on keeps the people they find, their chats with them, what they've done, and the business's
playbooks in HandsFreeOS.

It's in `development`: offered to nobody, and installable only where HandsFreeOS staff hand it out to try
(docs/addon-architecture.md, "Handing one out to try").

## What's built

Phase 1, steps 1 to 5, the playbook builder, tracking with the activity panel, friends, Facebook's download
file's dates, chats read by the AI from the file or live in Messenger, groups, the list for today, tidying up friends,
Facebook's warnings, comments on group posts, looking people up before drafting, phone alerts, which openers work, the
demo link, and the extension working on its own (the first part):

- **The activity panel** (`/a/outreach`, the page's first tab): what the extension noted over today, the last 7 days
  or the last 30. People reached, friend requests, likes, comments, chats started, follow-ups and who wrote back; by
  the group each person was found in, and person by person with how far each has come; and the person's own day
  against the daily limits. Owners and admins can see the whole team's (`?who=everyone`).
- **Noting what the person does on Facebook**: signed in, the extension notes each friend request, like, comment and
  message the person sends there themselves, with who it was to and the group they found them in, never what they
  wrote. Its side panel shows the day so far (apps/extension/README.md, "What it notes").
- **Friends** (`/a/outreach?view=friends`): the person's friends against Facebook's 5,000, the friend requests
  they've got in order of how each fits the playbooks in use (with why), the requests they sent that nobody has
  answered, the friends they keep (never suggested for unfriending), and the business's Don't pitch list, each 100 to
  a page and searched by name as it's typed. The extension saves the friends list and the requests from Facebook's
  pages (the ones the person got and hasn't answered, and after View sent requests the ones they sent), notes Confirm
  and Delete as the person presses them, sorts the requests on the page by fit, and sets Keep and Don't pitch from a
  profile (apps/extension/README.md).
- **Facebook's download file** (the Friends tab's **Bring in your Facebook file**): the person picks the zips
  Facebook gives them, the "Download your information" file and the chat backup that holds the newer chats, and their
  browser reads them. Names and dates are sent: their friends and since when, the requests they sent and got,
  the friends they removed, the requests they deleted, their followers and who they follow, and when they last
  messaged each person; and each one-to-one chat's latest 20 messages, for the AI to read. The Friends tab then says "Friends since Mar 2019" and the latest message either way, and a
  sent request shows the day it really went. The extension can get the file too (decision 16): its panel's **Your
  Facebook file** asks Facebook for it, downloads it when it's ready and gets the chat backup, pressing the buttons on
  Facebook's own download pages, then finds the zips in Chrome's downloads and brings them in the same way.
- **Chats** (`/a/outreach?view=chats`, decision 3): each one-to-one chat in the file, read by the AI from its latest
  20 messages: a short summary, the playbooks' tags that fit, whether they look like a prospect, and a next step. The
  likely prospects first, then the tagged, every chat read, and the ones not read yet; a tag and a name narrow it,
  50 to a page. Who goes in Contacts is the business's setting (Add-ons → Social Outreach): anyone tagged or looking
  like a prospect (the default), everyone, or only likely prospects. They're added with their tags and a timeline
  line with the summary; someone already in Contacts gets the tags whatever it says.
- **Chats read live** (decision 3, without waiting for the file): the extension sends each one-to-one chat the person
  opens in Messenger with its panel beside it, or, with **Read my chats**, opens their chats one at a time at a steady
  pace and stops on any Facebook warning. Each chat's latest 20 messages join the file's, one chat per person
  (`chat-collect.ts`, `outreach.chats.collect`), and are read the same way. A chat read live keeps its Messenger
  thread, so the Chats tab can **Open in Messenger**.
- **Groups** (`/a/outreach?view=groups`, step 4): the groups the extension saved from the person's groups, a search,
  or a group's own page, each scored against the playbooks in use as **Work these**, **Maybe** or **Skip**, with why:
  a playbook's words to search for groups, its area or a quoted sign in the name, size, and whether the person is in
  it (`groups.ts`). A group's People tab saves its members with the lines under their names; admins and moderators
  are kept as running it for good, and a group's full list of them (its **See all** page) marks the group's admins as
  read. Nobody is added to Contacts.
- **Today** (`/a/outreach?view=today`, step 5, and in the extension's panel): the person's list for the day, worked
  out each time from what HandsFreeOS knows (`today.ts`, `ops/today.ts`). Friend requests to people from the groups
  who fit a playbook, best first and as many as today's limit has left, only from groups whose admins are read and
  never to anyone who runs a group, is on Don't pitch, is in Contacts, or has had a request; a first message to new
  friends who accepted the person's request; follow-ups to likely prospects gone quiet (the playbook's pace);
  replies owed; and comments on good group posts (below). With **Like a post first** on (decision 33, each person's
  own setting, on to start), someone's request waits until a day after one of their posts was liked, and the list has
  **Like a post first** for as many as a day's requests; a profile with no post to like goes without. Requests the
  person got from people who fit a playbook well come first, as **Confirm their request** (decision 30). A message has **Draft a message**: three drafts from the AI in the playbook's tone, from what's known
  about the person and the chat so far, to copy and send on Facebook (the worker's `outreach.today.draft` action,
  against the daily AI limit). HandsFreeOS never sends: the extension notes the step, which takes it off the list.
- **Tidying up friends** (decisions 10, 12 and 17, `tidy.ts`, `ops/tidy.ts`): the Friends tab and the extension's
  panel suggest the sent requests nobody answered after the business's wait (3 weeks to start, a setting on the
  Add-ons page), and friends to unfriend: only once the download file is in, and only those never kept, not in
  Contacts, not on Don't pitch, with no likely-prospect chat, friends for over six months and with no message or step
  in six months either way. In the panel's **Tidy up your friends** the person ticks who, and the extension opens each
  profile in a tab they can see, checks it's them and where things stand, presses **Cancel request** (or **Friends**,
  **Unfriend** and **Confirm**), checks the profile says Add friend after, and notes it (`outreach.friend.end`). It
  goes one person every 20 to 40 seconds, up to 30 cancelled and 20 unfriended a day, and hands any step it can't
  find to the person.
- **Facebook's warnings** (decision 25): any warning the extension sees on a page is noted
  (`outreach.warning.note`). That day it reads no more chats and cancels or unfriends nobody; for 7 days the daily
  limits are halved, and for 2 friend requests are off the list for today. A red note says so on the Today tab, the
  activity panel's day, and the extension's panel.
- **Posts worth a comment** (decisions 18 to 20, `posts.ts`, `ops/posts.ts`): with the panel open on one of their
  groups, the extension sends the posts in its feed that say a playbook's signs (the quoted words, or its words to
  search for groups) or ask for help ("Can anyone recommend…", "Looking for…"), with who wrote them; a skip word
  leaves a post out (`postLook`). Each person keeps their own. The AI checks each one (the worker's
  `outreach.check_posts`): good for the business to comment on, or not, with why. The panel's **Posts worth a
  comment** marks them, and its **Find posts** goes through the groups the person is in that are marked Work these
  (or Maybe, with none), up to 5 a run, in a tab they can see, scrolling each feed a screen at a time every 6 to 12
  seconds, 8 screens a group, and stops on any Facebook warning. The good ones from the last week go on Today as
  **Comment on a post**, with the post, a link to it and **Draft a comment** (two drafts), as many as today's
  comment limit has left; **Not for me** puts one aside for good. Commenting on it, which the extension notes, takes
  it off. Who wrote one is kept as a profile from the group, and nobody goes in Contacts.
- **Looking someone up before drafting** (decision 21): when the person asks for drafts in the extension's panel, it
  first opens the person's profile in a tab out of view, reads their intro and latest two posts, follows the link in
  their lines to the business they own or work at (`pages`, from `apps/extension/src/facebook/profile.ts`) and reads
  that page too, then closes the tab. Those lines go with the ask (`lookup`) for the AI to use, kept for nothing
  else. It skips this on a day Facebook warned them. The web's Today tab drafts from what HandsFreeOS knows.
- **Phone alerts** (decision 22, `alerts.ts`, `ops/alerts.ts`, the worker's `alerts.ts`): while noting is on, the
  extension looks at the chats on any Facebook page as it changes (Messenger's list, an open chat, a small chat
  window) and tells HandsFreeOS who wrote last in each, never what (`outreach.replies.note`). One that answers a
  message of the person's the extension noted is a reply: their phone hears "Dana Reyes wrote back", unless they had
  that tab in front of them, and they're on Today as a reply owed until the person answers. At the business's hour
  (`morningPushHour`, 8 AM to start, or off; Add-ons → Social Outreach, in the business's time zone) each person who
  noted a step in the last 14 days and has something on their list hears how much ("6 on your list for today").
  Both are add-on pushes (`pushAddonNotice`), on the person's add-ons switch, and open Today.
- **Which openers work** (decision 23, `openers.ts`, `ops/openers.ts`): each playbook keeps two or three styles the
  AI opens first messages in, and up to three of the business's own openers, sent as written with the first name
  filled in. A first message's drafts take the opener the person has used least, and copying one notes which it was
  (`outreach.opener.use`). The Playbooks tab's **Which openers work** card counts, for each, the first messages sent
  with it, who wrote back and who booked a demo; owners and admins see everyone's.
- **The demo link** (decision 24, `demos.ts`, `ops/demos.ts`, the worker's `demos.ts`): each person's own link to the
  playbook's booking page for someone they reached (**Copy demo link** on Today, in the web and the panel), with a
  `ref` naming who sent it to whom and nothing else. A booking page keeps the `ref` on the booking
  (`appointment_attendees.link_ref`), and a booking through it counts as that person's demo by itself
  (`outreach.demo.note`, from `appointment.booked`). **Demo booked** on a profile in the panel marks one booked some
  other way (`outreach.demo.mark`).
- **The extension on its own** (decisions 26 to 33, `automation.ts`, `ops/automation.ts`; the extension's
  `src/auto/`): each person picks, in the panel's **On its own**, whether the extension does their friend requests,
  likes and comments by itself (messages always wait for them), whether it likes a post first, whether it confirms
  requests from people who fit, and their working hours (9 to 5, Monday to Friday, to start, on the business's
  clock). It then goes down their list for today on its own, at random times spread over the hours, or straight away at
  a person's pace once they press **Start my day**; in a window of its own beside theirs, one step per alarm: it opens
  the profile or post, checks it's the right person and where things stand, presses **Confirm**, **Like**, **Add
  friend**, or writes the AI's first comment draft and sends it, checks it worked, and notes it as its own
  (`touches.auto`). The list only ever holds what today's limits have room for, so it keeps them. It stops for the
  day on any Facebook warning and on **Stop for today**, and works only while Chrome is open, someone is signed in
  and noting is on. Today, in the web and the panel, marks what it does as **Done on its own**, and the morning push
  leaves those out. Once a day, first, it does the jobs that fill that list
  (decision 32, the extension's `src/auto/daily.ts` and `src/jobs/`): it saves the friend requests the person has got
  (`outreach.friends.save`), then the admins and moderators of up to 3 of their Work these groups, read to the end,
  and their members (`outreach.group.save`), then Find posts (`outreach.posts.save`) and Read my chats, up to 60
  (`outreach.chats.collect`). Each reads and saves only, as the panel's buttons do, and a warning stops the day.
- **Playbooks** (`/a/outreach?view=playbooks`): what the business is looking for on social media, how it sounds and
  which of its tags to use. Each has a goal, an offer and link, who it's for, signs to look for and who to skip, where
  to look, the steps it takes and how fast, the tone, sample messages, the openers, the conversation, words to avoid,
  a disclaimer and the tags. The first template is **CRM demos**; a blank one is always there.
- **The playbook builder** (`/a/outreach/playbooks/new`, `/a/outreach/playbooks/<id>`): a playbook asked a step at a
  time, eleven steps from the goal to a summary, each with ideas to tap and room for the business's own words. The offer
  step offers the business's booking pages as the link, and the tags step its own tags. A new playbook walks every
  step; changing one opens on the summary, where each part has its own Change.
- **AI help on each part of a playbook** (owners and admins): under every part the person writes, **Improve**
  rewrites what's there and **Suggest more** (or **Write it for me**) offers more, from the whole playbook as it
  stands. Words come back three to pick from; list lines to tap in one by one, or a rewritten list to use instead;
  questions with their answers, what each leads to and only the playbook's own tags. Nothing is used until the person
  picks it, and it counts against the business's daily AI limit (`playbook-assist.ts`; the worker's
  `outreach.playbook.assist` action). The goal, link, steps and pace are choices, not writing, so they have none.
- **The conversation**: the questions to work into a chat, each with the answers people give. An answer can add one of
  the playbook's tags, and says what's next: the next question, a question further down, the offer, checking back
  later, or stopping. A question with no answers is answered in the person's own words.
- **Saving from the extension**: signed in, the extension saves the Facebook profile or chat open beside it when the
  person presses its button, and marks the people and chats on any page that are saved already
  (apps/extension/README.md, "Signing in and saving").
- **A Social card on each customer** (`person.panels`): their Facebook profile, and each chat saved with them.

## How it fits together

| Piece                                                    | Where                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Manifest, operations, tables, shapes                     | `packages/core/src/addons/outreach/`                                                                                            |
| What a save takes: lengths, counts, id shapes (no zod)   | `packages/core/src/addons/outreach/limits.ts`                                                                                   |
| Worker half: the AI reading the chats, and its drafts    | `apps/worker/src/addons/outreach/`                                                                                              |
| What the extension notes, and the panel's shapes         | `packages/core/src/addons/outreach/activity.ts`, `ops/activity.ts`                                                              |
| The page and its tabs, and the Social card               | `apps/web/src/addons/outreach/`, `/a/outreach`                                                                                  |
| The playbook builder                                     | `apps/web/src/addons/outreach/playbook-builder.tsx`, `/a/outreach/playbooks/…`                                                  |
| Tables and permissions                                   | `supabase/migrations/20261024000100_addon_outreach.sql`, schema `addon_outreach`                                                |
| Groups and steps noted                                   | `supabase/migrations/20261026000300_outreach_activity.sql`                                                                      |
| Friends, Keep and Don't pitch, and how someone fits      | `friends.ts`, `fit.ts` (no zod) and `ops/friends.ts` in the add-on's folder                                                     |
| Friends and the Don't pitch list                         | `supabase/migrations/20261026000400_outreach_friends.sql`                                                                       |
| Facebook's download file: reading it, and bringing it in | `download-read.ts` (reads the zips, no zod), `download.ts` and `ops/download.ts`                                                |
| The extension getting the file                           | `apps/extension/src/facebook/fetch.ts`, `src/panel/fbfile.ts`                                                                   |
| What the file said, by name                              | `supabase/migrations/20261027000300_outreach_facebook_download.sql`                                                             |
| Chats read live in Messenger                             | `chat-collect.ts`, `supabase/migrations/20261027000600_outreach_chat_reads.sql`                                                 |
| Groups, their people, and the list for today             | `groups.ts`, `today.ts`, `supabase/migrations/20261027000700_outreach_groups.sql`                                               |
| Tidying up friends, and Facebook's warnings              | `tidy.ts`, `ops/tidy.ts`, `supabase/migrations/20261027000900_outreach_tidy_and_warnings.sql`                                   |
| The buttons pressed to cancel and unfriend               | `apps/extension/src/facebook/tidy.ts`, `src/panel/tidy.ts`, `src/panel/warnings.ts`                                             |
| Posts worth a comment, and the AI's check of them        | `posts.ts`, `ops/posts.ts`, `supabase/migrations/20261027001000_outreach_group_posts.sql`                                       |
| Finding posts, and looking people up before drafting     | `apps/extension/src/panel/posts.ts`, `src/panel/lookup.ts`, `src/facebook/browse.ts`                                            |
| Replies, openers and demos                               | `alerts.ts`, `openers.ts`, `demos.ts` and their `ops/`, `supabase/migrations/20261027001100_outreach_replies_openers_demos.sql` |
| The pushes, and a booking through the demo link          | `apps/worker/src/addons/outreach/alerts.ts`, `demos.ts`; `apps/worker/src/addons/alerts.ts` (`pushAddonNotice`)                 |
| The extension on its own: choices, and the warm-up       | `automation.ts`, `ops/automation.ts`, `supabase/migrations/20261027001200_outreach_automation.sql`                              |
| Messages on their own, and training wheels               | `sends.ts`, `ops/sends.ts`, `supabase/migrations/20261027001300_outreach_sends.sql`                                             |
| The runner, and what it presses                          | `apps/extension/src/auto/plan.ts`, `src/auto/run.ts`, `src/facebook/auto.ts`, `src/panel/auto.ts`, `src/tab.ts`                 |
| Spotting replies on the page                             | `apps/extension/src/facebook/replies.ts`, `src/hfos/replies.ts`, `src/content.ts`                                               |
| The extension                                            | `apps/extension`                                                                                                                |

Operations, all through the kernel:

| Operation                                             | Who               | What                                                                                                     |
| ----------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `outreach.playbook.list`                              | `outreach.use`    | The playbooks, those in use first                                                                        |
| `outreach.playbook.save`, `outreach.playbook.archive` | `outreach.manage` | Write one; put one away or bring it back                                                                 |
| `outreach.profile.save`                               | `outreach.use`    | A profile as the extension read it: finds the customer it's saved to, or the one picked, or adds one     |
| `outreach.chat.save`                                  | `outreach.use`    | A chat as read: the new messages join what was saved                                                     |
| `outreach.lookup`                                     | `outreach.use`    | Which profiles and chats on a page are saved, who in Contacts has a name, and Keep and Don't pitch       |
| `outreach.person`                                     | `outreach.use`    | A customer's profiles and chats, for the Social card                                                     |
| `outreach.touch.save`                                 | `outreach.use`    | A step the person took on Facebook, as the extension saw it: to whom, and the group they came from       |
| `outreach.activity`                                   | `outreach.use`    | The panel's numbers over a stretch, with demos, by group and person; everyone's for owners, admins       |
| `outreach.friend.note`                                | `outreach.use`    | The person confirmed or deleted a friend request on Facebook                                             |
| `outreach.friends.save`                               | `outreach.use`    | The person's friends list or requests, as far as the page loaded, up to 500 at a time                    |
| `outreach.friend.set`                                 | `outreach.use`    | Keep (the person's own) or Don't pitch (the business's) for someone                                      |
| `outreach.friends`                                    | `outreach.use`    | The Friends tab: the counts, and a page of one list searched by name, the requests by fit                |
| `outreach.download.save`                              | `outreach.use`    | A part of Facebook's download file as the browser read it; the last matches names and puts it in         |
| `outreach.chats.collect`                              | `outreach.use`    | Up to 10 chats read live in Messenger: their latest messages join what's kept, for the AI to read        |
| `outreach.groups.save`                                | `outreach.use`    | The groups a page lists, with what it said about each, up to 100 at a time                               |
| `outreach.group.save`                                 | `outreach.use`    | A group and up to 500 people from its People tab; its admins page marks its admins as read               |
| `outreach.groups`                                     | `outreach.use`    | The Groups tab: the counts, and a page of groups, those bringing results first, then by fit              |
| `outreach.today`                                      | `outreach.use`    | The person's list for today, and today's steps against the daily limits                                  |
| `outreach.friends.tidy`                               | `outreach.use`    | Sent requests to cancel and friends to unfriend, with today's counts against their limits                |
| `outreach.friend.end`                                 | `outreach.use`    | The extension cancelled a request or unfriended someone for the person                                   |
| `outreach.warning.note`                               | `outreach.use`    | Facebook warned the person: halves their limits for 7 days, friend requests off their list for 2         |
| `outreach.posts.save`                                 | `outreach.use`    | Up to 30 posts from a group's feed: keeps those worth a look for the AI, and says how each stands        |
| `outreach.post.check`                                 | the worker        | What the AI made of a kept post: good, not, or couldn't be read, with why                                |
| `outreach.post.skip`                                  | `outreach.use`    | The person put a post aside: off their list for good                                                     |
| `outreach.replies.note`                               | `outreach.use`    | Up to 20 chats the extension saw whose last message is theirs: each answering the person's is a reply    |
| `outreach.opener.use`                                 | `outreach.use`    | The person copied a first message: which opener it was drafted with                                      |
| `outreach.openers`                                    | `outreach.use`    | Which openers work, ever or in a week or month: sent, replies, demos; everyone's for owners, admins      |
| `outreach.demo.mark`                                  | `outreach.use`    | Someone the person reached booked a demo some other way, or not after all                                |
| `outreach.demo.note`                                  | the worker        | A booking through someone's demo link, from core's `appointment.booked`: a demo, once a booking          |
| `outreach.automation`                                 | `outreach.use`    | What the person lets the extension do on its own, and their hours, in the business's time zone           |
| `outreach.automation.save`                            | `outreach.use`    | The person's own choices for the extension on its own                                                    |
| `outreach.warm_up.missed`                             | `outreach.use`    | The extension found no post of someone's to like: their friend request goes without                      |
| `outreach.send.queue`                                 | `outreach.use`    | A message the extension drafted: it waits for the person's OK, or goes as it is; a reply as Replies says |
| `outreach.send.approve`                               | `outreach.use`    | OK messages, changed or not; with none named, every one waiting (Approve all)                            |
| `outreach.send.skip`                                  | `outreach.use`    | Skip a message: not sent, and off the list for today                                                     |
| `outreach.send.done`                                  | `outreach.use`    | The extension sent an OK'd message, or couldn't, and why                                                 |
| `outreach.sends`                                      | `outreach.use`    | The person's messages waiting for their OK, and those OK'd, with their training wheels                   |
| `outreach.wheels`                                     | `outreach.manage` | Who's on training wheels, and how far each has come                                                      |
| `outreach.wheels.end`                                 | `outreach.manage` | End someone's training wheels early                                                                      |

Permissions: **Use Social Outreach** (`outreach.use`, owners, admins and members) and **Run Social Outreach**
(`outreach.manage`, owners and admins, which needs `outreach.use`).

The extension calls these like the phone app calls core's: `x-hfos-client: extension`, its build in
`x-hfos-app-version` (held to `MIN_EXTENSION_VERSION` on the API when that's set), and a command id and moment on
every save, so a repeat gets the first answer and the audit log says "via browser extension".

## The owner's decisions

The owner answered the plan's questions on 5 Oct 2026. These are settled: ask before going against one.

1. **Sending is a setting, per person.** (a) They approve each one, the default; (b) likes and reactions happen on
   their own and they send the words; (c) fully hands-off, inside the daily limits. Every mode keeps the limits and
   stops for the day on any Facebook warning. In hands-off, a reply waits for the person unless "answer replies" is
   also on, and those replies follow the AI teammate's rules (`packages/core/src/ai-team/guardrails.ts`). The Chrome
   Web Store won't list an extension that sends without the user confirming, so hands-off lives only in a build
   loaded by hand.
2. **Old friends and chats come in either way:** Facebook's download file (the default), or "Collect from Facebook",
   where the extension scrolls the friends list and chats itself at a steady pace and stops on any warning.
3. **What goes in Contacts is a setting:** everyone, the tagged, or only likely prospects.
4. **The owner tests first,** loading the extension by hand. No store listing yet.
5. **Templates after CRM demos:** real estate agents, home services, then coaches.
6. **Only with the add-on.** The extension connects only to businesses where Social Outreach is on and the person
   has `outreach.use`. HandsFreeOS refuses it elsewhere, and it stops and says so when the add-on is turned off.

The owner answered the next round on 6 Oct 2026 (plan.md, "Next: what you asked for on 6 Oct"). These are settled too:

7. **An activity panel in both places:** the full view on the Social Outreach page, today's numbers in the
   extension's side panel. Requests sent and from which group, likes, comments, chats started, replies. Built.
8. **The extension notes what the person does on Facebook themselves:** Add friend, Like, Comment and Send, with the
   group they found the person in. It replaces "nothing is saved until the person presses a button" for those four
   steps. Built.
9. **Playbooks are asked, not filled in,** and have a conversation where each answer adds a tag and picks what's
   next. Built.
10. **Unfriending is a setting:** suggestions confirmed one by one (the default), or on its own within a daily limit
    in the build loaded by hand.
11. **Don't pitch stops everything:** friend requests, likes, comments and messages. Built: a step the extension
    notes to someone on the list isn't counted, and the Friends tab and the extension mark them.
12. **Sent requests nobody answers are cancelled after 3 weeks, with the person's OK.** The wait is a setting.
13. **The order:** the playbook builder, then tracking and the activity panel, then friends (requests received, the
    friends list, Keep and Don't pitch). Built, with cancelling and unfriending (decision 17).
14. **Confirm and Delete are noted** as the person presses them on a friend request they've got, like the other steps
    (a question answered the same day): Confirm makes them a friend in HandsFreeOS, and Delete marks the request
    turned down. Built.
15. **Cancelling old requests and unfriending come after the download file import,** which brings when each request
    was sent and when the person last talked to each friend. Until then the extension knows only what it has seen
    since it started noting, too little to cancel or unfriend on.

The owner answered on 9 Oct 2026, asking for it ("can we have the extension take control of the browser and get the
files on its own"), and picked doing it before the chats:

16. **The extension gets Facebook's file for the person.** Once they press its buttons, it presses Facebook's on the
    download pages, in a tab they can see: it asks for the file (Messages, Friends and Followers only, all time,
    JSON, lower media quality), downloads it when it's ready, and gets the chat backup (all time, without media). The person types their password and
    PIN; the extension never does. A step it can't find, it hands to the person and carries on after. It reads the
    zips from Chrome's downloads once the person turns on Allow access to file URLs, and brings them in as the Friends
    tab does. Built, not yet tried on the owner's account.

The owner asked for the next round on 9 Oct 2026 ("lets build 1-5 and cancel old friend requests, unfriending, and
openers on group posts") and answered its questions the same day. These are settled too:

17. **The extension presses Cancel request and Unfriend** once the person ticks who, one at a time, slowly, in a tab
    they can see. Built (the first of three parts).
18. **Openers on group posts:** the panel marks good posts as the person scrolls their groups, and **Find posts**
    scrolls the group feeds itself, slowly, stopping on any warning. Built (the second of three parts).
19. **Posts asking for help** are found by the playbook's signs, with the AI checking each one. Built.
20. **A good post goes on Today's list** with two AI comment drafts. The person posts the comment; the extension
    notes it. Built.
21. **Before drafting, the extension looks the person up:** it opens their profile and business page itself, quietly
    in a tab. Built.
22. **Phone alerts:** a push when the extension spots a reply, and a morning push at a time that's a setting (8am to
    start). Built (the third of three parts).
23. **Which openers work:** each playbook has two or three AI opener styles and the person's own openers. Drafts
    take turns with them, and a results card shows the replies and demos for each. Built.
24. **The demo link is built now,** so a booking through it counts by itself. The "Demo booked" mark stays too.
    Built.
25. **On a Facebook warning,** the daily limits are halved for 7 days, a red note shows in the panel and on the Today
    tab, friend requests stay off Today for 2 days, and the extension stops for the day. Built.

They come in three parts: cancelling and unfriending with the warnings (17 and 25); then openers on group posts, help
posts and looking people up (18 to 21); then phone alerts, which openers work, and the demo link (22 to 24).

The owner asked on 9 Oct 2026 for the extension to do more on its own, since it stays a build loaded by hand rather
than a store extension, and for more features, and answered the questions the same day. These are settled too:

26. **Sending is a setting, per person** (this replaces decision 1's choices): off, the person does everything (the
    default); (a) friend requests, likes and comments on their own, each message one tap; (b) everything on its own;
    (c) **Approve all** each morning. Choosing (b) starts training wheels. Built: off and the steps of (a) in part 1;
    messages in part 3 (`packages/core/src/addons/outreach/sends.ts`). With any choice but off, the extension looks
    each person up and drafts their first message, follow-up or reply with the AI, which waits as "I'd send this" in
    the panel and on Today: **Send** (changed or not), **Skip** (off the list for today), or **Approve all**. With
    (c) it drafts the day's messages first thing, before the other steps; with (a) after them. With (b), once the
    training wheels are off, a first message or follow-up goes as it is. What's OK'd, the extension sends in
    Messenger, in the chat when HandsFreeOS knows it, else from their profile's **Message**, at a person's pace, and
    notes it as its own; one it couldn't send says why and leaves the list for the day.
27. **Replies are a setting, per person:** (a) drafts wait for the person; (b) simple replies go on their own and the
    rest are handed over with a push; (c) every reply goes on its own. (b) and (c) start training wheels. Built: the
    AI says whether each reply it drafts is simple; with (b) a simple one goes as it is, with (c) every one does, and
    with (a) each waits. Whatever the choice, a reply to someone who needs the person waits, as the AI teammate
    hands over (decision 1): asking to stop, a refund, a complaint, a legal threat, cancelling, asking for them,
    sounding upset or an emergency; so does one to a chat HandsFreeOS hasn't seen. With (b) or (c), one that waits
    is handed over: their phone hears "Dana Reyes needs you", and why. Replies go only while Sending isn't off.
28. **When:** on its own in the person's working hours (9 to 5 to start), at random times, plus a **Start my day**
    button. Built.
29. **Tidying on its own is a setting:** off, cancelling old requests on their own, or cancelling and unfriending on
    their own. Part 5.
30. **Friend requests from people who fit a playbook are confirmed on their own;** the rest wait. Built: those who
    fit well.
31. **It asks to join good groups, up to 3 a day,** and the AI answers the join questions from the playbook. Part 5.
32. **Find posts, Read my chats, saving group members and checking friend requests run once a day on their own.**
    Built: first thing in the working day (or after Start my day), before the list, while the extension works on its
    own and **Once a day** is ticked (on to start).
33. **A like on one of their recent posts a day or two before the friend request.** Built: the request waits 20
    hours after the like; a like over 14 days old doesn't count; no post to like, no wait.
34. **All the features:** results by group, team sharing, an after-demo workflow, birthday and new-job notes, more
    templates, LinkedIn then Instagram, and a weekly report. Parts 2, 6 and 7. Built (part 2): **results by group**,
    everyone reached counted under the group they were found in, with who wrote back (in a saved chat, a chat read,
    or a reply the extension saw) and who booked a demo, on the Activity tab and, ever, on the Groups tab, where the
    groups that bring demos, then replies, come first; the extension gives them 3 of the 5 groups it works a run and
    tries others with the rest, and Today puts people from them ahead of others who fit as well. The **weekly
    report**: on Monday at the morning push's hour (8 when that's off), each person who used the extension that week
    gets an email of their friend requests, chats started, replies and demos, their best group and their best
    opener; an owner or admin with a team gets the team's too. It's on to start: Add-ons → Social Outreach turns it
    off, and Settings → Account turns off all add-on emails (`packages/core/src/addons/outreach/results.ts`,
    `apps/worker/src/addons/outreach/weekly.ts`).
35. **Automation and features are built side by side,** one PR at a time.
36. **Social Outreach gets an onboarding** like the main app's. Part 4.

**Training wheels** (proposed with the plan; the owner can change it): when someone picks a fully automatic choice
(26b, 27b or 27c), for the first 7 days and until they've OK'd 25 messages, everything it wants to send comes to them
first as "I'd send this", and their daily limits are half. More than 1 edit in 3 of the last 10 keeps it on longer;
owners and admins can end it early; a Facebook warning puts it back on for 7 days. Built (part 3, for 26b): choosing
it starts them once (`automation.wheels_from`); each message OK'd counts toward the 25, and whether it was changed
first toward the last 10 (`wheels_ok`, `wheels_edits`); earned, they're off for good (`wheels_done_at`). Owners and
admins see who's on them under Today and can **End now**. They matter only while Sending is (b), or Replies (b) or
(c) with Sending on; part 3b added replies.

The order: (1) the runner; (2) results by group and the weekly report; (3) messages and replies on their own; (4)
onboarding; (5) tidying on its own and joining groups; (6) team sharing, after-demo workflow, birthday notes,
templates; (7) LinkedIn, then Instagram.

From the plan, not contested: it reads only pages the person opens; group admins and moderators are never approached;
"Not interested" ends outreach for good; drafts mention only what's really on someone's profile or posts; and the
starting daily limits per Facebook account are 20 friend requests, 15 first messages, 20 follow-ups, 15 comments, 40
likes and 1 post, half that for new or quiet accounts.

## Rules worth knowing before changing anything

- **Nothing is saved until the person presses a button,** except the four steps the extension notes (decision 8),
  and what its panel's switches send as the person goes, each on by default and turned off there: the chats they open
  in Messenger (**Read chats I open**), and the posts worth a look in a group's feed (**Look for posts as I scroll**).
  While noting is on, it also tells HandsFreeOS who wrote last in the chats on the page (decision 22). Reading any
  other page only looks things up.
- **Noting a step adds nobody to Contacts.** Someone reached is kept as a profile with no customer, and the group
  they were first found in, until the person saves them; saving keeps their steps. A friend request marks the profile
  "request sent".
- **A step counts once.** The same post liked again, or another friend request to them within a day, comes back
  `repeated` and isn't counted again; comments and messages each count. A step that waited in the extension keeps
  the moment it was taken (`offline: 'anytime'`), and the extension sends it again with the same command id.
- **A message's place is worked out as it's noted** (`messageStep`): the first to someone starts a chat, the first on
  a later day follows up, and the rest of a day's, and answers, are neither. The daily limits count only those.
- **The limits count, they don't stop.** The person takes these steps on Facebook themselves, so the panel and the
  extension warn past a limit (`pastLimitWords`) and nothing is refused. Cancelling and unfriending are the
  extension's own presses, so it stops at their limits (`TIDY_LIMITS`), and HandsFreeOS still counts any it's told of.
- **The extension presses only where the person sent it:** Facebook's download pages (decision 16) and, for
  cancelling and unfriending, the profile of someone they ticked (`tidyPage`). It checks the profile is the one
  ticked and where things stand before pressing, and that it says Add friend after; anything else is handed to the
  person. It presses a button under their name, never a link or tab, and Unfriend and Confirm only in Facebook's box
  on top.
- **On its own, it does only what's on the person's list for today, and only the kinds they let it**
  (`autoKinds`, the list's `auto`). The list holds no more than today's limits have room for, so the runner never
  passes them; it checks each profile is the one listed and where things stand before pressing and after, passes
  over anything that isn't as expected for the rest of the day rather than retrying, and notes each step marked as
  its own (`auto`). It stops for the day on any warning, its own or the panel's
  (`src/hfos/warned.ts`), and keeps its state in the extension's storage, so a restart carries on where it was.
- **A message goes only through `sends`** (`outreach.send.*`). The extension drafts it and queues it; it waits
  (`waiting`) unless Sending is (b), the training wheels are off and it isn't a reply (`goesAsItIs`). A reply follows
  Replies instead, and never goes by itself to someone who needs the person (`replyNeedsYou`, from their last message
  in the person's own chat, which the server reads itself; the AI's "simple" only counts with (b)). With (b) or (c),
  one that waits is handed over with a push (`handedOver`, the worker's `handOver`). Only an OK'd one
  (`approved`) is sent, and only the extension says it went (`outreach.send.done`); the message itself is noted as any
  step is. One open send a person, profile and kind at a time: drafting again returns it. A send skipped or not sent
  takes them off the list for the rest of the day. A first message sent this way notes its opener, as copying does.
- **Training wheels halve the limits as a warning does** (`slowerFor`), on Today, the activity panel and tidying,
  and they're counted only on OKs while they're on (`countWheels`).
- **A post is checked once, and kept for the person who saw it** (`posts`, by `user_id` and link). Seen again, it's
  only updated; the AI's answer is taken once (`outreach.post.check` changes only a `waiting` post), and an answer it
  can't use marks it `failed`. Today offers it for a week from when it was last seen (`POST_FRESH_DAYS`), never when
  its writer runs a group, is on Don't pitch or is in Contacts, and never twice: a comment noted on its link, or
  **Not for me**, ends it. The look-up's lines go to the AI for that draft only and are never kept.
- **A warning is a warning for a week** (`warningOf`, `dailyLimitsNow`): limits halve (never below 1) for 7 days from
  the latest one, friend requests leave the list for 2, and the same words twice in a day come back `repeated`. The
  extension keeps the day's warnings itself too, so it stops even when HandsFreeOS can't be reached.
- **A reply answers a message the extension noted** (`outreach.replies.note`). A chat whose last message is theirs
  counts once for each message of the person's it answers (`replies`, by the moment of that message), so seeing the
  chat again is no news; a chat with nothing of the person's noted, or seen within 30 seconds of their message being
  noted (Messenger's list catching up), isn't one. The extension sends only who (the chat's number or their profile),
  only chats from the last two days, each at most every 3 minutes, and nothing while noting is off. The push goes to
  that person alone, unless they had the tab in front of them.
- **The morning push is one job per business** (`outreach.morning`), armed when the add-on comes on, when the hour
  changes, and whenever the extension sends a reply or something Today reads, so a business that had the add-on
  before it gets one too. It works out each person's list as they would see it (`outreach.today` on their behalf),
  pushes nobody with nothing on it, and one run more than three hours late waits for the next morning.
- **An opener is what a first message was drafted with, as copied.** Copying a draft notes it, and once a first
  message to them is noted (from 5 minutes before the copy) it stays the one it was. It's known by its kind and its
  words, so changing a style's words makes a new one; one taken out of a playbook keeps its numbers on the card. A
  reply counts when it came after the copy (seen by the extension, or in a chat read from the file or live).
- **A demo counts once per booking, and a mark once per person reached** (`demos`). The `ref` holds only the two
  ids, packed short (`demoRef`); a made-up one, or one from someone who no longer has `outreach.use` here, counts
  nothing. A mark taken back is kept and no longer counted (`undone_at`), like everything else here.
- **Each person's steps are their own** (`user_id`). Owners and admins can see everyone's; anyone else asking is
  refused (`outreach_activity_everyone`), and the page shows them their own.
- **A profile is known by its number or its username,** whichever its links show. Saved one way and seen the other,
  the two can't be matched automatically: a save offers the customers with the same name first (`sameName` in
  `outreach.lookup`, with `hasProfile`), and **It’s them** saves with that `personId`. Two profiles on one customer
  are fine.
- **A new customer from Facebook** is added through core's `person.create`, run inside the save, with source
  "Facebook" and texting consent unknown, so campaigns leave them alone. Duplicates by name aren't refused there: the
  extension offers same-named customers before it adds anyone.
- **Each teammate's chats are their own.** A chat is kept per person who saved it (`owner_user_id`), by the number in
  its link, so two teammates writing to the same customer keep two chats on that customer.
- **A chat saves to** the customer its profile link is saved to (or adds one), or the one picked, or the one it was
  saved with before; with none of those it's refused (`outreach_chat_without_profile`). Group chats can't be saved yet.
- **A chat keeps its latest 100 messages** (`KEPT_MESSAGES`). A read joins what was saved where the two overlap most
  (`joinMessages`), so scrolling up and saving again adds the older ones. Each message keeps when it was first saved,
  and the extension writes "Today" and "Wed 11:02 AM" as the date before sending (`apps/extension/src/hfos/when.ts`).
- **Friends are each person's own; Don't pitch is the business's.** Where someone's own Facebook stands with a
  person (friends, request sent, asked to be friends, request deleted, not friends) is kept per user in `friends`,
  with when it started; so is Keep. The Don't pitch list is the business's and says who added each person and when.
  Only they, or someone with `outreach.manage`, take a person off (`outreach_dont_pitch_not_yours`). Customers tagged
  **Friend or family** in Contacts count as on it.
- **Don't pitch refuses the step, not the person.** A step the extension notes to someone on the list is refused
  (`outreach_dont_pitch`) with what to change, so it's never counted as outreach. Saving their profile or a chat
  still works.
- **Newer news wins.** A list saved or an answer noted never undoes what was seen later (`seen_at`), and a deleted
  request stays deleted when a later list just doesn't show them. Confirm makes them a friend; Delete keeps the
  request as deleted. Saving a list adds nobody to Contacts.
- **Facebook's download file stays in the browser.** The web, or the extension's panel, reads the zips there
  (`readDownload`, in `download-read.ts`, which has no zod so the panel stays small), a file at a time,
  so a download of many gigabytes is fine. It sends names and moments, and only the latest 20 messages of each
  one-to-one chat (`RECENT_MESSAGES`, each cut to `MESSAGE_MOST`; a photo or a link is said as "(a photo)"), never a
  group chat's words, in parts the API takes (`downloadParts`, `DOWNLOAD_PART_BYTES`), and the last part (`last`)
  finishes the bringing-in. Only the person who started one sends its other parts.
- **The AI reads a chat once per newer message** (`chat-read.ts`, the worker's `chats.ts`). A chat comes in
  `waiting` when they wrote something in its latest messages, `skipped` when only the person did, and `none` with no
  words. The same file again reads nothing twice; newer messages put it back to `waiting`. The file's last part queues
  one read per business (`outreach.read_chats`), 20 chats a batch, the latest first. Tags are only the playbooks' own,
  copied as the business writes them (`checkedChatRead`), and a tag missing from Contacts is made. At the day's AI
  limit the rest wait six hours; an answer it can't use marks that chat `failed`. A read of older messages than the
  chat has by then is dropped (`lastAt`).
- **Who goes in Contacts is the setting, read at the moment of the read** (`contactsFromChats`, `goesInContacts`).
  Someone already in Contacts (through their profile) is tagged whatever it says. Someone on Don't pitch is added
  only when the setting is everyone. A chat's summary and tags are the person's own; the customer it adds is the
  business's, like any other.
- **The file has no links, so it's kept by name** (`file_people`, `file_chats`, each person's own). With the last
  part, a name is matched to the one profile saved here by it (`nameKey`: lower case, spaces closed up), or among
  several, the one the person's own Facebook has a say on. A name twice in one of the file's lists is two people,
  and neither is matched. A newer file updates the same rows and matches again.
- **What the file says goes in place as of when Facebook made it** (`madeAt`, the zip's own date, never before the
  latest moment in it). Where things stood then (friends, a request either way) beats what happened before (a friend
  removed, a request deleted). Newer news wins: something the extension saw after the file was made stays, and only
  moves its start earlier when it's the same; a deleted request stays deleted; Keep stays. Nobody is added to
  Contacts, and the same file again changes nothing.
- **Fit reads only what can be checked** (`fit.ts`): the words a playbook puts in quotes in its signs and who to skip,
  the places in its area, mutual friends, and the group someone was found in. A skip word makes them a skip whatever
  else fits, and with no playbook only mutual friends and groups count. The extension sorts the requests on a page
  with it; the Friends tab sorts the ones saved.
- **Tag names compare in lower case.** An app session's search path leaves out `extensions`, so `citext`'s `=` is
  plain text there: the Friend or family check uses `lower(name::text)`.
- **Limits live once,** in `limits.ts`. The commands hold sends to them; the extension cuts what it read to fit, and
  keeps a chat's save under the API's 256 KB.
- **Nobody deletes a saved profile, chat or playbook.** The tables' rules give no one delete; a playbook is archived
  instead, and two in use never share a name (`outreach_playbook_name_taken`). Their rows go when the business deletes
  the add-on's data, like any add-on's.
- **A playbook is checked by one schema,** `PlaybookDetails` (`playbooks.ts`): the builder checks each step with it
  as it's written, and the save holds to it. How long each part may be is `PLAYBOOK_LIMITS`, which the builder's boxes
  use too.
- **An answer only leads down.** It goes to a question further down or ends the questions, never back up, so a
  conversation can't go round in circles. It adds only one of the playbook's own tags (whatever the capitals), and the
  builder takes a tag off the answers when it comes off the playbook.
- **Questions are named q1, q2… in the order they're asked.** Answers point at those names, and a save renames them
  in order (`renumberQuestions`), with every answer still leading where it did.
- **Data version 2:** a playbook's questions became questions with answers, and it got a pace. Reading one saved
  before then gives it in today's shape (`upgradePlaybookDetails`, in `outreach.playbook.list`), because a business
  with the add-on on never runs a data step; the worker's step 2 tidies what a reinstall brings back.
- **Timeline lines** come from `addonTimelineLine`: "added them from Facebook", "linked their Facebook profile",
  "saved 3 Facebook messages".
- **No real people in the repo.** Tests and fixtures use made-up names; the extension's readers are tuned from
  outlines, never saved pages (apps/extension/README.md).

## Not yet

The extension's steps on Facebook's download pages follow the owner's own screens of October 2026, mapped button by
button, except the Download button beside a finished file, which no file was ready to show yet. Where it hands a
step to the person, the panel's page outline of that screen, which keeps those steps' words, tunes it.

Finding posts and the look-up read group feeds and profiles the way the readers do now, not yet tried on the owner's
account. A profile's business page is only one its lines link to by name ("Owner at …"); a business named without a
link isn't followed.

Cancelling and unfriending follow Facebook's usual buttons (Friends, Unfriend, Confirm; Cancel request), not yet
tried on the owner's account; a step it can't find is handed to the person. Unfriending on its own within a daily
limit (decision 10's other choice) comes with tidying on its own (decision 29).

The runner's presses (Add friend, Respond and Confirm, Like on the latest post, the comment box and its button) follow
Facebook's usual 2026 pages, not yet tried on the owner's account; one it can't find is passed over for the day, and
its line in the panel says so. Chrome must be open for it to work; a window it opens unfocused may still show in front
on some computers.

Spotting replies reads chats the way the chat readers do now, not yet tried on the owner's account; a chat's line in
Messenger's list counts when it doesn't start "You", so a group chat's line counts too, though only a chat with
someone the person messaged can be a reply. The demo link counts bookings on the business's own booking pages; a link
to anywhere else carries the `ref` along, and only **Demo booked** counts those.

Next: the AI suggesting a conversation from the rest of the playbook
comes with AI drafting. A profile saved after the file came in is matched to it when a newer file comes in. Then
leads. Then the rest of decisions 26 to 36, in the order above.
