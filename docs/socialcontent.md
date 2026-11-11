# AI Social Media Content Creator

An add-on (`socialcontent`) that studies creators in the business's niche and niches like it, finds the posts that did
far better than the posts around them, and works out why, so the business can plan its own content.

The owner's decisions and the build order are in `HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md`; the numbers
below (decision 1, and so on) are its decisions. Built: the add-on, its tables, the standout math, the work queue and
the web pages (part 1); the extension reading Instagram, with the AI helper and problem reports when a read goes wrong
(part 2); the AI's notes, the Playbook and ideas (part 3); watching Instagram videos, opt-in (part 4); the phone's
pages (part 5); reading Facebook and LinkedIn (part 6); and writing the business's own posts on a Calendar, with
designed, photo-style and its own pictures (part 8, below under "Making posts"); and putting OK'd posts up on
Facebook and LinkedIn through the extension (part 9, "Posting"), and on Instagram with the person's videos (part 10);
and reading how its own posts did, with the ones that did well in the Playbook (part 11, "Its own posts' numbers");
and the Calendar and its posts on the phone (part 12, under "On the phone").
The add-on is in `development`,
offered to nobody; staff give it to a business from Admin → Businesses.

## Where things are

| What                                                     | Where                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| The manifest, its permissions, events and pages          | `packages/core/src/addons/socialcontent/manifest.ts`                             |
| The tables (and their Drizzle mirror)                    | `supabase/migrations/20261027023800_addon_socialcontent.sql`, `tables.ts`        |
| What the reading computer is doing (`work.progress`)     | `supabase/migrations/20261027023900_socialcontent_progress.sql`                  |
| Which posts stand out, and who has done well             | `standouts.ts` (pure; web, phone and server all use it)                          |
| Reading a link to someone's page, and each network       | `networks.ts`                                                                    |
| The pages' words                                         | `words.ts`                                                                       |
| What the AI is asked about niches, and how it's checked  | `niches-ai.ts`                                                                   |
| People's operations: settings, niches, creators, posts   | `ops/research.ts`                                                                |
| The extension's operations: take work, save what it read | `ops/reading.ts`                                                                 |
| The worker's operations: niches, searches, the schedule  | `ops/worker.ts`, and `apps/worker/src/addons/socialcontent/`                     |
| What the AI helper is asked about a read, and its check  | `helper.ts`, and the worker's `apps/worker/src/addons/socialcontent/`            |
| What the AI is asked about standouts, and its checks     | `notes-ai.ts`; the asks run in the worker's `socialcontent/notes.ts`             |
| The Playbook, ideas and Try watching                     | `ops/notes.ts`                                                                   |
| The extension's reading                                  | `apps/extension/src/research/` (its README's 0.127.0 section)                    |
| Instagram's reads, and Facebook's and LinkedIn's         | `instagram-read.ts`; `page-read.ts`                                              |
| Watching a video in the reading tab                      | `apps/extension/src/research/watch.ts`                                           |
| The web pages                                            | `apps/web/src/addons/socialcontent/`, routes under `a/socialcontent/`            |
| What it's doing, on the Creators page                    | `activity-card.tsx` there; the extension's `Progress` in `research/read.ts`      |
| The phone's pages                                        | `apps/mobile/src/addons/socialcontent/`, routes under `a/socialcontent/`         |
| The Assistant's checklist for its screens                | `packages/core/src/assistant/ledger/socialcontent.json`                          |
| The business's own posts: the table, plan and post kind  | `supabase/migrations/20261027025000_socialcontent_calendar.sql`                  |
| The plan, its open days, and what a post still needs     | `calendar.ts` (pure)                                                             |
| What the AI is asked to write and design, and its checks | `posts-ai.ts`; the shapes on the wire in `content-shapes.ts`                     |
| The main offer and its lists, as the AI reads them       | `offer-ai.ts` (`offerForContent`); the worker's `socialcontent/business.ts`      |
| The notice while the offer isn't live                    | `offer-notice.tsx` in the web's folder; `OfferNotLive` in the phone's `kit.tsx`  |
| People's posts: calendar, save, OK, skip, remove         | `ops/content.ts`; the worker's keep in `ops/worker.ts`                           |
| Writing, filling the calendar, and making pictures       | the worker's `socialcontent/content.ts`                                          |
| Drawing a designed picture                               | the worker's `socialcontent/draw.ts` (Inter from `@fontsource/inter`)            |
| OpenAI's photo-style pictures                            | `apps/worker/src/pictures.ts`                                                    |
| The Calendar page and a post's sheet                     | `calendar-page.tsx` and `post-sheet.tsx` in the web's folder                     |
| Posting: where a post goes, its words as they go up      | `calendar.ts` (`placesFor`, `postText`, `POSTING`)                               |
| Posting: the next post due, how it went, Post it now     | `ops/posting.ts`; `supabase/migrations/20261027025100_socialcontent_posting.sql` |
| The extension putting a post up                          | `apps/extension/src/research/posting.ts` and `post-here.ts`                      |
| Its own posts' numbers: when they're read, doing well    | `own.ts` (pure); `ops/own.ts`; `20261027025200_socialcontent_own_numbers.sql`    |
| The extension reading its own posts' numbers             | `apps/extension/src/research/own.ts`                                             |

