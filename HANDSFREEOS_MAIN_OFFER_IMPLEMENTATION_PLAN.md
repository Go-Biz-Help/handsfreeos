# The main offer, and getting ready for social outreach

A business that has never done outreach usually fails at it for one reason: nobody wants what it's offering, said the
way it says it. This plan builds two things to fix that before the first message goes.

1. **The main offer**, in core: an AI-assisted builder that turns "we do marketing" into "We help roofers with 2 to 3
   crews get 10 to 20 booked roof inspections in 60 days, using…, and if we don't, you don't pay." It's the business's
   own, kept in versions, scored by the AI, and read by any add-on that uses it: Social Outreach now, AI Sales Coach
   later.
2. **Social Outreach, rebuilt around it**: a readiness check that holds the first day until the offer, the person's
   profile, their message and their targets are ready; a direct first message once someone accepts a friend request;
   a short pitch video they record from a script the AI writes; follow-ups that keep going until someone answers; and
   daily numbers that say what to fix.

Where it comes from: the "20 Bookings Per Month" workbook (Agency Growth Partner, edition 2026), Module 1 (Offer) and
Module 2 (Social Outbound), and the transcripts of the two videos that go with them. Modules 3 to 5 (cold email, sales
calls, coaching) are out of scope; Module 4 is a fit for AI Sales Coach later.

**Where it stands (2026-10-14):** step 1 is built on branch `claude/main-offer-plan` (docs/main-offer.md): the data,
the commands and queries, and showing it only with an add-on that uses it. Current offers are **Promotions** on
screen. Its migration, `20261027004100_main_offer.sql`, isn't on the hosted database yet. Social Outreach is in
`development`.

## Decisions (Chris, 2026-10-14)

| Question              | Answer                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the offer lives | **In core**, so add-ons can share it without reading each other's data. It **shows only while an add-on that uses it is on** (Social Outreach, AI Sales Coach, maybe others later).                                                                                                                                                                                                                      |
| How many              | **One main offer per business.**                                                                                                                                                                                                                                                                                                                                                                         |
| Niches                | **Each playbook narrows the offer's "who"** to one niche, with that niche's biggest problem and its own proof. Outcome, timeframe, method, guarantee and price stay the offer's. A niche that needs a different outcome or price is flagged by the AI as really a second offer.                                                                                                                          |
| Changing the offer    | **Drafts, then publish.** Editing makes a draft; the live version keeps running. The AI scores a draft before it goes live. Publishing flags what was built from the old version (profile text, first message) for a redo. Anyone already pitched keeps hearing the version they were pitched. Results are kept per version. The AI warns when the live version hasn't had enough messages to judge yet. |
| Getting ready         | **It blocks.** No outreach day starts until the readiness check is done, and it's worded as getting them the best results, never as a punishment.                                                                                                                                                                                                                                                        |
| The profile           | **The extension reads the person's own Facebook profile, scores it, and makes or suggests the changes**, putting in the words after their OK. Photos get tips only.                                                                                                                                                                                                                                      |
| Warming up            | **Likes and comments on their posts first**, in groups or on their own profile, then the friend request.                                                                                                                                                                                                                                                                                                 |
| After they accept     | **Direct.** The first message asks if they'd be open to the outcome on the guarantee, opening with something personal (their business, their job, something they posted) only when it's real and on topic. This replaces decision 47's "pitch only once the AI says they're ready" for new friends.                                                                                                      |
| The short video       | **The AI writes the script and the shot list**: what to say and what to show, part by part, with recording tips. The person records it and pastes its link.                                                                                                                                                                                                                                              |
| What we don't build   | **Extra or rented accounts** (the video's way to scale): against Facebook's rules and a risk to the business's own account. **AI voice notes**: the video says they don't convince yet, and the extension doesn't send audio.                                                                                                                                                                            |

Carried over, not re-asked:

- Every change is a command; security lives in the database; add-ons never touch each other, and core never names an
  add-on (CLAUDE.md, docs/addon-architecture.md).
- Social Outreach's settled rules stand unless this plan names the one it changes (docs/outreach.md, "The owner's
  decisions" and "Rules worth knowing before changing anything"). The changes are listed in "What this changes in
  Social Outreach's decisions" below.
- What the AI writes for a person follows decisions 53 to 55 (`voice.ts`): plain words, short sentences, no long
  dash, their voice, a message as a few texts.
- Nothing the AI writes is used until a person picks it, and it counts against the business's daily AI limit.

## What the repo has, and what it's missing

**Has.**

- The business profile (`app.knowledge_profiles`, `packages/core/src/knowledge/profile.ts`): description, services
  with prices, service area, tone. `workspaces.industry` and the Getting started goal. Enough to prefill a builder.
- Social Outreach's playbooks (`addons/outreach/playbooks.ts`): an `offer` line (300 characters, "A demo"), `audience`,
  `area`, `tone`, `link`, openers, the conversation, a pace (`messageAfterDays`, `followUpAfterDays`).
- AI help on each part of a playbook (`playbook-assist.ts`, the worker's `outreach.playbook.assist`): the pattern the
  offer builder copies.
- Core AI work run from the worker on its own route, behind a permission (`/v1/knowledge/try`): the pattern for a
  core feature's AI.
- The extension already writes on Facebook (comments, messages, group posts in `src/facebook/compose.ts` and
  `auto.ts`) and reads other people's profiles (`lookup.ts`).

**Missing.**

- **A name.** "Offer" is taken three times: core's **Current offers** (`app.offers`, Knowledge → Offers: "$50 off a
  furnace tune-up through October", read by the AI teammate and campaigns), HandsFreeOS's own **founding offers**
  (`platform.founding_offers`), and Real Estate's **purchase offers** on a home. The new thing is the **main offer**
  everywhere: `main_offer` in code, **Main offer** on screen. Nothing here renames Current offers.
- **A core feature that shows only for certain add-ons.** Core's capabilities are always on, and a manifest's
  `requires` is add-on to add-on. Core can't name `outreach`, so the add-on has to declare what it uses.
- **Anything about the person's own Facebook profile.** The extension finds its link only to skip it.
- **A positive reply.** Results count replies and demos; nothing says a reply was a yes.
- **A follow-up sequence.** Today follows up once per gap, only on chats the AI read as a likely prospect, with no
  count per person.
- **Somewhere to keep a video.** Core files take no video and attach only to records. A link is enough (Loom, YouTube,
  Google Drive), so the plan keeps a link, not a file.

## Part 1: the main offer, in core

### What it holds

Each part is what the workbook asks, in its order. Every part has examples to model for the business's line of work
(below), **Improve** and **Write it for me**, as a playbook's parts do.

| Part             | What's asked                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Niche finder** | Before the offer, and skippable: the best customer ever, their line of work, their size when they came, the result, how long it took, who else looks just like them. |
| **Who**          | The line of work (specific), the slice of it (by its problem or its size), the size or revenue, and the single most painful problem they have.                       |
| **Outcome**      | The result, measurable ("10 to 20 booked inspections a month"), how it's measured, and why it matters to them.                                                       |
| **Timeframe**    | How long it usually takes, and why that's realistic.                                                                                                                 |
| **Method**       | The system in 3 to 5 steps, and what's different about it compared with others who do the same.                                                                      |
| **Guarantee**    | What's promised if it doesn't work, when it applies, and who qualifies (so bad fits don't hold them to it).                                                          |
| **Price**        | The price, how it's built (flat, setup plus monthly, per result), and why it's worth it from the customer's side, with the math.                                     |
| **Proof**        | Real results for real customers, each in a line ("A 3-crew roofer got 14 inspections in 30 days"). Up to 10. Never invented.                                         |

From those the builder writes:

- **The one-line offer**: "We help [who] get [outcome] within [timeframe] using [method]. If [guarantee and when].
  [Price]." Owners can edit it.
- **The outcome and guarantee in a few words each**, for messages ("10 to 20 booked inspections in the next 30
  days", "you only pay for results"). Messages never carry the price.

### The AI's help

All of it runs in the worker on core's own routes, behind `main_offer.manage`, counted as a new AI usage source
(`main_offer`, a value added to `app.ai_usage_source` and its Drizzle mirror).

- **Niche finder** (`/v1/main-offer/niche`): from the best-customer answers, the niche to start with and why ("proof
  beats potential"). With no past customers, it picks the most painful problem in a line of work the business can
  easily reach, and says what kind of lead those businesses want most (the video's market research step).
- **Improve and Write it for me** (`/v1/main-offer/assist`): three to pick from for each part, from the offer as it
  stands and the business profile. The rule it holds to: every business wants more money, or more time to make
  more money; the outcome says which.
- **The score** (`/v1/main-offer/score`): each of the six parts from 1 to 10 with a line on why, the weakest part and
  the fix, and three checks from the video:
  - **Vague**: "grow your business" says nothing to grab onto.
  - **Generic**: "we do Facebook ads" sounds like everyone.
  - **Hard to believe**: a big promise with no proof and no conditions.
  - It also runs the video's **3-second test**: could a stranger see the outcome in three seconds?
- **Expectation, not a promise.** The AI is told the outcome is what's possible for a customer who qualifies, not a
  promise to everyone it's sent to. It flags a big claim with no proof behind it, and an outcome the business doesn't
  control (revenue, when it only delivers leads).

What the AI writes for the builder follows the same plain-writing rules as Social Outreach. `PLAIN_WRITING` and
`noDashes` move from the add-on's `voice.ts` into core (one copy), and the add-on imports them from there.

### Examples to model

The workbook's examples are written for marketing agencies. The builder's are written per line of work, from
`industries.ts`: home services, health and beauty, professional services, agencies, and the rest, in core's words
file for the offer. A line of work without its own examples gets the AI's, marked as such. Examples are there to
model, never to copy, and the screen says so.

### Versions and changes

- `app.main_offers`: one row per business: the draft (what's being edited, with who and when) and which version is
  live.
- `app.main_offer_versions`: each published version, never changed after: its number, every part, the one-line offer,
  the short outcome and guarantee, the score, who published it and when.
- **Commands:** `main_offer.save_draft`, `main_offer.publish`, `main_offer.discard_draft`, and the worker's
  `main_offer.score_save`. Publishing needs a scored draft with every part filled. **Queries:** `main_offer.get` (live version and draft) and
  `main_offer.versions`.
- **Events:** `main_offer.published` (`{ version }`). Add-ons that use the offer list it under `consumes`.
- **Too soon to change:** publishing while the live version has fewer than 100 first messages sent, or is under two
  weeks old, warns with the numbers ("Your offer has gone to 34 people. Most need about 100 before you can tell if it
  works."). It never refuses: the owner decides. Each add-on that uses the offer reports its own count through a core
  query it registers, so core never reads an add-on's tables. Built with the builder, in step 2.

### Who sees it, and only with an add-on that uses it

- **A manifest field, `uses`:** the core features an add-on needs, checked by `manifestIssues`. Social Outreach
  declares `uses: ['main_offer']`; AI Sales Coach will too.
- **A core capability, `sales.main_offer`**, current only while an add-on that uses the offer runs (`coreFeatureOn`,
  and `coreFeatureRunning` from the add-ons running). `workspace.get` hands it to the screens, so the web's Settings
  nav, the account menu and the phone ask `can('sales.main_offer')`. Every command refuses while no add-on running
  uses it (`main_offer_not_in_use`, with words saying which add-ons bring it).
- **When every add-on that uses it is off:** the offer is kept and hidden, like an uninstalled add-on's data, and comes
  back when one is on again. It goes only with the business.
- **Permissions:** everyone in the business reads it (`workspace.read`), and `main_offer.manage` (owners and admins,
  to start, customizable) edits, discards and publishes it, Use it anyway included. Screens ask for the permission.
- **Where:** Settings → **Main offer**: the live version, the score, the draft if there is one, and the versions. The
  builder opens over the app in the onboarding frame, a step at a time, as Social Outreach's setup does, with a
  summary beside it.

### What it means for the database

- One migration for the two tables, their row security (everyone in the business reads; `main_offer.manage` writes
  through the commands), the permission seeds and the new AI usage source. Numbered above the newest file in
  `supabase/migrations`, not by date. Mirrored in Drizzle.
- No foreign key into any add-on. An add-on that keeps which version something used keeps the version number, not a
  key into core's table it can't lose.

## Part 2: Social Outreach

### The playbook narrows the who

New parts on a playbook, in the builder after the goal, all checked by `PlaybookDetails`:

- **Niche**: who inside the offer's who ("roofers with 2 to 3 crews"). The AI checks it fits inside the offer's who,
  and says when it looks like a second offer instead.
- **Their biggest problem**: the niche's own pain, for the personal line and the video.
- **Proof for this niche**: picked from the offer's proof, or one of its own. Never invented.
- **The video's link and script** (below).
- **Something useful to send**: a link worth sending to someone who never answered (a guide, a checklist, a video),
  for the monthly check-in.

The playbook's `offer` line and `link` stay: the offer line becomes the short outcome, filled in from the main offer
and editable, and `link` stays the booking page. The `pace` changes (below). This is **data version 3**: a
`dataMigrations` step and `upgradePlaybookDetails` fill the new parts empty and turn the old pace into the new one.
The **CRM demos** template is rewritten in the new shape.

### Getting ready (the readiness check)

A new part of Social Outreach's setup, after the playbooks: **Get ready for your best results**. It lists five things,
each with why it matters in one line and what's left. Nothing outreach-like happens until all five are ticked.

| Item                        | Done when                                                                                                                                              | Whose                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **Your main offer**         | A version is live and every part scores 7 or more, or an owner chose **Use it anyway**.                                                                | The business                          |
| **A playbook with a niche** | A playbook in use has its niche, the niche's problem and its proof.                                                                                    | The business                          |
| **Your profile**            | The extension has read their Facebook profile since the offer went live, and every item on the profile list is done or ticked as done by hand (below). | Each person                           |
| **Your messages**           | They've seen sample first messages and the follow-ups for their playbook and OK'd the style, and the playbook has its video link.                      | Each person, the video the business's |
| **Your numbers**            | They've set a monthly goal for calls booked and their working days, and seen what it takes each day.                                                   | Each person                           |

How it holds:

- `outreach.day.start` refuses with rule `outreach_not_ready` and words naming what's left ("Your profile isn't ready
  yet. Finish it under Get ready on the Today tab.").
- Today's list shows nothing to send while someone isn't ready: one card, **Get ready**, with what's left. The
  extension works only from Today's list, so it does nothing on its own either. Its panel shows the same card.
- What only reads still runs: the steps before the first day (decision 60's lists, groups and checks), the asks from
  the app, Read my chats, Find posts. They make the first day better, and they need no offer.
- Steps the person takes on Facebook themselves are still noted. Nothing can stop them, and the check never pretends
  it can.
- A member who isn't an owner or admin and is waiting on the business's two items sees "Waiting on your business's
  main offer. Ask an owner of this business to finish it under Settings → Main offer.", and can do their own three
  meanwhile.
- **When the offer changes**, the profile and messages items go back to "Look again" for everyone, with what changed.
  Today keeps working on the new version meanwhile: a change never stops a day that's going.
- Worked out each time from what's kept (`outreach.readiness`), never stored as a flag; the person's OKs are kept in
  `addon_outreach.setup`.

### Your profile: the extension reads it, scores it, and fixes the words

- **A new ask, `profile_read`:** the extension opens the person's own profile, in a window of its own, and reads its
  picture's alt text, the cover's, the short bio, the intro's lines (work, lives in), the featured items, and the
  latest posts. The lines go to the AI and are let go once it answers, like a check (decision 46).
- **The AI scores it** against the workbook's checklist, made for Facebook. "Your profile does half the selling", but
  the aim is that it doesn't hurt:
  - a profile picture that's a clear face, not a logo;
  - a cover that says the outcome, not a sales pitch;
  - a bio that says what they do and for whom, from the offer (Facebook's short bio, 101 characters);
  - a work line that names the business and links its page;
  - featured items: a result, a review, the booking link;
  - posts that show who they are and some proof, not only selling.
- **What it writes:** three bios to pick from, a cover line to put on an image, what to feature, and a line for each
  item that's missing.
- **A new ask, `profile_edit`:** with the person's OK, the extension opens **Edit bio**, puts in the one they picked,
  saves, and reads it back to check. Anything it can't find is handed to the person (**Carry on**), as asks do.
  Photos, the cover and featured items are tips only: the person ticks them done.
- Both kinds go in `ASK_KIND_SINCE` with the build they ship in, and the extension's version goes up.
- Like the rest of the extension's presses, it's tuned from page outlines and not yet tried on the owner's account
  until it has been.

### Your numbers: daily targets from a monthly goal

- **The goal**: calls booked a month. **Working days**: 5 or 6 a week. Sunday warns ("Sundays rarely work for
  outreach"), but it's their call. The working days are the existing `WorkingHours.days`.
- **The math**, shown as it's worked: calls a month ÷ working days = calls a day; ÷ booking rate = positive replies a
  day; ÷ positive reply rate = messages a day. Until they have their own numbers it uses the video's: 4 to 8% of
  messages get a positive reply, and about 1 in 3 positive replies books. After 100 messages it uses theirs.
- **Honest about Facebook's pace.** A message is a first message or a follow-up; a friend request is never counted as
  one (the video's first common mistake). One Facebook account's safe pace is far below the video's 100 messages a day
  (`DAILY_LIMITS`: 15 first messages and 20 follow-ups), which comes to roughly 4 to 8 calls a month from first
  messages. A goal above what the limits allow says so plainly, and what helps: more friends to message (Reconnect),
  helpful posts that bring warm leads, and working Saturdays. Limits aren't raised by this plan; more platforms add their own.

### The conversation: warm up, ask directly, send the video, send the link, follow up

This is the video's three-step conversion system, after a warm-up, on Facebook.

1. **Warm up.** Like one of their posts first (decision 33, as now), and now also a comment on one of their own
   posts when the AI finds one on topic, where it would have commented on a group post. The like-pick already reads
   up to 6 of their posts; the comment uses the same reading. It counts against the comment limit. Then the friend
   request.
2. **They accept: ask directly.** The first message (`Say hi`, renamed **First message**) is the workbook's script,
   made personal:
   - an opening line about them (their business, their job, a post) only when the look-up found something real and
     it fits the offer;
   - then: open to [the short outcome] on [the short guarantee]?;
   - then: if so, they'll send more info.
   - Never the price, never a long story. Its only job is a yes.

   `TASK.opener` in `today.ts` ("Don't pitch yet") is rewritten. The openers stay (decision 23): a style is now the
   way the personal line is written, and an own opener can use `{outcome}` and `{guarantee}` beside `{first name}`.
   Reconnect's drafts (decision 46) stay without a pitch.

3. **They answer.** The AI's read of the chat (`chat-read.ts`) gets one more answer, `reply`: **yes** (send more
   info, sounds good), **question** (price, how it works, proof), **later**, or **no**. A yes is a **positive reply**,
   counted and kept with when (`stages`, `positive_at`). A no marks them not a fit, as now.
4. **Yes: send the short video.** The next draft (**Send the video**) is the playbook's video link with a line or two:
   here's a short video on how it works and how others got results, and if a quick call where they can see how it
   would work for their business sounds good, just say. The draft sells the call, not the service.
5. **A question: answer it and sell the call.** Short answers, and why a call helps them (they get a plan for their
   business, with their numbers), never a reason they'd skip it. The price is answered honestly when asked.
6. **They want the call: send the link.** The existing Pitch draft becomes **Send the link**: the booking link (the
   demo link, decision 24) and a line. A booking through it counts as a demo, as now.
7. **They go quiet: follow up.** At any of those steps, the follow-ups go on until they answer or say no:
   - 5 to 7 in all (a playbook choice, 6 to start), 1 day apart for the first three, then 2 days;
   - each short, a nudge that fits where they stopped, never a repeat;
   - after the last, a check-in once a month with the playbook's **something useful to send**, until they answer or
     the business stops it;
   - kept per person and step (`addon_outreach.follow_ups`: how many, the last one, the next due), so Today knows
     whose turn it is. A follow-up no longer needs the AI to have read the chat as a prospect: someone who got a
     first message is enough.

Today's kinds in order: Asking for what you offer, replies owed, Send the link, Send the video, First message, follow-
ups, Reconnect, comments, likes, friend requests. Each keeps its limit (First message and Reconnect share the first
messages; the rest share the follow-ups, as Pitch does now).

**The pace** on a playbook becomes `messageAfterDays` (as now), `followUps` (5 to 7) and `followUpGaps` (the days
between). `followUpAfterDays` goes, moved by the data step.

**Anyone pitched keeps their version.** A first message, the video and the link note the offer version they were
sent with (`sends.offer_version`). Follow-ups and answers to that person use that version's words, so nobody hears a
guarantee that changed halfway through.

### The short video: script and shot list

On the playbook, under **Your short video**:

- **The script**, 2 to 4 minutes, from the offer and the playbook's niche, in parts, each with what to say and what to
  show:
  1. Who it's for, and the problem (face to camera).
  2. What it costs them to leave it (face to camera).
  3. The method's steps (a simple slide or the screen).
  4. Proof: one or two real results (a screenshot, a review, a before and after).
  5. Why a call helps them: what they'll get from it (face to camera).
  6. What to do next: reply and they'll send times (face to camera).
- **Recording tips**: light in front, a quiet room, a wired or clip-on mic, eye level, one take is fine, under 4
  minutes, the video's thumbnail is their face.
- **The link**: Loom, YouTube (unlisted) or Google Drive, an https link checked like the extension link
  (`extensionLinkProblem`'s rules).
- **Improve** and **Write it again**, as on every other part. It's the business's, one per playbook. Each person
  using their own video comes later.

### Tracking: the daily numbers

- **The three numbers** the video says to watch daily: messages sent, positive replies, calls booked. Plus the two
  rates (positive replies ÷ messages, calls ÷ positive replies) against the benchmarks and the person's targets.
- On the **Results** tab: today, this week, this month; by playbook and by offer version. Owners and admins see
  everyone's, counts only, as now.
- **The day's report**: a push at the end of the person's working hours ("Today: 14 messages, 2 said yes, 1
  booked. 3 more messages hit your target."), on their add-ons switch, on to start, off in My settings.
- **The week's review**: on Monday morning, the AI reads last week's numbers and says what to fix first, in the
  order the video gives:
  - too few messages: volume (the most common fix);
  - enough messages, few yeses: the message or the offer;
  - yeses but few calls: the video and the follow-ups.

  Shown on Results and in a push. Counted against the AI limit.

## Part 3: AI Sales Coach, later

Nothing is built for it here. When it comes it declares `uses: ['main_offer']` and reads the live version: the
method and proof for the pitch, the guarantee's conditions and who qualifies for the call's questions, and the price
with its value math. The workbook's Module 4 (the line of questions, the pitch's order: diagnosis, method, proof,
offer, price) is its starting point.

## What this changes in Social Outreach's decisions

New decisions, numbered from 62 in docs/outreach.md (the numbering there repeats 60 and 61; tidy that when these go
in):

- **62. The main offer comes first.** Social Outreach uses core's main offer; a playbook narrows its who.
- **63. Ready before the first day.** The readiness check holds Start my day and everything Today would send.
- **64. Direct after they accept.** Replaces decision 47's moment to pitch for new friends: the first message asks
  about the offer. Decision 47's read (`pitch`) stays for chats that started another way (Reconnect, the file, people
  who wrote first).
- **65. The video, then the link.** Pitch becomes Send the video and Send the link.
- **66. Follow-ups until they answer.** 5 to 7, then monthly; no longer only for chats read as a prospect.
- **67. A positive reply is counted.**
- **68. The extension edits the person's own bio,** after their OK. It's the first time it changes their profile; it
  presses only on their own profile, in Edit bio.

## Build order

Each step ships on its own, with its tests, and leaves the add-on working.

1. **Core: the main offer. Built.** The migration, the Drizzle mirror, the permission, the commands, queries and
   events, the manifest's `uses` and `coreFeatureOn`, the commands' refusal, `PLAIN_WRITING` moved into core
   (`writing.ts`), `pnpm openapi`, and Current offers renamed **Promotions** on screen. Tests: refused with no add-on
   that uses it, publishing needs a score and clears the bar or says why, versions never change.
2. **Core: the builder, on the web.** Settings → Main offer, the builder, the three AI routes, the examples by line of
   work. Design boards first, in `design/`, reviewed before the screens are built. **Server side built** (the AI
   routes in `apps/worker/src/main-offer/routes.ts`, the prompts and checks in `packages/core/src/main-offer/assist.ts`,
   the examples in `examples.ts`). **The boards are in `design/main-offer`, waiting for Chris's review;** the screens
   wait for them.
3. **Social Outreach: the playbook's niche.** Data version 3, the builder's new steps, the CRM demos template.
4. **Social Outreach: getting ready.** `outreach.readiness`, the setup step, the Get ready card on Today, the web and
   the phone and the panel, `outreach_not_ready`, your numbers and their math.
5. **The extension: your profile.** `profile_read`, the AI's score and bios, `profile_edit`, a new extension build.
6. **The conversation.** The first message rewritten, the reply read (yes, question, later, no), Send the video, Send
   the link, the follow-up sequence and the monthly check-in, `sends.offer_version`, the comment on their own post.
7. **The short video.** The script and shot list, the link.
8. **Tracking.** The numbers on Results, by playbook and version, the day's report, the week's review.
9. **Docs.** `docs/main-offer.md` (new, with its rules worth knowing), docs/outreach.md (what's built, the
   decisions, the rules), docs/addon-architecture.md (`uses`), and a row in CLAUDE.md's Read first table.

Steps 1 and 2 are core and come first. Steps 3 to 8 are the add-on's, in that order, because the readiness check
needs the niche and the conversation needs the readiness check.

## Answered (Chris, 2026-10-14)

1. **The bar for the offer:** every part scores 7 or more. Below that, the AI's fix is shown, and an owner can still
   go ahead with **Use it anyway** and a line on why, kept with the version, so an AI score can't hold a business
   back for good.
2. **Facebook's pace:** the limits stay. The honest math shows, and Reconnect and helpful posts are offered for more.
   More reach comes from more platforms (LinkedIn, Instagram, TikTok, X, Threads, Alignable and others), each with
   its own safe pace, so the targets add up across them as they come.
3. **The short video:** one per playbook now; each person's own later.
4. **The day's report:** on to start, at the end of the working hours.

## Answered since

1. **Renaming Current offers** (Chris, 2026-10-14): **Promotions** on screen, built with step 1. `offer` stays in
   code, the tables and the commands, and the page keeps its address (`/knowledge/offers`) so old links work.
