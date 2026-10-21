# Search everything

The box at the top of the side menu is **Search everything** (⌘K, or Ctrl K): contacts, companies, leads, money, messages,
the calendar, tasks, notes, files and the words inside them, forms and their answers, knowledge, a business's own kinds
of records, add-on records, settings, archived records and the Deleted bin, each only for people who may see it. The
plan, its decisions and its build order are in `HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md`; the boards are in
`design/search`.

**Where it stands (2026-10-21):** built, all ten stages of the plan, and on for every business, on the web and the
phone together: the side menu's box with its dropdown and ⌘K, the Search page, the phone-width header's search
outside the Inbox, the phone's Search button in its top bar, Search settings at the top of Settings on both, and
Real Estate's groups through core's contract for add-ons. `/customers?q=` still filters Contacts, as it always has.
Its two migrations, `20261027009700_search_windows.sql` and `20261027009800_file_texts.sql`, go on the hosted
database before it reaches `main` ("Apply new migrations", docs/operations.md). One call is still Chris's: the box's
400 ms target (What it costs, below).

## Where things are

| What                                  | Where                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The queries                           | `packages/core/src/queries/search.ts`: `search.everything` (the box and the Search page) and `search.kind` (one kind, a page at a time)                                                                                                                                                                                       |
| Their shapes                          | `packages/core/src/schemas/search.ts`                                                                                                                                                                                                                                                                                         |
| Running a search                      | `packages/core/src/search/server/run.ts`: which kinds run, `step`, the budgets, the archived split, close matches, paging                                                                                                                                                                                                     |
| Each kind's SQL                       | `packages/core/src/search/server/kinds/<kind>.ts`, listed in `kinds/index.ts`; shared fragments (`LIVE_PERSON`, `RECORD_READS`, `numberMatches`, `archivedRule`, the windows) in `search/server/sql.ts`                                                                                                                       |
| What results open onto                | `activity.get` (`queries/activity.get.ts`), `task.list`'s `taskId`, `conversation.thread`'s `upTo`                                                                                                                                                                                                                            |
| Shared logic, for the server and apps | `packages/core/src/search/`: `probes` (what was typed), `kinds` (each kind's gate), `rank`, `snippet` (marks), `close`, `href`, `dropdown` (and `nobodyActive`), `lines` (and a note's `noteLines`), `words` (and `badgeTone`), `recent` (recent searches), and `fold` (accents)                                              |
| Document numbers                      | `documentNumberProbe` and `documentNumberMatches` in `packages/core/src/money/numbering.ts`                                                                                                                                                                                                                                   |
| Add-ons answering                     | `packages/core/src/search/addon.ts` (`AddonSearchInput`, `AddonSearchOutput`, an add-on's kinds and the links let through); `search/server/addons.ts` (which add-ons answer, asking each, holding its answer to core's rules, `addonSearchIssues`); `executeQueryWithin` in `kernel/execute.ts`; `route: false` on `QueryDef` |
| The API's guards                      | `apps/api/src/routes.ts` (rate limits, and each search inside a slot) and `apps/api/src/search-slots.ts` (the slot gate)                                                                                                                                                                                                      |
| The database                          | `supabase/migrations/20261027009700_search_windows.sql`: `private.search_fold`, the windows' indexes, and `form_answers_follow_response`                                                                                                                                                                                      |
| The words inside files                | `supabase/migrations/20261027009800_file_texts.sql` (`app.file_texts`, `private.search_words`, the forget trigger, `private.files_without_text`); `file.save_text` (`commands/file-text.ts`)                                                                                                                                  |
| The worker's file reader              | `apps/worker/src/files/file-text.ts` (the job, the sweep, `FILE_READER`) and `office-text.ts` (Word and Excel); `pnpm --filter @hfos/worker run files:read-backlog` lists what's left to read                                                                                                                                 |
| Tests                                 | `packages/core/test/search/` (the kinds, the gaps, who sees what, limits, plans, what results open, and the pure ones); `packages/core/test/addons/search-contract.test.ts` and `test/execute-query-within.test.ts` (add-ons answering); `apps/api/test/search-*.test.ts`; `packages/db/test/search-*.test.ts`                |
| The load check                        | `scripts/search-load.mjs`, local stack only (What it costs, below)                                                                                                                                                                                                                                                            |
| Settings search                       | `packages/core/src/settings/`: `pages` (the Settings menu), `catalog` (every setting), `search` (`searchSettings`, links, grouping, the main search's Settings group), `words`                                                                                                                                                |
| Settings search on the web            | `apps/web/src/components/settings/`: `settings-search.tsx` (the box), `use-setting-highlight.ts` (the jump and its ring), `setting-anchor.tsx` (`SettingAnchor`, `settingAttrs`), `SetRow`'s `setting`                                                                                                                        |
| Settings search on the phone          | `apps/mobile/src/settings/`: `settings-search.tsx` (the results), `use-setting-flash.ts` (scrolling to a row and flashing it); `ListRow`'s `settingKey`                                                                                                                                                                       |
| Its tests                             | `packages/core/test/settings-catalog.test.ts`; `apps/mobile/src/settings/__tests__/settings-search.test.tsx`; `apps/web/e2e/settings-search.spec.ts`                                                                                                                                                                          |
| Why a row matched                     | `packages/core/src/search/explain.ts`: each kind's tier and reason, one copy for the server's searchers and the phone's own search                                                                                                                                                                                            |
| The phone's own search                | `packages/core/src/search/copy.ts` (`searchCopy`, over the rows a phone keeps); `packages/core/src/crm/search-text.ts` (the search text a phone works out, for its pickers too)                                                                                                                                               |
| Search on the phone                   | `apps/mobile/src/app/app/w/[workspaceId]/search.tsx` (the screen); `apps/mobile/src/search/`: `use-search.ts`, `copy-sql.ts`, `recent.ts`, `rows.tsx`; `FilterChip` in `components/ui`                                                                                                                                        |
| Where a phone opens a result          | `apps/mobile/src/links/route-map.ts` (`/search#q=…`, forms, `?task=`, `?message=&at=`, `?activity=` and `?compose=`); Real Estate's deals offline: `apps/mobile/src/addons/realestate/search.ts`                                                                                                                              |
| The phone's tests                     | `packages/core/test/search/copy.test.ts`; `apps/mobile/src/search/__tests__/`: `copy-sql.test.ts`, `search-screen.test.tsx`, `entry-points.test.tsx`; `apps/mobile/src/links/__tests__/route-map.test.ts`; Maestro's `apps/mobile/maestro/search.yaml`                                                                        |
| The web's Search page                 | `apps/web/src/app/app/w/[workspaceId]/search/page.tsx` (the frame), `components/search/search-page.tsx` (everything) and `kind-page.tsx` (one kind)                                                                                                                                                                           |
| The web's box and dropdown            | `apps/web/src/components/search/`: `search-provider.tsx` (⌘K, recent searches), `search-box.tsx`, `use-search.ts`, `panel.tsx`, `highlight.tsx`, `rows/` (a row per kind); `lib/keys.ts` (`isMac`)                                                                                                                            |
| Where results open on the web         | The pages themselves follow their own part of the address: the inbox's thread, Tasks, a form, the timeline, the Files grid, a record page's tab (`lib/use-record-tab.ts`), a contact's page, the Deleted bin and Contacts (The web's screens, below)                                                                          |
| The web's tests                       | `apps/web/e2e/search.spec.ts`: the box and its keys, the Search page by its address, and what each result opens onto; `search.mobile.spec.ts`: a phone-width screen's header and the Inbox's sheet                                                                                                                            |
| Where search opens from               | Web: the side menu's box (`shell/sidebar.tsx`), the phone-width header (`shell/mobile-shell.tsx`), the layout filling `SearchProvider`. Phone: `AppBar`'s `search`, `searchScreenHref` (`search/href.ts`) and `SearchEverythingRow` (`search/rows.tsx`), last in Contacts' and Inbox's boxes                                  |