## How it works

- **Niches.** **Suggest niches** has the AI read the business's profile and knowledge base and name its own niche
  (kept ticked when there isn't one yet) and 3 to 5 like it, each with why and the words to search each network for
  creators in it. The own niche is the field the business itself is in, as a creator in that field posts about it
  (what it makes, sells, does or teaches), never its customers' trade: a CRM and automation company's is like "AI, CRM
  and automation", not its customers' "home services" (the owner's ask, 9 Nov 2026). At most one of the others is
  about the customers' world, and its why says so. A skipped own niche gives way to the next suggestion's: only an own niche that isn't skipped counts as
  the business having one (`hasOwnNiche`). When the AI names as its own niche one already kept, that one becomes the
  business's own (ticked if it was only suggested; one someone skipped stays skipped). A suggested niche waits for someone to tick it (**Search it**) or **Skip** it. Anyone can add one;
  the AI then writes its searches (`socialcontent.niche.added`), and when it can't, the niche's own name is searched.
- **Finding creators.** Once a month, and on **Find creators now**, each ticked niche is searched on each network
  studied. The reading computer reads each creator's profile: those with 5,000+ followers who posted in the last 30
  days are **Suggested** to tick; the rest are kept as not fitting, so they aren't read again (decisions 4 and 5).
  On Instagram, whose hashtags' pages send to its search page now, a search reads who posted what that page shows;
  when its answers show nobody, what the page holds itself (its own data, the answers it loaded), then its grid,
  which draws only on screen, so it's read in front only while the person is away (decision 120). A search that
  showed nobody at all ends saying so, with a problem report, never as done with nobody. When Instagram's answer for
  a profile, or for its posts, says it isn't there, the profile page itself is read (the data it came with, then its
  description for followers, name and bio), and when they last posted from the posts its grid links to (a post's code
  says when it was posted; in front only while the person is away, when the grid isn't drawn behind another window).
  A studied creator's posts are then asked for by their account's number (from the page's own name for itself when
  Instagram's profile answer isn't there), then by their name; when neither list comes, the posts the page holds, else
  each post its grid links to, one at a time back to the read's start, and a problem report says which ways didn't
  come (extension 0.130.0, 10 Nov 2026, after both ticked creators' posts reads ended with nothing). Their page is
  scrolled in front, only while the person is away, for up to 50 of their posts (0.131.0).
  Someone kept as not fitting only because their profile didn't say when they last posted, with 5,000+ followers, is
  read again by the next search, and suggested when they fit. Profiles that still wouldn't open are counted (**Couldn’t open N profiles**),
  and a search where none opened, or most didn't, ends saying so with a problem report, never as done (9 Nov 2026,
  after two searches showed 30 accounts and read none).
- **What it's doing** (the owner's ask, 9 Nov 2026: "so we can know the work it's done"). The Creators page shows,
  on top, whether the reading computer is there (when it last asked for work, and its extension's version; quiet past
  10 minutes), what it's doing now (the words it's searching, the searches done, the accounts the searches showed,
  the profiles and posts it read), how many more wait, and the last three things it did, each with what it found or
  why it didn't work. The extension says how a read is going as it goes (`socialcontent.work.progress`, into
  `work.progress`), and HandsFreeOS adds who a search suggested and who didn't fit. Settings → What it's doing shows
  the same facts on each row.
