# The main offer on the phone: review, notes, direction and tries

The main offer's last step, Review and go live, is only on the web. An owner who wants to look at how their offer
scored, leave the AI a note, or put a better version live has to be at a computer. This plan brings that step to the
phone:

1. **Settings → Main offer** on the phone, in This business, for anyone in a business that uses the offer.
2. **Review your draft**, as the web's: the score, each part's card with what's working, what's holding it back and
   the AI's fix, a note for the AI, Keep this part as is, Edit it myself, the owner's direction, and Make a try.
3. **Try 1 is ready**: how each part scored before and after, and **Compare on the web** to pick parts from it.
4. **Go live**, or **Use it anyway** with a reason, as on the web.
5. **Members read** the live version and the direction; they change nothing.

It builds on the main offer and its tries as they are (docs/main-offer.md, HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md,
HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md). The design is on the canvas **Main offer on the phone**
(https://claude.ai/artifact/QnVAhcpw5jG2YE9txiXUC4): Settings, Review your draft, Try 1 is ready, Edit it myself, Use
it anyway, and a member's view.

**Where it stands (2026-10-16):** planned. Chris approved the boards (2026-10-16: "boards approved").

## Decisions (Chris, 2026-10-16)

| Question                          | Answer                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How much of the flow is on phone? | **Review, and compare on a computer.** The whole Review step is on the phone. A try is made and summed up there; comparing it and taking parts from it is the web's Compare, which **Compare on the web** opens. |
| Where does it live?               | **Settings → Main offer.** A third exception to the rule that setting the business up stays on the web (2026-09-28), beside the balance and add-ons.                                                             |
| Can the phone put it live?        | **Yes, as the web does.** Go live once every part clears the bar; Use it anyway with a reason when it doesn't.                                                                                                   |
| Boards first?                     | **Yes.** Drawn and approved before building.                                                                                                                                                                     |

## What the repo has, and what it's missing

**Has:**

- Everything the screens say and decide, in core, ready for the phone: `MAIN_OFFER_WORDS`, `MAIN_OFFER_TRY_WORDS`,
  `OFFER_STEP_WORDS` (each part's boxes), `OFFER_NOTE_PICKS`, `OFFER_DIRECTION_PICKS`, and `partSays`, `underBar`,
  `clearsBar`, `lowestScore`, `missingParts`, `partWords`, `withPart`.
- The queries and commands: `main_offer.get` (with `inUse` and `comesWith`), `main_offer.tries`,
  `main_offer.save_draft`, `main_offer.save_direction`, `main_offer.publish`.
- The worker's routes, with the person's sign-in: `POST /v1/main-offer/score` and `POST /v1/main-offer/try`.
- The phone already calls the worker that way (`onboarding-setup/calls.ts`, `money/use-wallet.ts`), asks HandsFreeOS
  for what it doesn't keep (`@/lib/live-answer`), and opens the web in the browser (`@/lib/open-web`).

**Missing:**

- Any main offer screen on the phone (docs/main-offer.md, "Not yet").
- The phone's contract has none of the main offer's queries or commands.
- A way for Settings to know, with no signal, whether the business uses the offer.
- A few things the web works out in its components that the phone needs too: the "Under 7: who and guarantee"
  title, the quick checks, and what goes into the next try. The rule is one copy, in core.
- Words only the phone says: the Settings row, needing signal, Try 1 is ready, Compare on the web.

## How it works

### Where it shows

- **Settings → This business → Main offer**, when an add-on that uses the offer runs here and the person holds one of
  its permissions. An add-on's permissions are only in the person's list while it runs (`private.permissions_for`),
  so the phone's own copy answers with no signal. A new core helper, `coreFeatureHeld(catalog, permissions,
feature)`, beside `coreFeatureRunning`, says it, and names no add-on.
- The row's second line comes from `main_offer.get` when there's signal: "Version 3 is live · your draft is under 7
  on the who and the guarantee", or "Not built yet". With none it says what the screen is for.
- This business shows when either of its rows does: the balance for whoever manages the money, Main offer for
  whoever uses the offer.

### The screen (`settings/main-offer.tsx`)

It needs signal, as Social Outreach's live screens do: `main_offer.get` and `main_offer.tries` are asked on open and
on pull to refresh, and with none it says "The main offer needs signal. Try again when you're back online." Nothing
of the offer is kept on the phone, so `sync-config.yaml` doesn't change.

What it shows depends on the offer and on `main_offer.manage`:

| The offer         | Someone who can change it                                                                                                                                                               | Everyone else                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| No add-on uses it | Which add-on brings it (`comesWith`), as on the web.                                                                                                                                    | The same.                                          |
| Not built yet     | Build your main offer on a computer, with **Open on the web** (the builder's first steps stay there).                                                                                   | Ask an owner or admin to build it (`askOwner`).    |
| A draft           | **Review your draft** (board 2).                                                                                                                                                        | The live version, and that someone is changing it. |
| Live, no draft    | **Review** of the live version: its score, parts and direction. The first change (Edit it myself, Score, Make a try) keeps the live parts as the draft first (`main_offer.save_draft`). | The live version (board 6).                        |

**Review your draft**, as the web's Review step:

- At the top, who is changing it and when it was saved, then the offer in one line.
- The score at a glance: which parts are under 7, every part's number, the quick checks, and when it was scored. Not
  scored yet (after an edit): **Score my offer**. Missing a part: "Before it can be scored and go live, fill in:",
  each one opening Edit it myself, or the web for the niche, proof and the one line.
- **Each part** as a card, open when it's under 7: what it says now, what's working, what's holding it back, the AI's
  fix, **Your note for the AI** with the quick picks, **Keep this part as is** (a switch, as the phone's settings
  are), and **Edit it myself**. A kept part and a part with a note say so on the closed card.
- **Your direction**, its quick picks, what goes into the next try, and **Make Try N**.
- The bar at the bottom, as the web's footer: **Score my offer**, **Go live**, or **Use it anyway…** with **Make Try
  N**.
- The notes and kept parts start from the latest try's, as on the web. The draft, then the direction, are saved
  before a score or a try, as the web's `persist()` does.

**Edit it myself** (`settings/main-offer-part.tsx?part=`): that part's boxes from `OFFER_STEP_WORDS`, read and written
with `partWords` and `withPart`, with the AI's fix above them. Save keeps the draft (`main_offer.save_draft`), so the
score clears until it's scored again. The method's steps are each a box; adding, taking out and moving a step stay on
the web (question 1).

**Make a try** asks the worker (`/v1/main-offer/try`) with the notes and kept parts, then shows **Try 1 is ready**
(board 3): each part's score in the draft and in the try, Kept as is for a kept part, a blank in [brackets] called
out, and what it followed. **Compare on the web** opens the builder on that try
(`/app/w/<business>/main-offer/build?step=score&try=<id>`) in the browser; **Back to review** goes back. The try is
kept either way.

**Go live** publishes (`main_offer.publish`) and goes back to Settings with the web's words: "Your offer is live.
Version N is what your sales add-ons say now." **Use it anyway…** opens a sheet that takes the reason first (board 5).

Every refusal reads as the API and the worker word it, so the phone branches on `rule` only:
`main_offer_draft_moved` asks the screen again, and `main_offer_all_kept`, `main_offer_try_unchanged`, `ai_busy` and
`wallet_empty` show their message.

### One copy of shared logic

Moved into core (`packages/core/src/main-offer`), and the web switched to them:

- `underBarTitle(score)`: "Under 7: who and guarantee", or "Every part scores 7 or more".
- `offerChecks(score)`: the four quick checks and whether each passed.
- `goingInto(direction, notes, keep)`: what the next try is made from.
- `MAIN_OFFER_PHONE_WORDS` in `words.ts`: the Settings row, needing signal, Open on the web, Try N is ready, Compare
  on the web, and what each part did in the try.

## Commands, queries and routes

- **No new commands, queries or routes.** The API and the worker don't change, and `pnpm openapi` stays fresh.
- **The phone's contract grows** (`packages/core/test/contract/mobile-contract.json`, `UPDATE_CONTRACT=1`): the queries
  `main_offer.get` and `main_offer.tries`, and the commands `main_offer.save_draft`, `main_offer.save_direction` and
  `main_offer.publish`, all `online`, so none is ever queued.
- **The worker from the phone:** `workerPost` moves from `onboarding-setup/calls.ts` to `@/lib/worker`, so the
  onboarding setup and the main offer share it. Each AI ask is counted as main offer usage, as from the web.

## Screens

- `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/settings/main-offer.tsx`: the screen, by state.
- `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/settings/main-offer-part.tsx`: Edit it myself.
- `apps/mobile/src/main-offer/`: the calls (`calls.ts`), the screen's state (`use-main-offer.ts`), and its pieces
  (`review.tsx`: the glance, a part's card, the direction; `try-ready.tsx`; `anyway-sheet.tsx`; `live.tsx`, the
  read-only view).
- `settings/index.tsx`: the Main offer row.
- Built from the phone's own parts (`Screen`, `Card`, `Button`, `Input`, `Switch`, `Sheet`, `Badge`) and its tokens,
  which come from the web's.

## Tests

- **Core:** `coreFeatureHeld`; `underBarTitle`, `offerChecks` and `goingInto`, moved with the web's cases; the contract,
  recorded.
- **Phone** (jest, `apps/mobile/src/main-offer/__tests__`):
  - who sees the Settings row;
  - each state of the screen, and needing signal;
  - a note, Keep and the direction going into the try;
  - the live version kept as the draft before the first change;
  - Edit it myself saving the draft and clearing the score;
  - Make a try showing Try 1 is ready, and Compare on the web opening the right address;
  - Use it anyway waiting for a reason;
  - a member seeing nothing they can change.
- **Web:** the main offer browser tests again, after the move to core's helpers.

## Build order

1. **Core and the contract.** `coreFeatureHeld`, the helpers moved from the web (and the web on them), the phone's
   words, and the contract entries. The approved boards copied into `design/main-offer`, self-contained, as the web's
   are.
2. **The screen, read and review.** `@/lib/worker`, the calls, the Settings row, and the screen by state: not in use,
   not built yet, needs signal, the member's view, and Review your draft (the glance, the parts' cards, notes, Keep,
   the direction and the bottom bar).
3. **The changes.** Edit it myself, Score my offer, Make a try and Try 1 is ready with Compare on the web, Go live and
   Use it anyway.
4. **Tests, docs and the PR.** The tests above; docs/main-offer.md (what the phone does, and off the Not yet list);
   Social Outreach's phone README ("the main offer is built on a computer" stays true of building it); the Settings
   comment and words for the rule's third exception; and the tries plan's "Not in this plan".

It's all JavaScript, so it ships as an over-the-air update once CI passes. No migration, and no change to sync.

## Questions

1. **The method's steps on the phone:** change each step's words there, and add, take out or move steps on the web?
   Recommended: yes. A list you reorder by dragging is fiddly on a phone, and the steps are rarely all redone at once.
2. **A first offer:** with nothing built, the phone says to build it on a computer and offers Open on the web?
   Recommended: yes. The niche finder and the first steps are long forms that suit a computer.
3. **Missing parts that aren't scored** (the niche, proof, the one line): open them on the web? Recommended: yes, for
   the same reason.
4. **The Settings row with no signal:** say what the screen is for instead of how the offer is doing? Recommended: yes.
   The phone keeps nothing of the offer, so it can't say more.
5. **Members:** show them the row, read-only, when they use an add-on that uses the offer? Recommended: yes. They say
   the offer in their messages, and the web lets them read it too.

## Not in this plan

- Comparing a try and taking parts from it on the phone. Compare on the web does that.
- Building a first offer, the niche finder, and Improve or Write it for me on each box.
- Throwing a draft away, and the list of published versions.
- Add-ons' panels under the live version (Social Outreach's numbers for each version).
- Keeping the offer on the phone to read with no signal.
