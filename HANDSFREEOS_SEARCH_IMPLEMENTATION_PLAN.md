# Search everything

Today the box at the top of the side menu only opens Contacts. It sends what was typed to `/customers?q=`
(`apps/web/src/components/shell/search-field.tsx:22-28`) and says "Search contacts". Nothing searches a message's
words, a note, a task, a file, a form answer or a setting, and Settings has no search at all.

Chris asked: "the search contacts should be a search for everything in the crm. also add a search bar in the
settings page." After seeing the boards: "go ahead and build it once the plan is done".

This plan:

1. Turns the box into **Search everything** (⌘K, or Ctrl K), with results by kind as you type, a **Search page** on
   Enter, and one kind at a time in its own table.
2. Finds contacts, companies, leads, money, messages and calls, appointments, tasks, notes, files and the words inside
   them, forms and their answers, knowledge, a business's own kinds of records, add-on records (Real Estate first),
   settings, archived records and the Deleted bin. Each only for people who may see it.
3. Puts a **Search settings** box at the top of the Settings menu, and settings in the main search.
4. Ships the same search on the phone, in the same push: the server's answer with signal, the phone's own copy
   without.

The boards are in `design/search` (commit 18ce0f9), from the canvas "Search everything": 1 typing, 2 the Search page,
3 many matches, 4 different searches, 5 and 5b the phone, 6 Settings.

**Where it stands (2026-10-20):** boards approved; stages 1, 2, 3, 6 and 7 built (Build order), the rest still to
build.

## Decisions (Chris, 2026-10-20)

| #   | Question                        | Answer                                                                                                                                                        |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What does search cover?         | **Everything in the CRM, including the words inside files and form answers.**                                                                                 |
| 2   | Where can settings be searched? | **From the Settings bar and from the main search.**                                                                                                           |
| 3   | Web or phone first?             | **Together.** Both apps switch on in one push.                                                                                                                |
| 4   | What did "listings" mean?       | **Search results**, not a kind of record. (Real Estate's own **Listings** group, drawn on boards 1, 2 and 4, comes from the add-on and is a different thing.) |

### Calls taken on Chris's behalf

Chris said to build once the plan is done, so the questions the research left open are answered here, each with the
safer pick. Most are one constant or one word in core.

| #   | Question                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Who                               |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 5   | Messages for someone whose inbox is narrowed, or without its use | **Only threads they may open, and only with `inbox.use`.** Timeline copies of texts, emails and calls are never searched.                                                                                                                                                                                                                                                                                                                                    | Claude's call, Chris can overrule |
| 6   | Which timeline lines count as Notes                              | **`kind = 'note'` with any subtype and any actor, or a call or visit with no subtype.** That keeps people's own notes, logged calls and visits, imported notes (1,226 of the hosted 1,229 are GoHighLevel imports, subtype `gohighlevel`) and the AI's "Call summary:" notes. Channel copies always carry a subtype (`crm/activities.ts:21-26`) and system lines are kind `system`, so neither is searched.                                                  | Claude's call, Chris can overrule |
| 7   | Which files have their words read                                | **Text PDFs, plain text, CSV, Word (.docx) and Excel (.xlsx), read by the worker with no AI and no cost.** Scanned PDFs, photos, voice notes and the attachments that come with texts and emails are Not yet; a file's name is still found.                                                                                                                                                                                                                  | Claude's call, Chris can overrule |
| 8   | The Deleted bin                                                  | **Only people with `records.delete` see a Deleted bin group, and it matches only each item's name**, as the bin's own list does. Nothing sets `app.read_bin` for a person.                                                                                                                                                                                                                                                                                   | Claude's call, Chris can overrule |
| 9   | Other mail and Spam                                              | **Other mail shows in Messages with an "Other mail" label. Spam only in its own Spam kind, searched only when picked.**                                                                                                                                                                                                                                                                                                                                      | Claude's call, Chris can overrule |
| 10  | The phone                                                        | **The server with signal. With none, core's `searchCopy` searches the phone's copy and says so. Nothing typed is kept or logged on the server. No sync change.** Archived records aren't shown offline, so a customer in the bin (which reads as archived on phones, docs/deleting.md:94-96) never shows.                                                                                                                                                    | Claude's call, Chris can overrule |
| 11  | What the phone searches with no signal                           | **What board 5 says: contacts, companies, leads, tasks, notes, calendar, form names, Real Estate deals and settings.** Messages, money, files, form answers, knowledge and a business's own kinds wait for signal ("Files, messages and money show once you’re back online."). That keeps the inbox, own-mail and money-member rules out of phone code.                                                                                                      | Claude's call, Chris can overrule |
| 12  | Business settings on the phone                                   | **Listed, marked "Opens on the web", and opened in the browser at that setting.**                                                                                                                                                                                                                                                                                                                                                                            | Claude's call, Chris can overrule |
| 13  | How deep settings search goes                                    | **Every Settings page, each setting row on them, each Automations row and its Adjust fields, the Account page's sections, and add-on settings pages and switches.** Not this release: each calendar's builder sections and the AI teammate's sections (their open section lives in React state).                                                                                                                                                             | Claude's call, Chris can overrule |
| 14  | Add-ons                                                          | **Core gets a search contract: a manifest `search` declaration naming the add-on's own query, run through the kernel, with a failure kept to that add-on's groups. The contract is built in core first (stage 4a), then Real Estate answers (stage 4b): deals, listings, homes, and properties no listing covers, by address, MLS number or client.** Sales Coach and Social Outreach: Not yet.                                                              | Claude's call, Chris can overrule |
| 15  | Meeting transcripts                                              | **Only the AI's summary, and only as the Note it already is.** `call_suggestion.record` writes "Call summary:" as a note only when the meeting has a customer (`commands/call-suggestion.ts:169-178`), and stage 3 makes that note sealed with the appointment's private record (decision 38). `appointment_transcripts` is never read by search: an internal meeting's summary, which no screen shows, stays unfound, and the raw words are never searched. | Claude's call, Chris can overrule |
| 16  | AI call summaries in `app.ai_calls`                              | **Not searched.** The call's own transcript holds the same words under the same rules.                                                                                                                                                                                                                                                                                                                                                                       | Claude's call, Chris can overrule |
| 17  | Launch                                                           | **On for every business at once. Recent searches stay on each device, kept to the person who typed them. `/customers?q=` keeps working.**                                                                                                                                                                                                                                                                                                                    | Claude's call, Chris can overrule |
| 18  | One index, or each kind where it lives                           | **Each kind where it lives, read as the person under row security, with core's gates on top. No search table.** This is the add-on audit's recorded path: "a federated search can come later" (docs/addon-readiness-audit.md:246-247).                                                                                                                                                                                                                       | Claude's call, Chris can overrule |
| 19  | How long text stays fast                                         | **Bounded windows on btree indexes, never GIN text indexes**, which row security can't use (How it works, 2). A security-definer finder that hands back ids would be faster but not safer: called directly, it would tell a person which hidden rows hold a word. It is Not yet, and needs Chris's say-so.                                                                                                                                                   | Claude's call, Chris can overrule |
| 20  | The boards' "Deals" and "Quote #388"                             | **"Leads" and "Estimate #388": core's words** (`crm/record-words.ts:113`, `money/lists.ts:53`). "Deals" is Real Estate's own kind and would show twice where it runs. One word each in `search/words.ts` if Chris wants the boards' words back.                                                                                                                                                                                                              | Claude's call, Chris can overrule |
| 21  | Answers of a form response in the bin                            | **A restrictive policy hides them from everyone**, which also mends Forms → Results, which shows them today (`queries/form.ts:532-553`).                                                                                                                                                                                                                                                                                                                     | Claude's call, Chris can overrule |
| 22  | Knowledge                                                        | **A kind, as board 2 lists it.** Products, templates, workflows, campaigns and menu places are Not yet.                                                                                                                                                                                                                                                                                                                                                      | Claude's call, Chris can overrule |
| 23  | Accents                                                          | **Names, titles and the words read from files fold accents ("jose" finds José); message and note text doesn't.** One map in core (`search/fold.ts`) turns each letter into one letter (ł into l, ø into o, ß into s, æ into a), and `private.search_fold` copies it with the built-in `translate`. No `unaccent` extension: it isn't installed, and it turns ß into ss, which would throw the highlighting out of line and make the phone disagree.          | Claude's call, Chris can overrule |
| 24  | Port papers                                                      | **Never in search, for anyone.** They hold the losing carrier's account number and PIN (`schemas/port.ts:10-12`).                                                                                                                                                                                                                                                                                                                                            | Claude's call, Chris can overrule |
| 25  | Finished things                                                  | **Done tasks, won and lost leads, void bills and cancelled visits stay in their kind, marked, after the open ones.** Only archived records go to Archived.                                                                                                                                                                                                                                                                                                   | Claude's call, Chris can overrule |
| 26  | Typos                                                            | **Close matches only when nothing else matched, on contact, company, lead and record names, by edit distance that counts swapped letters** ("dnaa smtih" finds Dana Smith). Names close on every typed word come first, then names close on some, so Marcus Smith still follows the two Dana Smiths as board 4 draws. The same check runs on the phone.                                                                                                      | Claude's call, Chris can overrule |
| 27  | Enter in the dropdown                                            | **Enter opens the row picked with ↑ or ↓; with none picked, the Search page. ⌘↵ or Ctrl↵ always opens the page.** Boards 1 and 2 both hold.                                                                                                                                                                                                                                                                                                                  | Claude's call, Chris can overrule |
| 28  | Archived and the bin in the dropdown                             | **Shown only when the active groups have fewer than 3 hits** (board 4's "No one active matches"). The Search page always lists them last.                                                                                                                                                                                                                                                                                                                    | Claude's call, Chris can overrule |
| 29  | Messages rows                                                    | **One row per conversation**: its best message as the snippet, with "3 matches". One-to-one messages rank above campaign and automated sends. A call with no conversation opens its customer's timeline, and is skipped with neither.                                                                                                                                                                                                                        | Claude's call, Chris can overrule |
| 30  | Viewing as someone on the phone, with no signal                  | **Settings only, and it says searching needs signal while viewing as them.**                                                                                                                                                                                                                                                                                                                                                                                 | Claude's call, Chris can overrule |
| 31  | The header's search button on a phone-width web page             | **Inside the Inbox it stays "Search conversations". Everywhere else it opens Search.**                                                                                                                                                                                                                                                                                                                                                                       | Claude's call, Chris can overrule |
| 32  | The Assistant                                                    | **No search tool this release.** Its `search_customers` keeps working; its map of the app is corrected.                                                                                                                                                                                                                                                                                                                                                      | Claude's call, Chris can overrule |
| 33  | Group order, chips and the kinds list                            | **Groups whose best hit is tier 0 to 2 come first, by tier; every other group follows in kind order. The chips and the Search page's kinds list use the same order.** Board 1's dropdown (Messages above Calendar, both tier 3 or 4) and board 4's address (the Listing at tier 1, then Contacts and Calendar) both hold. Boards 1 and 2 draw the chips with Calendar before Messages; that order was only an example.                                       | Claude's call, Chris can overrule |
| 34  | Notes and form answers found by who they're on                   | **Yes, after the ones whose own words matched.** Board 2 finds "Gate code 4471, dog in the yard" and "Answered by Jo Smithers" for "smith" through the person, so Notes and Forms each gain a capped arm on the name of who the line is on or who answered (`why.field = 'customer'`, tier 4, ranked after the word matches).                                                                                                                                | Claude's call, Chris can overrule |
| 35  | Last contact on a contact's row                                  | **The newest message, call, note or visit either way, or a booking (`appointment_booked`); "Paid" from their newest paid invoice when the person may see money.** Board 2's "Paid Sep 30" and "Booked yesterday" come out as drawn. "Form sent Oct 2" (boards 3 and 5b) has no record anywhere, so it never shows; the row falls back to the line before it.                                                                                                 | Claude's call, Chris can overrule |
| 36  | Board 6's rows                                                   | **An example only.** No automation is called "Follow up on leads that went quiet". "quiet" finds the real catalogue's entries (Quiet hours, the Automations rows whose words hold it, and the Adjust field "Gone quiet after"), and the count is what `settingsFound` works out from them.                                                                                                                                                                   | Claude's call, Chris can overrule |
| 37  | What's typed, in the web's address                               | **Kept after `#`, never in the query string.** The Search page is `/search#q=…`, read in the browser, so what's typed never reaches the web's own server or its host's request logs. The Contacts page's own box keeps its `?q=` as today (`customers-list.tsx:96-113`).                                                                                                                                                                                     | Claude's call, Chris can overrule |
| 38  | A meeting summary on a private record                            | **Sealed with the record.** Today `call_suggestion.record` posts the summary note with only the customer and lead (`call-suggestion.ts:170-176`), so a tour on a private deal leaves an unsealed note any member reads. Stage 3 passes the appointment's `custom_record_id` to `activity.log`, so the note is sealed with the deal, before Notes are searched. Hosted has no transcripts, so nothing needs moving.                                           | Claude's call, Chris can overrule |

Kept from earlier work, not re-asked:

- Only `records.delete` holders see the Deleted bin, which keeps things 30 days (docs/deleting.md:21-28).
- A turned-off add-on's records stay hidden until it's back on (Chris, 2026-09-28; docs/addon-readiness-audit.md:377).
- Private records, and what hangs off them, stay with their people (Chris, 2026-09-30; docs/relationships.md:66-80).
- A person's own mailbox is theirs alone, never shown through a teammate view (20261013001200, 20261018000100).
- Inbox narrowing (0083), and words read out of a thread follow the thread (SEC-M15, 20261012020400:1-27).
- Setting the business up stays on the web on the phone, except the balance, add-ons, the main offer and partners
  (`apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/settings/index.tsx:66-74`).
- Form answers never reach phones (M17, `apps/mobile/src/forms/use-answers.ts:14-21`).
- Core never points into an `addon_<id>` schema, and an add-on never touches another.
- Every edit to `apps/sync/sync-config.yaml` makes every phone copy everything again. This plan makes none.
- The Error messages rules in CLAUDE.md. Matomo never sees what's typed (`apps/web/src/components/matomo.tsx:16-17`).
- ⌘J stays the Assistant's.

## What the repo has, and what it's missing

**Has:**

- Four list searches on a generated, trigram-indexed `search_text`: `person.list`, `company.list`, `lead.list`,
  `custom_record.list`. They use `like '%q%'` with no escaping and no phone normalising.
- Exact phone and email matching, other phones and emails included (`crm/matching.ts:10-22`), and `normalizePhone`
  (`crm/phone.ts:3-13`).
- Knowledge's ranked search with snippets (`searchKnowledge`, `knowledge/search.ts:80`).
- The inbox's thread search and its rules (`inbox.list`; `inInbox` in `inbox/rows.ts:356-398`), and the thread's
  exclusions: cancelled held texts and unanswered bridge calls (`queries/inbox.ts:1031,1049`).
- The worker's reader: `pdfPages` and `documentText` (`apps/worker/src/files/document-text.ts`), `readFileBytes`
  (`files/read.ts`), and `knowledge_document.save_text` as the pattern for a system command that saves what was read
  (`commands/knowledge.ts:546-617`).
- `messages_workspace_occurred_idx` on `(workspace_id, occurred_at desc)` (20261012070200:12-13).
- A side table whose policy defers to its source, `appointment_transcripts` (20261027003400:33-37), and a
  cross-business finder for the worker, `private.bin_due` (20261027000400:990-1014).
- Core's settings map for the Assistant with a test that reads the web's menus (`assistant/settings-map.ts`,
  `test/settings-map.test.ts`), the Automations catalogue (`automations/catalog.ts`), and jump-and-ring on Add-ons
  (`?addon=`) and Automations (`?adjust=`).
- On the web: Radix Popover in the shell (`nav-links.tsx:414-463`), two hand-made ARIA comboboxes
  (`industry-picker.tsx:63-172`, `address-input.tsx:70-138`), a debounced typeahead (`record-picker.tsx:36-92`), and
  ⌘J's key guard (`assistant-provider.tsx:637-652`).
- The add-on teammate pattern: a manifest names operations, and core finds them through `ADDON_SERVER_MODULES` and
  runs them through the kernel (`addons/teammate.ts:142-152`). Real Estate's own deal search, and its phone mirror
  `dealListOfCopy` with a parity test.
- On the phone: `openAppPath` and `routeFor` (a web path opens a phone screen or the browser), `useNetwork`,
  `asOfText`, `SearchBox`, `useSettled`, and a Search button in the m10 boards' top bar that the built `AppBar` left
  out.

**Missing:**

- Any search across kinds, and any search of message bodies, notes, tasks, calls, appointments, files, form answers
  or settings.
- A way to run an add-on's query inside another query (`executeCommandWithin` is for commands only,
  `kernel/execute.ts:801-824`).
- Any record of a file's words (`app.files` keeps only the name), and any Word or Excel reader.
- Indexes for a business's notes, threads and form answers by time.
- Deep links to a message in a thread, one task, one form response on the web, one note, a file on a record, the text
  composer, the merge dialog, a bin item, a new contact with a name, and one setting.
- A settings catalogue in core: the Settings menu (`GROUPS`) lives only in the web, and `SetRow` has no id.
- Rate limits on query routes other than invitations, and a rule on the 429 body.
- ⌘K, and a search route on the web or the phone.

## How it works

### 1. One search, start to finish

1. **The client** waits for 2 characters and 250 ms (300 ms on the phone), drops a stale answer with an
   `AbortController`, and works out the Settings group on the device from core's catalogue. It tells the server
   whether a setting matched (`settingsMatched`), and decides the empty, close-match and no-one-active lines itself,
   after merging the Settings group in.
2. **The API**: `POST /v1/queries/search.everything` or `search.kind` (`apps/api/src/routes.ts:58-75`). What's typed
   is in the body, never the path. Both routes carry a per-person rate limit and a per-machine slot gate (6 below).
3. **The kernel**: `executeQuery` opens the person's transaction (`asUser`, role `authenticated`, row security on),
   resolves the business (a teammate view included) and checks `workspace.read`, which every role holds and no owner
   can turn off (`permissions.ts:204-277`). Humans only, and no `ai`.
4. **The handler** (`packages/core/src/queries/search.ts`, then `search/server/run.ts`):
   - builds the probes once (`searchProbes`);
   - works out which kinds run (`searchKindsFor`, in Who can see what);
   - runs every statement, from a kind's candidates to its facts, snippets, paging and counts, through one guard,
     `step` (6 and 7 below): its own savepoint, a statement timeout cut to what's left of the request's budget, and
     errors turned into a marked group or a scrubbed error;
   - runs each add-on contributor last, each through `step` too;
   - ranks, explains and snips in core's JavaScript, picks the best match and orders the groups.
5. **Nothing is written.** A query has no `emit`: no event, outbox or audit row, and nothing typed is stored.

### 2. Why there are no text indexes

Checked on the hosted database (2026-10-20) with catalogue reads and EXPLAIN. Tests pin it: the leakproof catalogue in
`packages/db` (stage 1), and the plans of core's own statements in `packages/core` (stages 2 and 3).

- A person's query runs under row security, so Postgres uses an index for a condition the query adds only when that
  condition's function is leakproof. `textlike` (LIKE), `texticlike`, pg_trgm's `similarity_op` and
  `word_similarity_op`, `ts_match_vq` (`@@`), `jsonb_contains`, `arraycontains` and `citext_eq` are not. Plain equality
  and ordering are: `texteq`, `uuid_eq`, `int8eq`, `text_ge`, `text_lt`, `starts_with` and the timestamp comparisons.
  Supabase's `postgres` role isn't a superuser, so nothing can be marked leakproof.
- So `select id from app.people p where p.search_text like '%smit%'`, run as `authenticated`, is a Seq Scan even with
  `enable_seqscan` off. `people_search_idx` is never used by `person.list` today. With `workspace_id = …` added, it
  becomes an index scan on the business with the LIKE as a filter.
- A plain scan is cheap at today's sizes. ILIKE over all 17,810 messages of the busiest business (8.98 million
  characters) took 143 ms as `postgres` and 154 ms as its owner under full row security: about 8 µs a message.
  `to_tsvector` worked out per row took 1,072 ms, so long text is matched with LIKE, not with full text computed on
  the fly.
- A partial index's own condition is proved from every condition in the query, whatever its security level, so a
  partial btree index does work under row security.

So:

- **Small kinds scan the whole business** through a `workspace_id` btree: people, companies, leads, tasks,
  appointments, estimates, invoices, payments, forms, custom records, knowledge, file names and bin items.
- **Long text is matched in a window**: the business's newest rows, bounded by count and by time, read through a
  btree on `(workspace_id, time)`. The words are a filter over that window only.
- **Exact identifiers** use leakproof equality where it helps: a phone in E.164 on `people_phone_idx`, a thread's
  counterpart on `conversations_one_per_line`.
- **No GIN index is added.** It would cost write locks and storage, and buy nothing.

### 3. What each kind searches

| Kind (group label)                                              | Needs            | Matches                                                                                                                                                                                                                                                                        | Window, quick / full                                                                                                     |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Contacts                                                        | `records.read`   | names (folded), every email and phone, address, city, state, postal code, company name, custom field values                                                                                                                                                                    | whole business                                                                                                           |
| Companies                                                       | `records.read`   | name (folded), website, email, phones, address                                                                                                                                                                                                                                 | whole business                                                                                                           |
| Leads                                                           | `records.read`   | title (folded), the customer's name or company name                                                                                                                                                                                                                            | whole business                                                                                                           |
| Money                                                           | `money.read`     | estimates and invoices by number (the whole number, or its counter without the prefix), an amount typed as money, title, notes and customer, drafts included; payments by amount, the card's last 4, or their invoice's number or customer. Never a provider or idempotency id | whole business                                                                                                           |
| Messages                                                        | `inbox.use`      | a thread's counterpart exactly; the customer's, chat visitor's or Meta name and @handle; counterpart digits; the last preview; words in a message's subject and plain text (never its HTML); call transcripts. Never a thread on a turned-off add-on's record                  | messages 4,000 rows or 180 days / 25,000 or 3 years; threads 3,000 or 180 days / 20,000 or 3 years; calls 2,000 / 10,000 |
| Calendar                                                        | `workspace.read` | title, notes, the place's address, attendees' names, phones and emails. Never an appointment on a turned-off add-on's record, and never a meeting's transcript or summary (decision 15)                                                                                        | whole business                                                                                                           |
| Tasks                                                           | `records.read`   | title, notes                                                                                                                                                                                                                                                                   | whole business                                                                                                           |
| Notes                                                           | `records.read`   | the body of note lines (decision 6); then the name of who the note is on (decision 34)                                                                                                                                                                                         | 3,000 / 20,000                                                                                                           |
| Files                                                           | `records.read`   | names; the words inside (stage 5)                                                                                                                                                                                                                                              | names, whole business; words, 1,000 files / 10,000                                                                       |
| Forms                                                           | `workspace.read` | form names; answers of completed responses (payment answers only with `money.read`); then the name of who answered (decision 34)                                                                                                                                               | names, whole business; answers 3,000 / 20,000                                                                            |
| Knowledge                                                       | `workspace.read` | knowledge items, through `searchKnowledge`                                                                                                                                                                                                                                     | whole business                                                                                                           |
| A business's own kinds (a group each, its plural and icon)      | `records.read`   | `custom_records.search_text` and the folded name                                                                                                                                                                                                                               | whole business                                                                                                           |
| Add-on groups (Real Estate: Listings, Deals, Homes, Properties) | the add-on's own | the add-on's query                                                                                                                                                                                                                                                             | the add-on's                                                                                                             |
| Settings                                                        | each entry's own | core's catalogue, on the device                                                                                                                                                                                                                                                | none                                                                                                                     |
| Archived                                                        | the kind's       | archived people, companies, leads, conversations, forms and records, by name or title                                                                                                                                                                                          | with the kind                                                                                                            |
| Deleted bin                                                     | `records.delete` | each bin item's name                                                                                                                                                                                                                                                           | whole business                                                                                                           |
| Spam                                                            | `inbox.use`      | as Messages, Spam folder only, only when picked                                                                                                                                                                                                                                | as Messages                                                                                                              |

**Quick** is the dropdown's (`depth: 'quick'`), **full** the Search page's. A windowed group says whether it looked at
everything (`complete`) and how far back it went (`searchedBack`). On one kind's page, **Look further back** moves the
window back (`before`). Every business fits wholly in the full window today.

### 4. Ranking, the best match, and why each hit matched

Tiers, in `packages/core/src/search/rank.ts`, the same on the server and the phone:

| Tier | What matched                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | An exact identifier: a phone however it was typed (main or other), an email (main or other), a document number, an amount, a card's last 4, a counterpart, an MLS number.                  |
| 1    | Every word starts a word of the name or title; or the website's or email's domain.                                                                                                         |
| 2    | The name or title holds every word.                                                                                                                                                        |
| 3    | Another identifying field: address, city, postal code, company, phone digits, a custom field, a lead's or bill's customer, an attendee.                                                    |
| 4    | Words in content: a message, a call, a note, a task's or visit's notes, a file's words, a form answer, a knowledge item; after those, the name of who a note is on or who answered a form. |
| 5    | A close match (a typo).                                                                                                                                                                    |