- **Studying.** A ticked creator's posts are read back 12 months; anyone added from a link is studied straight away,
  whatever their size. Each studied creator is read again once a week: new posts, and the numbers of posts from 60
  days before the last read, since those still grow (decisions 8 and 11).
- **Standouts.** Every time a creator's posts are saved, all of them are weighed again: each post against the median
  of up to 10 posts on each side of it, on views and on likes plus comments. 2 times or more on either is a standout,
  and it says which (decisions 6 and 7). The Standouts page lists them, newest first.
- **The reading computer.** One person's computer reads for the whole business, in Chrome with the HandsFreeOS Social
  extension (decisions 1 and 12). An owner or admin picks it in Settings. What it's asked to do is a queue
  (`addon_socialcontent.work`): find creators for a niche on a network, read a profile, read posts. Only that
  computer takes work, one at a time: reading a creator someone ticked or added first, then searches for new
  creators, then the weekly and monthly reads, each oldest first, as a search takes a good part of the day's room on
  a network. Searches use at most 300 of a network's 400 a day (from extension 0.129.0); the rest is kept for the
  creators someone ticks or adds, so one ticked late in the day is still read within minutes while that computer
  has Chrome open. What it took and never finished goes back to waiting after 2 hours, and anyone can **Stop** what
  hasn't finished.
- **Notes on standouts** (part 3, decision 10). When posts are saved, the worker's notes job runs a minute later (once
  per business, and once more after when posts are saved while it runs, so none is missed): up to 15 standouts with
  no notes, 5 to an ask, each shown to the AI beside the posts around it that did about normal. Each note says why it worked, its hook, format and topic, the techniques
  used, and how the business could use it. Creators' captions are quoted as data, never instructions.
- **The Playbook** is written from the notes once 3 standouts are noted, and again each time 5 more are, or on
  **Write it again**: a summary and sections of what to do and why, each with standouts as examples.
- **Ideas** come from the Playbook each time it's new while fewer than 5 new ones wait, or on **Get ideas**: a title,
  hook, format, network, outline and why, based on standouts. Each can be saved, marked used, skipped or put back.
