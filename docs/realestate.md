# Real Estate Agent

Real Estate Agent (`realestate`) runs a real estate agent's buyer and listing deals: every duty an agent owes, each
deadline worked out from the contract's own dates, the proof that it was done, and alerts before anything slips.
It's HandsFreeOS's first real add-on and is built on the add-on framework (docs/addon-architecture.md); read that
first. `HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md` holds the owner's decisions, how each part works, and
what each step built.

Round one built deals, duties, dates, proof, documents, alerts, the duty editor and client updates. Round two
(**Buyer core**) adds the buyer's side: what they want and buyer memory, homes, tours, the CMA, offers and counters,
financing, inspections and repairs, the client's own tasks, and the client's portal. Round three (**Listing core**)
adds the listing's side: the home's facts, photos, the description the seller signs off, the MLS hold, the public
page, flyer, campaign and social posts, open houses, price changes the seller signs off, offers side by side with
the seller's estimate, matching to the business's own buyers, and the seller's portal. Round four (**Coordinator and
risk**) reads contracts and amendments, tracks contingencies, knows which duties wait on others, watches a client's
linked sale and purchase, raises at-risk work to the alert people after a business day, and adds Coordinate: Today,
Exceptions, the Waiting room and Team workload.

It's in **beta**: offered to nobody on its own. HandsFreeOS staff hand it to a test business, whose owners and
admins then add it from their Add-ons page. It's free; its AI use is counted.

## Where things are