Inside a tier: open before done, won, lost, void or cancelled; one-to-one messages before campaign and automated sends
(`campaign_recipient_id` set and `sent_by` null); then the newest (last contact, the message, or the last change);
then the name.

- **Best match**: the best hit overall at tier 2 or better, from Contacts, Companies, Leads, Money, a business's own
  kinds or an add-on group, ties going to kind order. The dropdown takes it out of its group: board 1 shows Dana above,
  and Marcus and Jo under Contacts. The Search page has no Best match row.
- **Group order** (decision 33): groups whose best hit is tier 0 to 2 first, by that tier, ties in kind order; then
  every other group in kind order (Contacts, Companies, Leads, Money, Messages, Calendar, Tasks, Notes, Files, Forms,
  Knowledge, a business's own kinds, add-on groups, Settings). The chips and the Search page's kinds list follow the
  same order. Board 1 then reads as drawn (Contacts, Companies, Leads, Money, then Messages before Calendar, which
  goes under "Also found"), and so does board 4's address: the Listing (its name is the address, tier 1), then the
  Contact (Address, tier 3) and the visit there (tier 3) in kind order. `orderGroups` in core is the one place this
  lives.
- **Exact match first**: when the search is a phone, an email or a number and something matched it exactly, that hit
  sits under **Exact match**, and the rest under **Also has 1042 in it** (board 4).
- **Why it matched**: every hit has `why.field`: `phone`, `email`, `website`, `number`, `amount`, `card`, `name`,
  `title`, `address`, `company`, `customer`, `field`, `mls`, `message`, `call`, `voicemail`, `note`, `task_notes`,
  `file_name`, `file_text`, `form_name`, `answer`, `knowledge`, `setting` or `close`. Core words the chip: "Phone",
  "Email", "Website", "Address", "Number", "In the file", "Form answer", "MLS number". A plain name match, and a note
  or answer found by who it's on, shows the marked name and no chip, as the boards do.
- **Marks**: core's `marksIn(text, probes)` gives `[start, end]` ranges, folded ("jose" marks "José") and digit-aware
  ("5550142" marks "(504) 555-0142"). The fold (`search/fold.ts`) turns each letter into exactly one letter, so a range
  found in the folded text fits the original. Both apps draw them as text inside `<mark>`, never HTML. The server sends no
  markup: `ts_headline` runs only inside knowledge's own search, and core turns its `**` markers into ranges. A body
  holding "<" can't inject anything.
- **Close matches** (`search/close.ts`): only when tiers 0 to 4 found nothing, no setting matched on the device
  (`settingsMatched`), and a word has 4 or more letters. The SQL, in its own `step`, takes up to 300 names from
  contacts, companies, leads and records where
  `extensions.similarity(private.search_fold(name), $fold) > 0.08 or extensions.word_similarity($fold, private.search_fold(name)) > 0.15`,
  best first. Contacts are held to `LIVE_PERSON` (not in the bin, not erased, not merged; The searchers): row security
  hides companies, leads and records in the bin but still shows people, so without it a binned customer's misspelt
  name, with a link, would reach a member who can't open the bin. Core counts, for each name, the typed words that lie
  within optimal-string-alignment distance 1 (words of 4 to 7 letters) or 2 (8 or more) of one of its words, keeps
  the names with at least one, and lists those close on every word first, then the rest by how many.
  `similarity('dnaa smtih', 'dana smith')` is 0.158, so trigrams alone miss board 4's typo. One swap a word finds both
  Dana Smiths on both words, then Marcus Smith on one ("smith"; `similarity('marcus smith', 'dnaa smtih')` is 0.091,
  inside the prefilter), as board 4 draws.

### 5. Archived, the Deleted bin, Spam and Other mail

- **Archived** (`archived_at` set): people (not merged, not in the bin, not erased), companies, leads,
  conversations, forms and records, matched on name or title only. "Archived Mar 3 · Restore from the record’s menu".
  **Include archived** folds them into their own kinds with an Archived badge instead.
- **Deleted bin**: `records.delete` holders only (row security on `bin_items` says so too, 20261027000400:92-93).
  Matches `bin_items.name` and nothing inside, items not already emptying, newest first. "Texts with Tom Becnel ·
  Deleted 4 days ago · Gone for good in 26 days". It opens Settings → Deleted bin with the item ringed.
- **No one active**: when only Archived or the bin found something, and no setting matched, the line at the top reads
  "No one active matches “tom becnel”." The client decides this line, the close-match line and the empty state after
  merging its Settings group, so "quiet hours" shows its setting with no close-match line (board 4).
- **Spam** never shows in Messages; the Messages kind page offers **Look in Spam** (`kind: 'spam'`). **Other mail**
  shows in Messages with an "Other mail" badge. A person's own mail shows with "My mail".

### 6. Capacity

The API is 2 machines with 6 database connections each (`apps/api/src/app.ts:52`), one transaction a request and a
15-second statement ceiling (`packages/db/src/client.ts:58`), on Micro compute.

- **Budgets.** Quick: 2 s a request, 1.5 s a statement. Full: 6 s and 4 s. One kind: 8 s and 5 s. Before every
  statement `step` runs `select set_config('statement_timeout', '<ms>ms', true)`, the smaller of the cap and what's
  left. Postgres reads `0` as no limit at all, so the value is never below 50 ms: with less than 50 ms left, the step
  doesn't run and its kind is marked `skipped`. The setting is local to the transaction and replaces `asUser`'s 15 s
  for the rest of it, which is why every statement sets its own.
- **A savepoint per statement, through one guard.** `step(kind, fn)` in `search/server/run.ts` runs every statement a
  search makes: a kind's candidates, its facts, display rows and snippets, `search.kind`'s paging, duplicates and
  standing counts, close matches, and each add-on contributor. A statement timeout (SQLSTATE 57014, read from the
  error's `cause` chain, as `translateDbError` reads codes, `kernel/pg-errors.ts:12-16`) rolls back that savepoint
  alone and marks its group `unavailable: 'too_slow'`. A spent budget marks the kinds not yet run `skipped`. Only when
  every kind tried was slow or skipped does the request refuse `search_took_too_long` (503, retried). Nothing runs
  outside a step, so no error can leave the transaction aborted for the statements after it. The worst case stays far
  inside the 30-second idle-in-transaction limit (`client.ts:59`).
- **Caps.** `perKind + 1` rows a kind (3 in the dropdown, 4 on the page), counts over a set cut to 101 rows and shown
  as "100+", and snippets cut in SQL (`substr` around `strpos`) for returned rows only. A row never carries a whole
  body.
- **The slot gate** (`apps/api/src/search-slots.ts`, `acquireSlot(timeoutMs)`): at most 3 searches at once on a
  machine, so search never holds more than half its 6 connections. A fourth waits up to 1 s, then gets `search_busy`
  (503, retried). Other routes never wait on it.
- **Rate limits** (`RATE_LIMITED`, `routes.ts:15-18`): `search.everything` 90 a minute and `search.kind` 60 a minute
  per person, keyed by the user's id (the IP when there's none), on the `preHandler` hook so `req.actor` is set,
  refused with the rule `search_too_fast` (429). They're in memory on each machine, so the real ceiling is double;
  accepted.
- **Only two routes.** An add-on's search query is marked `route: false` (a new `QueryDef` field), so the API never
  mounts it (`routes.ts:58-75` skips it) and it can only run inside `search.everything` or `search.kind`, under their
  rate limit and slot gate. `addonSearchIssues` requires the mark (Add-ons answer searches).
- **Clients**: 2 characters at least, a debounce, a stale answer dropped, one quiet retry after 2 s on a retried
  refusal.
- **Arithmetic.** A quick search is about 14 short statements on one connection: typically 60 to 250 ms, at worst 2
  s. Two machines with 3 slots each hold at most 6 of the API's 12 connections.
- A load check before the screens (stage 3) proves the budgets on a local business with 300,000 messages.

### 7. Privacy

- What's typed goes in the POST body to the API, never a URL path or query string, and is never stored on the server.
- **The web keeps it after `#`** (decision 37): the Search page is `/search#q=…&kind=…`, and "See all", "Also found"
  and "Add a contact" (`/customers#add=person&name=…`) build their links the same way. A browser never sends what's
  after `#`, so what's typed never reaches the web's own server or the request logs its host keeps for a day
  (docs/operations.md:12662). Matomo sends the route alone, with ids replaced (`matomo.tsx:16-17`). The
  Contacts page's own box keeps its filter in `?q=` as it does today (`customers-list.tsx:96-113`); search never
  sends anyone there with what was typed.
- **Nothing typed reaches a log.** Drizzle's query error puts the statement's parameters in its message
  (`drizzle-orm` 0.45.2, `errors.js:10-14`: `Failed query: …\nparams: …`), `translateDbError` hands back any error
  whose code it doesn't map untouched (`kernel/pg-errors.ts:657,698-699`), and the API logs an unhandled error whole
  (`apps/api/src/errors.ts:56-57`). So:
  - `step` catches every error of every statement: a 57014 marks the group; an `HfosError` is thrown on; anything else
    is thrown again as `new Error('search <kind> failed: <SQLSTATE>')`, with no cause, no message and no parameters;
  - both handlers, `search.everything` and `search.kind`, are wrapped whole in one more catch that does the same for
    anything that got past a step, and turns a 57014 outside a kind into `search_took_too_long`;
  - a contributor's failure is dropped with its group marked `failed`, and logged, if at all, by add-on id and
    SQLSTATE only.
    A test forces a database error and a 57014 in a kind, a snippet statement, close matches, `search.kind`'s paging and
    a contributor, and checks that neither the answer nor the captured API log holds what was typed.
- Recent searches stay on the device and with the person: the web in `localStorage` under
  `hfos.search.recent.<userId>.<workspaceId>`, and when the box mounts it removes every `hfos.search.recent.*` key that
  isn't the signed-in person's, so a shared office browser never shows the last person's searches, however they left
  (the server's sign-out route, an expired session, "Sign out and switch account"). Sign-out still clears them as a
  courtesy. The phone keeps them in its encrypted database, by `user_id`.
- The phone's store answers stay "Search History: No", with new reasons (stage 9).

### 8. One copy of shared logic

In `@hfos/core`, used by the server, the web and the phone: the probes (amounts from `money/format.ts`'s
`parseMoney`, document numbers from `money/numbering.ts`), the fold map (`search/fold.ts`, copied into
`private.search_fold`), the kinds and their gates (`SEARCH_KINDS`, the only place a kind's gate is written), the
tiers and ranking, why-it-matched words, marks and snippets, close matches, links, the dropdown's choices (`dropdownOf`), the
grey lines (`hitLines`), the phone's offline search (`searchCopy`), the settings catalogue and `searchSettings`, and
every word. The server's SQL only filters roughly; the same JavaScript ranks rows on the server and on the phone.

## The database

Two migrations, each numbered above the newest file in `supabase/migrations` when it's written (today
`20261027009600_the_497_seat_goes_yearly.sql`; check with `node scripts/migrations-check.mjs`). Plain `create index`,
because migrations run in a transaction (20261012070100:21-23). Each goes on the hosted database before `main` ("Apply
new migrations", docs/operations.md:552). After the connector's `apply_migration`, its recorded version is set back to
the file's (docs/operations.md:674).

### Migration A (stage 1): `<version>_search_windows.sql`

```sql
-- Folding accents, one character for one character, so a mark found in the folded text fits the original. The two
-- strings are core's FOLD_FROM and FOLD_TO (packages/core/src/search/fold.ts), copied here when this is written;
-- search/fold.test.ts runs both over the same words and fails if they disagree. Built-ins only, so truly immutable.
create or replace function private.search_fold(p text) returns text
  language sql immutable parallel safe set search_path = '' as $$
    select lower(translate(coalesce(p, ''), '<FOLD_FROM>', '<FOLD_TO>')) $$;
revoke all on function private.search_fold(text) from public;
grant execute on function private.search_fold(text) to authenticated, service_actor;

-- Notes, newest first. Partial, so channel copies and system lines aren't in it. The condition is written exactly
-- as core's NOTE_LINES (packages/core/src/search/server/kinds/notes.ts), so the planner proves it.
create index activities_notes_idx on app.activities (workspace_id, occurred_at desc, id desc)
  where kind = 'note' or (kind in ('call', 'visit') and subtype is null);

-- Threads by recency. Today's start (workspace_id, status, ...) or are partial (20260913000100:184-185).
create index conversations_recent_idx
  on app.conversations (workspace_id, last_message_at desc nulls last, id desc);

-- Form answers by recency. Today there is only (workspace_id) (20260927000200:110).
create index form_answers_recent_idx on app.form_answers (workspace_id, answered_at desc);

-- A response's answers are hidden while the response is in the Deleted bin. form_answers_select is workspace-only
-- (20260927000200:152-153); only form_responses has a bin rule (20261027000400:187-189).
create policy form_answers_follow_response on app.form_answers as restrictive for select to authenticated
  using (response_id in (select r.id from app.form_responses r));
```

- `private.search_fold` uses only `translate` and `lower`, both built in and immutable, so it is honestly immutable and
  Migration B's generated column may use it. The map turns upper and lower case accented Latin letters into their
  plain letter, one for one: é into e, ł into l, ø into o, đ into d, ß into s, æ into a, œ into o, İ into i. A letter
  outside the map is left as it is, combining accents included, so the length never changes. Core's `fold()` applies
  the same map, then lower-cases each character on its own. No `unaccent`: it isn't installed (only `citext`,
  `pgcrypto`, `pg_trgm` and `btree_gist` are, 20260911000100:15-16, 20260912000100:10, 20260915000200:18), its
  dictionary can change in an upgrade under a stored column, and it turns ß into ss and æ into ae, which moves every
  mark after them and would make the server and the phone rank the same row differently.
- The new policy's inner read runs `form_responses`' own rules as the person, its bin rule included, and touches only
  `id`, which `authenticated` is granted (20260927000200:159-163). The service actor's policies don't change.
  `form.results` follows on its own.
- Sizes on hosted: activities about 1.7k rows, conversations about 1k, form answers none. Each build holds a SHARE
  lock for milliseconds.
- Reused, not added: `messages_workspace_occurred_idx`, `calls_workspace_idx`, `people_workspace_idx`,
  `people_phone_idx`, `companies_workspace_idx`, `companies_phone_idx`, `tasks_workspace_due_idx`, `files_record_idx`,
  `appointments_range_idx`, the estimates' and invoices' list and number indexes, `knowledge_items_list_idx`,
  `bin_items_list_idx` and `conversations_one_per_line`.
- Drizzle: nothing to mirror. Drizzle doesn't hold indexes, and there are no new tables, columns or enums, so the parity
  test is untouched.

### Migration B (stage 5): `<version>_file_texts.sql`

```sql
-- The words of a text as core splits them for `$tsq` (search/probes.ts, `searchWords`): folded, every run of anything
-- that isn't a letter or a digit made one space, and a run of digits without its leading zeros. So "INV-001042",
-- "(504) 555-0142", "dana.smith@gmail.com" and "www.gulfcoastrealty.com" give 1042; 504 555 142; dana smith gmail com;
-- www gulfcoastrealty com, as a message or a contact would be matched. regexp_replace is immutable.
create or replace function private.search_words(p text) returns text
  language sql immutable parallel safe set search_path = '' as $$
    select regexp_replace(regexp_replace(private.search_fold(p), '[^[:alnum:]]+', ' ', 'g'),
                          '(^| )0+([0-9])', '\1\2', 'g') $$;
revoke all on function private.search_words(text) from public;
grant execute on function private.search_words(text) to authenticated, service_actor;

create table app.file_texts (
  file_id uuid primary key references app.files (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  state text not null check (state in ('done', 'truncated', 'no_text', 'unsupported', 'too_large', 'unreadable')),
  text text not null default '' check (char_length(text) <= 100000),
  -- Where each page (PDF) or sheet (Excel) starts in `text`, so a hit can say "page 3".
  pages integer[] not null default '{}' check (cardinality(pages) <= 2000),
  chars integer not null default 0 check (chars between 0 and 100000),
  -- The reader's version: a better reader reads older rows again through the sweep.
  reader smallint not null check (reader between 1 and 100),
  extracted_at timestamptz not null default now(),
  -- The words, without positions. Stored, because this table is never published.
  words tsvector generated always as (strip(to_tsvector('simple'::regconfig, private.search_words(text)))) stored
);
create index file_texts_recent_idx on app.file_texts (workspace_id, extracted_at desc);

-- The same business as its file (the appointment_transcripts pattern, 20261027003400:21-31).
create function private.check_file_text_refs() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from app.files f where f.id = new.file_id and f.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514',
      detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger file_texts_check_refs before insert or update on app.file_texts
  for each row execute function private.check_file_text_refs();

alter table app.file_texts enable row level security;
-- A file's words are read exactly when the file could be opened: the inner read brings files_select (sealed) and
-- files_not_binned with it, and the rest copies the storage read rule (20261027000400:1270-1279), with port papers
-- and knowledge files never, and a hidden add-on kind's records never (custom_record_visible).
create policy file_texts_select on app.file_texts for select to authenticated using (
  workspace_id in (select private.accessible_workspace_ids())
  and file_id in (select f.id from app.files f
    where f.status = 'ready' and f.deleted_at is null
      and f.record_type not in ('port', 'knowledge')
      and (f.record_type <> 'custom_record' or private.custom_record_visible(f.record_id))));
create policy file_texts_service_all on app.file_texts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.file_texts to authenticated;
grant select, insert, update, delete on app.file_texts to service_actor;
revoke all on app.file_texts from anon;

-- Deleting a file for good forgets its words, whoever deletes it. Putting it in the bin sets bin_item_id in the same
-- statement (20261027000400:755), so this doesn't fire, the words stay hidden, and Bring back shows them again.
create function private.forget_file_text() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from app.file_texts t where t.file_id = new.id;
  return new;
end $$;
revoke all on function private.forget_file_text() from public;
create trigger files_forget_text after update of deleted_at on app.files for each row
  when (old.deleted_at is null and new.deleted_at is not null and new.bin_item_id is null)
  execute function private.forget_file_text();

-- The worker's catch-up, across businesses, as private.bin_due is: files with no words yet, or read by an older reader.
create function private.files_without_text(p_limit integer, p_reader smallint)
returns table (file_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select f.id, f.workspace_id, w.organization_id
  from app.files f
  join app.workspaces w on w.id = f.workspace_id
  left join app.file_texts t on t.file_id = f.id
  where f.status = 'ready' and f.deleted_at is null and f.bin_item_id is null
    and f.record_type not in ('knowledge', 'port')
    and f.created_at < now() - interval '5 minutes'
    and (t.file_id is null or t.reader < p_reader)
  order by f.created_at
  limit greatest(1, least(coalesce(p_limit, 100), 500))
$$;
revoke all on function private.files_without_text(integer, smallint) from public;
grant execute on function private.files_without_text(integer, smallint) to service_actor;
```

- `file.delete` is a person's command and the person can only read `file_texts`; the definer trigger is what forgets
  the words, on every path that deletes a file (`file.delete`, a refused portal upload, anything later).
- What happens to the words: they stay while the file is in the bin, hidden by the policy, and come back on Bring
  back; they go when the file is deleted (the trigger), and by cascade when the bin is emptied
  (20261027000400:1120-1125), when a pending row is swept, and when the business is deleted. Merges move
  `app.files.record_id` by direct SQL (20261012150100:280); `file_texts` keeps no copy of it, so nothing goes stale.
- No `portal_actor` grant, and not added to the `powersync` publication.
- No GIN index on `words`: row security couldn't use it. Matching a stored `tsvector` per row costs microseconds.
- Drizzle: `fileTexts` beside `files` in `packages/db/src/schema/index.ts`, its `words` through the existing `tsvector`
  type with ``generatedAlwaysAs(sql`strip(to_tsvector('simple'::regconfig, private.search_words(text)))`)``, and added
  to the `tables` export so the parity test checks it.
- Without `private.search_words`, the `simple` parser keeps "INV-001042" as the signed number `-001042`, a phone's
  last part as `-0142`, and an email or a web address as one token (checked on local Postgres), so "1042", "0142",
  "smith" and "gulfcoastrealty" would match everywhere but inside a file. `search/fold.test.ts` runs core's
  `searchWords` and the SQL function over the same corpus.

### Published tables, and how this keeps clear of them

`activities`, `conversations`, `messages`, `calls`, `files`, `people`, `companies`, `leads`, `tasks`, `appointments`,
`estimates`, `invoices`, `payments`, `forms` and `custom_records` are in the `powersync` publication. PowerSync's first
copy of a published table is `SELECT *` (`packages/db/test/sync-secrets.test.ts:1-9`), and a stored column would also
rewrite the table under ACCESS EXCLUSIVE. So nothing here adds a column to a published table: Migration A adds indexes,
a function and a policy, and Migration B's new table isn't published (`form_answers` isn't either).
`apps/sync/sync-config.yaml` isn't touched, the phone's generated schema doesn't change, and `sync.yml` needn't run.

### Not added, on purpose

- No GIN, trigram or `tsvector` index anywhere.
- No extension: not `unaccent` (decision 23), `btree_gin` or `fuzzystrmatch`.
- No search table, and no column on any published table.
- No messages index: `messages_workspace_occurred_idx` is already there.
- No index for calls by number: a call is found through its thread's counterpart.

## Commands, queries and routes

| What                 | Name                     | Who                                                              | Notes                                                                                                                                                                |
| -------------------- | ------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search everything    | `search.everything`      | `workspace.read`, humans                                         | Reads only. Rate limit 90 a minute, slot gate. Phone contract.                                                                                                       |
| One kind             | `search.kind`            | `workspace.read`, humans                                         | 50 at a time. Rate limit 60 a minute, slot gate. Phone contract.                                                                                                     |
| One timeline line    | `activity.get`           | `records.read`                                                   | For `?activity=` links. A line on a custom record only when that record reads.                                                                                       |
| Tasks                | `task.list`              | as today                                                         | Gains `taskId: uuid.optional()` (`schemas/task.ts:104-114`, `task.list.ts:70-77`), so `/tasks?task=<id>` opens one.                                                  |
| A thread             | `conversation.thread`    | as today                                                         | Gains `upTo: isoDateTime.optional()`: items at or before that moment, so a hit opens at its message; newer ones load with `since`.                                   |
| Save a file's words  | `file.save_text`         | the worker alone (`actors: ['system']`, permission null), risk 1 | Emits `file.text_saved` with `{ fileId, state, chars, reader }`, never the words. Never a route.                                                                     |
| Real Estate's search | `realestate.search`      | `realestate.use`, humans, an add-on query                        | `route: false`: never an API route and never in the OpenAPI client. Core runs it inside `search.everything` and `search.kind`, under their rate limit and slot gate. |
| A meeting's summary  | `call_suggestion.record` | the worker, as today                                             | Also passes the appointment's `custom_record_id` to `activity.log`, so the "Call summary:" note on a private record is sealed with it (decision 38).                 |

New queries go in core's `queries` list (`queries/index.ts:251`) and the ordered list in `test/commands.test.ts:810`,
then `pnpm openapi` (CI checks `packages/api-client`). `QueryDef` gains `route?: false` (`kernel/types.ts:329-347`):
`registerOperations` skips such a query (`apps/api/src/routes.ts:58-75`), so the OpenAPI export, built from the
routes, leaves it out too, and `apps/api/test/healthz.test.ts:41-56` expects every human query except those. The phone contract (`test/mobile-contract.test.ts:190`) gains
`search.everything` and `search.kind`, recorded with `UPDATE_CONTRACT=1`; their inputs only ever grow.

### `search.everything`

```ts
// packages/core/src/schemas/search.ts
export const SearchKindKey = z.string().regex(/^[a-z][a-z0-9_]{1,30}(\.[a-z0-9_]{1,40})?$/);

export const SearchEverythingInput = z.object({
  workspaceId: uuid,
  q: z.string().trim().max(120, 'Keep a search to 120 characters.'),
  kinds: z.array(SearchKindKey).max(30).optional(), // the chips; unknown keys are ignored
  perKind: z.number().int().min(1).max(5).default(3),
  depth: z.enum(['quick', 'full']).default('quick'),
  includeArchived: z.boolean().default(false),
  onlyMine: z.boolean().default(false),
  settingsMatched: z.boolean().default(false), // a setting matched on the device: no close matches
});

export const SearchEverythingOutput = z.object({
  q: z.string(),
  tooShort: z.boolean(),
  probes: z.object({
    looksLike: z.enum(['phone', 'email', 'domain', 'number', 'amount', 'words']),
    phoneE164: z.string().nullable(),
    email: z.string().nullable(),
    number: z.string().nullable(),
  }),
  total: z.number().int(), // the server's groups only; the client adds its Settings group
  capped: z.boolean(),
  best: SearchHit.nullable(), // also left in its group; the dropdown takes it out
  groups: z.array(SearchGroup),
  archived: SearchGroup.nullable(),
  bin: SearchGroup.nullable(),
  close: z.boolean(), // the groups are close matches (never when settingsMatched)
  noneActive: z.boolean(), // only Archived or the bin found something; the client checks Settings too
});

export const SearchGroup = z.object({
  kind: z.string(), // 'contacts', 'record.pets', 'realestate.listings', 'archived', 'bin', 'close', 'spam'
  label: z.string().nullable(), // only for kinds core doesn't name: a business's own kinds and add-on kinds
  icon: z.string().nullable(),
  total: z.number().int(),
  capped: z.boolean(),
  complete: z.boolean(),
  searchedBack: isoDateTime.nullable(),
  unavailable: z.enum(['too_slow', 'skipped', 'failed']).nullable(),
  items: z.array(SearchHit),
});

export const SearchHit = z.object({
  kind: z.string(),
  id: uuid,
  title: z.string(),
  subtitle: z.string().nullable(), // add-on and record rows only; core's kinds use facts and hitLines
  badges: z.array(z.string()), // lead, client, archived, done, won, lost, cancelled, void, late, due, paid,
  //                              other_mail, spam, my_mail, voicemail, anonymous
  why: z.object({
    field: z.string(),
    label: z.string().nullable(), // an add-on's own chip, or a custom field's name
    snippet: z
      .object({ text: z.string(), marks: z.array(z.tuple([z.number().int(), z.number().int()])) })
      .nullable(),
    page: z.number().int().nullable(), // a PDF's page or an Excel sheet
  }),
  tier: z.number().int().min(0).max(5),
  exact: z.boolean(),
  at: isoDateTime.nullable(),
  href: z.string(), // a web path under /app/w/<workspace>/; the phone maps it through its route map
  contact: z
    .object({
      personId: uuid.nullable(),
      phoneE164: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  amount: z.object({ cents: z.number().int(), currency: z.string() }).nullable(),
  facts: SearchFacts,
  duplicateOf: z.object({ id: uuid, name: z.string() }).nullable(), // "Same number, maybe the same person"
});

// Every field optional: what hitLines and the page's tables print.
export const SearchFacts = z
  .object({
    phone: z.string(),
    email: z.string(),
    where: z.string(),
    company: z.string(),
    lastContact: z.object({ kind: z.string(), subtype: z.string().nullable(), at: isoDateTime }),
    openLead: z.object({ title: z.string(), stage: z.string() }),
    people: z.number().int(),
    openLeads: z.number().int(),
    customer: z.string(),
    pipeline: z.string(),
    stage: z.string(),
    owner: z.string(),
    status: z.string(),
    docKind: z.enum(['invoice', 'estimate', 'payment']),
    number: z.string(),
    dueOn: isoDate,
    sentAt: isoDateTime,
    openedAt: isoDateTime.nullable(),
    paidAt: isoDateTime,
    invoiceNumber: z.string(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    who: z.string(),
    channel: z.string(),
    direction: z.enum(['inbound', 'outbound']),
    matches: z.number().int(),
    messages: z.number().int(),
    on: z.string(),
    dueAt: isoDateTime,
    doneAt: isoDateTime,
    answeredBy: z.string().nullable(),
    question: z.string(),
  })
  .partial();
```

The phone contract only grows: every input field has a default, kinds and badges are strings, and old builds skip a
kind they don't know and a badge they can't draw.

### `search.kind`

```ts
export const SearchKindInput = ListInput.extend({
  // ListInput: limit 1 to 100, default 50; cursor
  workspaceId: uuid,
  q: z.string().trim().max(120, 'Keep a search to 120 characters.'),
  kind: SearchKindKey, // any group kind, plus 'archived', 'bin', 'spam'
  includeArchived: z.boolean().default(false),
  onlyMine: z.boolean().default(false),
  sort: z.enum(['best', 'recent', 'name']).default('best'),
  standing: z.enum(['lead', 'client']).optional(), // contacts
  before: isoDateTime.optional(), // windowed kinds: Look further back
});

export const SearchKindOutput = z.object({
  group: SearchGroup, // this page's items
  nextCursor: z.string().nullable(),
  standingCounts: z.object({ leads: z.number().int(), clients: z.number().int() }).nullable(),
  duplicates: z.array(
    z.object({
      ids: z.tuple([uuid, uuid]),
      on: z.enum(['phone', 'email']),
      value: z.string(),
      name: z.string(),
    }),
  ),
});
```

- **Best match** ranks up to 500 candidates in core and pages by offset: the cursor is
  `encodeCursor({ sort: 'best', id: String(offset) })` (`kernel/pagination.ts:18-20` takes `{ sort, id }`, two
  strings). `decodeCursor` reads it back, then `sort` must be `'best'` and `id` must match `^\d{1,3}$` with an offset of
  0 to 450; anything else throws `listMovedOn` (`kernel/pagination.ts:37-41`).
- **Most recent** pages on `(at desc, id)` with `encodeCursor` and `decodeTimeCursor`; **Name A–Z** on
  `(lower(name), id)` with `decodeCursor`.
- **Duplicates**: pairs of contacts on the page sharing an E.164 phone or an email, for the banner, both held to
  `LIVE_PERSON`. **Standing counts** use `LIVE_PERSON` too, so a customer in the bin is never counted as a lead or a
  client.

### The searchers

Each kind is a `KindSearcher` in `packages/core/src/search/server/kinds/<kind>.ts`:
`{ key, run(tx, plan): Promise<RawHit[]> }`. A searcher carries no gate of its own: `runSearch` reads each kind's
`needs` from core's `SEARCH_KINDS` by key (Who can see what), the same list the chips use, and a unit test checks that
every searcher's key has exactly one `SEARCH_KINDS` entry and the other way round. `plan` carries the probes,
`perKind`, the depth and its window, `includeArchived`, `onlyMine`, `me`, `before`, `sort` and `limit`.

In the sketches, `$ws` is `scope.workspaceId`; `$likes` the lowercased words as escaped `%word%` patterns, `$folds`
the folded ones, `$starts` folded `% word%` patterns matched against `' ' || private.search_fold(name)`; `$phone`,
`$phoneProbe` (jsonb `[{"phone": "+1…"}]`), `$email`, `$emailProbe`, `$domain` and `$domainLike` (its escaped form),
`$digits` (3 or more typed digits, else null), `$numberText` (a document number as typed, lower-cased, without a
leading `#`), `$counter` (its last run of digits without leading zeros), `$amount` (cents), `$card4`, `$tsq` and
`$firstWord` the other probes, each null when not there. `searchProbes` makes them, browser-safe in core:

- **Words**: only those holding a letter or a digit. With none, and no phone, email or number probe, the answer is
  `tooShort` and no SQL runs, so "--" or "@@" never matches everything. `x like all ('{}')` is true in Postgres, so every
  word arm is also written `cardinality($likes) > 0 and …` (and the same for `$folds` and `$starts`).
- **Digits** only with 3 or more, as `inbox.list` does (`queries/inbox.ts:528`), so a typed "1" never scans every
  number in the business.
- **Amounts** come from `parseMoney` (`money/format.ts:45`), only when the text reads as money: it starts with "$",
  or has cents or a thousands comma ("$1,280", "1,280.00"). A bare whole number is a number probe only, so "1042"
  never lists every $1,042.00 bill as an exact match.
- **Document numbers** come from `documentNumberProbe` in `money/numbering.ts`, beside `formatDocumentNumber`
  (`:46`): the typed number as written, and its counter, the last run of digits without leading zeros. A prefix may
  hold digits (`2026-`, `numbering.ts:24-25`), so the counter is read from the end, never by dropping every
  non-digit. "1042" finds `2026-1042`, `INV-001042` and `1042`; "LS-0042" finds `LS-0042`. A prefix that runs
  straight into the counter with no hyphen (`2026` then `1042`) is found by the whole number or by the tier 2 words.
- **`$tsq`** is built by `searchWords`, which splits words exactly as `private.search_words` does (Migration B).

Shared fragments live once in `search/server/sql.ts`:

- `LIVE_PERSON(alias)`: `<alias>.bin_item_id is null and <alias>.erased_at is null and <alias>.merged_into_id is null`.
  Row security still shows customers in the bin, erased names and merged shells (20261027000400:214-223), so every
  read of `app.people` in search uses it: Contacts, Archived, close matches, a company's people count, duplicates,
  standing counts, and any `contact` (phone, email, Call and Text) built from an estimate's, invoice's or payment's
  customer. A bill whose customer isn't live keeps only the name, as bills do (docs/deleting.md:31), with
  `contact: null` and no link to the person. `companyIsClient` already does this by hand (`crm/clients.ts:36-37`).
- `RECORD_READS(column)`: `(<column> is null or exists (select 1 from app.custom_records r where r.id = <column>))`.
  `custom_records_select` hides a turned-off add-on's kinds (`hidden_record_kinds()`), but tasks, notes, files,
  appointments and conversations check only `sealed` (gap 5), so each of those kinds uses it.

**Contacts** (`records.read`). Candidates, then facts for the winners only:

```sql
select p.id, p.first_name, p.last_name, p.email::text as email, p.phone_e164, p.city, p.address_line1,
       p.archived_at, p.updated_at,
  case
    when $phone is not null and (p.phone_e164 = $phone or p.other_phones @> $phoneProbe) then 0
    when $email is not null and (lower(p.email::text) = $email or p.other_emails @> $emailProbe) then 0
    when cardinality($starts) > 0
         and (' ' || private.search_fold(concat_ws(' ', p.first_name, p.last_name))) like all ($starts) then 1
    when $domain is not null and lower(p.email::text) like ('%@' || $domainLike) then 1
    when cardinality($folds) > 0
         and private.search_fold(concat_ws(' ', p.first_name, p.last_name)) like all ($folds) then 2
    else 3
  end as tier
from app.people p
left join app.companies c on c.id = p.company_id
where p.workspace_id = $ws
  -- Not in the bin, not an erased name, and (new for search; person.list filters only the first two) not a merged shell.
  and ${LIVE_PERSON('p')}
  and ( <the tier 0 and 1 arms>
     or (cardinality($folds) > 0
         and private.search_fold(concat_ws(' ', p.first_name, p.last_name)) like all ($folds))
     or (cardinality($likes) > 0
         and (p.search_text || ' ' || lower(coalesce(c.name, '') || ' ' || coalesce(p.address_line2, '') || ' ' ||
              coalesce(p.state, '') || ' ' || coalesce(p.postal_code, '') || ' ' ||
              jsonb_path_query_array(p.custom, 'strict $.*')::text)) like all ($likes))
     or ($digits is not null and (p.search_text like ('%' || $digits || '%')
         or regexp_replace(coalesce(p.phone_alt, ''), '\D', '', 'g') like ('%' || $digits || '%'))) )
  [onlyMine: and (p.owner_user_id = $me or p.team_user_ids @> array[$me]::uuid[])]   -- person.ts:135
order by (p.archived_at is not null), tier, p.updated_at desc, p.id
limit 101
```

- `why.field` comes from which arm matched, worked out in core from the row (a custom field's name from the business's
  field definitions for the winners only). `search_text` already holds E.164, so typed digits match
  (20261006000300:222-236).
- Facts, for the returned ids only (`where p.id = any($ids)`, the primary key): the Lead or Client badge from
  `personIsClient('p')` (`crm/clients.ts:18`), the open lead and its stage, and the last contact (decision 35): the
  newest line that is a message, call, note or visit, or an `appointment_booked` line (its kind, subtype and time),
  through `activities_person_idx`, as `person.list` reads `last_activity_at` (`person.ts:105`); and, for a person who
  may see money, their newest paid invoice's `paid_at` ("Paid Sep 30") when it is newer. Bookkeeping lines (created,
  archived, assigned, `file_added`, `intake`, `addon_line` and the rest) never count. The subtypes that count are one
  list in core, `CONTACT_LINES`, with a test naming every subtype `logSystemActivity` is called with.
- `duplicateOf`: when two tier-0 phone hits share `phone_e164`, the later one points at the first.

**Companies** (`records.read`): the same over `app.companies`, adding `lower(coalesce(c.website, '')) like ('%' ||
$domainLike || '%')` as tier 1 with `why.field = 'website'` (the website isn't in `search_text`), and facts: its people
(counted with `LIVE_PERSON`, so "12 people" never counts a customer in the bin or a merged shell) and open leads.

**Leads** (`records.read`):

```sql
select l.id, l.title, l.status, l.value_cents, l.archived_at, l.updated_at, s.name as stage, pl.name as pipeline,
  case when (' ' || private.search_fold(l.title)) like all ($starts) then 1
       when private.search_fold(l.title) like all ($folds) then 2 else 3 end as tier
from app.leads l
join app.pipeline_stages s on s.id = l.stage_id
join app.pipelines pl on pl.id = l.pipeline_id
left join app.people p on p.id = l.person_id and ${LIVE_PERSON('p')}
left join app.companies c on c.id = l.company_id
where l.workspace_id = $ws
  and cardinality($folds) > 0
  and ( private.search_fold(l.title) like all ($folds)
     -- The person's name and the company's together: a lead with both is found by either (board 2's
     -- "Backflow test, 4 buildings · Smithfield Property Mgmt").
     or private.search_fold(concat_ws(' ', p.first_name, p.last_name, c.name)) like all ($folds) )
  [onlyMine: and l.assignee_user_id = $me]   -- lead.ts:99
order by (l.archived_at is not null), tier, (l.status = 'open') desc, l.updated_at desc, l.id
limit 101
```

Won and lost leads carry their badge. Facts: the customer, pipeline › stage (or "Won Sep 30"), the assignee, the value.

**Money** (`money.read`): three statements, each with core's member rule added as the lists add it. `queries/money.ts`
exports `estimateMemberClause` and `invoiceMemberClause` (`:93-108`), so a member's search is held to their own jobs
exactly as `estimate.list` and `invoice.list` are, view-as included. Row security still decides.

```sql
-- invoices (estimates the same with estimateMemberClause). A draft has no number yet
-- (money_documents.sql:103,179: number is null exactly while sent_at is), so every arm coalesces it.
select i.id, i.number, i.title, i.status, i.total_cents, i.currency, i.due_on, i.person_id, ...,
       ${LIVE_PERSON('p')} as customer_live,
  case when $numberText is not null and lower(coalesce(i.number, '')) = $numberText then 0
       when $counter is not null and ltrim(substring(coalesce(i.number, '') from '[0-9]+$'), '0') = $counter then 0
       when $amount is not null and i.total_cents = $amount then 0
       when cardinality($likes) > 0
            and lower(coalesce(i.number, '') || ' ' || coalesce(i.title, '')) like all ($likes) then 2
       else 3 end as tier
from app.invoices i
left join app.people p on p.id = i.person_id
where i.workspace_id = $ws ${invoiceMemberClause(ctx)}
  and ( <tier 0 arms>
     or (cardinality($likes) > 0
         and lower(coalesce(i.number, '') || ' ' || coalesce(i.title, '') || ' ' || coalesce(i.notes, '') || ' ' ||
                   concat_ws(' ', p.first_name, p.last_name)) like all ($likes)) )
  [onlyMine: and i.assignee_user_id = $me]
order by tier, (i.status = 'void'), i.created_at desc
limit 101

-- payments: through their invoice. Only payments that went through.
select pay.id, pay.amount_cents, pay.currency, pay.card_last4, pay.received_at, i.id as invoice_id, i.number,
       ${LIVE_PERSON('p')} as customer_live, ...,
  case when $amount is not null and pay.amount_cents = $amount then 0
       when $card4 is not null and pay.card_last4 = $card4 then 0
       else 3 end as tier
from app.payments pay join app.invoices i on i.id = pay.invoice_id ${invoiceMemberClause(ctx)}
left join app.people p on p.id = i.person_id
where pay.workspace_id = $ws and pay.status = 'succeeded'
  and ( ($amount is not null and pay.amount_cents = $amount)                                           -- tier 0
     or ($card4 is not null and pay.card_last4 = $card4)                                               -- tier 0
     or ($numberText is not null and lower(coalesce(i.number, '')) = $numberText)                      -- tier 3
     or ($counter is not null and ltrim(substring(coalesce(i.number, '') from '[0-9]+$'), '0') = $counter)  -- tier 3
     or (cardinality($likes) > 0 and lower(concat_ws(' ', p.first_name, p.last_name)) like all ($likes)) )  -- tier 3
order by tier, pay.received_at desc nulls last, pay.created_at desc
limit 101
```

Never `provider_payment_id` or `idempotency_key`. The late and due badges come from `invoiceStanding` and
`estimateStanding` (`money/document-words.ts:182,207`); void ranks last. Titles are "Invoice #1042", "Estimate #388",
"Payment · Card", and "Draft invoice" or "Draft estimate" (with its title) when there's no number yet. The same tier
rule runs in core's `rankHits` through `documentNumberMatches(stored, probe)` from `money/numbering.ts`, so the server
and the tests agree. A row's `contact` is filled only when `customer_live`; otherwise the bill keeps the customer's
name alone.

**Messages** (`inbox.use`): four statements, merged in core into one row per conversation.

```sql
-- (i) Exact: the counterpart is the phone or email (the conversations_one_per_line index's leading columns).
select c.id, 0 as tier from app.conversations c
where c.workspace_id = $ws and c.counterpart = any ($exacts) and ${RECORD_READS('c.custom_record_id')}
  [folder rule] [archived rule] [onlyMine];

-- (ii) Thread fields, in a window. A chat visitor and a Meta contact point at their conversation, not the other way
-- round (conversations has no visitor or contact column), as inbox.list joins them (queries/inbox.ts:497-511).
with w as (select c.* from app.conversations c where c.workspace_id = $ws
           and (c.last_message_at >= $since or c.last_message_at is null)
           order by c.last_message_at desc nulls last, c.id desc limit $threadRows)
select w.id, 3 as tier from w
left join app.people p on p.id = w.person_id
left join app.chat_visitors v on v.conversation_id = w.id
left join app.meta_contacts mc on mc.conversation_id = w.id
where ${RECORD_READS('w.custom_record_id')}
  and ( (cardinality($likes) > 0
         and lower(concat_ws(' ', p.first_name, p.last_name, v.name, mc.name, mc.username, w.counterpart,
                             w.last_preview)) like all ($likes))
     or ($digits is not null and regexp_replace(w.counterpart, '\D', '', 'g') like ('%' || $digits || '%')) )  -- inbox.ts:524-530
  [folder rule] [archived rule] [onlyMine];

-- (iii) Bodies, in a window on messages_workspace_occurred_idx.
with w as (
  select m.id, m.conversation_id, m.occurred_at, m.subject, m.body_text, m.campaign_recipient_id, m.sent_by
  from app.messages m
  where m.workspace_id = $ws and m.occurred_at >= $since [and m.occurred_at < $before]
  order by m.occurred_at desc
  limit $messageRows)
select w.conversation_id,
       count(*) as matches,
       (array_agg(w.id order by (w.campaign_recipient_id is null or w.sent_by is not null) desc, w.occurred_at desc))[1] as best_id,
       max(w.occurred_at) as at,
       bool_and(w.campaign_recipient_id is not null and w.sent_by is null) as automated
from w join app.conversations c on c.id = w.conversation_id
join app.messages m on m.id = w.id
where m.error_code is distinct from $CANCELLED_TEXT and m.unsent_at is null       -- inbox.ts:1031
  and ${RECORD_READS('c.custom_record_id')}
  and cardinality($likes) > 0
  and lower(coalesce(w.subject, '') || ' ' || coalesce(w.body_text, '')) like all ($likes)
  [folder rule] [archived rule] [onlyMine: and (c.assignee_user_id = $me or c.private_to = $me)]   -- inbox.ts:466-489
group by w.conversation_id
order by automated, at desc
limit 101;

-- (iv) Call transcripts, in a window on calls_workspace_idx, through their thread when they have one, so the
-- folder, archived, only-mine and turned-off-record rules apply to calls as to messages.
with w as (select k.* from app.calls k where k.workspace_id = $ws and k.started_at >= $since
           order by k.started_at desc limit $callRows)
select w.id, w.conversation_id, w.person_id, w.is_voicemail, w.started_at from w
left join app.conversations c on c.id = w.conversation_id
where w.transcript is not null and cardinality($likes) > 0 and lower(w.transcript) like all ($likes)
  and (w.answered_via is distinct from 'bridge' or w.answered_by_user_id is not null)  -- inbox.ts:1049
  -- A call with a thread follows it (row security already hides the call when the thread is hidden); a call with
  -- none counts as Inbox and not archived.
  and (w.conversation_id is null or (${RECORD_READS('c.custom_record_id')} [folder rule] [archived rule]))
  [onlyMine: and (c.assignee_user_id = $me or c.private_to = $me
                  or (w.conversation_id is null and (w.placed_by = $me or w.answered_by_user_id = $me)))];
```

- The folder rule is `c.folder <> 'spam'` for Messages and `c.folder = 'spam'` for the Spam kind. The archived rule is
  `c.archived_at is null` unless `includeArchived`; archived threads go to Archived by name instead.
- Display rows join `conversations`, `people`, `chat_visitors` and `meta_contacts` again, under row security, for the
  merged ids, and cut the best message's snippet:
  `substr(m.body_text, greatest(1, strpos(lower(m.body_text), $firstWord) - 70), 200)`.
- Titles: "Text from Dana Smith", "Text to Jo Smithers", "Email · Kim Le", "Call · Marcus Smith", and "Texts with Dana
  Smith" for a thread-level hit, with "Last one 2 days ago · 14 messages". Badges `other_mail` (folder `other`),
  `my_mail` (`private_to` is the person), `voicemail`.
- A call with no conversation links to its customer's timeline; with neither, it's dropped.
- `$CANCELLED_TEXT` is `CANCELLED_TEXT` (`messaging/quiet-hours.ts:76`).

**Calendar** (`workspace.read`): `app.appointments` newest first on `appointments_range_idx`, with no 62-day limit,
and `${RECORD_READS('a.custom_record_id')}`: `appointments_select` checks only sealing (20261018000600:132-134), and
`unseen_private_records()` never reads hidden kinds (20261020001000:24-33), so without it a Real Estate tour would
stay findable by the deal's people after Real Estate is turned off. Tier 0 an attendee's `contact_phone_e164 = $phone`
or `contact_email = $email`; 1 and 2 the folded title; 3 the place's words (`lower(a.location::text)`,
`why.field = 'address'` when the address matched), notes, or an attendee's name. `app.appointment_transcripts` isn't
read (decision 15): an internal meeting's summary is shown by no screen, and a customer meeting's is found as its
Note. Sealed appointments are hidden by row security. Cancelled ones rank last with their badge. Only mine:
`owner_user_id = $me` or on `appointment_staff`.

**Tasks** (`records.read`): title (tiers 1 and 2) and notes (tier 4, `task_notes`), with
`${RECORD_READS('t.custom_record_id')}`. Done
tasks rank last with "Done". Only mine follows `task.list.ts:81` (the assignee, or the creator when unassigned).

**Notes** (`records.read`):

```sql
with w as (select a.id, a.body, a.person_id, a.company_id, a.lead_id, a.custom_record_id, a.occurred_at, a.author_user_id
           from app.activities a
           where a.workspace_id = $ws and ${NOTE_LINES} [and a.occurred_at < $before]
           order by a.occurred_at desc, a.id desc
           limit $noteRows)
select w.*, lower(w.body) like all ($likes) as in_words from w
left join app.people p on p.id = w.person_id and ${LIVE_PERSON('p')}
left join app.companies c on c.id = w.company_id
left join app.leads l on l.id = w.lead_id
where ${RECORD_READS('w.custom_record_id')}
  and cardinality($likes) > 0
  and ( lower(w.body) like all ($likes)
     -- Decision 34: the name of who it's on, ranked after the notes whose own words matched.
     or lower(concat_ws(' ', p.first_name, p.last_name, c.name, l.title)) like all ($likes) )
  [onlyMine: and w.author_user_id = $me]
order by in_words desc, w.occurred_at desc
limit 101
```

`NOTE_LINES` is one constant, ``sql`(a.kind = 'note' or (a.kind in ('call', 'visit') and a.subtype is null))` ``, the
same condition as `activities_notes_idx`. A note found by its words has `why.field = 'note'`; one found by who it's on
has `why.field = 'customer'`, tier 4 after the word matches, and its first 120 characters as the snippet (board 2's
"Gate code 4471, dog in the yard"). Facts: who it's on ("Note on Dana Smith · Oct 18").

**Files** (`records.read`), two statements:

```sql
-- names, across the business
select f.id, f.name, f.record_type, f.record_id, f.created_at from app.files f
where f.workspace_id = $ws and f.status = 'ready' and f.deleted_at is null
  and f.record_type not in ('port', 'knowledge')
  and (f.record_type <> 'custom_record' or exists (select 1 from app.custom_records r where r.id = f.record_id))
  and cardinality($folds) > 0 and private.search_fold(f.name) like all ($folds)
  [onlyMine: and f.created_by = $me]
order by f.created_at desc limit 101;

-- words inside (stage 5), in a window
with w as (select t.file_id, t.words, t.pages from app.file_texts t
           where t.workspace_id = $ws order by t.extracted_at desc limit $fileRows)
select f.id, f.name, f.record_type, f.record_id, w.pages from w
join app.files f on f.id = w.file_id
where w.words @@ to_tsquery('simple'::regconfig, $tsq)
  and f.status = 'ready' and f.deleted_at is null and f.record_type not in ('port', 'knowledge')
  and (f.record_type <> 'custom_record' or exists (select 1 from app.custom_records r where r.id = f.record_id))
limit 101;
```

`$tsq` is core's `'dana:* & smith:*'`, built by `searchWords` from folded letters and digits exactly as
`private.search_words` builds `words`, so `to_tsquery` can never throw and "1042", "0142", "smith" and
"gulfcoastrealty" match inside a file as they do elsewhere. For returned files only, the snippet is cut from `t.text`
at `strpos(private.search_fold(t.text), $firstWord)`, which lines up because the fold keeps the length, and the page is
the largest entry of `pages` at or before it ("page 3", or "Sheet 2" for Excel).

**Forms** (`workspace.read`): forms by folded name (archived ones to Archived), and answers:

```sql
with w as (select fa.response_id, fa.form_id, fa.question_title, fa.question_type, fa.text_value, fa.choice_labels, fa.answered_at
           from app.form_answers fa where fa.workspace_id = $ws
           order by fa.answered_at desc, fa.response_id desc limit $answerRows)
select w.*, r.person_id, f.name,
       lower(coalesce(w.text_value, '') || ' ' || array_to_string(w.choice_labels, ' ')) like all ($likes) as in_words
from w
join app.form_responses r on r.id = w.response_id and r.status = 'completed'   -- names granted columns only
join app.forms f on f.id = w.form_id
left join app.people p on p.id = r.person_id and ${LIVE_PERSON('p')}
where cardinality($likes) > 0
  and ( lower(coalesce(w.text_value, '') || ' ' || array_to_string(w.choice_labels, ' ')) like all ($likes)
     -- Decision 34: who answered, ranked after the answers whose own words matched.
     or lower(concat_ws(' ', p.first_name, p.last_name)) like all ($likes) )
  [and w.question_type <> 'payment' unless money.read]
order by in_words desc, w.answered_at desc
limit 101
```

One row per response, its best answer as the snippet with the question; found by who answered, its first text answer
("Answered by Jo Smithers · Oct 19 · “50 gallon, gas”", board 2). "Answered by Jo Smithers", or the `anonymous`
badge ("Answered by someone who didn’t say who"). Left out under Only mine (no owner).

**Knowledge** (`workspace.read`): `searchKnowledge(tx, ws, q, { limit: perKind + 1, includeDrafts: true })`
(`knowledge/search.ts:80`), its `**` markers turned into marks. Left out under Only mine.

**A business's own kinds** (`records.read`):
`custom_records r join custom_record_types ty` where `r.purged_at is null` and `cardinality($likes) > 0` and
`(r.search_text like all ($likes) or private.search_fold(r.name) like all ($folds))`, ranked within each type, one group per type (`record.<ty.key>`,
labelled with its plural and icon). Row security hides turned-off add-ons' kinds and private records
(20261013002400:360-369). The kinds a running contributor covers for this person are left out. Only mine: owner or
team on a kept-to-team record, else `created_by`.

**Deleted bin** (`records.delete`):

```sql
select b.id, b.kind, b.name, b.deleted_at, b.purge_after from app.bin_items b
where b.workspace_id = $ws and b.purging_since is null
  and cardinality($folds) > 0 and private.search_fold(b.name) like all ($folds)
order by b.deleted_at desc limit 21
```

**Close matches** (`records.read`): only when tiers 0 to 4 found nothing and no setting matched, in their own `step`,
contacts held to `LIVE_PERSON` (How it works, 4).

### Running a search (`search/server/run.ts`)

```ts
export async function runSearch(
  ctx: QueryContext,
  input: SearchEverythingInput | SearchKindInput,
  opts?: { searchers?: readonly KindSearcher[] }, // defaults to every kind; tests pass a slow or failing one
): Promise<RawAnswer>;

// Every statement a search makes goes through this, and nothing runs outside it.
async function step<T>(kind: string, run: (sp: Tx) => Promise<T>): Promise<T | Unavailable>;
```

`step` checks the budget (under 50 ms left: `skipped`, no statement), sets the statement timeout to the smaller of the
cap and what's left, never below 50 ms, opens a savepoint (`ctx.tx.transaction`), and runs. A 57014, read through the
error's `cause` chain, marks the kind `too_slow`; an `HfosError` is thrown on; any other error is thrown again as
`new Error('search <kind> failed: <SQLSTATE>')`, with no cause, message or parameters (How it works, 7).

1. `searchProbes(q, { country })`. Too short (under 2 characters, or no word with a letter or a digit, and no phone,
   email or number probe): an empty answer, no SQL.
2. `setBudget(depth)`; `searchKindsFor({ permissions, viewAs, addons })`, filtered by `kinds`; each kind's gate read
   from `SEARCH_KINDS` (Who can see what).
3. For each kind, in kind order: its candidates through `step`. A spent budget marks the rest `skipped`.
4. Add-on contributors, each through `step` (below).
5. Close matches, through their own `step`, when nothing matched and `settingsMatched` is false.
6. For the winners only, through `step` again: facts, display rows and snippets, and for `search.kind` the paging,
   duplicates and standing counts. A step that fails here marks its group, never the request.
7. Core ranks (`rankHits`), splits Archived and the bin, builds `why`, snippets and marks (`snippetOf`), picks `best`
   (`bestOf`), orders the groups (`orderGroups`, decision 33), and fills `href` (`searchHref`).
8. If every kind tried was slow or skipped: `search_took_too_long`.

`queries/search.ts` wraps both handlers whole in one more catch: a non-`HfosError` that got past a step is thrown
again scrubbed the same way, and a 57014 outside a kind becomes `search_took_too_long`.

### Add-ons answer searches

Built in core as its own step: the "Not yet" list in docs/addon-architecture.md:495-517 doesn't cover search.

**The manifest** (`packages/core/src/addons/manifest.ts:405-500`) gains an optional field:

```ts
search?: {
  query: string;                                   // '<id>.search', a defineAddonQuery of this add-on
  kinds: readonly { key: string; singular: string; plural: string; icon: string }[];  // keys under the add-on: 'listings'
  covers?: readonly string[];                      // its own recordKinds, left out of core's group when it ran
  permission: WorkspacePermission;                 // one of its own permissions
};
```

`manifestIssues` gains, beside the teammate rules (`:696-724`): the query starts with `<id>.`; kind keys match
`^[a-z][a-z0-9_]{1,30}$` and are unique; `covers` names only its own record kinds; the permission is one of its own.
The catalogue tests gain `addonSearchIssues(ADDON_SERVER_MODULES)`: the query exists in the module, is a
`defineAddonQuery` for this add-on, humans only, has core's `AddonSearchInput` and `AddonSearchOutput` as its input and
output (the same objects), declares no `ai`, and is marked `route: false`, so the API never mounts it and nobody can
POST to it around search's rate limit and slot gate (`apps/api/src/routes.ts:58-75` mounts every human query
otherwise). The generator's template (`addons/_template/core/manifest.ts.tpl`, `scripts/addon-new.mjs`)
gets a commented stub.

**Shapes** (`packages/core/src/search/addon.ts`, browser-safe):

- `AddonSearchInput = { workspaceId, probes, kinds?, perKind, includeArchived, onlyMine, depth, sort?, cursor? }`. Add-ons
  get core's probes, never the raw text to parse, and use core's `escapeLike`, `tierOf`, `marksIn` and `snippetOf`, so
  every group ranks on one scale.
- `AddonSearchOutput = { groups: [{ kind, total, capped, nextCursor, items: [{ id, title, subtitle, badges, why: {
label, snippet }, exact, tier, at, href, recordId }] }] }`.

**Running them** (`packages/core/src/search/server/addons.ts`), the `teammateAddonTools` pattern
(`addons/teammate.ts:142-152`): walk `ADDON_SERVER_MODULES`, keep add-ons with `manifest.search` that run here
(`loadActiveAddons`, read once a request) and whose permission the person holds (`scopeCan`, or every one under a staff
view-as). Each runs through `step` and the new kernel helper, with a statement timeout of the smaller of 1.5 s
(quick) or 3 s (full) and what's left:

```ts
// packages/core/src/kernel/execute.ts, beside executeCommandWithin (:801-824), whose helpers are private here.
export async function executeQueryWithin<I extends z.ZodType, O extends z.ZodType>(
  ctx: QueryContext,
  query: QueryDef<I, O>,
  rawInput: unknown,
): Promise<z.output<O>>;
// assertActorAllowed; parseInput; the same workspace or businessNotThere; in a savepoint: assertAddonRuns(sp,
// query.addon, ws, false); assertPermission unless scope.viewAs (VIEW_AS_BLOCKED kept, as :906-913); the handler;
// output.parse; translateDbError.
```

- A failure of any kind (`addon_inactive` when it was turned off mid-search, a timeout, a bug) drops only that add-on's
  groups, marked `unavailable: 'failed'`. Event delivery is kept apart the same way (docs/addon-architecture.md:449-451).
  The error itself is dropped: logged, if at all, as the add-on's id and the SQLSTATE, never its message.
- Core drops any hit whose `href` doesn't start with `/a/<id>/` or `/customers/records/<uuid>`, as alerts do
  (`apps/worker/src/addons/alerts.ts:98-99`). Kinds are capped at `perKind + 1`, counts at 50.
- **`covers` is honoured only when the contributor ran for this person.** Someone with `records.read` but not
  `realestate.use` still finds properties through core's group for the business's kinds, opening the record page,
  whose Real Estate panel offers "Open the deal" (`apps/web/src/addons/realestate/record-panel.tsx:10-30`).
- Core never reads an `addon_<id>` table and never names an add-on; it reaches add-ons only through the module list
  (`test/addons/boundaries.test.ts:15-34`).

**Real Estate** (`packages/core/src/addons/realestate/ops/search.ts`, registered in `realestate/server.ts`):
`realestate.search`, permission `realestate.use`, humans, no `ai` (`realestate_find_deals` already serves the AI),
`route: false`. Its manifest declares `search: { query: 'realestate.search', kinds: [listings 'Listing'/'Listings'
home, deals 'Deal'/'Deals' key, homes 'Home'/'Homes' house, properties 'Property'/'Properties' home], covers:
['realestate_deal', 'realestate_property'], permission: 'realestate.use' }` (record kinds at
`realestate/manifest.ts:139-157`). Each read runs as the person, so private deals
stay with their people through the add-on table policies and `custom_records_select`.

- **Listings**: the property record's name (the address: tier 1 a word start, 2 contains) and `mls_number = $text`
  (tier 0, "MLS number") from `addon_realestate.listings` (`tables.ts:1302-1373`). Subtitle from its facts: "Active ·
  $389,000 · 3 bd · 2 ba". Links to the deal it belongs to.
- **Deals**: `realestate.deal.list`'s own search (`ops/queries.ts:248-303`: deal name, client name, property address,
  wildcards escaped at `:295`) through `dealRows`. Subtitle: side · stage. Archived deals carry the badge and stay out
  unless `includeArchived`; add-on records never go in the bin (docs/deleting.md:6). Only mine through `onDealSql`.
  Links to `/a/realestate/deals/<recordId>`.