- **Watching videos** (part 4, decision 9; Instagram's for now). Off until an owner or admin turns it on in Settings,
  after a notice that it uses about 10 to 20 times the AI; **Try it on a few videos** watches up to 5 of the newest
  standout videos once without turning it on. The reading computer opens the post, gets its video file from
  Instagram's video servers, takes up to 12 frames (about 512 wide) and the first 2 minutes of sound, and sends them
  to the worker's `socialcontent.post.watch`, where what's said is heard (charged as speech) and the AI looks at the
  frames and reads the words. Nothing is kept but the AI's notes: the hook, what's on screen, what's said, the pacing,
  why it worked.
- **On the phone** (part 5). Its one row at the top of More opens its first screen, which lists Creators (how many
  are studied and wait to be ticked), Standouts (how many), the Playbook, Ideas and Settings, as the web's side menu
  pops them out of its one row. Each page does what the web's does, at phone size: Creators has what it's doing, the
  niches, adding a creator from a link, the three lists, and a studied creator's posts in a sheet; Standouts keeps to
  a network (chips) or one creator (a sheet to pick from), and a link's `?network=` and `?creator=` open it that way;
  Settings asks again in a sheet, with the notice, before watching videos is turned on, and says the extension goes
  on a computer rather than offering the download. Nothing is kept on the phone: each screen asks with signal, says
  it needs signal with none, and Creators and Settings ask again every half minute while they're open. Its commands
  are online commands in the phone's contract (`packages/core/test/contract/mobile-contract.json`); the worker's
  actions (Suggest niches, Write it again, Get ideas) go through `workerPost`, as on the web.
- **The Calendar on the phone** (part 12). Its first screen lists the Calendar too, at the web's own address
  (`a/socialcontent/calendar`). It does what the web's does: Fill the calendar, OK the week, Write a post, the
  Fill on its own switch, when it filled and fills again with the plan and who puts posts up, each day's posts and open days (Write one), No day yet,
  and Went up lately with each post's latest numbers. A post opens on its own screen at `calendar?post=<id>`, as the
  web's sheet does, so a link to one opens it there too. That screen changes everything the sheet does (title,
  network, format, a day in the next two weeks and a time in the business's time zone, where on Facebook, hook,
  words, hashtags, slides, script), shows where it went up and How it did, makes its picture again, takes the
  person's own photos (made smaller first, to 2048 px) or video (up to 25 MB) from the phone, OKs it or takes the OK
  back, Post it now, Skip it, Remove (owners and admins), and Write it again. Pressing a picture opens the post's pictures full screen, to
  swipe between (and pinch to zoom on iPhone). On a network the extension doesn't post on yet, Share the words
  hands them to the phone's share sheet. The day and clock words (`dayShown`, `timeShown`, `filledLine`,
  `planShown`) live in core's words, shared with the web. Its commands (`socialcontent.content.save`, `.approve`,
  `.approve_week`, `.post_now`, `.skip`, `.remove`) are online commands; uploads ask `file.begin_upload` and `file.confirm`
  straight away (as an anytime command would only be queued) and put the file in storage between. The screens ask
  again every 20 seconds (the Calendar) and 15 (a post) while open, so a picture being made or a post going up shows
  when it's done.

## Making posts

Part 8 (decisions 13 to 20). The business's own posts, written by the AI from the Playbook and its ideas, on a
**Calendar** page beside the others. Posting them through the extension is parts 9 and 10 (below under "Posting").

- **A Social post is a record** of a kind this add-on manages (`socialcontent_post`, "Social posts"), so its pictures
  are core files on it, it has a timeline and search finds it. What only a post has is its row in
  `addon_socialcontent.content`: the network, format (picture, carousel, video or words only), words, hook, hashtags,
  slides or script, what its picture shows and how it's made, its pictures (file ids, in order), where on Facebook it
  goes, when it goes, and its state (waiting for an OK, OK'd, posting, posted, didn't post, skipped). The kind is made
  when the add-on is turned on; the migration made it for businesses that already had it.
- **The plan** is in Settings → Posting (owners and admins): posts a week on Instagram, Facebook and LinkedIn (0 to
  7; 3, 3 and 2 at first) and a time for each, in the business's time zone. 1 a week lands on Wednesday, 2 on Tuesday
  and Thursday, 3 on Monday, Wednesday and Friday, and so on (`WEEKDAYS_FOR`). Settings also takes the Facebook Page's
  link and where Facebook posts go (the profile, the Page or both), which each Facebook post starts with, and the
  **Fill on its own** switch (below).
