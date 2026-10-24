# Funnels — the AI teammate takes each person through the business's steps

A business describes the steps it wants people to go through, and the AI teammate does the rest. It sends each
step's messages when something happens or doesn't, answers questions knowing where the person is, and moves them
on. Nobody builds a workflow. A funnel is a pipeline's stages plus, for each stage, its goal, what moves someone on,
and what the teammate says and when.

It started with Christina Robbins's recruiting funnel (`HANDSFREEOS_FUNNELS_IMPLEMENTATION_PLAN.md`, built). That
plan made the pieces a funnel uses: the step-by-step form with videos, personal links, booking inside the form,
"stopped partway", Facebook lead ads, Indeed, and who joined a session. Doing it with workflows still meant building
and remembering five of them. This plan puts the steps where the owner thinks about them, in one place the teammate
reads.

> **Status: planned, not built.** The decisions below are the owner's (2026-10-24). "Picks to confirm" are mine and
> stay open until the owner says yes. Nothing is built before the boards in `design/funnels` are approved.

## Decisions (Chris, 2026-10-24)

| Question                           | Answer                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What it's called                   | **Funnels**, in the AI teammate                                                                                                                              |
| Its stages                         | **A pipeline's stages.** Pick a pipeline, or make a new one for the funnel                                                                                   |
| Who writes each message            | **An option:** the teammate writes it from what it should say, or it sends the business's exact words                                                        |
| Approving messages first           | **An option** on each funnel                                                                                                                                 |
| Ready-made funnels                 | **None.** Every funnel starts from the business's own description                                                                                            |
| Making one                         | **Step by step, with a live map.** Guided steps on one side; a map on the other draws itself, branch by branch; any box opens its step                       |
| Where it starts                    | **Describe it, the AI drafts it.** Type or paste how it should go; the steps then go through each part to check and change                                   |
| Before turning it on               | **Try it as a lead, on screen.** Play a pretend lead, pick what they do at each fork, and see each message and when. Nothing is sent                         |
| A person on the team replies       | **That person's funnel pauses** until someone clicks **Hand back**, as the teammate's conversation does today                                                |
| The teammate is off                | **Funnels need the teammate on.** One place turns everything off                                                                                             |
| A funnel changes with people in it | **Everyone gets it at once.** People stay in the stage they're in; from then on they get the new messages and rules                                          |
| More than one funnel               | **One at a time.** Joining a funnel ends the one they were in. The teammate still knows their history                                                        |
| How people get in                  | **All three:** by how they arrive (a lead source, a form, a booking, a new lead in the pipeline), added by hand, or the AI suggests it and a person says yes |

## Picks to confirm