- **Homes**: `addon_realestate.homes` (`tables.ts:633-643`) by address, linking to the buyer deal's homes.
- **Properties**: property records whose address matches and that no listing covers, such as a buyer's home or a
  property with no deal yet (`realestate.property.search` lists those too, with their deal count, `ops/queries.ts:329-354`).
  A property with a listing shows once, as its Listing, which is how board 4's address search reads. Links to the
  record page (`/customers/records/<recordId>`), whose Real Estate panel lists its deals. Because `covers` takes
  `realestate_property` out of core's group whenever this runs, without this kind such a property would be found only
  through a deal's address, or not at all.

### Words inside files: the worker

The worker's alone; no provider and no AI.

- **The handler**: `onFileText` (`apps/worker/src/files/file-text.ts`) is added to the `file.attached` entry after
  `onFileFingerprint` (`apps/worker/src/handlers/index.ts:170-173`). `file.attached` comes from `file.confirm`, the
  worker's `file.store`, `file.finish_copy` and `portal.upload_confirm` (`commands/file.ts:160-210,274-280`;
  `commands/file-answer.ts:428-452`; `portal-files.ts:191`). It only schedules, so nothing is downloaded inside the outbox transaction:
  `scheduleJob(tx, { kind: 'file.text', dedupeKey: 'file.text:<fileId>', runAt: now, payload: { fileId }, workspaceId,
organizationId })`, as `knowledge/document.ts:31-55` does. It schedules nothing for `knowledge` files (their words
  are knowledge items) or `port` papers.