## The pieces

- **Two queries.** `search.everything` reads every kind at once, a few of each: the box asks at `quick` depth, the
  Search page at `full`. `search.kind` reads one kind a page at a time, with its sorts. People only, under
  `workspace.read`; nothing is written, and the AI has no search tool. Both are in the phone contract, so their
  inputs only ever grow.
- **A searcher for each kind** (`search/server/kinds/`): its candidates read as the person, through `step`, then the
  winners' facts. Its gate is in `SEARCH_KINDS`, never in the searcher (The kinds, below).
- **Core's shared logic** (`search/`, browser-safe): what was typed (`searchProbes`), the tiers and why each hit
  matched (`rank`, `explain`), marks and snippets, close matches, links, the dropdown's choices and grey lines, the
  words, and the fold. The server, the web and the phone run this one copy.
- **The add-ons' contract**: an add-on whose manifest has `search` answers with groups of its own, through one
  `route: false` query that core runs after its own kinds. Real Estate is the first.
- **The API's guards**: a rate limit a person on each query, and a slot gate on each machine (How a search runs,
  below; docs/operations.md has them for running the API).
- **Two migrations**: `20261027009700_search_windows.sql` (the fold, the windows' indexes, and a binned response's
  answers hidden) and `20261027009800_file_texts.sql` (a file's words and who may read them). No new extension, no
  text index, no column on a table phones copy, and no sync change.
- **The worker's file reader**, which keeps the words inside text PDFs, plain text, CSV, Word and Excel files for
  Files to find.
- **The web**: the box at the top of the side menu with its dropdown and ⌘K, and the Search page at `/search#q=…`,
  with what's typed only ever after `#` (The web's screens, below).
- **The phone**: a full-screen search from the top bar, asking the server with signal and searching its own copy
  without (The phone, below).
- **Settings search**: core's catalogue of every setting, searched on the device, from Settings in both apps and as
  the main search's Settings group (Settings search, below).

## How a search runs

1. **The client** waits for 2 characters and a pause, and sends what was typed in the body of
   `POST /v1/queries/search.everything` (or `search.kind`), never in a path or a query string.
2. **The API** counts the person's searches (90 a minute for everything, 60 for one kind, `search_too_fast` past
   that), then waits up to a second for one of the machine's 3 search slots (`search_busy` when none comes free).
3. **The kernel** opens the person's transaction under row security and checks `workspace.read`. People only; the AI
   has no search tool.
4. **`runSearch`** works out the probes once (`searchProbes`: the words, folded and escaped; a phone in E.164; an
   email; a web address's domain; a document number and its counter; an amount only when it reads as money), and
   answers too short (under 2 characters, or nothing with a letter or a digit) with no SQL at all.
5. Each kind the person may search runs its candidates through **`step`**: its own savepoint and a statement timeout
   cut to what's left of the budget (quick 2 s a request and 1.5 s a statement, full 6 s and 4 s, one kind 8 s and
   5 s; never under 50 ms). A kind reads up to 101 rows, enough to say "100+"; long text is read in a window of the
   business's newest rows (The kinds).
