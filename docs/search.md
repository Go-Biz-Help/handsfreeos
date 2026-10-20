# Search everything

The box at the top of the side menu becomes **Search everything**: contacts, companies, leads, money, messages,
the calendar, tasks, notes, files and the words inside them, forms and their answers, knowledge, a business's own kinds
of records, add-on records, settings, archived records and the Deleted bin, each only for people who may see it. The
plan, its decisions and its build order are in `HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md`; the boards are in
`design/search`.

**Where it stands:** Search 2 is built: core's search with its first kinds (contacts, companies, leads, money,
knowledge, a business's own kinds, the Deleted bin and close matches), and the API's guards. Search 6 is built and on
screen: **Search settings** at the top of the Settings menu on the web, and at the top of Settings on the phone
(below). The main box and `/customers?q=` work as they did until Search 9 switches it on.

## Where things are

| What                                  | Where                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The queries                           | `packages/core/src/queries/search.ts`: `search.everything` (the box and the Search page) and `search.kind` (one kind, a page at a time)                                                                    |
| Their shapes                          | `packages/core/src/schemas/search.ts`                                                                                                                                                                      |
| Running a search                      | `packages/core/src/search/server/run.ts`: which kinds run, `step`, the budgets, the archived split, close matches, paging                                                                                  |
| Each kind's SQL                       | `packages/core/src/search/server/kinds/<kind>.ts`, listed in `kinds/index.ts`; shared fragments (`LIVE_PERSON`, `RECORD_READS`, `numberMatches`, `archivedRule`) in `search/server/sql.ts`                 |
| Shared logic, for the server and apps | `packages/core/src/search/`: `probes` (what was typed), `kinds` (each kind's gate), `rank`, `snippet` (marks), `close`, `href`, `dropdown`, `lines`, `words`, and `fold` (accents)                         |
| Document numbers                      | `documentNumberProbe` and `documentNumberMatches` in `packages/core/src/money/numbering.ts`                                                                                                                |
| The API's guards                      | `apps/api/src/routes.ts` (rate limits, and each search inside a slot) and `apps/api/src/search-slots.ts` (the slot gate)                                                                                   |
| The database                          | `supabase/migrations/20261027009700_search_windows.sql`: `private.search_fold`, the windows' indexes, and `form_answers_follow_response`                                                                   |
| Tests                                 | `packages/core/test/search/` (the kinds, the gaps, who sees what, limits, plans, and the pure ones); `apps/api/test/search-slots.test.ts` and `search-guards.test.ts`; `packages/db/test/search-*.test.ts` |
| Settings search                       | `packages/core/src/settings/`: `pages` (the Settings menu), `catalog` (every setting), `search` (`searchSettings`, links, grouping, the main search's Settings group), `words`                             |
| Settings search on the web            | `apps/web/src/components/settings/`: `settings-search.tsx` (the box), `use-setting-highlight.ts` (the jump and its ring), `setting-anchor.tsx` (`SettingAnchor`, `settingAttrs`), `SetRow`'s `setting`     |
| Settings search on the phone          | `apps/mobile/src/settings/`: `settings-search.tsx` (the results), `use-setting-flash.ts` (scrolling to a row and flashing it); `ListRow`'s `settingKey`                                                    |
| Its tests                             | `packages/core/test/settings-catalog.test.ts`; `apps/mobile/src/settings/__tests__/settings-search.test.tsx`; `apps/web/e2e/settings-search.spec.ts`                                                       |

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
   5 s; never under 50 ms). A kind reads up to 101 rows, enough to say "100+".
6. **Core's JavaScript ranks** them (`rankHits`: tier, open before finished, newest), says why each matched, splits
   archived records out to Archived, and keeps the first few.
7. **Close matches** run only when nothing matched (the Deleted bin and Archived included), every kind answered, no
   setting matched on the device, and a word has 4 or more letters; with chips picked, only over those kinds.
8. Only then are the winners' facts read, through `step` again: whether a contact is a client, their open lead, a
   company's people, a record's own fields. A step that fails here marks its group, never the search.
9. The groups are ordered (decision 33), the best match picked, and each hit given its link. Nothing is written.

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
phone. Change a tier rule in `rank.ts` or a searcher's `explain`, not in its SQL alone.

**Archived** records come back only by their name or title, under Archived (Include archived folds them into their
kind). A kind's own page leaves them out unless asked, and the Archived page lists only them.

**Money follows the member rule** in its own SQL, through `estimateMemberClause` and `invoiceMemberClause` from
`queries/money.ts`, as the money lists do. A bill whose customer isn't live keeps only the name, with `contact: null`.

**The Deleted bin** is searched by each item's name only, for whoever holds `records.delete` (row security asks the
same).

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