| Question                                   | Pick                                                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the wording choice lives             | **On each message**, with the funnel's default ("The teammate writes it") set once. An exact message can still fill in `{first_name}`, `{session_time}` and `{join_link}`                                                  |
| The approval choice                        | Three settings on the funnel: **Like the teammate** (default: drafts while it's in training wheels, on its own once it's automatic), **Always ask first**, and **Send on their own**                                       |
| What moves someone on                      | Something HandsFreeOS sees (a form answered or stopped partway, a video watched, booked, joined, attended, missed, a deal won or lost), **they say something like…** (the teammate judges their reply), or **time passes** |
| Moving backwards                           | Only a person, or a rule the owner wrote (a no-show back to "Invited to a presentation"). The teammate never moves someone back on its own                                                                                 |
| The pipeline is the truth                  | A person dragging a lead to another stage on the board moves them in the funnel too, and that stage's messages start                                                                                                       |
| When someone leaves                        | A won or lost stage ends their funnel. So do STOP, being removed by hand, and joining another funnel. "No reply after the last nudge" goes to a stage the owner picks, such as "Inactive"                                  |
| Messages that come due while paused or off | A message tied to a moment that has passed ("Were you able to log on?") is skipped. The rest wait and go out when the funnel runs again                                                                                    |
| Quiet hours                                | They apply as they do now. A message has a **good until** (30 minutes for one tied to a session's start), after which it's skipped rather than sent late                                                                   |
| The teammate's own follow-ups              | Inside a funnel, the funnel's messages replace the teammate's Follow up ladder for that conversation, so nobody gets nudged twice                                                                                          |
| A workflow that also texts the same people | A yellow issue on the funnel's rail ("**Speed to lead** also texts new leads in this pipeline"), with a link to pause it. Nothing stops both running                                                                       |
| Limits                                     | Up to 20 funnels a business, 12 stages a funnel and 8 messages a stage. Funnel messages count toward the teammate's 12 messages a customer a day, and AI-written ones toward its share of the AI limit                     |
| Who can make and change funnels            | Owners and admins (`ai_team.manage`), like the rest of the teammate. Everyone can see them and where people are                                                                                                            |
| The AI suggesting someone                  | A suggestion waits on **Approvals** ("Add Maria to **Recruiting**? She asked about the opportunity"), and in the conversation, for anyone to accept or dismiss                                                             |
| The phone app                              | See a person's funnel and stage, pause, resume, remove, and accept suggestions. Making and changing funnels is on the web                                                                                                  |
| Removing a stage with people in it         | The steps ask where they go before it saves                                                                                                                                                                                |

## What's already there

| Piece                                 | Where                                                                                                                                                                     | What a funnel uses it for                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Pipelines and stages                  | `pipeline.create` (`DEFAULT_STAGES`), `stage.create/update/delete/reorder`, `lead.move_stage` (emits `lead.stage_changed`); stage `kind` `open`, `won`, `lost`            | The funnel's stages, and moving people                           |
| The board                             | `apps/web/src/components/pipeline/board.tsx` (`PipelineBoard`, `stage-column.tsx`)                                                                                        | Where people are, with a funnel badge                            |
| Events                                | `TRIGGER_EVENT_KEYS`: `lead.created`, `form.submitted`, `form.stopped`, `appointment.booked/cancelled/no_show`, `attendee.joined/attended/no_show`, `message.received`, … | What moves people on, and when messages go                       |
| What the teammate knows on each reply | `apps/worker/src/ai-team/context.ts` `loadRunContext` (the lead, its stage and the pipeline's stages); `prompt.ts`, `turns.ts`                                            | Adding the funnel: the stage's goal, talking points, what's next |
| Teammate runs                         | `run.ts` (`RunKind` `reply`, `first`, `nudge`, `task`), `runNudge`, `TEAMMATE_JOBS`                                                                                       | A new `funnel` run for a stage's message                         |
| Timed messages                        | `app.scheduled_jobs` through `scheduleDebouncedJob`; the Follow up skill's `ai_teammate.follow_up` and its checks before sending (`follow-up.ts`)                         | Each stage's timed messages, with the same checks                |
| Times around a booking                | The workflow engine's `WaitUntil` `date_field` with `appointment.starts_at`, re-read on waking (`waits.ts`)                                                               | "5 minutes after it starts", even after a reschedule             |
| Drafts and approvals                  | `app.ai_teammate_drafts`, `ai_teammate.decide_draft`, `ai_teammate.send_draft`, **Approvals**                                                                             | Messages that ask first, and the AI's suggestions                |
| Take over and Hand back               | `conversation.take_over` (`conversation.taken_over`), `conversation.hand_to_ai` (`conversation.handed_to_ai`), `app.conversations.handled_by` and `ai_epoch`              | Pausing and resuming a person's funnel                           |
| The map                               | `apps/web/src/components/workflows/canvas/` (`WorkflowCanvas`, `@xyflow/react`, `@dagrejs/dagre`: `graph.ts`, `layout.ts`, `nodes.tsx`, `edges.tsx`)                      | The live map's drawing and layout, with nodes of its own         |
| The teammate's screens                | `ai-team/` routes; `TeammateSubnav` (Teammate, Instructions, Review, Activity, Approvals); `TeammateBuilder`, `rail.tsx`                                                  | A **Funnels** tab, and the rail's issues                         |
| The test console                      | `core/ai-team/test-console.ts`, the worker's `/v1/ai-team/test`: one turn, nothing sent                                                                                   | Sample messages while trying it as a lead                        |

Two things don't exist yet. Workflow runs don't notice a person taking over (`workflows/` has no `taken_over`
handling), and the test console plays one turn only, never anything timed. A funnel handles both itself.

## Shape

### 1. What a funnel is (`packages/core/src/funnels/`)

Core's, for every business, not an add-on. One definition, checked with zod, that the web, the phone, the worker
and the AI draft all read.

- **The funnel** (`app.funnels`): its name, its pipeline, its status (`draft`, `on`, `paused`, `archived`), its
  approval setting, its default wording, and its definition (`FunnelDefinition`, with `FUNNEL_VERSION`). A save
  names the revision it started from, as the main offer's draft does, so two editors never undo each other.
- **Who gets in** (`entry`): rules ("a new lead in this pipeline", "Lead source is Facebook lead ad", "answers the
  form **Join our team**", "books **Live presentation**"), and two switches: **Can be added by hand** and **The
  teammate can suggest people**.
- **Each stage** (`stages[]`), keyed by its pipeline stage:
  - **Goal**: a line ("Get them to book a presentation").
  - **What it should know here**: talking points the teammate reads only at this stage (up to 1,000 characters).
  - **Moves on when** (`moves[]`): each is "when this happens, go to that stage". The kinds are an event with an
    optional filter (`event`), the teammate judging a reply (`reply`, "they say they're interested"), and time with
    nothing happening (`quiet`, "3 days without a reply").
  - **Messages** (`messages[]`): each has
    - **when**: on arriving, after a time, or around their booking ("5 minutes after it starts");
    - **only if**: optional, they have or haven't done something by then ("hasn't joined");
    - **what to say**: the teammate's brief, or the exact words;
    - **how**: text, email, or the best way they can be reached;
    - **good until**: how late it may still go.
- **Forks are drawn, not built.** Two messages at the same moment with opposite "only if"s ("joined" and "hasn't
  joined") are drawn as a fork on the map. So is each stage's "moves on when" list. Nobody wires branches.
- **Who's in it** (`app.funnel_people`): the funnel, the person, their lead, the stage, when they reached it, the
  booking it's timed around, the messages already sent at this stage, and paused or not, with why. A partial
  unique index keeps one active row a person (one funnel at a time).
- **Commands** (all through the kernel):
  - `funnel.create`, `funnel.save`, `funnel.turn_on`, `funnel.pause`, `funnel.archive`;
  - `funnel.add_person`, `funnel.remove_person`, `funnel.move_person`;
  - `funnel.suggest`, `funnel.decide_suggestion`.
  - Each emits its event: `funnel.person_added`, `funnel.stage_reached`, `funnel.person_left`,
    `funnel.paused_for_person`, `funnel.resumed_for_person`. Workflows can start on them like any other.
- **Queries:** `funnel.list`, `funnel.get` (with how many people are at each stage), `funnel.of_person`,
  `funnel.people`.
- **Words** (`funnels/words.ts`): what a stage, a rule and a message say in a line, for the steps, the map, a
  person's record and the phone, so the web and the phone read them the same way.

### 2. How it runs (`apps/worker/src/funnels/`)

- **Getting in.** The worker hears the entry events and runs `funnel.add_person`. A person already in another funnel
  leaves it first (`funnel.person_left`, "joined **Recruiting**").
- **Moving on.**
  - An event that matches one of their stage's `moves` runs `lead.move_stage`. The pipeline stays the truth: any
    `lead.stage_changed`, the board's included, sets their funnel stage and starts that stage's messages.
  - A `quiet` move is a scheduled job of its own.
  - `reply` moves are the teammate's: on a reply run it gets one tool, `funnel_move_on`, limited to that stage's
    `reply` moves, with its reason recorded.
- **Messages.**
  - Reaching a stage schedules each of its messages in `app.scheduled_jobs` (`funnel.message`, keyed by person and
    message). Times around a booking use the workflow engine's time maths and are worked out again on waking, so
    a reschedule moves them.
  - On waking, it checks again: still at that stage, the "only if" still holds, not paused, the teammate on, they
    can be reached that way, quiet hours, and not past good until.
  - Then a teammate run of a new kind, `funnel`. Its turn carries the message's brief (or the exact words to send),
    the stage's goal and talking points, and what's next.
  - The approval setting decides whether it's sent or waits as a draft on **Approvals**.
- **Answering.** Every reply run for someone in a funnel gets it in its context (`loadRunContext`): the funnel's
  name, where they are, the stage's goal and talking points, what moves them on, and what comes next. So "What's
  the comp plan?" in the middle of the overview gets an answer, then a nudge back to the video.
- **Pausing.** `conversation.taken_over` pauses that person's funnel. `conversation.handed_to_ai` resumes it, with
  the messages still ahead scheduled again; ones whose moment passed are skipped. The teammate off holds every
  funnel the same way.
- **One voice.** Inside a funnel, the teammate's own Follow up ladder stands down for that conversation, and its
  "Message new leads first" skips anyone a funnel just took in, since the funnel's first stage writes to them.
- **Records.** Each run's **Activity** entry names the funnel, the stage and the message. The person's timeline gets
  "Reached **Booked** in **Recruiting**" and "Left **Recruiting**: said they're not interested".

### 3. Making one: the steps and the live map (web)

**AI teammate → Funnels**, a new tab after **Instructions**: each funnel with its pipeline, how many people are in
it, and its switch. **New funnel** opens the steps, with the map beside them:

1. **Describe it.** Type or paste how it should go. The AI drafts the funnel (the worker's
   `/v1/funnels/draft`, which uses the daily AI limit): its stages, the moves between them, the messages and
   when. The map draws itself as the draft comes in.
2. **Its pipeline.** Use one the business has, matching the draft's stages to it, or make a new one from the draft's
   stages.
3. **Who gets in.** The entry rules, and the two switches.
4. **The stages.** Each stage's goal, what it should know, and what moves someone on.
5. **The messages.** For each stage, the messages and when they go, with "only if" for forks.
6. **Wording and approvals.** The default wording, any exact messages, and the approval setting.
7. **Try it as a lead.** Below.
8. **Turn it on.** The rail lists what's missing or risky first, as the teammate's does. Red issues block turning
   it on; yellow ones only warn.

**The map** uses the workflow canvas's drawing and layout, with nodes of its own:

- a box for each stage, with its goal and, once on, how many people are there;
- each message as a small card on its stage's line, with its time ("Thu 7:05 pm, if they haven't joined");
- an arrow for each move, labelled with what causes it ("they book", "says not interested", "3 days quiet").

Clicking a box opens its step with that part ready to change. The map is the same afterwards, when the funnel is
edited, with the counts live.

**Try it as a lead.**

- A pretend person ("Sam") walks the map. At each fork the steps ask what Sam does: joins or doesn't, says yes, says
  no, or asks a question.
- Each message shows with its time, worked out from a pretend booking.
- Exact messages show as written. Ones the teammate writes are drafted through the test console, one turn each.
  They use the AI limit, so they're made only when shown.
- A question Sam asks gets the teammate's answer with the funnel in mind.
- Nothing is sent, booked or moved. A core function, `playFunnel(definition, choices)`, works out the path and the
  times, so the steps and the tests agree.

### 4. Seeing where people are

- **A person or a lead:** a line under their name: "**Recruiting** · At the presentation (Thu 7 pm) · Next: 'Can you
  hear okay?' at 7:10". **Pause**, **Remove** and **Move to…** sit beside it.
- **The board:** a funnel badge on each card, and a **Funnel** button above the board that opens its map with the
  counts.
- **Activity and Approvals:** each entry names the funnel and the stage. The AI's suggestions wait on Approvals.
- **The phone app:** the same line on a person, with pause, resume, remove and the suggestions.

### 5. Christina's funnel, as the first real one

What she'd type in step 1 is her email. The draft would come back about like this:

| Stage                | Moves on when                                                      | Messages                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| New lead             | they open their link                                               | on arriving: their personal link to the form                                                                                                      |
| In the funnel        | they book a presentation; quiet 3 days → Inactive                  | 30 minutes after stopping partway: back to where they left off                                                                                    |
| Booked               | they join (→ At the presentation); it ends without them (→ Missed) | the day before and an hour before: a reminder with their Join link. 5 minutes after it starts, if they haven't joined: "Were you able to log on?" |
| At the presentation  | it ends (→ After)                                                  | 10 minutes in: "Can you hear the presenter okay?"                                                                                                 |
| After                | they say they're in (→ Interested); they say no (→ Out)            | an hour after: "I'll check back with you to go over next steps"                                                                                   |
| Missed               | they book again (→ Booked); quiet 7 days → Inactive                | on arriving, and 2 days later: a link to pick another night                                                                                       |
| Interested           | the three-way call is booked (→ Three-way call)                    | on arriving: the Business Expansion Leader's booking link. Then a hand-off to the team                                                            |
| Three-way call (won) | —                                                                  | —                                                                                                                                                 |
| Out, Inactive (lost) | —                                                                  | —                                                                                                                                                 |

The form, its videos, the booking inside it, the Join links and who joined are all from the first funnels plan.
This plan only adds the steps around them.

## Build order

Each stage leaves `main` working and shippable, behind nothing: a business without funnels sees no change.

0. **The boards** (`design/funnels`): the Funnels tab, the steps with the live map (drafting, a stage, a message, a
   fork), trying it as a lead, the rail's issues, a person's funnel line, the board's badge and map, and the phone.
   The owner approves them before any code.
1. **Core:** `FunnelDefinition`, its words, `playFunnel`, the tables (`app.funnels`, `app.funnel_people`), the
   commands, queries and events, and their tests (the parity test, row security, the one-at-a-time rule).
2. **The worker:** getting in, moving on, messages and their checks, pausing and resuming, the teammate's `funnel`
   run, its context and `funnel_move_on`, and the Follow up ladder standing down. Tests on the real database,
   with Christina's funnel as the scenario.
3. **The web: the tab, the steps and the map,** without the AI draft (a blank funnel to start from, for this stage
   only), and editing a funnel that's on.
4. **The AI:** drafting from a description, and suggesting people.
5. **Try it as a lead.**
6. **Where people are:** the person and lead line, the board's badge and map, Activity and Approvals, the phone app,
   and the docs (`docs/funnels.md`, the CLAUDE.md read-first table, the teammate's section of `docs/operations.md`).

## Not in this plan

- **Ready-made funnels** (the owner's decision).
- **Being in two funnels at once** (the owner's decision).
- **Making or changing funnels on the phone.** The phone sees and pauses them.
- **Phone calls as a funnel message.** The teammate can place calls today; a stage's message that's a call is later.
- **Zoom's own join events.** "Joined" stays "clicked their Join link", as in the first funnels plan.
- **Moving workflows into funnels.** Workflows stay for anyone who wants exact control.