6. **Each add-on that answers searches** (its manifest's `search`) and runs here is asked next, for someone holding
   its permission, in a step of its own held to 1.5 s (3 s on a page). Whatever it answers, or a line saying it
   couldn't be searched, joins core's groups; a kind of records it covers leaves core's group only when it answered
   for every kind it has, and that kind's archived records still go under Archived.
7. **Core's JavaScript ranks** them (`rankHits`: tier, open before finished, newest), says why each matched, splits
   archived records out to Archived, and keeps the first few.
8. **Close matches** run only when nothing matched (the Deleted bin, Archived and the add-ons included), every kind
   and add-on answered, no setting matched on the device, and a word has 4 or more letters; with chips picked, only
   over those kinds.
9. Only then are the winners' facts read, through `step` again: whether a contact is a client, their open lead, a
   company's people, a record's own fields. A step that fails here marks its group, never the search.
10. The groups are ordered (decision 33), the best match picked, and each hit given its link. Nothing is written.

## The kinds

Each kind's gate is in `SEARCH_KINDS` (`search/kinds.ts`); row security decides every row underneath it.

| Kind          | Needs            | Finds                                                                                                                                                                                                                                                               | Reads                                                                                                       |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Contacts      | `records.read`   | names (folded), every phone and email, the address, the company, the business's own fields                                                                                                                                                                          | the whole business                                                                                          |
| Companies     | `records.read`   | name (folded), website, emails, phones, address                                                                                                                                                                                                                     | the whole business                                                                                          |
| Leads         | `records.read`   | title (folded), the customer's or company's name                                                                                                                                                                                                                    | the whole business                                                                                          |
| Money         | `money.read`     | estimates and invoices by number, amount, title, notes and customer; payments by amount, card, invoice or customer                                                                                                                                                  | the whole business                                                                                          |
| Messages      | `inbox.use`      | a thread's counterpart exactly; who it's with (customer, chat visitor, Meta name and @handle), folded; a text's number, its digits, or an email's address (never our own keys for chat, portal and Meta threads); its last preview; message words; call transcripts | threads 3,000 or 180 days / 20,000 or 3 years; messages 4,000 / 25,000; calls 2,000 / 10,000, the same days |
| Calendar      | `workspace.read` | an attendee's phone or email exactly; the title (folded); the address, who's coming (folded); the notes                                                                                                                                                             | the whole business                                                                                          |
| Tasks         | `records.read`   | title (folded), notes                                                                                                                                                                                                                                               | the whole business                                                                                          |
| Notes         | `records.read`   | the words of note lines (`NOTE_LINES`), then the name of who they're on (folded)                                                                                                                                                                                    | 3,000 / 20,000 note lines                                                                                   |
| Files         | `records.read`   | names (folded); the words read inside text PDFs, plain text, CSV, Word and Excel files, split as `searchWords` splits a search, with the page or sheet they're on                                                                                                   | names, the whole business; words 1,000 / 10,000 files with words, the ones read most recently               |
| Forms         | `workspace.read` | form names (folded); answers of completed responses, then who answered (folded)                                                                                                                                                                                     | names, the whole business; answers 3,000 / 20,000                                                           |
| Knowledge     | `workspace.read` | knowledge items, through knowledge's own search                                                                                                                                                                                                                     | its own 20 at most                                                                                          |
| Own kinds     | `records.read`   | a record's name (folded) and fields, a group per kind                                                                                                                                                                                                               | the whole business                                                                                          |
| Spam          | `inbox.use`      | as Messages, in the Spam folder, only when picked                                                                                                                                                                                                                   | as Messages                                                                                                 |
| Archived      | the kind's       | archived contacts, companies, leads, threads, forms and records, by name or title only; the page says how far back the threads window looked                                                                                                                        | with the kind                                                                                               |
| Deleted bin   | `records.delete` | each item's name                                                                                                                                                                                                                                                    | the whole business                                                                                          |
| Close matches | `records.read`   | contact, company, lead and record names within an edit or two, only when nothing else matched                                                                                                                                                                       | 300 names that look alike                                                                                   |
| Add-on groups | the add-on's own | whatever its own search query finds, only while it runs: Real Estate's Listings, Deals, Homes and Properties (below)                                                                                                                                                | the add-on's                                                                                                |

**Real Estate's groups** (`realestate.search` in `packages/core/src/addons/realestate/ops/search.ts`, tested in
`test/addons/realestate-search.test.ts`), for whoever holds Work on deals while it runs: **Listings**, a listing by its
home's address (the property record's name) or by its MLS number exactly (tier 0, "MLS number"); **Deals**, a deal by
its name or fields, its client's name ("Client") or its home's address ("Address"), as the Deals list searches;
**Homes**, a home on a buyer deal by its address, opening the deal's Homes at it; and **Properties**, a property by its
address or fields when no listing in the answer is on it. A deal or a property found by a field says which field, as
core's group of records does. A listing's own deal and its property are left to the listing whenever the answer shows
it, however they matched, so each shows once; a kind's own page of deals or properties leaves them out too, so it holds
what its group counted, while chips naming Deals or Properties without Listings keep them. It reads all four in one
statement, as the person: a private deal, its listing and its homes stay with its people, an archived deal and what
hangs off it come back only with Include archived (core's Archived lists the record by name otherwise), and Only mine
keeps to the deals the person is on (the Deals list's Mine) and the properties they added. Its `covers` takes core's
groups of deals and properties out whenever it answered; someone without Work on deals still finds them there.

A window is the box's (quick) or the Search page's and a kind's own page's (full). A windowed group says whether it
looked at everything (`complete`) and, when it didn't, how far back it went (`searchedBack`, to the microsecond).
**Look further back** passes that as `before`, and the next window reads what's at or before it: a window ends at the
time of the first row it couldn't hold, so the rows sharing that time (a form response's answers) are read whole by
the next one.

## The web's screens

**The Search page** is `/search#q=…&kind=…&archived=1&mine=1&sort=…&show=leads|clients&before=…`. The route renders
the frame only: it reads no `searchParams` and asks the API for nothing (decision 37). What the Settings group needs
(the business's name, clock and settings, and whether the person is staff or runs an agency) comes from the layout's
`SearchProvider`, which the business's layout fills from what it already asks for, plus `workspace.get` for the
settings (a hint: without it a setting is found without its value). The page reads the
fragment off `window.location.hash` when it opens and on `hashchange` and `popstate`, writes it back with
`history.replaceState` 300 ms after typing stops (a new kind, or a new sort, is a `pushState`, so Back undoes it), and
asks `search.everything` (the full window, 4 a kind) from the browser. A browser never sends what's after `#`, so
what's typed never reaches the web's own server or its host's logs; `search.spec.ts` checks every request the page
makes to it.

- **Everything**: a card for each kind found, in core's order, the kinds list beside them with counts and "Nothing in
  Knowledge." for the kinds that found nothing, a running add-on's among them (never the Deleted bin when it found
  something, nor a kind that didn't answer, which has its own line and Try again, nor the kinds of an add-on that
  couldn't be searched); tasks and notes share one card when together they have 4 or fewer.
  Settings, Archived and the Deleted bin come last. "Show 3 more contacts" reads that kind's first page in place, for
  that answer only; "Only contacts" opens the kind. Close matches have a page of their own too: `search.kind` with
  `close` reads every kind's names, in close matches' own order, and the box's Close matches chip asks for them alone. The line at the top (close matches, nobody active, nothing at all) is core's
  `dropdownOf`, decided after the device's Settings group is merged in, as in the box; a Deleted bin that wasn't
  searched counts among the kinds that didn't answer, with its own line, so neither nobody active nor nothing at all
  shows beside it. Nobody active is one rule (`nobodyActive`) for the server's `noneActive` and the dropdown.
- **One kind** (`kind=`): `search.kind` 50 at a time with Show 50 more; contacts get All · Leads · Clients, Sort and a
  table (name, phone, email, where, last contact), and the banner when two share a number or an email, whose Compare
  and merge (for `records.archive`) opens Merge with the other record chosen. A windowed kind, and Archived for its
  threads, says how far back it looked, and Look further back adds the older window's results; Messages can Look in
  Spam. A kind that didn't answer (an add-on's that failed) shows its line with Try again, and no count. Settings' own page is the device's whole answer. Counts read in each kind's own nouns: "1 contact named
  “dana”", "2 things in the Deleted bin for “tom becnel”" (core's `kindNoun`).
- **The box and its dropdown** (`search-box.tsx`, `panel.tsx`) sit at the top of the side menu, inside the layout's
  `SearchProvider`: the chips, the best match with Call and Text, a few groups, Exact match and "Also has 1042 in
  it", Also found, Archived and the bin when little else matched, ⌘K (Ctrl K) and the keys of "Keyboard" in the plan.
  ⌘K focuses the box wherever the side menu is drawn (from `md`); below it, it opens the Search page with its own box
  focused. The box asks only while its panel is open. A chip asks for its kind alone: the Settings group shows with
  no chip picked, or Settings itself. Recent searches stay in `localStorage` under the signed-in person and the
  business, kept by core's rule (`search/recent.ts`, as the phone keeps its own: at most 8, the same words searched
  again moving up whatever their case or accents), shared by the box and the Search page through the provider, which
  removes anyone else's when it mounts; signing out removes them all.
