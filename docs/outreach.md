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
demo link, the extension working on its own (the first part), its settings in HandsFreeOS, its live status with
Start my day and Stop for today in the app, Waiting for you, the bare-bones extension, with what needs the browser
asked of it from the app, the whole add-on on the phone, the setup, Social Outreach's onboarding, in HandsFreeOS, the
good fits among friends and chats (growth part 1), stages with the moment to pitch (growth part 2), groups,
theirs first, then new ones (growth part 3), posts asking for what the business offers, fast (growth part 4),
helpful posts with the people who engage (growth part 5), the owner's notes after trying it (decisions 51 to 58:
how the AI writes, the chat so far beside a message, Start fresh and the setup's welcome), the redesign
(decision 59: four tabs and the gear on the web and the phone, and the panel in HandsFreeOS's look), and the main
offer's plan (decisions 62 to 70: the playbook's niche, Get ready, the profile's check, the conversation: warm up,
ask straight out, the video, the link, follow-ups until they answer; the short video's script; and the daily numbers,
with the day's report and the week's review).

The parts below name the tabs they were built on. Since decision 59 those live here: **Today** has the Live tab's
status, Start my day and Stop for today in a strip (the full day under its **Details**, `?view=live`), Waiting for
you as **Needs you**, and the list; **People** has the Pipeline (a board for everyone in play), Friends and Chats;
**Groups** is as it was; **Results** is the Activity tab; and the gear's **Settings** has the settings, Playbooks, the
person's computers and Start fresh. The old addresses (`?view=waiting`, `?view=activity`) open what they became.

