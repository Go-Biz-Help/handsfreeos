# The main offer

The business's main offer: who it helps, the result, how fast, how, the guarantee and the price, built and scored
with the AI. It's core's, so add-ons share it without reading each other's data, and it shows only while an add-on
that uses it is on: Social Outreach now, AI Sales Coach later. The plan, with the owner's decisions and what comes
next, is `HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md`.

It isn't the promotions under Knowledge (`app.offers`, the `offer.*` commands: "$50 off a tune-up through October"),
HandsFreeOS's own founding offers, or Real Estate's offers on a home. Its name is `main_offer` in code and **Main
offer** on screen, everywhere.

## What's built

Steps 1 and 2 of the plan: the data, the commands and queries, showing it only with an add-on that uses it, the AI's
help, and the screens: Settings → Main offer and the builder, from the boards in `design/main-offer`.

| What                                   | Where                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its parts, the score, the bar          | `packages/core/src/main-offer/parts.ts` (browser-safe)                                                                                               |
| Commands                               | `packages/core/src/commands/main-offer.ts`                                                                                                           |
| Queries                                | `packages/core/src/queries/main-offer.ts`                                                                                                            |
| Schemas                                | `packages/core/src/schemas/main-offer.ts`                                                                                                            |
| Shown only with an add-on that uses it | `CORE_FEATURES` and the manifest's `uses` (`addons/manifest.ts`); `coreFeatureOn`, `coreFeatureRunning` and `addonsUsing` (`addons/capabilities.ts`) |
| The plain-writing rules                | `packages/core/src/writing.ts` (`PLAIN_WRITING`, `noDashes`), Social Outreach's before                                                               |
| Database                               | `20261027006100_main_offer.sql`: `app.main_offers`, `app.main_offer_versions`                                                                        |
| The AI's help: prompts and checks      | `packages/core/src/main-offer/assist.ts` (the niche finder, Improve and Write it for me, the score)                                                  |
| The AI's routes                        | `apps/worker/src/main-offer/routes.ts` (`/v1/main-offer/niche`, `/assist`, `/score`); the scripted stand-in's `MAIN_OFFER_RULES`                     |
| Examples by line of work               | `packages/core/src/main-offer/examples.ts`                                                                                                           |
| What the screens say                   | `packages/core/src/main-offer/words.ts`                                                                                                              |
| Settings → Main offer                  | `apps/web/src/app/app/w/[workspaceId]/settings/main-offer/`, `apps/web/src/components/main-offer/page.tsx`                                           |
| The builder                            | `apps/web/src/app/app/w/[workspaceId]/main-offer/build/`, `apps/web/src/components/main-offer/builder.tsx`, `box.tsx`, `score.tsx`                   |
| Tests                                  | `packages/core/test/main-offer.test.ts`, `main-offer-assist.test.ts`; `apps/worker/test/main-offer.test.ts`; `apps/web/e2e/main-offer.spec.ts`       |

- **The parts** (`MainOfferParts`): the niche finder (the best customer ever and who looks like them), then who, outcome,
  timeframe, method, guarantee and price, each with the workbook's follow-ups; proof (real results, a line each, up to
  10); the one-line offer; and the outcome and guarantee in a few words each, for messages, which never carry the price.
- **The score** (`MainOfferScore`): each of the six parts from 1 to 10 with why, the weakest part and its fix, the three
  ways offers fail (vague, generic, hard to believe), and whether a stranger sees the outcome in three seconds.
- **The draft** (`main_offer.save_draft`, `main_offer.discard_draft`): one a business, saved whole, with a revision that
  goes up with every save. A save names the revision it started from; a different one is refused
  (`main_offer_draft_moved`), so two editors never undo each other. The live version keeps running meanwhile.
- **The score's save** (`main_offer.score_save`): the worker's alone (`actors: ['system']`), for the revision the AI
  read. A draft that moved on meanwhile keeps no score (`saved: false`).