- **On a phone-sized screen** the header's search button opens the Search page, titled "Search" with Back, except
  in the Inbox, where it keeps its sheet that searches conversations and ends with "Search everything for “q”".
- **Marks** are drawn by `highlight.tsx` as text inside `<mark>`, from the server's snippet ranges or core's `marksIn`,
  never as HTML.

**Where each result opens** (core's `searchHref`). Each page follows its own part of the address, so a result for the
page already open works too, as the box offers on every page: the thread, the timeline, the Files grid, a
contact's page and the Deleted bin through `useSearchParams` (each renders per request, so none needs a Suspense
boundary), Contacts on `hashchange`, and the form and Tasks pages from their `searchParams`. A record page's tab
follows the address too (`useRecordTab`): `?tab=` picks it, a note (`?activity=`) opens the Timeline and a file
(`?file=`) Files, since the router keeps the page when only its query changes and a tab that isn't shown isn't
mounted. Each ask is acted on once, not again as the page refreshes. Text, Merge and Add a contact take theirs off the
address once open, and a note or a task once its dialog closes, so a reload doesn't open them again:

| Result              | Address                                            | What happens                                                                                                                                          |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A message or a call | `inbox/<thread>?message=<id>&at=<when>`            | The thread reads up to that moment (`upTo`) when it isn't in the newest page, and on from it (`since`), then scrolls to it and rings it for 4 seconds |
| A task              | `tasks?task=<id>`                                  | The page asks for that task on its own (`task.list`'s `taskId`, anyone's, done or not) and opens it in its dialog; closing it leaves the list         |
| A form's answers    | `forms/<form>/answers/<response>`                  | Sends on to `forms/<form>?response=<id>`, which opens on Results, One at a time, with that response open                                              |
| A note              | `customers/people/<id>?activity=<id>` (and others) | `activity.get`, in a dialog over the timeline, on a contact's, a company's, a lead's or a record's page                                               |
| A file              | `…?tab=files&file=<id>&page=<n>`                   | The Files tab with the file's card ringed; a PDF opened from it opens at that page                                                                    |
| Text, on a contact  | `customers/people/<id>?compose=sms`                | The record page's text sheet                                                                                                                          |
| Compare and merge   | `customers/people/<a>?merge=<b>`                   | Merge, with the other record chosen                                                                                                                   |
| The Deleted bin     | `settings/deleted-bin?item=<id>`                   | Reads further down the bin until the item shows, then rings it                                                                                        |
| Add a contact       | `customers#add=person&name=…`                      | Add person with what was typed as the name, for `records.write`; the fragment is dropped once read                                                    |

## What it costs, and when to look again

**On the hosted database** (checked 2026-10-20, How it works, 2 in the plan). An ILIKE over all 17,810 messages of the
busiest business, 8.98 million characters, took 143 ms as `postgres` and 154 ms as its owner under row security:
about 8 µs a message. Working out `to_tsvector` for each row took 1,072 ms, which is why long text is matched with
LIKE in a window, never with full text worked out on the fly. Every business fits wholly in the full window today:
the busiest has 17,810 messages against the window's 25,000, and the whole database holds about 1,700 timeline lines,
about 1,000 threads and no form answers.

**What a fold costs.** `private.search_fold` only lower-cases plain ASCII text, so 20,000 plain names folded twice
take 40 to 60 ms. Text with an accent pays the whole map, about 2.4 µs a character, so about 40 µs a 17-letter name
each time it's folded, which is why each searcher folds a name once. `foldPattern` finds a word in a file's 100,000
characters in about 1.6 ms, against about 280 ms to fold them.

**What a search holds.** One of its API machine's 6 database connections for one transaction, inside one of the
machine's 3 search slots, each statement held to what's left of its budget (How a search runs): far inside the
15-second statement ceiling and the 30-second limit on an idle transaction. The plan puts a box search at about 14
short statements, typically 60 to 250 ms and 2 s at worst.

