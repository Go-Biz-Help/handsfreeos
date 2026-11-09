# AI Social Media Content Creator

An add-on (`socialcontent`) that studies creators in the business's niche and niches like it, finds the posts that did
far better than the posts around them, and works out why, so the business can plan its own content.

The owner's decisions and the build order are in `HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md`; the numbers
below (decision 1, and so on) are its decisions. Built: the add-on, its tables, the standout math, the work queue and
the web pages (part 1); the extension reading Instagram, with the AI helper and problem reports when a read goes wrong
(part 2); the AI's notes, the Playbook and ideas (part 3); watching Instagram videos, opt-in (part 4); and reading
Facebook and LinkedIn (part 6). The add-on is in `development`, offered to nobody; staff give it to a business from
Admin → Businesses.

## Where things are

| What                                                     | Where                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| The manifest, its permissions, events and pages          | `packages/core/src/addons/socialcontent/manifest.ts`                        |
| The tables (and their Drizzle mirror)                    | `supabase/migrations/20261027023800_addon_socialcontent.sql`, `tables.ts`   |
| What the reading computer is doing (`work.progress`)     | `supabase/migrations/20261027023900_socialcontent_progress.sql`             |
| Which posts stand out, and who has done well             | `standouts.ts` (pure; web, phone and server all use it)                     |
| Reading a link to someone's page, and each network       | `networks.ts`                                                               |
| The pages' words                                         | `words.ts`                                                                  |
| What the AI is asked about niches, and how it's checked  | `niches-ai.ts`                                                              |
| People's operations: settings, niches, creators, posts   | `ops/research.ts`                                                           |
| The extension's operations: take work, save what it read | `ops/reading.ts`                                                            |
| The worker's operations: niches, searches, the schedule  | `ops/worker.ts`, and `apps/worker/src/addons/socialcontent/`                |
| What the AI helper is asked about a read, and its check  | `helper.ts`, and the worker's `apps/worker/src/addons/socialcontent/`       |
| What the AI is asked about standouts, and its checks     | `notes-ai.ts`; the asks run in the worker's `socialcontent/notes.ts`        |
| The Playbook, ideas and Try watching                     | `ops/notes.ts`                                                              |
| The extension's reading                                  | `apps/extension/src/research/` (its README's 0.127.0 section)               |
| Instagram's reads, and Facebook's and LinkedIn's         | `instagram-read.ts`; `page-read.ts`                                         |
| Watching a video in the reading tab                      | `apps/extension/src/research/watch.ts`                                      |
| The web pages                                            | `apps/web/src/addons/socialcontent/`, routes under `a/socialcontent/`       |
| What it's doing, on the Creators page                    | `activity-card.tsx` there; the extension's `Progress` in `research/read.ts` |
| The Assistant's checklist for its screens                | `packages/core/src/assistant/ledger/socialcontent.json`                     |

## How it works

- **Niches.** **Suggest niches** has the AI read the business's profile and knowledge base and name its own niche
  (kept ticked when there isn't one yet) and 3 to 5 like it, each with why and the words to search each network for
  creators in it. The own niche is the field the business itself is in, as a creator in that field posts about it
  (what it makes, sells, does or teaches), never its customers' trade: a CRM and automation company's is like "AI, CRM
  and automation", not its customers' "home services" (the owner's ask, 9 Nov 2026). At most one of the others is
  about the customers' world, and its why says so. A skipped own niche gives way to the next suggestion's: only an own niche that isn't skipped counts as
  the business having one (`hasOwnNiche`). A suggested niche waits for someone to tick it (**Search it**) or **Skip** it. Anyone can add one;
  the AI then writes its searches (`socialcontent.niche.added`), and when it can't, the niche's own name is searched.
- **Finding creators.** Once a month, and on **Find creators now**, each ticked niche is searched on each network
  studied. The reading computer reads each creator's profile: those with 5,000+ followers who posted in the last 30
  days are **Suggested** to tick; the rest are kept as not fitting, so they aren't read again (decisions 4 and 5).
  On Instagram, whose hashtags' pages send to its search page now, a search reads who posted what that page shows;
  when its answers show nobody, what the page holds itself (its own data, the answers it loaded), then its grid,
  which draws only on screen, so it's read in front only while the person is away (decision 120). A search that
  showed nobody at all ends saying so, with a problem report, never as done with nobody. When Instagram's answer for
  a profile, or for its posts, says it isn't there, the profile page itself is read (the data it came with, then its
  description for followers and name). Profiles that still wouldn't open are counted (**Couldn’t open N profiles**),
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
  computer takes work, oldest first, one at a time; what it took and never finished goes back to waiting after 2
  hours, and anyone can **Stop** what hasn't finished.
- **Notes on standouts** (part 3, decision 10). When saved posts bring new standouts, the worker's notes job runs a
  minute later (once per business): up to 15 standouts with no notes, 5 to an ask, each shown to the AI beside the
  posts around it that did about normal. Each note says why it worked, its hook, format and topic, the techniques
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
  to 7 between answers, at most 400 a network a day). On Facebook and LinkedIn, which load no such answers, it reads
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
- **Watching videos is opt-in** (decision 9, part 4): a switch that starts off, a notice that it uses more AI, and a
  way to try it on a few videos first. Only networks marked `watches` are watched (Instagram). The video is fetched
  only from Instagram's video servers, and the worker takes a watch only from the reading computer, for work it took.

## Not yet

- The phone's pages (part 5), TikTok and YouTube (part 7).
- LinkedIn company pages' posts (members' posts are read), and watching Facebook's and LinkedIn's videos.
