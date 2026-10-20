# Search everything

The box at the top of the side menu becomes **Search everything**: contacts, companies, leads, money, messages,
the calendar, tasks, notes, files and the words inside them, forms and their answers, knowledge, a business's own kinds
of records, add-on records, settings, archived records and the Deleted bin, each only for people who may see it. The
plan, its decisions and its build order are in `HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md`; the boards are in
`design/search`.

**Where it stands:** Search 3 is built: core's search over every kind but add-ons' and settings (contacts,
companies, leads, money, messages and calls, Spam, the calendar, tasks, notes, file names, forms and their answers,
knowledge, a business's own kinds, Archived, the Deleted bin and close matches), the queries its results open onto,
and the API's guards. Search 6 is built and on screen: **Search settings** at the top of the Settings menu on the
web, and at the top of Settings on the phone (Settings search, below). Search 8 is built but not linked: the phone's
full-screen search, with signal and without (The phone, below), opens only from a link (a web `/search#q=…` link).
The main box and `/customers?q=` work as they did until Search 9 switches it on.

## Where things are

| What                                  | Where                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The queries                           | `packages/core/src/queries/search.ts`: `search.everything` (the box and the Search page) and `search.kind` (one kind, a page at a time)                                                                 |
| Their shapes                          | `packages/core/src/schemas/search.ts`                                                                                                                                                                   |
| Running a search                      | `packages/core/src/search/server/run.ts`: which kinds run, `step`, the budgets, the archived split, close matches, paging                                                                               |
| Each kind's SQL                       | `packages/core/src/search/server/kinds/<kind>.ts`, listed in `kinds/index.ts`; shared fragments (`LIVE_PERSON`, `RECORD_READS`, `numberMatches`, `archivedRule`, the windows) in `search/server/sql.ts` |
| What results open onto                | `activity.get` (`queries/activity.get.ts`), `task.list`'s `taskId`, `conversation.thread`'s `upTo`                                                                                                      |
| Shared logic, for the server and apps | `packages/core/src/search/`: `probes` (what was typed), `kinds` (each kind's gate), `rank`, `snippet` (marks), `close`, `href`, `dropdown`, `lines`, `words`, and `fold` (accents)                      |
| Document numbers                      | `documentNumberProbe` and `documentNumberMatches` in `packages/core/src/money/numbering.ts`                                                                                                             |
| The API's guards                      | `apps/api/src/routes.ts` (rate limits, and each search inside a slot) and `apps/api/src/search-slots.ts` (the slot gate)                                                                                |
| The database                          | `supabase/migrations/20261027009700_search_windows.sql`: `private.search_fold`, the windows' indexes, and `form_answers_follow_response`                                                                |
| Tests                                 | `packages/core/test/search/` (the kinds, the gaps, who sees what, limits, plans, what results open, and the pure ones); `apps/api/test/search-*.test.ts`; `packages/db/test/search-*.test.ts`           |
| The load check                        | `scripts/search-load.mjs`, local stack only (The load check, below)                                                                                                                                     |
| Settings search                       | `packages/core/src/settings/`: `pages` (the Settings menu), `catalog` (every setting), `search` (`searchSettings`, links, grouping, the main search's Settings group), `words`                          |
| Settings search on the web            | `apps/web/src/components/settings/`: `settings-search.tsx` (the box), `use-setting-highlight.ts` (the jump and its ring), `setting-anchor.tsx` (`SettingAnchor`, `settingAttrs`), `SetRow`'s `setting`  |
| Settings search on the phone          | `apps/mobile/src/settings/`: `settings-search.tsx` (the results), `use-setting-flash.ts` (scrolling to a row and flashing it); `ListRow`'s `settingKey`                                                 |
| Its tests                             | `packages/core/test/settings-catalog.test.ts`; `apps/mobile/src/settings/__tests__/settings-search.test.tsx`; `apps/web/e2e/settings-search.spec.ts`                                                    |
| Why a row matched                     | `packages/core/src/search/explain.ts`: each kind's tier and reason, one copy for the server's searchers and the phone's own search                                                                      |
| The phone's own search                | `packages/core/src/search/copy.ts` (`searchCopy`, over the rows a phone keeps); `packages/core/src/crm/search-text.ts` (the search text a phone works out, for its pickers too)                         |
| Search on the phone                   | `apps/mobile/src/app/app/w/[workspaceId]/search.tsx` (the screen); `apps/mobile/src/search/`: `use-search.ts`, `copy-sql.ts`, `recent.ts`, `rows.tsx`; `FilterChip` in `components/ui`                  |
| Where a phone opens a result          | `apps/mobile/src/links/route-map.ts` (`/search#q=…`, forms, `?task=`, `?message=&at=`, `?activity=` and `?compose=`); Real Estate's deals offline: `apps/mobile/src/addons/realestate/search.ts`        |
| The phone's tests                     | `packages/core/test/search/copy.test.ts`; `apps/mobile/src/search/__tests__/`: `copy-sql.test.ts`, `search-screen.test.tsx`; `apps/mobile/src/links/__tests__/route-map.test.ts`                        |

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
6. **Core's JavaScript ranks** them (`rankHits`: tier, open before finished, newest), says why each matched, splits
   archived records out to Archived, and keeps the first few.
7. **Close matches** run only when nothing matched (the Deleted bin and Archived included), every kind answered, no
   setting matched on the device, and a word has 4 or more letters; with chips picked, only over those kinds.
8. Only then are the winners' facts read, through `step` again: whether a contact is a client, their open lead, a
   company's people, a record's own fields. A step that fails here marks its group, never the search.
9. The groups are ordered (decision 33), the best match picked, and each hit given its link. Nothing is written.

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
| Files         | `records.read`   | names (folded); the words inside come with Search 5                                                                                                                                                                                                                 | the whole business                                                                                          |
| Forms         | `workspace.read` | form names (folded); answers of completed responses, then who answered (folded)                                                                                                                                                                                     | names, the whole business; answers 3,000 / 20,000                                                           |
| Knowledge     | `workspace.read` | knowledge items, through knowledge's own search                                                                                                                                                                                                                     | its own 20 at most                                                                                          |
| Own kinds     | `records.read`   | a record's name (folded) and fields, a group per kind                                                                                                                                                                                                               | the whole business                                                                                          |
| Spam          | `inbox.use`      | as Messages, in the Spam folder, only when picked                                                                                                                                                                                                                   | as Messages                                                                                                 |
| Archived      | the kind's       | archived contacts, companies, leads, threads, forms and records, by name or title only; the page says how far back the threads window looked                                                                                                                        | with the kind                                                                                               |
| Deleted bin   | `records.delete` | each item's name                                                                                                                                                                                                                                                    | the whole business                                                                                          |
| Close matches | `records.read`   | contact, company, lead and record names within an edit or two, only when nothing else matched                                                                                                                                                                       | 300 names that look alike                                                                                   |

A window is the box's (quick) or the Search page's and a kind's own page's (full). A windowed group says whether it
looked at everything (`complete`) and, when it didn't, how far back it went (`searchedBack`, to the microsecond).
**Look further back** passes that as `before`, and the next window reads what's at or before it: a window ends at the
time of the first row it couldn't hold, so the rows sharing that time (a form response's answers) are read whole by
the next one.

## The load check

`node scripts/search-load.mjs` seeds a business on the local stack with 300,000 messages, 50,000 notes and 20,000
customers, and runs searches through the kernel as an owner, a member and a narrowed member: 200 from the box and 50
from the Search page each. It refuses to start unless Supabase and every database it uses are on this machine. The
plan asks for quick p95 under 400 ms and full under 2 s, and the script exits 1 past either.

Measured on 2026-10-20, after Search 3's review, on the local stack in a shared cloud container (one search at a
time):

| Who             | Box (quick) p50 | p95    | Search page (full) p50 | p95      |
| --------------- | --------------- | ------ | ---------------------- | -------- |
| Owner           | 512 ms          | 616 ms | 1,180 ms               | 1,392 ms |
| Member          | 466 ms          | 588 ms | 1,159 ms               | 1,436 ms |
| Narrowed member | 530 ms          | 675 ms | 1,366 ms               | 1,620 ms |

The Search page is inside its 2 s. **The box isn't inside its 400 ms** on a business this size, about 15 times the
busiest one on the hosted database (17,810 messages): contacts, one statement over every customer of the business,
take about 200 ms of it at 20,000 customers, and the rest is each kind's own statement and savepoint. No search
timed out or was skipped. Two fixes found by this check are in the code: a window's matching rows are bounded by its
edge in their index scan (it was a filter over every message of the business, 300 to 600 ms), and who a thread or a
note is on is read by key, not by joining every customer.

**The box's miss needs Chris's decision** before the screens ship (Search 6): either its target moves to what was
measured, or contacts get faster first. The plan's Not yet (revisit the faster path when the box's p95 passes 1 s on a
real business) is a different trigger and doesn't stand in for the 400 ms.

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