**The load check.** `node scripts/search-load.mjs` seeds a business on the local stack with 300,000 messages, 50,000
notes and 20,000 customers, and runs searches through the kernel as an owner, a member and a narrowed member: 200
from the box and 50 from the Search page each. It refuses to start unless Supabase and every database it uses are on
this machine, and the business it seeds stays in the local database until `pnpm db:reset`. The plan asks for quick
p95 under 400 ms and full under 2 s, and the script exits 1 past either.

Measured on 2026-10-20, after Search 3's review, on the local stack in a shared cloud container (one search at a
time):

| Who             | Box (quick) p50 | p95    | Search page (full) p50 | p95      |
| --------------- | --------------- | ------ | ---------------------- | -------- |
| Owner           | 512 ms          | 616 ms | 1,180 ms               | 1,392 ms |
| Member          | 466 ms          | 588 ms | 1,159 ms               | 1,436 ms |
| Narrowed member | 530 ms          | 675 ms | 1,366 ms               | 1,620 ms |

The Search page is inside its 2 s. **The box isn't inside its 400 ms** on a business this size, about 15 times the
busiest one on the hosted database: contacts, one statement over every customer of the business, take about 200 ms
of it at 20,000 customers, and the rest is each kind's own statement and savepoint. No search timed out or was
skipped. Two fixes found by this check are in the code: a window's matching rows are bounded by its edge in their
index scan (it was a filter over every message of the business, 300 to 600 ms), and who a thread or a note is on is
read by key, not by joining every customer. It hasn't been run since: Search 4a's read of which add-ons run (only
when one that answers searches may answer) and Search 5's file words window aren't in these numbers.

**The box's 400 ms is Chris's call, still open.** The plan asked for that call before the screens were on, and
Search 9 switched them on without it: either the target moves to what was measured (the plan's How it works, 6 and
Tests by package, this page and `QUICK_P95_MS` in the script, together), or contacts get faster first. Until then the
script exits 1 by design.

**When to look again at a faster finder.** The faster path under Not yet, below, is faster but not safer, and needs
Chris's say-so. Look again when either of these happens on a real business:

- its 25,000 newest messages, the full window, span less than a year, so last year's mail needs Look further back
  (docs/operations.md, "Search on the API", has the reads that check). Its 20,000 newest threads can fall short
  first: one text sent to many customers starts a thread for each, and who a thread is with is read in that window;
- search's p95 passes 1 s (the API logs each request's `responseTime`).

The load check's business is already past a second on the Search page (a p95 of 1.4 to 1.6 s), so a business
growing toward 15 times today's busiest is when this comes up. The box's 400 ms is a different line and doesn't
stand in for either.

## Rules worth knowing before changing anything

**Row security decides, and core adds a gate for each gap it leaves.** Every read runs as the person. On top, each
kind's permission is written once, in `SEARCH_KINDS` (`search/kinds.ts`), which both apps read for the chips and the
server reads to skip a kind; a searcher carries no gate of its own. The gaps and their fixes are listed in the plan's
"Who can see what": customers in the bin, erased names and merged shells stay readable to row security, so every read
of `app.people` in search adds `LIVE_PERSON`; a line on a turned-off add-on's record adds `RECORD_READS`. Under a staff
view-as nobody holds a permission, so the gates are skipped and row security alone decides.

**Windows on btree indexes, never GIN.** Under row security a condition reaches an index only through a leakproof
function, and LIKE, trigram similarity and full-text matching aren't (`packages/db/test/search-leakproof.test.ts`
pins it). So small kinds scan the business through a `workspace_id` btree, long text is matched in a window of the
newest rows, and exact identifiers use leakproof equality. `packages/core/test/search/plans.test.ts` explains each
searcher's real statement and fails if one stops using its index, or folds a row's name more than once (an accented
name costs about 40 µs a fold, so a searcher folds it in a lateral and every arm reads that). Don't add a GIN, trigram
or `tsvector` index for search: it costs writes and buys nothing.

**A window's edge reaches its rows as a bare parameter.** The same leakproof rule bounds a window: `at > $edge` is an
index condition only when `$edge` is a plain parameter, since the planner counts `coalesce` and `greatest` as leaky,
so `windowed` (`search/server/sql.ts`) works the edge out whole in a CTE and reads it as an init plan. Written any
other way, the window is a filter over every row of the business (300 to 600 ms on 300,000 messages);
`plans.test.ts` pins the index condition. Customers and records joined to a window's rows are read by key, in
`offset 0` laterals, never joined over the whole business.

**Nothing typed is kept or logged.** It travels in a POST body, the web keeps it after `#`, and nothing stores it. A
database error carries its statement's parameters, and so what was typed, so `step` throws any error that isn't one
of ours again as `search <kind> failed: <SQLSTATE>` with no message or cause, and both queries are wrapped in one more
such catch. A statement stopped for time marks its group `too_slow`; a spent budget marks the rest `skipped`; only
when every kind tried was slow or skipped is the search refused `search_took_too_long`. A step that fails while
reading the winners' facts keeps the hits and marks the group. `limits.test.ts` forces each of these and checks no
error holds the typed words, and `search-guards.test.ts` checks the API's own error log.

