# AI Social Media Content Creator

An add-on (`socialcontent`) that studies creators in the business's niche and niches like it, finds the posts that did
far better than the posts around them, and (from part 3) works out why, so the business can plan its own content.

The owner's decisions and the build order are in `HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md`; the numbers
below (decision 1, and so on) are its decisions. Part 1 is built: the add-on, its tables, the standout math, the work
queue and the web pages. The extension starts reading Instagram in part 2, so until then nothing fills the queue's
work on its own. The add-on is in `development`, offered to nobody.

## Where things are

| What                                                     | Where                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| The manifest, its permissions, events and pages          | `packages/core/src/addons/socialcontent/manifest.ts`                      |
| The tables (and their Drizzle mirror)                    | `supabase/migrations/20261027023800_addon_socialcontent.sql`, `tables.ts` |
| Which posts stand out, and who has done well             | `standouts.ts` (pure; web, phone and server all use it)                   |
| Reading a link to someone's page, and each network       | `networks.ts`                                                             |
| The pages' words                                         | `words.ts`                                                                |
| What the AI is asked about niches, and how it's checked  | `niches-ai.ts`                                                            |
| People's operations: settings, niches, creators, posts   | `ops/research.ts`                                                         |
| The extension's operations: take work, save what it read | `ops/reading.ts`                                                          |
| The worker's operations: niches, searches, the schedule  | `ops/worker.ts`, and `apps/worker/src/addons/socialcontent/`              |
| The web pages                                            | `apps/web/src/addons/socialcontent/`, routes under `a/socialcontent/`     |
| The Assistant's checklist for its screens                | `packages/core/src/assistant/ledger/socialcontent.json`                   |

## How it works

- **Niches.** **Suggest niches** has the AI read the business's profile and knowledge base and name its own niche
  (kept ticked when there isn't one yet) and 3 to 5 like it, each with why and the words to search each network for
  creators in it. A suggested niche waits for someone to tick it (**Search it**) or **Skip** it. Anyone can add one;
  the AI then writes its searches (`socialcontent.niche.added`), and when it can't, the niche's own name is searched.
- **Finding creators.** Once a month, and on **Find creators now**, each ticked niche is searched on each network
  studied. The reading computer reads each creator's profile: those with 5,000+ followers who posted in the last 30
  days are **Suggested** to tick; the rest are kept as not fitting, so they aren't read again (decisions 4 and 5).
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

## Rules worth knowing before changing anything

- **One extension for both social add-ons, never mixing them** (decision 1). It does this add-on's work only where
  it's on, and only through `socialcontent.*` operations. The pace on each network and a network's "stopped for the
  day" belong to the extension (the same browser, the same account), not to either add-on's tables, so add-ons never
  share data. It stays loaded by hand, never a Chrome Web Store extension.
- **Everything is read through the extension** (decision 3): no network's API and no paid data service.
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
- **Only networks the extension reads can be picked** (`CONTENT_NETWORK_INFO[n].ready`; Instagram for now). The rest
  show as coming later (decision 2).
- **Watching videos is opt-in** (decision 9, part 4): a switch that starts off, a notice that it uses more AI, and a
  way to try it on a few videos first.

## Not yet

- The extension's reading (part 2), the AI's notes, the Playbook and the ideas (part 3), watching videos (part 4), the
  phone's pages (part 5), Facebook and LinkedIn (part 6), TikTok and YouTube (part 7).
