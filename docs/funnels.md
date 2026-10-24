# Funnels in the AI teammate

A funnel is the path a business wants people taken along, from first hearing about it to where it wants them. It is
a pipeline's stages plus, for each stage, its goal, what moves someone on, and what the teammate sends there and
when. The teammate follows it: it sends each stage's messages at the right time, answers questions knowing where the
person is, and moves them on. Nobody builds a workflow.

The owner's decisions, the build order and Christina Robbins's recruiting funnel (the first real one) are in
`HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md`. The boards are in `design/funnels`.

## Where things are

| What                                                 | Where                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The definition, its words, timing, issues, trying it | `packages/core/src/funnels/` (`definition.ts`, `words.ts`, `schedule.ts`, `issues.ts`, `play.ts`, `fill.ts`)             |
| The AI's draft                                       | `packages/core/src/funnels/draft.ts` (the draft), `draft-wire.ts` (what the model writes, and mending it)                |
| A lead's move carrying the funnel with it            | `packages/core/src/funnels/follow.ts`, called from `lead.move_stage`                                                     |
| Commands and queries                                 | `packages/core/src/commands/funnel.ts`, `packages/core/src/queries/funnel.ts`                                            |
| Tables                                               | `app.funnels`, `app.funnel_people` (`20261027011400_funnels.sql`)                                                        |
| Running it: getting in, moving on, messages          | `apps/worker/src/funnels/` (`events.ts`, `tick.ts`)                                                                      |
| The draft route                                      | `apps/worker/src/funnels/draft.ts` (`POST /v1/funnels/draft`)                                                            |
| What the teammate knows, and its two tools           | `apps/worker/src/ai-team/funnel-context.ts`, `prompt.ts` (`funnelLines`, `suggestLines`), `tools.ts`                     |
| A funnel's message as a teammate run                 | `runFunnelMessage` in `apps/worker/src/ai-team/run.ts` (`RunKind` `funnel`)                                              |
| The web: the tab, the steps, the map, trying it      | `apps/web/src/components/funnels/`, routes under `apps/web/src/app/app/w/[workspaceId]/ai-team/funnels/`                 |
| Where people are on the web                          | `person-funnel.tsx` (their page, their lead, the inbox), the board's badge (`pipeline/lead-card.tsx`), `suggestions.tsx` |
| The phone                                            | `apps/mobile/src/components/customers/funnel-card.tsx`, `apps/mobile/src/funnels/calls.ts`                               |

## The shape

**`app.funnels`** holds one row a funnel: its pipeline, its status (`draft`, `on`, `paused`, `archived`), a
`revision`, and its `definition` (jsonb, `FunnelDefinition`). The definition is:

- **`entry`**: its rules (a new lead in the pipeline, or one that came in by certain ways; a form answered; a
  booking on a calendar), whether people can be added by hand, whether the teammate may suggest people, and the stage
  people start at.
- **`stages`**: one for each pipeline stage the funnel uses, by `stageId`. An open stage has a `goal`, talking points
  (`knows`), its `moves` (an event, a reply the teammate judges, or so long quiet) and its `messages`; `handOff` hands
  them to the team after its first messages. A won or lost stage has nothing of its own: people leave the funnel
  there.
- **`approval`** (`teammate`, `ask` or `send`), the default wording, and what the business described.

Every move, message and rule has a short id (`v…`, `m…`, `r…`) that never changes, so the people in it keep their
place when it's edited.

**`app.funnel_people`** holds one row a person a funnel has had: `active`, `paused` (with why), `suggested`,
`declined` or `left` (with why), their stage and lead, when they reached it, their booking, and which messages went
(`sent`) and what they've done (`seen`). A partial unique index keeps a person in **one funnel at a time**.

**`playFunnel`** (`play.ts`) is "Try it as a lead": the same timing and forks the worker uses, played on screen with
nothing sent. The worker and the steps read the same `funnelMessageDueAt` and `funnelUpcoming`.

## How it runs

- **Getting in.** `apps/worker/src/funnels/events.ts` hears `lead.created`, `form.submitted`, `appointment.booked`
  and the rest, and adds them by the funnel's rules (`funnel.add_person` as the system). People add them by hand;
  the teammate suggests them (`suggest_funnel`) and someone says yes on Approvals, on the person's page, or in the
  conversation (`funnel.decide_suggestion`).
