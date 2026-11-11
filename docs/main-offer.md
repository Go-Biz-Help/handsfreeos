# The main offer

The business's main offer: who it helps, the result, how fast, how, the guarantee and the price, built and scored
with the AI. It's core's, so add-ons share it without reading each other's data, and it shows only while an add-on
that uses it is on: Social Outreach and the AI Social Media Content Creator now, AI Sales Coach later. The plan, with the owner's decisions and what comes
next, is `HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md`; the notes, the owner's direction and the AI's tries on its
last step are `HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md`; that last step on the phone is
`HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md`.

It isn't the promotions under Knowledge (`app.offers`, the `offer.*` commands: "$50 off a tune-up through October"),
HandsFreeOS's own founding offers, or Real Estate's offers on a home. Its name is `main_offer` in code and **Main
offer** on screen, everywhere.

## What's built

The whole plan, steps 1 to 9, the tries plan, steps 1 to 4, and the phone plan, steps 1 to 4. Core's part is below:
the data, the commands and queries, showing it only with an add-on that uses it, the AI's help, the owner's direction
and the AI's tries, and the screens, Settings → Main offer and the builder on the web and Settings → Main offer on the
phone, from the boards in `design/main-offer` (the tries' are 8 to 10, the phone's 11 to 16).
Social Outreach's part (steps 3 to 8) is under **In Social Outreach**, and in full in docs/outreach.md, decisions 62
to 70. The lists for content (the owner's picks of 11 Nov 2026) are under **For your content**, and how the Content
Creator uses them under **In the AI Social Media Content Creator**.

| What                                   | Where                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its parts, the score, the bar          | `packages/core/src/main-offer/parts.ts` (browser-safe)                                                                                                                                                                                                                                                        |
| Commands                               | `packages/core/src/commands/main-offer.ts`                                                                                                                                                                                                                                                                    |
| Queries                                | `packages/core/src/queries/main-offer.ts`                                                                                                                                                                                                                                                                     |
| Schemas                                | `packages/core/src/schemas/main-offer.ts`                                                                                                                                                                                                                                                                     |
| Shown only with an add-on that uses it | `CORE_FEATURES` and the manifest's `uses` (`addons/manifest.ts`); `coreFeatureOn`, `coreFeatureRunning`, `coreFeatureHeld` and `addonsUsing` (`addons/capabilities.ts`)                                                                                                                                       |
| The plain-writing rules                | `packages/core/src/writing.ts` (`PLAIN_WRITING`, `noDashes`), Social Outreach's before                                                                                                                                                                                                                        |
| Database                               | `20261027006100_main_offer.sql`: `app.main_offers`, `app.main_offer_versions`; `20261027007800_main_offer_tries.sql`: the direction, `app.main_offer_tries`; `20261027010800_main_offer_names.sql`: the names; `20261027025900_main_offer_lists.sql`: the lists for content                                   |
| The AI's help: prompts and checks      | `packages/core/src/main-offer/assist.ts` (the niche finder, Improve and Write it for me, the score, a try)                                                                                                                                                                                                    |
| The AI's routes                        | `apps/worker/src/main-offer/routes.ts` (`/v1/main-offer/niche`, `/assist`, `/score`, `/try`); the scripted stand-in's `MAIN_OFFER_RULES`                                                                                                                                                                      |
| By asking the Assistant                | `packages/core/src/assistant/tools-main-offer.ts` (`edit_main_offer`, `main_offer_go_live`, `manage_main_offer`, `score_main_offer`, `try_main_offer`); `apps/worker/src/assistant/tools-main-offer.ts`                                                                                                       |
| Examples by line of work               | `packages/core/src/main-offer/examples.ts`                                                                                                                                                                                                                                                                    |
| The lists for content                  | `packages/core/src/main-offer/lists.ts` (browser-safe: the lists, their words, the AI's prompt and checks); `main_offer.save_list`; the route `/v1/main-offer/lists`; the Assistant's `help_main_offer_lists` and `manage_main_offer` (`set_list`)                                                            |
| For your content, on the screens       | `apps/web/src/components/main-offer/content-lists.tsx`; on the phone `apps/mobile/src/main-offer/lists.tsx`, route `settings/main-offer-lists` (`?list=` opens one)                                                                                                                                           |
| What the screens say                   | `packages/core/src/main-offer/words.ts`, with what the web and the phone both work out (`underBarTitle`, `offerChecks`, `goingInto`, `offerAiWords`, `offerStepOf`, `offerRowLine`)                                                                                                                           |
| Settings → Main offer                  | `apps/web/src/app/app/w/[workspaceId]/settings/main-offer/`, `apps/web/src/components/main-offer/page.tsx`                                                                                                                                                                                                    |
| The builder                            | `apps/web/src/app/app/w/[workspaceId]/main-offer/build/`, `apps/web/src/components/main-offer/builder.tsx`, `box.tsx`, `score.tsx`                                                                                                                                                                            |
| Its last step: review, compare, apply  | `apps/web/src/components/main-offer/review.tsx` (the part cards, the direction, Versions), `tries.tsx` (Compare, the applied step)                                                                                                                                                                            |
| On the phone                           | `apps/mobile/src/main-offer/` (`screen.tsx`, `review.tsx`, `live.tsx`, `try-ready.tsx`, `anyway-sheet.tsx`, `edit.tsx`, `row.ts`, `calls.ts`); routes `settings/main-offer`, `-part`                                                                                                                          |
| How a version is doing, from an add-on | `main_offer.panels`, an `<AddonSlot>` under the live version on Settings → Main offer; Social Outreach's is `apps/web/src/addons/outreach/offer-panel.tsx`                                                                                                                                                    |
| A new version, heard by add-ons        | `main_offer.published` (`{ version }`), under an add-on's `events.consumes`; Social Outreach's is `apps/worker/src/addons/outreach/tracking.ts`                                                                                                                                                               |
| Tests                                  | `packages/core/test/main-offer.test.ts`, `main-offer-assist.test.ts`, `main-offer-phone.test.ts`, `main-offer-lists.test.ts`; `packages/db/test/main-offer-rls.test.ts`; `apps/worker/test/main-offer.test.ts`; `apps/web/e2e/main-offer.spec.ts`; `apps/mobile/src/main-offer/__tests__/main-offer.test.tsx` |

- **The parts** (`MainOfferParts`): the niche finder (the best customer ever and who looks like them), then who, outcome,
  timeframe, method, guarantee and price, each with the workbook's follow-ups; proof (real results, a line each, up to
  10); the one-line offer; and the outcome and guarantee in a few words each, for messages, which never carry the price.
- **The score** (`MainOfferScore`): each of the six parts from 1 to 10 with why in a line, what's working (`good`),
  what's holding it back (`holding`), its own `fix`, and `followedDirection` when the owner's direction changed how it
  was judged; the weakest part and its fix, the three ways offers fail (vague, generic, hard to believe), and whether a
  stranger sees the outcome in three seconds. A score kept before the tries has only the number and why, so the rest
  is optional. `partSays` is what a part says in a line, for every screen that lists it.
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
- **The direction** (`main_offer.save_direction`): the owner's own words for the whole offer, up to 2,000 characters,
  on `app.main_offers`. Empty clears it. Saving it moves the revision on, so a score from before is stale and the
  draft is scored again against it. It stays with the offer after a version goes live.
- **The names the business goes by** (`main_offer.save_names`, `main_offer.manage`; Chris, 23 Oct 2026: other
  businesses use HandsFreeOS for their own, so the profile check needs to know the name to look for): up to 5, each
  up to 100 characters, on `app.main_offers` (`names`). Its company and the brand it sells, like "Go Biz Help" and
  "HandsFreeOS". Each is kept once, whatever its case. None means the business's name in HandsFreeOS
  (`namesGoneBy`), which `main_offer.get` returns beside them (`businessName`). They aren't scored or versioned, so
  saving them moves no revision. Social Outreach's profile check takes every one as the business's (docs/outreach.md,
  decision 84). Settings → Main offer shows them for everyone, and owners and admins add and remove them there, each
  change saved at once (`components/main-offer/names.tsx`); the phone shows them on the live offer.
- **A try** (`main_offer.try_save`, the worker's alone): a whole new version of the offer the AI wrote from the draft,
  the direction, the owner's notes on its parts and the parts to keep, with its own score, kept in
  `app.main_offer_tries` for the revision it read (`saved: false` when the draft moved on). It keeps the draft it
  read (`base`, what Restore puts back), why each part changed, and what it followed. Tries are numbered within a
  round, the live version they're beside (0 before the first); a new version starts a new round.
- **Taking parts in** (`main_offer.try_apply`, `main_offer.manage`): the picked parts go into the draft and the rest
  stays. The try's one line and few words come too only when every part it changed is taken into the draft it was
  written from (`lineFromTry`); otherwise the builder offers three new ones to pick from. A try from an earlier round
  is refused (`main_offer_try_gone`), and so is one with no draft (`main_offer_no_draft`).
- **Reading** (`main_offer.get`, `main_offer.versions`, `main_offer.tries`): everyone in the business. `get` says
  whether an add-on that uses it is on (`inUse`), which add-ons bring it (`comesWith`), the bar, the revision, the
  direction, the names, the lists for content and the business's name, the live version and the draft with its score and what it still needs. `tries` lists the round's, the
  newest first, up to 20.
- **Shown only with an add-on that uses it:** an add-on's manifest names the parts of core it uses (`uses:
['main_offer']`, Social Outreach's and the Content Creator's today). Core's capability `sales.main_offer` is in `workspace.get`'s capabilities
  only while one runs, so the screens ask `can('sales.main_offer')`; core never names an add-on.

- **The screens.** Settings → **Main offer** shows only while an add-on that uses it is on (the settings menu's
  `feature`), to everyone in the business: the first-time card, the draft someone is working on (Open the draft, Throw
  it away), the live version with its parts, scores and quick checks, and the versions. The builder
  (`/main-offer/build`, `?step=` for one) opens over the app in the onboarding frame for `main_offer.manage`: the ten
  steps listed beside it with what's been answered, examples to tap for the business's line of work (`industry`),
  Improve or Write it for me under every box, and every move saving the draft. A draft opens where it is; with none,
  changing a live offer starts from it, on Who. The last step, **Review and go live**, scores; each part shows what's
  working, what's holding it back and the AI's fix, with a note for the AI and Keep this part as is; the owner's
  direction sits under them; and **Make a try** writes one beside the draft, compared part by part
  (`&try=`) and taken in a part at a time. Then Go live, or, under the bar, Use it anyway with a reason. Opened from
  somewhere else (Social Outreach's setup), `?back=` names where leaving it and going live go back to: a path in the same
  business only, checked as sign-in's `next` is (`safeNext`); anything else goes to Settings → Main offer.
- **On the phone**, Settings → This business → **Main offer** (the third exception to business setup staying on the
  web, 2026-10-16) shows for anyone holding a permission of an add-on that uses the offer (`coreFeatureHeld`, so it
  shows with no signal), with how the live version and the draft are doing under it. The screen needs signal: it asks
  `main_offer.get` and `main_offer.tries` and keeps nothing. Whoever has `main_offer.manage` gets **Review and go
  live** as the web has it: the score at a glance, each part's card with a note, Keep this part as is and Edit it
  myself (that part's boxes, the method's steps' words only), the direction, Score my offer, Make a try, Go live and
  Use it anyway. A try made there shows how each part scored before and after, and **Compare on the web** opens the
  builder on it (`?step=score&try=`): comparing and taking parts in stay on the web. With no draft, the first change
  keeps the live version's parts as the draft. Everyone else reads the live version. **For your content** is its own
  screen there, with the AI's help as on the web. A first offer, the niche, proof
  and the one line are built on the web (**Open on the web**). A web link to Settings → Main offer opens the phone's
  screen.
- **The AI's help** (`/v1/main-offer/*`, `main_offer` usage): the niche finder reads the best customer, or with none
  suggests niches the business can reach; Improve rewrites what's in a box and Write it for me fills an empty one,
  three to pick from (for the method, three sets of steps); the score reads the draft as it's kept, never what the
  screen sends, and keeps it with the revision it read. Every route reads the owner's direction when there is one.
  **A try** (`/v1/main-offer/try`) is two asks: one writes the whole offer from the draft as it's kept, the direction,
  the notes and the parts to keep, and the other scores it. It's refused with every part kept
  (`main_offer_all_kept`), and says so when the AI changed nothing it was free to change
  (`main_offer_try_unchanged`).

## For your content

The owner, 11 Nov 2026 (picks 1a 2a 3a 4a 5a 6b 7b): lists the AI Social Media Content Creator writes every post and
idea from, with the AI's help to fill them.

- **Eleven lists** (`OFFER_LISTS`, `OFFER_LIST_INFO` for each one's label, hint, example and what the AI is told):
  what makes you different, features and benefits, problems your customers have, questions and worries with your
  answers, before and after, your story, topics you want to be known for, myths in your line of work, your voice,
  what to ask people to do, and never say. Up to 12 lines a list, each up to 300 characters, kept once whatever its
  case (`cleanListLines`).
- **Kept on the offer, not on a version** (`app.main_offers.lists`, a JSON object of list to lines). Like the names
  and the direction they aren't scored or versioned, never hold the offer back from going live, and saving them moves
  no revision. They're read safely (`listsOf`): an unknown list, a line that isn't text and an empty list are left out.
- **Saved a list at a time** (`main_offer.save_list`, `main_offer.manage`, risk 1): the whole list, as the screen or the
  Assistant has it. An empty list clears it, nothing changed saves nothing, and `main_offer.list_saved` goes out with
  the list before and after. `main_offer.get` returns them (`lists`) to everyone in the business.
- **The AI's help** (`/v1/main-offer/lists`, `main_offer` usage), four ways, from the business, its line of work, the
  live offer (or the draft's parts, without the price), the owner's direction, the lists and a short read of the
  Knowledge base: **Write it for me** gives new lines for a list, as many as it has room for, up to 7; **Improve**
  rewrites one line three ways; **Examples** gives up to 5 lines to model, for a business in the same line of work,
  never naming a real company or claiming real results; and **What's missing** says which lists are empty or thin, up
  to 5. What comes back is checked (`checkedOfferLists`): no line the list has, none twice, no long dashes, and never
  the line it was asked to improve. Nothing is saved until the person keeps a line.
- **The screens.** Settings → Main offer shows **For your content** under the names, a row a list with how many lines
  it has. Owners and admins open a row to add, change and remove lines, with the AI's buttons under it, each change
  saved at once; everyone else reads them. The phone has the same as its own screen (decision 6b), linked from the
  main offer's screen whatever state the offer is in.
- **By asking the Assistant**: `help_main_offer_lists` asks the AI as the buttons do and saves nothing (it runs on its
  own); `manage_main_offer` with `set_list` saves a whole list on a card, which waits for the person's OK.

## In the AI Social Media Content Creator

It declares `uses: ['main_offer']` (the owner's pick 4a: only the Content Creator reads the lists) and hears
`main_offer.published`. docs/socialcontent.md has the rest.

- **No post or idea is written until the offer is live** (7b, as Social Outreach does): writing, rewriting, filling
  the calendar and suggesting ideas are refused (`socialcontent_offer_not_live`), and the Calendar and Ideas say so
  with a link to Settings → Main offer. The research and the Playbook go on.
- **Every post and idea is written from it**: the live version's parts, never the price, and the lists, each quoted
  in its own block (`offerForContent`), with never say as hard rules.
- **When a version goes live**, a calendar that was filled before and fills on its own is filled again at once.

## In Social Outreach

Social Outreach declares `uses: ['main_offer']` and reads the live version wherever it writes or checks anything:

- **A playbook narrows the offer's who to a niche** (step 3, decision 62): its niche, their problem, proof and
  something useful to send. The AI's help on a playbook reads the live offer, and `outreach.playbook.niche_fit` says
  when a niche needs another outcome or price, which is a second offer.
- **Nobody's outreach starts until the offer is live** (step 4, decision 63): Get ready's first item is the main offer,
  and `readinessFor` holds Start my day, Today's list and the helpful post until every item is done. Someone who can't
  build the offer waits on an owner or admin, told who to ask.
- **The person's own Facebook profile is checked against it** (step 5, decision 64): the AI reads what the extension
  read and says what to change, with bios written from the offer.
- **Every message is written from it** (step 6, decisions 65 to 68): the first message is one short question that makes
  them curious (Social Outreach's decision 137), and no message carries the guarantee unless they ask (decision 65, 2026-10-26); a yes gets the playbook's short video, then the booking link; follow-ups
  come until they answer. Each person reached keeps the version they were first pitched with (`follow_ups.offer_version`,
  `sends.offer_version`), so nobody hears a new price or guarantee mid-conversation. Get ready's **Your messages**
  shows samples written from the live version, and a new version asks again.
- **The short video's script is written from it** (step 7, decision 69), and says when it was written for an older
  version.
- **How each version is doing** (step 8, decision 70): Results shows the first messages, yeses and calls booked by
  version, and the main offer's page shows the live one's through `main_offer.panels`, too new to judge before 100
  first messages. Hearing `main_offer.published`, the worker tells whoever OK'd their messages against an older
  version to look again.

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
- **The lists for content are the business's own words.** The AI's lines are suggestions until a person keeps one,
  its examples are to model, and it never writes a result for a list (the proof rule holds). They aren't scored and
  never hold the offer back, and only add-ons that declare `uses: ['main_offer']` read them, from `main_offer.get` or
  the worker's `app.main_offers.lists`; today that's the Content Creator alone.
- **Not the promotions.** Nothing here reads or writes `app.offers`, and the promotions' commands stay `offer.*`.
- **The owner's direction follows them over the coaching rules** (Chris, 2026-10-16): a broad who on purpose isn't
  marked down for being broad, and the part says it was scored that way. It never outranks the rule on inventing
  nothing, the plain-writing rules, or the scale and the bar, and anything it says about scores is ignored. It's
  quoted as data in every prompt, like the owner's notes.
- **The Assistant can do what the screen does** (the owner, 2026-10-26: whatever the person can). Someone with
  `main_offer.manage` can ask it to change any box, the steps or the results, score the draft, write a try and take
  its parts in, set the direction and the names, throw the draft away, and put the draft live. Every change shows a
  card and waits for their OK, so what it writes is used only once they pick it; a score and a try are the
  builder's own (`offerScore`, `offerTry`) and change nothing in the offer. Going live holds to the bar as the
  screen does: under it, only with the person's own reason. Results go in only as the person gave them.
- **Nothing the AI writes is used until a person picks it.** A try sits beside the draft and never changes
  (`private.forbid_change`); only `main_offer.try_apply`, a person's pick, moves its parts into the draft, and every
  part starts on the draft's side. Kept parts, the niche and proof are the draft's exactly in every try.
- **Only the worker keeps a try,** for the revision it read, as only it keeps a score. People read tries; nobody
  writes or changes one.
- **The phone reviews; the web builds and compares** (Chris, 2026-10-16). The phone's commands are all `online` in its
  contract and it keeps nothing of the offer, because each one is for the draft's revision as the server has it now.
  What both show or decide is core's (`words.ts`), never worked out twice.

- **How a version is doing comes from the add-on, never from core.** Core keeps no counts of messages and never reads
  an add-on's tables. The page has a place for panels (`main_offer.panels`, an `<AddonSlot>` under the live version),
  and Social Outreach puts its own there: the first messages, yeses and calls booked with each version, too new to
  judge before 100 first messages (docs/outreach.md, decisions 68 and 70).
- **An add-on hears a new version; what it does about it is its own.** Core emits `main_offer.published` and nothing
  more. An add-on that keeps work made from an older version (Social Outreach's OK'd messages, a video's script) says
  so where that work is shown, worked out from the version it kept, and may tell people (Social Outreach's push).
  Nothing an add-on keeps is rewritten when a version goes live.
- **A new add-on that uses the offer** declares `uses: ['main_offer']` (docs/addon-architecture.md, "Parts of core only
  some add-ons use"): the capability, Settings → Main offer and the commands then come on with it, and
  `comesWith` names it to anyone the commands refuse. It reads the live version with `main_offer.get`, or in the
  worker straight from `app.main_offers` and `app.main_offer_versions`; it never writes them.

## Not yet

- **Social Outreach doesn't read the direction yet.** Its messages, profile check and video script are written from
  the live version's parts, which carry what the direction asked for. Reading the direction there is a change of its
  own.
- **A try for one part only** isn't built: a note on that part with every other part kept does the same.
- **On the phone, the last step and the lists for content only.** Comparing a try and taking its parts in, building a first offer, the niche
  finder, Improve and Write it for me, adding or moving the method's steps, throwing a draft away and the list of
  versions are the web's; so are add-ons' panels under the live version. Nothing of the offer is kept on the phone to
  read with no signal.
- **No warning when publishing too soon.** The plan's "too soon to change" warning at publish (fewer than 100 first
  messages, or under two weeks old) isn't built: the live version's panel says it's too new to judge instead, and
  publishing never asks. Its age isn't checked anywhere.
- **Social Outreach doesn't read the lists for content** (the owner's pick 4a): only the Content Creator does.
- **AI Sales Coach doesn't read it yet** (the plan's Part 3): when it does, it declares `uses: ['main_offer']` and reads
  the live version for the pitch, the guarantee's conditions and the price.
- **One offer a business, one video a playbook.** A second offer, and each person's own video, are later.