- **The activity panel** (`/a/outreach`, the page's first tab): what the extension noted over today, the last 7 days
  or the last 30. People reached, friend requests, likes, comments, chats started, follow-ups and who wrote back; by
  the group each person was found in, and person by person with how far each has come; and the person's own day
  against the daily limits. Owners and admins can see the whole team's (`?who=everyone`).
- **Posts liked and commented on** (the Results tab, `outreach.activity.posts`, the web's `touched-posts.tsx`, the
  phone's `posted.tsx`, their words `TOUCHED_POSTS_WORDS`): each post liked or commented on in the stretch, the latest first, All, Likes or Comments, 50 at a time: whose post, a
  link to it, the group, by hand or by the extension, and who on the team for everyone's. For what the extension did
  on its own it keeps what the post said, the AI's comment it posted, and why the AI picked that post to like
  (`touches.post_text`, `comment_text`, `why`); a comment on a post found in a group shows what that post said. What
  the person wrote themselves is still never kept: their own comments show without the words.
- **Which post gets the like** (decision 33, `like-pick.ts`, the worker's `likes.ts`, the extension's
  `readTheirPosts` and `likeTheirPost`): the extension reads up to 6 of the latest posts on their profile that are
  theirs, what each says and what Facebook says its pictures show ("May be an image of 2 people and dog"), and the AI
  picks one (`outreach.like.pick`): to do with the business first (its offer, line of work or area), else about them
  (family, a pet, a hobby, a trip, a win), else a plain friendly one; never one about a death, an illness, an
  accident, money trouble, politics or religion, or one that's angry or sad, which a list of words also rules out
  whatever the AI says (`neverLike`). None fit: no like, and the friend request goes without, as with no post. One
  they liked already counts without asking. Without the AI (its limit, not set up, busy, or out of reach) the words
  alone pick the first safe post. The feed says why ("Liked a post of Dana's (a photo of their new boat)").
- **Noting what the person does on Facebook**: signed in, the extension notes each friend request, like, comment and
  message the person sends there themselves, with who it was to and the group they found them in, never what they
  wrote. The Live and Activity tabs show the day so far (apps/extension/README.md, "What it notes").
- **Friends** (`/a/outreach?view=friends`): the person's friends against Facebook's 5,000, the friend requests
  they've got in order of how each fits the playbooks in use (with why), the requests they sent that nobody has
  answered, the friends they keep (never suggested for unfriending), and the business's Don't pitch list, each 100 to
  a page and searched by name as it's typed. **Check my friend requests** and **Save my friends list**, above the
  lists, ask the person's computer to save the requests waiting and the friends list from Facebook's pages (below,
  **Asking the extension**); the requests they sent before come in with the download file. The extension notes
  Confirm and Delete as the person presses them; Keep and Don't pitch are set on the tab, and Don't pitch on Today too.
- **Good fits among friends and chats** (decision 46, `checks.ts`, `ops/checks.ts`, the worker's `checks.ts`, the
  extension's `src/jobs/checks.ts`): the Friends tab's **Check my friends** (an ask, `checks`), and the once-a-day
  jobs after Read my chats, have the person's computer read the next of their friends and the people they've chatted
  with, about 40 a day (`CHECKS_PER_DAY`, halved for a week after a warning), every 15 to 30 seconds, in a window of
  its own: HandsFreeOS says who's next (`outreach.checks.next`: friends whose chat the AI read as a likely prospect,
  then friends with any chat, others they've chatted with, friends found in a group, then the rest, the most mutual
  friends first; never anyone on Don't pitch or tagged Friend or family), the extension opens each profile, checks
  it's them, reads what it says about them and their latest posts, follows the link to the business they own or work
  at and reads that too, and sends those lines (`outreach.check.look`), or that Facebook showed someone else. The AI
  reads them with the person's own chat with them (the worker's `outreach.check_people`) and says whether they're a
  good fit for a playbook, might fit, or not, why in up to three lines, who they are in one, and a natural first step
  (`outreach.check.save`); the lines are let go once it has. The Friends tab's **Good fits** list has the good fits
  first, then those who might fit, with the AI's why (its first line, the rest under **More**) and first step; a good fit shows the same why line on the other lists, and its card says how far it has come ("312 of
  1,840 checked · 28 good fits"). Each is read again after 90 days, and one Facebook didn't show after a week. The
  card's **Check everyone again** (`outreach.checks.again`) puts everyone checked back on the list at once, for when
  the AI reads pages better than it did: it sets `again` on each of the person's checks, and the next read clears it.
  They go at the day's pace, and what the AI said stays on show until it answers again. A page linked from their
  profile counts as their business only when the line naming it says they own or founded it; otherwise the AI is
  told it's where they work. Nobody goes in Contacts.
- **Partners** (decision 81, `partners.ts`, `ops/partners.ts`, the worker's `partners.ts`): a playbook whose goal is
  **Find partners** is a partner playbook, and every step for customers leaves it out (`playbooksInUse`,
  `FOR_CUSTOMERS`); its `partnerKinds` say which kinds of partner it looks for (data version 6). HandsFreeOS says who
  the person's computer reads next for the AI's partner check (`outreach.partners.next`: admins of groups of at least
  200 members the AI didn't call not the business's people, the biggest first; then people with at least 1,000
  followers; then businesses, by their intro's words or on Alignable; never anyone on Don't pitch or Never contact,
  anyone found already, anyone sent a customer message in the last 30 days, nor anyone marked Not interested), at most
  half the network's profiles read a day, which the customer checks share. The extension reads each profile and how
  many follow them (`outreach.partner.look`); the AI (the worker's `outreach.check_partners`) says good, maybe or not,
  what kind of partner, who their audience is and how big, why and a first warm-up (`outreach.partner.save`). A good
  or maybe goes on the person's **Partners** list (`outreach.partners`) at Found, and `profiles.partner_found_at` keeps
  them and their twins out of every step for customers from then (`pitchable`); a friend request from them is still
  confirmed. The person marks them (`outreach.partner.mark`): Interested, Call booked, Make partner, Not now, back on
  the list, or not a partner after all, which takes them off the list so they may be pitched again. Each person's own,
  like their checks. Today reaches them in a part of its own (`partners`, `partnerToday`): a like first
  (`partner_warm_up`; one moves them to Warming up), the ask a day later (`partner_ask`, at most 3 a day, within the
  first messages the customers' steps left; again 90 days after Not now), up to 2 follow-ups a week apart
  (`partner_follow_up`), the details with the person's partner link after a yes (`partner_details`), and replies owed
  (`partner_reply`). Each is a message of its own kind, drafted by the worker about partnering only
  (`partnerDraftPrompt`), and always waits for an OK of its own, never Approve all; once it goes it moves them along
  (`notePartnerSent`). The AI reads their answer while drafting a reply (`outreach.partner.answer`): a yes makes them
  Interested and drafts the details, not now or no sets them aside. A call booked through the partner link (its ref
  starts `sp-`) moves them to Call booked (`outreach.partner.call`), never a demo. The extension (0.64.0) reads up to
  15 candidates a day on Facebook and LinkedIn after checking friends (**Find partners**, its `src/jobs/partners.ts`),
  with how many follow them off the top of their profile, and does Today's partner steps after the customers' of each
  sort (`workLeft`). On the web and the phone, the Partners list is one of People's lists (`?view=partners`, `?show=`
  a stage, `?net=` a network): a chip for each stage with how many are at it, and each row's kind, network,
  audience, when they reached their stage and why they fit, with the marks its stage offers (`partnerMarksFor`).
  Today has a Partners part of its own below the list, each message with an OK of its own; copying a partner's draft
  moves them along as one the extension sent does (`outreach.conversation.note`). Results has the person's own asks,
  yeses, calls and partners made (`ActivityOutput.partners`, left out of the team's), and the morning push counts a
  partner's steps, but not a like the extension gives on its own (`doneOnItsOwn`).
- **Research one person** (decision 46a, `researchShown` and `RESEARCH_WORDS` in `checks.ts`, the ask kind `research`
  in `asks.ts`, the web's `research.tsx`, the extension's `research` in `src/jobs/checks.ts`): a **Research** button
  on each row of the Friends tab (friends, good fits, requests received and sent, kept) and the People tab's pipeline
  (list and board) asks the person's computer (`outreach.ask.make`, `{ kind: 'research', profileId }`, target
  `profile:<id>`) to check that one person next, the same way as above. It counts toward the same day's checks
  (`CHECKS_PER_DAY`): with those used up, the ask ends at once as done, with `result.queued` and the line "That's
  today's 40 checks. Dana goes first when checking carries on tomorrow.", and the row says **First in line
  tomorrow**. `outreach.checks.next` puts anyone with a Research ask since they were last read first (reason
  `asked`), whoever they are to the person (a request, someone found in a group), and lists only them when the
  extension passes `profileId`. The row shows **Research**, then **Researching…** while the ask is open or the AI is
  reading what was sent, then the AI's answer (good fit, might fit or not, with the why). No button for someone on
  Don't pitch or tagged Friend or family (refused with `outreach_research_not_pitched`), nor for someone checked
  already (`outreach_research_done`). Extension 0.27.0 and later (`ASK_KIND_SINCE`).
- **Stages, and the moment to pitch** (decision 47, `stages.ts`, `ops/stages.ts`, the web's `pipeline-view.tsx`, the
  phone's `pipeline.tsx`): the **Pipeline** tab, after Today, on the web and the phone, has everyone the person
  reached (a step noted, a chat with words, a good fit or might fit from the checks, a demo, or a mark) by where they
  stand, worked out each time (`outreach.stages`): booked, not a fit, pitched, ready to pitch, talking (they wrote),
  friends, warming up (a like, a comment or a friend request), or found; **All in play** lists the ready first, then
  talking, pitched, friends, warming up, found and booked, each with why, the AI's next step and the latest either
  way. The AI's read of a chat now also says whether it's time to offer (`pitch`: ready, not yet, or not interested,
  with why in a line), from the playbook's offer and its conversation's questions. Ready, they go on Today as
  **Pitch**: drafts that answer where the chat left off and offer it with the person's demo link, which the worker
  adds when the AI left it out; copying one, or a pitch the extension sends, moves them on to pitched. A "no" marks
  them not a fit (the AI's mark, undone by its next read that says otherwise), and "Not interested ends outreach for
  good" (the plan): nothing on Today reaches them again but a reply they're owed. The person marks someone **Ready to
  pitch**, **Pitched**, **Not a fit** or **Back in play** on the Pipeline (`outreach.stage.mark`); their own mark is
  never undone by the AI.
- **Facebook's download file** (the Friends tab's **Bring in your Facebook file**): the person picks the zips
  Facebook gives them, the "Download your information" file and the chat backup that holds the newer chats, and their
  browser reads them. Names and dates are sent: their friends and since when, the requests they sent and got,
  the friends they removed, the requests they deleted, their followers and who they follow, and when they last
  messaged each person; and each one-to-one chat's latest 20 messages, for the AI to read. The Friends tab then says "Friends since Mar 2019" and the latest message either way, and a
  sent request shows the day it really went. The extension can get the file too (decision 16): the Friends tab's
  **Let the extension get your file** asks the person's computer, a step at a time, to ask Facebook for it (**Ask
  Facebook**), download it when it's ready (**Download my file**) and get the chat backup (**Get my chat backup**),
  pressing the buttons on Facebook's own download pages in a tab they can see, then to find the zips in Chrome's
  downloads and bring them in the same way (**Bring them in**, read in the extension's offscreen page, since its
  background can't open files).
- **Chats** (`/a/outreach?view=chats`, decision 3): each one-to-one chat in the file, read by the AI from its latest
  20 messages: a short summary, the playbooks' tags that fit, whether they look like a prospect, and a next step. The
  likely prospects first, then the tagged, every chat read, and the ones not read yet; a tag and a name narrow it,
  50 to a page. Who goes in Contacts is the business's setting (Social Outreach → Settings → General, For your team):
  anyone tagged or looking like a prospect (the default), everyone, or only likely prospects. They're added with their tags and a timeline
  line with the summary; someone already in Contacts gets the tags whatever it says.
- **Chats read live** (decision 3, without waiting for the file): the extension sends each one-to-one chat the person
  opens in Messenger in the tab in front of them, panel open or not, or, with **Read my chats** on the Chats tab, opens
  their chats one at a time at a steady pace, up to 150, and stops on any Facebook warning. Each chat's latest 20 messages join the file's, one chat per person
  (`chat-collect.ts`, `outreach.chats.collect`), and are read the same way. A chat read live keeps its Messenger
  thread, so the Chats tab can **Open in Messenger**.
- **Groups** (`/a/outreach?view=groups`, step 4): the groups the extension saved, each scored against the playbooks
  in use as **Work these**, **Maybe** or **Skip**, with why: a playbook's words to search for groups, its area or a
  quoted sign in the name, size, and whether the person is in it (`groups.ts`). The tab's buttons ask the person's
  computer: **Save my groups**, **Find groups** (a box of words to search for, starting with the first playbook in
  use's), **Save a group** (a group's link pasted), **Save members of my best groups**, **Find posts**, and each
  group's **Save its members**. Saving a group's members reads its admins and moderators first, to the end of the
  list, which marks the group's admins as read and keeps them as running it for good, then its members with the lines
  under their names. Nobody is added to Contacts.
- **Groups, theirs first, then new ones** (decision 48, `group-checks.ts`, `ops/group-checks.ts`, the worker's
  `groups.ts`, the extension's `src/jobs/groups-check.ts` and `src/jobs/join.ts`): the Groups tab's **Check my groups**
  (an ask, `group_checks`), and the once-a-day jobs after friend requests, have the person's computer read up to 8
  groups (4 a day on its own) that HandsFreeOS says are next (`outreach.groups.to_check`: the person's own groups
  first, then groups found that fit by name, never one its name skips; none checked in the last 60 days, or a week
  after one couldn't be read). For each it opens the group and reads its latest posts, then its About tab, what it
  says it's for and its rules from the admins, and sends them (`outreach.group.look`). The AI reads them with the
  playbooks in use (the worker's `outreach.check_groups`) and says whether the business's people are there and post,
  which playbook, why in up to three lines, and who's there in one (`outreach.group.check`); the posts are let go,
  the About lines and rules stay on the group for the helpful posts to come (decision 50). The group's fit then
  follows the AI (`checkedGroupFit` in `groups.ts`): its people are there makes it **Work these**, some of them at
  least **Maybe**, not its people **Skip**; Today's friend requests and comments put the groups the person is in
  first, and those the AI called good next. The Groups tab's card says how many people in the groups who fit a
  playbook haven't been reached yet, against a day of friend requests ("1,240 people left to reach: about 62 days of
  friend requests"), each group's row the same, and when it's under a week (`LOW_DAYS`), says so. **Find and join
  more groups** (an ask, `join`), **Ask to join** on a group, and the once-a-day jobs while the person's
  **Join good groups when my groups run low** setting is on (on to start) and people left are low, ask to join up to
  3 a day (`JOINS_PER_DAY`, halved for a week after a warning; `outreach.joins.next`): the groups the AI said have
  the business's people, then those that fit well by name not checked yet. With none, the extension searches
  Facebook with the playbook's words, checks the best 3 it finds and asks again. It presses **Join group**; when the
  group asks questions first, the AI answers each from the playbook (the worker's `outreach.join.answer` action),
  and the extension writes them in, ticks that the person agrees to the rules, and submits. A group that asks
  questions to pick from a list is left to the person. Each ask is noted, with the answers given
  (`outreach.join.note`): asked, waiting for the admins, joined, or couldn't, with why; the Groups tab shows it on
  the group's row. One that couldn't is tried again after a week, or when the person asks for it.
- **Today** (`/a/outreach?view=today`, step 5): the person's list for the day, worked
  out each time from what HandsFreeOS knows (`today.ts`, `ops/today.ts`). Friend requests to people from the groups
  who fit a playbook, best first and as many as today's limit has left, only from groups whose admins are read and
  never to anyone who runs a group, is on Don't pitch, is in Contacts, or has had a request; a first message to new
  friends who accepted the person's request; follow-ups to likely prospects gone quiet (the playbook's pace);
  replies owed; and comments on good group posts (below). With **Like a post first** on (decision 33, each person's
  own setting, on to start), someone's request waits until a day after one of their posts was liked, and the list has
  **Like a post first** for as many as a day's requests; a profile with no post to like goes without. Requests the
  person got from people who fit a playbook well come first, as **Confirm their request** (decision 30). **Reconnect**
  (decision 46): friends and people they've chatted with whom the AI found a good fit, once neither side has written
  for a month (`RECONNECT_QUIET_DAYS`), with the AI's why, who they are and a first step, sharing the first messages'
  limit with Say hi; its drafts pick things up again without a pitch, from what the AI found. **Pitch** (decision 47):
  people whose chat the AI read as ready for the offer, or the person marked ready, until a pitch goes, they're
  booked or not a fit, or the person writes to them again; counted against the follow-ups, and in place of a reply or
  follow-up to them. **Answer their comment** (decision 50): people who commented on the person's helpful post. A
  message has **Draft a message**: three drafts from the AI in the playbook's tone, from what's known
  about the person and the chat so far, to copy and send on Facebook (the worker's `outreach.today.draft` action,
  against the daily AI limit; first looked up on Facebook while their computer is online, below). HandsFreeOS never
  sends: the extension notes the step, which takes it off the list. Each person kept as a profile has a menu, here
  (on the web and the phone) and on the Friends tab, the Chats tab and Waiting for you (`person-menu.tsx`): **Add to Contacts** (customers with the
  same name offered first, **It’s them** or **Add as new**; `outreach.profile.contact`), or **In Contacts** once they
  are; **Demo booked**; and **Don't pitch** (a switch of its own on the Friends tab, beside **Keep**; both flip at once and send `outreach.friend.set` in the background, flipping back with the reason if it’s refused). Each Friends tab row keeps the name, **Facebook** and the "N mutual" chip on one line. A group whose admins aren't read yet has
  **Save its members** under **Save who runs these groups**.
- **Tidying up friends** (decisions 10, 12 and 17, `tidy.ts`, `ops/tidy.ts`): the Friends tab suggests the sent
  requests nobody answered after the business's wait (3 weeks to start, a setting in Social Outreach → Settings →
  General, For your team), and friends to unfriend: only once the download file is in, and only those never kept, not in
  Contacts, not on Don't pitch, with no likely-prospect chat, friends for over six months and with no message or step
  in six months either way. Under the Friends tab's **Tidy up** the person ticks who and presses **Cancel the ticked
  requests** or **Unfriend the ticked**, which asks their computer (`cancel`, `unfriend`): it opens each profile in a
  tab they can see, checks it's them and where things stand, presses **Cancel request** (or **Friends**,
  **Unfriend** and **Confirm**), checks the profile says Add friend after, and notes it (`outreach.friend.end`). It
  goes one person every 20 to 40 seconds, up to 30 cancelled and 20 unfriended a day, does only the ticked people
  still on the lists, and hands any step it can't find to the person (**Carry on**, or **Skip** that person).
- **Facebook's warnings** (decision 25): any warning the extension sees on a page, in the tab in front of the person
  (panel open or not) or one it works in, is noted (`outreach.warning.note`). That day it reads no more chats and cancels or unfriends nobody; for 7 days the daily
  limits are halved, and for 2 friend requests are off the list for today. A red note says so on the Today, Friends
  and Live tabs, the activity panel's day, and the extension's panel, and the asks on Facebook wait for tomorrow.
- **Posts worth a comment** (decisions 18 to 20, `posts.ts`, `ops/posts.ts`): as the person scrolls one of their
  groups in the tab in front of them, panel open or not, the extension sends the posts in its feed that say a playbook's signs (the quoted words, or its words to
  search for groups) or ask for help ("Can anyone recommend…", "Looking for…"), with who wrote them; a skip word
  leaves a post out (`postLook`). Each person keeps their own. The AI checks each one (the worker's
  `outreach.check_posts`): good for the business to comment on, or not, with why. **Find posts**, asked from the
  Groups tab, goes through the groups the person is in that are marked Work these (or Maybe, with none), up to 5 a
  run, in a window of its own, scrolling each feed a screen at a time every 6 to 12
  seconds, 8 screens a group, and stops on any Facebook warning. The good ones from the last week go on Today as
  **Comment on a post**, with the post, a link to it and **Draft a comment** (two drafts), as many as today's
  comment limit has left; **Not for me** puts one aside for good. Commenting on it, which the extension notes, takes
  it off. Who wrote one is kept as a profile from the group, and nobody goes in Contacts.
- **Posts asking for what the business offers, fast** (decision 49, `posts.ts`, the worker's `posts.ts`, the
  extension's `src/jobs/posts.ts` and `src/auto/run.ts`): while the extension works on its own, in the person's
  working hours, every 60 to 120 minutes at random (`WATCH_EVERY_MINUTES`; the first an hour or two after the
  once-a-day Find posts), it opens the same groups Find posts works, up to 5, sorted by new posts
  (`?sorting_setting=CHRONOLOGICAL`), reads two screens of each and sends them (`found`: `watch`), between the day's
  steps and never beside an ask. The AI's check of every post now also says whether it's **strong**: the writer is
  asking, now, for exactly what the business offers, ready to hire or buy; only a good post can be. A strong one
  pushes to the person who found it at once (the worker's `outreach.post.checked`), once a post, when it's fresh:
  posted within a day by what Facebook printed ("12m", "3h", "Yesterday"), or, with nothing that says, found by the
  look (`freshPost`): "Dana Reyes is asking for what you offer", opening Today. On Today, the strong ones come first
  (`asking`), before anything else, with **Asking for what you offer** on the web and a part of their own at the top
  on the phone; the extension comments on them first too. It's each person's **Look for new posts asking for what I
  offer, every hour or two** setting, on to start.
- **Helpful posts, and the people who engage** (decision 50, `helpful.ts`, `ops/helpful.ts`, the worker's
  `helpful.ts`, the extension's `src/jobs/helpful.ts` and `src/facebook/compose.ts`, the web's `helpful-card.tsx`):
  once a day (the once-a-day jobs' last, or **Write a helpful post** on Today, on the web and the phone), the person
  asks for one (`outreach.helpful.ask`): for the best of the groups they're in that fits (the AI's good ones first,
  then by fit, then those with posts kept), never one they posted in during the last week, one a day
  (`HELPFUL_PER_DAY`; one put aside or that couldn't go frees the day). The AI writes it (the worker's
  `outreach.draft_helpful`): from the playbook's offer, audience and tone and what people in the group asked lately
  (the posts kept from it), after reading the group's About lines and rules (kept since decision 48); something
  useful, never selling, no links, under 120 words, ending with a question; or, when the rules don't allow a post
  like it, why, and it's put aside (`outreach.helpful.draft`). Today shows it at the top, with what to do by the
  person's **Helpful posts** setting (`posting`, inside what the business allows): **The extension posts it after
  my OK** (the default): its words to change, and **OK, post it** (`outreach.helpful.ok`, then an ask of kind
  `post`), and their computer opens the group, types it into the box **Write something…** opens, presses **Post**,
  finds it at the top of the newest posts for its link, and notes it (`outreach.helpful.posted`); **I copy it and
  post it myself**: **Copy**, **Open the group** and **I posted it**; **The extension posts it on its own**: the
  runner puts it up once it's written, in the working hours. A group whose admins approve posts first is noted as
  up, waiting for them. **Not this one** puts it aside (`outreach.helpful.skip`). Once a day, the extension reads
  each one up in the last fortnight (found by its first words when its link isn't known): each comment and reply,
  with what it says, and who reacted, from **See who reacted to this** (`outreach.helpful.engaged`); never the
  person. Each is kept as a profile from the group, nobody in Contacts. On Today they're warm leads for a fortnight:
  **Answer their comment** (`warm_lead`, counted against the comments, with two drafts that thank them and add to
  what they said) until the person comments on the post after it; and someone not a friend yet goes first for **Like
  a post first** ("Like one of theirs back") and then a friend request, ahead of anyone from the groups, whatever
  the playbooks say.
- **Only certain countries, or not them** (decision 61, `countries.ts`, `ops/countries.ts`, the worker's
  `countries.ts`, the web's `business-settings.tsx`, `country-picker.tsx` and `country-skipped.tsx`): Social
  Outreach → Settings → General has, under For your team, **Which countries to reach**: **Anywhere** (to start), **Only these
  countries** or **Not these countries**, with the countries picked by name (ISO two-letter codes underneath, kept in
  the add-on's settings as `countries`). Each person kept as a profile has a country: the one a line on their profile
  shows ("Lives in Austin, Texas", then "From Lagos, Nigeria"; `countryFromLines`), **seen**; or, when none does,
  the AI's guess from their name, posts and groups, **guessed**; or **couldn't tell**. A check of someone (decision 46) reads it with the rest, its lines first (`outreach.check.save`); everyone else found, in a group, asking to be
  friends, writing a post or engaging, is worked out by the worker's `outreach.guess_countries`, armed when a group's
  people or friend requests are saved and when the settings are, and only while the setting skips anyone: the lines
  under their name first, then the AI, 25 to a question, up to 200 a run (`outreach.countries.save`). A guess never
  replaces a country seen. While the setting skips anyone, Today leaves them out of everything new: Confirm their
  request, Like a post first, friend requests, Say hi, Pitch, follow-ups, Reconnect, comments and warm leads (a reply
  owed still shows); so does the extension, which works from Today's list; the Friends tab's good fits leave them out,
  and so do the Groups tab's people left to reach (`countryLetsSql` in `ops/common.ts`, the one copy of
  `countryLets`). The Friends tab's **Skipped for country** (`outreach.countries.skipped`) lists them, the latest
  worked out first, with their country and seen or guessed, and **Unskip** (`outreach.country.unskip`) lets one
  through from then on whatever the setting says.
- **Never contact, and Don't pitch on a chat** (the owner's ask of 14 Oct 2026, `contactable` and `neverContactOf`
  in `ops/common.ts`; `20261027003500_outreach_never_contact.sql`): **Never contact**
  is a list of the business's, beside Don't pitch and stronger: nobody here sends them a friend request, a like, a
  comment or a message, not even a reply. It's a switch on each Friends tab row and **Never contact** in the person
  menu (the web's and the phone's), set with `outreach.friend.set`'s `neverContact`, and the Friends tab lists them
  (`?show=never_contact`) with who added each and when. Everything Don't pitch leaves out leaves them out too (they
  aren't `pitchable`), and beyond that their friend requests are never shown under Friend requests to decide (so
  never confirmed), a reply of theirs pushes nobody (`outreach.replies.note`), drafting a message for them is refused
  (`outreach.send.queue`, `outreach_never_contact`) and any waiting or OK'd is skipped when they go on it, a step
  noted to them isn't counted (`outreach_never_contact`), Research is refused, and a chat read never puts them in
  Contacts. Like Don't pitch it covers a profile kept twice under the same name, and only whoever added someone, or an
  owner or admin, takes them off (`outreach_never_contact_not_yours`). Each row of the Chats tab has the same two
  switches as a Friends tab row, **Don't pitch** and **Never contact**, for whoever the chat is with
  (`outreach.chats` says `dontPitch` and `neverContact` for each chat's profile; `ChatMarks` in the web's
  `chats-view.tsx` and the phone's `chats.tsx`, where they need signal), so
  someone the person has chatted with but isn't friends with is decided chat by chat. On the phone, People has the Never contact list itself beside Pipeline and Chats
  (`?view=never_contact`, the phone's `never-contact.tsx`, from `outreach.friends`' `never_contact` view): who's on it,
  who added them and when, and a switch that takes someone off, with signal. On the web that address opens the Friends
  tab's Never contact list. A chat with no profile kept yet
  (one from the file not matched to anyone) has no switches until it's read in Messenger.
- **Looking someone up before drafting** (decision 21): while the person's computer is online and Facebook didn't
  warn them that day, **Draft a message** or **Draft a comment** on Today asks it (a `lookup` ask): it opens the
  person's profile in a window of its own, reads their intro and latest two posts, follows the link in their lines to
  the business they own or work at (`pages`, from `apps/extension/src/facebook/profile.ts`) and reads that page too,
  then closes the window. Those lines go with the draft for the AI to use, kept for nothing else; the drafts come back
  on the ask (its `result`, kept a week with it). Offline, or with **Draft from what HandsFreeOS knows**, Today
  drafts from what HandsFreeOS knows.
- **Phone alerts** (decision 22, `alerts.ts`, `ops/alerts.ts`, the worker's `alerts.ts`): while noting is on, the
  extension looks at the chats on any Facebook page as it changes (Messenger's list, an open chat, a small chat
  window) and tells HandsFreeOS who wrote last in each, never what (`outreach.replies.note`). One that answers a
  message of the person's the extension noted is a reply: their phone hears "Dana Reyes wrote back", unless they had
  that tab in front of them, and they're on Today as a reply owed until the person answers. At the business's hour
  (`morningPushHour`, 8 AM to start, or off; Social Outreach → Settings → General, For your team, in the business's time
  zone) each person who noted a step in the last 14 days and has something on their list hears how much ("6 on your list for today").
  Both are add-on pushes (`pushAddonNotice`), on the person's add-ons switch, and open Today.
- **Which openers work** (decision 23, `openers.ts`, `ops/openers.ts`): each playbook keeps two or three styles the
  AI opens first messages in, and up to three of the business's own openers, sent as written with the first name
  filled in. A first message's drafts take the opener the person has used least, and copying one notes which it was
  (`outreach.opener.use`). The Playbooks tab's **Which openers work** card counts, for each, the first messages sent
  with it, who wrote back and who booked a demo; owners and admins see everyone's.
- **The demo link** (decision 24, `demos.ts`, `ops/demos.ts`, the worker's `demos.ts`): each person's own link to the
  playbook's booking page for someone they reached (**Copy demo link** on Today), with a
  `ref` naming who sent it to whom and nothing else. A booking page keeps the `ref` on the booking
  (`appointment_attendees.link_ref`), and a booking through it counts as that person's demo by itself
  (`outreach.demo.note`, from `appointment.booked`). **Demo booked** in a person's menu (Today, Friends, Chats,
  Waiting for you) marks one booked some other way (`outreach.demo.mark`, by the profile kept here).
- **The extension on its own** (decisions 26 to 33, `automation.ts`, `ops/automation.ts`; the extension's
  `src/auto/`): each person picks, on Social Outreach's **Settings** tab (decision 37), whether the extension does their friend requests,
  likes and comments by itself (messages always wait for them), whether it likes a post first, whether it confirms
  requests from people who fit, and their working hours (9 to 5, Monday to Friday, to start, on the business's
  clock). It then goes down their list for today on its own, at random times spread over the hours, or straight away at
  a person's pace once they press **Start my day**; in a window of its own beside theirs, one step per alarm: it opens
  the profile or post, checks it's the right person and where things stand, presses **Confirm**, **Like**, **Add
  friend**, or writes the AI's first comment draft and sends it, checks it worked, and notes it as its own
  (`touches.auto`). The list only ever holds what today's limits have room for, so it keeps them. It stops for the
  day on any Facebook warning and on **Stop for today**, and works only while Chrome is open, someone is signed in
  and noting is on. Today marks what it does as **Done on its own**, and the morning push
  leaves those out. Once a day, first, it does the jobs that fill that list
  (decision 32, the extension's `src/auto/daily.ts` and `src/jobs/`): it saves the friend requests the person has got
  (`outreach.friends.save`), then the admins and moderators of up to 3 of their Work these groups, read to the end,
  and their members (`outreach.group.save`), then Find posts (`outreach.posts.save`) and Read my chats, up to 60
  (`outreach.chats.collect`). Each reads and saves only, as the same asks from the app do, and a warning stops the
  day.
- **Lists first** (decision 60, `lists.ts`, `ops/lists.ts`, the extension's `src/auto/lists.ts` and
  `src/jobs/people.ts`): before anything else in the person's day, the runner saves their own lists to their end:
  their friends list, the friend requests they've got, and the ones they've sent (it presses **View sent requests**
  on `/friends/requests`, and nothing else). HandsFreeOS keeps when each was last saved to its end, each person's own
  (`addon_outreach.list_saves`, `outreach.lists`, `outreach.lists.saved`). The first time, nothing runs until all
  three are saved: the extension says "Saving your friends list first…", and under **Start my day** the web and the
  phone say the day starts once they're saved (`dayWords` with `outreach.live`'s `lists`). One that goes wrong is
  tried again in a few minutes. After that, the requests either way are saved again each morning before the day (they
  stand for that day's once-a-day friend requests), and the friends list once its last full save is 7 days old
  (`FRIENDS_AGAIN_DAYS`); a refresh that goes wrong waits for tomorrow and never holds the day up. Right after the
  first full save it works out the **Tidy up** suggestions (`outreach.friends.tidy`, decisions 10, 12 and 17) and
  then checks friends for good fits once (decision 46, up to `CHECKS_PER_DAY`), which stands for that day's check;
  from then on the checks run daily with their cap.

  **Groups too** (the owner's decision): after the sent requests it saves the person's groups (Save my groups,
  `src/jobs/groups.ts`), and right after the first full save it checks them (decision 48, `src/jobs/groups-check.ts`,
  up to `GROUP_CHECKS_DAILY`), before Tidy up. The first time, the day waits for both, and either one that goes wrong
  is tried again in a few minutes, as the lists are; the first check stands for that day's group checks. After that
  the groups are saved again once their last save is 7 days old, like the friends list, and checked by the daily
  group checks; neither holds the day up. Kept in `list_saves.groups_at` and `group_checks_at`
  (`20261027002830_outreach_list_saves_groups.sql`), noted with `outreach.lists.saved` (`groups`, `group_checks`).

  **The live checklist** (`preDaySteps`, `PRE_DAY_WORDS`): while the steps before the first day run, the web (Today's
  status strip and the Live view, `pre-day-list.tsx`), the phone's live view (`PreDayPart`) and the extension's
  panel list them in order (Save your friends list, Save friend requests you got, Save friend requests you sent,
  Save your groups, Check your groups, Work out who to unfriend, Check your friends for good fits), each ticked once
  noted, the one under way showing what the extension says it's doing ("Reading your friends… 1,240 friends so far.",
  "3 of 8 groups checked. Reading …"). No new channel: the ticks are `outreach.live`'s `lists`, and the progress is
  the working computer's status line, which the jobs' `job.progress` already sends with each beat. Each beat also
  says which step it's doing (`doing`, the runner's `beforeNow`; `addon_outreach.computers.doing`,
  `20261027003100_outreach_computer_doing.sql`), so the web and the phone show the count under that step and no
  other (`preDayNow`): while the extension does other work, no line shows under a step. While a step runs its count
  is sent and told every `PRE_DAY_LINE_SECONDS` (4) rather than every 20 and 45, so it goes up as it reads. Work out
  who to unfriend is one call to HandsFreeOS, so it has no count. The web and the phone take the first step not done
  as the one under way. It shows only while the day is started, and goes once every step is done.

- **Settings in HandsFreeOS** (decisions 37 to 40 and 73, `/a/outreach?view=settings&part=`, `automation.ts`,
  `ops/automation.ts`, `settings-parts.ts`, the web's `settings-page.tsx`, `settings-view.tsx` and
  `use-autosave.ts`, the extension's `src/hfos/follow.ts`): every setting the extension follows is set here, never in
  the extension, a page for each part, each change saved as it's made. **General** holds the person's own on every
  network: how the AI writes for them, the working hours and how the phone hears about messages waiting (`pushes`).
  **Each network's page** holds On for you, what it does there on its own, Replies, helpful posts and along the way
  (only the switches its runner does, `ticksShownOn`), and on Facebook the three switches the extension used to keep (**Note my steps on Facebook**, **Read chats as I open
  them**, **Look for posts as I scroll a group**). For owners and admins, **For your team** on General holds the
  choices people may pick, where a new person starts (`rules` in the business's Social Outreach settings), and the
  business's other Social Outreach settings (`business-settings.tsx`), which used to be on the Add-ons page: that page
  now only links here (`settings-link.tsx`, or a line saying where they are for people who can't change them); and
  **For your team on** each network's page holds whether the team may use it and its daily limits under the starting
  ones. An owner or admin picks anyone under **Settings for** and changes theirs; the person then sees "Changed by".
  The extension loads them when the person signs in and hears each change within seconds on the same live channel
  the web listens on, while Chrome is open; its panel shows a short summary with **Change in HandsFreeOS**.
- **Live status and control** (decision 41, `/a/outreach?view=live`, `live.ts`, `ops/live.ts`, `ops/day.ts`, the
  web's `live-view.tsx`, the extension's `src/hfos/live.ts`): the **Live** tab shows what the person's extension is
  doing right now, on which computer, the next step, today's counts against the limits, how many things wait for
  them (Waiting for you's count, linking there), a Facebook warning, and a feed of today's steps, all live. **Start my day** and **Stop for today** there
  keep the person's day in HandsFreeOS (`addon_outreach.days`), and the computer that works follows within seconds
  over the live channel. Each install of the extension is a computer (`addon_outreach.computers`) with a plain name
  ("Chrome on Windows"), renamable and removable on the tab (a fresh install takes its old computer's place, decision
  85); only the one the person used last works, and the others stand by and
  say why. With no word from it for 3 minutes the tab says "Your computer is offline: nothing runs until Chrome is
  open. Last seen 2:14 PM." While it's shown, the tab asks again every minute, so a computer still beating never
  looks offline. A warning stops the day there too and pushes to the person's phone once that day. Owners
  and admins see each person's status, computer, counts and how many wait, never their lines or messages.
- **Waiting for you** (decisions 40, 42 and 72, `/a/outreach?view=waiting`, `waiting.ts`, `waiting-words.ts`,
  `ops/waiting.ts`, `ops/needs.ts`, the web's `waiting-view.tsx`, the worker's `waiting.ts`, the extension's
  `src/hfos/waiting.ts` and `src/panel/needs.ts`): one list of everything waiting for the person, worked out each
  time (`outreach.waiting`), the same as **Needs you** on Today, on the web and the phone. The extension's panel no
  longer lists it (decision 72, replacing the list in the panel that decisions 42 and 59 gave it): it says how many
  things need the person in one line under Next up, with a link to Needs you, and the number is on its icon. **Your computer needs you** (an ask with a step handed to the person, below, with **Carry on**, **Skip** and
  **Stop**); **Replies handed over to you** (each waits for an OK of its own); **Messages to OK**, with **Approve all**,
  which leaves a reply handed over or one to someone who needs the person; **Steps it needs you for**, a step the
  extension couldn't do there and then (a button or box it couldn't find, a different page, Facebook not taking it, a
  message that didn't go), with **I did it** and **Let it go**; and **Friend requests to decide**, those from the last
  two weeks that didn't fit a playbook (or fit but are on Don't pitch), with why and **Leave it**. Each tab's label
  carries the count. New
  messages and steps reach the phone as the person's **pushes** setting says: one bundled push at most every 2 hours
  in their working hours ("5 messages wait for your OK", the default), or one for each; a reply handed over pushes at
  once either way. The extension's Chrome pop-ups follow the same rule on the computer that works. A click opens
  Needs you in HandsFreeOS in a tab (`outreachPath(…, 'waiting')`, at `#needs-you`), never the side panel (decision
  72).
- **Asking the extension** (decision 43, `asks.ts`, `ops/asks.ts`, `addon_outreach.asks`, the web's `asks.tsx`, the
  worker's `asks.ts`, the extension's `src/asks/run.ts` and `src/hfos/asks.ts`): what needs the browser is asked of
  the person's working computer from the app. The buttons on the Friends, Groups, Chats and Today tabs (and the
  phone's Groups and Chats screens) make an ask
  (`outreach.ask.make`), one of eighteen kinds: the file's three steps and bringing it in, friend requests, the
  friends list, groups, a groups search, checking groups, joining groups, putting up a helpful post, group members (the best groups, ones named, or a pasted link), Find posts,
  Read my chats, checking friends for good fits, cancelling and unfriending the ticked, and a look-up before drafting. Asking again while one like it
  is open answers that one. The computer that works hears of it on the live channel (or with its next beat), takes it
  (`outreach.ask.take`), does it with its jobs, one at a time and never beside a step of the runner's, says how it's
  going (`outreach.ask.progress`) and how it ended (`outreach.ask.end`, which waits in the extension with no
  connection). Each shows live under its button and in the Live tab's **Asked of your computer**, with **Stop**
  (`outreach.ask.cancel`). A step it can't find is handed to the person: the tab comes to the front, Chrome pops up,
  their phone hears "Your computer needs you", and Waiting for you lists it, with **Carry on** and, for someone
  ticked, **Skip** (`outreach.ask.reply`), pressed on the web or the phone; the extension hears the answer on the
  live channel, or with its next look every 20 seconds. Its panel says what to do and to press Carry on in
  HandsFreeOS → Needs you, with a link there, and keeps only **Stop** (decision 72). A day with no computer on lets
  an ask go; Chrome closing mid-way ends it as lost; half an hour with no answer stops it. Asks are kept a week.
- **On the phone** (decision 44, `apps/mobile/src/addons/outreach/`, `words.ts`, `views/waiting.ts`): one item
  under More, **Social Outreach**, saying how many messages wait for the person's OK, opens the add-on's own screen:
  **Waiting for you**, **Live**, **Today**, **Pipeline**, **Groups**, **Chats**, **Playbooks** and **Settings**, at the web's own
  addresses (`/a/outreach?view=…`, `/a/outreach/playbooks/<id>`), so every link and push opens there. Waiting for you
  works with no signal: each person's messages waiting for their OK reach their phone alone (`addon_phone_rows`,
  source `sends`, sealed to the person by `private.addon_phone_own_table`, 20261027001800) and leave it once OK'd,
  skipped or sent, so they read them, OK, change, skip and Approve all on a plane; each press waits on the phone and
  goes when it's back online, and its message stays off the list until it has gone. An OK that waited more than 30 minutes asks "Still send?" first; a skip goes whenever,
  but never undoes an OK given after it was pressed; Approve all names what the phone showed and passes over any
  handled elsewhere meanwhile (`partial`). The steps it needs them for and the friend requests to decide come from
  HandsFreeOS, with signal. The Live screen asks again every minute and keeps the last answer "As of 2:14 PM" without
  signal; Start my day and Stop for today wait on the phone too, and show as pressed only while they wait there.
  Like the web, it names an open computer when the one that works is offline, shows the others as standing by, and
  offers no Start my day while a Facebook warning keeps the day stopped. Today OKs and skips its drafts, puts a post aside,
  has each person's menu as the web's (**Add to Contacts**, with the same-named customers offered first, **Demo
  booked** and **Don't pitch**; the phone's `person-menu.tsx`) and, for owners and admins, ends training wheels; Groups and Chats search and page as the web's, and ask the
  person's computer as the web's buttons do (decision 43, the phone's `asks.tsx`): **Save my groups**, **Find
  groups**, **Save members of my best groups**, **Find posts**, a group's **Save its members** and **Read my chats**,
  each with the line of its latest ask; the Live screen lists what was asked (**Asked of your computer**), and Waiting
  for you what needs the person there first (**Your computer needs you**), with **Carry on**, **Skip** and **Stop**
  (`outreach.ask.make`, `.reply`, `.cancel`, online); Playbooks are
  read by everyone and changed a part at a time by owners and admins, each save put on the playbook as it is now so a
  change made meanwhile on the web stays; Settings has the web's menu and parts (decision 73), each part a screen
  pushed over the menu (`?part=` in its address, the manifest's `ui.phone` reading `part` and `net`), with Settings
  for (owners and admins), every change saved as it's made, and no Start fresh; **Where your team gets the
  extension** is checked as the web's box checks it (`extensionLinkProblem`). Activity and Friends have a lot to look through, so they stay on the web (the manifest's `ui.phone`
  `web`), and so do their asks (the file, friend requests, friends, tidying), drafting a message with its look-up,
  copying an opener and the AI's playbook help. What the phone shows, but for Waiting for you's messages, needs
  signal, and says so plainly without it. What waits on the phone with no signal and goes when it's back
  (`apps/mobile/src/changes/commands.ts`): OK, change and Approve all on a message (`outreach.send.approve`, held to
  30 minutes, then "Still send?"); Skip on a message, Start my day and Stop for today, **I did it** and **Let it go**
  on a step, **Leave it** on a friend request, and **Not for me** on a post (`outreach.send.skip`, `.day.start`,
  `.day.stop`, `.need.clear`, `.request.set_aside`, `.post.skip`, as long as it takes). What needs signal there and
  then, and is never queued: saving settings (someone's, `outreach.automation.save`, and the business's,
  `addon.save_settings`), ending training wheels (`outreach.wheels.end`), writing or archiving a playbook
  (`outreach.playbook.save`, `.archive`), asking the computer, Carry on, Skip and Stop (`outreach.ask.make`, `.reply`,
  `.cancel`), and the person menu's Add to Contacts, Demo booked and Don't pitch (`outreach.profile.contact`,
  `outreach.demo.mark`, `outreach.friend.set`). The words the web and the phone
  both say are core's `words.ts` (`OUTREACH_WORDS`), which the web reads too: its Settings, Waiting for you, Today
  and Live tabs, its Settings pages and the Add-ons page's link to them, the person menu (`OUTREACH_WORDS.person`,
  `sameNamePeople`), and its tabs' names and the labels its Playbooks, Groups and Chats tabs share with the phone. The web's step-by-step playbook builder keeps its own questions, which the phone doesn't ask. The helpers that write phone rows (`addon_phone_upsert` and the seals) run only as their owner: nobody
  signed in may call them.
- **The setup** (decisions 36, 45 and 83, `/a/outreach/setup`, `setup.ts`, `ops/setup.ts`, the web's
  `setup-view.tsx`, `setup-steps.tsx` and `setup-network.tsx`): Social Outreach's onboarding, a step at a time in the
  same card as the main app's, with a list of the steps beside it (folded on a phone). A **main setup** in three
  parts, once per person: **Your business** (the main offer, a playbook, a short video if the business wants one, the
  team's rules; owners and admins only), **Your computer** (the extension) and **You** (your messages, your goal, the
  networks you use). Then a **short setup for each network** they turn on, Facebook first: Allow it in Chrome (not on
  Facebook), a playbook for it (only while none runs there), your profile there, what it does there, and your first
  day there (`?net=linkedin&step=allow`). Each step ticks from what's true, never from a button pressed, and **Skip
  for now** leaves it to do. The main offer and a playbook are built on their own pages, which come back to the step
  (`back=`, `from=setup`). The install has five steps, each with a picture of Chrome drawn in the app's colours
  (`install-pictures.tsx`), the sign-in ticking by itself, and **Stuck?** folded under them; a network's Allow has
  three. It opens at the first step left, can be left with **Finish later** and picked up from the **Next** line on
  every tab ("Next: Main offer · 5 of 8 done.", with **Carry on** and **Hide**), and **Set up again** on the Settings
  tab opens it at the first step. Someone who never saved their own settings and never started it is sent there from
  the bare Social Outreach page, and the extension opens it in a tab when they sign in (decision 21a); the phone's
  Social Outreach screen says to set it up on a computer until it's finished (`SETUP_WORDS.onPhone`, while
  `finishedAt` is empty, whether or not the web's line was hidden). On a phone or a browser other than Chrome, the
  steps done on a computer say so, with the page's link to copy. The extension downloads from HandsFreeOS itself
  (decision 71): the setup's install step and Settings → Your computer have **Download HandsFreeOS Social** with its
  version and size. A business that keeps its own copy pastes its link under **Where your team gets the extension**
  (Settings → General, For your team, on the web; and on the phone), and everyone's download is that one instead.
- **Playbooks** (`/a/outreach?view=playbooks`): what the business is looking for on social media, how it sounds and
  which of its tags to use. Each has a goal, a niche inside the business's main offer with its biggest problem and its
  own proof (decision 62), an offer and link, something useful to send, who it's for, signs to look for and who to
  skip, where to look, the steps it takes and how fast, the tone, sample messages, the openers, the conversation, words
  to avoid, a disclaimer and the tags. The first template is **CRM demos**; a blank one is always there.
- **The playbook builder** (`/a/outreach/playbooks/new`, `/a/outreach/playbooks/<id>`): a playbook asked a step at a
  time, twelve steps from the goal to a summary, each with ideas to tap and room for the business's own words. The
  niche step shows the live main offer, offers its who and its proof to tap, and **Check it fits my main offer**; with
  none live it says where to build one, and carries on without. The offer step starts a new playbook's offer as the
  main offer's outcome in a few words, offers the business's booking pages as the link, and asks for something useful
  to send; the tags step offers its own tags. A new playbook walks every step; changing one opens on the summary, where
  each part has its own Change.
- **AI help on each part of a playbook** (owners and admins): under every part the person writes, **Improve**
  rewrites what's there and **Suggest more** (or **Write it for me**) offers more, from the whole playbook as it
  stands. Words come back three to pick from; list lines to tap in one by one, or a rewritten list to use instead;
  questions with their answers, what each leads to and only the playbook's own tags. Nothing is used until the person
  picks it, and it counts against the business's daily AI limit (`playbook-assist.ts`; the worker's
  `outreach.playbook.assist` action). The AI reads the live main offer with the playbook, so what it writes stays inside
  the offer's who and in line with its outcome and guarantee. The goal, link, steps and pace are choices, not writing,
  so they have none; proof has none either, as a result is real or it isn't there.
- **Whether the niche fits the main offer** (`niche-fit.ts`; the worker's `outreach.playbook.niche_fit` action): the AI
  says **inside** the offer's who, **really a second offer** (it needs another outcome or price), or **outside** it,
  with why in a line. It only says; it never stops a playbook being saved. With no live main offer it says so and the
  AI isn't asked.
- **The conversation**: the questions to work into a chat, each with the answers people give. An answer can add one of
  the playbook's tags, and says what's next: the next question, a question further down, the offer, checking back
  later, or stopping. A question with no answers is answered in the person's own words.
- **Add to Contacts, in the app** (`outreach.profile.contact`): the extension no longer saves a profile or a chat by
  a button (settings part 4). The people the person reaches are kept as profiles by noting; the person menu on Today
  (the web's and the phone's), the Friends tab, the Chats tab and Waiting for you adds one to Contacts with Facebook as the source, or ties them to the
  same-named customer the person picks (`person-menu.tsx`, `same-name.tsx`).
- **Save to their card, on the web** (`outreach.chat.keep`, `chat-keep.tsx`): chats come onto the Chats tab through
  **Read chats as I open them**, **Read my chats** and the file; **Save to their card** on a chat there, or on a reply
  waiting for the person, copies its messages onto the customer's Social card, each with when it was sent. Nobody in
  Contacts yet: the same-named customers are offered first, or they're added. Saved again, only what's new is added.
  Nothing is read on Facebook for it.
- **A Social card on each customer** (`person.panels`): their Facebook profile, and each chat saved to their card.

## How it fits together

| Piece                                                    | Where                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest, operations, tables, shapes                     | `packages/core/src/addons/outreach/`                                                                                                                                                                                                                                                |
| What a save takes: lengths, counts, id shapes (no zod)   | `packages/core/src/addons/outreach/limits.ts`                                                                                                                                                                                                                                       |
| Worker half: the AI reading the chats, and its drafts    | `apps/worker/src/addons/outreach/`                                                                                                                                                                                                                                                  |
| What the extension notes, and the panel's shapes         | `packages/core/src/addons/outreach/activity.ts`, `ops/activity.ts`                                                                                                                                                                                                                  |
| The page and its tabs, and the Social card               | `apps/web/src/addons/outreach/`, `/a/outreach`                                                                                                                                                                                                                                      |
| The playbook builder                                     | `apps/web/src/addons/outreach/playbook-builder.tsx`, `/a/outreach/playbooks/…`                                                                                                                                                                                                      |
| Tables and permissions                                   | `supabase/migrations/20261024000100_addon_outreach.sql`, schema `addon_outreach`                                                                                                                                                                                                    |
| Groups and steps noted                                   | `supabase/migrations/20261026000300_outreach_activity.sql`                                                                                                                                                                                                                          |
| Friends, Keep and Don't pitch, and how someone fits      | `friends.ts`, `fit.ts` (no zod) and `ops/friends.ts` in the add-on's folder                                                                                                                                                                                                         |
| Friends and the Don't pitch list                         | `supabase/migrations/20261026000400_outreach_friends.sql`                                                                                                                                                                                                                           |
| Facebook's download file: reading it, and bringing it in | `download-read.ts` (reads the zips, no zod), `download.ts` and `ops/download.ts`                                                                                                                                                                                                    |
| The extension getting the file                           | `apps/extension/src/facebook/fetch.ts`, `src/jobs/file.ts`, `src/jobs/file-in.ts`, `src/offscreen.ts`                                                                                                                                                                               |
| What the file said, by name                              | `supabase/migrations/20261027000300_outreach_facebook_download.sql`                                                                                                                                                                                                                 |
| Chats read live in Messenger                             | `chat-collect.ts`, `supabase/migrations/20261027000600_outreach_chat_reads.sql`                                                                                                                                                                                                     |
| Groups, their people, and the list for today             | `groups.ts`, `today.ts`, `supabase/migrations/20261027000700_outreach_groups.sql`                                                                                                                                                                                                   |
| Tidying up friends, and Facebook's warnings              | `tidy.ts`, `ops/tidy.ts`, `supabase/migrations/20261027000900_outreach_tidy_and_warnings.sql`                                                                                                                                                                                       |
| The buttons pressed to cancel and unfriend               | `apps/extension/src/facebook/tidy.ts`, `src/jobs/tidy.ts`                                                                                                                                                                                                                           |
| Posts worth a comment, and the AI's check of them        | `posts.ts`, `ops/posts.ts`, `supabase/migrations/20261027001000_outreach_group_posts.sql`                                                                                                                                                                                           |
| Posts asking for the offer, fast (decision 49)           | `posts.ts`, `apps/worker/src/addons/outreach/posts.ts`, `apps/extension/src/jobs/posts.ts`, `src/auto/run.ts`, `supabase/migrations/20261027002300_outreach_fast_posts.sql`                                                                                                         |
| Helpful posts, and who engages (decision 50)             | `helpful.ts`, `ops/helpful.ts`, `apps/worker/src/addons/outreach/helpful.ts`, `apps/extension/src/jobs/helpful.ts`, `src/facebook/compose.ts`, `apps/web/src/addons/outreach/helpful-card.tsx`, `supabase/migrations/20261027002400_outreach_helpful_posts.sql`                     |
| Finding posts, and looking people up before drafting     | `apps/extension/src/jobs/posts.ts`, `src/jobs/lookup.ts`, `src/facebook/browse.ts`                                                                                                                                                                                                  |
| Replies, openers and demos                               | `alerts.ts`, `openers.ts`, `demos.ts` and their `ops/`, `supabase/migrations/20261027001100_outreach_replies_openers_demos.sql`                                                                                                                                                     |
| The pushes, and a booking through the demo link          | `apps/worker/src/addons/outreach/alerts.ts`, `demos.ts`; `apps/worker/src/addons/alerts.ts` (`pushAddonNotice`)                                                                                                                                                                     |
| The extension on its own: choices, and the warm-up       | `automation.ts`, `ops/automation.ts`, `supabase/migrations/20261027001200_outreach_automation.sql`                                                                                                                                                                                  |
| Settings in HandsFreeOS, and the business's rules        | `automation.ts`, `ops/automation.ts`, `apps/web/src/addons/outreach/settings-view.tsx`, `business-settings.tsx`, `settings-link.tsx`, `supabase/migrations/20261027001400_outreach_settings_in_app.sql`                                                                             |
| The extension following them live                        | `apps/extension/src/hfos/follow.ts`, `src/panel/status.ts`                                                                                                                                                                                                                          |
| Live status, computers, the day, the feed                | `live.ts`, `ops/live.ts`, `ops/day.ts`, `apps/web/src/addons/outreach/live-view.tsx`, `supabase/migrations/20261027001500_outreach_live.sql`                                                                                                                                        |
| The extension's heartbeat, and following the day         | `apps/extension/src/hfos/live.ts`, `src/hfos/follow.ts`, `src/background.ts`                                                                                                                                                                                                        |
| The warning push, and pruning the feed                   | `apps/worker/src/addons/outreach/live.ts`                                                                                                                                                                                                                                           |
| Messages on their own, and training wheels               | `sends.ts`, `ops/sends.ts`, `supabase/migrations/20261027001300_outreach_sends.sql`                                                                                                                                                                                                 |
| Waiting for you, and steps it needs you for              | `waiting.ts`, `waiting-words.ts` (no zod of its own), `ops/waiting.ts`, `ops/needs.ts`, `supabase/migrations/20261027001600_outreach_waiting.sql`                                                                                                                                   |
| Waiting for you's tab, and its pushes                    | `apps/web/src/addons/outreach/waiting-view.tsx`, `apps/worker/src/addons/outreach/waiting.ts`                                                                                                                                                                                       |
| The icon's number, the panel's line, and the pop-ups     | `apps/extension/src/hfos/waiting.ts`, `src/hfos/needs-you.ts`, `src/panel/needs.ts`, `src/background.ts`                                                                                                                                                                            |
| Lists first, before the day (decision 60)                | `lists.ts`, `ops/lists.ts`, `apps/extension/src/auto/lists.ts`, `src/jobs/people.ts`, `src/jobs/groups.ts`, `src/jobs/groups-check.ts`, the web's `pre-day-list.tsx`, `supabase/migrations/20261027002800_outreach_list_saves.sql`, `20261027002830_outreach_list_saves_groups.sql` |
| The runner, and what it presses                          | `apps/extension/src/auto/plan.ts`, `src/auto/run.ts`, `src/auto/turns.ts`, `src/facebook/auto.ts`, `src/panel/status.ts`, `src/tab.ts`                                                                                                                                              |
| Stages and the pitch (decision 47)                       | `stages.ts`, `ops/stages.ts`, `apps/web/src/addons/outreach/pipeline-view.tsx`, `apps/mobile/src/addons/outreach/pipeline.tsx`, `supabase/migrations/20261027002100_outreach_stages.sql`                                                                                            |
| The fits among friends and chats (decision 46)           | `checks.ts`, `ops/checks.ts`, `apps/worker/src/addons/outreach/checks.ts`, `apps/extension/src/jobs/checks.ts`, `supabase/migrations/20261027002000_outreach_fit_checks.sql`                                                                                                        |
| Groups, theirs first, then new ones (decision 48)        | `group-checks.ts`, `ops/group-checks.ts`, `apps/worker/src/addons/outreach/groups.ts`, `apps/extension/src/jobs/groups-check.ts`, `src/jobs/join.ts`, `src/facebook/join.ts`, `supabase/migrations/20261027002200_outreach_group_checks.sql`                                        |
| Asking the extension                                     | `asks.ts`, `ops/asks.ts`, `apps/web/src/addons/outreach/asks.tsx`, `apps/worker/src/addons/outreach/asks.ts`, `supabase/migrations/20261027001700_outreach_asks.sql`                                                                                                                |
| Its jobs                                                 | `apps/extension/src/asks/run.ts`, `src/hfos/asks.ts`, `src/jobs/`, `src/offscreen.ts`                                                                                                                                                                                               |
| Reading as the person goes, panel or not                 | `apps/extension/src/facebook/looking.ts`, `src/hfos/looked.ts`, `src/content.ts`                                                                                                                                                                                                    |
| Spotting replies on the page                             | `apps/extension/src/facebook/replies.ts`, `src/hfos/replies.ts`, `src/content.ts`                                                                                                                                                                                                   |
| The phone: its screens, and the words they say           | `apps/mobile/src/addons/outreach/`, `app/app/w/[workspaceId]/(tabs)/(more)/a/outreach/`, `words.ts` (the web's too)                                                                                                                                                                 |
| The phone's copy of Waiting for you                      | `views/waiting.ts`, `../phone-rows.ts`, `supabase/migrations/20261027001800_outreach_on_the_phone.sql`                                                                                                                                                                              |
| The setup, in HandsFreeOS                                | `setup.ts`, `ops/setup.ts`, `apps/web/src/addons/outreach/setup-view.tsx`, `setup-steps.tsx`, `setup-network.tsx`, `install-pictures.tsx`, `extension-link.tsx`, `/a/outreach/setup`                                                                                                |
| The extension's first run, and the setup's table         | `apps/extension/src/hfos/setup.ts`, `supabase/migrations/20261027001900_outreach_setup.sql`                                                                                                                                                                                         |
| How the AI writes, and a message as a few texts          | `voice.ts`, `today.ts` (`checkedDrafts`), `apps/worker/src/addons/outreach/today.ts`, `apps/extension/src/auto/run.ts`, `supabase/migrations/20261027002600_outreach_voice.sql`                                                                                                     |
| The chat so far beside a message waiting                 | `sends.ts` (`recentBubbles`), `ops/common.ts` (`recentOf`), `apps/web/src/addons/outreach/chat-bubbles.tsx`, `apps/mobile/src/addons/outreach/chat-bubbles.tsx`                                                                                                                     |
| Don’t pitch covering a person kept twice                 | `ops/common.ts` (`neverTwins`, `pitchable`), `supabase/migrations/20261027002500_outreach_dont_pitch_twins.sql`                                                                                                                                                                     |
| Start fresh                                              | `apps/web/src/addons/outreach/start-fresh.tsx`, core’s `addon.start_fresh`, `apps/extension/src/hfos/follow.ts` (`forgetOnFreshStart`)                                                                                                                                              |
| The extension                                            | `apps/extension`                                                                                                                                                                                                                                                                    |

Operations, all through the kernel:

| Operation                                             | Who               | What                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outreach.playbook.list`                              | `outreach.use`    | The playbooks, those in use first                                                                                                                                                                                                                                                                                                   |
| `outreach.playbook.save`, `outreach.playbook.archive` | `outreach.manage` | Write one; put one away or bring it back                                                                                                                                                                                                                                                                                            |
| `outreach.profile.save`                               | `outreach.use`    | A profile as the extension read it: finds the customer it's saved to, or the one picked, or adds one (no longer used by the extension)                                                                                                                                                                                              |
| `outreach.chat.save`                                  | `outreach.use`    | A chat as read: the new messages join what was saved (no longer used by the extension; Save to their card is `outreach.chat.keep`)                                                                                                                                                                                                  |
| `outreach.chat.keep`                                  | `outreach.use`    | Save to their card: one of the person's own chats on the Chats tab onto the customer's Social card; refused until they say who (`outreach_chat_who`)                                                                                                                                                                                |
| `outreach.lookup`                                     | `outreach.use`    | Which profiles and chats on a page are saved, who in Contacts has a name, and Keep and Don't pitch (Add to Contacts' same-name check; no longer used by the extension)                                                                                                                                                              |
| `outreach.profile.contact`                            | `outreach.use`    | Add to Contacts: a profile kept here becomes a customer (source Facebook), or is tied to the one named                                                                                                                                                                                                                              |
| `outreach.person`                                     | `outreach.use`    | A customer's profiles and chats, for the Social card                                                                                                                                                                                                                                                                                |
| `outreach.touch.save`                                 | `outreach.use`    | A step the person took on Facebook, as the extension saw it: to whom, and the group they came from                                                                                                                                                                                                                                  |
| `outreach.activity.posts`                             | `outreach.use`    | The posts liked and commented on over a stretch, the latest first, with what the extension's own said; everyone's for owners, admins. Not them: `outreach_activity_everyone`                                                                                                                                                        |
| `outreach.activity`                                   | `outreach.use`    | The panel's numbers over a stretch, with demos, by group and person; everyone's for owners, admins                                                                                                                                                                                                                                  |
| `outreach.friend.note`                                | `outreach.use`    | The person confirmed or deleted a friend request on Facebook                                                                                                                                                                                                                                                                        |
| `outreach.friends.save`                               | `outreach.use`    | The person's friends list or requests, as far as the page loaded, up to 500 at a time                                                                                                                                                                                                                                               |
| `outreach.friend.set`                                 | `outreach.use`    | Keep (the person's own), or Don't pitch or Never contact (the business's), for someone; Never contact skips the messages waiting for them                                                                                                                                                                                           |
| `outreach.friends`                                    | `outreach.use`    | The Friends tab: the counts, and a page of one list searched by name, the requests by fit, the good fits with the AI's check; and how far checking has come                                                                                                                                                                         |
| `outreach.checks.next`                                | `outreach.use`    | Who the person's computer checks next for a good fit, in order, no more than today has room for                                                                                                                                                                                                                                     |
| `outreach.check.look`                                 | `outreach.use`    | What someone's profile and business page said as the computer read it, for the AI; or that Facebook showed someone else                                                                                                                                                                                                             |
| `outreach.check.save`                                 | the worker        | What the AI made of them: good, might fit or not, the playbook, why, who they are and a first step; the lines go                                                                                                                                                                                                                    |
| `outreach.stages`                                     | `outreach.use`    | The Pipeline: everyone the person reached by where they stand, counted by stage, one stage or all in play, by name                                                                                                                                                                                                                  |
| `outreach.stage.mark`                                 | `outreach.use`    | Ready to pitch, pitched, not a fit, or back in play, for someone the person reached                                                                                                                                                                                                                                                 |
| `outreach.download.save`                              | `outreach.use`    | A part of Facebook's download file as the browser read it; the last matches names and puts it in                                                                                                                                                                                                                                    |
| `outreach.chats.collect`                              | `outreach.use`    | Up to 10 chats read live in Messenger: their latest messages join what's kept, for the AI to read                                                                                                                                                                                                                                   |
| `outreach.groups.save`                                | `outreach.use`    | The groups a page lists, with what it said about each, up to 100 at a time                                                                                                                                                                                                                                                          |
| `outreach.group.save`                                 | `outreach.use`    | A group and up to 500 people from its People tab; its admins page marks its admins as read                                                                                                                                                                                                                                          |
| `outreach.groups`                                     | `outreach.use`    | The Groups tab: the counts, and a page of groups, those bringing results first, then by fit                                                                                                                                                                                                                                         |
| `outreach.groups.to_check`                            | `outreach.use`    | Which groups the person's computer checks next: their own first, then those that fit by name; none checked lately                                                                                                                                                                                                                   |
| `outreach.group.look`                                 | `outreach.use`    | What a group's About tab, rules and latest posts said as the computer read them, for the AI; the posts go once it has                                                                                                                                                                                                               |
| `outreach.group.check`                                | the worker        | What the AI made of a group: the business's people are there, some, or not, the playbook, why and who's there                                                                                                                                                                                                                       |
| `outreach.joins.next`                                 | `outreach.use`    | Which groups to ask to join, no more than today has room for, with people left to reach and the setting                                                                                                                                                                                                                             |
| `outreach.join.note`                                  | `outreach.use`    | How an ask to join went: asked, waiting for the admins, joined or couldn't, with the AI's answers to its questions                                                                                                                                                                                                                  |
| `outreach.helpful.ask`                                | `outreach.use`    | Ask the AI for today's helpful post, for a group of theirs that fits: one a day, never the same group twice a week                                                                                                                                                                                                                  |
| `outreach.helpful.draft`                              | the worker        | What the AI wrote, or why the group's rules don't allow it, or that it couldn't                                                                                                                                                                                                                                                     |
| `outreach.helpful.ok`                                 | `outreach.use`    | OK it for their computer to put up, as written or changed; an ask of kind post does it                                                                                                                                                                                                                                              |
| `outreach.helpful.skip`                               | `outreach.use`    | Put it aside: it isn't posted, and the day is free for another                                                                                                                                                                                                                                                                      |
| `outreach.helpful.posted`                             | `outreach.use`    | It's up (by the extension, or the person says so), with its link once known; or it couldn't go, with why                                                                                                                                                                                                                            |
| `outreach.helpful.engaged`                            | `outreach.use`    | Who commented on and reacted to one, as the extension read it: warm leads, nobody in Contacts                                                                                                                                                                                                                                       |
| `outreach.helpful`                                    | `outreach.use`    | Today's helpful post, those up in the last fortnight with who engaged, and the person's posting choice                                                                                                                                                                                                                              |
| `outreach.helpful.next`                               | `outreach.use`    | For their computer: the one to put up (OK'd, or on its own), and those up lately to read                                                                                                                                                                                                                                            |
| `outreach.today`                                      | `outreach.use`    | The person's list for today, and today's steps against the daily limits                                                                                                                                                                                                                                                             |
| `outreach.friends.tidy`                               | `outreach.use`    | Sent requests to cancel and friends to unfriend, with today's counts against their limits                                                                                                                                                                                                                                           |
| `outreach.friend.end`                                 | `outreach.use`    | The extension cancelled a request or unfriended someone for the person                                                                                                                                                                                                                                                              |
| `outreach.warning.note`                               | `outreach.use`    | Facebook warned the person: halves their limits for 7 days, friend requests off their list for 2                                                                                                                                                                                                                                    |
| `outreach.posts.save`                                 | `outreach.use`    | Up to 30 posts from a group's feed: keeps those worth a look for the AI, and says how each stands                                                                                                                                                                                                                                   |
| `outreach.post.check`                                 | the worker        | What the AI made of a kept post: good, not, or couldn't be read, with why; and whether it's strong (decision 49)                                                                                                                                                                                                                    |
| `outreach.post.skip`                                  | `outreach.use`    | The person put a post aside: off their list for good. Waits on a phone as long as it takes                                                                                                                                                                                                                                          |
| `outreach.replies.note`                               | `outreach.use`    | Up to 20 chats the extension saw whose last message is theirs: each answering the person's is a reply                                                                                                                                                                                                                               |
| `outreach.opener.use`                                 | `outreach.use`    | The person copied a first message: which opener it was drafted with                                                                                                                                                                                                                                                                 |
| `outreach.openers`                                    | `outreach.use`    | Which openers work, ever or in a week or month: sent, replies, demos; everyone's for owners, admins                                                                                                                                                                                                                                 |
| `outreach.demo.mark`                                  | `outreach.use`    | Someone the person reached booked a demo some other way, or not after all; by the profile kept here too                                                                                                                                                                                                                             |
| `outreach.demo.note`                                  | the worker        | A booking through someone's demo link, from core's `appointment.booked`: a demo, once a booking                                                                                                                                                                                                                                     |
| `outreach.automation`                                 | `outreach.use`    | Someone's settings for the extension, inside the business's rules; anyone's for owners and admins                                                                                                                                                                                                                                   |
| `outreach.automation.save`                            | `outreach.use`    | Save someone's settings; anyone's for owners and admins. A choice the business doesn't allow: `not_allowed`                                                                                                                                                                                                                         |
| `outreach.automation.people`                          | `outreach.manage` | Everyone who uses Social Outreach, with what each lets the extension do on its own                                                                                                                                                                                                                                                  |
| `outreach.warm_up.missed`                             | `outreach.use`    | The extension found no post of someone's to like: their friend request goes without                                                                                                                                                                                                                                                 |
| `outreach.send.queue`                                 | `outreach.use`    | A message the extension drafted: it waits for the person's OK, or goes as it is; a reply as Replies says                                                                                                                                                                                                                            |
| `outreach.send.approve`                               | `outreach.use`    | OK messages, changed or not; with none named, all waiting (Approve all) but those that wait one at a time (`oneByOne`). `partial` passes over any named that no longer wait, and those one at a time (the phone's Approve all). One of those named among others: `outreach_send_one_by_one`. Waits on a phone 30 minutes, then asks |
| `outreach.send.skip`                                  | `outreach.use`    | Skip a message: not sent, and off the list for today. Waits on a phone as long as it takes; never undoes a later OK: `outreach_send_okd_since`                                                                                                                                                                                      |
| `outreach.send.done`                                  | `outreach.use`    | The extension sent an OK'd message, or couldn't, and why                                                                                                                                                                                                                                                                            |
| `outreach.sends`                                      | `outreach.use`    | The person's messages waiting for their OK, and those OK'd, with their training wheels                                                                                                                                                                                                                                              |
| `outreach.wheels`                                     | `outreach.manage` | Who's on training wheels, and how far each has come                                                                                                                                                                                                                                                                                 |
| `outreach.wheels.end`                                 | `outreach.manage` | End someone's training wheels early                                                                                                                                                                                                                                                                                                 |
| `outreach.live.beat`                                  | `outreach.use`    | The extension's beat: this computer, what it's doing, new feed lines; answers whether it works, the day, and how many asks wait. Keeps no receipt                                                                                                                                                                                   |
| `outreach.day.start`, `outreach.day.stop`             | `outreach.use`    | Start my day or Stop for today, the person's own; an older press never undoes a newer one, and one from another day changes nothing. Start after a warning: `outreach_warned_today`; with nothing on its own: `outreach_sending_off`                                                                                                |
| `outreach.lists`, `outreach.lists.saved`              | `outreach.use`    | When the person's own friends list, requests got and sent, and groups were last saved, and the first group check, Tidy up and friend check after; the extension notes each (Lists first, decision 60)                                                                                                                               |
| `outreach.computer.rename`                            | `outreach.use`    | Rename one of the person's computers                                                                                                                                                                                                                                                                                                |
| `outreach.computer.remove`                            | `outreach.use`    | Remove the person's computers, one or every one standing by; never the one that works (`outreach_computer_working`)                                                                                                                                                                                                                 |
| `outreach.live`                                       | `outreach.use`    | The Live tab: the computer that works and what it says, the day, counts, what waits, the warning, today's feed                                                                                                                                                                                                                      |
| `outreach.live.team`                                  | `outreach.manage` | Each person's status, computer, counts and how many wait; never their lines or messages                                                                                                                                                                                                                                             |
| `outreach.waiting`                                    | `outreach.use`    | Waiting for you: replies handed over, messages to OK, steps it needs them for, requests to decide; asked by the worker too                                                                                                                                                                                                          |
| `outreach.need.note`                                  | `outreach.use`    | The extension couldn't do a step there and then: it waits for the person, unless they let the same go this week                                                                                                                                                                                                                     |
| `outreach.need.clear`                                 | `outreach.use`    | I did it, or Let it go. One the extension couldn't do again after the moment pressed stays                                                                                                                                                                                                                                          |
| `outreach.request.set_aside`                          | `outreach.use`    | Leave it: a friend request off Waiting for you until they ask again                                                                                                                                                                                                                                                                 |
| `outreach.ask.make`                                   | `outreach.use`    | Ask the person's computer to do something on Facebook; one like it open answers that one. No computer: `outreach_no_computer`; warned today: `outreach_warned_today`                                                                                                                                                                |
| `outreach.ask.take`                                   | `outreach.use`    | The working computer takes the oldest ask waiting; lets go of one waiting over a day, and ends as lost one it had under way before                                                                                                                                                                                                  |
| `outreach.ask.progress`                               | `outreach.use`    | How an ask is going; answers whether the person pressed Stop, and their answer to a step handed over. Keeps no receipt. Not taken yet: `outreach_ask_not_taken`                                                                                                                                                                     |
| `outreach.ask.end`                                    | `outreach.use`    | How an ask ended, with a look-up's drafts; waits in the extension with no connection                                                                                                                                                                                                                                                |
| `outreach.ask.reply`                                  | `outreach.use`    | Carry on or Skip, for a step handed to the person                                                                                                                                                                                                                                                                                   |
| `outreach.ask.cancel`                                 | `outreach.use`    | Stop an ask, waiting or under way                                                                                                                                                                                                                                                                                                   |
| `outreach.asks`                                       | `outreach.use`    | The person's own asks, today's and the open ones (a tab's kinds), with their working computer and whether Facebook warned them today                                                                                                                                                                                                |
| `outreach.setup`                                      | `outreach.use`    | The person's own setup: the main steps and each network's, where each stands and what's next, when they finished (`finishedAt`, the phone's line), the extension signed in, playbooks, the link                                                                                                                                     |
| `outreach.setup.save`                                 | `outreach.use`    | The setup started, done, left for later, its line hidden, or the extension signed in                                                                                                                                                                                                                                                |

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
   Amended by decision 43 (settings part 4): today's numbers are on the Live tab, and the panel says what it's doing.
8. **The extension notes what the person does on Facebook themselves:** Add friend, Like, Comment and Send, with the
   group they found the person in. It replaces "nothing is saved until the person presses a button" for those four
   steps. Built.
9. **Playbooks are asked, not filled in,** and have a conversation where each answer adds a tag and picks what's
   next. Built.
10. **Unfriending is a setting:** suggestions confirmed one by one (the default), or on its own within a daily limit
    in the build loaded by hand.
11. **Don't pitch stops everything:** friend requests, likes, comments and messages. Built: a step the extension
    notes to someone on the list isn't counted, and the Friends tab marks them. Since settings part 4 it's set on the Friends
    tab and Today's person menu, not on a profile in the panel.
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
    scrolls the group feeds itself, slowly, stopping on any warning. Built (the second of three parts). Since settings part 4
    the posts are sent as the person scrolls a group in the tab in front of them, panel open or not, and **Find
    posts** is asked from the Groups tab.
19. **Posts asking for help** are found by the playbook's signs, with the AI checking each one. Built.
20. **A good post goes on Today's list** with two AI comment drafts. The person posts the comment; the extension
    notes it. Built.
21. **Before drafting, the extension looks the person up:** it opens their profile and business page itself, quietly
    in a tab. A page their profile links to counts as their business only when the line naming it says they own or
    founded it ("Owner at…"); otherwise it's told to the AI as where they work, a job. Built.
22. **Phone alerts:** a push when the extension spots a reply, and a morning push at a time that's a setting (8am to
    start). Built (the third of three parts). The morning push counts every network the person works, as Today's
    strip shows them: one network in its own words, more than one named ("on Facebook and Alignable").
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
    (c) **Approve all** each morning. Choosing (b) starts training wheels. Built: off and the steps of (a) in automation part 1;
    messages in automation part 3 (`packages/core/src/addons/outreach/sends.ts`). With any choice but off, the extension looks
    each person up and drafts their first message, follow-up or reply with the AI, which waits as "I'd send this" in
    the panel (replaced by decision 72: in HandsFreeOS only) and on Today: **Send** (changed or not), **Skip** (off
    the list for today), or **Approve all**. With
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
    their own. Automation part 5.
30. **Friend requests from people who fit a playbook are confirmed on their own;** the rest wait. Built: those who
    fit well.
31. **It asks to join good groups, up to 3 a day,** and the AI answers the join questions from the playbook. Automation part 5.
32. **Find posts, Read my chats, saving group members and checking friend requests run once a day on their own.**
    Built: first thing in the working day (or after Start my day), before the list, while the extension works on its
    own and **Once a day** is ticked (on to start).
33. **A like on one of their recent posts a day or two before the friend request.** Built: the request waits 20
    hours after the like; a like over 14 days old doesn't count; no post to like, no wait. The post is picked by the
    AI from their latest few, business first, then personal, never a sensitive one ("Which post gets the like").
34. **All the features:** results by group, team sharing, an after-demo workflow, birthday and new-job notes, more
    templates, LinkedIn then Instagram, and a weekly report. Automation parts 2, 6 and 7. Built (automation part 2): **results by group**,
    everyone reached counted under the group they were found in, with who wrote back (in a saved chat, a chat read,
    or a reply the extension saw) and who booked a demo, on the Activity tab and, ever, on the Groups tab, where the
    groups that bring demos, then replies, come first; the extension gives them 3 of the 5 groups it works a run and
    tries others with the rest, and Today puts people from them ahead of others who fit as well. The **weekly
    report**: on Monday at the morning push's hour (8 when that's off), each person who used the extension that week
    gets an email of their friend requests, chats started, replies and demos, their best group and their best
    opener; an owner or admin with a team gets the team's too. It's on to start: Social Outreach → Settings → General (For your team) turns it
    off, and Settings → Account turns off all add-on emails (`packages/core/src/addons/outreach/results.ts`,
    `apps/worker/src/addons/outreach/weekly.ts`).
35. **Automation and features are built side by side,** one PR at a time.
36. **Social Outreach gets an onboarding** like the main app's. Built in HandsFreeOS (decision 45).

**Training wheels** (proposed with the plan; the owner can change it): when someone picks a fully automatic choice
(26b, 27b or 27c), for the first 7 days and until they've OK'd 25 messages, everything it wants to send comes to them
first as "I'd send this", and their daily limits are half. More than 1 edit in 3 of the last 10 keeps it on longer;
owners and admins can end it early; a Facebook warning puts it back on for 7 days. Built (automation part 3, for 26b): choosing
it starts them once (`automation.wheels_from`); each message OK'd counts toward the 25, and whether it was changed
first toward the last 10 (`wheels_ok`, `wheels_edits`); earned, they're off for good (`wheels_done_at`). Owners and
admins see who's on them under Today and can **End now**. They matter only while Sending is (b), or Replies (b) or
(c) with Sending on; automation part 3b added replies.

The order: (1) the runner; (2) results by group and the weekly report; (3) messages and replies on their own; (4)
onboarding, built in HandsFreeOS as the setup (decision 45, settings part 6); (5) tidying on its own and joining
groups; (6) team sharing, after-demo workflow, birthday notes, templates; (7) LinkedIn, then Instagram. (1) to (4) are
built.

From the plan, not contested: it reads only pages the person opens; group admins and moderators are never approached
(as customers: decision 81 lets a partner playbook ask them to partner, each message with the person's OK);
"Not interested" ends outreach for good; drafts mention only what's really on someone's profile or posts; and the
starting daily limits per Facebook account are 20 friend requests, 15 first messages, 20 follow-ups, 15 comments, 40
likes and 1 post, half that for new or quiet accounts.

The owner asked on 10 Oct 2026 for every setting to live in HandsFreeOS, with the extension only doing the work,
showing what's going on and prompting, the app and the phone live too, and answered the questions the same day
(`questions-10-oct-settings.md` in the project's files). These are settled too:

37. **Every setting lives in HandsFreeOS,** on Social Outreach's **Settings** tab: **My settings** and **Business
    settings** (updated by decision 73: a page for General, one for each network, Your computer and Start fresh). The
    extension keeps none of its own: it loads them when the person signs in and follows a change within seconds while
    Chrome is open. Built (settings part 1).
38. **Each person picks their own, inside the business's rules:** the choices owners and admins allow, their daily
    limits (at most the starting ones), and the defaults a new person starts with. A choice the business stops
    allowing steps back to the nearest one it allows. Built.
39. **Owners and admins see and change anyone's settings;** the person sees "Changed by". The extension's panel shows
    a short read-only summary with **Change in HandsFreeOS**. Built.
40. **How the phone hears about messages waiting is a setting:** one push for what's waiting, at most every 2 hours in
    working hours (the default), or one for each. A reply handed over always pushes at once. The choice is kept from
    settings part 1. Built (settings part 3): the bundled push gathers for 10 minutes after the first new message or step, goes at most
    every 2 hours and only in the person's working hours, and only when something is new since the last ("5 messages
    wait for your OK"); one for each pushes each message and step at once. Friend requests aren't pushed: Facebook
    tells people of those itself.
41. **Live status and control in the app:** **Start my day** and **Stop for today** on the web and the phone; only
    the person's most recently active computer works; the app says when it's offline and when it was last seen;
    what it's doing, the next step, today's counts, what waits and warnings, with a feed of today's steps; a Facebook
    warning pushes to the phone; owners and admins see each person's status, counts and how many wait, never their
    messages. Built (settings part 2): a **Live** tab, second after Activity; a beat every minute, offline after 3 minutes
    without one; one warning push a day; the day kept in HandsFreeOS, the newer press winning. Built on the phone too
    (settings part 5), on the same operations.
42. **One Waiting for you list,** the same in the extension, the web and the phone: messages to OK, replies handed
    over, friend requests that didn't fit, and what it needs the person for. On the phone: change, OK, skip and
    Approve all. On the computer: a number on the extension's icon and a Chrome pop-up. Built (settings part 3) for the web (a
    **Waiting for you** tab, third, with its count on the label) and the extension (the list in its panel, after
    **Right now** since settings part 4, the number on its icon, and pop-ups bundled as the phone's pushes are); "what it needs the person for" is a step the
    extension couldn't do there and then. Built on the phone too (settings part 5), on the same operations, its messages kept
    on the phone. The owner confirmed (10 October) that **Approve all** leaves out replies handed over and messages to
    someone who needs the person: each waits for an OK of its own. The list in the extension's panel is replaced by
    decision 72: the list is on the web and the phone only, and the extension keeps the number on its icon, the
    pop-ups (which open it in HandsFreeOS) and a line in its panel saying how many things wait there.
43. **The extension goes bare bones:** signing in, what it's doing, Waiting for you, Start and Stop. Anything else is
    in the app; what needs the browser is started there and done by the extension. More can be added later. Built
    (settings part 4): the panel keeps signing in with the business picker, **Right now** (what it's doing, the next step, why
    it isn't working when it isn't, a warning, a warning past a daily limit, the settings in a line with **Change in HandsFreeOS**, **Start my day**
    and **Stop for today**, and an ask under way with **Carry on**, **Skip** and **Stop**), **Waiting for you**, and
    **Open HandsFreeOS**; the page outline stays, folded away in its footer. The rest is asked from the app's Friends,
    Groups, Chats and Today tabs (`asks`, **Asking the extension** above), and the phone's Groups and Chats screens
    (settings part 5), and reading as the person goes moved into the Facebook tab itself. Waiting for you in the panel,
    and Carry on and Skip on the ask under way, are replaced by decision 72: the ask keeps only **Stop**, and a step
    handed over says to press Carry on in HandsFreeOS → Needs you.
44. **The whole add-on on the phone,** as one item under More: settings, Waiting for you (which works offline and
    sends when back online), the live view, Today, Groups, Chats, and Playbooks with editing. Built (settings part 5):
    Waiting for you's messages reach phones through records_v1's sealed arm, as rows of `addon_phone_rows` kept to
    their person (`private.addon_phone_own_table`, 20261027001800), with no change to `apps/sync/sync-config.yaml`
    and no copy made again; OK and change wait on the phone 30 minutes before "Still send?", a skip and Start and
    Stop as long as it takes; Activity and Friends open on the web; everything else asks HandsFreeOS, with signal.
    The Groups and Chats screens ask the computer as the web's tabs do (decision 43), with signal.
45. **The onboarding lives in HandsFreeOS** (decision 36), after these: pick playbooks, settings, then "Install the
    extension and sign in", then groups; the phone points to the computer. A first-timer signing in on the extension
    is sent there (21a). Built (settings part 6); the phone's Social Outreach screen says to set it up on a computer
    until it's done (`SETUP_WORDS.onPhone`). Decision 83 put its steps in a new order: a main setup, then one for each
    network.

The owner asked on 11 Oct 2026 for Social Outreach to work the whole way people sell in Facebook groups: find the
fits among the friends and chats they already have, start with the groups they're in and join more when those run
dry, answer posts asking for what they offer quickly, write helpful posts and follow up with the people who engage
with them, and know when someone is ready for the pitch. They answered the questions the same day ("build all of it").
These are settled too:

46. **Find the fits among the person's friends and chats.** The extension opens each friend's profile, and the
    business page it links to, at a person's pace, about 40 a day; the AI reads what they say with the person's chat
    with them, when there is one, and says whether they fit a playbook, why, what they do and a first step. Those who
    fit well and haven't heard from the person in a month go on Today as **Reconnect**, with drafts. Friends with a
    chat go first, then friends from the groups, then the rest. It runs with the once-a-day jobs, and from the
    Friends tab's **Check my friends**. Growth part 1. Built.
    - **46a. Research one person from their row.** The owner asked for a **Research** button on person rows (friends,
      requests received and sent, the pipeline) for anyone not checked yet: it checks that person next, ahead of the
      daily order, reading their profile, posts and business page for the AI. The owner decided it **counts toward
      the same daily check limit**; when the day's checks are used up it says so and they go first tomorrow. Never
      offered for someone on Don't pitch or tagged Friend or family, since they're never checked. Built.
47. **Stages, and the moment to pitch.** Each person reached has a stage, worked out from what HandsFreeOS knows:
    found, warming up, friends, talking, ready to pitch, pitched, booked, or not a fit. The AI's read of a chat says
    when the playbook's questions are answered well enough to pitch; Today then offers **Pitch**, with drafts that
    carry the demo link. Growth part 2. Built: a Pipeline tab on the web and the phone, Pitch on Today, and "Not
    interested ends outreach for good" with Back in play.
48. **Groups: theirs first, then new ones.** The AI checks the groups the person is in, from their About page and
    recent posts, for whether the playbook's people are there and post. Today works the groups they're in first. When
    the groups that fit have fewer people left to reach than a week of friend requests, or the person presses **Find
    more groups**, the extension finds groups and asks to join up to 3 a day, and the AI answers the join questions
    from the playbook on its own (decision 31). Growth part 3. Built: **Check my groups** and the once-a-day check,
    people left to reach on the Groups tab, **Find and join more groups**, **Ask to join**, and the join setting, on
    to start.
49. **Posts asking for what the business offers, fast.** In the person's working hours, the extension looks at the
    top of their best groups every hour or two; a post the AI calls a strong fit pushes to their phone at once and
    goes to the top of Today. Growth part 4. Built: the look at the newest posts while the extension works on its
    own, strong posts with a push when they're fresh, first on Today, and the setting, on to start.
50. **Helpful posts in the groups, and the people who engage.** The AI drafts posts that help, from the playbook and
    what people in each group ask about, after reading the group's rules: at most 1 a day (the plan's starting
    limit), and never the same group twice in a week. Who posts it is a setting, per person, inside the business's
    rules: the extension after the person's OK (the default), the person copying it, or the extension on its own.
    Whoever reacts to or comments on one of the person's posts is a warm lead: Today has them to answer, like back and
    friend. Growth part 5. Built: the AI's post on Today on the web and the phone, the three ways to put it up, the
    business allowing them (copying always), and who engaged read once a day for a fortnight.

The order: (1) the fits among friends and chats; (2) stages and the pitch; (3) groups, theirs and new; (4) fast posts;
(5) helpful posts and warm leads. Each is a part of its own, as decision 35 says.

After trying it, the owner sent notes on 11 Oct 2026. Built as below; where a note left a choice open (the voice's
defaults, a few texts on to start), the choice made is said, for the owner to change:

51. **Friends on Don't pitch never show in the Pipeline.** Some still did: Facebook shows one person by number in one
    place and by username in another, so the same friend was kept twice, and only one was on the list. Don't pitch now
    covers a profile kept under the same name on the same network. Built.
52. **See the chat so far when a message waits for an OK,** to know where it's going: its latest messages as chat
    bubbles above it, on Today and Waiting for you on the web, the phone and the extension's panel. Built. The
    extension's panel is replaced by decision 72: no message waits there, so it shows no chat bubbles.
53. **The AI writes plainly:** everyday words a 10-year-old knows, short sentences, relaxed, and never a long dash.
    Each person picks their voice on the Settings tab (and in Facebook's setup, under More choices), with a sample of how a
    message reads: short forms like "u" and "thx", text acronyms like "lol" and "btw", an emoji now and then, all off
    to start. Built.
54. **A greeting after a gap.** When the last message either way was a few days ago or more, the AI opens with a
    greeting that fits ("it's been a while"), as its own text when the person sends a few, and a sorry for the slow
    reply when they wrote last. Built.
55. **A message as a few short texts,** a few seconds apart, the way people text: a greeting, then the point. A
    setting, on to start. Built.
56. **Start fresh.** An owner can erase everything in Social Outreach for the business and start again with its
    setup, on the Settings tab after typing its name: everyone's profiles, friends, chats, groups, playbooks, settings,
    messages waiting and steps noted. Customers in Contacts stay. The rule that nobody deletes a profile, chat or
    playbook stands: they go only with all of the add-on's data, as before. Built, in core for every add-on.
57. **An onboarding like the main app's.** The setup is a page of its own over the app, in the main onboarding's
    frame, with a welcome first that says what's ahead, Finish later at the top, and "carry on where you left off".
    Built; its steps are decision 83's.
58. **Check my groups did nothing.** The computer's extension was a build from before checking groups, which left
    the ask hanging. Each kind of ask now names the build it needs: an older one says to update, with how. Built; the
    extension is 0.25.0.

The owner asked on 12 Oct 2026 for a better design of the add-on and the extension, saw it drawn in the HandsFreeOS
design system ("Social Outreach redesign", a Design canvas), and said to build all of it. That changes where decisions
41 to 44 put things; what they decided stands. Settled too:

59. **Four tabs and the gear, and the panel in HandsFreeOS's look.** Ten tabs were too many, Waiting for you and Today
    said the same, and every tab carried notes and the same orange line about the computer.
    - **Today** opens first (the bare page; `?view=waiting` too): a strip with the computer's state, what it's doing,
      the next step, today's steps against the limits as bars, **Start my day** or **Stop for today**, and
      **Details** for the full day (`?view=live`: the feed, what was asked of it, the team and renaming computers);
      then **Needs you** (decision 42's list, its count on the tab); then the list for today, without a message
      Needs you shows already; **Done today** beside them; an empty list is three next steps with a button each; and
      **How Social Outreach works**, folded away, in place of the notes beside each tab. A drafted message shows as
      the texts it would send, with **Send**, **Edit** and **Skip**.
    - **People**: the Pipeline, a board of Friends, Talking, Ready to pitch, Pitched and Booked for everyone in play
      (found and warming up counted above it), one stage or a search a list; moving someone to another stage is in
      their menu; and Friends and Chats beside it.
    - **Groups**, as it was; why its buttons wait is said once under the tabs, as on People.
    - **Results** (`?view=results`, the old `?view=activity`): the three numbers to watch every day against the
      person's targets, the two rates, the week's review, and the numbers by playbook and offer version (decision
      70); then demos booked, reached, chats started, wrote back and booked, each with how many of the step before
      made it, what was done along the way, by group and by person. The day against the limits moved to Today's strip.
    - **Settings**, the gear: a menu of My settings, Business settings, Playbooks, Your computer and Start fresh;
      where a new person starts is folded to a line until changed. The menu is updated by decision 73: General, each
      network, then Playbooks, Your computer and Start fresh, a page for each; where a new person starts stays
      folded, on General.
    - **On the phone** the same four tabs at the top of one screen, with the gear for Settings (Playbooks and the
      computer in it): Today with the strip, Needs you (offline as before) and the list; People with the Pipeline
      and Chats, Friends on the web; Groups; and Results, the three numbers and the week's review (decision 70), a
      summary with the posts liked and commented on (the
      person's own; a tap opens the post on Facebook), person by person and the team's posts on the web.
    - **The panel** (0.26.0): the business and a state chip in the top bar; the first run's three steps over signing
      in; **Next up** with today's steps as bars and Start or Stop; **Needs you**; **Done today**, the newest steps
      (both from `outreach.live`); and at the foot the settings line, who's signed in, Open HandsFreeOS and
      **Something look wrong on this page? Tell us**. Pushes and pop-ups say Today where they said Waiting for you.
      The panel's **Needs you** is replaced by decision 72: a line under Next up says how many things need the
      person in HandsFreeOS, with a link to Needs you there.

    Built.

60. **Lists first, the first day only.** Before someone can start their day, the system first finishes saving their
    friends list and their friend requests, sent and received; once that's done, the day starts. The first time,
    Start my day waits until all three are saved. After that, the requests are refreshed each morning before the day
    starts, and the friends list once a week. Right after the first full save, it works out the friends to unfriend
    (Tidy up, decisions 10, 12 and 17) and then the good fits among friends (decision 46), once. Built. **Groups
    too:** before the first day it also saves the person's groups, then checks them (decision 48), and the day waits
    for both; a failure is tried again as the lists are. After that the groups are saved again weekly and checked by
    the daily group checks, without holding the day up. While all this runs, the person sees a live checklist of the
    steps (Save your friends list, Save friend requests you got, Save friend requests you sent, Save your groups,
    Check your groups, Work out who to unfriend, Check your friends for good fits), the one under way with its
    progress and each ticked when done, on the web where Start my day is, on the phone's live view and in the
    extension's panel. Built.
61. **Only certain countries, or not them.** A business can reach anyone (to start), only people in the countries
    it picks, or everyone but them. Where someone lives is what their profile shows; when it shows none, the AI
    guesses from their name, posts and groups (the owner's decision), and both are kept, with whether it was seen or
    guessed. Everyone the setting skips is on a list with their country, and **Unskip** lets that person through from
    then on, whatever the setting says. Built: the setting, the countries from checks and the worker's guesses, the
    filter on Today, the good fits and people left to reach, and the Skipped for country list on the Friends tab.
    Not yet on the phone's Business settings, which keeps the setting as saved.

From the main offer's plan (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Chris, 2026-10-14):

62. **A playbook narrows the main offer.** The business has one main offer, in core (docs/main-offer.md); each
    playbook picks one niche inside its who, with that niche's biggest problem and its own proof, picked from the
    offer's or its own and never invented. The AI says when a niche looks like a second offer. A playbook's offer
    starts as the main offer's outcome in a few words, and it keeps something useful to send someone who never
    answered. Built (data version 3). The new pace came with the plan's step 6 (decision 67), and the short video's
    link and script with step 7 (decision 69).
63. **Get ready for your best results, and it blocks** (the owner's decision: present it as getting the best
    results). Nothing outreach-like happens for a person until four things are done: the business's main offer is
    live, a playbook in use has its niche and the niche's problem (and proof when the main offer has any), every item
    on the person's Facebook profile list is right since the live version (by the AI's check, decision 64, or their
    own tick), and they've set a monthly goal for
    calls booked and seen what it takes each day. Until then Start my day is refused (`outreach_not_ready`, naming the
    first thing left and where), Today's list keeps only replies owed to people who wrote first, the extension puts up
    no helpful post on its own, and Today, the phone's Today and the extension's panel show **Get ready** in place of
    the rest. What only reads goes on (decision 60's lists, groups and checks, asks, Read my chats, Find posts), and
    joining groups. A member waits on the business's two and does their own meanwhile. A new main offer version asks
    everyone to look at their profile again, saying what changed. It's worked out each time (`outreach.readiness`,
    `readiness.ts`), never kept as a flag; the person's ticks and goal are on their setup row, and the goal's working
    days in their settings. Its items are setup steps of their own (decision 83): the main offer, the playbook, your
    messages and your goal in the main setup, and your profile in each network's. Built. **Your messages** joined
    with the plan's step 6 (decision 68), so it's five items; it doesn't wait on a short video (decision 83).
64. **Your profile, read by the extension and checked by the AI.** From Get ready, **Read my profile** asks the
    person's computer (`profile_read`, extension 0.32.0): it opens their own profile in a window of its own, checks
    it's theirs, and reads the picture's and the cover's descriptions, the short bio, the intro's lines, what's
    featured and the latest posts. The worker's AI (`outreach.profile.check`) checks them against the live main offer,
    item by item, and writes three bios (Facebook's short bio, up to 101 characters), a line for the cover and what to
    feature. Only its answer is kept, on the person's setup row; what the page said goes no further (but the parts
    shown side by side, from decision 84: the name, username, line, links and address). An item it says
    is right counts as done, and the person ticks the rest once they've changed them. **Put this one in**
    (`profile_edit`) has their computer press Edit bio, put the bio in, save, and read the profile again for a new
    check; where it can't, it hands the step to them (**Carry on**). The picture, the cover and what's featured stay
    tips: the extension never changes them. A check of an older main offer version counts for nothing, as old ticks
    don't. Built on the web, the phone and the extension; tuned from page outlines, not yet tried on a real account.
65. **Warm up, then ask straight out** (the owner's decisions: direct after they accept; warm up with likes and
    comments first). Before a friend request the extension likes one of their posts, and when the post is about their
    work it leaves a short comment too, counted against the comments' limit (extension 0.33.0). Once they accept,
    the **First message** asks straight out whether they'd be open to the main offer's outcome on its guarantee, and
    says more info follows if so. A personal line goes first only when the look-up found something real that fits.
    The business's own openers can say `{outcome}` and `{guarantee}`, filled from the offer's words in a few words.
    This replaces decision 47's moment to pitch for new friends; its read (`pitch`) stays for chats that started
    another way (Reconnect, the download file, people who wrote first). Built.
66. **The video, then the link.** The AI reads each answer to a step while drafting the reply to it: yes, a
    question, not now or no (`answerOf`; the worker keeps it with `outreach.answer.note`). A reply's sighting carries
    no words, so the extension reads the chat before drafting (`bringInChat`). A yes moves them on: to **Send the
    video** (the playbook's short video with a line selling the call), or with no video yet straight to **Send the
    link** (the demo link, decision 24), and after the video to the link. The draft comes back as that step, and the
    extension queues it so. A question gets a short answer and why a call helps; not now, a check-in a month on; a no
    ends it and marks them not a fit, unless the person marked them themselves. On Today, the web copies the link or
    the video's link alone too. The playbook's video link is written in the plan's step 7; until then a yes gets the
    link. Built.
67. **Follow-ups until they answer, then once a month.** Whoever goes quiet after a step gets 5 to 7 follow-ups (6 to
    start), each so many quiet days after the last message (1, 1, 1, 2, 2, 2 to start: the playbook's pace, data
    version 4), then a **check-in** each month with the playbook's something useful to send. It goes on until they
    answer, say no or are marked not a fit, or the person presses **Stop checking in** (`outreach.conversation.stop`);
    sending them the next step, or answering them, goes on again. No longer only for chats read as a prospect. Each
    person's conversation with each profile is a `follow_ups` row: the step, the follow-ups sent, what's next and
    when, and their answer. A draft copied on Today to send by hand is noted as sent (`outreach.conversation.note`;
    the link marks them pitched); a message the person types themselves puts the next follow-up off about a day. Today
    lists replies, Send the link, Send the video, first messages, follow-ups and check-ins in that order, each
    follow-up saying which of how many it is; the link, the video, follow-ups and check-ins share the follow-ups'
    daily limit. Built on the web, the phone and the extension.
68. **A yes counts, by the offer's version.** A yes is kept as a positive reply, once (`stages.positive_at`).
    Everyone pitched keeps the main offer's version of their first step, and what follows uses its words
    (`follow_ups.offer_version`, `sends.offer_version`). The main offer's page shows how the live version is doing
    (`outreach.offer.versions`, in core's `main_offer.panels` slot): first messages, yeses and calls booked, too new to
    judge before 100 first messages; owners and admins see everyone's, anyone else their own. Get ready's **Your
    messages** shows sample messages the AI writes for the person's playbook in their voice, to someone made up (the
    worker's `outreach.messages.samples`): the first messages, the video, the link, the follow-ups with their days, and
    a check-in. They OK how they read against the live version (`outreach.readiness.messages`), and a new version
    asks again. The phone shows the samples written on the computer and OKs them. Built.
69. **The short video, scripted by the AI** (the owner's decisions: the AI writes the script; one video per
    playbook, each person's own later). On the playbook, under **Short video**, the AI writes the script from the
    live main offer and the playbook's niche (the worker's `outreach.video.script`, `video.ts`): six parts, each with
    what to say and what to show (who it's for and the problem, what it costs them, how it works, proof, why a call
    helps, what to do next), 2 to 4 minutes spoken. **Improve** writes one part again, **Write it again** the whole
    script, and the business changes the words as it likes. Proof comes only from the real results given; with none,
    the script leaves "[your result]" to fill in. Recording tips sit beside it, and the person records it themselves
    and pastes its link (Loom, YouTube or Google Drive: https, with a real host). The playbook keeps both (data
    version 5); a script written for an older main offer version says so. An owner or admin links it. The video is
    optional (decision 83): **Your messages** doesn't wait on it, and the setup's video step has **We don’t use
    one**, kept as the business's choice (`noVideo`). The phone shows
    the script and changes the link; the script is written on the web. Built.
70. **The daily numbers** (the main offer plan's step 8; `tracking.ts`, the boards in `design/tracking`; the owner's
    decision: the day's report is on to start). Results leads with the three numbers the video says to watch every
    day: first messages sent, said yes (`stages.positive_at`) and calls booked (`demos`, not taken back), for today,
    the last 7 days or the last 30 (`outreach.tracking`). Each has the person's target from their goal on Get ready's
    Your numbers (`targetFor`: the first messages the goal takes at the worst rate, never past Facebook's safe pace,
    and the yeses and calls it takes), and the two rates between them stand against the usual ones (4 to 8% say yes,
    1 in 3 of them book), "too few to tell yet" under 25 first messages or 3 yeses. Below them, by playbook (the one a
    first message's opener came from, `opener_uses`) and by the main offer's version each person was first pitched
    with (`follow_ups`). Someone counts as messaged from their first chat started or first pitch, whichever came
    first. Owners and admins see everyone's counts, with no targets and no review: each person's answers and
    conversations are their own, so every count comes through `private.outreach_numbers_by_network`, counts only, and the main
    offer page's numbers by version now count the team's yeses too. **The day's report**: at the end of the person's
    working hours on a day they sent something, a push with the day's numbers and how far from the target ("Today:
    14 messages, 2 said yes, 1 booked. 1 more message hits your target."), on their add-ons switch, off in My
    settings (`dayReport`; a screen from before it keeps the one kept). One job a person (`outreach.day_report`),
    armed when they start their day or save their settings and by the morning push, back each working day while they
    note steps. **The week's review**: on Monday at the morning push's hour, for each person who noted a step in the
    last two weeks, the AI reads last week's numbers (Monday to Sunday) and says what to fix first, in the video's
    order (`fixFirst`): too few messages (volume), then fewer than 4% saying yes (the message or the offer), then
    fewer than 1 in 3 booking (the video and the follow-ups), else keep going. Counted against the AI limit; when the
    AI can't write it (the day's limit, the wallet, an answer it can't use), the numbers' own words (`rulesReview`).
    Kept for Results (`addon_outreach.reviews`, each person's own) and pushed, once. **A new main offer**
    (`main_offer.published`) pushes to whoever OK'd their messages against an older version, as Get ready asks them to
    look again. The phone shows the numbers, the review and the breakdowns on Results, and the switch in its settings.
    Built.

The owner asked on 12 Oct 2026 for the extension's zip to be in HandsFreeOS for people to download, with the steps to
install it in Chrome with Developer mode. That replaces "kept wherever the team keeps files, never in HandsFreeOS's
code" (decision 45's install step). Settled too:

71. **HandsFreeOS hands out the extension.** The web app serves the build its own code makes
    (`/downloads/hfos-social.zip`): every deploy zips the extension as it builds, so nobody releases or uploads
    anything by hand, and a deploy always hands out the extension its code has. The setup's install step
    and Settings → Your computer have **Download HandsFreeOS Social** with its version and size, and the steps:
    unzip it to a folder you keep, turn on Developer mode at chrome://extensions, Load unpacked, pin it, sign in on
    Facebook; Chrome's note about developer mode, and how to update. Today's strip links there while no computer has
    signed in. A business's own link (**Where your team gets the extension**) still wins when it gives one. Built.

The owner decided on 16 Oct 2026: "Get rid of the Needs you and chats on the extension. We should only see progress,
activity, stuff like that on the extension. Everything else is shown in the HFOS web app." That replaces the parts of
decisions 42, 43, 52 and 59 that put Needs you, with its chat bubbles, in the extension's panel. Settled too:

72. **The extension shows progress and activity only** (Chris, 16 Oct 2026). The panel keeps signing in, Next up
    (what it's doing or does next, today's steps against the limits, **Start my day** and **Stop for today**), each
    network's line (**Allow on LinkedIn**, its warnings, its runner's line), **Done today**, the settings line, the
    link to HandsFreeOS, and **Copy page outline** and **Save page outline**. Needs you is on the web and the phone
    alone: no message to OK, chat so far, reply, step to do or friend request is listed or answered in the panel.
    - **A line under Next up** while anything waits: "3 things need you in HandsFreeOS" ("1 thing needs you…" for
      one), a link to Needs you on Today (`outreachPath(…, 'waiting')`, at `#needs-you`); nothing when none wait. Its
      count is the icon's, from `outreach.waiting`.
    - **An ask under way** keeps its line and **Stop**. A step it hands the person says what to do, then to press
      Carry on (and Skip, for someone ticked) in HandsFreeOS → Needs you, with a link there; Carry on and Skip are
      pressed on the web or the phone (`outreach.ask.reply`), and the extension hears the answer on the live channel
      or with its next look.
    - **The icon's number and Chrome's pop-ups stay.** A click on a pop-up, or its button, opens Needs you in
      HandsFreeOS in a tab, never the side panel.

    Built in 0.44.0; the extension is 0.63.0 now.

The owner asked on 16 Oct 2026 to "separate the settings per platform: a settings menu with general settings and then
all the platforms, and each one has the settings related to that platform", saw it drawn in the HandsFreeOS design
system ("Social Outreach settings by platform", a Design canvas), and said to build it like the design. That updates
where decisions 37 and 59 put the settings; what they decided stands. Settled too:

73. **Settings, a page for each part** (Chris, 16 Oct 2026). The Settings tab is a menu beside one page at a time
    (`?view=settings&part=`, core's `settings-parts.ts`, the web's `settings-page.tsx`):
    - **The menu:** Settings with **General**; Networks with each network the add-on works, saying **On** or **Off**
      for the person shown, then the networks still to come (Instagram, Alignable, Threads, X and TikTok) as
      **Soon**, which don't open; and More with **Playbooks**, **Your computer** (the person's own) and **Start
      fresh** (an owner's). In a phone's browser it's a list to pick from, above the page. Owners and admins keep
      **Settings for** above every page, and a part keeps whose settings they're looking at. An address naming no
      part, or the old `#mine` and `#business`, opens General.
    - **General** is the person's own on every network: how the AI writes for them, their working hours, and how their
      phone and the extension tell them what waits, with the day's report; **Set up again**; and **Changed by**. For
      owners and admins, **For your team**: the choices people may pick, where a new person starts (folded), where
      the team gets the extension, who from chats goes in Contacts, when friend requests are suggested for
      cancelling, the morning push, the weekly report and the countries it reaches. Who goes in Contacts and when to
      cancel are one setting each for the whole business, on every network, so they're on General, not on Facebook's
      page as the design drew them. Anyone else sees who sets the choices they may pick.
    - **Each network's page**, in that network's words: **On for you** beside its name, which saves at once with its
      line beside it (Chris, 2026-10-16). A network the business doesn't use says so and who can allow it; one that's
      off says so. While it's on: the first time's **Allow** in Chrome (every network but Facebook), its training
      wheels, what it does on its own, replies and helpful posts, along the way, on Facebook the extension's three
      switches, and **Your daily limits on** it, read only: the business's own there, halved while its training
      wheels are on, with its cap in any 7 days and the kit's other limits (`limitsShownOn`). For owners and admins,
      **For your team on** it: **Your team may use** it (Facebook is always allowed), and its daily limits for each
      person, at most its starting ones.
    - **Every change saves as it's made** (the web's `use-autosave.ts`): no Save button, but the extension's link
      box's own. A click saves at once, and typing after a short pause or on leaving the field; one save at a time
      for each form, with a change made meanwhile in the next. The line under the page's title says changes save as
      they're made, Saving…, Saved, or the server's words when one is refused, and the form goes back to what's kept.
      A change saved elsewhere starts the form again only while nothing of its own waits or saves. The person's
      settings go through `outreach.automation.save` and the business's through `addon.save_settings`, as before.
    - A choice that starts training wheels starts them as soon as it's picked, so it says so before it's picked.

    Built on the web and the phone. The phone has the same menu and parts, each part a screen pushed over the menu
    (`?part=` in its address), and no Start fresh. The setup keeps its own Save and Next buttons.

74. **The extension says what it saw** (Chris, 16 Oct 2026: "build all three"). Testing LinkedIn took a round trip
    for every miss: the person tried, said what went wrong, pasted an outline, and waited for a fix. Now the person's
    computer reports for itself (the extension's `src/jobs/report.ts`, extension 0.48.0; core's problem reports since
    0.49.0, decision 75):
    - **A note of each page a job read** (`outreach.report.save`, table `reports`): the page's kind and its address
      as the outline masks it ({1}, {2}… for people's and groups' parts), whether Chrome showed the page (it draws
      nothing in a window hidden behind another), what the readers found (counts, yes or no, and the network's own
      section names from the outline's headings; never words), a line on what was missing, and the page's outline
      when something was: everything a person wrote is "[2 words]", as in the panel's own outline. Noted: every read
      of the person's own profile; a step handed to the person; an ask that didn't finish; a step of the day
      that didn't go, on any network; and every page of Check LinkedIn. Each person's own (restrictive policy, as `asks`); an ask's
      notes go with it, and the day's steps' after a week (`outreach.live_prune`). Never for the file kinds, whose
      pages are Facebook's own download and password ones.
    - **Check LinkedIn** (`checkup`, on LinkedIn's page in Settings, the person's own): one press opens their profile,
      feed, connections, a people search, a posts search, their messages and one connection's profile, reads each
      without pressing anything, and notes each with its outline. Its window is in front for about a minute, then
      theirs comes back. It stops on any LinkedIn warning. From 0.52.0 it also tries each step (decision 76).
    - **What's blocking, on screen**: the extension says with its beat which networks Chrome lets it on
      (`computers.allowed`). An ask on a network it isn't allowed on waits, and says what to press (Allow on the
      network in the extension's panel, then Allow in Chrome's box); so does that network's page in Settings.

75. **The notes are problem reports on HandsFreeOS's support desk** (Chris, 16 Oct 2026: "it should work for the
    entire extension, all the platforms, future ones included… maybe they also go to the HFOS admin area, so that if I
    wanted to get something done before the morning it can be addressed when I want"; he chose to build it in core).
    From extension 0.49.0 the notes of decision 74 are core's **problem reports** (`app.problem_reports`, migration
    20261027008100), sent with `problem_report.send` with the add-on's id as a label, `extension` as the source and
    the network as the area, so any network the extension works on, and any other add-on's tool, sends to the same
    place. HandsFreeOS's staff with Health read them on the support desk's **Problem reports** page (`/admin/problems`
    on the web, the desk's Problem reports on the phone): open or handled, by area, each with its outline, **Copy
    for Claude** (the phone shares it) and **Mark handled**. The person who sent one reads only their own; they go
    after 30 days, handled or not. The add-on's own `outreach.report.save` is gone; the notes 0.48.0 saved were
    copied across, and its table `reports` is dropped in a later migration.

76. **Check LinkedIn tries every step up to its last press** (Chris, 17 Oct 2026: "Lets try to have linkedin do all
    of the actions it needs to do and give feedback on issues instead of one thing at a time"). From extension 0.52.0
    Check LinkedIn still reads the pages of decision 74, and on the way takes each of the extension's LinkedIn steps as
    far as it goes without changing anything (`src/networks/linkedin/tries.ts`), so one press finds every step that
    doesn't work. Nothing is ever saved, posted, sent, liked, connected or withdrawn:
    - **Your headline:** the pencil by your name, the box it opens, its one field named Headline and its one Save; a
      few words written in Headline and its own put back, then the box closed (Dismiss, and Discard if LinkedIn asks).
    - **Posting:** Start a post on the feed opens the composer, with a box to write in and Post; it's closed again with
      nothing written.
    - **Commenting:** on a person's post with a page of its own, from the feed or the posts search: a word written in
      its comment box, so the button that sends it shows, then taken out again.
    - **Connecting:** Connect on the profile of someone in the people search you're not connected with, in the top card
      or under More (pressed again to close it).
    - **Messaging:** Message on one connection's profile opens the conversation, with its box to write in and Send.
      Nothing is written, as LinkedIn shows the other person someone's typing; the conversation is closed again.
    - **Liking:** one of that connection's posts on their activity, and its Like.
    - **Withdrawing:** on Sent invitations, each invitation's Withdraw.
    - **The data file:** on Get a copy of your data, the words each step of asking for it looks for; nothing ticked.

    Each step sends a problem report of its own (job `checkup.<step>`): whether it works, what it found (counts, yes or
    no), what it couldn't find in the extension's words, the names of what it looked among as the outline shows them,
    and the page's outline when it doesn't work. A step with nothing to try on (no connection, no invitation sent)
    says so. A last report (`checkup.summary`) and the ask's line name the steps that don't work. **Put this one in**
    says which of its steps failed the same way. Its window is in front for about three minutes.

    His first Check LinkedIn on 0.52.0 (17 Oct 2026) found posting, commenting, liking and the data file working,
    nobody to connect with or withdraw from, and three faults, which 0.53.0 fixes:
    - **The headline's field had no name.** LinkedIn wraps it in more boxes than the outline shows, and the line above
      it was further up than the extension looked. A field is now named by the nearest line above it however many
      boxes it's in, within the box over the page, passing over what isn't shown and stopping at another field's row.
    - **Message on a profile opened nothing the page could see.** LinkedIn's newer pages draw their older parts in a box
      of their own at the foot of every page (`interop-shadowdom`, and the iframe `interop-iframe` beside it), out of
      the page's own look-ups; its conversations are likely there. The extension now looks there too, opening the box
      as Chrome lets an extension (`src/networks/shadow.ts`), and the outline shows what's inside it ("#shadow-root",
      "#document"). When nothing opens and Message is a link to a page of its own (`/messaging/compose/…`), Check
      LinkedIn opens that page and tries there too; messaging counts as working when either way does.
    - **Someone the search offered Connect to read as a connection.** Their top card said "· 1st" beside the real
      "· 2nd". With Connect there, a "1st" no longer counts.

    A try that opens something (the headline's box, a conversation) now takes the page's outline before it closes it
    again, so its report shows what it saw.

    His Check LinkedIn on 0.53.0 (17 Oct 2026) found every step working but messaging, and the outline inside the
    interop frame showed why: Message on a profile takes the tab to the new conversation's own page
    (`/messaging/thread/new/?recipient=…`), drawn in the interop frame, and its Send stays off till something's
    written, which the extension took for no Send at all. From 0.54.0 a Send that's still off counts for finding the
    box, that page is one the runner writes on (its address names whom it's to, and a different member there stops
    it), the box is typed in with the frame's own page, and the try closes nothing on a conversation's own page.

    On 0.54.0 Message opened its window over the profile instead, in the interop box, and the window links to them by
    member id while his connections list gives only their name in LinkedIn's address. From 0.55.0, on their profile,
    the member id its own Message carries counts too when telling their window.

    On 0.55.0 every step tried worked (17 Oct 2026). Commenting had nothing to try on that time: no person's post on
    his feed or the search had a page of its own. From 0.56.0 it's tried on one of the connection's own posts from
    their activity when the feed and the search have none.

77. **Check Facebook, the same way** (Chris, 17 Oct 2026: "ok lets add a check for facebook"). From extension 0.57.0
    Facebook's page in Settings has **Check Facebook** too (`checkup` on Facebook; `ASK_KIND_SINCE_ON.facebook`, so an
    older build isn't asked it and the button says how to update). One press reads the person's profile, feed, friend
    requests (and, after View sent requests, the ones they've sent), friends, groups and one of them, a people search,
    a groups search, their chats, one friend's profile, the profile of someone they sent a request to, their
    notifications and Download your information, and on the way takes each of the extension's Facebook steps as far as
    it goes without changing anything (`src/networks/facebook/tries.ts`). Nothing is ever saved, posted, sent, liked,
    added, confirmed, cancelled, unfriended or joined:
    - **Your bio:** Edit bio (or Add bio) opens its box; a word written in it and their own put back, its Save found,
      then its Cancel closes it. Nothing is written in a box with no Cancel to close it.
    - **Confirming:** Confirm by the friend requests they've got.
    - **Posting:** Write something… in one of their groups opens the composer, with a box to write in and Post; it's
      closed again, nothing written.
    - **Commenting:** on a person's post from that group (else from their feed), on its own page: a word written in its
      comment box and taken out again, and the button that sends it looked for (Enter sends it without one).
    - **A friend request:** Add friend on the profile of someone from the people search they aren't friends with (the
      first three looked at, one at a time).
    - **Joining:** Join group on a group from the groups search they aren't in.
    - **Liking, unfriending and messaging,** on one friend's profile: one of their posts and its Like; Friends' menu,
      with Unfriend in it, closed again; and, last, as it may open Messenger, Message opening a chat with its box to
      write in, nothing written (Messenger shows the other person someone's typing), a window over the page closed
      again.
    - **Cancelling:** Cancel request on the profile of someone they sent one to.
    - **The file:** on Download your information, its first step (Create export); nothing pressed.

    Each step sends its own problem report as Check LinkedIn's do (job `checkup.<step>`, the outline kept when it
    doesn't work), and the ask's last line names what doesn't work and what had nothing to try on. The two Checks share
    the job's own steps (`src/jobs/checkup.ts`), each network's tries are its own, and every try finds what it needs
    with its step's own functions, so a try fails where the step itself would. Its window is in front for about four
    minutes.

78. **Instagram and Alignable, looked at first** (Chris, 17 Oct 2026: "lets add ... instagram and alignable as
    platforms", and whether a browser of Claude's could look at how those sites are built). They're networks now, in
    Chris's order after LinkedIn (core's `PLATFORMS`, migration 20261027008300), each in its kit's `stage: 'looking'`:
    the plan's "Each starts with a look at a real account and a kit". The look is the person's own Check, not a
    browser of anyone else's: signed out, both sites show little but their sign-in, Instagram's terms forbid
    automated collection, Alignable's robots.txt keeps every robot out of its signed-in pages, and signing in to the
    person's account from a server would put it at risk. So:
    - **Each has its page in Settings:** On for you, Your team may use it (every network allowed to start), what to
      press in Chrome (its site is an optional host permission, asked for once it's turned on), a note of what the
      extension does there for now (`NETWORK_WORDS.looking`), and **Check Instagram** or **Check Alignable**, the
      one ask either takes (`ASK_KINDS_ON`), of extension 0.58.0 or later (`ASK_NETWORK_SINCE`). No choices, limits
      or training wheels show there yet.
    - **It has no day yet:** `outreach.day.start` refuses one (`outreach_network_looking`), and it isn't on Today's
      strip, the network filters, the setup's networks step or a playbook's (`WORKING_PLATFORMS`).
    - **Alignable works from its part 3** (stage 6 of the partners plan, 20 Oct 2026), as LinkedIn did before its
      runner: `stage: 'working'`, so it has a day, a row on Today's strip and the filters, a step in the setup and a
      place on a playbook, its choices and limits in Settings, and its Check and profile as before. Until its runner
      (part 5) every step there is the person's own: Today lists them, they do them on Alignable, and the extension
      notes each (part 2). Start my day there says so (`sendingOffWords`). Instagram follows from its part 12 (below).
    - **Check Instagram's new reads** (extension 0.79.0; the Instagram plan's part 9): it also opens the person's
      followers, a hashtag, a place, their notifications and a chat, so its readers of who follows, hashtag and
      place posts, who engaged and a chat's messages are built from what those outlines show. Its chats in Messages
      are buttons, not links (his Check, 0.62.0), so from 0.80.0 Check opens the first with words by its row.
    - **Instagram's readers** (extension 0.80.0; the Instagram plan's part 10; `src/networks/instagram/read.ts`), as
      Alignable's are, each plain data, each counted in Check's notes and never said: someone's profile (their name
      and username, whether the person follows them by Follow, Follow Back, Following or Requested, whether they follow
      the person by Follow Back or "Follows you", their followers and latest posts); the person's followers in the box
      over /<you>/followers/ (each one's username, name and link, and whether the person follows them back: Follow
      beside them says not); a post (who posted it, by its own link /<name>/p/<code>/, its caption, its likes, its
      comments by who and what, and its place); a hashtag's and a place's posts; notifications (who followed, liked or
      commented, the kind only); Messages (each chat's name, whose its last line is, when, and which box: Primary,
      General or Requests); and a chat (who it's with, its messages as the person's or theirs, its box, and whether
      it's a request waiting for Accept). The profile and the post are built from his outlines of 18 Oct 2026; the
      followers, a hashtag, a place, notifications and a chat from Instagram's usual markup, by its own words, labels,
      roles and link addresses, and they're tuned from his next Check, which opens each: from his Check of 21 Oct 2026
      in 0.84.0 (below, **His Checks of 21 Oct 2026**).
    - **Noting the person's own steps on Instagram** (extension 0.80.0; part 11; `src/networks/instagram/actions.ts`):
      Follow or Follow Back on a profile or a list's row is a follow, kept as a request (`friend_request`) to that
      account, noted once the button says Following or Requested, so one Instagram blocked notes nothing; a post's
      Like (never a comment's) with the post's link; a comment sent from a post's box with something written, to whoever
      posted it or to the one it starts by naming (@name); and a message sent in a chat, with its id from
      /direct/t/<id>/. Each is to the account by its name in Instagram's address, never to the person themselves, and
      nothing anyone wrote is kept.
    - **Instagram works from its part 12** (extension 0.80.0, no migration), as Alignable did before its runner:
      `stage: 'working'` with `runs: RUNS_NOTHING`, so it has a day, a row on Today's strip and the filters, a step in
      the setup and a place on a playbook, its limits in Settings, and every step there is the person's own; Sending
      stays off till its runner (part 14, below). Today says **Follow them** there.
    - **A follow-back counts as accepting** on Instagram: its "friends" are the person's followers. **Save my
      followers** (`friends`, from 0.80.0, `src/jobs/instagram/`) opens their account from Instagram's menu, then their
      followers, reads the box a screen at a time at a person's pace, pressing nothing, and saves everyone it read as
      Instagram's friends list (`outreach.friends.save`). Someone they followed who's among them is a friend, and
      their first message comes as on the other networks ("Followed you back today"). From 0.85.0 it reads only the
      newest, and who followed back is seen on their own accounts too (below, **Instagram's newest followers**).
    - **No follow-back in 3 days: one short message** (the plan's "The steps"): someone followed 3 or more days ago who
      hasn't followed back and has had no message gets one first message on Today, marked as going to their Requests
      (`TodayItem.requests`, with no demo link): one text with no link, no video and no price, as Instagram passes only
      one till they accept. At most 5 of the day's 10 first messages go there, those sent there today counted (its
      kit's `requestsMessageAfterDays` and `requestsMessagesPerDay`, null on every other network). The AI's draft for
      it follows the rule (`REQUESTS_TASK`; drafts with a link or a second text are dropped, `fitsRequests`), and so
      does one of the business's own openers, or the AI writes it instead. No follow-up or check-in goes in a chat they
      haven't answered or accepted: one waiting in their Requests waits there.
    - **Unfollowing** on Instagram (the plan's question 5) is its tidying (`cancel_request`): people followed more than
      the business's wait ago (3 weeks to start) who didn't follow back, 20 a day at most, never anyone who wrote back,
      a customer, someone kept, or anyone followed before HandsFreeOS saw it. The Friends tab says **Not following you
      back** and **Unfollow the ticked**; the person ticks who, and the extension unfollows them in a tab they can see,
      pressing Following, then Unfollow in its box, each by its own words (`cancel`, from 0.80.0). Nothing is
      unfollowed on its own.
    - **Instagram's asks from part 13** (extension 0.81.0, `ASK_KINDS_ON.instagram`, `ASK_KIND_SINCE_ON`, no
      migration): beside Save my followers, unfollowing and its profile, its followers checked for fits and one
      researched (each account read for the AI: their name, what they do, their bio, how many follow them and what
      Instagram says their latest posts show, 20 a day, its kit's `checksPerDay`), its chats read for the AI, and
      someone looked up before drafting. Read my chats presses each chat's row in the person's messages by the name it
      shows, as its rows aren't links, sends each one-to-one chat as Instagram's with its id from /direct/t/<id>/, and
      notes who wrote last (`outreach.replies.note`), as a tab of the person's does as they go there now; the Requests
      box and group chats are left alone. Instagram's own profile reader now reads someone's bio and their posts'
      descriptions for these.
    - **Instagram's runner from part 14** (extension 0.82.0, `src/auto/instagram.ts`; its kit's `runs`, no migration):
      Instagram works on its own as LinkedIn and Alignable do, so its Sending choices open on its page in Settings
      ("Follows and likes on their own; each message waits for one tap, and you post each comment"). It goes only while
      its day is started and its Sending isn't Off, and stops for the day on any Instagram warning ("Action blocked",
      "Try again later"), there alone; HandsFreeOS halves Instagram's limits for a week after one and takes follows off
      its list for two days, as on every network (`warningOf`, `dailyLimitsNow`). Before its first day it saves the
      newest followers, works out who to unfollow and checks the followers once (`LIST_SAVES_ON`, `LIST_MARKS_ON`).
      Then, once a day: the newest followers (a follow-back is its accepting), from 0.85.0 the accounts it followed
      looked at for who follows back, the followers checked (20 accounts), its chats read with who wrote last noted,
      and Find partners with Instagram's search (whoever posted what it shows for creators,
      the accounts it shows for businesses). On Today's list it does the warm-ups (a look at their account and a like on
      one of their recent posts, on that post's own page, and a second while the day's likes have room past the
      warm-ups left; the look alone where it sees no post) and the follows (their account's own Follow, read again to
      see it says Following or Requested). It sends messages once OK'd, typed only into their chat's own box, the one to
      their Requests as one text. **Comments stay by hand:** the plan says "Anything public, and every message, waits
      for an OK to start", the code has no comment that waits for an OK and goes on its own (a comment in a runner's
      `runs.auto` goes as soon as Sending allows it, as LinkedIn's do), and Alignable's public writing is kept by hand for
      the same reason, so `comment` isn't in Instagram's `runs.auto` and Sending's words say so. **Unfollowing stays the
      person's ticks**, as withdrawing old requests does on Facebook, LinkedIn and Alignable: the runner works out who
      before the first day, and never unfollows on its own. Its limits are the plan's, all in its kit already (20
      follows, 30 likes, 10 comments, 10 first messages with at most 5 to Requests, 15 follow-ups, 20 profiles
      checked, 20 unfollows).
    - **Instagram's growing from part 15** (extension 0.83.0; **migration `20261027010100_outreach_engagement_follows`**,
      which only widens `addon_outreach.engagements.kind` with `follow`, always off any helpful post): two more of its
      runner's once-a-day jobs, and two more places Find partners looks.
      - **Hashtags and places.** A playbook has no fields for them, so they come from what it says already, as
        Alignable's town comes from the person's profile (`postLooks` in `posts.ts`, given by `outreach.posts.words`
        where its kit's `hashtags` says so): local hashtags first, a place in its area with its Words to search for
        groups ("Austin" and "plumbing" make #austinplumbing; its signs' quoted words stand in when it has none), the
        words alone or the places alone only when it has no area or no words, three a day in turn. Places are its
        area's own (`placesIn`, as fit reads them): a place's page has an id of Instagram's that no name gives, so the
        extension opens one (two a day at most) only when a hashtag's post was tagged at a place in the area. Each page
        has 4 of its posts opened in turn at a person's pace and read for who posted it, its caption, its likes and its
        place, and the posts are saved as a network's search finds are (no group, `found: 'search'`), kept only when
        they say a playbook's words or ask for help, for the AI's check.
      - **Their authors are warmed up, then followed.** On a follow network, whose comments wait for the person,
        Today lists a like for each good post's author not warmed yet, for the runner to do, as many as tomorrow's
        follows need (as the groups' people's are); a day after the like, their follow comes ("Wrote a post your
        search on Instagram found"), and their post's comment stays the person's to write.
      - **Warm leads from the notifications** (`helpful`, as Alignable's): who started following the person, and who
        liked or commented on their posts, sent through `outreach.engaged.save` (never what anyone wrote). Someone who
        followed is followed back at once, as they made the first move ("Followed you on Instagram"), unless the
        notification's own button says the person follows them already; being among the saved followers doesn't count
        as being followed back on a follow network. Someone who liked or commented gets a like back, then a follow.
      - **Find partners** also reads the hashtag of each creator search's words, and once a run the accounts Instagram
        suggests to the person (`/explore/people/`), beside its search's own.
      - Its once-a-day choice's words say so ("Once a day, first: save my newest followers, and read my messages and
        notifications"). No ask is added: Instagram runs on its own, so Today shows no Find posts there, as on LinkedIn.
    - **Instagram's newest followers** (Chris, 21 Oct 2026, extension 0.85.0, no migration). Save my followers read
      his followers a screen at a time, 8 to 15 seconds apart, as Instagram blocks accounts that scroll fast, and saved
      about 200 in 11 minutes: 10,000 would take 9 to 10 hours. The pace stays. His design:
      - **The first save reads only the newest 200** (a few minutes from 0.89.0): new followers are the warmest leads. (0.85.0
        read 300; the owner, 22 Oct 2026: 200 is plenty, from 0.86.0.)
      - **Each later save, and the runner's once a day, reads only those new since the last.** It stops once it
        reaches the followers saved before, usually within a minute, and at 200 all the same, so a burst of new
        followers still ends. From 0.89.0 HandsFreeOS says where: each screen is saved as it's read, and a screen whose
        followers `outreach.friends.save` had already (none added, none newly a follower) ends it, so a new install or
        another computer stops there too. (0.85.0 to 0.88.0 kept the newest at the last save on the computer, in
        `hfos.followersRead`: a new install started over from the top.) A save stopped part way keeps what it read.
      - **It reads with its window in front, a screen at a time to the box's end** (0.89.0). Instagram draws more of
        the box only as it's scrolled on screen, and Chrome draws nothing in a window hidden behind another: Chris's
        save of 23 Oct 2026 read 87 in twelve minutes. Each screen, still 8 to 15 seconds apart, goes to the box's
        end, which keeps every row it drew, so the newest 200 take a few minutes.
      - **A partial list never marks anyone gone.** `outreach.friends.save` only adds and updates the people it's given
        (nothing in core takes a list for whole), so a capped or incremental save leaves everyone it didn't read as
        they were: followers stay followers, and a follow still waiting keeps when it went. The reader of the box reads
        up to 400 rows now: at 200, a read never got past the first 200 the box drew.
      - **Follow-backs are seen on the person's own account** (`outreach.follow_backs.next`,
        `src/jobs/instagram/follow-backs.ts`), not the list of followers: those the person followed at least a day ago
        who are still waiting (`request_sent`, with a follow noted), not looked at in the last 20 hours, the longest
        since a look first, at most 30 a day (its kit's `followBackLooksPerDay`, halved for a week after a warning),
        at the checks' pace in its own window, pressing nothing, after Save my followers and as the runner's
        once-a-day job after the newest followers. "Follows you" or Follow Back is saved as a list of one among the
        followers (`friends`), the same accepting the list gives: "Followed you back" on Today, then the first
        message, and off the unfollow list. Following or Requested is saved as a follow still waiting (`sent`), which
        keeps `since` (so the one message to their Requests after 3 days and the unfollow list after 3 weeks go by when
        they were followed) and moves `seen_at`, which is when they were last looked at. Follow (no longer followed) is
        noted as ended already (`outreach.friend.end`, not counted). So follow-backs, the Requests message and the
        unfollow list no longer need the whole list of followers. It also finds those who followed the person before
        being followed back by them (a warm lead's "Followed you"), whom no newest followers show.
      - **The looks don't count against `checksPerDay`** (20 profiles a day on Instagram): that's the accounts read for
        the AI, its good-fit checks and its partner check, and sharing it would leave those fewer each day. A look reads
        one account the person follows already, sends nothing on and presses nothing; it has its own 30, counted on the
        computer across Save my followers and the runner (`hfos.followBacks`).
      - The words say it: "Save your newest followers" before the first day, "It's saving your newest followers first",
        and the once-a-day choice's note says it looks at the accounts they followed for who followed back.
    - **Alignable's Read my chats, every conversation** (extension 0.85.0). His first Read my chats on Alignable (21 Oct
      2026, 15:36 to 15:38 UTC) sent 1 chat of the 8 with messages (Messages had 16 conversations; Check's `chats: 16`,
      `chatsPreview: 8`). The one sent was the conversation Messages opened on: its two messages, the last his, as the
      inbox's outline showed it, and no other was saved (`file_chats`). The run's 2 minutes 17 seconds match a press of
      each of the other 7 rows, each waited on twice for its conversation, which never opened. Its rows have
      no button or link in them, and the press went to the row's outermost part (`conversationInSidebar`), which no part
      inside it hears. The "no messages yet" skip was right (8 rows show a line under the name), and the list needed no
      scrolling. Now a row is pressed on its name, the line a person's pointer lands on, with the press's down and up
      before its click, so it reaches whichever part of the row Alignable listens on; a conversation its row didn't
      open isn't kept as read, the run's line says how many, and the page goes to HandsFreeOS once with its outline.
    - **Its asks from part 4** (extension 0.73.0, `ASK_KINDS_ON.alignable`): its connections saved from My Network,
      all of them past Ally's picks; the connection requests they've got from its Requests; connections checked for
      fits and one researched, each business's page read for the AI (30 a day, its kit's `checksPerDay`); and a
      business looked up before drafting. Reading its chats waited for a reader built from a chat with messages in it,
      which Check Alignable opens from Messages' side from 0.73.0; it's built from his Check of 21 Oct 2026 (below,
      **Read my chats on Alignable**).
    - **Read my chats on Alignable** (extension 0.84.0, `chats` in `ASK_KINDS_ON.alignable` from 0.84.0 in
      `ASK_KIND_SINCE_ON`, no migration), as Instagram's part 13 is: its chat reader is built from the owner's Check
      of 21 Oct 2026, whose outlines showed an open conversation's messages each a `rel-card-message` between its
      header (`channel-header-loaded`) and its box (`full-view-write-message`). Theirs starts its row with their
      picture in a link to their business (`/biz/businesses/<id>`), then who and when, then the card; the person's own
      has who and when, the card, then a picture alone. The reader keeps each message as the person's or theirs, what
      it says and when, the latest 20, and who wrote last, as Instagram's chat reader keeps them, never more. **Read
      my chats** (`src/jobs/alignable/chats.ts`) presses each conversation's row down Messages' side by the name it
      shows (its rows aren't links), at a person's pace, sends each one with messages in it as Alignable's, keyed by
      Alignable's id for the business (the key its conversations open by), and notes who wrote last
      (`outreach.replies.note`), as a tab of the person's does as they go there now. Its runner reads them once a day,
      right after the connections are checked, as Instagram's does.
    - **Its town's posts and forum questions** (extension 0.74.0, the `posts` ask, **Find posts in your town** on
      Today): the extension finds the person's town from their own profile's address, opens its page and reads a few
      screens of it, and saves each post and question as one found on the network (no group, `found: 'find'`), for
      the AI's check as LinkedIn's search finds are. The good ones come onto Today with a draft, and their writers
      get a connect step after a warm-up. Answers to the ones asking for what the business offers (`strong`) are at
      most 2 a day there (its kit's `forumAnswersPerDay`), inside the day's comments, and Settings shows the line.
      Each is still the person's OK: they post it on Alignable, and the extension notes it.
    - **Recommend, by hand only** (the plan's question 8; extension 0.75.0): Today suggests one business a day to
      recommend there (`recommend`, its kit's `recommends`), a partner of the person's or a customer they've done
      work for (a paid invoice or a job done), never one they've recommended and never one on Never contact. A
      different one each day, so one they'd rather not waits. They write it on Alignable, and the extension notes it
      when the recommendation's page sends what's written (a touch of kind `recommend`, once a business). Don't pitch
      holds back the outreach, never a recommendation. Check Alignable opens a recommendation's page from 0.75.0 too,
      so its noticer is checked against Alignable's own form.
    - **Recommendations on Get ready** (the plan's "at least 5"; extension 0.76.0): reading their own profile counts
      the recommendations it shows (none beside Alignable's own ask for one, `/biz/word_of_mouth`), and the AI's check
      writes a short note asking happy customers for one (`recommendNote`). Get ready shows "2 of 5 on your profile"
      and the note to copy into Alignable's Ask for Recommendations, which it opens. It's a tip: it doesn't hold the
      list back.
    - **Its runner from part 5** (extension 0.77.0, `src/auto/alignable.ts`; its kit's `runs`): Alignable works on its
      own as LinkedIn does, so its Sending choices open on its page in Settings. It goes only while its day is started
      and its Sending isn't Off, and stops for the day on an Alignable warning, there alone. Before its first day it
      saves the connections and the connection requests they've got, then checks the connections once. Then, once a
      day: the requests, the connections checked (30 business pages), Find partners, and the town's posts (so Today's
      Find posts card goes). Find partners searches its businesses (`/biz/search`) and reads those found for the
      partner check; businesses alone, as it has no creators (`PARTNER_SEARCH_KINDS_ON`). On Today's list it does the
      warm-ups (a look at their business page and a like on a recent post of theirs, or the look alone when there's
      none) and the connection requests (their page's own Connect, by Alignable's id for the business, then their
      page again to see it went). It sends messages once OK'd, typed only into that conversation's box. **Comments
      and forum answers stay by hand:** each waits for the person's OK, as it's public writing (the plan's question
      9), so `comment` isn't in its `runs.auto`, and Sending's choices say so. **Recommendations stay by hand only.**
      Withdrawing old requests stays the person's too: no reader of the requests they've sent is built, as their
      markup isn't known, so nothing works out which to withdraw. A reply is drafted from what HandsFreeOS knows: from
      0.84.0, their conversation as the day's Read my chats last brought it in.
    - **Warm leads from Alignable's notifications** (the plan's "whoever likes, comments on or recommends you";
      extension 0.78.0, a migration: `engagements.helpful_id` may be empty and `kind` takes `recommend`): the
      extension reads Notifications once a day for who liked or commented on the person's posts and answers and who
      recommended them, and sends them (`outreach.engaged.save`), one row a person and kind, kept to the latest. Each
      is a warm lead on Today ("Recommended you on Alignable"): a like of theirs back, then a connection request. A
      comment off any helpful post isn't answered from Today, as there's no post to open.
    - **A forum question asking for what the business offers** pushes as a strong post does (decision 49), saying
      "On Alignable." and opening Today on Alignable (`?net=alignable`, on the phone too).
    - **Nothing goes on its own where the extension doesn't work the network** (`runsOnItsOwn`, its kit's
      `runs.auto`; none now, Instagram's runner coming last, in its part 14), even once it has a day: its Sending is off whatever was
      picked (`withinRules`), so nothing is drafted to wait for a sender that isn't there, and its page in Settings
      says every step there is the person's own (`noRunnerWords`), with no Replies, no helpful post where it has none
      (`helpfulOn`), and no switches along the way till its runner reads them. An Alignable chat opens at `/biz/conversations?with_business_id=`, by the
      other business's id, and Today's groups to read admins of are the list's own network's.
    - **In the extension** one reader serves both (`src/networks/looking/`), from each network's site
      (`src/networks/instagram/site.ts`, `src/networks/alignable/site.ts`): its addresses, its own words, its
      warnings and the buttons it looks for. As the person goes its script reads only warnings, and notes none of
      their steps. Check reads the network's main pages one at a time, at a person's pace, with its window in front,
      sends a problem report of each with its outline (names and words hidden), and looks for each step's button
      without pressing it: on Instagram the bio's box and Submit (on its own profile's form), Follow and Message (on
      someone's account), Like and the box to comment in (on one of their posts); on Alignable Connect, Message,
      Recommend, Like and a box to comment in, on each page it opens till each is found. Check Alignable follows
      Alignable's own menus by their words (its network, messages, the forum, its communities and the rest), never to
      anything that signs out, pays, invites, deletes or changes settings, since its signed-in addresses aren't
      published.
    - **What his first Checks found** (0.58.0, 17 Oct 2026), and what 0.59.0 does about it:
      - **Instagram:** the bio, Message and Like were found. Follow wasn't: the account was one he follows, and its
        Following was read by the arrow beside it ("Down chevron icon"), so a control's own words now come before its
        picture's label (`nameOf`), and Check looks for Follow on the accounts Instagram suggests (`/explore/people/`,
        three at most) when the first is followed already. The box to comment in had no Post: Instagram shows it only
        once something's written, so a word is written and taken out again, as Check Facebook's comment does. And
        Message now opens its chat, finds its box, writes nothing (Instagram shows the other person when someone's
        writing) and closes it again, as Check Facebook's does.
      - **Alignable:** alignable.com/ was its public home page though he was signed in, with a button into
        alignable.com/biz, which its robots.txt keeps every robot out of beside its dashboard, claims and onboarding.
        Every word of its menus was hidden, and the job chose its menu's places by those words, so it opened none.
        Check now starts at /biz, chooses the places its menus lead to in the tab, on their real words
        (`placeOpening`: never its public home page, its company's pages, signing out, paying or deleting), and opens
        the public home page only when /biz's menus have nothing worth a look. Words it may use are kept in outlines
        now, so the next Check shows its menus.
    - **His second Checks** (0.59.0): Alignable found all five steps' buttons, on a business's page, from /biz and
      the places its menus lead to (its network, events, groups, conversations and notifications). Instagram found
      the bio, Message (its chat opened over the page and closed) and Follow (on an account it suggests), but the post
      it opened was a reel, which opens in the reels player (/reels/<code>/) with no box to comment in till Comment is
      pressed. 0.60.0 takes the reels player for a post's page and opens a photo's post before a reel.
    - **His third Check Instagram** (0.60.0) found four of five: the comment box showed Post, but the word set in it
      by hand didn't stay, as Instagram redraws the box once it has the focus. 0.61.0 writes there as typing does
      (Chrome's insertText, after the redraw), as Check Facebook's comment does.
    - **His fourth Checks** (0.62.0, 18 Oct 2026): LinkedIn's nine steps all work, its About among them; Alignable's
      five; Instagram's four of five again. The word did go in Instagram's comment box and Post showed, but Instagram
      draws the box again once something's written in it, so the box Check had found read empty, and the word stayed
      in the new one. 0.63.0 looks at the box as it is each time, empties that one, and types only into a box that has
      the focus. His Alignable profile's outline showed its parts (About Us with its own page, the Elevator Pitch's
      button, My Ideal Customer and the ideal partner, the services), but its details' page was read before it had
      drawn anything. 0.63.0 reads that profile as the AI's check would, opens the Elevator Pitch and My Ideal Customer
      and closes them with nothing written, and reads About Us's page and his details' once each has drawn its boxes.
    - **His Checks of 21 Oct 2026** (0.83.0; every step works on both), and what 0.84.0 does about what they read:
      - **Alignable's chat:** its reader of an open conversation's messages is built from his outlines (above, **Read
        my chats on Alignable**), and its Read my chats asked from 0.84.0.
      - **Instagram's followers:** /<you>/followers/ showed his account without the box of followers over it, and its
        counts aren't links to the list now (`href="#"`). Save my followers and Check press his own account's count of
        followers once, as a person does, when the box doesn't show from the address, and read it there.
      - **Its notifications:** 30 people, every one under Instagram's "Suggested for you", each with Follow, below a
        month of Meta's own notifications: nobody had followed, liked or commented, so none was right. The reader now
        leaves out whatever is under that heading, as an account's name there can say "replied".
      - **A chat:** each message is an article, their picture (a link to them) beside the last of a run of theirs and
        none beside the person's, a post one shares linking to whoever posted it, and the header a link to them with
        their name in a heading. Who it's with leaves out the accounts a shared post links to; whose each message is
        goes by their picture, then the side it sits on; a shared post has no words to keep but still says who wrote
        last (`ChatOpen.last`).
      - **A post's likes:** its bar is Like, its count ("36.5K"), Comment, its count, and so on, each wrapped in boxes
        the outline leaves out, so the count is now the control after its Like, in page order.
      - **A hashtag:** #smallbusiness's page sent the tab to Instagram's search for it
        (/explore/search/keyword/?q=#smallbusiness), and its grid of posts is read as the hashtag's now, for Check and
        the day's look at hashtags.
      - **A place:** no post he'd read was tagged at one, so Check opened /explore/locations/, which is no list of
        places now but an account named "explore". Check opens up to two of the hashtag's posts for one tagged at a
        place instead, as the day's look does, so a place's page is still to be outlined.
      - **His own account:** it has no posts ("0 posts", with Instagram's own box for sharing a first photo) and no bio:
        the bio's section holds a one-word line in the place someone else's account shows what they do, a link and
        Threads. The name was read from that line; it's the line under the username now, beside the counts, as on
        someone else's account. The "New" button among the highlights was read as one, by its icon's title; it isn't.
    - **Each moves to `working`** once its readers and steps are built from what its Check sends back, as LinkedIn's
      were from his (0.46.0 to 0.56.0).

79. **Finding customers on Instagram and Alignable** (Chris, 17 Oct 2026: "go with your recommendations except for
    the instagram profile"; HANDSFREEOS_INSTAGRAM_ALIGNABLE_IMPLEMENTATION_PLAN.md, its decisions 1 to 10). Fix
    LinkedIn's gaps first (people found by post search get invitations; each network's Settings show only the
    switches its runner does). Alignable first, then Instagram. On Instagram: Chris's personal account, optimized as
    his LinkedIn is; the first message once they follow back or answer, else one short message with no link after 3
    days; unfollow those who didn't follow back within 3 weeks, 20 a day at most; the AI drafts posts and the person
    puts them up. On Alignable: each playbook says customers, referral partners or both; Recommend only by hand;
    forum answers after an OK each time. The plan's starting limits.
80. **Optimize your profile, on every network** (Chris, 17 Oct 2026: "need to have an AI and automated optimize
    feature for all platforms"). Decision 64 grows from Facebook's bio and LinkedIn's headline to every part of the
    profile a person writes, on every network, Instagram and Alignable among them: the AI checks each part against
    the main offer and writes it again at the network's own length; the person sees each as it is and as written,
    and **Put them all in** (or **Put this one in**) is their OK, as their profile is public; the extension writes
    each in, hands over what a site won't let it, and reads the profile again. Pictures and covers stay tips. It's
    checked again when the main offer changes and once a month, and a new check only suggests.
    - **Built in 0.62.0:**
      - **LinkedIn:** the AI writes the whole About (at most 2,000 characters; LinkedIn takes 2,600) beside the
        headlines. The person can change either, and **Put them all in** puts the picked headline and the About in
        with one press. Check LinkedIn tries the About's pencil too.
      - **Instagram:** its own list (a photo, a name that says what you do, the bio, the link, highlights and posts).
        The extension reads the account's own page and its form, and puts the bio in on the form, or hands that to the
        person. The AI writes a name for the person to put in, as Instagram changes names only in its app or Accounts
        Center.
      - **Alignable:** its own list, ticked by the person for now. Check Alignable opens the profile's pages and its
        edit form, so its reader and writer get built from what it sends. 0.63.0 reads the profile (About Us, the
        ideal customer and partner, the services) and opens its editors; the AI's check and the writer follow.
      - **Nothing in [brackets] goes in.** That's how the AI marks what it can't know, and the screen asks for it to be
        filled in first.
      - **Each network's page of Settings has Your profile,** with Get ready's sheet, so a network still looked at has
        it too.
      - **An About needs 0.62.0 or later**; an older build says to update first.

81. **Partners: reaching customers through someone else's audience** (Chris, 18 Oct 2026: "identify people with large
    followings of our target audience, or admins and moderators of fb groups and ask them if they'd be interested in a
    partnership"; HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, its decisions 1 to 15). A playbook whose goal is
    **Find partners** looks for group admins and moderators, creators and businesses whose audience is the
    playbook's, the AI judging fit first and size second. It warms them up, then asks only whether they're open to a
    partnership, and every partner message waits for the person's OK. Someone asked to partner is never pitched as a
    customer. A partner earns a share of each payment their clients make in HandsFreeOS in their first 12 months,
    paid by HandsFreeOS once a month for payments at least 30 days old, from the business's card through Stripe, with
    Stripe's fees the business's and $25 the smallest payout unless the business sets a lower one; US partners
    first (the plan's decisions 16 to 18). Each partner has their own page. Alignable's referral swap stays beside
    the commission. Social Outreach finds and asks; partners, commissions and payouts are core's, as money is: **Make
    partner** on the Partners list takes Manage partners (`partners.manage`), since it promises the business's money,
    and makes the contact a partner in core too (`partner.add`), with a link of their own. Group admins and moderators are still never approached
    as customers; this is the one way they're approached, as Chris asked. **Searches** (the plan's stage 4, Chris, 19
    Oct 2026): Find partners also searches each network with the partner playbooks' own words, their signs' quoted
    words and their words to search for groups. Post search finds creators, whoever wrote the posts, and people search
    finds businesses with the same customers. Two searches a day on a network, the same words for the same kind once
    a week, none while three days of reads wait. Who they find is kept to read for the partner check
    (`partner_leads`, `outreach.partner.leads`), nobody added to Contacts, and let go once the AI has answered.
82. **A code from your email, typed in HandsFreeOS** (Chris, 20 Oct 2026: "Alignable sends email verification codes
    to verify profile updates. So we need a feature to send a notification to the user to go check that code in their
    email and input it in HFOS so the extension can enter it in"). Where a network asks for a code it emailed (Alignable
    does before About Us changes), the extension asks HandsFreeOS for it: the ask goes to **code** (Needs you), Chrome
    pops up, and the person's phone says **Look in your email**. They type the code under the ask's line on the web or
    the phone (`outreach.ask.code`), the live channel tells their computer at once, and it puts the code in. The code is
    theirs alone, on the database too (`ask_codes`, nobody else reads it, owners included), handed to their computer
    once and deleted as it's taken, never in a push, an event, the audit or a receipt, and never handed over after 30
    minutes (`ASK_CODE_MINUTES`); the daily prune clears what's left. A code that didn't work asks for the newest one,
    which pushes again. Check never presses an Edit that emails a code (0.70.0). Its first use is Alignable's About Us,
    from Get ready (extension 0.71.0): read, written by the AI whole, and put in past the code.

    **The code's notification stays up** (Chris, 20 Oct 2026: "the notification about entering the alignable code …
    takes us to a screen that allows us to enter it and if we go away from it … there should be a notification button
    … next to the Ask HandsFreeOS button … that notification should remain active for the 30 minutes that the code is
    active until someone enters the code. also if the code is not entered in 30 minutes the system should then prompt
    the user to have the extension try again"). Waiting on a code raises an add-on alert for the person alone
    (critical, pushed at any hour, never emailed, due in 30 minutes), on Home and under the phone's **bell** beside
    Ask HandsFreeOS, which counts the add-ons' alerts still open and lists them; each opens the code's own screen
    (`?view=code&ask=`), its box ready to type in. It goes once the code's typed or the ask moves on or ends. With no
    code in 30 minutes the extension hands the step over (`askCodeRanOutWords`) instead of failing it: the
    notification becomes "Alignable's code ran out", and the step's Carry on reads **Try again**, which opens the
    profile again and presses Edit, so the network emails a new code (extension 0.72.0).

83. **A main setup, then a short one for each network** (Chris, 21 Oct 2026: "an easy to use and follow onboarding
    for the social outreach add on"). The old setup had too many steps, a hard extension install, no clear next
    thing to do and too much reading, for owners and their team alike. It also ended before anything could work: Get
    ready was a list of links, Sending stayed off, nothing started a day, and it covered Facebook only. Chris decided:
    - **What goes in:** "everything needed to have the system being to start working and know what it should be
      doing should be in the onboarding". So the setup covers Get ready's items (decision 63), the team's rules, the
      extension, what it does on each network, and the first day there.
    - **The split:** "ok then we may need to have an overall onboarding and then have a short onboarding for each
      social media platform they turn on". The **main setup** has three parts: Your business (`offer`, `playbook`,
      `video`, `rules`; owners and admins), Your computer (`extension`) and You (`messages`, `numbers`, `networks`).
      Owners have 8 steps and members 4; a member sees the business's part as done or waiting on an owner, and their
      messages wait on it. Each network turned on (in the networks step, or later with **Set up {network}** on its
      page in Settings) gets its own: `allow` (not Facebook), `playbook` (only while no playbook runs there),
      `profile`, `choices` and `start` (`NETWORK_STEPS`, `networkSteps`).
    - **Sending:** "They pick, we suggest". What it does on a network is three cards with nothing picked and the usual
      one marked **Most people start here**; Save waits for a pick. Decision 26's off stays until they pick.
    - **The short video is optional:** "ok just want to make sure its not required because some owners may not want
      one". **Your messages** no longer waits on a linked video (decision 69), and the video step has **We don’t use
      one** (`noVideo`). Members never wait on it.

    Every step ticks from what's true (`setupStepStates`, `networkStepStates`): Get ready's items for that network
    (`readinessFor`), the extension signed in (`extension_at`), their own settings saved (`settings_at`), the team's
    rules kept or changed (`rulesKept`, which **Keep these** saves), a playbook in use with its video or `noVideo`,
    the network allowed on the working computer, that network's Sending not off, and a day started there. **Skip for
    now** leaves a step to do. It opens at the first step not done, the main setup's then each network's, passing
    over a step waiting on someone else (`setupOpenAt`, `setupNext`). Groups have no step: decision 60's lists-first
    reads them before a network's first day, and its Start says so. Start names the first thing in the way with **Do
    it now** (`startBlocker`), and a refusal shows in the server's words with its fix (`startFix`). The install has
    five steps with drawn pictures and **Stuck?**; a network's Allow has three. No migration: `reached` is no longer
    written and an old one is still read (`SETUP_REACHED`), and an old `?step=` opens its new step (`readSetupStop`).
    Designed on the canvas "Social Outreach setup" (https://claude.ai/artifact/5hcaEL1hSTAUjKUn8JrSdU). Built.

84. **Check my profile: the whole profile, as a person** (Chris, 22 Oct 2026: "we need to make sure the check my
    profile feature has the ability to update the entire profiles including names, usernames, and images as well as
    links, adding other socials if applicable, bios etc. For example my current instagram account isn't related to
    my business but i don't want to make it my business page because i want to be seen as a person not a brand or
    company so we need to be able to make the changes necessary to do that and also recognize through AI when that
    needs to be done or when a profile isn't matching well or clashes in some way"). Decisions 64 and 80 checked each
    part on its own; now:
    - **How it comes across** (`look`): every network's check also judges the whole profile as a stranger sees it, as
      a person who does this work (`person`, the only one that's right), a personal account with nothing about the
      work, a company or brand more than a person, or too little to tell, and lists what clashes, with the work or
      with the person's other profiles (`unlike`: their name, username, line or link). It stays their own account,
      as a person, never a business page. The AI has the business's name, their other profiles as their last checks
      read them, and their notes (`ProfileContext`). The look advises: Get ready still goes by decision 63's items.
    - **Every part** (`PARTS_ON`, profile-parts.ts): beside the bio, the About and the checklist, the username, the
      name and the links, each as it is and as written, with who does it (`PART_HOW_ON`): the person's computer puts
      it in (`auto`: the bio, the About, LinkedIn's name in its intro's box), opens the page where it's changed and
      hands the step over with what to paste (`steps`: names and usernames in Accounts Center on Facebook and
      Instagram, LinkedIn's address, links on Facebook and LinkedIn), says it's only in the network's app (`app`:
      Instagram's links), or it's theirs to do (`tip`). **Put these in** is their OK for the ones ticked, one
      `profile_edit` (name, username and links from extension 0.87.0, `PROFILE_PARTS_SINCE`).
    - **Pictures:** "leave rule". The extension still never changes a picture (decision 64). The AI judges the photo,
      and the cover is made from its line, drawn in the app at the network's size (`COVER_SIZE_ON`) to download; the
      steps say where to put each in.
    - **Usernames ask first:** "ok". A new one shows what changes (old links stop working, searches miss the old one,
      the network limits changes) before it's picked. Each is held to the network's rules (`USERNAME_RULES_ON`), and
      checked free on the person's computer (`username_check`, a new kind of ask, migration 20261027010600): each
      address opened and read for whether anyone's there (extension `networks/there.ts`), nothing pressed. A taken one
      offers the rest, and their own to type and check. Nothing changes unless they pick one.
    - **Show me more, with a note** (Chris: "is there a way to try more if we don't like the ones suggested and maybe
      give feedback?"): three more of a username, name, bio or cover line (the About again, whole), unlike what was
      written before, following the chips and words they gave (`MORE_CHIPS`, `outreach.profile.more`). The note is kept
      (`notes`) and the next check follows it too; the ones before stay to go back to (`earlier`).
    - **Links** come from what's known, never guessed (`linksToAdd`): a booking link of a playbook running there, the
      business's website, and their own other profiles as their checks read them; one that doesn't read as them yet
      is held back.
    - **Side by side** (`profileMatch`, Settings → General): each network's name, username, line and link, what's
      unlike the rest marked, and **Fix it on** each.
    - **Once a month** (decision 80's promise, not built till now): a check over 30 days old says so beside **Read my
      profile** (`checkDue`). It asks nothing of their computer on its own.

    Kept with each check, the person's own: the parts compared (`seen`), the names and usernames to use (each free,
    taken or not known), the notes and what came before. A new check keeps the notes, what came before, and what
    their computer found of a username (`carriedOver`). A check from before this shows the checklist as it did. No
    data version: it's all in the setup row's jsonb. Designed on the canvas "Social Outreach profile check"
    (https://claude.ai/artifact/1t3H7FWim3zds5WWBDz9LN). Built; the new editors follow the pages' words, and haven't
    been tried on a real account.

    After Chris read every network on 23 Oct 2026 ("Facebook didn't work"; Instagram "recognized it wasnt a personal
    profile style name ... but it didn't really recognize that the business wasn't really related to the right
    business based on the offer or playbook"; side by side showed "only LinkedIn and Instagram ... even though it
    shows that Alignable worked"):
    - **Facebook's October 2026 profile** (extension 0.90.0, from the page outline his read sent): Edit profile is a
      link now ("Edit"), not a button, so every read since 16 Oct had taken his profile for someone else's. It's read
      by that link; the bio is the line above the details row (there's no Edit bio); the Personal details, Work and
      Education cards stand for the Intro, and the Links card gives the links. With no Edit bio, a new bio is the
      person's to put in.
    - **The work, weighed** (`look.work`): same, other or none, against the main offer and the playbooks that run on
      the network, which the check now has, with the person's own name. A profile about another business, brand or
      line of work is never right, even as a person, and its first clash says what it's about instead. Names and
      usernames come from their own name, never with a blank like "[First name]"; one with a blank isn't kept.
    - **Side by side** shows every network the person has on, Alignable's too (it has no username), and one not read
      yet says so, with a link to read it.

85. **One extension, one computer, every network from install** (Chris, 23 Oct 2026: "why when i first install the
    Social Outreach extension i have to allow on LinkedIn, Instagram, and Alignable but not on Facebook? Also everytime
    i install it creates a new "computer" even though it's the same computer and browser", then "build both as well as
    making all the platforms built in"). His Live tab listed Chrome on Mac 1 to 31, one for each time he put the
    extension in. Chrome makes a hand-loaded extension's id from its folder and empties its storage when it's removed,
    so each install made a new install id, and HandsFreeOS a new computer. From extension 0.88.0:
    - **Every network from install.** LinkedIn's, Instagram's and Alignable's sites are the manifest's host
      permissions, as Facebook's are, no longer optional ones asked for with **Allow on <network>**. Each one's script
      is still registered only while it's on in HandsFreeOS (a network that's off runs nothing), and nothing is
      web-accessible. **Allow on <network>** stays for a person who takes a site back under the extension's Site
      access in Chrome; the setup's Allow step ticks itself once the extension says Chrome lets it there, and the
      settings say there's nothing to allow (`SETTINGS_WORDS.builtIn`). This undoes the rule of the networks plan's
      "New sites, asked for when turned on": the extension is loaded by hand, so an update asks nobody, and a store
      build would ask once, at install.
    - **Its own id.** The manifest carries the extension's key, so its id is gdgihcnpgggcaijdhnfnkfcfmhpmailc from any
      folder. The private half isn't kept: nothing is packed with it. Moving to it changes the id once (a new
      install, signed out), which the next part covers.
    - **A fresh install takes its old computer's place** (`replacedComputer`). A new install id is `fresh` until its
      first beat is answered; a beat from a fresh id HandsFreeOS doesn't know takes over the person's most recently
      seen computer whose name is the same plain name, numbered or not ("Chrome on Mac", "Chrome on Mac 30"), keeping
      its row, name, feed and whether it works, rather than making another. One they renamed is never taken: renaming
      is how to keep two computers of the same kind apart. A build before 0.88.0 never says fresh.
    - **Remove the ones you don't use** (`outreach.computer.remove`, risk 1, migration 20261027010700): on the Live
      tab and Settings → Your computer, **Remove** beside each one standing by, and **Remove the N standing by** once
      asked to confirm. Never the one that works (`outreach_computer_working`, which says to open the panel on the
      computer used now first); one still running comes back as new at its next beat. A person deletes only their
      own (a restrictive policy, as for reading them); their feed lines go with them and an ask one took keeps no
      computer. The phone shows the others and doesn't remove them.

## Rules worth knowing before changing anything

- **Nothing is saved until the person presses a button in HandsFreeOS** (an ask, below), except the four steps the
  extension notes (decision 8); while it works on its own (decision 26), the runner's own steps from Today's list and
  its once-a-day jobs, which save the friend requests the person got, their best groups' admins and members, posts
  worth a look, their chats (decision 32, `src/auto/daily.ts`) and who a search for partners found (decision 81); and what two switches send as the person goes, in the Facebook tab in front of them,
  panel open or not, each on by default and turned off in their settings in HandsFreeOS (decision 37): the chats they
  open in Messenger (**Read chats as I open them**), and the posts worth a look in a group's feed (**Look for posts
  as I scroll a group**). Facebook's warnings are read there always. The extension's own work tabs are never read this way.
  While noting is on, it also tells HandsFreeOS who wrote last in the chats on the page (decision 22), and the runner
  hands over a step it couldn't do (`outreach.need.note`, decision 42). Reading any other page only looks things up.
- **Settings live in HandsFreeOS, never in the extension** (decision 37). A new choice for what the extension does
  is a field on `AutomationSettings` (each person's, with a column in `addon_outreach.automation`) or on the business's
  `rules`, set on the Settings tab; the extension reads it from `outreach.automation` and keeps no copy but the one
  `src/hfos/follow.ts` writes. Saving the person's settings is what tells the extension (`outreach.automation.saved`
  and `addon.settings_saved` on the live channel), so nothing else needs to.
- **What the AI writes for the person goes through `voice.ts`** (decisions 53 to 55). Every prompt that writes for
  them carries `PLAIN_WRITING` (everyday words, short sentences, relaxed, no long dash), and what comes back is cleaned
  with `noDashes` (a dash between words becomes a comma, between numbers a hyphen) whatever the prompt said. A message
  or comment carries the person's voice (`voiceLines`, from `AutomationSettings.voice`, columns `voice_*` in
  `addon_outreach.automation`; the worker reads it with `voiceFor`); a helpful post only their emoji choice. A message
  to a chat quiet `GAP_GREETING_DAYS` (3) or more opens with a greeting that fits the gap (`gapLine`), measured from the
  latest message either way, in the chat or a message noted; a first message and a comment never get one.
- **A message's texts are its parts between blank lines** (`messageParts`), when the person sends a few
  (`voice.split`, on to start): at most `PARTS_MOST` (3), any more joined to the last. The AI writes them so
  (`checkedDrafts` with `split`, which also joins a message to one when they don't), and a pitch's link goes on as its
  own. The extension sends each as its own text, waiting `partPauseMs` (2 to 8 seconds, as long as typing it takes)
  between them. Once one text has gone the message counts as sent, and a later one that didn't go is said on its line.
- **A message waiting shows the chat so far** (decision 52): `Send` and `TodayItem` carry `recent`, the chat's latest
  `RECENT_SHOWN` (6) messages, oldest first, from the person's own chat (`recentOf` in `ops/common.ts`: its own when
  the send names it, else their latest with the profile). Bubbles say when, once for a run the same day
  (`recentBubbles`). The phone's offline copy keeps no chats, so its Waiting for you shows them with signal only.
- **Each kind of ask names the first build that does it** (`ASK_KIND_SINCE` in `asks.ts`, decision 58). A computer
  with an older build isn't asked it: the button says so with how to update (`cantAskWhy`), `outreach.ask.make`
  refuses (`outreach_extension_too_old`), and one waiting ends at the take saying so. A new kind of ask goes in the
  list with the build it ships in, and the extension's version goes up. The extension ends any kind it doesn't know,
  and always frees the next ask after one ends.
- **The setup is a page of its own** (decision 57): it opens over the app with no sidebar, in the main app's
  onboarding frame (`SetupPage`, `SetupCard`), with Finish later at the top. A **welcome** comes first while no step
  is finished (`setupOpenAt`); Back from the first step goes to it; coming back where they left off says so
  (`resumed`), with Start over.
- **The setup's steps are worked out, never kept** (decision 83, `setupStepStates`, `networkStepStates`): each ticks
  from a fact another screen also changes, so a step done on Today or Settings is done in the setup too, and Skip
  for now never ticks one. Don't add a stored "done" for a step; add the fact. `reached` is old data, still read
  (`SETUP_REACHED`) and no longer written. A new step goes in `SETUP_STEPS` or `NETWORK_STEPS` with its words in
  `SETUP_WORDS`, which the phone reads too.
- **The setup is each person's own** (`addon_outreach.setup`). Finishing it changes nothing the extension does: the
  networks step's and each network's saves do (`outreach.automation.save`). A **first-timer**
  (`isFirstTime`) has never saved their own settings and never started the setup (`started_at`: moving on from a
  step, or leaving it for later). Saving their own settings is kept for good (`settings_at`, stamped by
  `outreach.automation.save` only when it's the person's own): an owner or admin saving them for them doesn't count,
  and doesn't undo it either, so someone who chose theirs once is never a first-timer again. The extension signing
  in makes a row too (`extension_at`), so a row alone never means started. Each save moves only its own parts
  forward, merged in the database, so two at once never put back what the other saved. Each person reads and writes
  only their own row, held by a restrictive policy too. The bare page sends a first-timer there; a tab's own link
  never does. The extension says it's signed in at each sign-in and at most every 6 hours while it stays signed in
  (`hfos.setupReported`; a refusal waits the same 6 hours, only a lost connection is tried again sooner), and opens
  the setup once per person, business and computer (`hfos.setupOpened`) when HandsFreeOS's answer to that report
  says they're a first-timer (`firstTime`), unless the add-on is off; with no answer it goes by the settings it
  follows. Only the extension's first sign-in, and the person's own steps, go out on the live channel: its sign-ins
  again and its check every few hours don't, so colleagues' open tabs don't refresh for someone else's extension.
  The **Carry on** line shows only to someone who started it or never saved their own settings, until it's finished
  or hidden (`showsSetupBanner`).
- **HandsFreeOS hands out the extension** (decision 71): the web app's `build` and `dev` first run the extension's
  `scripts/download.mjs`, which builds it for the HandsFreeOS the web app's own settings name (`NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_WORKER_URL`, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, read as Next.js
  reads them) and zips it to `apps/web/public/downloads/hfos-social.zip`, which git ignores. `next.config.ts` gives
  the button its version and size. `apps/web/turbo.json` counts the extension's files in the web build, so a change to
  them makes a new zip, and keeps the zip with a cached build. Never commit a zip or release one by hand. The zip's
  name never changes, since Chrome knows an extension loaded by hand by its folder and a newer one unzipped over the
  same folder keeps the person signed in; the link ends `?v=` and the version so browsers fetch the newer one.
- **A business's own link wins** (`extensionLink` in its Social Outreach settings, a whole https link with
  a real host only, refused
  with its own words on a save). A stored one that stopped passing reads as none and leaves the other settings as
  saved (`outreachSettings`), and every screen that saves some of the business's settings sends what's kept as it
  reads it (`settingsToSave`), so such a link goes with the next save rather than refusing it. The web's box and the
  phone's check a link as the save does before sending it (`extensionLinkProblem`). Members read it through `outreach.setup`, since `addon.settings` is the managers'.
- **The country setting skips, it never deletes** (decision 61). Anyone it skips stays kept, on the Skipped for
  country list. Someone whose country isn't known, yet or at all, is let through: nothing says they're outside. A
  reply owed is never skipped. Unskip is the business's, per profile (`country_through` in `addon_outreach.profiles`,
  with who and when), and holds whatever the setting becomes. Every place that picks people for outreach filters
  with `countryLetsSql`; a new one does too.
- **Noting a step adds nobody to Contacts.** Someone reached is kept as a profile with no customer, and the group
  they were first found in, until the person saves them; saving keeps their steps. A friend request marks the profile
  "request sent".
- **A step counts once.** The same post liked again, or another friend request to them within a day, comes back
  `repeated` and isn't counted again; comments and messages each count. A step that waited in the extension keeps
  the moment it was taken (`offline: 'anytime'`), and the extension sends it again with the same command id.
- **A message's place is worked out as it's noted** (`messageStep`): the first to someone starts a chat, the first on
  a later day follows up, and the rest of a day's, and answers, are neither. The daily limits count only those.
- **The limits count, they don't stop.** The person takes these steps on Facebook themselves, so the activity panel
  and the extension's panel (under **Right now**) warn past a limit (`pastLimitWords`) and nothing is refused. Cancelling and unfriending are the
  extension's own presses, so it stops at their limits (`TIDY_LIMITS`), and HandsFreeOS still counts any it's told of.
- **The extension presses only where the person sent it with an ask:** Facebook's download pages (decision 16) and,
  for cancelling and unfriending, the profile of someone they ticked on the Friends tab and still on its lists
  (`tidyPage`). It checks the profile is the one
  ticked and where things stand before pressing, and that it says Add friend after; anything else is handed to the
  person. It presses a button under their name, never a link or tab, and Unfriend and Confirm only in Facebook's box
  on top.
- **On its own, it does only what's on the person's list for today, and only the kinds they let it**
  (`autoKinds`, the list's `auto`). The list holds no more than today's limits have room for, so the runner never
  passes them; it checks each profile is the one listed and where things stand before pressing and after, passes
  over anything that isn't as expected for the rest of the day rather than retrying, and notes each step marked as
  its own (`auto`). It stops for the day on any warning, its own or the panel's
  (`src/hfos/warned.ts`), and keeps its state in the extension's storage, so a restart carries on where it was. The
  day's start and stop follow HandsFreeOS's (decision 41): a press here goes to `outreach.day.*`, and one in the app
  reaches it within seconds.
- **One computer works at a time** (decision 41): the person's most recently used one (the panel opened or shown, a
  step of their own there, signing in there, Start or Stop pressed there; never the runner's own steps). The others
  stand by and say why. There's no automatic hand-over: the app names the open computer and says to open its panel.
- **HandsFreeOS is the record of the day** (`addon_outreach.days`, `ops/day.ts`): Start and Stop from anywhere go
  through `outreach.day.*`, an older press never undoes a newer one, a press from another day (one that waited on the
  phone overnight) changes nothing and is passed over quietly, never refused, and a warning stops the day whatever was
  pressed, for the rest of that day. The extension follows the answer to each beat, except while a press of its own waits to
  be sent, and never undoes a warning it saw itself.
- **Each network is on its own** (Chris, 15 Oct 2026; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md): a warning
  or a pause on one network never affects another. A day is a network's (`days.platform`, `outreach.day.*`'s
  `platform`, Facebook when left out), a warning is the network's that showed it (`warnings.platform`; `warningOf`,
  `warnDay`), and a day's steps count against that network's limits alone (`dayCounts`, through the touch's profile).
  A warning's words, its feed line and its push name the network. LinkedIn is in `PLATFORMS` so each network's can be
  kept apart. On LinkedIn the extension notes the person's own steps, who wrote back and LinkedIn's warnings, as
  LinkedIn's (0.34.0, apps/extension/README.md, "The networks"), and takes no ask there before 0.40.0
  (`ASK_NETWORK_SINCE`); the activity panel and joining groups are Facebook's. The team's live view is the network on
  screen's, as the person's own is (`outreach.live.team`'s `platform`): on any other than Facebook, only the people
  who have it on. A new place that
  reads a warning, a day or the day's counts names its network.
- **Each network has its own choices** (Chris, 15 Oct 2026: the same choices as Facebook, each person turning networks
  on). Facebook's are the settings they always were; every other network's are in `AutomationSettings.networks`
  (`NetworkChoices`: on, sending, replies, liking a post first, confirming requests, the once-a-day jobs, joining
  groups, watching for posts, helpful posts), kept in `automation.networks` and off to start (20261027007100). Read
  one network's with `choicesFor`, or `automationOf(ctx, me, now, platform)`, never the top-level fields for a network
  that isn't Facebook. The business allows networks (`rules.networksAllowed`, every one to start, Facebook always)
  and sets each other network's limits under its starting ones (`rules.networkLimits`); a network it stops allowing
  reads as off (`withinRules`), and turning one on that it doesn't allow is refused (`not_allowed`). Each network's
  training wheels are its own (`automation.network_wheels`, Facebook's in the wheels columns): choosing (b) on
  LinkedIn starts LinkedIn's, its messages count toward them (`countWheels` by the message's network), LinkedIn's
  warning puts back only LinkedIn's (`wheelsBackOn`), and `outreach.wheels.end` and `outreach.wheels` take and give
  the network. A network that's off has no day to start (`outreach_network_off`) and nothing done on its own.
- **Each network's Today, asks and lists are its own.** `outreach.today` lists only its network's people (the
  `platform` folded into the country filter every pick uses, and the replies and chats read by their own). An ask is
  made on a network (`outreach.ask.make`'s `platform`, kept in `asks.platform`, 20261027007200): only the kinds that
  network can be asked (`ASK_KINDS_ON`; LinkedIn's: its invitations and connections, checks, chats, a look-up,
  research, the profile, withdrawing old invitations, post search and a post), only while the person works it, named
  by its network in its target (`askTargetOn`) so it never answers another's, ended at the take by that network's
  warning alone, and never handed to a build older than the network's first (`ASK_NETWORK_SINCE`, LinkedIn 0.40.0)
  or than the kind's first there (`ASK_KIND_SINCE_ON`: LinkedIn's file 0.42.0, its helpful post 0.43.0);
  the take says the ask's network. The lists saved before the first day are each network's (`outreach.lists` and
  `outreach.lists.saved` take `platform`; other networks' in `list_saves.network_saves`): LinkedIn's first day saves
  connections and invitations either way, then works out old invitations to withdraw and checks connections, with no
  groups (`LIST_SAVES_ON`, `LIST_MARKS_ON`, `PRE_DAY_WORDS_ON`).
- **Each network is in the app** (the plan's build order, step 3), on the web and the phone alike, from one copy of
  its logic and words in core (`network-words.ts`):
  - **Each network has its page in Settings** (decision 73, on the web and the phone): **On for you**
    beside its name, inside what the business allows, and while it's on, its own choices (the same as Facebook's, off
    to start on any other network) and its own training wheels, saved through `outreach.automation.save`'s
    `networks`. Facebook's choices stay the settings' own (`choicesFor`, `withNetwork`). A network the business
    doesn't use is shown off, saying why and who can change that (`NETWORK_WORDS.notAllowed`: owners and admins turn
    on **Your team may use** it below, anyone else asks them). **The switch saves at once** (Chris, 2026-10-16), for
    the person's own settings and for an owner or admin changing someone else's, as every change there does now:
    while it saves, the switch is busy; once saved, a line beside it says so (`NETWORK_WORDS.switched`: "LinkedIn is
    on. The extension picks it up in a few seconds."); refused, it goes back with the server's words. The setup's
    networks step keeps its own Next.
  - **For your team on a network's page** allows it (`networksAllowed`, Facebook always) and sets its daily limits
    for each person, each at most the kit's starting one (`dailyLimits` for Facebook, `networkLimits` for the rest).
  - **Today is each network's:** `outreach.live` takes a `platform` and gives that network's day, warning, limits,
    choice and first lists (the computers, what the working one says and the feed stay the person's); with more than
    one network on, the strip is a row for each, by name, with its own Start my day and Stop for today and its own
    warning line (**Start all** and **Stop all** press each), and the list below is the one shown (`?net=` on the
    web, picked on the strip on the phone). Asks made from a network's screens carry its `platform`, and a button for
    a kind it can't be asked doesn't show (`askableOn`, `cantAskWhy`, `latestAskOn`).
  - **The network is on every row, by its name, never a logo** (Chris): the pipeline, friends, chats and Results'
    people (`platform` on each row of `outreach.stages`, `outreach.friends`, `outreach.chats` and
    `outreach.activity`), and Needs you's items, from their link (`networkOfWaiting`), so the phone's copy of the
    messages needs nothing more. The pipeline, friends and chats narrow to one network (their input's `platform`,
    counts too; every network's when left out).
  - **Results add "By network"** beside "By playbook" and "By offer version" (`outreach.tracking`'s `byNetwork`):
    one goal for every network, each network's share of the first messages. `private.outreach_numbers_by_network` gives each
    count's network, from the profile reached (20261027007400).
  - **The playbook's networks step** offers each network in `details.platforms`, at least one, with where it looks
    on each; **the setup has a step to pick networks** (`networks`, the main setup's last, then a short setup for
    each network turned on, decision 83). **A playbook runs only on its networks** (`runsOn`, data version 7): Today, posts,
    checks, asks and Get ready read the playbooks on the network shown. Every customers' playbook saved before then
    gets Facebook and LinkedIn, as it ran on both (`onItsNetworks` marks it done); a new one starts with every network
    that works. Get ready says when no playbook runs on the network shown (`playbookNoneOn`).
  - **Screens say a network's own words** from its kit, or a word for all of them: an invitation to connect or a
    friend request (`dailyWordsOn`, `todayKindsOn`, `sendingModesOn`, `ticksOn`), LinkedIn messaging or Messenger
    (`chatUrlOn`, `openChatWords`), an ask by its name there (`askNameOn`: Withdraw old invitations, Put your new
    headline in), and a warning's note names its network (`warningNote`'s `platform`).
  - **LinkedIn works end to end from the app:**
    - **Get ready is the network shown's** (`outreach.readiness`'s `platform`): its profile part is the network's own
      list in its words (`profileWordsOn`), each item ticked and checked on that network, its headlines to pick from
      with **Put this one in** (a `profile_edit` ask there, up to the network's own length: Facebook's bio 101,
      LinkedIn's headline 220, else `outreach_bio_too_long`), LinkedIn's About to start from with Copy, and **Read my
      profile** on that network. Each other row of the strip waits on its own readiness, and says when its own
      profile is what's left (`READY_WORDS.stripNotReadyOn`).
    - **The helpful post is each network's** (`outreach.helpful`, `.ask` and the `post` ask with its `platform`):
      LinkedIn's goes on the person's own feed, so the card says "Your LinkedIn feed" where a group's name would be,
      and **Open LinkedIn** in place of Open the group (`helpfulWordsOn`, `helpfulWhere`, `helpfulOpenUrl`), by
      LinkedIn's own posting choice (`postingAboutOn` under it on LinkedIn's page in Settings).
    - **Today's comments on a post with no group** (LinkedIn's post search) say "On LinkedIn", and open the post; a
      warm lead from the person's own feed says "on LinkedIn" too. **The post's writer is someone to connect with:**
      a good post found in the last fortnight puts its writer on Today's invitations, once the person has liked or
      commented on it (or the warm-up wait has passed), by the playbook they fit best, counted with the day's other
      requests.
    - **Friends narrowed to LinkedIn tidies LinkedIn alone:** its card offers withdrawing old invitations, never
      removing a connection (`tidyWordsOn`'s `kinds`, from the kit's `tidyLimits`). `outreach.friends.tidy` counts
      each network's withdrawals, friends and download file on its own.
    - **The Live tab is each network's** (`?net=` on the web, its names on the phone), with that network's Start my day
      and Stop for today, counts, first lists and warning.
- **Each network has its kit** (`networks.ts`, `NETWORKS`): its name, the start of its links, the shape of a
  profile's id and name and a chat's id, how many friends it allows, its starting daily limits (LinkedIn's: 15
  invitations, at most 80 in any 7 days, 15 first messages, 20 follow-ups, 10 comments, 30 likes, 40 profiles read,
  20 old invitations withdrawn), and its words for a friend, a friend request and its messaging. What differs from one
  network to the next goes there, never into an `if`. Saves take a link and ids of any network it knows
  (`NetworkUrl`, `ThreadKey`), and every save that keeps a profile refuses one that isn't on the network named
  (`requireFits`, `profileMisfit`, `outreach_wrong_network`). The database keeps ids to short, plain characters
  (20261027006900). A network's cap on requests in any 7 days (`weeklyRequests`, LinkedIn's 80 invitations) holds
  Today's `friend_request` limit to what's left, and Today says it (`week`). Checks go by network too:
  `outreach.checks.next` takes a `platform`, lists that network's people, and keeps to its own profiles read a day
  (`checksPerDay`), halved by a warning there alone.
- **Each network's profile in Get ready is its own.** A LinkedIn day waits on LinkedIn's profile, never on
  Facebook's (`readinessFor` and `outreach.readiness` take a `platform`; Start my day and Today ask with theirs).
  LinkedIn's checklist (`PROFILE_ITEMS_ON`) has its photo, banner, headline (the `bio`, up to 220 characters), About,
  Experience, Featured and activity; its AI (`LINKEDIN_PROFILE_CHECK_SYSTEM`) writes three headlines, the opening of
  an About (`aboutDraft`) and a banner line. Its ticks and check are kept in `setup.network_profiles` (20261027007300),
  Facebook's in their columns as before; `outreach.readiness.profile` and `outreach.profile.check_save` take the
  network, and `ProfileRead` says which network the extension read. The not-ready words name it: "Your LinkedIn
  profile isn’t ready yet."
- **Growing on LinkedIn** (the plan's part 6). A post LinkedIn's post search finds is kept in no group
  (`outreach.posts.save` with `found: 'search'` and no `group`, refused on Facebook), checked by the AI and offered to
  comment on like a group's. The helpful post goes on the person's own feed: `outreach.helpful.ask` with
  `platform: 'linkedin'` takes no group (`helpful.platform`, a null `group_id` there only, 20261027007500), one a day
  on each network, each network's posting choice; its AI (`LINKEDIN_HELPFUL_SYSTEM`) writes for their connections and
  followers from what the posts their search found asked. `outreach.helpful` and `outreach.helpful.next` take the
  network, and whoever engages with it is a warm lead on that network's Today. The extension (0.43.0) puts it up on
  the person's feed (Start a post, the box's own Post), notes its link, and reads who commented and reacted once a
  day; on its own when LinkedIn's posting choice is `own`.
- **LinkedIn's data file** ("Get a copy of your data"; `linkedin-export.ts`, no zod, read in the browser as
  Facebook's file is): `readLinkedInExport` reads Connections.csv (each connection's profile address and since when),
  Invitations.csv (either way, with the other person's profile), messages.csv (one-to-one conversations only, no spam,
  their latest few messages) and Profile.csv (the person's own name), each column found by its name in the header
  row past LinkedIn's notes. LinkedIn can be asked for it, to download it and to bring it in (`file_request`,
  `file_download`, `file_in` in `ASK_KINDS_ON.linkedin`); it has no chat backup. The extension (0.42.0) asks for it
  on that page in a tab the person can see (they type their password), and brings it in: connections through
  `outreach.friends.save` as the friends list, the invitations still waiting as requests and sent ones, each with
  `since` (when the file says it began, so an old invitation is old at once), then the chats through
  `outreach.download.save` as LinkedIn's, matched by name.
- **The AI hears each network's words.** A draft, a chat read, a check, a like and a post check are told the network
  they're on (`todayDraftSystem`, `chatReadSystem`, `checkSystem`, `likePickSystem`, `postCheckSystem`, each taking
  a `platform`; the worker passes the profile's or the chat's). `inNetworkWords` puts the add-on's own Facebook
  words in the network's ("an invitation to connect", "LinkedIn messaging"), never what a person wrote, and leaves
  Facebook's prompts word for word. Today's lines and kinds say them too (`todayKindWords`). A post off a group, as
  LinkedIn's post search finds, is "on LinkedIn".
- **A heartbeat tells nobody:** a beat that changes nothing writes only `last_seen_at`: no event, no broadcast and no
  command receipt (`receipt: false`). A feed line, a new state, a different working computer or coming back online
  tells the app once; a new line alone at most every 45 seconds (the extension sends one at most every 20), and a
  line kept without telling is told with a later beat. A press in the extension that makes another computer the one
  that works tells the app and the others at once, day changed or not. Only a computer new to HandsFreeOS has the
  worker arm the feed's pruning (`made`). Because nothing receipt-less may wait on the phone, the phone's contract
  test refuses a phone command with `receipt: false`.
- **A line is cut short, never refused:** the status line, a feed line and a warning's line are at most 300
  characters (`LINE_MOST`, `clipLine`): the extension cuts them, and HandsFreeOS cuts what it's sent and the lines it
  writes itself, so a long error or a long Facebook warning never stops a beat or a warning's note.
- **A stop reaches what's under way:** the day stopped in the app, or another computer working now, ends a
  once-a-day job under way at its next page, and the runner looks again as soon as the step under way is done rather
  than at the next step's time (`wakeFor`'s `halt`). The same ends an ask under way, with Stop for today's words or
  the other computer's. A press in the panel updates the kept answer at once, so an older answer never undoes it.
- **What needs the browser is asked of the working computer** (`asks`, decision 43): from HandsFreeOS only, each
  person's own (owners and admins don't ask someone else's computer). Only the computer that works takes one, the
  oldest first, one at a time, and never beside a step of the runner's (`inTurn` in the extension's
  `src/auto/turns.ts`; the runner waits, "Doing what you asked from HandsFreeOS first"). One of a kind about the same
  thing is open at a time (`askTarget`), and at most five look-ups wait. A day without a computer on lets an ask go
  (`expired`); Chrome closing mid-way ends it as lost; a warning that day, seen on any of their computers, refuses
  every ask but bringing in the file, and ends one before it starts or at its next page while it goes (one kept in any
  tab, or a beat's answer that says so). Stop for today (pressed in the extension's panel, the web or the phone) and
  another computer working stop the one under way, with why and how far it got. An ask is done only when its job did
  what was asked; stopped, warned or unable to, it's failed with the job's words. Rows of `asks` are private to their
  person on the database too, as `needs` are: a person reads and writes only their own, owners and admins included,
  who count the team's through `private.outreach_asks_waiting` (`test/addons/outreach-own-rows.test.ts`). A step it can't find is handed to the person (**Carry on**, **Skip**), with one push per ask for
  each way it needs them (a step, or a password to type), on their add-ons switch, opening Live; half an hour with no answer stops it. A code the
  network emailed them (decision 82) is a notification that stays up until it's typed, and waits 30 minutes, then
  asks them to Try again. Asks run outside working hours and after
  Stop for today, since the person is asking now. They're kept a week, pruned with the feed.
- **An ask's line tells nobody more than every 20 seconds** (`ASK_LINE_SECONDS`) and keeps no receipt
  (`receipt: false`), as the beat; a new state goes at once. Its end keeps its moment and command id, so a retried end
  gets the first answer, and one sent after a Stop leaves it stopped.
- **The panel shows; HandsFreeOS decides** (decision 72: progress and activity only). Nothing is saved from the
  panel: the people reached are kept as profiles by noting, and Add to Contacts, Demo booked, Keep and Don't pitch are
  in the app (Keep on the web's Friends tab). The panel's only presses are signing in and the business picker, Start
  my day and Stop for today, **Allow on LinkedIn**, **Stop** on an ask under way, its links into HandsFreeOS (Needs
  you's among them), and **Copy page outline** and **Save page outline** (folded under **Something look wrong on this
  page? Tell us**). Nothing waiting is answered there: Send, Edit, Skip, Approve all, I did it, Let it go, Leave it
  and an ask's Carry on are pressed on the web or the phone.
- **Offline is worked out by whoever shows it:** no beat for 3 minutes (`OFFLINE_MINUTES`), on the server's clock
  (`live.now`), so the note shows with no event. A heartbeat tells nobody, so the Live tab asks again every minute
  while it's shown (`LIVE_REFETCH_SECONDS`) to keep the last-seen time moving.
- **Owners and admins see status, counts and how many wait; never lines, feeds or messages** (`outreach.live.team`).
  The feed's lines name the people reached, so they stay the person's own, and the database holds it too: beside the
  add-on's usual policies, restrictive ones let a person read and write only their own `computers`, `days`,
  `live_steps`, `needs`, `waiting_pushes`, `asks` and `setup`. Owners and admins (`outreach.manage`) may also read the
  team's `days`, which hold no words, and never change any. Everything else of a colleague's they see only through
  `security definer` functions in `private` that give status and counts, never a line, a need or a drafted message:
  `outreach_team_computers` (each computer's state and when it was seen, no line), `outreach_needs_waiting` and
  `outreach_asks_waiting` (how many wait for each person, and the newest), each refusing anyone but owners and admins,
  the person asking for themself, and the worker (`outreach_may_count`). The worker runs as `service_actor`, which
  the policies don't narrow (`test/addons/outreach-own-rows.test.ts`). `sends` keeps only the usual policy (`outreach.use` reads the business's
  rows), so there the operations alone keep a message to its person.
- **The feed keeps a week** (`addon_outreach.live_steps`, the worker's `outreach.live_prune`), each line once by the
  id the extension gave it, at the server's time. The same daily job lets go of needs done or let go more than a week
  ago (`NEED_QUIET_DAYS`) and open ones off the list a week more (`NEED_SHOWN_DAYS` and `NEED_GONE_DAYS`: noted again,
  one is new anyway), and deletes computers not seen for a month (`COMPUTER_KEEP_DAYS`) but each person's working one:
  their lines went with the week, an ask one took keeps no computer, and the extension, seen again, comes back as a
  new computer.
- **A message goes only through `sends`** (`outreach.send.*`). The extension drafts it and queues it; it waits
  (`waiting`) unless Sending is (b), the training wheels are off and it isn't a reply (`goesAsItIs`). A reply follows
  Replies instead, and never goes by itself to someone who needs the person (`replyNeedsYou`, from their last message
  in the person's own chat, which the server reads itself; the AI's "simple" only counts with (b)). With (b) or (c),
  one that waits is handed over with a push (`handedOver`, the worker's `handOver`). Only an OK'd one
  (`approved`) is sent, and only the extension says it went (`outreach.send.done`); the message itself is noted as any
  step is. One open send a person, profile and kind at a time: drafting again returns it. A send skipped or not sent
  takes them off the list for the rest of the day. A first message sent this way notes its opener, as copying does.
- **Waiting for you is worked out each time** (`outreach.waiting`), from `sends`, `needs`, the person's asks that
  need them at their computer (a step handed over or a password to type, `asksNeedingYou`) and their friend
  requests. The Live tab, the team view, the tab's label, the icon and the pushes all count it the same way
  (`waitingFor` in `ops/waiting.ts`). What waits for a person is theirs alone.
- **A person's waiting messages are on their phone alone** (decision 44, `private.addon_phone_own_table`): each row
  of `sends` waiting is copied to `addon_phone_rows` sealed to its `user_id` (never open, not even an owner's other
  phones of the business), with who it's to (`name`, `profile_url`, kept on `sends` by triggers from the profile), and
  leaves once it's OK'd, skipped or sent. Row security says the same. The phone reads them with `waitingOfCopy`, which
  answers what `outreach.waiting` does of them; a change to what's kept is a change to the manifest's `offline` and
  the migration together.
- **On the phone, the newer press wins** (decision 44): an OK that waited is held to 30 minutes (`freshMinutes`), then
  asks; a skip that waited goes whenever, but is refused when the message was OK'd after it was pressed
  (`outreach_send_okd_since`); an OK that waited finds nothing to OK once the message was skipped meanwhile, and the
  phone's Approve all (`partial`) passes over those.
- **Approve all leaves what needs the person** (`oneByOne`): a reply handed over (`handedOver`) and a message to
  someone who needs them (`needsYou`) each wait for an OK of their own, on Today and in Waiting for you.
  Today's button counts only what it OKs; the web's Waiting for you says the same number (`approveAllCount`). The
  server holds to it, whatever the client: `outreach.send.approve` with none named, or with
  `partial` (the phone's Approve all, any build), passes over them, and one named among others is refused
  (`outreach_send_one_by_one`); only one named alone, without `partial`, is OK'd.
- **A need is a step the extension couldn't do there and then** (`needs`, `openNeed`): a button or box it couldn't
  find, a different page, Facebook not taking it, or a message that didn't go (`outreach.send.done`, which hands it
  over itself). Never what changed on Facebook meanwhile ("Facebook says…"), no post to like, the AI, or a closed
  window. One open per step and person (or post, for a comment); noted again, it's seen again with the newest why. The
  step noted later, by anyone and however it was done, clears it (`clearNeeds`; a comment's by its post, or by the
  profile with no post kept or the same link), unless the extension couldn't do it again after that moment, and then
  **I did it** says so. Only a Facebook link is kept. Its `seen_at` is when it couldn't (kept offline); it begins to
  wait (`created_at`) when it reaches HandsFreeOS. **Let it go** keeps the same step quiet for a week (`NEED_QUIET_DAYS`); it's shown for a
  week from the last time it couldn't (`NEED_SHOWN_DAYS`), and back after that is new again. The runner still tries
  the step another day. A confirm need hides once the request is answered on Facebook, and a friend request need once
  a request is sent.
- **Friend requests to decide** are those from the last two weeks (`REQUEST_SHOWN_DAYS`) that didn't fit a playbook
  (owner answer 13a): those that don't fit well, and those that do but aren't Today's to confirm (no playbook in use,
  or Don't pitch or tagged Friend or family), with why. A good fit from someone pitched is never here, even past the
  most Today lists at once: Today confirms it on a later day (decision 30).
  **Leave it** sets one aside until they ask again (`set_aside_at`). They count on the icon and the lists, and are
  never pushed.
- **Pushes for what waits follow the person's choice** (`pushes`, the worker's `waiting.ts`): bundled, one job a
  person (`outreach.waiting_push`), 10 minutes after the first new one, at most every 2 hours and only in their
  working hours, and only when a message or step reached HandsFreeOS since the last (`waiting_pushes`, kept in the
  same transaction as the push); one for each pushes each message and step at once. A reply handed over pushes at
  once either way (the worker's `handOver`), and is never counted in, nor makes, a bundled push (`BUNDLE_KINDS`). A
  refusal for good (the add-on off, the person out of reach) drops the push; anything else is tried again, and the
  push keys (with the business in them) stop a second. The extension's pop-ups follow the same rule (`popUpsFor`) on
  the computer that works, telling of what was there, replies too, in one pop-up at most on its first look; its
  icon's number is everything waiting, asked again on the person's own changes, HandsFreeOS's own, and anyone's
  change to their settings or training wheels.
- **Training wheels halve the limits as a warning does** (`slowerFor`), on Today, the activity panel and tidying,
  and they're counted only on OKs while they're on (`countWheels`).
- **A post is checked once, and kept for the person who saw it** (`posts`, by `user_id` and link). Seen again, it's
  only updated; the AI's answer is taken once (`outreach.post.check` changes only a `waiting` post), and an answer it
  can't use marks it `failed`. Today offers it for a week from when it was last seen (`POST_FRESH_DAYS`), never when
  its writer runs a group, is on Don't pitch or is in Contacts, and never twice: a comment noted on its link, or
  **Not for me**, ends it. The look-up's lines go to the AI for that draft only and are never kept.
- **A warning is a warning for a week** (`warningOf`, `dailyLimitsNow`): on its network, limits halve (never below 1)
  for 7 days from the latest one, friend requests leave the list for 2, and the same words twice in a day on the same
  network come back `repeated`. The
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
  the two can't be matched automatically: Add to Contacts offers the customers with the same name first (`sameName`
  in `outreach.lookup`, with `hasProfile`), and **It’s them** ties them (`outreach.profile.contact` with that
  `personId`). Two profiles on one customer are fine.
- **A new customer from Facebook** is added through core's `person.create`, run inside the save, with source
  "Facebook" and texting consent unknown, so campaigns leave them alone. Duplicates by name aren't refused there: Add
  to Contacts offers same-named customers before it adds anyone.
- **Each teammate's chats are their own.** A chat is kept per person who saved it (`owner_user_id`), by the number in
  its link, so two teammates writing to the same customer keep two chats on that customer.
- **A chat saves to** the customer picked, or the one the chat is in Contacts with, or the one its profile is saved
  to, or the one it was saved with before; with none of those, Save to their card is refused (`outreach_chat_who`)
  until the person picks a same-named customer or says to add them. Only the person's own chats can go on a card, and
  one with no messages kept is refused (`outreach_chat_nothing_to_keep`). A chat from the file has no number until
  it's read in Messenger, so it's kept on the card as `file.<its id>` and takes its number when saved again. Group
  chats can't be saved yet.
- **A chat keeps its latest 100 messages** (`KEPT_MESSAGES`). A read joins what was saved where the two overlap most
  (`joinMessages`), so scrolling up and saving again adds the older ones. Each message keeps when it was first saved
  (one saved to the card from the Chats tab, when it was sent, so the activity counts a reply on its own day), and the
  extension writes "Today" and "Wed 11:02 AM" as the date before sending (`apps/extension/src/hfos/when.ts`).
- **Friends are each person's own; Don't pitch is the business's.** Where someone's own Facebook stands with a
  person (friends, request sent, asked to be friends, request deleted, not friends) is kept per user in `friends`,
  with when it started; so is Keep. The Don't pitch list is the business's and says who added each person and when.
  Only they, or someone with `outreach.manage`, take a person off (`outreach_dont_pitch_not_yours`). Customers tagged
  **Friend or family** in Contacts count as on it.
- **Don't pitch covers a person kept twice** (decision 51). Facebook shows one person by number in one place and by
  username in another, so the same person can be kept as two profiles. A profile kept under the same name on the same
  network as one on the list, or tagged Friend or family, is never pitched either (`neverTwins` and `pitchable` in
  `ops/common.ts`, the name compared with one space between words and no capitals). A stranger who shares the name is
  left alone too: the safe side. Every list that pitches goes through `pitchable`; the Don't pitch list itself shows
  only who was put on it.
- **Don't pitch and Never contact cover every profile on a customer** (Chris, 2026-10-15). A customer's Facebook and
  LinkedIn profiles are one person once both are on them in Contacts, so either on a list covers the other, on any
  network (`customerNever` and `offPeople` in `ops/common.ts`). Across networks only the customer counts, never the
  name. And someone pitched or booked through one of their profiles, by anyone here, isn't started again through
  another: `inPlay` leaves them out of every pick on Today but a reply they're owed (`reachedElsewhere`).
- **Never contact goes further than Don't pitch** (`contactable`): a profile on it, kept under its name on its
  network, or on its customer, is left out of everything `pitchable` leaves out, and also of what Don't pitch still allows: friend
  requests to decide, a reply's push, a message drafted or waiting, and Contacts from a chat. A new place that reaches
  people, or tells the person about someone, filters with `contactable` when Don't pitch alone would let them
  through.
- **Don't pitch refuses the step, not the person.** A step the extension notes to someone on the list is refused
  (`outreach_dont_pitch`) with what to change, so it's never counted as outreach. Saving their profile or a chat
  still works.
- **Newer news wins.** A list saved or an answer noted never undoes what was seen later (`seen_at`), and a deleted
  request stays deleted when a later list just doesn't show them. Confirm makes them a friend; Delete keeps the
  request as deleted. Saving a list adds nobody to Contacts.
- **Facebook's download file stays in the browser.** The web, or the extension when asked (in its offscreen page,
  the `offscreen` permission), reads the zips there (`readDownload`, in `download-read.ts`, which has no zod so the
  extension stays small), a file at a time,
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
- **A check is the person's own, and what their pages said goes once it's read** (`checks`, decision 46). One row a
  person and profile: the extension's look sets it waiting with the lines, and the AI's answer
  (`outreach.check.save`, only for the look it read: `lookedAt`) keeps its verdict, playbook, why, who they are and a
  first step, and empties the lines. A look that found someone else is `failed` at once, with no lines. Row security
  keeps each person to their own rows, owners and admins included (`checks_own`), since the AI read their chats; the
  worker reads them as `service_actor`. The day's count is the looks since the business's midnight. Today's
  **Reconnect** takes only `good` ones, never anyone not pitched, and never someone written to either way in the last
  month or on the list already; it counts against the first messages, as Say hi does.
- **A stage is worked out, never kept** (`ops/stages.ts`, `staged`): from the steps noted, friends, the latest chat,
  replies seen, the checks, demos and the marks in `stages`, in this order: booked, not a fit, pitched, ready, talking,
  friends, warming up, found. `stages` keeps only what can't be worked out, one row a person and profile: a mark
  (`ready` or `lost`, by the person or the AI, with when and why) and when the pitch went. The person's mark wins over
  the AI's; the AI's not a fit goes with its next read that isn't a no; **Back in play** clears the mark and the pitch.
  Row security keeps each person to their own rows (`stages_own`). **Not a fit ends outreach** (`inPlay` in
  `ops/common.ts`): Today's confirms, friend requests, likes, first messages, reconnects, pitches, follow-ups and
  comments leave them out; a reply they're owed stays. A pitch shows until it goes (`pitched_at`: a pitch the extension
  sent, `outreach.send.done`, or one copied on the web, which marks it), or the person writes to them after the chat's
  latest message or the mark.
- **A group's check is the business's; an ask to join is the person's own** (decision 48). The About lines, rules and
  the AI's answer sit on `groups`, the business's like the rest of what's kept about a group; the posts read for the
  check wait in `check_lines` and go when the AI answers (`outreach.group.check`, the system's only, and only for the
  look it read: `aboutAt`). A look with nothing on it is `failed` at once. The fit follows the AI over the name
  (`checkedGroupFit`): good is **Work these**, maybe at least **Maybe**, not **Skip**. `joins` keeps one row a person
  and group, restrictive to its person (`joins_own`); a failed one is asked again after a week, a new ask resetting
  when it went. The day's asks count since the business's midnight. Joining on its own is the person's
  `join_groups`, kept since 20261027001200 but unused until 20261027002200, which turned it on for everyone; the
  once-a-day job joins only while it's on and people left to reach are under a week of friend requests. People left
  count the way Today picks friend requests (found in a group that fits, fit a playbook, never reached, never running
  a group, on Don't pitch or in Contacts), up to 5,000.
- **A strong post is pushed once, and only fresh** (decision 49). `posts.strong` is set by the AI's check alone
  (`outreach.post.check`), and only for a good post; a second answer changes nothing. The push's key is the post's
  (`post:<id>`), so a post seen again never buzzes twice, and it goes only to the person who found it, on their
  add-ons switch. Fresh is by what Facebook printed (`postHoursAgo`: a day or less), or, with nothing that says, found
  by the look; a post put aside isn't pushed. The look runs only in the working hours, with the setting on
  (`automation.watch_posts`), and only while the extension works on its own; the state keeps when it's next
  (`watchAt`), and a new day looks after the once-a-day jobs.
- **A helpful post is the person's own, and holds its group for a week once it's going up** (`helpful`, decision 50).
  One a day counts those being written, waiting, OK'd or up (`COUNTED` in `ops/helpful.ts`); one put aside or that
  couldn't go frees the day and its group. Asking again while one is open answers that one. The AI's answer is kept
  only while it's being written (`drafting`), and a link in it is no post. `how` keeps the posting choice when it
  was written: an ask of kind `post` takes only one OK'd, and the runner only a draft whose `how` is `own`, so
  nothing goes up twice. `engagements` keeps one row a person, post and kind, restrictive to its person
  (`engagements_own`, as `helpful_own`); Today's warm leads read them for a fortnight (`WARM_LEAD_DAYS`), each person
  once (their comment over their reaction), never anyone not pitched or running a group; a comment is answered once
  the person's own comment on that post is noted after it was read. The business's `postingAllowed` always keeps
  copying, and a choice it stops allowing steps back toward copying (`withinRules`).
- **Fit reads only what can be checked** (`fit.ts`): the words a playbook puts in quotes in its signs and who to skip,
  the places in its area, mutual friends, and the group someone was found in. A skip word makes them a skip whatever
  else fits, and with no playbook only mutual friends and groups count. The Friends tab sorts the requests saved with
  it.
- **Tag names compare in lower case.** An app session's search path leaves out `extensions`, so `citext`'s `=` is
  plain text there: the Friend or family check uses `lower(name::text)`.
- **Limits live once,** in `limits.ts`. The commands hold sends to them; the extension cuts what it read to fit, and
  keeps a chat's save under the API's 256 KB.
- **Nobody deletes a saved profile, chat or playbook.** The tables' rules give no one delete; a playbook is archived
  instead, and two in use never share a name (`outreach_playbook_name_taken`). Their rows go when the business deletes
  the add-on's data, like any add-on's: on Settings → Add-ons, or all at once with **Start fresh** (decision 56).
- **Start fresh is core's** (`addon.start_fresh`, docs/addon-architecture.md, "Starting fresh"): an owner types the
  name, and the add-on is uninstalled, its data deleted and installed again, the worker making each move. Social
  Outreach only offers it, on the Settings tab. The extension forgets what it kept on the computer for the business
  when `outreach.automation`'s `startedAt` (the add-on's `installed_at`) moves (`forgetOnFreshStart` in
  `src/hfos/follow.ts`): a new key the extension keeps about a business's outreach goes in `KEPT_FOR_BUSINESS`.
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
- **Get ready holds what reaches people, never what reads** (decision 63): a new path that reaches someone (a message,
  a request, a comment, a post) checks `readinessFor` first, as `outreach.today`, `outreach.day.start` and
  `outreach.helpful.next` do; a reply to someone who wrote first is never held. The tests' fixture gets a business
  ready before those three (`getReady` in `outreach-fixture.ts`); one made with `{ ready: false }` isn't.
- **A note of what the extension saw keeps the page's shape, never its words** (decisions 74 and 75): a problem
  report holds counts, yes or no, the network's own section names, the masked address and the outline, in which
  everything a person wrote is "[2 words]" and people's and groups' links are {1}, {2}…; never anything read off the
  page as text. In the business it's the person's own, never their business's; HandsFreeOS's staff read it on the
  support desk, and it goes after 30 days. A note that can't be made or sent never stops a job.
- **The profile's check keeps the AI's answer, never the page** (decision 64): what the extension read goes to the
  worker's `outreach.profile.check` and no further. The check is saved by `outreach.profile.check_save`, which only
  the system runs, after `checkedProfileCheck`: an item with nothing read is never right, and a bio over 101
  characters, or one already given, is dropped.
- **Data version 3:** a playbook got a niche, its problem, its proof and something useful to send, empty on one saved
  before (the same `upgradePlaybookDetails`, and the worker's step 3). The five are optional in `PlaybookDetails`, and
  a save that leaves one out keeps what's saved (`keptV3` in `ops/playbooks.ts`), so a phone built before them never
  wipes them; null or an empty list clears one.
- **A conversation is each person's own** (decisions 65 to 68): one `follow_ups` row per person and profile, changed
  only by `noteSent` (a step, a follow-up, a check-in or a reply going, from the extension's sends or a copied draft)
  and `noteAnswer` (the AI's read of their answer), and stopped by Stop checking in. A step starts it over at that
  step, keeping the offer's version from the first. A step sent, or answering them, goes on with one the person
  stopped; one a no stopped goes on only once they're back in play (`outreach.stage.mark` open).
- **Anyone pitched keeps their version.** A draft for someone already pitched uses the main offer version they were
  first sent (`offerVersionFor`), never the live one, so nobody hears a new price or guarantee mid-conversation.
- **The offer's counts are the add-on's.** Core never reads `addon_outreach`; the main offer's page shows Social
  Outreach's counts through its `main_offer.panels` slot (`offer-panel.tsx`), from `outreach.offer.versions`.
- **Data version 4:** the pace became how many follow-ups (5 to 7) and the quiet days before each, and a playbook got
  a video link (optional, kept on a save that leaves it out, `PLAYBOOK_KEPT_KEYS`). A pace saved before keeps its
  spacing when the business changed it (`paceOf`); an old phone's `followUpAfterDays` is taken and ignored.
- **Data version 5:** a playbook got its video's script (`videoScript`, every part once, in order), kept on a save that
  leaves it out like the parts before it. The AI's script is only ever offered: the builder puts it on the playbook,
  and the playbook's save checks it.
- **The team's numbers come through one function** (decision 70): `private.outreach_numbers` counts first messages,
  yeses and calls booked for one person or, for owners, admins and the worker, everyone, and gives back counts only.
  `stages` and `follow_ups` are each person's own, so a query joining them for anyone else sees only the asker's rows;
  count through the function instead, as `outreach.tracking` and `outreach.offer.versions` do. Someone counts as
  messaged once, from their first chat started or first pitch, whichever came first.
- **The rule picks what to fix; the AI only words it** (decision 70). `fixFirst` decides from the week's numbers, in the
  video's order, and the AI is told which one and writes about that alone. Without the AI, `rulesReview` says it. One
  review a person a week (`reviews`, unique by week): the Monday job skips anyone whose week is kept, so a run tried
  again for one the AI was busy on does only that one, and nobody hears it twice.
- **The day's report goes only on a day with something to tell**, at the end of the person's working hours on the
  business's clock, while `dayReport` is on; a save from a screen that sends none keeps the one kept.
- **Timeline lines** come from `addonTimelineLine`: "added them from Facebook", "linked their Facebook profile",
  "saved 3 Facebook messages".
- **No real people in the repo.** Tests and fixtures use made-up names; the extension's readers are tuned from
  outlines, never saved pages (apps/extension/README.md).

## Not yet

The extension's steps on Facebook's download pages follow the owner's own screens of October 2026, mapped button by
button, except the Download button beside a finished file, which no file was ready to show yet. Where it hands a
step to the person, the page outline of that screen (folded away in the panel's footer), which keeps those steps'
words, tunes it.

Finding posts and the look-up read group feeds and profiles the way the readers do now, not yet tried on the owner's
account. A profile's business page is only one its lines link to by name ("Owner at …"); a business named without a
link isn't followed.

Cancelling and unfriending follow Facebook's usual buttons (Friends, Unfriend, Confirm; Cancel request), not yet
tried on the owner's account; a step it can't find is handed to the person. Unfriending on its own within a daily
limit (decision 10's other choice) comes with tidying on its own (decision 29).

The runner's presses (Add friend, Respond and Confirm, Like on the latest post, the comment box and its button) follow
Facebook's usual 2026 pages, not yet tried on the owner's account; one it can't find is passed over for the day, and
its line on the Live tab and in the panel says so. Chrome must be open for it to work; a window it opens unfocused may still show in front
on some computers.

Spotting replies reads chats the way the chat readers do now, not yet tried on the owner's account; a chat's line in
Messenger's list counts when it doesn't start "You", so a group chat's line counts too, though only a chat with
someone the person messaged can be a reply. The demo link counts bookings on the business's own booking pages; a link
to anywhere else carries the `ref` along, and only **Demo booked** counts those.

Asking from the phone covers the Groups and Chats screens' buttons; the Friends tab's asks and the look-up before
drafting stay on the web with those tabs and drafting. A pasted group link is asked on the web. The asks themselves (the file's steps, the friends list,
groups and their members, Read my chats, tidying and the look-up) do what the panel's buttons did, not yet tried on
the owner's account from the app.

`outreach.profile.save` and `outreach.chat.save` (and `outreach.lookup`'s profiles and chats) are kept only for
extension builds from before the bare-bones one (0.19.0, settings part 4), which saved from the panel. Once every
computer has that build or newer, raise the API's `MIN_EXTENSION_VERSION` to it (apps/extension/README.md, "Load it
in Chrome"), and the two commands can be retired; Add to Contacts is `outreach.profile.contact` and Save to their card
`outreach.chat.keep`.

From the main offer's plan (decisions 62 to 70), still to come: each person's own short video, after one a playbook;
the profile's read and the bio's edit (decision 64) follow page outlines, not yet tried on the owner's account; the
phone OKs messages and changes the video's link, but the samples and the script are written on the web; and yeses
were first kept with step 6 (`stages.positive_at`), so weeks before it count none, and people pitched before it have
no offer version.

Next: the AI suggesting a conversation from the rest of the playbook, with AI drafting. A profile saved after the file
came in is matched to it when a newer file comes in. Then leads. Then the rest of decisions 26 to 35 (the onboarding,
decision 36, and joining groups, decision 48, are built), in the order above: tidying on its own, then team sharing, the after-demo workflow, birthday notes and
templates, then LinkedIn and Instagram. LinkedIn and the networks after it are planned in
HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md: one add-on, a kit per network, and each network on its own, so a
warning or a pause on one never affects the others (Chris, 15 Oct 2026).