**A new kind** adds its entry to `SEARCH_KINDS` with its gate, its searcher under `search/server/kinds` (every
statement through the `SearchDb` it's handed, never `ctx.tx` directly), and a case to `test/search/gaps.test.ts` for
the gap it closes; `kinds.unit.test.ts` fails until a searcher and its entry match one for one.

**One copy of the ranking.** The SQL only filters roughly and orders well enough to keep the best 101; the tier, why
it matched, the marks and the lines are worked out in core's JavaScript, the same on the server and, offline, the
phone. Change a tier rule in `rank.ts` or a kind's reasons in `explain.ts` (which the server's searchers and the
phone's `searchCopy` share), not in its SQL alone.

**One fold, in core and in the database.** `FOLD_FROM` and `FOLD_TO` (`search/fold.ts`) and the two strings in
`private.search_fold` (`20261027009700_search_windows.sql`) are one map, one letter for one letter, so a mark found
in folded text fits the original and the phone ranks a row as the server does. A change to the map is a new
migration that writes both strings again; `fold.test.ts` runs core and the database over every character of the
common blocks and fails if they disagree. `private.search_fold` has no pinned search path on purpose, so Postgres
works it out inline (every name in it is written in full); `fold.test.ts` fails if it stops being inlined. Never
`unaccent`: it isn't installed, and it turns ß into ss, which throws every mark after it out of line.

**Nothing search adds reaches PowerSync.** No column on a table phones copy: PowerSync's first copy of a published
table is `SELECT *`, so every column reaches its storage, and a stored column would also rewrite the table under
ACCESS EXCLUSIVE. `app.file_texts` is never published (`sync-secrets.test.ts`). The phone searches what it already
keeps.

**The phone contract only grows.** Both queries are recorded in `test/contract/mobile-contract.json`: an input field
is only ever added, with a default, and a kind or a badge is a string an old build skips. Record an addition with
`UPDATE_CONTRACT=1` (`test/mobile-contract.test.ts`).

**Archived** records come back only by their name or title, under Archived (Include archived folds them into their
kind). A kind's own page leaves them out unless asked, and the Archived page lists only them.

**Money follows the member rule** in its own SQL, through `estimateMemberClause` and `invoiceMemberClause` from
`queries/money.ts`, as the money lists do. A bill whose customer isn't live keeps only the name, with `contact: null`.

**Add-ons answer through core's contract, and nowhere else.** An add-on's manifest names one query of its own
(`search`), a `defineAddonQuery` for people alone on core's `AddonSearchInput` and `AddonSearchOutput`, with no `ai` and
`route: false`, so the API never mounts it and nobody calls it around search's rate limit and slot gate
(`addonSearchIssues` checks; the API's `registerOperations` skips any query so marked). Core runs it with
`executeQueryWithin` after its own kinds, as the person and inside a savepoint, so its add-on being on and its
permission are checked again; it gets core's probes, never what was typed, and ranks on core's tiers. Its answer is
held to core's rules (its own kinds, links only to its own pages or the record a hit is about, however `..` is written,
archived hits only when asked for, short snippets, counts shown to 50 in the box and on the Search page), and any
failure of its (turned off mid-search, a timeout, an error) drops its groups alone, in their place one line with its
name ("Real Estate Agent couldn’t be searched just now"), logged as its id and SQLSTATE at most. On one of its kinds'
own pages a timeout refuses `search_took_too_long`, as a core kind's does. `covers` takes its kinds of records out of
core's group only when it answered for every kind it has, and their archived ones still go under Archived: someone
without its permission, or a search where it failed, still finds those records through core's group, opening the
record page. Core never names an add-on: it reaches them
only through `ADDON_SERVER_MODULES`. docs/addon-architecture.md ("Search") has the add-on's side.

**The Deleted bin** is searched by each item's name only, for whoever holds `records.delete` (row security asks the
same).

**Messages read only threads, messages and calls, never the timeline's copies of them**, and Notes read only
`NOTE_LINES` (`search/server/kinds/notes.ts`): kind `note` with any subtype, or a call or visit with no subtype. A
copy of a text, an email or a call always carries a subtype, so a member whose inbox is narrowed never finds a hidden
thread's words through its copy. `NOTE_LINES` is written word for word as `activities_notes_idx`'s condition, so the
planner can prove the partial index from it; change both together.

**Long text is matched where it's stored, unfolded** (decision 23): a message's subject and plain text (never its
HTML), a transcript, a note, a task's or visit's notes, an answer. Names and titles fold. A found row carries a
stretch of its text cut in SQL around the first match (`stretchOf`), never the whole body.

**A file's words are read by the worker alone, and follow the file.** `file.attached` queues a `file.text` job
(never for port papers or knowledge files), which sniffs the first bytes and reads a text PDF page by page, plain text
and CSV, or Word and Excel with no library (`office-text.ts`: the zip checked before anything is inflated, 20 MB a
part and 50 MB in all, never a part that says it grows more than 200 times, and a tag scanner that expands no
entity). No AI and no cost; scans, photos, voice notes and message attachments are Not yet. The words, 100,000
characters at most, go in `app.file_texts`, which phones never get: `file_texts_select` reads them exactly when the
file could be opened. No reader builds more than twice that, so a workbook repeating one long cell can't fill the
worker's memory. They stay hidden while the file is in the bin and go when it's deleted for good, by a definer
trigger, since a person may only read them; `file.save_text` holds the file while it keeps them, so a delete meanwhile
waits for it. No event, audit row, log line or job row ever holds them: a failed save says only its SQLSTATE. A better
reader raises `FILE_READER`, and the daily sweep reads every older file again.

**`searchWords` and `private.search_words` split text alike.** The stored `words` are the text folded, every run of
anything but a letter or a digit one space, and digits without their leading zeros, so "1042", "0142", "smith" and
"gulfcoastrealty" match inside a file as they do elsewhere. Core builds the query (`tsq`, `dana:* & smith:*`) from what
was typed the same way, so `to_tsquery` never throws on it; `fold.test.ts` runs both over one corpus and every
character of the common blocks, and checks the query finds the stored words. Change one, change both. Postgres's
parser splits a few words further, "65e8m" into 65e8 and m, which `to_tsquery` makes a phrase, and a phrase never
matches words kept without their places, so `wordsQuery` makes every `<->` an `&`. The window counts only files with
words (`t.chars > 0`, which `file_texts_recent_idx` is partial on: change both together), so photos never crowd a
document out. The snippet finds where the longest typed word starts a word with `termPattern`, built on
`foldPattern` (each letter a bracket of the letters that fold to it), rather than folding up to 100,000 characters,
which costs about 2.4 µs a character once a text holds an accent.

**Everything hanging off a record of the business's own kinds asks the record** (`RECORD_READS`): tasks, notes,
files, appointments, threads and their calls. Their own policies check only sealing, so without it a turned-off
add-on's tour or portal thread would stay findable.