- **The Calendar** shows today and the next 14 days, day by day: each post with its picture, title, first line and
  state, and each open day in the plan (a network's day with no post, or only a skipped one) with **Write one**.
  **Fill the calendar** has the worker write a post for every open day from tomorrow on: 5 at a time, 30 seconds
  apart, from saved ideas first, then new ones, then the Playbook alone. After the first fill it tops up once a week
  on its own (`socialcontent.calendar`, re-armed when the add-on is turned back on). **Write a post** takes the next
  open day; **Write the post** on an idea does the same for the idea's network and marks it used.
- **Fill on its own** (the owner, 11 Nov): a switch on the Calendar (web and phone) and in Settings → Posting, on
  until an owner or admin turns it off (`settings.auto_fill`, from `20261027025800_socialcontent_auto_fill.sql`).
  Off, a fill under way stops before its next post, the weekly top-up writes nothing and isn't queued again, and
  Fill the calendar is hidden (`socialcontent_fill_off` if it's asked for anyway); the posts already written stay,
  and Write a post still works. Turned on again, the worker hears `socialcontent.settings.saved` (`fillTurnedOn`)
  and fills the open days right away.
- **Writing** asks Claude for the post in the network's way (Instagram's hook and up to 10 hashtags, Facebook like a
  neighbour, LinkedIn a lesson and a question), as the business, never inventing results, prices or reviews. Its
  answer is checked (`checkedPost`): Instagram never gets words alone, a carousel needs 2 slides, hashtags are kept
  apart from the words, and the AI picks how the picture is made. **Write it again** takes what to change.
- **The AI writes picture posts and words alone, never videos** (the owner, 11 Nov): its formats are `AI_FORMATS`
  (picture, carousel, words only), an idea taken from a video standout becomes a picture or carousel post, and an
  answer that still says video is kept as a picture post. A video post is only ever the person's own, when they pick
  Video on a post. Video drafts the AI wrote before, with no video added, are written again as picture posts on the
  same day by the next fill.
- **The main offer comes first** (the owner's picks of 11 Nov, 4a and 7b; docs/main-offer.md, "For your content"):
  the add-on declares `uses: ['main_offer']`, so Settings → Main offer comes with it. No post or idea is written until
  the offer is live, as in Social Outreach: Write a post, Write it again, Fill the calendar and Suggest ideas are
  refused (`socialcontent_offer_not_live`), the weekly top-up and the nightly ideas write nothing, and the Calendar and
  Ideas hide those buttons and say why, with **Open Main offer** (`offerLive` from `socialcontent.calendar.get` and
  `socialcontent.idea.list`). The research and the Playbook go on. When a version goes live, the worker hears
  `main_offer.published` and fills the calendar at once, if it was filled before and Fill on its own is on.
- **Its information** comes from the business profile from setup (what it sells and who it serves), up to 30 short
  answers from the Knowledge base (FAQs and facts, `businessText`), the live main offer (its parts, never the price)
  and the lists for content (what makes you different, features and benefits, your voice, never say and the rest),
  the Playbook and the idea it's written from. Ideas read the offer and the lists too.
- **Pictures** (decision 14), made in the worker's `socialcontent.pictures` job, one post at a time:
  - **Designed by the AI** (the default for tips, steps, quotes, claims and every carousel slide): Claude picks a
    layout (bold, clean or split), the colours (from the business's colour, kept readable) and the words for each page;
    the worker draws each page as a 1080 by 1350 PNG with Inter. Words are drawn, never left to an image model, so
    they're spelled right; emoji are left out. Charged as the AI's words, like any ask.
  - **Photo-style, by the AI**: OpenAI's image model (`OPENAI_IMAGE_MODEL`, GPT-Image-2.6 Sunburst) makes a lifelike
    picture with no words from the AI's description, cropped to 1080 by 1350. When it's busy, GPT-Image-2.6 Flare
    tries once (`OPENAI_IMAGE_BACKUP_MODEL`); it plans at `medium` (`OPENAI_IMAGE_COMPLEXITY`). Charged 9¢ each on
    the balance (`ai.image`), and only when the balance has room; the charge keeps OpenAI's real cost beside it.
    Without `OPENAI_API_KEY` posts get designed pictures only. See "Photo-style pictures: the image models" in
    docs/operations.md.
  - **Your own**: **Add your photo** uploads to the post's files. A video post needs the person's own video: they
    record it from the script and add it with **Add your video** (up to 25 MB, core's most for a file), which takes
    the place of one it had (part 10). Core's files take MP4, QuickTime and WebM videos for this (`ATTACHMENT_TYPES`,
    and the attachments bucket from `20261027025150_attachments_take_videos.sql`).
    The sheet's **Make it again**, **Switch to designed** and **Switch to photo-style** make it again, with what to
    change. Pressing a picture opens the post's pictures full screen (`PictureViewer`), with arrows or the arrow keys
    between them.
- **The OK** (decision 15). Every post waits for an OK: **OK it** on one, or **OK the week** for every post going in
  the next 7 days that has everything it needs (words, its pictures or 2 slides, a video's own video, a day at least a minute ahead, and on
  Facebook where it goes, with the Page's link when it goes to the Page). What one still needs is shown on the post
  and said by OK the week. Changing an OK'd post takes the OK back; **Skip it** opens its day again.
- **Removing a post** (the owner, 11 Nov: "give me the option to delete a post from the calendar page so when i click
  fill calendar it writes one in to fill it"). An owner or admin presses the bin on a post's row on the Calendar, or
  **Remove** in its sheet (and on the phone's post screen), and says **Remove it** when asked. It comes off the
  calendar for good and never goes up, and its day is open again, so **Fill the calendar** or **Write one** puts a new
  post there. `socialcontent.content.remove` archives its record through core's `custom_record.archive`: an add-on's
  records are never deleted (docs/deleting.md), and archiving is `records.archive`'s, so the team (who can't) still
  has Skip it, and the refusal says so (`socialcontent_remove_forbidden`). A post that went up or is going up can't be
  removed. The Assistant removes one on a Confirm card (`socialcontent_remove_own_post`). It's an online command on
  the phone.

## Posting

Parts 9 and 10 (decisions 15 to 17). An OK'd post goes up at its time from the business's reading computer, in Chrome
with the HandsFreeOS Social extension, while Chrome is open there: Facebook and LinkedIn from 0.132.0, Instagram from
0.133.0. The post's sheet offers **Copy the words** on any network the extension doesn't post on.

- **Each minute, before any reading,** the extension asks for the next post due (`socialcontent.post.next`) on the
  networks it posts on with no warning today. HandsFreeOS hands it the OK'd post whose time has come, soonest first,
  with its words as they go up (`postText`: the words, a blank line, then the hashtags, within what the network
  takes), its pictures (or the person's video, on a video post), the places it still goes, and the Page's link. It's
  taken (`posting`), so it goes up once.
- **Where it goes** (`placesFor`): on Facebook the person's profile, the business's Page, or both, in that order
  (decision 17); on LinkedIn and Instagram their feed. Each place it went up is kept (`posted_to`, with its link when the network
  shows one), so trying again never puts it up twice there.
- **Putting it up** (the extension's `research/posting.ts` and `post-here.ts`): the pictures are fetched from
  HandsFreeOS's storage on the person's own sign-in; the network's box is opened, the words typed, the pictures added
  (its file field, pasting, its photo button with the file picker held back, or dropping them), Next pressed when the
  box asks, then Post. A Facebook Page's post goes through Meta Business Suite's Create post for the Page, so the
  person's profile is never switched to the Page while Social Outreach works as them; a tick for Instagram there is
  turned off. Its link comes from the network (LinkedIn's View post), else from the top of the profile, the Page or
  their own posts by its first words.
- **Instagram** (part 10): **Create** on its home page (then **Post** when it asks which kind), the pictures or the
  person's video into Create new post, **OK** when it says a video goes up as a reel, **Next** past cropping and
  editing, then the words in the caption box and **Share**. Its link comes from the person's own newest posts, as
  Instagram's page asks for them, by its first words.
- **How it went** (`socialcontent.post.went`): up everywhere is **Posted**, with **See it on your profile**, **your
  Page** or **LinkedIn**; any place that didn't take it is **Didn't post**, saying why and where. A network's warning
  before anything was pressed stops posting and reading there for the day, for both social add-ons, and the post goes
  back to waiting.
- **Never twice:** once Post is pressed in a place it's never pressed there again on its own. One taken that hasn't
  said how it went within 20 minutes is marked as didn't post ("it may have gone up"), never retried. One still
  waiting a day past its time (the computer was off) is marked as didn't post too.
- **Post it now** (`socialcontent.content.post_now`, risk 2: the Assistant asks first) puts an OK'd post, or one that
  didn't post, up now: its time becomes now, and it counts as the OK. Places it already went up in are left out.
- **The Calendar** says how many are OK'd and going up, whose computer puts them up, and warns when none is picked or
  it hasn't checked in for 10 minutes (`postingLines`, shared with the phone).
- **When a place doesn't work,** a problem report goes to Admin → Problem reports with job `post.profile`,
  `post.page` or `post.feed`: what the hands did, step by step, and the page's outline. Never a name.

## Its own posts' numbers

Part 11 (decision 19). About 2 and 7 days after a post went up, the reading computer reads its numbers in each place
it went up with a link, from 0.134.0 of the extension; at 7 days it's weighed against the business's own other posts
there, and one that did well goes into the Playbook beside the creators' standouts.

- **When** (`nextCheckAt`, `checkDue` in `own.ts`): going up sets `checks_due_at` for 2 days after it first went up
  anywhere; once every place has its 2-day read, for 7 days; then none. A 2-day read missed until the 7th day is left
  out, and the 7-day read takes its place. Only places that went up with a link are read.
- **Each minute, after posting,** the extension asks for the next post whose read is due (`socialcontent.own.next`,
  reader only), on the networks it posts on with no warning today. It's put off half an hour as it's handed out
  (`OWN.takenMs`), so a read never answered is simply asked again; reading twice changes nothing.
- **Reading** (the extension's `research/own.ts`): it opens the post by its link. On Instagram it reads the post's own
  answer by the number in its link (views on a video, likes, comments, shares), as a creator's post is read; on
  Facebook and LinkedIn the post's own page by the network's reader (reactions as likes, and comments: neither shows
  views or shares there). A warning stops it there for the day, for both social add-ons, with nothing said.
- **What it showed** (`socialcontent.own.read`): kept by place and read in `numbers`, each read once; a place that
  couldn't be read keeps why. The post's sheet shows **How it did** ("After 2 days: 1,240 views · 86 likes"), and the
  Calendar lists **Went up lately** (the 30 days before its days) with each post's latest line (`numbersLines`,
  shared with the phone).
- **Doing well** (`ownDoneWell`): at the 7-day read each place is weighed against the business's own posts there with
  their 7-day numbers, by the same rule as a creator's standouts (`STANDOUT`: 2 times the middle of up to 10 on each
  side, at least 4 that show the same number, and the least numbers a standout needs). The best place is kept
  (`done_well`), and `socialcontent.content.done_well` has the worker write the Playbook again, from the creators'
  noted standouts and up to 10 of the business's own posts that did well (`<own_posts>`, examples `O1`…), shown as
  **Your post** among its examples.

## When a read goes wrong

The same help Social Outreach's steps get (decision 142 in docs/outreach.md), for a read instead of a step:

- When the reading computer can't read a creator's profile or posts, or a search, its tab sends a view of the page
  (one numbered line per thing on screen, everything a person wrote hidden as "[2 words]") to the worker's
  `socialcontent.helper.look`. The AI sorts it (in the way, moved, refused, a warning, unclear) and takes one move at
  a time to clear the way: a pop-up's Close, Escape, a scroll, a wait. Never a press, a sign-in, a follow or a like
  (core's `mayClear`, and `checkedReadLook` here).
- When it cleared something, the read is tried once more. Otherwise a problem report goes to Admin → Problem reports
  with addon `socialcontent` and job `read.find`, `read.profile` or `read.posts`: the network's answer's status and
  the names of its parts, the page's outline and what the helper said and did. Never a name. A warning or a refusal
  is sorted as the network's limit; the rest need a fix, and the fix-it check reads them like any other.
- The work says why it failed in words the business reads on Settings → What it's doing. Signed out, or a page it can't
  read, rests that network's reading for 30 minutes; a warning stops it for the day for both social add-ons.

## Rules worth knowing before changing anything

- **One extension for both social add-ons, never mixing them** (decision 1). It does this add-on's work only where
  it's on, and only through `socialcontent.*` operations. The pace on each network and a network's "stopped for the
  day" belong to the extension (the same browser, the same account), not to either add-on's tables, so add-ons never
  share data. It stays loaded by hand, never a Chrome Web Store extension.
- **Everything is read through the extension** (decision 3): no network's API and no paid data service. On
  Instagram it reads the answers Instagram's own pages load, asked for from inside its reading tab on the person's
  signed-in account, after opening each page as a person would, at a person's pace (6 to 12 seconds between pages, 3
  to 7 between answers, at most 400 a network a day, of which searches use at most 300). On Facebook and LinkedIn, which load no such answers, it reads
  the pages themselves with the extension's own readers (Social Outreach's), scrolling as a person does: the post
  search, then the people (Facebook: pages) search, for creators; a profile; and someone's posts (a Facebook profile
  itself, a LinkedIn member's recent activity). Neither network shows a post's views to others, so their standouts
  go by reactions plus comments. A LinkedIn post's time comes from its own number.
- **A post is judged against its neighbours, never the creator's best ever.** Followers and engagement grow, so the
  owner's rule is the posts around it: 5 posts where one has 100 likes and comments and the rest 20 to 50 makes the
  100 the one to learn from. The middle number (median) is used so one other big hit nearby doesn't hide a standout.
  A post needs at least 4 neighbours showing the same number, and at least 10 likes and comments or 500 views; posts
  under 7 days old wait and aren't anyone's neighbour. The numbers live once, in `STANDOUT`.
- **The server keeps the standout answer; screens only show it.** It's worked out again for all of a creator's posts
  on every save, since each post's neighbours change.
- **Creators are research, not customers.** They live in the add-on's own tables, never as people or records, and
  nothing here messages them.
- **One list per business** (decision 12): anyone who uses the add-on picks niches and creators; owners and admins
  (`socialcontent.manage`) pick the networks and whose computer reads, and that person must be able to use the add-on.
- **Only the reading computer takes work and saves what it read** (`socialcontent_not_reader` for anyone else). The
  queue holds one open job of a kind about the same thing at a time (a partial unique index), so asking twice never
  reads twice.
- **Only networks the extension reads can be picked** (`CONTENT_NETWORK_INFO[n].ready`: Instagram, Facebook and
  LinkedIn). The rest show as coming later (decision 2). LinkedIn's creators are read weekly and monthly on their own,
  like the others (the owner's pick, 8 Nov).
- **Nothing the business posts goes up without a person's OK** (decision 15). The AI writes drafts; OKing one is risk
  2, so the Assistant asks first. Changing an OK'd post takes its OK back. The worker writes posts and pictures only
  through its own commands (`socialcontent.content.put`, `.pictured`), which make the record through core's
  `custom_record.create`, so the system may run that command (and `custom_record.update`) for an add-on.
- **Every post and idea is built on the main offer and its lists** (`OFFER_FOR_CONTENT`, in both `WRITE_SYSTEM` and
  `IDEAS_SYSTEM`): they're quoted as data in their own blocks, the price is never quoted, and never say is a hard
  rule. Nothing is written until the offer is live; the add-on reads the offer and never writes it.
- **Words on pictures are drawn by the worker, never by an image model** (decision 14): OpenAI's pictures are asked
  for with no words in them.
- **A post goes up once in each place** (part 9). Once Post is pressed in a place it's never pressed there again on
  its own; one that may have gone up is the person's to look at, and Post it now leaves out the places it went up in.
- **A Page's post never switches the person's profile:** it goes through Meta Business Suite, so Social Outreach,
  working at the same time, stays the person.
- **The business's own posts are weighed only against its own** (part 11): in the same place, by their 7-day numbers,
  never against creators', so a small business's good post counts as one.
- **Watching videos is opt-in** (decision 9, part 4): a switch that starts off, a notice that it uses more AI, and a
  way to try it on a few videos first. Only networks marked `watches` are watched (Instagram). The video is fetched
  only from Instagram's video servers, and the worker takes a watch only from the reading computer, for work it took.

## Not yet

- Videos over 25 MB: core's most for a file. A longer video needs making smaller first (phones offer it when
  sharing).
- Posting's boxes are built from the networks' usual words and roles, not yet from page outlines of them: the first
  problem reports (`post.*`) will say what to fix.
- Reading a Facebook or LinkedIn post's shares and views: neither shows them on the post's own page.
- Removing a post's older AI pictures: a picture made again replaces them on the post, but the old files stay among
  its files, since deleting a file is a person's step.
- TikTok and YouTube (part 7).
- LinkedIn company pages' posts (members' posts are read), and watching Facebook's and LinkedIn's videos.