- **The job `file.text`** (registered beside `knowledge.document`, `apps/worker/src/scheduled.ts:550`):
  1. A declared image, audio or zip type: save `unsupported` without downloading.
  2. `readFileBytes(services, scope, fileId, 25 MB)`: `removed` (deleted, in the bin, or not ready, `files/read.ts:19`)
     saves nothing and ends quietly. It can't loop: `files_without_text` never returns a deleted, binned or unfinished
     file, so the sweep doesn't schedule it again, and a binned file is read after Bring back. `too_large` saves
     `too_large`.
  3. Sniff the first bytes, never trusting the declared type (`file.confirm` takes it from storage metadata,
     `commands/file.ts:258-266`): `%PDF-` is a PDF; `PK\x03\x04` holding `word/document.xml` is Word, holding
     `xl/workbook.xml` is Excel; UTF-8 text with a `text/plain` or `text/csv` type is text; anything else is
     `unsupported`.
  4. Read: a PDF with `pdfPages` (`document-text.ts:55-66`), pages joined with a blank line and each page's start kept
     in `pages`; under 40 characters a page on average is `no_text` (a scan); `null` is `unreadable`. Text and CSV with
     `documentText(bytes, 'text')`. Word and Excel with `office-text.ts`. Everything through the reader's tidying,
     stopped at 100,000 characters (`truncated` past it).
  5. Save through `executeCommand(db, fileSaveText, …, systemActor(…))` with `reader: FILE_READER = 1`.
  6. `MAX_ATTEMPTS` is 5 (`apps/worker/src/outbox.ts:16`, used by `jobs.ts:203`); the last attempt saves `unreadable`
     rather than throwing again, so a file that can't be read gets a row and leaves the sweep. One file at a time on
     the 512 MB machine (`apps/worker/fly.toml:75-77`), which already reads 25 MB PDFs for Real Estate.
- **The Word and Excel reader** (`apps/worker/src/files/office-text.ts`), on `node:zlib` with no new dependency, as the
  worker's zip writer has none (`files/zip.ts:1-9`):
  - read the end-of-central-directory record, then the central directory; refuse zip64, encrypted entries (flag bit
    0), methods other than stored (0) or deflate (8), and more than 2,000 entries;
  - inflate only the named parts (`word/document.xml`; `xl/sharedStrings.xml` and `xl/worksheets/sheet*.xml` in sheet
    order) with `zlib.inflateRawSync(buf, { maxOutputLength: 20 MB })`, 50 MB inflated in all, and refuse a declared
    ratio over 200 to 1;
  - Word: the text of each `<w:t>`, a new line per `</w:p>`, a tab per `<w:tab/>`. Excel: shared strings, inline
    strings and numbers as written (phones and invoice numbers), a line a row, cells joined by tabs, each sheet's
    start in `pages`;
  - XML through a small tag scanner that decodes only the five named entities and numeric ones, never an XML library
    that expands entities.
  - The words are data, never instructions (`document-text.ts:6-8`), and never sent to a model.
- **The command `file.save_text`** (`packages/core/src/commands/file-text.ts`), modelled on
  `knowledge_document.save_text`: input `{ workspaceId, fileId, state, text, pages, chars, reader }`. It checks the file
  is in the business, ready, not deleted and not `knowledge` or `port` (else "File not found."), upserts
  `app.file_texts` on `file_id`, and emits `file.text_saved` with `{ fileId, state, chars, reader }`. No event or audit
  row ever holds the words, so they never outlive a purge (docs/deleting.md:39-41).
- **Catching up**: `file.text_sweep` in `scheduled.ts`, seeded in `ensureRecurringJobs` (`:640-700`) with the dedupe
  key `sweep:file_text`, as the bin's sweep is (`apps/worker/src/bin/index.ts:110-121`). It calls
  `private.files_without_text(20, FILE_READER)` through `asWorker(db, {}, …)` and schedules a `file.text` job for each
  in its own business, their `runAt` spread over the next five minutes. Claimed jobs run one after another
  (`apps/worker/src/jobs.ts:150-215`, a batch of 20, `env.ts:613`), so a batch of large reads all due at once would
  hold reminders and AI replies back behind it; 20 spread out never does. It comes back in ten minutes after a full
  batch, else in a day. It covers files from before this
  release (one ready file on hosted, a knowledge PDF it skips), files written by direct SQL (imports), and a better
  reader later. `pnpm --filter @hfos/worker run files:read-backlog` lists what's left, read-only.

### Refusals

Clients branch on `rule`, never the words.

| Rule                      | Status | When                                                      | Words                                                                                                                                                                                                          |
| ------------------------- | ------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_kind_not_allowed` | 403    | `search.kind` for a kind the person may not open          | `missingPermissionMessage(perm, role)` (`permissions.ts:657-676`), for example "You need the “Use the inbox” permission for that. An owner of this business can turn it on for you in Settings → Permissions." |
| `search_kind_gone`        | 404    | `search.kind` for a business's kind that's gone or hidden | "That kind of record isn’t in this business anymore. Search everything again, or pick another kind."                                                                                                           |
| `addon_inactive`          | 403    | `search.kind` for an add-on kind while it's off           | The kernel's (`errors.ts:139-147`): "Real Estate is turned off for this business."                                                                                                                             |
| `search_took_too_long`    | 503    | every kind tried timed out or was skipped                 | "That search took too long. Add another word, or pick one kind to look in, and try again."                                                                                                                     |
| `search_busy`             | 503    | the machine's 3 slots stayed full for a second            | "Search is busy for a moment. Try again in a few seconds."                                                                                                                                                     |
| `search_too_fast`         | 429    | over the rate limit                                       | "You’re searching faster than HandsFreeOS can keep up. Wait a few seconds and try again."                                                                                                                      |

- `search_too_fast` is raised by the route's `errorResponseBuilder` as an `HfosError`, so the API's `isHfosError`
  branch sends it with its rule (`apps/api/src/errors.ts:9-13`). `@fastify/rate-limit` 11.2 throws what the builder
  returns, and a route's `keyGenerator`, `hook` and `errorResponseBuilder` override the plugin's. The generic
  `rate_limited` body for invitations doesn't change.
- 503 and 429 are retried (`dispositionOf`, `errors.ts:44`).
- Existing refusals stay: validation from the kernel (`execute.ts:63-71`), with the input's "Keep a search to 120
  characters."; `listMovedOn` for a tampered cursor; `businessNotThere`.
- Too short and nothing found are answers, not refusals. A group that was slow, skipped or failed is a line in its
  group, not a refusal (Words in core).

## Who can see what

Every hit passes three layers.

1. **Row security, as the person**: business access; inbox narrowing (20261012070500:22-50); a person's own mailbox
   (20261013001200:186-208); private mail hidden through a teammate view (20261018000100:157-175); sealed portal
   threads (20261018001200:44-60); private records and what hangs off them (20261013002400:360-369, 475-478, 516-519);
   the money member rule (20261012030400:44-97); appointments sealed to private records (20261018000600:132-134);
   restrictive rules hiding what's in the Deleted bin (20261027000400:155-191); `bin_items` only with `records.delete`
   (`:92-93`); and the two new policies.
2. **Core's gate per kind** (`packages/core/src/search/kinds.ts`, `SEARCH_KINDS`, each `{ key, label, needs, offline,
windowed }`), used by both apps for the chips and by the server to skip kinds. It is the only place a kind's gate is
   written: searchers carry none, and a test ties every searcher's key to exactly one entry.

   | Kind                                                                      | Needs                                  |
   | ------------------------------------------------------------------------- | -------------------------------------- |
   | Contacts, Companies, Leads, Tasks, Notes, Files, own kinds, close matches | `records.read`                         |
   | Messages, Spam                                                            | `inbox.use`                            |
   | Money                                                                     | `money.read`                           |
   | Calendar, Forms, Knowledge                                                | `workspace.read`                       |
   | Deleted bin                                                               | `records.delete`                       |
   | An add-on's kinds                                                         | its declared permission, while it runs |
   | Settings                                                                  | each entry's own `needs` and `feature` |
   | Archived                                                                  | the kind it came from                  |

   The server asks `scopeCan` (`execute.ts:312-319`). Under a **staff view-as** (`scope.viewAs`) the permissions list
   is empty, so `scopeCan` says no to everything (`execute.ts:94`). There search skips its gates, exactly as
   `executeQuery` skips its own check (`:906-909`), and row security alone decides; the bin comes out empty because
   `bin_items` needs `records.delete`. A **teammate view** already carries the teammate's own permissions
   (`execute.ts:179-183`), so the gates are right there unchanged.

3. **Core's shape rules**, always: the Notes rule (decision 6); customers not in the bin, not erased and not merged,
   wherever search reads `app.people` (`LIVE_PERSON`); tasks, notes, files, appointments, threads and their calls on a
   custom record only when that record reads (`RECORD_READS`); files ready, not deleted, never port papers
   or knowledge files; Spam left out unless picked; cancelled held texts and unanswered bridge calls left out; form
   answers only through a completed response that still reads; payment answers only with `money.read`.

### The gaps row security leaves, and how each is closed

| #   | Gap                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                            | Test                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Conversations, messages and calls never check `inbox.use` (20261013001200:192-207)                                                                                                                                                                                                      | Core's gate on Messages and Spam; `search.kind` refuses `search_kind_not_allowed`                                                                                                                              | `search/gaps.test.ts`, case 1 |
| 2   | Timeline copies hold message, email and transcript words, and the whole business reads them (0083)                                                                                                                                                                                      | Notes read only `NOTE_LINES`, so a narrowed member never finds a hidden thread's words through its copy                                                                                                        | cases 2 and 3                 |
| 3   | `form_answers` ignore the bin (20260927000200:152-153)                                                                                                                                                                                                                                  | `form_answers_follow_response`, plus the join to a completed response                                                                                                                                          | case 4; `search-rls.test.ts`  |
| 4   | Port papers' names are readable by every member (`files_select`, 20261013002400:516-518)                                                                                                                                                                                                | Files leave out `record_type = 'port'`; `file_texts_select` too; the worker never reads them                                                                                                                   | case 5; worker test           |
| 5   | Tasks, notes, files, appointments and threads on a turned-off add-on's records stay readable: their policies check only `sealed`, and `unseen_private_records()` ignores hidden kinds (20261013002400:475-519; 20261018000600:132-134; 20261018001200:55-60; 20261020001000:24-33)      | `RECORD_READS` on Tasks, Notes, Files, Calendar and Messages (i) to (iv), calls through their thread (`custom_records_select` applies `hidden_record_kinds()`); `custom_record_visible` in `file_texts_select` | case 6                        |
| 6   | Customers in the bin, erased names and merged shells stay readable (20261027000400:214-223)                                                                                                                                                                                             | `LIVE_PERSON` wherever search reads `app.people`: Contacts, Archived, close matches, a company's people count, duplicates, standing counts, and a bill's customer (name only, `contact: null`)                 | case 7                        |
| 7   | Staff view-as: `scopeCan` is false for everything                                                                                                                                                                                                                                       | Skip the gates under `scope.viewAs` only                                                                                                                                                                       | `search/visibility.test.ts`   |
| 8   | A meeting on a private record leaves its AI summary as an unsealed note any member reads: `call_suggestion.record` passes only the customer and lead to `activity.log` (`call-suggestion.ts:63-83,170-176`), and a note is sealed only from `custom_record_id` (20261013002400:424-440) | Stage 3 passes the appointment's `custom_record_id`, so the note is sealed with the record before Notes are searched (decision 38)                                                                             | case 8                        |

The same hidden-add-on gap also touches `task.list` and the timeline outside search. Search closes it in its own SQL;
a restrictive policy for every reader is a separate security step (Not yet).

## Screens

### Web: the box and its dropdown (board 1)

In `apps/web/src/components/search/`:

- **`search-provider.tsx`**, mounted in the workspace layout beside `AssistantProvider`, inside
  `WorkspaceShellProvider` and `CallProvider` (`app/app/w/[workspaceId]/layout.tsx:53-98`). It holds the box's ref, the
  business's settings and time zone (from `workspace.get`, for the settings catalogue's values) and recent searches:
  `localStorage` key `hfos.search.recent.<userId>.<workspaceId>`, at most 8, shown when the box is focused and empty
  with "Clear", every read and write in try/catch. When it mounts, it removes every `hfos.search.recent.*` key that
  isn't the signed-in person's, so the next person on a shared browser never sees them, whichever way the last one
  left (`user-menu.tsx:26`, `accept-invite.tsx:73`, `claim-seat.tsx:136`, `delete-account.tsx:46`, or the server's
  `auth/sign-out/route.ts:11`, which can't reach `localStorage`). Sign-out clears them too, as a courtesy.
- **⌘K** (Ctrl K elsewhere) copies the ⌘J guard (`assistant-provider.tsx:637-652`): Meta on a Mac, Ctrl elsewhere,
  ignoring alt, shift and repeats, with `preventDefault` so Ctrl K never reaches the browser's own search. On a computer
  it focuses and selects the sidebar box; below `lg` it opens `/search` with the box focused. `isMac()` moves from
  `assistant-provider.tsx:221-224` into `apps/web/src/lib/keys.ts`, shared by both.
- **`search-box.tsx`** replaces `SearchField` in the sidebar (`components/shell/sidebar.tsx:39-41`). It keeps
  `role="search"` on its form and `data-testid="shell-search"`. Placeholder and label "Search everything", a `<kbd>`
  "⌘K" or "Ctrl K" styled like `ask-button.tsx:28-32`, `aria-keyshortcuts`. The input is an ARIA combobox after
  `industry-picker.tsx:63-172`: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, rows
  pressed with `onMouseDown` preventDefault so focus stays, group headings `role="presentation"`.
- **The panel** is a Radix Popover anchored to the input, portalled, about 600 px wide (the sidebar is 240 px),
  opening to the right on a computer, with collision padding and `onOpenAutoFocus` preventDefault (the
  `nav-links.tsx:414-463` pattern).
- **`use-search.ts`**: 250 ms debounce, 2 characters, an `AbortController` (the `record-picker.tsx:36-92` pattern),
  `apiBrowser().POST('/v1/queries/search.everything', { body: { workspaceId, q, depth: 'quick', perKind: 3,
settingsMatched } })`, the last answer kept on screen while the next loads, and `searchSettings()` run first and
  merged locally as the Settings group (`settingsMatched` says whether it found any). On
  `search_busy`, `search_took_too_long` or `search_too_fast` it shows the refusal's words with "Try again", and retries
  once, quietly, after 2 s.
- **`panel.tsx`** draws `dropdownOf(answer, settingsHits, { maxGroups: 5, maxRows: 10 })` from core, which decides
  the close-match line, the no-one-active line and the empty state after merging the Settings group, and adds it to
  the counts ("All 27", "See all 27 results"):
  - kind chips with counts ("All 26", then the kinds found, in kind order); a chip asks again with `kinds: [key]` and
    `perKind: 5`;
  - the **Best match** row: avatar, the name with marks, the Lead or Client badge, the grey line from `hitLines`
    ("(504) 555-0142 · dana.smith@gmail.com · Texted 2 days ago"), **Call** and **Text**, and ↵ when picked;
  - up to 5 groups of up to 3 rows (2 when more than 3 groups show), in the order of decision 33, each with "See all
    7" to `/search#q=…&kind=…`;
  - **Exact match** and **Also has 1042 in it** when the search is a phone, an email or a number;
  - "Also found: Calendar 2 · Tasks 1 · Notes 1 · Files 1 · Forms 1 · Listings 1" for the groups that didn't fit, each
    a link to the Search page with that kind (`/search#q=…&kind=…`);
  - Archived and the Deleted bin when the active groups hold fewer than 3 hits (decision 28);
  - the hints "↑↓ move · ↵ open · Esc close", and "See all 26 results".