**Spam is searched only when picked** (`SEARCH_KINDS`' `picked`), Other mail is badged `other_mail`, a person's own
mail `my_mail`; a cancelled held text and an unanswered bridge call are never found, as the thread never shows them.
One row stands for a conversation, its best message as the snippet, one-to-one before campaign and automated sends.

**A meeting's summary is found only as the note it already is**, sealed with the appointment's private record when it
has one (`call_suggestion.record` passes the record to `activity.log`), and a task approved from the same call is
sealed with it too (`call_suggestion.decide` passes the record to `task.create`, giving it to the host only while the
host is on the record). A record in the Deleted bin reads for nobody, so the note then goes on the customer alone.
`app.appointment_transcripts` is never read.

## The phone

**One screen, full screen over the business** (boards 5 and 5b): `/app/w/<business>/search`, with `q` and `kind`.
It opens from the Search button in the top bar of a business's screens (`AppBar`'s `search`, on wherever the business
mark leads), from "Search everything for “q”" at the end of the Contacts and Inbox boxes' own results (both stay
filters of their lists), and from a link: the route map reads a web `/search#q=…&kind=…`
link's pairs after `#` (a rule names the pairs it reads, `fragment`, and no other rule ever sees them) and keeps them
on the phone's own address, so what was typed never leaves the phone that way either. The box is focused, with
Cancel; the chips are the found kinds with their counts; then the best match with Call and Text (for whoever may use
the inbox, on a customer with a number), a few of each kind with "See all 7", the Settings group, and "See all 26
results" for every group at once. One kind (a chip, or See all) is `search.kind` 25 at a time with Show 25 more, its contacts
told apart by phone · where · last contact (`hitLines`' `page`, board 5b), and for contacts Leads or Clients and "Two
Dana Smiths share a number. Same person?" with Compare, which opens the web's merge for whoever may archive customers.
A kind this build doesn't know is skipped, in a link and in an answer; a group that only says it didn't answer (an
add-on that couldn't be searched, named by its id) is kept, so its line shows, there and on its kind's own page,
rather than "No matches". Try again shows only with a refusal it can help (busy, too slow, too fast, no answer at
all), as on the web.

**With signal** the phone asks `search.everything` 300 ms after the typing stops, what was typed in the body only
(`apps/mobile/src/search/use-search.ts`), drops a stale answer, asks again once after 2 s when the refusal says to
retry, and again when signal comes back. Its own rows show at once, marked "On this phone", and the server's answer
takes their place (not while viewing as someone: the copy is the viewer's). Settings are searched on the phone, as
Settings search does, and a setting that matched is sent as `settingsMatched` so no close matches are looked for.
Results open through the route map (`openAppPath`): a screen the phone has, or the browser for the rest, with the
arrow out on those rows; a setting opens where Settings search opens it. A search is kept among the recent ones
(`search_recent`, a local-only table in the encrypted copy, never sent, by core's rule in `search/recent.ts`: at most
8 a person a business, the same words again moving up whatever their case or accents) when one of its results is
opened.

**With no signal**, or when a request fails for want of it, `apps/mobile/src/search/copy-sql.ts` reads at most 200
rows a kind through `getAll` (never a live query over every row): each kind's words lower-cased into one text, the
three longest typed words each in it (a letter outside ASCII read as any one letter, since SQLite folds the case of
plain letters only), or the phone, the digits (in order in a number written freely too) or a web address's domain
typed; those whose name, or a note's own words, holds the words first, then the latest. The SQL only narrows, never
past what `searchCopy` would match. Core's `searchCopy` (`search/copy.ts`) then decides which match, ranks them with
the server's tiers and reasons (`search/explain.ts`), and answers in the server's shape with `source: 'phone'`, so one
row draws both. It searches contacts, companies and leads, tasks, notes, the calendar, live forms by name, Real
Estate's deals (a phone add-on's `search`, from the same copy and view as its Deals screen, with the server's line
and its Client and Address chips) and settings; the chips
for Money, Messages, Files and Knowledge are greyed, and the line at the top is the board's: "You’re offline, so this
searched what’s on this phone. Files, messages and money show once you’re back online. As of 8:58 AM". With no signal,
one kind's page for a kind the phone doesn't keep says searching it needs signal, not that nothing matched: Real
Estate's Listings, Homes and Properties too, since a phone add-on names the kinds its search answers
(`PhoneAddon.searchKinds`), and by the name the chip or See all that opened it gave, never a kind's key. Two tests
hold it to the server: `copy.test.ts` compares `searchCopy` with `search.kind`'s titles, order, tiers, reasons and
links on every row of Bayou Plumbing's a phone keeps, read as a phone gets them, and
`apps/mobile/src/search/__tests__/copy-sql.test.ts` runs the phone's own statements on SQLite and requires the same
answer from the rows they read as from every row.

**What the phone never shows offline.** Archived records, and a customer in the Deleted bin with them, since the bin
reads as archived on a phone; neither lends a name to a lead, a task, a note or a visit. Notes and tasks only on a
customer, company or lead in the copy: the phone's tasks and timeline carry no record, so it can't tell a turned-off
add-on's property from anything else, and a line anchored to none of the three (a plain to-do among them) waits for
signal. Viewing as someone with no signal, only settings are searched: "Searching needs signal while you’re viewing
as Dana." SQLite can't fold accents, so the rows read may miss "José" for "jose" (a name typed as it's stored is
always read); ranking and marks still fold.

**Where a result lands on the phone.** A thread at its message (`?message=&at=`: scrolled to and rung once it's in the
copy), a task through the Tasks screen (`?task=`: opened as tapping it would), a note on its customer (`?activity=`),
Text on the best match through the customer's screen (`?compose=sms`: their text thread, or "No text thread with
them yet"), a form and one response's answers on the phone's own form screens, and a business's own kinds of
records, files on a record (the route map's `webWhen: ['file']`, so the row carries the arrow out) and business
settings on the web.

## Settings search

**Search settings** finds a setting by what it's called, where it sits or the other words people use for it, on the
device as the person types, with nothing sent anywhere. On the web it's a box at the top of the Settings menu (and
over the page picker on a phone-width screen): typing replaces the menu with what matched, grouped as the menu is
("5 settings on 2 pages"), and choosing one opens its page at it and rings it for 4 seconds, from another page or the
one already open. On the phone it's a box at the top of Settings: a setting the phone has opens its screen scrolled
to the row and flashed (`?setting=<key>`), and one only the web changes says "Opens on the web" and opens the browser
at it. The main search's Settings group (Search 7 and 8) is the same search, through `settingsSearchGroup`; an add-on's
entries there read under its own name ("Real Estate Agent", and "Real Estate Agent · Opens the Add-ons page" for a
switch), never "Settings ›". On the phone both read the settings through one hook, `usePhoneSettings`.

**The catalogue is the one list.** `SETTINGS_GROUPS` (`settings/pages.ts`) is the Settings menu itself: the web draws
its menu from it, settings search gates each page as the menu does (`settingsPageShown`: the page's permission, and a
part of core only some add-ons use while one of them runs), and the Assistant's map is checked against it.
`SETTINGS` (`settings/catalog.ts`) is every setting: each Settings page, a hand-written row for each setting row and
card on them and each Account section, each Automations row (opened ringed on the page), a few Adjust fields (opening
their automation's sheet with `?adjust=`), each notification row (from `account/notification-rows.ts`, which both
apps' notification screens read), the phone's own settings (Face ID, the businesses and documents kept on it, its
changes, the person's own safety contacts), and an add-on's switches and settings page, which show last under the
add-on's own name and never as a Settings page. Each calendar's builder and the AI teammate's sections aren't in it
yet (decision 13).

**Each setting shows only to whoever its screen shows it to.** Beside the page's own gate, an entry can carry its own
permission (`needs`, Delete this business needs `workspace.delete`), a part of core some add-ons use (`feature`), or
`only`: New support tickets is listed only to people who answer HandsFreeOS support, and Daily agency digest only to an
owner or admin of an organization with more than one business (`managesAnAgency`), as both apps' notification screens
decide. The web's settings layout passes both from `platform.me` and the account; the phone passes what it already
knows (`useKeptStaff`), so it works with no signal, and leaves the row out when it doesn't know.

**How it matches.** Words are folded as search folds them, every apostrophe reads as one (the catalogue is written
with curly ones, a keyboard types straight ones) and a typed hyphen splits words ("opt-out" finds "opt out"). With
nothing found, a typo gets search's close-match check, but the main search's Settings group leaves such close settings
out: there, close matches are names, and only a setting that really matched says the words were spelled right. On the
web, ↵ with no row picked opens the best match.

**`test/settings-catalog.test.ts` keeps it honest.** It reads the web's source: every setting is marked exactly once
(`<SetRow setting="…">`, `<Block setting="…">`, `<SettingAnchor setting="…">`, `settingAttrs('…')` on a card, or the
id it already had), every literal `SetRow` and `Block` title on the Settings pages carries `setting=` or sits on its
`NOT_SEARCHABLE` list with a reason, every `settings…#anchor` link in the web, the worker and the phone resolves,
every page and phone screen it names exists, and searching "quiet" gives what the real catalogue holds. TypeScript
refuses a `setting=` key the catalogue doesn't have (`SettingKey`). So a new setting row adds its entry and marks
itself, or the test says which one is missing.

**Anchors that emails and tools link to keep their ids:** `quiet-hours` (Automations' "Edit quiet hours", and now
the Quiet hours row itself rather than its card), `rcs` (the RCS emails and the composer), `founding` (the founding
checkout) and `notifications` (the Assistant's tools). A new anchor is the key with hyphens
(`texting.ring_for` is `#texting-ring-for`).

## Not yet

- **A faster path for very large businesses:** a security-definer finder that hands back candidate ids, checked again
  by row security (`id = any($ids)` on the primary key), with expression GIN indexes behind it. Faster, not safer: it
  has to copy who may see what exactly, or it tells a person which hidden rows hold a word, so it needs Chris's
  say-so. When to look again is under What it costs, above.
- **Reading more files:** scanned PDFs and photos (OCR or AI reading, a rate-card cost), voice notes, and legacy .doc
  and .xls, which can't be uploaded anyway. Scans, photos and voice notes added to a record are files, so their names
  are found.
- **The attachments on texts and emails**, kept with the message rather than as files, aren't found at all, not even
  by name.
- **Folding accents in long text, and stemming.** Message and note text matches as it's stored.
- **Searching inside what's in the Deleted bin.** Only each item's name is found.
- **Sales Coach and Social Outreach answering searches.** Social Outreach has to keep each person to their own chats
  in its query, because its row security lets anyone with `outreach.use` read them (`outreach/ops/chats.ts`).
- **People an add-on keeps apart from Contacts** (open-house visitors, showing agents, Facebook profiles), which will
  show only in that add-on's own group.
- **An Assistant tool for Search everything.** Its `search_customers` still finds customers.
- **More kinds:** products, templates, workflows, campaigns, menu places (a "Pages" kind), website-chat visitors and
  intake lines. A hidden menu place is still reached by its links.
- **Settings search inside each calendar's builder and the AI teammate's sections**, which need a `?module=` link on
  both builders (decision 13).
- **On the phone:** a bin mark on its copy, batched with the next sync change, so a customer in the bin stops reading
  as archived; the Lead or Client badge, one kind's Leads and Clients chips and the duplicate banner with no signal
  (`personIsClient` reads jobs, visits, plans and bills the phone keeps only in part); and ringing the note an
  `?activity=` link names, which opens its customer for now.
- **The hidden-add-on gap outside search:** `task.list`, the timeline, the calendar and the inbox still show the
  tasks, notes, visits and threads on a turned-off add-on's records, since their policies check only sealing. Search
  closes it in its own SQL (`RECORD_READS`); a restrictive policy for every reader is a separate security step.
- **"Form sent" as a last contact** (boards 3 and 5b): nothing records that a form was sent to someone.
- **An internal meeting's AI summary**, which no screen shows, so search doesn't either (decision 15); AI call
  summaries in `app.ai_calls`; and calls by number without a thread.