| What                                  | Where                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest, permissions, kinds, events  | `packages/core/src/addons/realestate/manifest.ts`                                                                                                                                                                                                                                                                                                                                      |
| The 148 duties and 24 trackers        | `packages/core/src/addons/realestate/catalog/`                                                                                                                                                                                                                                                                                                                                         |
| Business days, due rules, date checks | `packages/core/src/addons/realestate/dates/`                                                                                                                                                                                                                                                                                                                                           |
| Stages and duty statuses              | `states.ts`; terms and their history `terms.ts`; proof `proof.ts`; health `health.ts`; the alert ladder `ladder.ts`                                                                                                                                                                                                                                                                    |
| The duty editor's rules               | `editor.ts`; settings `settings.ts`                                                                                                                                                                                                                                                                                                                                                    |
| Words both apps and the AI use        | `words.ts`, `rule-words.ts` (a duty's rules, "due Fri"), `history-words.ts` (a deal's and a duty's history)                                                                                                                                                                                                                                                                            |
| Fair housing and the AI's prompts     | `fair-housing.ts`, `prompts.ts`                                                                                                                                                                                                                                                                                                                                                        |
| The buyer's side, in words            | `homes.ts` (facts and fit), `memory.ts`, `tours.ts` (the agreement rule), `cma.ts`, `offer-words.ts` (the one-page summary), `closing.ts`, `client-words.ts` (the portal's words)                                                                                                                                                                                                      |
| Round four, in words                  | `contract-read.ts` (what the AI is asked and how its answer is checked), `contingencies.ts`, `catalog/order.ts` (which duties wait on which), `dates/linked.ts` (what a linked sale or purchase breaks)                                                                                                                                                                                |
| The listing's side, in words          | `listing.ts` (facts and where each came from, the hold, the page's address, the campaign's words, the questionnaire), `net.ts` (the seller's estimate), `offer-words.ts` (offers side by side)                                                                                                                                                                                         |
| Listing data from a feed (round five) | `feed.ts` (the one shape every supplier is read into, RESO's names, money in cents); the worker's adapters in `apps/worker/src/addons/realestate/feed/` (Repliers, a RESO Web API, AnyProp, and the stand-in MLS), the look-ups and the 15-minute feed check; `searches.ts` (a buyer's profile as a saved search)                                                                      |
| Commands and queries                  | `packages/core/src/addons/realestate/ops/` (the engine that makes and dates duties is `ops/engine.ts`); all of them in `server.ts`                                                                                                                                                                                                                                                     |
| Its own tables                        | `tables.ts` (Drizzle mirror of schema `addon_realestate`); migrations `20261013002500` to `20261013003000`, round two's from `20261014000800`, round three's from `20261020000100`, round four's from `20261020001100`                                                                                                                                                                 |
| Worker                                | `apps/worker/src/addons/realestate/`: the sweep and the alert ladder, the wiring alert, client-update drafting and checking; reading pasted listings, buyer memory, tours following the calendar, the CMA summary, the offer clock; `listing.ts` (a listing's facts, description, posts and reminders) and `matching.ts` (our buyers); `contract.ts` (reading a contract or amendment) |
| Web                                   | components in `apps/web/src/addons/realestate/`; pages under `apps/web/src/app/app/w/[workspaceId]/a/realestate/`; panels and menu icons in `apps/web/src/addons/registry.ts`                                                                                                                                                                                                          |
| The client's portal                   | its pages in `apps/web/src/addons/realestate/portal/` (the seller's in `listing.tsx`); core's shell, sign-in, Home, Messages and Files in `apps/web/src/components/portal/` and `apps/web/src/app/c/[token]/`                                                                                                                                                                          |
| The public pages                      | `apps/web/src/addons/realestate/public/`, drawn by core's `apps/web/src/app/a/[site]/[addonId]/[...path]/`; their operations in `ops/public.ts` and `ops/open-houses.ts`                                                                                                                                                                                                               |
| Design boards                         | `design/realestate` (approved 2026-09-30)                                                                                                                                                                                                                                                                                                                                              |
| Tests                                 | `packages/core/test/addons/realestate-*.test.ts`; `apps/worker/test/realestate-*.test.ts`; `packages/db/test/private-records-rls.test.ts`; `apps/web/e2e/realestate.spec.ts`, `realestate-buyer.spec.ts`, `realestate-listing.spec.ts`, `realestate-coordinator.spec.ts`                                                                                                               |

The core pieces it needed are core's, usable by any add-on: private records and support access
(docs/relationships.md), add-on alerts on Home, push and email, locked files, and staff grants
(docs/addon-architecture.md).

## The screens

- **Deals** (`/a/realestate`): health counts, My deals, All deals, Needs attention, Closed and Archived; Start a
  buyer deal and Start a listing.
- **A deal** (`/a/realestate/deals/<id>`): its stages and next move, what could stop the closing, its duties by what
  brought them, key dates, people, commission and client updates. A duty opens in the drawer at `?duty=<id>`; every
  alert about a duty lands there. **Key dates** (`…/dates`), **Documents** (`…/documents`), **History**
  (`…/history`) and a **client update** (`…/updates/<draft>`) are its own pages.
- **My duties** (`/a/realestate/duties`): overdue, today, this week, later, waiting, blocked, and waiting for a date.
- **Deal settings** (`/a/realestate/settings`, owners and admins): the duty list and its editor, publishing,
  versions, the alert people, closed days, milestone drafts, and support access.
- **Panels** on a customer, a company, a Pipeline lead and a property: their deals, and Start a deal from them.
- **A buyer deal** also has, on its page, what the buyer wants, their homes and tours, the buyer agreement,
  financing, the client's to-do, and offers and CMAs; and its own pages under `…/deals/<id>/`: **What they want**
  (`buyer`), **Homes** (`homes`, `?add=1` to add one, `?home=<id>` for one), **Tours** (`tours`, `?plan=1` to plan
  one), a **CMA** (`cma/<id>`), **Offers** (`offers`, one at `offers/<id>`, its summary at `offers/<id>/summary`),
  **Financing**, **Inspections** and the **Client's to-do** (`client-tasks`, `?invite=1` to invite to the portal).
- **A listing deal** also has, on its page, the listing (photo, price and what it was, the MLS, the description and
  the page), offers with what the seller would take home, open houses, marketing, the seller's to-do, matching, the
  seller's estimate and CMAs; and its own pages under `…/deals/<id>/`: **The home's facts** (`facts`), **Photos**,
  **Description**, **Price** (`?change=1` to change it), **Marketing** (`?live=1` to mark it live on the MLS), the
  **Flyer**, **Open houses** (`?plan=1` to plan one), **Offers** side by side, and the **Seller's estimate**
  (`net-sheet`). Financing, Inspections and the CMA work on a listing too, from the seller's side.
- **The client's portal** (`/c/<link>`, at phone width): Home, Homes, To do and Messages; a deal, a tour's homes to
  say what they thought, and an offer's summary. A seller's deal shows their listing, and its own pages: the
  questions about their home (`questionnaire`), a sign-off (`sign-off/<task>`) and their offers (`offers`).
  Settings → Real Estate → Alerts & dates picks the calendar tours and open houses go on.
- **The public pages** (`/a/<site>/realestate/<slug>`, signed out): a listing's page with "Ask about this home", and
  an open house's sign-in (`…/open-house/<id>`), opened from the QR code on the printed sheet.
- **Round four on a deal**: **the contract as read** (`…/contract/<read>`), the PDF beside each value with its clause,
  page and words, to confirm or set aside, and for an amendment what it changes and which duties move;
  **Contingencies** (`…/contingencies`), each with its end and how it ended; on the deal page, a callout while a
  reading waits, the Contingencies and Linked deal cards, and what a linked deal breaks; on Documents, each reading's
  state and Read it again. A duty's drawer shows what it waits on, what waits on it and what moves if it slips, and
  Chased and It came in while it waits on someone outside.
- **Coordinate** (`/a/realestate/coordinate`): **Today** (at risk, escalated, overdue, due today), **Exceptions**
  (`?tab=exceptions`), the **Waiting room** (`?tab=waiting`) and **Workload** (`?tab=workload`, See every deal only),
  each narrowed by `?mine=1` or `?agent=<id>`. **Deals** takes filters in its address: `agent`, `side`, `stage`,
  `closing` (days), `waiting` (`outside`, `blocked`, `either`) and `health`.
- **The client's portal** shows their contingencies on their deal, and how each ended.

## Rules worth knowing before changing anything

The owner's decisions (Chris, 2026-09-30) are settled; ask before going against one.

- **A deal is private to the people on it.** Its main agent and team see it; owners, admins and anyone given **See
  every deal** (`realestate.all_deals`) see them all. What hangs off a deal (its duties, dates, documents, files,
  tasks, timeline lines, Home cards) follows it, in row security, never in the app. Properties are shared.
- **A deal's appointments are its own too** (a tour, round two). Someone off the deal doesn't see them or who
  they're with, only that the people on them are busy then, in the calendar and in every open time it offers; only
  people on the deal work them (`appointment_staff_not_on_record`). Phones get them back with the deal screens.
- **Only the main agent, owners and admins change who's on a deal.**
- **Duties stay in the add-on**, not in Tasks, so a proof rule can't be skipped elsewhere.
- **A duty is done only with its proof** (`duty_needs_proof`, saying what's missing). Owners and admins
  (`realestate.except`) may finish one without it, or waive it, with a reason kept in its history.
- **Duties from contract dates start as drafts** until a person confirms the dates. Everyday duties start at once.
- **A date with no time is due at 11:59 PM** where the business is. Business days skip weekends, US federal
  holidays as observed, and the business's closed days. A calendar-day deadline on a weekend or holiday keeps its
  date and shows a warning.
- **Terms are never overwritten.** Every value keeps its source and history; an amendment supersedes, and two values
  that disagree wait for a person, who picks one with a reason.
- **Signed documents are kept for good**: locked, never deleted or renamed, only replaced by a newer version marked
  as the one that counts. They stay locked even if the add-on's data is deleted.
- **Deals are archived, never deleted.**
- **Changing the duty list changes new deals only.** Open deals keep their version until an owner or admin applies
  the new one to one deal, after seeing what it changes.
- **Alerts:** Home cards, push and email; critical any time, the rest in working hours; critical ones also go to
  the business's alert people (owners or people who see every deal; the owners when nobody is picked).
  Acknowledging stops an alert climbing. A changed wire raises a critical alert at once and a duty finished only by
  a phone check.
- **The Assistant** looks things up on its own and changes things only with a person's OK. It never makes
  exceptions, waives, ends or archives a deal, sets the final commission, changes the team or edits the duty list.
- **Client updates are drafted, never sent, by the AI.** The agent checks and sends each from their own mailbox
  (else their address, else the team inbox). Every draft's words are checked for fair-housing risk by a fixed list
  and by the AI; it goes only once each flag is fixed or kept with a reason, and every check is kept.
- **Support can't see private deals** unless the deal's agent or an admin lets them in, for 24 hours or less,
  covering every deal the person letting them in can see. The founder sees all.
- **Commission's final amount** is set by owners and admins.

Round two (Chris, 2026-09-30):

- **Homes are added by the agent and the client.** The agent pastes an address or a listing's words; a link is kept
  but never read. The AI fills in facts only from words in the text, each with its quote, and the agent confirms
  them. Fit reads only the budget, areas, kind of home and rooms, never who lives somewhere.
- **A tour needs a signed buyer agreement that covers its day** (`buyer_agreement_needed`,
  `buyer_agreement_expired`). Owners and admins (`realestate.except`) can let one through with a reason, kept in the
  deal's history with their name. A tour is one appointment on the calendar with its homes in order, and the client
  is invited.
- **Buyer memory: the AI suggests, a person confirms.** Each suggestion keeps the words it came from. Anything about
  who lives somewhere or a protected class is never kept, only how many were left out.
- **The CMA's range is worked out, its summary drafted by the AI** for the agent to check, with both fair-housing
  checks. It's shared only once it's final and checked.
- **Offers are terms only**, with every version kept, a clock on the answer, and a one-page summary for the client.
  The contract is filled in the agent's forms software and uploaded. Accepted terms go to Key dates unconfirmed.
- **Each financing step is marked done with its proof.**
- **Round two's records add proof to their duties** (a tour to B-05, an offer to B-11…), once, and never finish one.
- **The portal:** a private link, and a 6-digit code emailed on each new device; no password. A device stays signed
  in for 30 days after it was last used, 90 at most. Co-buyers each have their own sign-in, and each one's save, pass,
  feedback and sign-off is their own. The client sees where the deal stands and its dates, does their own tasks,
  saves or passes on homes, says what they thought after a tour, and messages the agent.
- **Portal messages** are seen only by the people on that client's deals, plus owners, admins and See every deal.
  The "your agent replied" email is a link only; the words stay in the portal.

Round three (Chris, 2026-10-01):

- **Nothing public before the listing is live on the MLS** (`realestate_not_on_mls`): its page, the flyer, an email
  or text to contacts, copying the social posts, the open house sign-in and matching to buyers all wait. Nothing lets
  it through; it's the MLS's rule. The agent marks it live with its number and day, and the MLS page as proof.
- **The home's facts come three ways**: the seller's questionnaire in the portal, the old listing's words pasted for
  the AI to read (each fact with its quote), or typed by the agent. Where they disagree the agent picks; only a
  person confirms a fact, and the page shows only confirmed ones.
- **The description: the AI drafts, the agent edits, the seller signs off** the exact words in the portal. Both fair
  housing checks read every version; it's sent only once each flag is fixed or kept with a reason.
- **A new price is used only once the seller signs it off**; then it's on Key dates, the page and the flyer, matching
  runs again, and the agent is reminded to change it on the MLS. An owner or admin can let a description or a price
  through without the portal, with a reason kept ("signed on paper").
- **Campaigns use exact words** from the signed-off description, read by the fair housing list, and wait in
  Campaigns for approval like any other. HandsFreeOS never posts to social accounts; the agent copies a post.
- **Open houses** go on the host's calendar; the seller sees them, no sign-off. A visitor on their own becomes a
  customer with a lead for the host, their yes to texts kept with "Open house: <street>"; one working with another
  agent is only recorded, never a lead or texted. The host is reminded the next morning about anyone not followed up.
- **Offers side by side, with what the seller would take home** from each: an estimate from the agent's figures, and
  it says so; every save of the figures is kept. The seller's accept, counter, decline or let's talk tells the agent
  what they want and accepts nothing.
- **Matching** suggests a live listing to the agent on each of the business's own buyer deals it fits. The listing's
  side sees how many, never who.
- **Public photos are links that work for an hour**, and the public pages show only the business's name, never the
  agent's phone.

Round four (Chris, 2026-10-02):

- **The AI reads contracts and amendments** as they're added to Documents (`contract`, `amendment`, `addendum`):
  parties, money, every date and contingency, each with its clause, page and the words it came from. A value whose
  words aren't in the document, or a date that isn't a date ("within a reasonable time"), is never entered; it's
  listed for the agent. Inspection reports and the Closing Disclosure aren't read.
- **Scans are read too**: the PDF goes to the AI, and each value is marked "read from a scan" to check closely.
- **A person confirms each value.** Until then it waits on Key dates, unconfirmed, beside its clause, and nothing
  rests on it; the duties on its date start, or move, once it's confirmed. One that's wrong is set aside with a reason.
- **The agent records how a contingency ended** (satisfied, waived or expired) with the signed form from the deal's
  documents, as its proof; an owner or admin can record it without the form, with a reason kept. The client sees each
  one, and how it ended, in their portal. A contingency ends on its key date, so moving the date moves it; past its
  end with nothing recorded, the deal is red.
- **Duties wait on others: built in, plus the agent's own** on the same deal, never in a circle. Built-in orders
  stay; one that doesn't apply ends when its first duty is waived or done. Waiting on someone outside has a day to
  chase them (two business days on, unless said), and "Chased" moves it on.
- **Linked sale and purchase: watch both and warn.** Each shows the other's key dates, health and agent, never its
  duties, documents or messages; a date that breaks the pair is flagged on both, to both agents.
- **At risk for a business day with nobody acknowledging it** goes to the business's alert people too (up to 10, in
  Deal settings; the owners when nobody is picked). Critical ones go to them at once, as before.
- **Coordinate's views** cover the deals the person sees; Workload is about people, so it needs See every deal.
  Exceptions stay until they're fixed, not when someone opens them.

Round five (Chris, 2026-10-02):

- **Listing data: HandsFreeOS's own Repliers account by default**, turned on by staff; a brokerage can connect its
  own Repliers, AnyProp or MLS feed instead, and it's used first. Only the worker holds the keys.
- **A feed is a source of facts, never of authority.** What it says is kept as it said it, with its supplier, MLS
  and time, and shown as "From the MLS". It fills only facts still empty, as suggestions to confirm; what a person
  confirmed is never overwritten, and where they disagree both are shown. A feed that's down marks nothing done.
- **Comps from the MLS don't count until the agent ticks them.**
- **A buyer's new matches go to the agent first**, at most one Home card a day per buyer, never to the client. The
  client sees only the homes the agent sends.
- **Our listing seen Active on the MLS is marked live here**, with the feed as proof. A price or status on the MLS
  that differs from the deal's is flagged on a Home card, never copied over. HandsFreeOS never writes to the MLS.
- **Each MLS's notice, logo and courtesy line go with its listings** wherever they're shown.

## Handing it to a test business

1. A HandsFreeOS staff member with `platform.addons.manage` opens **/admin/businesses/<business>** and presses
   **Let them try it** beside Real Estate Agent under Add-ons in testing (`addon_grant.give`).
2. An owner or admin of that business opens **Add-ons**, finds Real Estate Agent under Available to add, marked
   Testing, and presses **Install**. Deals, My duties and Deal settings join the menu once it's on.
3. **Take back** stops new installs there; a business that added it keeps it until it's uninstalled.

The steps, with what to check, are in docs/operations.md under "Hand an add-on to a test business".

## Working on it

```bash
pnpm --filter @hfos/core exec vitest run test/addons/realestate   # the add-on's core tests (the local stack)
pnpm --filter @hfos/worker exec vitest run test/realestate          # its worker's
pnpm openapi                                                        # after changing an operation
```

- A new duty for everyone goes in the catalog (`catalog/`), with a catalog test; bump `CATALOG_VERSION` when a
  row's meaning changes. Businesses change theirs in the duty editor, never in code.
- A deal command runs the engine (`openWork` in `ops/engine.ts`) and ends with `settle()`, which re-dates, activates
  drafts, recomputes the expected commission and refreshes health. Don't write duties around it.
- Words shown to people come from core (`words.ts`, `rule-words.ts`, `history-words.ts`), so the phone and the
  Assistant say the same thing.
- A command locally takes 0.5 to 1.4 seconds (opening a listing at Active makes 45 duties); the engine's many small
  writes are where to start if that matters.

## Not yet

- Showings and their feedback (round five, with the showing connector); vendors and booking the photographer;
  reports on competing listings.
- Putting the listing on the MLS, posting to social sites, and reading offers from their PDFs.
- Reading inspection reports and the Closing Disclosure; lender, title and insurance connectors. Round five is
  building listing data (its connector and adapters are in), e-sign and showings on core's connections and a
  service's updates (docs/addon-architecture.md).
- Phone screens for deals and Coordinate. Their links are ready: the manifest's `ui.phone` names the deal pages the phone will
  draw, and a push, an email link or a Home card opens them there once the phone has them (the web until then).
- The AI teammate using the add-on, and workflow steps and triggers from it.
- State rules, a brokerage rule engine beyond the duty editor, retention and legal holds, and exporting a whole
  transaction.
- Prices.
