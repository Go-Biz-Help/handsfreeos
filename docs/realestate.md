# Real Estate Agent

Real Estate Agent (`realestate`) runs a real estate agent's buyer and listing deals: every duty an agent owes, each
deadline worked out from the contract's own dates, the proof that it was done, and alerts before anything slips.
It's HandsFreeOS's first real add-on and is built on the add-on framework (docs/addon-architecture.md); read that
first. `HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md` holds the owner's decisions, how each part works, and
what each step built.

Round one built deals, duties, dates, proof, documents, alerts, the duty editor and client updates. Round two
(**Buyer core**) adds the buyer's side: what they want and buyer memory, homes, tours, the CMA, offers and counters,
financing, inspections and repairs, the client's own tasks, and the client's portal.

It's in **beta**: offered to nobody on its own. HandsFreeOS staff hand it to a test business, whose owners and
admins then add it from their Add-ons page. It's free; its AI use is counted.

## Where things are

| What                                  | Where                                                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest, permissions, kinds, events  | `packages/core/src/addons/realestate/manifest.ts`                                                                                                                                                                                  |
| The 148 duties and 24 trackers        | `packages/core/src/addons/realestate/catalog/`                                                                                                                                                                                     |
| Business days, due rules, date checks | `packages/core/src/addons/realestate/dates/`                                                                                                                                                                                       |
| Stages and duty statuses              | `states.ts`; terms and their history `terms.ts`; proof `proof.ts`; health `health.ts`; the alert ladder `ladder.ts`                                                                                                                |
| The duty editor's rules               | `editor.ts`; settings `settings.ts`                                                                                                                                                                                                |
| Words both apps and the AI use        | `words.ts`, `rule-words.ts` (a duty's rules, "due Fri"), `history-words.ts` (a deal's and a duty's history)                                                                                                                        |
| Fair housing and the AI's prompts     | `fair-housing.ts`, `prompts.ts`                                                                                                                                                                                                    |
| The buyer's side, in words            | `homes.ts` (facts and fit), `memory.ts`, `tours.ts` (the agreement rule), `cma.ts`, `offer-words.ts` (the one-page summary), `closing.ts`, `client-words.ts` (the portal's words)                                                  |
| Commands and queries                  | `packages/core/src/addons/realestate/ops/` (the engine that makes and dates duties is `ops/engine.ts`); all of them in `server.ts`                                                                                                 |
| Its own tables                        | `tables.ts` (Drizzle mirror of schema `addon_realestate`); migrations `20261013002500` to `20261013003000`, and round two's from `20261014000800`                                                                                  |
| Worker                                | `apps/worker/src/addons/realestate/`: the sweep and the alert ladder, the wiring alert, client-update drafting and checking; reading pasted listings, buyer memory, tours following the calendar, the CMA summary, the offer clock |
| Web                                   | components in `apps/web/src/addons/realestate/`; pages under `apps/web/src/app/app/w/[workspaceId]/a/realestate/`; panels and menu icons in `apps/web/src/addons/registry.ts`                                                      |
| The client's portal                   | its pages in `apps/web/src/addons/realestate/portal/`; core's shell, sign-in, Home, Messages and Files in `apps/web/src/components/portal/` and `apps/web/src/app/c/[token]/`                                                      |
| Design boards                         | `design/realestate` (approved 2026-09-30)                                                                                                                                                                                          |
| Tests                                 | `packages/core/test/addons/realestate-*.test.ts`; `apps/worker/test/realestate-*.test.ts`; `packages/db/test/private-records-rls.test.ts`; `apps/web/e2e/realestate.spec.ts`, `realestate-buyer.spec.ts`                           |

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
  versions, the alert person, closed days, milestone drafts, and support access.
- **Panels** on a customer, a company, a Pipeline lead and a property: their deals, and Start a deal from them.
- **A buyer deal** also has, on its page, what the buyer wants, their homes and tours, the buyer agreement,
  financing, the client's to-do, and offers and CMAs; and its own pages under `…/deals/<id>/`: **What they want**
  (`buyer`), **Homes** (`homes`, `?add=1` to add one, `?home=<id>` for one), **Tours** (`tours`, `?plan=1` to plan
  one), a **CMA** (`cma/<id>`), **Offers** (`offers`, one at `offers/<id>`, its summary at `offers/<id>/summary`),
  **Financing**, **Inspections** and the **Client's to-do** (`client-tasks`, `?invite=1` to invite to the portal).
- **The client's portal** (`/c/<link>`, at phone width): Home, Homes, To do and Messages; a deal, a tour's homes to
  say what they thought, and an offer's summary. Settings → Real Estate → Alerts & dates picks the calendar tours
  go on.

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
  the business's alert person (an owner or someone who sees every deal; the owners when nobody is picked).
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

- The listing side's workspace (round three): listing prep, marketing, showings, open houses and the seller's
  portal pages.
- Reading contracts and reports; the MLS, e-sign, lender, title, insurance and showing connectors (each needs an
  add-on's own credentials and webhook routes in core first).
- Phone screens for deals. Their links are ready: the manifest's `ui.phone` names the deal pages the phone will
  draw, and a push, an email link or a Home card opens them there once the phone has them (the web until then).
- The AI teammate using the add-on, and workflow steps and triggers from it.
- State rules, a brokerage rule engine beyond the duty editor, retention and legal holds, and exporting a whole
  transaction.
- Prices.
