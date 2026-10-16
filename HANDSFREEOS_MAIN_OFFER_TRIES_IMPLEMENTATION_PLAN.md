# The main offer: notes, your direction and the AI's tries

The main offer's last step scores each part and names the weakest. That works for a plain offer. It falls short when
the offer is unusual and the scoring rules push it back toward plain. HandsFreeOS itself is the example: it isn't
"a CRM", and the scorer marked its who down for naming three lines of work, which is the point of it. The owner had
no way to say so.

This plan changes the last step so the owner can steer the AI instead of fighting it:

1. **Each part shows what's working and what's holding it back**, with the AI's fix. The owner can leave the AI a
   note on any part, or keep a part as it is.
2. **A direction for the whole offer**, in the owner's own words. The AI writes and scores to it from then on.
3. **The AI's tries**: a whole new version of the offer, written from the direction and the notes, kept beside the
   draft. It never replaces anything by itself.
4. **Compare and pick, part by part.** Your draft on the left, the try on the right. Take any parts from it, all of
   it, or none, then score and go live as now.

It builds on the main offer as it is (docs/main-offer.md, HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md). The design
is on the canvas **Main offer: notes, direction and tries** (https://claude.ai/artifact/14rYNgQfLT3v8xBhAsFkiw):
Review, Compare, and Picks applied.

**Where it stands (2026-10-16):** built, steps 1 to 4, on branch `claude/compassionate-hypatia-62wvlc`: the
migration (`20261027007800_main_offer_tries.sql`, not yet on the hosted database), the fuller score, the direction,
the tries' commands and query, the AI's prompts and checks, the worker's `POST /v1/main-offer/try`, the builder's
Review, Compare and applied views with Settings → Main offer's, and the docs (docs/main-offer.md). Chris approved the
boards (2026-10-16: "boards approved").

## Decisions (Chris, 2026-10-16)

| Question                                          | Answer                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What each part shows                              | **What's working, what's holding it back, and the AI's fix**, with the score. A note box under each, and **Keep this part as is**.                                                                 |
| Feedback on the whole offer                       | **A direction box at the end**, in the owner's words: what the offer really is, who it's for, what to lead with.                                                                                   |
| What the AI does with it                          | **Writes a new try beside the draft.** Nothing changes until the owner picks.                                                                                                                      |
| How a try is compared                             | **Side by side, part by part.** Each part shows yours and the try's, with both scores and why it changed. Tap a side to pick it; Keep all mine and Use all of it are there too.                    |
| When the direction disagrees with a coaching rule | **The AI follows the owner and scores with it.** The direction becomes part of the brief: a broad who on purpose isn't marked down just for being broad, and the part says it was scored that way. |
| Keeping tries                                     | **Every try is kept.** Try 1, Try 2 and so on stay listed, and parts can be mixed in from any of them.                                                                                             |

Carried over, not re-asked (docs/main-offer.md, "Rules worth knowing before changing anything"):

- **Every part clears 7 before it goes live**, or someone with `main_offer.manage` says why (Use it anyway). The
  direction changes what the AI judges good, never the scale or the bar.
- **A version never changes**, and **only the worker scores**, for the revision it read.
- **The AI never writes proof.** A try copies the draft's proof as it is.
- **Nothing the AI writes is used until a person picks it.** A try is a suggestion; applying it is the pick.
- **What the AI writes follows `writing.ts`**: plain words, short sentences, no long dash, `[brackets]` where a
  number or name it wasn't given would go.
- **One main offer a business.** A try is a draft of the same offer, not a second one.
- Everything the AI does here counts as `main_offer` usage against the daily AI limit.

## What the repo has, and what it's missing

**Has.**

- The score (`MainOfferScore` in `packages/core/src/main-offer/parts.ts`): each part's score and one line on why,
  the weakest part and one fix, the three flags and the 3-second test. Kept with the draft's revision, and with each
  version.
- Improve and Write it for me on each box (`/v1/main-offer/assist`), three to pick from.
- The draft and its revision: a save names the revision it started from, and a score is only for the revision it read.
- The builder's last step (`score` in `OFFER_STEPS`), Use it anyway, and Settings → Main offer.

**Missing.**

- **Why a part scored what it did, beyond one line.** Nothing says what's already working, and the only fix is the
  weakest part's.
- **Anywhere to say what the offer really is.** Every prompt reads the parts and the business profile, and nothing
  from the owner about where it should go.
- **A rewrite of the whole offer.** The AI helps one box at a time.
- **Somewhere to keep the AI's version beside the draft**, and a way to take some of its parts and not others.

## What it holds

### The direction

`app.main_offers.direction`: the owner's words for the whole offer, up to 2,000 characters, or null.

- **Kept for good**, not just for one try. Every score, try, Improve and Write it for me reads it, until someone
  changes it or clears it.
- **Saving it moves the draft's revision on**, so a score from before is stale and is done again against it, and two
  editors can't undo each other (`main_offer_draft_moved`, as a save does).
- Settings → Main offer shows it under the live version, with **Edit your direction**.

### Notes and kept parts

Per try, never on their own. The owner writes them on the review step, and they go with **Make a try**:

- **A note on any of the six scored parts**, up to 500 characters each. Quick picks add a line: Broad on purpose,
  Undersells it, Not how I'd say it, Say what's different, Make it shorter.
- **Keep this part as is**: the try leaves that part exactly as the draft has it.
- The try keeps the notes and kept parts it followed, so the review step starts from the latest try's notes after a
  reload, and Compare can say what the try followed.

### The tries

`app.main_offer_tries`, one row a try, never changed after (`private.forbid_change`):

| Column               | What                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `round`              | The live version when it was made, 0 before the first. A round's tries are the ones Versions shows; older rounds are kept, hidden.                                            |
| `number`             | Try 1, 2, 3 within the round. `unique (workspace_id, round, number)`.                                                                                                         |
| `from_revision`      | The draft's revision it was written from.                                                                                                                                     |
| `base`               | The draft's parts as it read them: **Before Try N**, and what Restore puts back.                                                                                              |
| `parts`              | The try's whole offer (`MainOfferParts`): the six scored parts rewritten unless kept, the one line and the few words rewritten from them, niche and proof copied from `base`. |
| `why`                | For each scored part, why it changed, in a sentence; null for a part it kept.                                                                                                 |
| `score`              | The AI's score of the try as a whole (`MainOfferScore`), with the direction.                                                                                                  |
| `direction`          | The direction it followed, as it was then.                                                                                                                                    |
| `notes`, `keep`      | The notes and kept parts it followed.                                                                                                                                         |
| `made_by`, `made_at` | Who asked, and when.                                                                                                                                                          |

Each row stays under 100 KB (`octet_length` checks, as the draft has). Nothing in an add-on points at a try.

### The score, in more detail

Each part in `MainOfferScore` gains, all optional so every score kept today still parses:

- `good`: up to 3 lines on what's working (each under 200 characters);
- `holding`: up to 3 lines on what's holding it back;
- `fix`: the AI's fix for that part, in a sentence (under 300);
- `followedDirection`: true when the direction changed how the part was judged. The screen says **Scored with your
  direction** beside it.

The part's `why` stays its one-line headline, and the whole score's `weakest` and `fix` stay as they are.

## How it works

1. **Review** (the builder's last step, now **Review and go live**). Scoring works as now. Each part is a card: the
   score, the headline, then open it for what it says now, Working, Holding it back, the AI's fix, the note box and
   Keep this part as is. Parts under 7 start open. The direction box is under the cards. **Edit it myself** goes to
   that part's step, as Change the who does now.
2. **Make a try.** The web saves the draft and the direction if they changed, then asks the worker for a try with
   the revision, the notes and the kept parts. The worker reads the draft and direction as kept (never what the
   screen sends, as the score does), writes the try, scores it, and keeps it. Saved only if the draft is still at that
   revision; otherwise the screen says it changed and to make the try again.
3. **Compare.** Versions lists Your draft and the round's tries, each with its lowest score. Opening a try shows each
   part side by side: yours and its score, the try's and its score, why it changed, and Higher score where it is. A
   kept part shows once, marked kept. Every part starts on **yours**. A preview below reads the offer with the picks,
   the try's parts tinted. When the draft changed after the try was made, it says so.
4. **Apply the picks.** The draft takes the picked parts from the try; the rest stays. When every part the try changed
   is picked, and the draft hasn't moved since the try, the try's one line and few words come too.
5. **A mix needs its own line.** When only some parts are picked, the one line no longer fits them. The applied step
   shows three new lines from the AI (Write it for me on `line`, as Put it together does) and the draft's own, to pick
   one. The few words for messages are offered the same way.
6. **Scored again.** Applying is the owner's say-so to score: once the line is settled, the draft is scored as it
   now is. Then Go live, or Use it anyway, as now.
7. **Restore.** **Restore my draft from before** saves the try's `base` back as the draft. Try N stays listed.

A try with a `[bracket]` in it (a number the AI wasn't given) can be picked; publishing already needs the parts
filled in, and the screen points at the bracket to fill before going live.

## The AI's prompts

All in `packages/core/src/main-offer/assist.ts`, as now.

- **The direction is fenced like every other answer**, inside `<direction>` with `quoteData`, as data. The system
  prompt says what it's for: it's the owner's own view of what the offer is and who it's for, and where it disagrees
  with a coaching rule (one line of work in the who, say), follow the direction. It never outranks the rules on
  inventing results, numbers or names, the plain-writing rules, or the scale and the bar. Anything in it about scores
  is ignored.
- **The score** reads the direction, judges a part by how well it does what the direction asks when the two disagree,
  and sets `followedDirection` when it did. It answers the new `good`, `holding` and `fix` for each part.
- **The try** (`OFFER_TRY_SYSTEM`, `offerTryPrompt`, `OFFER_TRY_SCHEMA`, `checkedOfferTry`, ending on its own ask line
  for the scripted stand-in): the offer, the direction, the notes by part and the parts to keep. It rewrites every box
  of the parts not kept, then the one line and the few words from them, and says why each part changed, naming the
  note or direction it followed. The check holds every box to its length (a box that's too long keeps the draft's
  words; a part that fails whole stays the draft's, with no why), the method to 3 to 5 steps, and no long dashes. A
  part that comes back the same as the draft's counts as kept. Kept parts, niche and proof are copied from the draft
  exactly.
- **Improve, Write it for me and the niche finder** read the direction too.

## Commands, queries, routes and events

| What                  | Name                        | Who                                     | Notes                                                                                                                                                                     |
| --------------------- | --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save the direction    | `main_offer.save_direction` | `main_offer.manage`, risk 1             | `{workspaceId, revision, direction}`; empty clears it. Moves the revision on. Emits `main_offer.direction_saved`.                                                         |
| Keep a try            | `main_offer.try_save`       | the worker alone (`actors: ['system']`) | For the revision it read; `{saved: false}` when the draft moved on. Numbers it within the round. Emits `main_offer.try_made` (`{ number }`).                              |
| Apply picks           | `main_offer.try_apply`      | `main_offer.manage`, risk 1             | `{workspaceId, revision, tryId, take}`, at least one part. Merges, moves the revision on, says whether the line came too (`lineFromTry`). Emits `main_offer.try_applied`. |
| The round's tries     | `main_offer.tries`          | everyone in the business                | Newest first, up to 20, each whole with its lowest score.                                                                                                                 |
| The offer             | `main_offer.get`            | everyone in the business                | Gains `direction`.                                                                                                                                                        |
| Write and score a try | `POST /v1/main-offer/try`   | `main_offer.manage`                     | `{workspaceId, revision, notes, keep}` → `{saved, try}`. Two asks: write, then score.                                                                                     |

Every command refuses while no add-on that uses the main offer is on (`main_offer_not_in_use`), as the others do.
New refusals, in the error-message rules' words:

- `main_offer_all_kept` (422): "Every part is kept as is, so a try has nothing to change. Untick Keep this part as is
  on the part you want rewritten."
- `main_offer_try_gone` (409), with the version's number: "That try is from before version 3 went live. Make a
  new one from your draft."
- `main_offer_try_unchanged` (422), when the AI left every part it was free to change as it was: "The AI left every
  part as it was this time. Add a note on what you'd like changed, or try again."
- `main_offer_no_draft` and `main_offer_draft_moved`, as today.

Core still never names an add-on, and no add-on reads the tries. Social Outreach hears `main_offer.published` as now,
and nothing else here.

## Screens

- **The builder's last step** (`apps/web/src/components/main-offer/`): the part cards and the direction replace
  `OfferScoreView` on the builder; Versions, Compare and the applied state are new. The step keeps its address, with
  `&try=<id>` for the try being compared, so a reload opens the same comparison. The boards are on the canvas; they go
  into `design/main-offer` once approved.
- **Settings → Main offer**: the live version's parts show Working and Holding it back, read-only, and the direction
  shows under it with Edit your direction.
- **Words** in `packages/core/src/main-offer/words.ts`, once, as the rest of the builder's are, ready for the phone.
- **The phone** still shows nothing of the main offer (docs/main-offer.md, "Not yet").

## The database

One migration, numbered above the newest file in `supabase/migrations` (`20261027007800_main_offer_tries.sql` as of
today; check again before adding it):

- `app.main_offers.direction text`, checked at 1 to 2,000 characters or null.
- `app.main_offer_tries` as above, with `private.forbid_change` on update. Row security: everyone in the business
  reads (`private.accessible_workspace_ids()`); only the worker inserts (`service_actor`, its system scope), as the
  score's save does. Nothing updates or deletes a try; they go with the business.
- No new AI usage source: it's all `main_offer`.

Mirrored in Drizzle (`packages/db/src/schema/index.ts`), so the parity test holds. Applied to the hosted database
before `main` gets it ("Apply new migrations" in docs/operations.md).

## Tests

- **Core** (`packages/core/test/main-offer.test.ts`, `main-offer-assist.test.ts`): saving the direction moves the
  revision and unscores the draft; a try is kept only for the revision it read; applying merges only the picked
  parts, brings the line only when every changed part is picked and the draft hasn't moved, and refuses another
  round's try; `main_offer.tries` lists only the round's; scores kept before this still parse; the direction is fenced
  in every prompt; `checkedOfferTry` keeps kept parts, niche and proof exactly, drops over-long boxes and long dashes.
- **The database** (`packages/db/test`): members read tries; nobody but the worker writes one; nobody changes one.
- **The worker** (`apps/worker/test/main-offer.test.ts`): `/try` refuses without `main_offer.manage`, with no add-on
  that uses it, with every part kept, and with a moved draft; with the scripted stand-in it writes, scores and keeps
  a try. The stand-in gains a rule for the try's ask.
- **The browser** (`apps/web/e2e/main-offer.spec.ts`): leave a note, keep a part, write a direction, make a try,
  pick two parts, pick a line, see it scored, go live.

## Build order

Each step ships on its own, with its tests, and leaves the builder working.

1. **Core: the direction, the fuller score and the tries.** The migration and its Drizzle mirror, the score's new
   fields, `main_offer.save_direction`, `main_offer.try_save`, `main_offer.try_apply`, `main_offer.tries`,
   `main_offer.get`'s direction, the try's prompt and check, the direction in every prompt, the words, and
   `pnpm openapi`. Today's screens keep working: the new fields are optional and nothing calls the new commands yet.
   **Built.** The words for the screens are `MAIN_OFFER_TRY_WORDS`, `OFFER_NOTE_PICKS` and `OFFER_DIRECTION_PICKS`
   in `words.ts`.
2. **The worker: the try.** `POST /v1/main-offer/try`, the direction read by the score, Improve, Write it for me and
   the niche finder, and the scripted stand-in's rule. **Built.** The scripted score also answers what's working,
   what's holding a part back and its fix, and marks the who as scored with the direction when there is one, so the
   screens have something to show without a model.
3. **The web: Review, Compare and the applied step**, from the approved boards, and Settings → Main offer's Working,
   Holding it back and direction. **Built.** The boards are in `design/main-offer` (8 to 10). The step is **Review
   and go live**; under the bar its footer offers Use it anyway and Make a try, and each part's Edit it myself goes to
   its step. A try's comparison opens at `?step=score&try=<id>`. Saving the direction moves the revision on, so the
   draft's score clears until it's scored again. What a part says is core's `partSays`, for the web and the phone.
4. **Docs.** docs/main-offer.md: what's built, the direction and the tries under its rules, and the refusals.
   **Built**, with the README's main offer section and CLAUDE.md's Read first row.

## Answered (Chris, 2026-10-16)

1. **The direction is always kept.** The board's tick for "Keep this direction for every score and try" goes: the
   direction is kept until someone changes or clears it.
2. **A mix gets a new line to pick.** When only some of a try's parts are taken, the AI offers three new one-line
   offers and the few words for messages, and the owner picks one or keeps theirs.
3. **Applying scores right away.** Pressing Apply counts as asking for a score once the line is picked.
4. **Versions shows this round's tries only.** Tries made before the last version went live are kept but not listed.
5. **Social Outreach doesn't read the direction yet.** Its messages and video script are written from the live
   version's parts. Reading the direction there is a later change of its own.

## Not in this plan

- The main offer on the phone.
- A try for one part only. A note on one part with every other part kept does the same.
- Keeping the direction with each version. The version keeps its score, which says where the direction changed it.
- AI Sales Coach reading the direction, when it reads the main offer at all.