**Archived** records come back only by their name or title, under Archived (Include archived folds them into their
kind). A kind's own page leaves them out unless asked, and the Archived page lists only them.

**Money follows the member rule** in its own SQL, through `estimateMemberClause` and `invoiceMemberClause` from
`queries/money.ts`, as the money lists do. A bill whose customer isn't live keeps only the name, with `contact: null`.

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
Until Search 9 adds the app bar's button it opens only from a link: the route map reads a web `/search#q=…&kind=…`
link's pairs after `#` (a rule names the pairs it reads, `fragment`, and no other rule ever sees them) and keeps them
on the phone's own address, so what was typed never leaves the phone that way either. The box is focused, with
Cancel; the chips are the found kinds with their counts; then the best match with Call and Text (for whoever may use
the inbox, on a customer with a number), a few of each kind with "See all 7", the Settings group, and "See all 26
results" for every group at once. One kind (a chip, or See all) is `search.kind` 25 at a time with Show 25 more, and
for contacts Leads or Clients and "Two Dana Smiths share a number. Same person?" with Compare, which opens the web's
merge for whoever may archive customers. A kind this build doesn't know is skipped, in a link and in an answer.

**With signal** the phone asks `search.everything` 300 ms after the typing stops, what was typed in the body only
(`apps/mobile/src/search/use-search.ts`), drops a stale answer, asks again once after 2 s when the refusal says to
retry, and again when signal comes back. Its own rows show at once, marked "On this phone", and the server's answer
takes their place (not while viewing as someone: the copy is the viewer's). Settings are searched on the phone, as
Settings search does, and a setting that matched is sent as `settingsMatched` so no close matches are looked for.
Results open through the route map (`openAppPath`): a screen the phone has, or the browser for the rest, with the
arrow out on those rows; a setting opens where Settings search opens it. A search is kept among the recent ones
(`search_recent`, a local-only table in the encrypted copy, at most 8 a person a business, never sent) when one of
its results is opened.

**With no signal**, or when a request fails for want of it, `apps/mobile/src/search/copy-sql.ts` reads at most 200
rows a kind through `getAll` (never a live query over every row): each kind's words lower-cased into one text, the
three longest typed words each in it (a letter outside ASCII read as any one letter, since SQLite folds the case of
plain letters only), or the phone, the digits (in order in a number written freely too) or a web address's domain
typed; those whose name, or a note's own words, holds the words first, then the latest. The SQL only narrows, never
past what `searchCopy` would match. Core's `searchCopy` (`search/copy.ts`) then decides which match, ranks them with
the server's tiers and reasons (`search/explain.ts`), and answers in the server's shape with `source: 'phone'`, so one
row draws both. It searches contacts, companies and leads, tasks, notes, the calendar, live forms by name, Real
Estate's deals (a phone add-on's `search`, from the same copy and view as its Deals screen) and settings; the chips
for Money, Messages, Files and Knowledge are greyed, and the line at the top is the board's: "You’re offline, so this
searched what’s on this phone. Files, messages and money show once you’re back online. As of 8:58 AM". With no signal,
one kind's page for a kind the phone doesn't keep says searching it needs signal, not that nothing matched. Two tests
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
records, files on a record and business settings on the web.

## Settings search

**Search settings** finds a setting by what it's called, where it sits or the other words people use for it, on the
device as the person types, with nothing sent anywhere. On the web it's a box at the top of the Settings menu (and
over the page picker on a phone-width screen): typing replaces the menu with what matched, grouped as the menu is
("5 settings on 2 pages"), and choosing one opens its page at it and rings it for 4 seconds, from another page or the
one already open. On the phone it's a box at the top of Settings: a setting the phone has opens its screen scrolled
to the row and flashed (`?setting=<key>`), and one only the web changes says "Opens on the web" and opens the browser
at it. The main search's Settings group (Search 7 and 8) is the same search, through `settingsSearchGroup`.

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