- **Call** uses `useCalls().openDialer({ name, phone, personId })` (`lib/calls/call-provider.tsx:80`, as
  `record-page.tsx` does), or a `tel:` link when calls aren't on in this browser. **Text** opens
  `customers/people/<id>?compose=sms`. Both show only with `inbox.use` (`useCan`) and a phone.
- **`rows/*.tsx`**: one row per kind (contact, company, lead, money, message, calendar, task, note, file, form,
  knowledge, record, setting, bin, archived), plus a generic row for add-on hits from title, subtitle and badges.
  Add-on and record icons come from the registry's `ADDON_UI` and the record-kind icon map; nothing deeper in an add-on
  is imported (`eslint.config.js:16-22`).
- **`highlight.tsx`** draws `{ text, marks }`, and title marks from `marksIn`, as text and `<mark>`, never
  `dangerouslySetInnerHTML`.

### Web: the Search page (board 2)

- **The route** `apps/web/src/app/app/w/[workspaceId]/search/page.tsx`: an async server component that renders the
  frame only. `params` is a Promise (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:13-14`);
  it reads no `searchParams` and asks the API for nothing, so what's typed never reaches the web's server (decision
  37). Metadata title "Search". `proxy.ts:10-14` already keeps `/app` signed-in only.
- **The address** is `/search#q=…&kind=…&archived=1&mine=1&sort=…&show=leads|clients&before=…`. `search-page.tsx`
  reads `window.location.hash` in an effect and on `hashchange` (the `usage-page.tsx:184-190` precedent of reading
  `window.location`, so no `useSearchParams` and no Suspense boundary), trims `q` and cuts it to 120 characters as
  `customers/page.tsx` does (`:10-47`), and asks `apiBrowser()` for the answer (`search.everything`, depth `full`,
  perKind 4; or `search.kind` with `kind`). A browser never sends the fragment, and moving between pages with
  `router.push('/app/w/<ws>/search#q=…')` sends only the path.
- **`search-page.tsx`** (client): the big box; "26 results for “smith”" and "Everything in Bayou Plumbing you’re
  allowed to see."; **Include archived** and **Only mine** (in the fragment); the kinds list on the left from
  `searchKindsFor` with counts, and one line for the allowed kinds with none ("Nothing in Knowledge."); a card per kind
  with richer rows:
  - contacts: phone, email, last contact (and the open lead or company under the name);
  - leads: pipeline › stage, owner, amount;
  - money: the due or late chip, the amount; payments "Paid";
  - messages: channel and name, the snippet marked, when;
  - calendar: when and who; tasks and notes, sharing one "Tasks and notes" card when together they have 4 rows or
    fewer, as board 2 draws;
  - files: "On Marcus Smith · page 3: “…”" with **In the file**;
  - forms: "Answered by Jo Smithers · Oct 19 · “50 gallon, gas”" with **Form answer**;
  - add-on cards with the add-on's name under the kind ("Listings · Real Estate").

  Each card has "Show 3 more contacts" (expands in place from `search.kind`'s first page) and "Only contacts" (the
  one-kind view). Settings, Archived and the Deleted bin come last. A group marked slow, skipped or failed shows its
  line with **Try again**. The fragment changes through `window.history.replaceState` after 300 ms, which Next's
  router follows (`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md:345-347,399-437`)
  without a request; not `router.replace` with a query string, as the Contacts list does (`customers-list.tsx:96-113`),
  which would send what's typed to the server on every pause. `WorkspaceMain` gives the page its ordinary padding.

### Web: one kind (board 3)

The same route with `kind=` (`kind-page.tsx`):

- "9 contacts named “dana”" when every hit matched on the name ("9 contacts for “dana”" otherwise), and "Add a last
  name, a phone number or a street to narrow it." when there are more than 5 and one word was typed;
- the kind chips stay at the top to switch kinds;
- for Contacts: **All 9 · Leads 5 · Clients 4** (`CONTACTS_WORDS`, `standingCounts`) and **Sort**: Best match, Most
  recent contact, Name A–Z;
- a table that tells same-name people apart: Name (badge, and a line: the open lead or company), Phone, Email, Where
  (street and town), Last contact;
- the banner from `duplicates`: "Two Dana Smiths share the number (504) 555-0142. They may be the same person." with
  **Compare and merge** to `customers/people/<a>?merge=<b>`, only with `records.archive` (`person.merge`'s permission,
  `commands/person.merge.ts:33-40`);
- "Showing all 9", or "Showing 50 of 120" with **Show 50 more** (`nextCursor`);
- for windowed kinds, "Searched messages back to Mar 3, 2025." with **Look further back** (`before=`); for Messages,
  **Look in Spam**.

### Web: the different searches (board 4)

All from the same answer and core's words: a phone typed any way (Exact match, the Phone chip, "Same number, maybe the
same person", then "Texts with Dana Smith"); a number ("Exact match", then "Also has 1042 in it"); an address; an email
or web address (Website, Email); words inside messages, notes, files and form answers; a typo ("Nothing spelled “dnaa
smtih”. Showing close matches."); a setting ("Quiet hours · Settings › Texting & calls · 9:00 PM to 8:00 AM");
someone archived or deleted ("No one active matches “tom becnel”.", Archived, Deleted bin); and nothing ("No matches
for “zxqv”" with "Check the spelling, or try a phone number, an email or a street.", **Ask HandsFreeOS** and **Add a
contact**).

- **Ask HandsFreeOS** calls `useAssistant().setDraft('Find “zxqv” in my business')` and `setOpen(true)`
  (`assistant-provider.tsx:130-131`), shown only when the Assistant is on for the person. It never sends by itself.
- **Add a contact** goes to `/customers#add=person&name=<q>` (new: the Contacts list reads the fragment off
  `window.location` in an effect, opens `PersonDialog` with the name filled in, then drops the fragment with
  `history.replaceState`), with `records.write`.

### Web: Settings search (board 6)

- **`apps/web/src/components/settings/settings-search.tsx`**: a "Search settings" box at the top of the `SettingsNav`
  card, above the `<nav>` (`settings-nav.tsx:242`), and above the `SettingsPicker` select below `lg` (`:288`).
  Typing replaces the menu with `settingsFound(n, pages)` ("5 settings on 2 pages"), grouped like the menu: the group,
  the page, the setting and its section ("MESSAGES › Texting & calls › Quiet hours (Texting rules)"; "BUSINESS ›
  Automations › Went quiet after a price (Pipeline and records)", "Gone quiet after"), and **Show every setting** to clear. Board 6's
  "Follow up on leads that went quiet" and "3 settings on 2 pages" were an example (decision 36): the rows and the
  count are whatever the real catalogue holds. It runs core's `searchSettings` on every keystroke; ↑ ↓, ↵ and Esc work
  as in the dropdown.
- **Add-on entries** (an add-on's switches and its settings page) never sit inside a Settings group: Add-ons is at the
  foot of the menu, not a Settings tab (the owner's decision, 2026-09-28, `nav-links.tsx:122-126`;
  `web-boundaries.test.ts:69-71`). They show last, under the add-on's own name ("Real Estate › Deal settings"), marked
  "Opens the Add-ons page" or opening the add-on's own page, never as a page in `SETTINGS_GROUPS`.
- Choosing one `router.push`es `path#anchor`, or `?adjust=<id>` for an automation (`automations-page.tsx:147-162`).
  Already on that page, it calls the highlighter directly: router pushes don't fire `hashchange`
  (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md:687-702`).
- **`use-setting-highlight.ts`**, run in `SettingsFrame` (`settings-nav.tsx:171-202`), which stays across settings
  pages: on a pathname change and when called, it reads `window.location.hash` (no `useSearchParams`, so no Suspense
  over every settings page; the `usage-page.tsx:184-190` precedent), finds `[data-setting]` or the id,
  `scrollIntoView({ block: 'center' })`, adds `ring-2 ring-accent` and takes it off after 4 s
  (`add-ons-page.tsx:160-168`).
- **`SetRow`** (`set-row.tsx:5-44`) gains `setting?: SettingKey`, rendering `id`, `data-setting` and `scroll-mt-20`; a
  small `<SettingAnchor setting>` wraps cards and sections; the Adjust sheet's `Block` (`automations/panels.tsx`) gains
  the same prop. TypeScript refuses a key the catalogue doesn't have. The Automations rows get `id="automation-<id>"`
  (they already carry `data-testid="automation-<id>"`, `automations-page.tsx:349`).
- The ids that emails and tools link to keep their names: `quiet-hours`, `rcs`, `founding`, `notifications`
  (`texting-page.tsx:1839`; `apps/worker/src/telephony/rcs-billing.ts:91`; `apps/worker/src/founding/checkout.ts:479`;
  `apps/worker/src/assistant/tools-extra.ts:972`).
- **The catalogue** (core, browser-safe):
  - `packages/core/src/settings/pages.ts`: `SETTINGS_GROUPS`, the web's `GROUPS` moved unchanged (group label, page
    key, label, path, `exact`, `needs`, `feature`; Partners' label from `PARTNERS_WORDS.menu`). `settings-nav.tsx` keeps
    a `Record<SettingsPageKey, Icon>`, the precedent being `PLACES` keyed by `MENU_KEYS` (`nav-links.tsx:82-120`).
  - `packages/core/src/settings/catalog.ts`: `SETTINGS: SettingEntry[]`, with
    `{ key, page, section, label, words, anchor, open?, needs?, feature?, phone, value? }`: `phone` is a phone route
    (`'settings/notifications?setting=notifications.customer_waiting'`) or `'web'`; `value(settings, timeZone)` prints
    "9:00 PM to 8:00 AM" or "Off" for quiet hours (`schemas/telephony.ts:62-68`) and opening hours. Hand-written for
    each setting row on the Settings pages and each Account section, with synonyms seeded from `LOOK_ALIKES`
    (`assistant/places-map.ts:640-651`); "Who sees which conversations" included (`inbox-visibility-card.tsx:65-101`);
    Delete workspace gated on `workspace.delete`, not on being the owner. Derived entries: each Automations row from
    `AUTOMATIONS` (`automations/catalog.ts:126-155`, its group as the section, opened with `?adjust=<id>`), a short list
    of Adjust fields ("Gone quiet after"), each notification row, and each add-on's labelled switches (opening
    `/add-ons?addon=<id>`, for `addons.manage`) and `ui.nav` settings page (Real Estate's Deal settings, for
    `realestate.manage`, `realestate/manifest.ts:1512-1518`).
  - `NOTIFICATION_ROWS` and `EMAIL_ONLY_ROWS` move from `apps/mobile/src/push/switches.ts:41,124` into
    `packages/core/src/account/notification-rows.ts`; the phone and the web's notifications section
    (`notifications-section.tsx:47`) both read them.
  - `packages/core/src/settings/search.ts`: `searchSettings(q, { permissions, addons, surface })` scores label,
    section, page and words with search's own `fold` (`search/fold.ts`; the `fold` in `industries.ts:280` is private
    to that file and folds differently, and its scoring at `:290-320` is the pattern copied) and the same close-match
    check, gated exactly as
    `useSettingsGroups` gates (`settings-nav.tsx:207-221`: `can` and `coreFeatureRunning`), and returns hits with group,
    page, section, value, href and phone target. `settingValueText(key, settings, timeZone)`.
  - The Assistant's settings map gains the areas it lacks (Main offer, Facebook & Instagram, Deleted bin, Partners), so
    the Assistant and search agree.

### Web: where a result opens

Every href is a web path under `/app/w/<workspace>/`, built once by core's `searchHref`. New:

- `inbox/<conversationId>?message=<messageId>&at=<iso>`: `conversation.thread` with `upTo: at`; the thread scrolls to
  the message and rings it for 4 s; newer items load with `since`.
- `tasks?task=<id>`: `task.list` with `taskId`, `scope: 'all'`, `status: 'all'`, then `TaskDialog` opens (the page
  loads only 100 open and 10 done, `tasks/page.tsx:20-31`).
- `forms/<formId>/answers/<responseId>`: a new web route that redirects to `forms/<formId>?response=<responseId>`; the
  form page opens its responses and calls the existing `show(responseId)` (`components/forms/responses.tsx:36-50`),
  reading the parameter off `window.location`. The phone has the same path already, so one href serves both.
- `customers/people|companies/<id>?activity=<id>`, `leads/<id>?activity=<id>`, `customers/records/<id>?activity=<id>`:
  `activity.get`, shown in a note dialog over the timeline.
- `…?tab=files&file=<id>&page=<n>`: rings the file card; a PDF opens its signed link with `#page=N`
  (`components/files/file-grid.tsx:19-24`).
- `customers/people/<id>?compose=sms`: opens the record page's text sheet (`record-page.tsx:210-214`).
- `customers/people/<a>?merge=<b>`: opens `MergeDialog` with the other customer chosen (`record-page.tsx:1115`;
  `merge-dialog.tsx` gains `initialOtherId`).
- `settings/deleted-bin?item=<binItemId>`: rings the row.
- `settings/<page>#<anchor>`; `search#q=…&kind=…` (the Search page, decision 37); `customers#add=person&name=<q>`.
  What's typed only ever travels after `#`.
- Reused: `calendar?appt=<id>&date=<day>` (`lib/calendar/url.ts:55`), `leads/<id>`, `money/invoices/<id>`,
  `money/estimates/<id>`, `customers/records/<id>`, `knowledge/items/<id>`, `settings/automations?adjust=<id>`,
  `add-ons?addon=<id>`, and add-on pages under `a/<id>/`.

### Web on a phone-width screen

- The header's search button (`mobile-shell.tsx:114-121`) opens `/search` with the box focused (what's typed goes in
  the fragment as on a computer), except in the Inbox,
  where it keeps its inbox-only sheet (`:217-240`, decision 31). That sheet's results end with "Search everything for
  “q”". The sheet's description at `:244` goes.
- On `/search` the header shows "Search" and Back: `/search` is a special case where `:55-64` works out the place.

### Phone: search (board 5) and one kind (board 5b)

- **The button**: `AppBar` (`apps/mobile/src/components/shell/app-bar.tsx:62-113`) gains `search` (on by default when
  `leading === 'business'`), a Search icon after Ask HandsFreeOS as the m10 boards draw it
  (`design/m10/Main.dc.html:1193`), `testID="app-bar-search"`, label "Search everything".
- **The route** `apps/mobile/src/app/app/w/[workspaceId]/search.tsx`, registered as
  `<Stack.Screen name="search" options={{ presentation: 'fullScreenModal' }} />` beside `ask`
  (`[workspaceId]/_layout.tsx:69`). Params `q` and `kind`: with no kind, everything; with one, that kind.
- **Everything** (board 5): the box focused, Cancel, scrollable kind chips with counts (`FilterChip`, defined twice
  today, moves to `apps/mobile/src/components/ui/filter-chip.tsx` from `inbox.tsx:313` and `approvals.tsx:239`), the
  best match with 44 px **Call** and **Text** (`startCall`, `apps/mobile/src/inbox/calls.ts:43`; the thread or
  composer), groups with "See all", the Settings group, and "See all 26 results". Both buttons need
  `holds(grants, 'inbox.use')`. Drawn from core's `dropdownOf` with the phone's limits.
- **One kind** (board 5b): `search.kind` 25 at a time with **Show 25 more** (as forms load, `forms/use-answers.ts:45-46`),
  **All 9 · Leads 5 · Clients 4** for contacts, rows with phone · where · last contact, and the banner "Two Dana Smiths
  share a number. Same person?" with **Compare**, which opens the web's merge (`customers/people/<a>?merge=<b>`)
  through `openWeb`, only with `records.archive`.
- **Online** (`apps/mobile/src/search/use-search.ts`): `api.POST('/v1/queries/search.everything', …)` with depth
  `quick`, perKind 3 and `settingsMatched` from its own `searchSettings` run, the lines decided after merging as on the
  web (`lib/api.ts:40-61` sends the view-as header, so answers follow view-as), 300 ms with
  `useSettled`, stale answers dropped, asked again when signal comes back (the `lib/live-answer.ts` pattern). The phone's
  own rows show at once marked "On this phone" and are replaced in place by the server's answer (not under view-as).
- **Opening a result**: `openAppPath(hit.href)` (`components/assistant/parts.tsx:75-80`): `routeFor` gives a phone
  screen, or `openWeb` opens the browser at the whole path, anchor included. Rows that open the web show the
  `ExternalLink` icon `ListRow` uses.
- **Route map** (`apps/mobile/src/links/route-map.ts:78-133`), new rules: `{ web: 'search', phone: 'search', fragment:
['q', 'kind'] }`, a new field: `splitQuery` drops everything after `#` today (`route-map.ts:139-141`), so it learns to
  read the fragment's pairs for a rule that names them, and the web's `/search#q=…` opens the phone's search with `q`
  and `kind`; `{ web: 'forms', phone: 'forms' }`; `{ web: 'forms/:formId', phone: 'forms/:formId' }`;
  `{ web: 'forms/:formId/answers/:responseId', phone: 'forms/:formId/answers/:responseId' }`; `tasks` gains query
  `task` (the Tasks screen opens it when it's in the copy); `inbox/:conversationId` gains `message` and `at` (the
  thread rings it when it's in the copy); `customers/people/:personId` gains `activity` and `compose`;
  `customers/records/:recordId` goes to the web (the phone has no screen for a business's own kinds).
- **The Contacts and Inbox boxes stay list filters**, keeping the test ids Maestro uses (`customers-search`,
  `(more)/customers.tsx:95-103`, `maestro/subflows/open-customer.yaml`). Each gains a last row, "Search everything for
  “q”". The Contacts box's hardcoded "Search contacts" moves onto `CONTACTS_WORDS.search`.
- **Recent searches**: a local-only table `search_recent` (`workspace_id`, `user_id`, `q`, `at`) in the encrypted
  database, beside `LOCAL_TABLES` (`apps/mobile/src/changes/tables.ts:95`), at most 8 per person per business, never
  sent.

### Phone: no signal

When `useNetwork` (`lib/network.ts:6-20`) says there's no signal, or a request fails for want of it (a fetch
`TypeError`, `api.ts:95-104`):

- `apps/mobile/src/search/copy-sql.ts` runs one bounded SQL per kind through `usePowerSync().getAll`, never a live
  `useQuery` over every row (`customers/use-customers.ts:113-127`), each `lower(col) LIKE ? ESCAPE '\'` with `LIMIT
200`, which `phone-sql.test` checks for SQLite functions and synced columns (`sync/__tests__/phone-sql.test.ts:8-18`).
  Core's `searchCopy` ranks, explains and groups the rows into the server's shape (`source: 'phone'`), so one row
  component draws both.
- Kinds (decision 11): contacts, companies and leads (with the search text the phone builds, moved into core as
  `crm/search-text.ts` and re-exported by `apps/mobile/src/sync/compute.ts:67-112` so its three pickers keep working);
  tasks (open, or done in 90 days, `sync-config.yaml:133`); notes (`NOTE_LINES`, 12 months); calendar (from 90 days
  back, `:167`); live forms by name (`:141-146`); Real Estate deals through `PhoneAddon.search`; settings. Archived
  records aren't shown.
- **Notes and tasks only on a customer in the copy.** The server hides tasks and notes on a turned-off add-on's
  records (gap 5), but the phone's tasks and activities streams carry no `custom_record_id`
  (`sync-config.yaml:133,135`), so the phone can't tell. `searchCopy` and `copy-sql.ts` keep a note or a task only when
  its `person_id`, `company_id` or `lead_id` is in the copy, and drop a row anchored only to a record, as the Contacts
  search does today (`customers/use-customers.ts:177-213`). A line on both a customer and a record still shows, as it
  already does on that customer's timeline on the phone.
- The line at the top is the board's, word for word: "You’re offline, so this searched what’s on this phone. Files,
  messages and money show once you’re back online." with "As of 8:58 AM" (`asOfText`, `lib/sync-status.ts:173-180`).
  Kinds that need signal show as chips that can't be picked. When signal comes back, the server's answer replaces the
  phone's in place.
- Viewing as someone with no signal: Settings only, with "Searching needs signal while you’re viewing as Dana."
- SQLite's `lower()` folds plain letters only, so "jose" may miss "José" offline; ranking and marks still fold.

### Phone: Settings search

A `SearchBox` (`components/admin/bits.tsx:76`) at the top of `(more)/settings/index.tsx` runs `searchSettings` with
`surface: 'phone'`, instantly and with no signal. Settings the phone has (My cell, Face ID lock, Businesses on this
phone, Documents on mobile data, Changes on this phone, Usage & balance, Main offer, Partners, My safety, Notifications,
Appearance, Delete my account; `settings/index.tsx:126-278`) open in place with `?setting=<key>`, and the screen scrolls
to the row and flashes it (`apps/mobile/src/settings/use-setting-flash.ts`; `ListRow` gains `settingKey`). Settings
only the web changes show "Opens on the web" with the `ExternalLink` icon and call
`openWeb('/app/w/<ws>/settings/texting#quiet-hours')` straight away, because `routeFor` drops the hash
(`route-map.ts:139-141`). Values such as quiet hours come from the synced `workspaces.settings`
(`sync-config.yaml:121`). The main search's Settings group behaves the same.

### Keyboard

- ⌘K or Ctrl K from anywhere focuses the box and selects its text; ⌘J stays the Assistant's.
- In the dropdown: ↑ ↓ move over rows (the best match, each group's rows, then "See all 26 results"); ← → over the
  chips; ↵ opens the picked row, or the Search page with none picked; ⌘↵ or Ctrl↵ always opens the page; Esc closes and
  keeps the text, a second Esc clears it; Tab leaves.
- On the Search page: ↑ ↓ move through the kinds list and rows; ↵ opens.
- In the Settings bar: ↑ ↓, ↵ and Esc.

## Words in core

`packages/core/src/search/words.ts`, `SEARCH_WORDS`, for both apps:

- **The box**: "Search everything"; "Recent searches", "Clear"; the kind labels in order: Contacts, Companies, Leads,
  Money, Messages, Calendar, Tasks, Notes, Files, Forms, Knowledge, Settings, Spam, Archived, Deleted bin, Close
  matches; "Best match"; `seeAll(n)` "See all 7"; `seeAllResults(n)` "See all 26 results"; "Also found:"; "Exact
  match"; `alsoHas(q)` "Also has 1042 in it"; the hints "move", "open", "close".
- **The page**: `resultsFor(n, q)` "26 results for “smith”" (with "100+"); `everythingIn(business)` "Everything in
  Bayou Plumbing you’re allowed to see."; "Include archived", "Only mine"; `nothingIn(labels)` "Nothing in Knowledge."
  or "Nothing in Knowledge and Settings."; `showMore(n, plural)` "Show 3 more contacts"; `only(plural)` "Only contacts";
  "Tasks and notes".
- **One kind**: `named(n, plural, q)` "9 contacts named “dana”" and `kindFor(n, plural, q)` "9 contacts for “dana”";
  "Add a last name, a phone number or a street to narrow it."; "Showing all 9" and `showingOf(a, b)` "Showing 50 of
  120"; "Show 50 more", "Show 25 more"; the sorts "Best match", "Most recent contact", "Name A–Z";
  `twoShare(name, phone)` "Two Dana Smiths share the number (504) 555-0142. They may be the same person." and
  `twoSharePhone(name)` "Two Dana Smiths share a number. Same person?"; "Compare and merge", "Compare"; "Same number,
  maybe the same person"; `searchedBack(plural, date)` "Searched messages back to Mar 3, 2025."; "Look further back";
  "Look in Spam".
- **Empty and odd states**: `closeMatches(q)` "Nothing spelled “dnaa smtih”. Showing close matches."; `noneActive(q)`
  "No one active matches “tom becnel”."; `noMatches(q)` "No matches for “zxqv”" with "Check the spelling, or try a
  phone number, an email or a street."; "Ask HandsFreeOS", "Add a contact"; `askDraft(q)` "Find “zxqv” in my
  business".
- **A group that didn't answer**: `tooSlow(label)` "Messages took too long to search. Try again, or pick Messages on
  its own."; `skipped(label)` "Messages wasn’t searched this time, to keep this quick. Pick Messages on its own to
  search it."; `addonFailed(name)` "Real Estate couldn’t be searched just now. Try again in a minute."; "Try again".
- **The phone**: the offline line, word for word from board 5; "On this phone"; `viewingAsOffline(name)` "Searching
  needs signal while you’re viewing as Dana."; `everythingFor(q)` "Search everything for “q”".
- **Why chips** (`whyLabel(field)`): Phone, Email, Website, Address, Number, Amount, Card, Company, Customer, In a
  message, Voicemail, Call, In a note, Task notes, File name, In the file, Form answer, MLS number, Close match, and a
  custom field's own name.
- **The grey lines** (`search/lines.ts`, `hitLines(hit, { now, timeZone })`): "(504) 555-0142 · dana.smith@gmail.com ·
  Texted 2 days ago"; "Works at Smithfield Property Mgmt"; "12 people · 4 open leads"; "Dana Smith · Installs › Quote
  sent"; "Marcus Smith · Was due Oct 14" with the chip "6 days late"; "Dana Smith · Sent Oct 17 · Not opened yet";
  "Marcus Smith · Invoice #1031" with "Paid Sep 30"; "Thu, Oct 23 · 8:00–10:00 AM · Jo Smithers"; "Task · Due tomorrow ·
  Sam Rivera"; "Note on Dana Smith · Oct 18"; "On Kim Le · page 3"; "Answered by Jo Smithers · Oct 19"; "Last one 2 days
  ago · 14 messages"; "Settings › Texting & calls · 9:00 PM to 8:00 AM"; "Archived Mar 3 · Restore from the record’s
  menu". `lastContactLine({ kind, subtype, at }, now)`: "Texted", "Emailed", "Called", "Missed call", "Visit", "Note",
  "Chatted", "Messaged", "Booked", "Paid", then when. It has its own name on purpose: core already exports
  `lastContactWords(iso, now)` from `crm/pipeline-words.ts:172-177`, and both sit under `export *` in core's index
  (`index.ts:25`), so a second function of that name would fail typecheck as an ambiguous re-export. Within a week
  the "when" is `lastContactWords(at)` itself, lower-cased after the verb ("Texted 2 days ago", "Called yesterday",
  "Booked today"), so there is one wording for how long ago; after that it is the date (`formatDate`, "Emailed Oct 9",
  "Paid Sep 30").
- `bin-words.ts` gains `binLeftLine(item)`: "Deleted 4 days ago · Gone for good in 26 days", beside `binItemDetail`
  (`bin-words.ts:289-315`, `BIN_DAYS`).
- **Settings words** (`settings/words.ts`): "Search settings", `settingsFound(n, pages)` "3 settings on 2 pages", "Show
  every setting", "Opens on the web".
- **Refusals**: the table above; each in `search/words.ts` so the API, the web and the phone print the same.

`CONTACTS_WORDS.search` ("Search contacts") stays for the Contacts page's own box (`customers-list.tsx:181-192`).

## Tests by package

**`packages/db`** (against the local stack):

- `search-rls.test.ts`:
  - `form_answers_follow_response`: a binned response's answers are invisible to an owner and a member, come back after
    Bring back, and the service actor is unaffected; `form.results`' recent answers drop them.
  - `file_texts_select`: another business's row unseen; a sealed file's words only for its record's people; a binned
    file's words hidden and back after Bring back; a deleted file's hidden; port papers and knowledge files never, even
    for `channels.manage`; an unsealed file on a turned-off add-on's record hidden; no grant for `portal_actor` or
    `anon`; the service actor held to its business.
  - The forget trigger: `file.delete`'s update removes the words, the bin's update keeps them, emptying the bin and
    deleting the business cascade.
  - `files_without_text`: callable by `service_actor` only; finds missing and older-reader rows, never binned, deleted,
    port or knowledge files.
- `search-leakproof.test.ts`: asserts from the catalogue that `textlike`, `ts_match_vq` and `similarity_op` have
  `proleakproof = false` and `texteq` and `starts_with` have it true, so a change that makes them leakproof, which
  would change why there are no text indexes (How it works, 2), shows up. Only catalogue reads: `@hfos/db` can't import
  `@hfos/core` (core depends on db, `parity.test.ts:33-37`), so the plans of core's own statements are tested in core.
- `sync-secrets.test.ts`: `file_texts` isn't in `pg_publication_tables` for `powersync`. `parity.test.ts` covers
  `fileTexts`.

**`packages/core`** (through `executeQuery` as different people, against the local stack):

- `search/gaps.test.ts`, one case per gap:
  1. `inbox.use` taken away (a permission the business sets): no Messages group though row security would allow it;
     `search.kind('messages')` refuses `search_kind_not_allowed`.
  2. A narrowed inbox: a word only in a thread the member isn't on is found neither in Messages nor in Notes (its sms
     copy isn't searched); a word in their own thread is found.
  3. Timeline copies: an sms or email copy never shows in Notes; an imported note (kind `note`, subtype `gohighlevel`,
     actor `integration`), a logged call (kind `call`, no subtype) and the AI's "Call summary:" note do; a call copy
     (subtype `answered`), a `file_added` line and an `intake` line don't.
  4. A form response in the bin: its answers aren't found.
  5. Port papers: never found by name by a member or an owner.
  6. A turned-off add-on: a task, a note and a file on a Real Estate property, and a tour (an appointment) and the
     portal thread on a Real Estate deal, found by the deal's own people, hide from them when it's turned off and come
     back when it's on; a call in that thread hides with it; the records group hides the kind; the contributor isn't
     run; nothing errors.
  7. Customers: one in the bin is in neither Contacts nor Archived; a merged shell and an erased name never show; a
     misspelt name of a customer in the bin gives a member no close match; a company's people count leaves out people
     in the bin and merged shells; an invoice whose customer is in the bin is found by the name, with no phone, email,
     Call or Text; the owner sees the bin group by name, a member doesn't, a member given `records.delete` does.
  8. A sealed meeting: the "Call summary:" note of a tour on a private deal is found by the deal's people and by
     nobody else (after stage 3's change to `call_suggestion.record`).
- `search/visibility.test.ts`: staff view-as (gates skipped, what row security allows, an empty bin, private mail
  hidden); a teammate view (the teammate's permissions, their own mail hidden); a person's own mailbox (found with "My
  mail", never by a teammate or an owner); a sealed deal and its portal thread hidden from someone off the deal across
  records, tasks, notes, files and messages; a money member finding only their own invoices by number and by amount;
  Spam absent unless picked, Other mail badged, for calls in those threads too; knowledge files never in Files; a
  cancelled held text and an unanswered bridge call never found; an internal meeting's AI summary (no customer, so no
  note) never found by anyone.
- `search/limits.test.ts`, with test-only searchers passed through `runSearch`'s `searchers` option: "%" and "_" match
  literally; 121 characters is a validation error; one character, "--", "@@" and a lone "1" return `tooShort` with no
  statement run (a statement counter), and "12" runs no digit arm; a searcher sleeping past its timeout marks only its
  group `too_slow`; with 30 ms of budget left the next kind is `skipped` and `statement_timeout` is never set to 0 or
  under 50 ms; every kind timing out refuses `search_took_too_long` with 503 and disposition `retry`; no event, outbox
  or audit row is written. Scrubbing: a forced `DrizzleQueryError` and a forced 57014 in a kind, a snippet statement,
  close matches, `search.kind`'s paging and a contributor each leave the request answering (the group marked) or
  refusing with a rule, and neither the answer nor any thrown error's message, cause or stack holds the typed words.
- `search/plans.test.ts`, the capacity guard, moved here from `packages/db` because it runs core's own statements:
  through `asUser` on a seeded business, after `set local enable_seqscan = off` and `set local enable_bitmapscan = off`
  (a small business picks a Seq Scan, or a bitmap scan on another index and a sort, whatever indexes exist; stage 1's
  Built note), `EXPLAIN (costs off)` of each searcher's real statement names
  `messages_workspace_occurred_idx` for the messages window, `activities_notes_idx` for Notes (built from `NOTE_LINES`,
  so the partial condition is proved under row security), `conversations_recent_idx` for threads,
  `form_answers_recent_idx` for answers and `people_workspace_idx` for contacts.
- `search/fold.test.ts` (against the local stack): core's `fold` and `private.search_fold`, and core's `searchWords` and
  `private.search_words`, give the same text over one corpus (ł, ø, æ, œ, ß, đ, İ, é both precomposed and as e plus a
  combining accent, Greek, digits with leading zeros, emails, web addresses, "(504) 555-0142", "INV-001042"), and the
  fold never changes the length.
- `search/kinds.test.ts`: board fixtures for each searcher (a phone typed four ways, "#1042" and "INV-001042", "$1,280",
  an address, a domain, words in a message, note, file and answer, "dnaa smtih", "zxqv", "quiet hours"); a thread found
  by its chat visitor's name and by a Meta @handle; a payment found by amount and by card ranked by its tier; a call in
  a Spam thread left out of Messages, in an archived thread left out without Include archived, and under Only mine
  only when the thread is the person's; a lead with both a person and a company found by the company's name; a draft
  invoice and a draft estimate found by title and by customer, titled "Draft invoice"; "2026-1042" and a bare "1042"
  both exact against a `2026-` prefix, "LS-0042" exact, "1042" exact against `INV-001042`; a note and a form response
  found by who they're on, after word matches; a contact's last contact reading "Booked yesterday" and "Paid Sep 30",
  and never a `file_added` line; counts capped at 100; Only mine per kind; Include archived; windows (a 25,001-message
  fixture says `searchedBack`, and `before` carries on); `search.kind` cursors for each sort, a "best" cursor built
  with `encodeCursor({ sort: 'best', id: '50' })`, and a tampered one giving `listMovedOn`; standing counts and
  duplicates that leave out customers in the bin.
- Pure unit tests (no database): `probes.test.ts` ("(504) 555-0142", "504.555.0142", "+1 504 555 0142" and "5045550142"
  give `+15045550142`; "555-0142" gives digits only; emails; a domain from "https://www.gulfcoastrealty.com/about";
  "$1,280" and "1,280.00" give 128000 cents through `parseMoney` and "1042" gives no amount; "2026-1042", "#1042",
  "INV-001042" and "LS-0042" give their number and counter; "--" and "@@" give no words; `$tsq`never holds an operator
character);`rank.test.ts`(tiers, best match at tier 2 or better, campaign sends after one-to-one, document numbers
through`documentNumberMatches`); `snippet.test.ts`(marks fold and read digits, and fit the original after ß and
ł;`"<script>"`stays text);`close.test.ts` (`osaDistance('dnaa', 'dana') = 1`, `('smtih', 'smith') = 1`; for
"dnaa smtih", both Dana Smiths, close on both words, before Marcus Smith, close on one); `href.test.ts`;
`dropdown.test.ts`(the rule of decision 33, not board 1 copied: tier 0 to 2 groups by tier, then kind order, so
Messages comes before Calendar at tiers 3 and 4, and the chips follow the same order; the best match out of its
group; Also found; Archived only under 3 hits; the close-match and no-one-active lines decided after the Settings
group, so "quiet hours" with a setting and nothing else shows no close-match line, and the counts include
settings);`kinds.unit.test.ts`(every searcher's key has exactly one`SEARCH_KINDS`entry and the other way round);`lines.test.ts` (`lastContactLine`reads "Texted 2 days ago" through`lastContactWords`, then "Emailed Oct 9");
`copy.test.ts` (`searchCopy`on synced-row fixtures gives the server's groups, order and words, the`realestate-phone-views.test.ts:371-373` approach; an unsealed note and a task on a property, with no customer, are
  never found offline).
- `settings-catalog.test.ts`, reading the web's source as `settings-map.test.ts:29-70` does: every page path has a
  `page.tsx`; every key appears exactly once as `setting="key"` or its anchor as an id; every literal
  `<SetRow title="…">` and `<Block title="…">` under `components/settings` and `app/…/settings` carries `setting=` or
  sits on `NOT_SEARCHABLE` with a reason (`components/calendars` and `components/ai-team` left out, decision 13); every
  `settings…#anchor` link in `apps/web`, `apps/worker` and `apps/mobile` resolves; every phone target exists under
  `apps/mobile/src/app`; `searchSettings('quiet')` gives the real catalogue's entries (Quiet hours under Texting &
  calls; "Went quiet after a price", "Regular customer gone quiet" and "Channel went quiet" under Automations, and the
  Adjust field "Gone quiet after"), grouped by page, with the count `settingsFound` works out from them, never board
  6's "3 settings on 2 pages", and gated by permission and feature; Delete workspace needs `workspace.delete`; no
  entry's group or page is an Add-ons page, and every add-on entry sits under its add-on's name.
- `settings-map.test.ts:45-47` reads `MENUS.Settings` from core's `SETTINGS_GROUPS`; `web-boundaries.test.ts:69-71`
  asserts core's settings pages hold no Add-ons page.
- `addons/search-contract.test.ts` (stage 4a, on a test-only add-on): `addonSearchIssues` is clean for every module
  and fails for a wrong name, a foreign permission, an unknown covered kind, a missing query and a query without
  `route: false`; a bad href is dropped; a contributor that throws a `DrizzleQueryError` holding the typed words leaves
  the rest standing as `failed`, and the words are in no log line. `addons/realestate-search.test.ts`:
  an MLS number finds the listing first; a private deal is found by its team and not by another member; archived deals
  only with `includeArchived`; `covers` honoured only when the contributor ran; a property with no listing found under
  Properties, and one with a listing found once, as its Listing; `addon_inactive` on `search.kind` while it's off. `execute-query-within.test.ts`: permission,
  add-on off, view-as, another business refused.
- `commands.test.ts:810`: the new queries in order and `file.save_text`; `mobile-contract.test.ts`: recorded again;
  the places map's wording.

**`apps/api`**: `search-slots.test.ts` unit-tests `acquireSlot(timeoutMs)` directly: three held slots make a fourth
wait and give up after its timeout, a released slot lets the next in, and nothing leaks after a throw (real local
searches finish in milliseconds, so a route test can't hold a slot for a second). `search-guards.test.ts` checks only
the wiring: both routes carry the rate limit; the 91st `search.everything` in a minute from one person gets 429 with
`search_too_fast` while another person isn't limited; a route whose slot can't be had answers `search_busy` 503;
other routes never wait; the invitation routes' 429 body is unchanged; the OpenAPI export has both queries and no
`route: false` query (no `/v1/queries/realestate.search`); the error log of a forced failure holds no `q`.
`healthz.test.ts:41-56` expects every human query except those marked `route: false`.

**`apps/worker`**: `test/files/office-text.test.ts` (Word and Excel built in the test; a high-ratio zip and one with too
many entries refused; a PDF named `.docx` read as a PDF; a non-zip refused) and `test/files/file-text.test.ts`
(`file.attached` schedules one job; a PDF saves its page starts and "page 3" comes out right; a scan saves `no_text`;
CSV; an image saves `unsupported` without a download; port and knowledge files skipped; over 25 MB saves `too_large`;
no words in the event or audit; the sweep schedules only missing and older-reader files, at most 20 a run with their
`runAt` spread over five minutes, and stops; a file whose read ends `removed` is never scheduled again by the sweep;
the last failed attempt saves `unreadable`).

**`apps/web`** (Playwright, local stack only):

- `crm.spec.ts:176-189` rewritten: typing "Ramsey" in `shell-search` shows the dropdown with Contacts; Enter lands on
  `/search#q=Ramsey`, and no request the browser sends to the web's own server carries "Ramsey" (Playwright's request
  log). Specs that open `/customers?q=` directly stay (`crm.spec.ts:62`, `import.spec.ts:46-49`,
  `customer-team.spec.ts:164-166`).
- `search.spec.ts`: chips and groups; the best match's Call and Text; ↑ ↓ ↵; `ControlOrMeta+k` focusing the box; a
  phone typed with punctuation finding the exact contact with the Phone chip; an invoice number; a kind page with sort,
  Leads/Clients, the duplicate banner and Show 50 more; Archived and the bin for an owner and no bin for a member; a
  member without `inbox.use` or `money.read` never seeing those chips or rows; the empty state's buttons; each new deep
  link opening the right thing.
- `settings-search.spec.ts`: "quiet" shows the count core's `settingsFound` gives for the seeded catalogue (imported
  from `@hfos/core`, not written out), with Quiet hours under Texting & calls; choosing Quiet hours lands on Texting &
  calls with its card ringed; the jump works on the same page too; a member doesn't see Texting & calls.
- `search.mobile.spec.ts` (`playwright.config.ts:57-63`): the header button opens `/search` with Back and "Search"; the
  Inbox keeps "Search conversations".

**`apps/mobile`**: jest `src/search/__tests__/search-screen.test.tsx` (online groups, offline with the board's line and
the chips that can't be picked, a failed request falling back to the copy, view-as with no signal, an unknown kind
skipped); a Settings search test (a phone setting scrolls and flashes; a web-only one calls `openWeb` with the hash);
route-map tests for the new rules; `phone-sql.test` covers the new SQL by itself; `compute.test.ts:37-39` passes after
the search-text builders move to core; Maestro `apps/mobile/maestro/search.yaml` (open search from the app bar, type a
name, open the contact; then the no-signal subflow and the offline line), with `open-customer.yaml` untouched.

**Load check** (not in CI): `scripts/search-load.mjs`, local stack only and never against the hosted project, seeds a
business with 300,000 messages, 50,000 notes and 20,000 customers, runs 200 searches each as a narrowed member, a member
and an owner, and prints p50 and p95. Quick p95 must stay under 400 ms and full under 2 s. The numbers go in
docs/search.md.

## Build order

Each stage ships on its own with its tests and leaves today's box and `/customers?q=` working until stage 9. A stage
with a migration applies it to the hosted database before its merge to `main`. Commits are named "Search 1: …",
"Search 2: …". Every stage ends with `pnpm lint && pnpm typecheck && pnpm format:check`, its package tests, and marks
its step **Built** here with what changed while building.

1. **Search 1: the windows, folding and the form-answers rule.**
   - Ships: Migration A, with `private.search_fold` copied from core's fold map, and the map itself. Nothing on screen
     changes, except that a binned response's answers leave Forms → Results.
   - Files: `supabase/migrations/<version>_search_windows.sql`, `packages/core/src/search/fold.ts`,
     `packages/core/test/search/fold.test.ts` (the `fold` half; `searchWords` joins it in stage 5),
     `packages/db/test/search-rls.test.ts`, `packages/db/test/search-leakproof.test.ts`,
     `packages/db/test/forms-rls.test.ts`.
   - Tests: the db cases for the new policy, the leakproof catalogue, and core's fold against the SQL. The plans of
     the windows are tested in core once its statements exist (stages 2 and 3, `search/plans.test.ts`), never by a
     copy of them in `packages/db`, which can't import core.
   - Docs: docs/forms.md (Results leaves out binned responses' answers), docs/deleting.md (form answers follow their
     response).
   - **Built** (2026-10-20). Migration A is `20261027009700_search_windows.sql`, applied locally; it still has to go
     on the hosted database ("Apply new migrations", docs/operations.md) before this reaches `main`. What changed
     while building:
     - **Σ and ς fold to σ.** Not an accent, but the local stack's database uses the ICU locale provider, whose
       `lower()` turns a word-final Σ into ς by context, while one character at a time (core, and a libc database)
       gives σ. With both in the map, nothing is left that depends on the letters around it, so core, the phone and
       any database agree, and "οδος" still finds "ΟΔΟΣ". `fold()` still lower-cases each character on its own.
     - **What the map holds** (518 letters, both cases): every letter of Latin-1 Supplement and Latin Extended-A,
       and of Latin Extended-B and Latin Extended Additional (Vietnamese), that is a plain letter with accents; and,
       besides the ones the plan names, ð, ħ, ı, ŀ, ŧ, ſ, ẞ, ǿ, ǽ and ǣ. `FOLDS_TO` in `search/fold.ts` groups them
       by the letter they fold to, and `FOLD_FROM` and `FOLD_TO` are built from it; the migration holds the two
       strings as written then.
     - **`form.results` dropping a binned customer's answers is tested in core** (`test/form-queries.test.ts`, with
       `person.delete` and `bin.restore`), since `packages/db` can't import core. `search-rls.test.ts` holds the
       policy's own cases, and reads the form's answers the way Results does.
     - **`forms-rls.test.ts`** gains the phone's sheet sending its answers again (`on conflict do update` with
       `returning`), because that path now reads the answer already there through the new policy.
     - **`search-leakproof.test.ts`** checks every function "How it works", 2 names, not only the five in Tests by
       package, and that Supabase's `postgres` role isn't a superuser.
     - **`fold.test.ts`** also compares every character from U+0001 to U+024F, Greek, Cyrillic and Latin Extended
       Additional one at a time, and checks that `fold` keeps the length of every character in the Basic
       Multilingual Plane. Run as a signed-in person, so it proves `authenticated` may call `private.search_fold`.
     - **`private.search_fold` skips `translate` for ASCII text, and has no `set search_path`, so it's worked out
       inline.** As the plan wrote it, it cost about 60 µs a 17-letter name, ASCII or not: `translate` checks every
       character against all 518 letters of the map (about 2.4 µs a character), and a function with a search_path
       set is never inlined (about 5 µs a call). 20,000 names folded twice, as Contacts' `$starts` and `$folds` arms
       do, took about 2.4 s locally, past the quick search's 1.5 s a statement. Now text whose bytes equal its
       characters (only ASCII, in UTF-8) is just lower-cased, which gives the same text since no ASCII letter is in
       the map, and the same 20,000 names take 40 to 60 ms. Every name in the body is written out in full
       (`pg_catalog.lower`, `operator(pg_catalog.=)` and so on), so a caller's search_path can't change it; it's
       the one function here without a pinned search_path, which `rls.test.ts` requires only of definer functions,
       and Supabase's advisor will list it as "search path mutable", which is expected. `fold.test.ts` checks the
       plan works it out inline with the ASCII branch, so pinning a search_path later fails there.
     - **Text with an accent still pays the map in full**: about 2.4 µs a character, so about 40 µs a 17-letter name,
       and each call pays it again (Postgres doesn't share one fold between two arms). Stage 2's searchers can fold a
       row's name once (a lateral, or a subquery) where the sketches fold it twice, and its `plans.test.ts` and stage
       3's load check, whose 20,000 customers should include accented names, watch it. **Stage 5**: a file's words
       (`private.search_words` in a stored column over up to 100,000 characters) and the Files snippet's
       `strpos(private.search_fold(t.text), …)` take the slow path for any file with one accent, about 240 ms for
       100,000 characters; the column is worked out once when the words are written, but the snippet runs per
       search, so cut `t.text` to a stretch before folding it, or find the word in the unfolded text first.
     - **`form_answers_recent_idx` ends with `response_id desc`**: it's on
       `(workspace_id, answered_at desc, response_id desc)`. A response's answers share one `answered_at`
       (`forms/submit.ts` writes them in one insert with `now()`, and an import gives them the response's time), so
       without a tiebreaker a window cut at 3,000 rows splits a response, and "Look further back" on
       `answered_at < $before` skips the rest of it. Stage 3 orders the window by
       `answered_at desc, response_id desc` (the Forms sketch now does), and pages answers on
       `(answered_at, response_id) < ($before, the last response)` so each response is read whole.
     - **`form_answers_follow_response` is a correlated `exists`**, as the forms' own insert and update policies are:
       `exists (select 1 from app.form_responses r where r.id = form_answers.response_id)`, not
       `response_id in (select r.id …)`. It means the same, but the `in` form can only be a hashed subplan, which
       reads every response the person can see, in every business they can open, before any statement reading
       answers, even one form's. Now each answer probes `form_responses_pkey`.
     - EXPLAIN as an owner under row security uses `activities_notes_idx`, `conversations_recent_idx` and
       `form_answers_recent_idx` for the three windows, as How it works, 2 says, but only with **both
       `enable_seqscan` and `enable_bitmapscan` off**. With only seqscan off, the seeded data picks a bitmap scan on
       another index and a sort for threads (`conversations_one_per_line`, or `conversations_assignee_idx`) and for
       answers (`form_answers_workspace_idx`); notes use their index either way. `plans.test.ts` (Tests by package)
       now turns both off. The tests that pin this come with the statements, in stages 2 and 3.

2. **Search 2: core's search, its first kinds, and the API's guards.**
   - Ships: `search.everything` and `search.kind` for Contacts, Companies, Leads, Money, Knowledge, a business's own
     kinds, the Deleted bin and close matches, with the probes, tiers, why, marks, snippets, words, hrefs and
     `dropdownOf` in core; `step`, the budget with its 50 ms floor, savepoints for every statement, scrubbed errors and
     `search_took_too_long`; `LIVE_PERSON` and `RECORD_READS`; amounts from `parseMoney` and document numbers from
     `money/numbering.ts`; the rate limits with `search_too_fast` and the slot gate with `search_busy`; `pnpm openapi`.
     Nothing on screen yet.
   - Files: `packages/core/src/search/{words,kinds,probes,rank,snippet,close,href,dropdown,lines}.ts`,
     `packages/core/src/search/server/{run,sql}.ts`,
     `packages/core/src/search/server/kinds/{contacts,companies,leads,money,knowledge,records,bin,close}.ts`,
     `packages/core/src/schemas/search.ts`, `packages/core/src/queries/search.ts`, `packages/core/src/queries/money.ts`
     (export the member clauses), `packages/core/src/money/numbering.ts` (`documentNumberProbe`,
     `documentNumberMatches`), `packages/core/src/queries/index.ts`, `packages/core/src/bin-words.ts`,
     `packages/core/src/index.ts`, `packages/core/src/server.ts`, `apps/api/src/routes.ts`,
     `apps/api/src/search-slots.ts`, `apps/api/test/search-slots.test.ts`, `apps/api/test/search-guards.test.ts`,
     `packages/api-client/src/schema.d.ts`, `packages/core/test/search/*.test.ts` (with `plans.test.ts` for the
     kinds so far), `packages/core/test/commands.test.ts`.
   - Docs: a new docs/search.md with "Where things are", "How a search runs" and "Rules worth knowing before changing
     anything" (row security decides and core adds a gate for each gap; windows on btree indexes, never GIN; nothing
     typed is kept or logged; a new kind adds its gate to `kinds.ts` and a case to `gaps.test.ts`).
   - **Built** (2026-10-20). No migration. `pnpm openapi` adds both queries to `packages/api-client`. What changed
     while building:
     - **More files than listed:** `search/index.ts` (the browser-safe barrel core's index exports),
       `search/server/hit.ts` (building a hit, and which field a row matched in, shared by the searchers),
       `search/server/kinds/index.ts` (`SEARCHERS`, in kind order), and `test/search/helpers.ts` (Bayou Plumbing and
       the boards' rows).
     - **A searcher has two halves**, `{ key, find(db, plan), facts?(db, plan, hits) }`, not `run(tx, plan)`: `find`
       reads the candidates and core ranks them; `facts` reads only the winners' details (a contact's client badge,
       open lead and paid date, a company's people, a record's own fields). Neither sees `ctx.tx`: each statement goes
       through the `SearchDb` it's handed, which is `step`, and a statement stopped for time throws `SearchStopped`,
       caught for that kind alone.
     - **Errors:** a database error in a kind's candidates, close matches or a kind's page is thrown again as
       `SearchFailed` ("search contacts failed: 42P01"), as How it works, 7 says, so the API answers 500 and logs that
       line only; "answering or refusing with a rule" in Tests by package holds for timeouts and for the winners'
       facts. A facts step that fails keeps its hits and marks the group `failed` or `too_slow`; `SEARCH_WORDS.failed`
       words that line for core's own kinds.
     - **Archived came now, not in stage 3,** for contacts, companies, leads and records: their SQL, as sketched,
       returns archived rows, which had to go somewhere. They come back only by name or title (`archivedRule` in
       `sql.ts`), go under Archived, fold into their kind with Include archived, are left out of a kind's own page, and
       `search.kind('archived')` lists them; a kind that runs out of time there marks the page (`unavailable`,
       `complete: false`) rather than leaving it quietly short. Stage 3 adds conversations and forms.
     - **`search.kind` pages in core for every sort:** each searcher reads up to 500 candidates in that sort's own SQL
       order (Best match by tier, Most recent by the hit's `at`, Name A–Z by the lower-cased name), then core pages by
       offset for Best match (any offset under 500, rather than 0 to 450, since a page holds 1 to 100), by `(at, id)`
       for Most recent and by `(folded title, id)` for Name A–Z, with `decodeTimeCursor` and `decodeCursor`; past 500
       it says `capped`. A contact's `at`, and Most recent contact, is their last contact (decision 35's lines, through
       `activities_person_idx`), else their last change; for Most recent that lateral runs before the cut, for every
       candidate, so the 500 read are the 500 most recently in touch. Money's `at` is a bill's creation and a
       payment's receipt; the rest use their last change.
     - **Document numbers carry their prefix:** a counter matches under the same prefix, a bare number under any
       (`documentNumberMatches`, and `numberMatches` in SQL), the prefixes compared by their letters and digits alone
       (`barePrefix`). So "1042" finds `2026-1042` and `INV-001042`, "LS0042" finds `LS-0042`, while "LS-0042"
       doesn't find `INV-0042` and "2026-1042" doesn't find `INV-1042`.
     - **Probes:** digits only when nothing but digits and a phone's punctuation was typed (otherwise "dana 504"
       matched every 504 number in the business); a card's last 4 only for exactly 4 digits typed; a document number
       only for one word, or one word after "invoice", "estimate", "inv" or "est" ("Invoice #2026-1042", a result's
       own title), and not when it was a whole phone number. A digit or two on their own ("+1", "15", "1 2") make no
       words, since the records' `search_text` holds every phone in E.164 and they'd match nearly all of them; beside
       a word ("12 oak") they still count, and "15" is still a document number.
     - **The fold runs once a row:** each searcher folds a name in a `cross join lateral (… offset 0)`, as stage 1's
       note asked, and every arm reads that `fname`: `startsAll` takes the folded name. `plans.test.ts` counts one
       fold a name in each statement's verbose plan.
     - **Close matches wait for everything else:** none when the Deleted bin found the name, Archived did, or a kind
       didn't answer (it may hold the name); and with chips picked, only over those kinds (a record kind picked by
       name, only that one). `noneActive`, and `dropdownOf`'s no-one-active and nothing-at-all lines, likewise only
       when every kind answered.
     - **Why it matched, at tier 3,** is the field holding the words the name or title doesn't (`fieldHolding` in
       `hit.ts`): "dana metairie" is Dana's address, not her email; "repipe marcus" is the invoice's customer. A row
       whose words sit in no named field says `phone` when its phones hold them.
     - **`plans.test.ts`:** contacts read through `people_workspace_updated_idx` when the order by recency makes it
       cheaper than `people_workspace_idx`; both lead with the business, so the test accepts either and checks the
       index condition is the business.
     - **Shapes:** `SearchFacts` gains `archivedAt`, `deletedAt` and `purgeAfter` (for "Archived Mar 3" and the bin's
       line), and badges gain `draft`. The close-match group is one group, `close`, each hit keeping its own kind.
       `dropdownOf` takes the device's Settings group as a `SearchGroup` (stage 6 builds it from `searchSettings`).
       `searchKindsFor({ permissions, viewAs })` gains add-ons in stage 4a. When the business's own kinds run out of
       time they answer one group, `records`, in the records' place (`kindRank`), named "Your own kinds of records";
       `unavailableLine(group)` in `dropdown.ts` words every group that didn't answer, and theirs say only "Try
       again", since no one chip picks them all.
     - **Words:** an invoice's line uses core's own `dueWording` ("Marcus Smith · 6 days overdue"), not board 3's
       "Was due Oct 14" with a "6 days late" chip; `CONTACT_LINES` and `countsAsContact` live in `search/lines.ts`,
       and `lines.test.ts` reads core's source for every subtype a timeline line is written with. `SEARCH_WORDS`
       gains `noName`, and `searchCount` says "20+" for a count cut at 20, as it says "100+" at 101 rows.
     - **Names:** `runSearchEverything` and `runSearchKind` (with `runSearch` choosing between them),
       `searchKindEntry` (the query is `searchKind`) and `searchCount` (core's migrations already export
       `countWords`).
     - **Knowledge** asks `searchKnowledge` with the probe's words for its most, 20, in the box and on its own page
       alike, and a full read is marked `capped` (`FoundGroup.capped`): "Knowledge 20+", never 4 presented as all.
       **The bin** reads 101 rows like the other kinds (not 21), so its count is right; Only mine keeps to what the
       person deleted.
     - **Tests:** `gaps.test.ts` holds cases 1 (with money and the bin; Messages' `inbox.use` comes with stage 3), 6
       (the records group) and 7; `visibility.test.ts` the staff view-as, a teammate view, a money member and a
       private deal; the rest arrive with their kinds. `limits.test.ts` checks an answer past the `q` it echoes back
       to the person who typed it, and that the winners' facts are read after every kind's candidates.
       `search-guards.test.ts` counts each route's own limit (90 and 60), forces a failure through a database that
       fails any statement carrying the typed words, and captures the API's log. Not yet, by stage: the `searchWords` half of
       `fold.test.ts` (5), `route: false` and the contributor's failure (4a), the phone contract (3).

3. **Search 3: the remaining kinds, and what results open onto.**
   - Ships: Messages and Spam, Calendar, Tasks, Notes, file names, Forms and their answers, and Archived, each with its
     gate and shape rules; `activity.get`; `task.list`'s `taskId`; `conversation.thread`'s `upTo`; both queries in the
     phone contract; and, before Notes can be searched, `call_suggestion.record` sealing a private record's meeting
     summary note (decision 38). The load check runs, and its numbers are recorded. Still nothing on screen.
   - Files: `packages/core/src/search/server/kinds/{messages,calendar,tasks,notes,files,forms}.ts`,
     `packages/core/src/search/server/run.ts`, `packages/core/src/commands/call-suggestion.ts`,
     `apps/worker/test/calendar-connections.test.ts` (where the summary note is tested today: a tour on a private deal
     gives a sealed note),
     `packages/core/src/queries/activity.get.ts`,
     `packages/core/src/schemas/task.ts`, `packages/core/src/queries/task.list.ts`, `packages/core/src/queries/inbox.ts`,
     `packages/core/src/schemas/message.ts`, `packages/core/src/queries/index.ts`, `packages/api-client/src/schema.d.ts`,
     `packages/core/test/search/gaps.test.ts`, `packages/core/test/search/visibility.test.ts`,
     `packages/core/test/search/limits.test.ts`, `packages/core/test/search/kinds.test.ts`,
     `packages/core/test/search/plans.test.ts`, `packages/core/test/mobile-contract.test.ts`,
     `packages/core/test/contract/mobile-contract.json`, `packages/core/test/commands.test.ts`,
     `scripts/search-load.mjs`.
   - Docs: docs/search.md (each kind, its gate and window; the load numbers).
   - **Built** (2026-10-20). No migration. `pnpm openapi` adds `activity.get`, `task.list`'s `taskId` and
     `conversation.thread`'s `upTo` to `packages/api-client`; the phone contract records both search queries. What
     changed while building:
     - **More files than listed:** Spam is `spamSearcher` in `kinds/messages.ts`, the same reads in the Spam folder;
       `search/kinds.ts` (the new kinds, and `picked`: Spam is searched only when a search names it, and is no
       chip), `search/words.ts` (`messageTitle`, `threadTitle`, `callTitle`), `search/href.ts` (a form's own page),
       `search/rank.ts` (`ranksLater`), `search/lines.ts` (an answer by someone with no name on file),
       `search/server/hit.ts` (`stretchSnippet`), `search/server/sql.ts` (the windows,
       `stretchOf`, `isoMicros`), `schemas/activity.ts` (`activity.get`'s shapes), `queries/timeline.list.ts`
       (`activity.get` shares its row and its columns), `queries/search.ts` (the descriptions), and
       `test/search/{helpers,opens,kinds.unit,rank,href,lines}.test.ts`: `moreOfTheBoards` holds Search 3's rows, and
       `opens.test.ts` checks what results open onto (`activity.get`, `taskId`, `upTo`).
     - **The windows** (`windowed` in `sql.ts`) are one statement each: a `win` read counts the newest rows' times, one
       more than the window holds, through the (business, time) btree, and the matching rows are read over the range
       it found, its edge reaching them as an init plan (The load check, below). A window ends at the time of the first row it couldn't hold, and keeps only rows newer than
       that, so the rows sharing it (a form response's answers, which share `answered_at`) are left whole for the next
       window, and no window holds more than its count. **`before` is inclusive** (`<=`, not the sketches' `<`) for
       the same reason: Look further back passes `searchedBack` and reads what's at or before it. `searchedBack`
       is ISO to the microsecond, worked out in SQL (a JavaScript date would cut it to the millisecond and skip rows
       inside it), and null when the window looked at everything. Notes and answers are bounded by count alone, as
       How it works, 3 gives them; calls take the messages' days, as sketch (iv) does. A kind with several windows
       (Messages) is complete only when all of them are, and says the latest `searchedBack`. The one degenerate case:
       more rows than a window holds all at one moment would leave every later window empty; nothing writes that.
     - **Messages:** each read joins the thread's names itself (`THREAD_NAMES`, customers held to `LIVE_PERSON`), so
       there is no separate display statement; only a whole thread's count of messages ("14 messages") is read for the
       winners. Who a thread is with is folded (`$folds`), beside one lower-cased arm over names, counterpart and
       preview together. A thread found by its last preview alone is tier 4 (`message`), words in content as the tier
       table says, not tier 3. A call in a thread merges into the thread's row; one with no thread opens its customer's
       page, and is dropped with no customer. A campaign or automated send gets the badge `automated` (new; old
       builds skip it), which `ranksLater` puts after one-to-one sends; times in a result's link are to the
       microsecond, so `conversation.thread`'s `upTo` includes the message. The exact counterpart read leaves a
       thread that never had a message to core: asking for `last_message_at is not null` in SQL sent the planner down
       the recency index rather than `conversations_one_per_line`. Who a thread or a note is on is read by key in
       `offset 0` laterals, each only for a thread of its channel.
     - **Snippets of long text** are cut in SQL around the first typed word (`stretchOf`: 320 characters from 100
       before), then marked and cut again in core (`stretchSnippet`), with "…" where either cut fell.
     - **Calendar:** the place is matched on `location->>'address'` and its postal code, not `location::text`, whose
       keys ("kind", "zoom", "record") would match anything. The notes are tier 4 (`note`), as the tier table says,
       not tier 3 as the sketch has it; an attendee's name is tier 3 (`customer`). The title is folded, and who's
       coming read, in one lateral, so the plan folds a title once.
     - **Notes:** a note's title is its first line, cut at 80 characters ("Note on Dana Smith · Oct 18" is its line);
       found by who it's on, its opening is the snippet. A note on a customer who isn't live, and so on nothing that
       opens, is dropped.
     - **Files and forms:** a file whose customer isn't live is dropped, as it has nowhere to open. Answers are one row
       a response through `distinct on`, its best answer the one whose words matched, else its first that says
       something; the window's answers are read in a subquery ordered as `form_answers_recent_idx` is, so the planner
       reads that index, bounded by the edge, rather than the business's every answer. Only mine keeps forms named by
       their maker and leaves answers out. Archived threads and forms go under Archived, and the Archived page reads
       them.
     - **`activity.get`** answers `{ activity }`, a timeline entry as `timeline.list` shows it, with `RECORD_READS`.
     - **Tests:** `gaps.test.ts` holds all eight cases (case 1 now with Messages and Spam, case 8 through
       `call_suggestion.record` as the worker runs it, then `call_suggestion.decide` as a person, and a meeting on a
       record in the bin); `apps/worker/test/calendar-connections.test.ts` checks a tour on a private deal leaves a
       sealed note. `kinds.test.ts` holds Only mine for each new kind, a windowed kind's count capped at 100, names
       folded in Notes, Calendar and Forms, and a response whose customer was merged away. Campaign sends are ranked
       in `rank.test.ts` only: a fixture would need a campaign and its recipients. `search.kind`'s cursors are walked
       for contacts, as before.
     - **After review** (2026-10-20), what changed:
       - **A task approved from a call** on a private record goes on the record too (`call_suggestion.decide` passes
         it to `task.create`), so it is sealed with the deal as the summary note is. Decision 38 asked only for the
         note, but the task is written from the same private call, and without the record it was every member's, and
         found through Tasks. It goes to the host only while the host is on the record (`private.user_sees_record`),
         and otherwise is left unassigned, since `tasks_sealed_assignee` refuses a sealed task to someone off it.
       - **A record in the Deleted bin** keeps its appointments, and reads for nobody, the worker included, so passing
         it to `activity.log` or `task.create` refused the whole review as gone. Both now pass the record only while it
         reads; otherwise the note and the task go on the customer alone. A private record is never binned
         (`bin_record_private`), but a sealed appointment whose record doesn't read leaves the note off (the summary
         stays on the transcript) and refuses the task, rather than write a private deal's words unsealed.
       - **Names fold everywhere** a row is found by who it's on (decision 23): Notes' and Forms' decision-34 arms and
         Calendar's attendees match the folded name against `$folds`, as Contacts and Messages do. Calendar folds who's
         coming once a row in its lateral (`fnames`).
       - **Messages match a thread's counterpart** only where it's something a person types: a text's number (its
         digits too) or an email's address. A chat's, the portal's and Meta's counterparts are keys of ours
         ("portal:<id>"), whose letters and digits matched by chance and came back as a Phone match.
       - **Forms:** an answer's words are its choices' labels, else its typed words, as `form.response` reads them
         (`forms/submit.ts` writes a choice's labels into `text_value` too, so they showed twice). A response found by
         who answered opens on its form's first question, by the question's place in the version answered
         (`jsonb_path_query(definition, '$.pages[*].questions[*].id') with ordinality`), since question ids are random.
         Who answered is the live customer (`LIVE_PERSON`): a response whose customer was merged away, deleted or
         erased since has no contact and isn't badged anonymous, and its line says "Answered by someone with no name
         on file" (new, in `search/lines.ts`), not "someone who didn't say who".
       - **Notes:** a call or visit logged with no words matched null, not false, and `desc` put it first, so wordless
         lines found by who they're on could crowd out notes whose words matched; `in_words` is now
         `coalesce(…, false)`.
       - **The Archived page** says how far back its threads window looked (`complete`, `searchedBack`), and its Look
         further back reads on only in the kinds with a window, since the rest showed everything the first time.
       - **The load check** refuses to start unless Supabase (whose Auth it makes its people in) and every database it
         uses are on this machine: a value already in the shell wins over `.env.local`.
     - **The load check** (`scripts/search-load.mjs`) loads core through the API's `tsx`, refuses to start unless
       Supabase and every database it uses are on this machine, and narrows the inbox for its third person after the
       owner's and the member's runs. The numbers are in docs/search.md, measured again after the review: the Search
       page's p95 is 1.4 to 1.6 s, inside its 2 s, but **the box's p95 is 590 to 680 ms, past the 400 ms this plan asks
       for**, on a business 15 times the busiest on hosted. Contacts (Search 2's statement over every customer of the business) are about 200 ms of it
       at 20,000 customers; no search timed out or was skipped. **This needs Chris's decision** before the screens
       ship (Search 6): either the box's target moves to what was measured (How it works, 6, Tests by package,
       docs/search.md and `QUICK_P95_MS` then change together), or Contacts gets faster first. The Not yet entry
       (revisit when the box's p95 passes 1 s on a real business) is a different trigger and doesn't stand in for the
       400 ms; until Chris decides, the script exits 1 by design. The check found two real faults, both fixed: under
       row security a window's edge reached the matching rows' index scan only as a bare parameter (`coalesce` and
       `greatest` count as leaky, so the edge was a filter over all 300,000 messages, 300 to 600 ms; now an init
       plan, about 100 ms, and `plans.test.ts` pins the index condition), and joining a thread's or a note's customer
       scanned every customer, so each is now a lookup by key (`offset 0` laterals). Narrowing the inbox of a business
       this size repaints for about two minutes, past a request's 15-second statement ceiling, so the script switches
       it on directly, as is done by hand.

4. **Search 4a: what core builds first, so add-ons can answer searches.** Core's own step, as CLAUDE.md asks for
   anything an add-on needs that core lacks (the Sales Coach plan's "Round 0: what core builds first" is the pattern),
   with no add-on touched.
   - Ships: the manifest's `search` declaration and its checks (`manifestIssues`, `addonSearchIssues`, `route: false`
     required); `QueryDef.route` and `registerOperations` skipping such a query; `executeQueryWithin`; core gathering
     contributors through `step`, each failure kept to its own groups and logged by SQLSTATE at most; `covers`
     honoured only when a contributor ran; the generator's commented stub. Its contract tests run on a test-only
     add-on, so nothing real is needed yet.
   - Files: `packages/core/src/addons/manifest.ts`, `packages/core/src/kernel/types.ts`,
     `packages/core/src/kernel/execute.ts`, `packages/core/src/search/addon.ts`,
     `packages/core/src/search/server/addons.ts`, `apps/api/src/routes.ts`, `apps/api/test/healthz.test.ts`,
     `addons/_template/core/manifest.ts.tpl`, `scripts/addon-new.mjs`,
     `packages/core/test/addons/search-contract.test.ts`, `packages/core/test/execute-query-within.test.ts` (new).
   - Docs: docs/addon-architecture.md ("Search" under "The pieces": the declaration, `route: false`, a failure kept to
     its own groups), docs/search.md.

   **Search 4b: Real Estate answers.**
   - Ships: `realestate.search` (Listings, Deals, Homes, and Properties no listing covers), `route: false`, and its
     manifest declaration. The phone's offline Real Estate search comes in stage 8, with the copy-hit shape it needs.
   - Files: `packages/core/src/addons/realestate/manifest.ts`, `packages/core/src/addons/realestate/ops/search.ts`,
     `packages/core/src/addons/realestate/server.ts`, `packages/core/test/addons/realestate-search.test.ts`. No change
     to `packages/api-client`: the query is never a route.
   - Docs: docs/realestate.md (what search finds), docs/search.md.

5. **Search 5: words inside files.**
   - Ships: Migration B; `file.save_text`; the worker's `file.text` job with the PDF, text, CSV, Word and Excel readers
     behind their caps; the catch-up sweep; the Files searcher's words inside, with the page.
   - Files: `supabase/migrations/<version>_file_texts.sql`, `packages/db/src/schema/index.ts`,
     `packages/core/src/commands/file-text.ts`, `packages/core/src/commands/index.ts`,
     `packages/core/src/schemas/file.ts`, `packages/core/src/search/server/kinds/files.ts`,
     `apps/worker/src/files/file-text.ts`, `apps/worker/src/files/office-text.ts`,
     `apps/worker/src/files/document-text.ts` (export its tidying), `apps/worker/src/handlers/index.ts`,
     `apps/worker/src/scheduled.ts`, `apps/worker/package.json` (`files:read-backlog`),
     `apps/worker/test/files/office-text.test.ts`, `apps/worker/test/files/file-text.test.ts`,
     `packages/db/test/search-rls.test.ts`, `packages/db/test/sync-secrets.test.ts`,
     `packages/core/src/search/probes.ts` (`searchWords`), `packages/core/test/search/fold.test.ts` (the
     `searchWords` half), `packages/core/test/commands.test.ts`, `packages/core/test/search/kinds.test.ts`.
   - Docs: docs/operations.md (the file reader, its caps, the sweep and `files:read-backlog`), docs/deleting.md (a
     file's words follow it), docs/search.md.

6. **Search 6: Settings search, on the web and the phone together.**
   - Ships: the Settings menu's pages and every setting in core's catalogue; `searchSettings` and `settingValueText`;
     the web's Search settings box with jump-and-ring; `SetRow`, `Block` and `SettingAnchor` with their anchors; the
     notification rows in core; the phone's Settings search opening in place or on the web; the Assistant map's missing
     settings areas; the staleness test. The first thing people see.
   - Files: `packages/core/src/settings/{pages,catalog,search,words}.ts`,
     `packages/core/src/account/notification-rows.ts`, `packages/core/src/assistant/settings-map.ts`,
     `packages/core/src/index.ts`, `apps/web/src/components/settings/settings-nav.tsx`,
     `apps/web/src/components/settings/settings-search.tsx`, `apps/web/src/components/settings/use-setting-highlight.ts`,
     `apps/web/src/components/settings/set-row.tsx`, `apps/web/src/components/settings/setting-anchor.tsx`, the
     settings pages under `apps/web/src/components/settings/` and `apps/web/src/app/app/w/[workspaceId]/settings/`
     (their `setting=` props), `apps/web/src/components/settings/automations/{automations-page,panels}.tsx`,
     `apps/web/src/components/settings/notifications-section.tsx`, `apps/mobile/src/push/switches.ts`,
     `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/settings/index.tsx`,
     `apps/mobile/src/settings/use-setting-flash.ts`, `apps/mobile/src/components/shell/list.tsx` (`ListRow`),
     `packages/core/test/settings-catalog.test.ts`, `packages/core/test/settings-map.test.ts`,
     `packages/core/test/web-boundaries.test.ts`, `apps/web/e2e/settings-search.spec.ts`. The phone part ships as an
     over-the-air update in the same push.
   - Docs: docs/search.md (the catalogue is the one list, kept honest by its test; anchors that emails link to keep
     their ids), README.md's Settings section.
   - **Built** (2026-10-20). No migration, no API change (nothing is asked of the server), so `pnpm openapi` has nothing
     to do. What changed while building:
     - **An entry carries more:** `key`, `kind`, `page`, `addon`, `section`, `label`, `words`, `anchor`, `open`, `path`,
       `needs`, `feature`, `only`, `phone` and `value`. `kind` is `page`, `setting`, `phone` or `addon`: each Settings
       page is an entry itself (`page.texting`, with its own `PAGE_WORDS` seeded from LOOK_ALIKES), so a page is found
       by its name without every row on it; `phone` entries are the phone's own settings (Face ID, Businesses on this phone,
       Documents on mobile data, Changes on this phone, My safety), which only `surface: 'phone'` lists; `addon` entries
       carry their add-on and are grouped under its name. `path` is where it lives under /app/w/<business>/ (an add-on's
       own page, or Calendars' Services, Resources, Territories and Booking site, which are whole pages with no anchor).
       Every typed word has to be in the entry, its section, or the page and group around it, and at least one in the
       entry itself; a typo gets the close-match check (every typed word within its allowance of a word). Every
       apostrophe reads as one, since the catalogue is written with curly ones and a keyboard types straight ones ("can't
       answer" finds "Questions the AI can’t answer"), and a typed hyphen splits words ("opt-out" finds "opt out").
       What's typed is cut at 100 characters, and search's close check (`wordIsClose`, now in `search/close.ts` for the
       names' close matches too) turns away words whose lengths differ by more than the allowance before working out
       the distance, so a long pasted word stays cheap on every keystroke.
     - **`only` on New support tickets and Daily agency digest:** the notification rows' `staffOnly` and `agencyOnly`
       carry onto their entries, and `searchSettings` takes `staff` and `agency` and lists them only when they hold,
       as both apps' Notifications show them. Left out, neither is listed. The web's settings layout passes them from
       `platform.me` (`getPlatformMe`, fetched once per request with the Account page) and the account
       (`managesAnAgency`, moved into `account/notification-rows.ts` so the web's Account page, the phone's
       Notifications and settings search decide it once); the phone passes what it already knows (`useKeptStaff`),
       so it works with no signal.
     - **`searchSettings(q, { permissions, addons, surface })` takes `addons: null` on the phone,** which has no list of
       what runs with no signal: a part of core some add-ons use shows when the person holds a permission of an add-on
       that uses it (`coreFeatureHeld`), as the phone's Main offer row already decides, and an add-on's own entries
       likewise. `settingsPageShown` and `settingsGroupsFor` are the one gate, which the web's menu uses too. Beside it:
       `settingHref`, `settingPhoneTarget`, `settingsByPage` (the menu's order, add-ons last), `settingsCount`, and
       `settingsSearchGroup`, the main search's Settings group for `dropdownOf` (its line is `hitLines`' "Settings ›
       Texting & calls · 9:00 PM to 8:00 AM"; a setting's id is its catalogue key, since the group never leaves the
       device). It leaves out a setting that's only close to what was typed, and is null when nothing else matched:
       the main search's close matches are names (decision 26), and a typo near some setting's word mustn't hide them
       or set `settingsMatched`. `dropdownOf` likewise counts only a real setting match as spelled right.
     - **An Automations row opens ringed on the page (`#automation-<id>`), not with `?adjust=`:** its switch is on the
       row, and most rows have no Adjust sheet. The Adjust fields (a short list of 11, "Gone quiet after" among them)
       open their automation's sheet with `?adjust=<id>` and ring the field inside it. The sheet follows the address's
       `?adjust=` itself (`useSearchParams`, which `closeAdjust`'s `replaceState` updates), not the page's
       `initialAdjust`, which keeps its value after the sheet closes: so the jump works from the Automations page
       itself, again after the sheet was closed, and a jump to a plain row shuts it. Their section is the automation's
       name ("Gone quiet after · Stale opportunities").
     - **Marking a setting:** `<SetRow setting>`, `<Block setting>` and the local sections' `setting` on Usage, Email,
       Payments and Partners; `settingAttrs(key)` spread on a card, where `<SettingAnchor>` around it would ring wider
       than a `max-w` card; and `<SettingAnchor>` (with `as` and `row`) only for what has no element of its own, the
       Workspace form's fields and My calendar's sections. Ids that were already there and linked stay as written
       (`appearance`, `menu`, `notifications`, `my-cell`, `delete-account`, `passkeys`, `google`, `rcs`, `founding`,
       `your-page`, `logo-and-colour`, `delete-workspace`). The test accepts each of these forms, and counts the
       anchor's literal id too, so a key marked twice or not at all fails.
     - **The ring** is the Add-ons page's `ring-2 ring-accent` on a card, and on a row it also fills it
       (`bg-accent-soft`, as board 6 draws it). `quiet-hours` moved from the Texting rules card to the Quiet hours row,
       where board 6 rings it; Automations' "Edit quiet hours" link still lands there.
     - **Ids changed or not marked:** the Workspace page's Getting started guide switch is `#workspace-getting-started`
       now, since Home's card already is `#getting-started` (Get help links there). Email's domain card repeats per
       domain, so only the first is `email.own_domain`, and "Another domain" and "Receive mail here too" are words of
       it. Partner payouts' card is marked only once payouts are open, when there is something to set. Migrations'
       Connect a CRM is in the page's words, since it's a header button. Support access (`settings/support-access`)
       isn't in the Settings menu, so it isn't in the catalogue.
     - **Notification rows** carry their `key` (`notifications.urgent`) and both the phone's short `detail` and the
       web's `description`; `KeyedNotificationRow` keeps the key's type so a screen can mark the row. The web's
       `NotificationPrefs` is core's `EmailSwitches`; `push/switches.ts` re-exports the rows for the phone's imports.
     - **The phone:** the results are their own component, `apps/mobile/src/settings/settings-search.tsx`, so they're
       tested without the whole Settings screen; `Screen` gained `scrollRef` for the flash; Notifications' rows flash
       too (`useFlashRow`). The flash scrolls with `measureLayout` against the ScrollView's `getInnerViewRef()`, which
       React Native has but its types don't declare yet. Values (quiet hours, business hours) show on the phone's rows
       and in the main search's group; the web's menu shows each setting's section, as board 6 does.
     - **More files than listed:** `packages/core/src/settings/index.ts`, the Partners page's `settings-page.tsx` and
       `payouts-section.tsx`, `apps/mobile/src/components/shell/screen.tsx`,
       `apps/mobile/src/settings/settings-search.tsx`, `apps/mobile/src/settings/__tests__/settings-search.test.tsx`
       (Tests by package's Settings search test), the phone's Settings → Notifications screen,
       `apps/web/src/lib/api/server.ts` (`getPlatformMe`), the settings layout, `packages/core/src/search/close.ts` and
       `dropdown.ts` with `test/search/dropdown.test.ts`, and `apps/worker/src/assistant/tools-settings.ts`: `get_settings` reads every area, so the four new ones read
       `main_offer.get`, `meta_account.list`, `bin.list` (names and dates only) and `partners.settings`. No Assistant
       tool changes any of them; each has a handover.
     - **The web's box:** in the side menu it stays at the top while the menu scrolls under it (`sticky`), so the menu's
       scroll to the page you're on never hides it. ↵ with no row picked opens the best match (a setting, or a page
       found by its name), not the first row in menu order.
     - **`settings-search.spec.ts`** imports core with `await import('@hfos/core')`, as the consent spec does, and also
       checks ↓ ↵, ↵ alone opening the best match, Esc, an Adjust field opened again after its sheet was closed, and a
       member's own Appearance.

7. **Search 7: the web's Search page and what it opens, built but not linked.**
   - Ships: `/search#q=…` by address (the frame from the server, the answer asked from the browser with what's typed
     in the fragment only; the kinds list, cards, one kind with its table, sort, Leads/Clients, duplicates and Show 50
     more, the windows, Spam, the empty, close-match and archived states decided after the Settings group, the
     Settings group); the dropdown components ready but not mounted, with recent searches kept per person; every new
     deep link, `customers#add=person&name=` included; `isMac` in `lib/keys.ts`. The sidebar box is unchanged.
   - Files: `apps/web/src/app/app/w/[workspaceId]/search/page.tsx`,
     `apps/web/src/components/search/{search-provider,search-box,use-search,panel,highlight,search-page,kind-page}.tsx`,
     `apps/web/src/components/search/rows/*.tsx`, `apps/web/src/lib/keys.ts`,
     `apps/web/src/components/assistant/assistant-provider.tsx`, `apps/web/src/components/inbox/conversation-view.tsx`, `apps/web/src/components/inbox/hooks.ts`,
     `apps/web/src/app/app/w/[workspaceId]/tasks/page.tsx`, `apps/web/src/components/tasks/tasks-page.tsx`,
     `apps/web/src/app/app/w/[workspaceId]/forms/[formId]/answers/[responseId]/page.tsx`,
     `apps/web/src/app/app/w/[workspaceId]/forms/[formId]/page.tsx`, `apps/web/src/components/forms/responses.tsx`,
     `apps/web/src/components/crm/record-page.tsx`, `apps/web/src/components/crm/merge-dialog.tsx`,
     `apps/web/src/components/crm/customers-list.tsx`, `apps/web/src/components/bin/deleted-bin.tsx`,
     `apps/web/src/components/shell/workspace-main.tsx`, `apps/web/e2e/search.spec.ts` (the page by address and the
     deep links).
   - Docs: docs/search.md (the screens and where each result opens).
   - **Built** (2026-10-20). No migration, and no change to the API's shapes (`pnpm openapi` has nothing to do). The
     page answers at `/search#q=…`, linked from nowhere until Search 9; `search.spec.ts` checks it by its address, that
     no request to the web's own server carries what was typed, Sort, Leads and Clients by their rows, the whole
     "Nothing in …" line for an owner and a member, and every new deep link. What changed while building:
     - **More files than listed:** `components/search/rows/parts.tsx` (what a row is made of: its picture, marked title,
       badges, core's grey line and chips) and `rows/index.tsx` (`rowView` by kind, the dropdown's and the page's row,
       `PageRow`); `components/timeline/timeline.tsx`, where `?activity=` opens its dialog, since the lead and the
       record pages have timelines of their own besides `record-page.tsx`'s; `components/files/file-grid.tsx`, where
       `?file=&page=` rings the card and a PDF opens at the page, for the same three pages;
       `components/forms/editor.tsx` and `results.tsx`, which open on Results and One at a time so `responses.tsx` can
       `show` the response; `components/shell/user-menu.tsx` (signing out clears recent searches);
       `e2e/forms.ts` (`formWithAnswers` also answers the owner's email); and core's `search/words.ts`: `page`,
       `kindsOfResults`, `call`, `text`, `sort`, `columns`, `twoShareEmail` (a pair sharing an email had no words),
       `badgeLabel`, so both apps name a badge alike (a lead and a client in `CONTACTS_WORDS`' words), and `kindNoun`,
       so one kind's counts read in its own nouns: "1 contact named “dana”", "2 things in the Deleted bin for “tom
       becnel”", "Show 1 more contact" (`named`, `kindFor`, `showMore` and `searchedBack` take the kind). Leads and
       Clients are `CONTACTS_WORDS`' own, as "Web: one kind" says; Search 8's phone, built beside this, gave
       `SEARCH_WORDS` a copy of them (`standing`), which the merge should point at `CONTACTS_WORDS` too.
       `use-search` is a `.ts`, as "Screens" names it.
     - **Close matches have a page:** `search.kind` with `close` was refused as `search_kind_gone` (the close searcher
       read `close` as no kinds picked), yet everything's answer has a `close` group, which the kinds list, Show more
       and the box's See all open. Now `close` reads every kind's names there (`kinds/close.ts`), in close matches' own
       order rather than re-ranked (all are tier 5, so time would decide; `run.ts`); and `search.everything` answers
       the box's Close matches chip (`kinds: ['close']`), which found nothing before. Both are in `kinds.test.ts`.
     - **Not changed:** `shell/workspace-main.tsx`: `/search` already takes the ordinary padding, its default.
     - **The route asks for the business, never for anything typed:** "Web: the Search page" has it ask the API for
       nothing, but the Settings group needs the business's name, clock and settings and the staff and agency flags,
       and no `SearchProvider` is in the layout yet to hand them down. So the route asks `workspace.get`, `account.me`
       and `platform.me` itself, until Search 9's provider supplies them (then the page should take them from it).
     - **Where the pages read their part of the address:** the form page reads `?response=` from its `searchParams`
       (an id, never what was typed) and hands it down, rather than off `window.location`, because the editor has to
       open on Results first; the Tasks page reads `?task=` the same way, asks `task.list` with `taskId`, scope and
       status `all`, and says so when a task asked for is gone (only then: not on an ordinary visit, nor when its
       dialog closes). The thread (`useOpenedMessage`, in `inbox/hooks.ts`), the timeline, the Files grid, the record
       page (`compose`, `merge`) and the Deleted bin follow `useSearchParams`, which needs no Suspense boundary on
       pages rendered per request, as all of these are; Contacts reads `#add=` when it opens and on `hashchange`. So a
       result for the page already open, as the box will offer on every page, works too; each ask is acted on once,
       not again as the page refreshes. A note, Text, Merge and Add a contact take theirs off the address once open, and a task once its dialog
       closes.
     - **A thread opened at a message** reads up to it (`upTo`, a page) and everything after it (`since`, 100 at a
       time, paging back to it, at most 10 pages), so nothing between it and the newest page is missing; past 1,000
       newer messages the rest waits until the thread is opened from the inbox. The message or call is found by its
       card's own test id (`message-<id>`, `call-<id>`), so `message-log.tsx` is unchanged.
     - **One kind:** `before` is in the fragment as planned; Look further back adds the older window's results under
       those already shown, while a reload of that address shows that window alone. Archived offers it too, for its
       threads, whenever the server says it stopped short. Sort and Leads/Clients are for contacts, as board 3 draws
       them; a refusal that can't pass (`search_kind_not_allowed`, `search_kind_gone`) shows its words without Try
       again. Show 50 more drops a page that lands after the search changed, and adds that page's duplicate pairs to
       the banners. Settings' own page is worked out on the device, since `search.kind` never serves a device kind.
     - **The page's layout:** the wide cards (contacts, companies, leads, money, messages, a business's own kinds,
       add-ons) come first and the rest sit in a grid of small ones, as board 2 draws them, each in core's order. The
       kinds list also lists Archived and the Deleted bin when they found something, opening their pages, scrolls
       sideways on a phone, and leaves out "Nothing in …" when nothing at all was found (the empty state says it). An
       invoice's late, due and paid badges aren't drawn: its line already says "6 days overdue" or "Paid Sep 30". The
       Deleted bin, which answers apart from the groups, is never named in "Nothing in …" when it found something,
       and a bin that ran out of time gets its own line and Try again. What a card's Show more read belongs to the
       answer it was read for, so a new search, or Include archived, never shows the last one's rows.
     - **The box:** a chip asks for its kind alone, and the chips keep everything's counts meanwhile; ← and → move
       over the chips only once a row is picked, since before that they move the caret, as in any box. Already on the
       page a link names (the Search page, or Contacts for Add a contact), the dropdown sets `location.hash`, since a
       router push to the same page fires no `hashchange`. Ask HandsFreeOS shows only while the Assistant is on for the person; Call opens the dialer when
       calls are on in this browser, else a `tel:` link.
     - **Recent searches** are kept under the signed-in person (`signedInAs`), even while viewing as a teammate; the
       Search page keeps them too (on ↵ and on opening a result), and removes anyone else's when it opens, as the
       provider does. Search 9's layout passes the signed-in person's id to `SearchProvider` the same way.

8. **Search 8: the phone's search, built but not linked.**
   - Ships: the full-screen search route with online answers, the phone's own rows while waiting, the offline search
     with the board's line (notes and tasks only on a customer in the copy), one kind with Leads/Clients and the
     banner, the route-map rules (the search rule reading the fragment), recent searches in the encrypted database,
     `FilterChip` in `components/ui`, and Real Estate's offline search: `PhoneAddon` gains `search` (it has only
     `addonId`, `permission` and More today, `apps/mobile/src/addons/registry.ts:13-19`), which needs the copy-hit
     shape `searchCopy` brings in this stage. Reachable only from a link (a web `/search#q=…` link opens it).
     Delivered as an over-the-air update.
   - Files: `apps/mobile/src/app/app/w/[workspaceId]/search.tsx`, `apps/mobile/src/app/app/w/[workspaceId]/_layout.tsx`,
     `apps/mobile/src/search/{use-search,copy-sql,recent}.ts`, `apps/mobile/src/search/rows.tsx`,
     `apps/mobile/src/components/ui/filter-chip.tsx`, `apps/mobile/src/changes/tables.ts`,
     `apps/mobile/src/links/route-map.ts`, `apps/mobile/src/sync/compute.ts`, `packages/core/src/search/copy.ts`,
     `packages/core/src/crm/search-text.ts`, `packages/core/test/search/copy.test.ts`,
     `apps/mobile/src/addons/registry.ts`, `apps/mobile/src/addons/realestate/search.ts`,
     `apps/mobile/src/search/__tests__/search-screen.test.tsx`, `apps/mobile/src/links/__tests__/route-map.test.ts`.
   - Docs: docs/search.md (the phone, online and offline); apps/sync/README.md gets one line saying search reads the
     copy as it is.

9. **Search 9: switch it on, on the web and the phone in one push.**
   - Ships: the sidebar box becomes Search everything with its dropdown and ⌘K; the phone-width header opens `/search`
     outside the Inbox; the phone's app bar gets its Search button, and Contacts and Inbox get "Search everything for
     “q”"; the Assistant's map of the app (`places-map.ts:66,139,209,540,602`, `PHONE_APP` at `:618-623`) and the
     store privacy answers say what search does now. One commit holds every entry point, so a revert takes them all.
     The web ships on Vercel and the phone by over-the-air update once CI passes on the combined tree.
   - Words that become untrue the moment search shows archived records, reworded once, in core: archived means "hidden
     from lists, found in search under Archived" (`archivedNotice`, `crm/record-words.ts:156-165`; the
     `custom_record.archive` description, `commands/custom-record.ts:484`, which reaches the OpenAPI client, so
     `pnpm openapi`; the Assistant's `archive_or_restore` tool, `assistant/tools-inbox-crm.ts:97`), and a hidden menu
     place "still opens from a link", because menu places aren't a kind yet (`hiddenHint`, `account/menu.ts:651`; the
     worker's note, `apps/worker/src/assistant/tools-extra.ts:1055`; the comment at `mobile-shell.tsx:50-51`;
     `README.md:195`). The web's hard-coded copies move onto core's words: the archived notice in
     `relationships/custom-record-page.tsx:231` and its archive and restore lines at `:546-547`, and
     `crm/archive-dialog.tsx:95`. `crm-words.test.ts:157-160` follows.
   - Files: `apps/web/src/components/shell/sidebar.tsx`, `apps/web/src/components/shell/search-field.tsx` (deleted),
     `apps/web/src/components/shell/mobile-shell.tsx`, `apps/web/src/app/app/w/[workspaceId]/layout.tsx`,
     `apps/web/src/components/assistant/ask-button.tsx`, `apps/mobile/src/components/shell/app-bar.tsx`,
     `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/customers.tsx`,
     `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/inbox.tsx`, `packages/core/src/assistant/places-map.ts`,
     `packages/core/src/crm/record-words.ts`, `packages/core/src/commands/custom-record.ts`,
     `packages/core/src/assistant/tools-inbox-crm.ts`, `packages/core/src/account/menu.ts`,
     `apps/worker/src/assistant/tools-extra.ts`, `apps/web/src/components/relationships/custom-record-page.tsx`,
     `apps/web/src/components/crm/archive-dialog.tsx`, `packages/core/test/crm-words.test.ts`,
     `packages/api-client/src/schema.d.ts`, `apps/mobile/store/privacy-app-store.md`,
     `apps/mobile/store/privacy-play.md`, `apps/web/e2e/crm.spec.ts`, `apps/web/e2e/search.spec.ts`,
     `apps/web/e2e/search.mobile.spec.ts`, `apps/mobile/maestro/search.yaml`, `README.md`.
   - The privacy answers stay "No", with the reason: "With signal, what you type is sent to HandsFreeOS only to answer
     that search, and is never kept or logged. With no signal, search is worked out on the phone. Recent searches stay
     on the phone."
   - Docs: README.md's shell section (the box is Search everything; a hidden place is still reached by its links, since
     menu places aren't a kind yet, `README.md:195`).

10. **Search 10: docs.**
    - Ships: docs/search.md complete (where things are, the pieces, "Rules worth knowing before changing anything", the
      measured costs and load-check numbers as the point to revisit the finder, Not yet); in CLAUDE.md, a Read first
      row ("Search everything, and settings search: `docs/search.md`, then this plan"), `design/search` added to the
      Screen designs row, and one Add-ons bullet: an add-on answers searches through `manifest.search`, a
      `defineAddonQuery` marked `route: false` that core runs inside `search.everything`, its failures kept to its own
      groups; docs/addon-readiness-audit.md's federated search line marked built; docs/operations.md (the search rate
      limits, the slot gate and the budgets; no extension is installed); this plan marked built, with each stage's
      differences.
    - Files: `docs/search.md`, `CLAUDE.md`, `docs/addon-readiness-audit.md`, `docs/operations.md`,
      `HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md`.

## Answered

The research's open questions, and where each is settled:

1. Should a narrowed member, or someone without Use the inbox, find words from threads they can't open, through
   timeline copies? No (decisions 5 and 6).
2. Scans, photos, voice notes and message attachments? Not read this release (decision 7).
3. Words inside what's in the Deleted bin? No: names only, for `records.delete` (decision 8).
4. Spam and Other mail? Other mail labelled, Spam on its own (decision 9).
5. The phone with no signal, and its privacy answers? A partial search that says so; "not collected" kept, because
   nothing is kept or logged (decisions 10 and 11, stage 9).
6. Business settings on the phone? Listed, opening the web (decision 12).
7. Calendar builder and AI teammate sections? Not this release (decision 13).
8. People add-ons keep apart from Contacts (open-house visitors, showing agents, Facebook profiles)? Not this release;
   when they come, only inside that add-on's own group (Not yet).
9. Raw meeting transcripts? Only the summary (decision 15).
10. Recent searches, rollout, boards first? On each device; everyone at once; the boards are approved (decision 17).
11. A universal search index? No, and no text indexes either: row security can't use them (decisions 18 and 19).
12. Which finished things show? In their kinds, marked (decision 25).
13. A records-only reader without the add-on's permission? Finds the record through core's group, opening the record
    page (Add-ons answer searches).

## Not yet

- **A faster path for very large businesses**: a security-definer finder that returns candidate ids, re-checked by row
  security (`id = any($ids)` on the primary key), with expression GIN indexes behind it. Faster, not safer: it must copy
  visibility exactly or it tells a person which hidden rows hold a word, so it needs Chris's say-so. Revisit when a
  business's full window stops covering a year of messages, or search's p95 passes 1 s.
- OCR or AI reading of scanned PDFs and photos (a rate-card cost); transcribing voice notes; the attachments on texts
  and emails (the telephony bucket); legacy .doc and .xls, which can't be uploaded anyway.
- Folding accents in long text, and stemming.
- Searching inside what's in the Deleted bin.
- Sales Coach and Social Outreach searches. Social Outreach must apply its each-person's-own rule in its query, because
  its row security lets any `outreach.use` holder read chats (`outreach/ops/chats.ts:219-232`).
- People add-ons keep apart from Contacts: open-house visitors, showing agents, Facebook profiles.
- An Assistant `search_everything` tool.
- Products, templates, workflows, campaigns, menu places (a "Pages" kind), website-chat visitors and intake lines.
- Calendar builder and AI teammate sections in settings search, which need a `?module=` link on both builders.
- A bin mark on the phone's copy, batched with the next sync change.
- The hidden-add-on-kind gap in `task.list`, the timeline, the calendar and the inbox outside search, as a restrictive
  policy for every reader.
- "Form sent" as a last contact (boards 3 and 5b): nothing records that a form was sent to someone (decision 35).
- Searching an internal meeting's AI summary: no screen shows it today, so search doesn't either (decision 15).
- AI call summaries in `app.ai_calls`, and calls by number without a thread.