- **One job a person.** Each person in a funnel has one `funnel.tick` job, keyed `funnel:<funnelPersonId>`. Each
  time it wakes it does one thing (a quiet move, the stage's hand-off, or one message) and reschedules itself for
  the next thing due. Anything that changes them (an event, a reply, an edit, a pause) pokes it.
- **A message is claimed before it's sent.** The tick marks it sent (`funnel.note_progress`) and then runs it, so a
  retry never sends it twice.
- **The teammate writes it, or the business's words go.** An `ai` message is a brief: the teammate's `funnel` run
  writes it, with the stage's goal and talking points. An `exact` one goes as written, with `{first_name}`,
  `{session_time}`, `{join_link}` and `{business}` filled in (`fill.ts`).
- **Answering.** Every run that talks to someone in a funnel has `<funnel>` in its context: the stage, its goal,
  what moves them on, and what's next. A stage's reply moves are offered as `funnel_move_on` with their ids.
- **Moving on.** Events move people by the funnel's moves (`funnel.move_person` as the system); the teammate moves
  them by a reply move only (`funnel.move_person` as the AI). Either way it is `lead.move_stage` with the funnel's
  id, so the board always shows where they are.

## Rules worth knowing before changing anything

**The pipeline is the truth.** A person dragging a lead to another stage moves them in the funnel too
(`funnelFollowsLead`), and that stage's messages start. A stage the funnel doesn't use takes them out (`outside`); a
won or lost stage ends their funnel.

**Funnels need the teammate on.** With the teammate off, nothing in any funnel goes out, and turning one on is
refused. One switch turns everything off.

**A team reply pauses that person's funnel** until someone clicks Hand back, as the teammate's conversation does
(`taken_over`). The teammate handing them to the team pauses it too (`handed_off`). A person paused by hand stays
paused until a person resumes them: the system never resumes someone a person paused.

**Edits reach everyone at once, and people stay where they are.** `funnel.save` refuses a stale `revision` (another
tab, or someone else). A stage taken out with people in it needs to know where they go (`moveFrom`).

**Only a person, or a rule the owner wrote, moves someone back.** The teammate only takes a stage's reply moves, and
never a move backwards by itself.

**A message past its good-until is skipped, not sent late.** 30 minutes for one timed around a booking's start, two
hours for one on the booking's day, a day otherwise, unless the message says. Quiet hours apply as they do to the
teammate's other messages. A message tied to a moment that's passed ("Were you able to log on?") never goes.

**One voice.** Inside a funnel, the funnel's messages stand in for the teammate's Follow up ladder and its first
message (`inFunnel`), so nobody gets nudged twice. A workflow that also texts the same new leads shows as a yellow
issue on the funnel; nothing stops both running.

**The teammate never names the funnel or its stages to the customer.** `funnelLines` and `suggestLines` say so, and
`suggest_funnel` changes nothing for them until a person says yes.

**The AI's draft is a draft.** `POST /v1/funnels/draft` saves nothing; `funnel.create` keeps it. `draftFromWire`
keeps what's sound and mends or drops the rest (a move to a stage it never named, a time out of range), and on a
pipeline the business has, the draft uses its stage names exactly. It counts against the daily AI limit as `funnel`
use.

**Limits.** 20 funnels a business, 12 stages a funnel, 8 messages and 6 moves a stage, 6 entry rules
(`FUNNEL_LIMITS`). AI-written messages count toward the teammate's share of the daily AI limit, as its replies do.

**Who may.** Owners and admins make and change funnels (`ai_team.manage`). Everyone who can see records sees them
and where people are; whoever can change records pauses, removes, moves and adds people, and answers suggestions.

**A person in the Deleted bin takes their funnel row out of sight with them** (`funnel_people_follow_person`).

## Where people are

- **A person, their lead, and their conversation:** a line under the name, from `funnel.of_person`: the funnel, the
  stage (and their booking), and what's next, or why it's paused, with Pause or Resume, Move to… (their lead, which
  the funnel follows) and Remove. With a suggestion waiting, it asks yes or no. In no funnel, Add to a funnel lists
  the ones that take people by hand. A business without funnels sees nothing.
- **The board:** a badge on each card in the funnel (paused or not), and a Funnel button that opens its map with how
  many people are at each stage (`lead.board`'s `funnel`).
- **Activity and Approvals:** each run's summary starts with the funnel and stage ("Recruiting · New lead: Sent …"),
  a funnel's draft says which funnel and stage it's from, and the teammate's suggestions wait at the top of
  Approvals.
- **The phone:** the same line on a customer, with Pause, Resume, Remove and the suggestions, while there's signal.
  Making and changing funnels is on the web. None of it is in the phone's copy.

## Not yet

- Ready-made funnels, and being in two funnels at once (the owner's decisions).
- Making or changing funnels on the phone.
- A phone call as a funnel message.
- Zoom's own join events: "joined" is "clicked their Join link".