- **Publishing** (`main_offer.publish`): the draft becomes the next version, and `main_offer.published` (`{ version }`)
  goes out for the add-ons that use the offer. It's refused with nothing new (`main_offer_no_draft`), with a part
  missing (a validation error naming each, from `missingParts`), unscored or scored before its last change
  (`main_offer_not_scored`), and under the bar without a reason (`main_offer_below_bar`, 422, naming the lowest part
  and the AI's fix). **Use it anyway** sends `anyway`, kept with the version.
- **Reading** (`main_offer.get`, `main_offer.versions`): everyone in the business. `get` says whether an add-on that uses
  it is on (`inUse`), which add-ons bring it (`comesWith`), the bar, the revision, the live version and the draft with
  its score and what it still needs.
- **Shown only with an add-on that uses it:** an add-on's manifest names the parts of core it uses (`uses:
['main_offer']`, Social Outreach's today). Core's capability `sales.main_offer` is in `workspace.get`'s capabilities
  only while one runs, so the screens ask `can('sales.main_offer')`; core never names an add-on.

- **The screens.** Settings → **Main offer** shows only while an add-on that uses it is on (the settings menu's
  `feature`), to everyone in the business: the first-time card, the draft someone is working on (Open the draft, Throw
  it away), the live version with its parts, scores and quick checks, and the versions. The builder
  (`/main-offer/build`, `?step=` for one) opens over the app in the onboarding frame for `main_offer.manage`: the ten
  steps listed beside it with what's been answered, examples to tap for the business's line of work (`industry`),
  Improve or Write it for me under every box, and every move saving the draft. A draft opens where it is; with none,
  changing a live offer starts from it, on Who. The score step scores, then offers Go live, or, under the bar, Change
  the weakest part and Use it anyway with a reason.
- **The AI's help** (`/v1/main-offer/*`, `main_offer` usage): the niche finder reads the best customer, or with none
  suggests niches the business can reach; Improve rewrites what's in a box and Write it for me fills an empty one,
  three to pick from (for the method, three sets of steps); the score reads the draft as it's kept, never what the
  screen sends, and keeps it with the revision it read.

## Rules worth knowing before changing anything

- **One main offer a business** (the owner's decision, 2026-10-14). Each Social Outreach playbook narrows its who to a
  niche (plan, Part 2); a niche that needs another outcome or price is a second offer, which the AI says.
- **Every command refuses while no add-on that uses it is on** (`main_offer_not_in_use`, saying which add-ons bring
  it). The offer is kept, hidden, and comes back when one is on again; it goes only with the business. Reading still
  works, so an add-on turned off and on finds it as it was.
- **Every part clears 7 before it goes live** (`MAIN_OFFER_BAR`, the owner's answer of 2026-10-14), unless someone with
  `main_offer.manage` says why in a line (Use it anyway), kept with the version. Without that, an AI score could hold a
  business back for good.
- **A version never changes.** `app.main_offer_versions` refuses any update (`private.forbid_change`); the next change
  is the next version. Anything that remembers which version it used keeps the number, never a key into the table.
- **Only the worker scores.** A person's commands can't write a score, and a score is only for the revision it read.
- **`main_offer.manage`** (owners and admins to start, customizable) edits, discards and publishes. Everyone in the
  business reads it: the people reaching out say it.
- **What the AI writes for a person follows `writing.ts`:** plain words a 10-year-old knows, short sentences, no long
  dash, and `noDashes` on whatever comes back. Social Outreach's `voice.ts` re-exports the same two.
- **The AI never writes proof.** It tidies results the business typed (`main_offer_no_proof` with none), and its
  prompts say to put `[brackets]` where a number or name it wasn't given would go.
- **Examples are to model, never to copy,** and proof's examples are shown as words, not chips to tap: a result that
  isn't the business's own is no proof.
- **Not the promotions.** Nothing here reads or writes `app.offers`, and the promotions' commands stay `offer.*`.

- **How a version is doing comes from the add-on, never from core.** Core keeps no counts of messages and never reads
  an add-on's tables. The page has a place for panels (`main_offer.panels`, an `<AddonSlot>` under the live version),
  and Social Outreach puts its own there: the first messages, yeses and calls booked with each version, too new to
  judge before 100 first messages (docs/outreach.md, decision 68).

## Not yet

Social Outreach's playbooks read the live version (step 3: the niche, the AI's help, whether a niche fits;
docs/outreach.md, decision 62), nobody's outreach starts until the offer is live (step 4, Get ready: decision 63),
the AI checks each person's Facebook profile against it (step 5, decision 64), and every message is written from it,
each person reached keeping the version they were first sent (step 6, decisions 65 to 68). The numbers by version on
Social Outreach's Results, and hearing `main_offer.published`, are step 8.
The phone shows nothing of the main offer yet; its words are core's, ready for it.
