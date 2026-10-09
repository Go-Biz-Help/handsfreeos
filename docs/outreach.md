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
Facebook's warnings, comments on group posts and looking people up before drafting:

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
  replies owed; and comments on good group posts (below). A message has **Draft a message**: three drafts from the AI in the playbook's tone, from what's known
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
- **Playbooks** (`/a/outreach?view=playbooks`): what the business is looking for on social media, how it sounds and
  which of its tags to use. Each has a goal, an offer and link, who it's for, signs to look for and who to skip, where
  to look, the steps it takes and how fast, the tone, sample messages, the conversation, words to avoid, a disclaimer
  and the tags. The first template is **CRM demos**; a blank one is always there.
- **The playbook builder** (`/a/outreach/playbooks/new`, `/a/outreach/playbooks/<id>`): a playbook asked a step at a
  time, ten steps from the goal to a summary, each with ideas to tap and room for the business's own words. The offer
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

| Piece                                                    | Where                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Manifest, operations, tables, shapes                     | `packages/core/src/addons/outreach/`                                                          |
| What a save takes: lengths, counts, id shapes (no zod)   | `packages/core/src/addons/outreach/limits.ts`                                                 |
| Worker half: the AI reading the chats, and its drafts    | `apps/worker/src/addons/outreach/`                                                            |
| What the extension notes, and the panel's shapes         | `packages/core/src/addons/outreach/activity.ts`, `ops/activity.ts`                            |
| The page and its tabs, and the Social card               | `apps/web/src/addons/outreach/`, `/a/outreach`                                                |
| The playbook builder                                     | `apps/web/src/addons/outreach/playbook-builder.tsx`, `/a/outreach/playbooks/…`                |
| Tables and permissions                                   | `supabase/migrations/20261024000100_addon_outreach.sql`, schema `addon_outreach`              |
| Groups and steps noted                                   | `supabase/migrations/20261026000300_outreach_activity.sql`                                    |
| Friends, Keep and Don't pitch, and how someone fits      | `friends.ts`, `fit.ts` (no zod) and `ops/friends.ts` in the add-on's folder                   |
| Friends and the Don't pitch list                         | `supabase/migrations/20261026000400_outreach_friends.sql`                                     |
| Facebook's download file: reading it, and bringing it in | `download-read.ts` (reads the zips, no zod), `download.ts` and `ops/download.ts`              |
| The extension getting the file                           | `apps/extension/src/facebook/fetch.ts`, `src/panel/fbfile.ts`                                 |
| What the file said, by name                              | `supabase/migrations/20261027000300_outreach_facebook_download.sql`                           |
| Chats read live in Messenger                             | `chat-collect.ts`, `supabase/migrations/20261027000600_outreach_chat_reads.sql`               |
| Groups, their people, and the list for today             | `groups.ts`, `today.ts`, `supabase/migrations/20261027000700_outreach_groups.sql`             |
| Tidying up friends, and Facebook's warnings              | `tidy.ts`, `ops/tidy.ts`, `supabase/migrations/20261027000900_outreach_tidy_and_warnings.sql` |
| The buttons pressed to cancel and unfriend               | `apps/extension/src/facebook/tidy.ts`, `src/panel/tidy.ts`, `src/panel/warnings.ts`           |
| Posts worth a comment, and the AI's check of them        | `posts.ts`, `ops/posts.ts`, `supabase/migrations/20261027001000_outreach_group_posts.sql`     |
| Finding posts, and looking people up before drafting     | `apps/extension/src/panel/posts.ts`, `src/panel/lookup.ts`, `src/facebook/browse.ts`          |
| The extension                                            | `apps/extension`                                                                              |

Operations, all through the kernel:

| Operation                                             | Who               | What                                                                                                 |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `outreach.playbook.list`                              | `outreach.use`    | The playbooks, those in use first                                                                    |
| `outreach.playbook.save`, `outreach.playbook.archive` | `outreach.manage` | Write one; put one away or bring it back                                                             |
| `outreach.profile.save`                               | `outreach.use`    | A profile as the extension read it: finds the customer it's saved to, or the one picked, or adds one |
| `outreach.chat.save`                                  | `outreach.use`    | A chat as read: the new messages join what was saved                                                 |
| `outreach.lookup`                                     | `outreach.use`    | Which profiles and chats on a page are saved, who in Contacts has a name, and Keep and Don't pitch   |
| `outreach.person`                                     | `outreach.use`    | A customer's profiles and chats, for the Social card                                                 |
| `outreach.touch.save`                                 | `outreach.use`    | A step the person took on Facebook, as the extension saw it: to whom, and the group they came from   |
| `outreach.activity`                                   | `outreach.use`    | The panel's numbers over a stretch, by group and person, and the day; everyone's for owners, admins  |
| `outreach.friend.note`                                | `outreach.use`    | The person confirmed or deleted a friend request on Facebook                                         |
| `outreach.friends.save`                               | `outreach.use`    | The person's friends list or requests, as far as the page loaded, up to 500 at a time                |
| `outreach.friend.set`                                 | `outreach.use`    | Keep (the person's own) or Don't pitch (the business's) for someone                                  |
| `outreach.friends`                                    | `outreach.use`    | The Friends tab: the counts, and a page of one list searched by name, the requests by fit            |
| `outreach.download.save`                              | `outreach.use`    | A part of Facebook's download file as the browser read it; the last matches names and puts it in     |
| `outreach.chats.collect`                              | `outreach.use`    | Up to 10 chats read live in Messenger: their latest messages join what's kept, for the AI to read    |
| `outreach.groups.save`                                | `outreach.use`    | The groups a page lists, with what it said about each, up to 100 at a time                           |
| `outreach.group.save`                                 | `outreach.use`    | A group and up to 500 people from its People tab; its admins page marks its admins as read           |
| `outreach.groups`                                     | `outreach.use`    | The Groups tab: the counts, and a page of groups by fit, searched by name                            |
| `outreach.today`                                      | `outreach.use`    | The person's list for today, and today's steps against the daily limits                              |
| `outreach.friends.tidy`                               | `outreach.use`    | Sent requests to cancel and friends to unfriend, with today's counts against their limits            |
| `outreach.friend.end`                                 | `outreach.use`    | The extension cancelled a request or unfriended someone for the person                               |
| `outreach.warning.note`                               | `outreach.use`    | Facebook warned the person: halves their limits for 7 days, friend requests off their list for 2     |
| `outreach.posts.save`                                 | `outreach.use`    | Up to 30 posts from a group's feed: keeps those worth a look for the AI, and says how each stands    |
| `outreach.post.check`                                 | the worker        | What the AI made of a kept post: good, not, or couldn't be read, with why                            |
| `outreach.post.skip`                                  | `outreach.use`    | The person put a post aside: off their list for good                                                 |

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
    start).
23. **Which openers work:** each playbook has two or three AI opener styles and the person's own openers. Drafts
    take turns with them, and a results card shows the replies and demos for each.
24. **The demo link is built now,** so a booking through it counts by itself.
25. **On a Facebook warning,** the daily limits are halved for 7 days, a red note shows in the panel and on the Today
    tab, friend requests stay off Today for 2 days, and the extension stops for the day. Built.

They come in three parts: cancelling and unfriending with the warnings (17 and 25); then openers on group posts, help
posts and looking people up (18 to 21); then phone alerts, which openers work, and the demo link (22 to 24).

From the plan, not contested: it reads only pages the person opens; group admins and moderators are never approached;
"Not interested" ends outreach for good; drafts mention only what's really on someone's profile or posts; and the
starting daily limits per Facebook account are 20 friend requests, 15 first messages, 20 follow-ups, 15 comments, 40
likes and 1 post, half that for new or quiet accounts.

## Rules worth knowing before changing anything

- **Nothing is saved until the person presses a button,** except the four steps the extension notes (decision 8),
  and what its panel's switches send as the person goes, each on by default and turned off there: the chats they open
  in Messenger (**Read chats I open**), and the posts worth a look in a group's feed (**Look for posts as I scroll**).
  Reading any other page only looks things up.
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
- **A post is checked once, and kept for the person who saw it** (`posts`, by `user_id` and link). Seen again, it's
  only updated; the AI's answer is taken once (`outreach.post.check` changes only a `waiting` post), and an answer it
  can't use marks it `failed`. Today offers it for a week from when it was last seen (`POST_FRESH_DAYS`), never when
  its writer runs a group, is on Don't pitch or is in Contacts, and never twice: a comment noted on its link, or
  **Not for me**, ends it. The look-up's lines go to the AI for that draft only and are never kept.
- **A warning is a warning for a week** (`warningOf`, `dailyLimitsNow`): limits halve (never below 1) for 7 days from
  the latest one, friend requests leave the list for 2, and the same words twice in a day come back `repeated`. The
  extension keeps the day's warnings itself too, so it stops even when HandsFreeOS can't be reached.
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
limit (decision 10's other choice) waits for the build loaded by hand's hands-off mode.

Next, in the owner's order (decisions 18 to 24): openers on group posts with help posts and looking people up, then
phone alerts, which openers work, and the demo link. The AI suggesting a conversation from the rest of the playbook
comes with AI drafting. A profile saved after the file came in is matched to it when a newer file comes in. Then
leads and results by group. The settings for decisions 1 to 3 arrive with the steps that need them.
