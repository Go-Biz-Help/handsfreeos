# Social Outreach: the app holds the schedule, the extension does the work

Today the browser extension plans each network's day itself: the order of its work, the times, the once-a-day jobs
and where the day is up to all live in its own storage, in five runners (`apps/extension/src/auto/run.ts` for
Facebook, `linkedin.ts`, `instagram.ts`, `alignable.ts`, and `follows.ts` for Threads and X). The app only sends it the
list of who to reach (`outreach.today`) and the jobs a person asks for (`outreach.ask.*`).

This moves the schedule into HandsFreeOS. The web and phone apps show what the extension will do and when, buttons and
the Assistant change it, and the extension does what it's sent. Decision 195 in `docs/outreach.md`.

## Decisions (Chris, 25 Nov 2026)

| Question               | Answer                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who holds the schedule | **The web and phone apps**: "the web app/phone app has the knowledge and schedule and tasks etc and the extension just knows how to do the things that the app send it". "yes" to building it.               |
| Why                    | So the Assistant and buttons in the app can tell the extension what to do, and the app shows "what it plans to do when".                                                                                     |
| How                    | **Five steps, a pull request each**, in the order below. Nothing changes all at once.                                                                                                                        |
| Safety                 | **Every limit stays:** one page at a time, the warm-up before a message, never a message to someone on Instagram who doesn't follow the person (decision 159), each network's daily limits and its warnings. |
| The Content Creator    | **Not part of this.** It already works this way: the app keeps its calendar and the extension asks for the next post (`socialcontent.post.next`).                                                            |

## The steps

1. **See the plan in the app** (built, extension 0.155.0). The runners' pure rules move to core unchanged
   (`packages/core/src/addons/outreach/plan-rules.ts`, `runners.ts`). The extension says where each network's day is
   up to (`outreach.plan.note`, `addon_outreach.plan_days`), and HandsFreeOS works the rest of the day out with the
   same rules (`plan.ts`: `nextMove`, `planAhead`, `planShown`; `outreach.plan`). Today gets a **Plan** part on the
   web and the phone, and the Assistant reads it (`outreach_plan`). The extension still decides for itself, so the
   plan only shows.
2. **The app decides, the extension does** (Threads and X built, extension 0.156.0, then Alignable, 0.157.0,
   Instagram, 0.158.0, LinkedIn, 0.159.0, and Facebook, 0.160.0: every network's runner asks now; all switched off
   until a day's plan is checked against a real day).
   Each runner's `go()` asks HandsFreeOS for its next move (`nextMove` on the server, with the list and the day it
   already has) and does it, saying how it went. One network at a time, the smallest first: Threads and X, then
   Alignable, Instagram, LinkedIn, and Facebook last. Each keeps its own pace, warnings and limits. With no
   connection, a runner goes on as it does today until it's back.
3. **Buttons on the plan** (built, no new extension build): do now, skip today, move to a time, and put back. One
   command (`outreach.plan.change`), so the Assistant can do it too.
4. **The Assistant changes the plan,** on Confirm cards where a change asks first (decision of 26 Oct 2026).
5. **Clean-up.** The extension's own planning goes: its day's state is HandsFreeOS's, and `src/auto/plan.ts` keeps
   only what the pages need.

## Step 1, as built

- **The rules, once.** `plan-rules.ts` holds what the runners decide with: the kinds in their turns, the once-a-day
  jobs and their batches, rounds of finding again, the newest posts' watch, replies any time, the gaps that spread the
  list over the hours, and the day itself (`networkDay`). `runners.ts` holds each network's kit (`RUNNERS`). The
  extension imports both, so its runners work exactly as before (its whole suite passed unchanged).
- **The extension's word** (`apps/extension/src/hfos/plan.ts`). A couple of seconds after a runner's state changes in
  a way the plan can see, and after each answered beat, it sends that network's state (`planStateOf`): what's done,
  what was tried, the jobs done and waiting, and when it goes next. Never for a new line alone (`planNoteKey`), and
  never the same twice (a short mark, kept while the browser is open). Only the working computer's is kept, with its
  times moved onto HandsFreeOS's clock. One row a person and network, their own, hidden from a view of them
  (`20261027036200_outreach_plan_days.sql`). An earlier day's row reads as a day not begun.
- **The day ahead** (`planAhead`). From where the day is, each move is taken as done in about the time it takes
  (`MOVE_MINUTES`), with the gap the runner would leave after it, until the working hours end (or the day, after Start
  my day). The first move is at the extension's own next time when it said one; the rest say "About". Up to 40 rows,
  the rest counted. What the person asked for goes first, listed apart.
- **What the plan leaves out, and says so:** the referral look, a helpful post going up on its own, reads that wait
  till the person is away, and how long a job really takes. Comment research shows only once one of its batches
  waits (it runs only for HandsFreeOS's own staff), then first when due, outside the hours too (decision 194).
- **Today's Plan part** (`page-parts.ts`; the web's `plan-view.tsx`, `/today/plan`; the phone's `plan.tsx`): where
  the day stands, You asked for these first, Coming up, and Done so far today. It asks again every minute, and on the
  web when the computer, the day or an ask changes. Before an extension says anything, it says to update to 0.155.0,
  or that the computer will say within a minute.

## Step 2, as built (Threads and X)

- **One order, asked for** (`outreach.plan.next`, `packages/core/src/addons/outreach/ops/plan.ts`; its shapes in
  `plan-next.ts`). A runner says where its day is up to (`PlanState`), its own clock, a number from 0 to 1 for the
  go's waits, and what only its computer knows (`PlanHere`): whether the person is away, the once-a-day reads put off
  till they are, whether a comment research of theirs reads now, and whether something they asked is in line.
  HandsFreeOS answers with `nextMove` on its own settings, hours, day, warning, lists and today's list.
- **`nextMove` takes what the computer knows.** A first day's lists wait for the person to be away (`screen`); a
  later save of them is left till then and the rest goes on; a read put off is passed over, tried again in 10
  minutes, and holds a round of finding again; a comment research reads when the runner was told one does. A piece
  of the list's work says how it goes (`reading`, the `day` it's in, `answering` outside the hours). Left out, as
  for the plan that's shown, the day is worked out as if they're away.
- **What's in line is the runner's word** (`here.asking`). HandsFreeOS's own count of what the person asked includes
  one no computer took yet, which never held a runner: the count is only for the plan that's shown.
- **Whose clock.** HandsFreeOS works the move out on its own clock and sends each time back on the runner's, by how
  far apart the two are (`now`). A piece of work comes by its key (`workKey`) with today's list, so the runner asks
  once. What the move changed in the day comes back too (`change`): a round begun, who still waits for an answer.
- **Who's answered** (`decides`). Only the networks in `PLAN_DECIDES`, only the person's working computer, and only a
  build from 0.156.0 (`NEXT_SINCE`, read from the request). Anyone else is told to plan for itself. Taking a network
  out of `PLAN_DECIDES` hands its order back to the extension at its next go.
- **Switched off for now** (`PLAN_DECIDES` is empty). The build went out first, so Threads' and X's runners ask and
  are told to plan for themselves, which they do exactly as before. They're switched on by putting `'threads'` and
  `'x'` in `PLAN_DECIDES`, a change to HandsFreeOS alone (no new extension), once the Plan on Today has been checked
  against what the owner's computer really did over a day (promised to Chris, 25 Nov 2026). The database tests switch
  them on for themselves (`outreach-plan-ops.test.ts`).
- **The runner** (`apps/extension/src/auto/follows.ts`). Its own checks stay first and unchanged: the working
  computer, Chrome allowing the network, Sending, a warning, noting, Stop for today, an ask in line. Then it asks
  (`planNext`, 15 seconds at most) and does the move as it does its own (`asTold`): the same reads, steps, words,
  pace and limits. It plans the go itself, with the code it had, when HandsFreeOS doesn't decide, can't be reached, or
  sends a move it can't do. It never saves the person's lists while they're at their computer, whatever it's sent.
- **Tested** in core (`outreach-plan.test.ts`, `outreach-plan-ops.test.ts`) and in the extension
  (`follows-plan-next.test.ts`): each kind of move done as sent, and 19 situations of a day where the move the rules
  send is compared with the one the runner picks by itself.
- **Not yet:** switched on (above). The runner's own planning is still there, used when HandsFreeOS can't be
  reached (step 5 takes it out). Nothing on the Plan is pressed yet (step 3).

## Step 2, Alignable, as built

- **The runner** (`apps/extension/src/auto/alignable.ts`, extension 0.157.0). `go` keeps its own checks first, in
  its hours and outside them, then asks (`planNext`) and does the move (`asTold`) with the pieces its own planning
  uses: `beforeGo`, `dailyGo`, `idleGo`, `waitAsTold` and `workNext`. Its own planning follows, unchanged, for a go
  HandsFreeOS doesn't decide. `changeKept` moved to `src/hfos/plan.ts`, as every runner that asks needs it.
- **Switched off** (`PLAN_DECIDES` is still empty). Alignable goes in by itself, after Threads and X, once a day's
  plan there has matched what the computer did.
- **`savesAway`** (`RunnerKit`, `runners.ts`): true only for Threads and X, whose runner never begins a save of the
  person's lists while they're at their computer. Alignable's tab opens away from the front and puts a save off by
  itself, so its save is sent whenever it's due, as its runner tries it, and it never waits for the screen
  (`wait: screen` is one it turns down). Instagram's is true and LinkedIn's `false` (both below). Facebook starts as
  `false`: check it against its runner when its turn comes.
- **The idle look.** With nothing left, `nextMove` capped the next look at the hours' end for every network. Only
  Facebook's runner does that; the others look within the hour and find the hours over. Now the cap is Facebook's
  alone, so a wait HandsFreeOS sends ends when the runner's own would.
- **Tested** in core (`outreach-plan.test.ts`: the save rule, the idle look) and in the extension
  (`alignable-plan-next.test.ts`): each kind of move done as sent, the moves it turns down, and 23 situations
  compared, with when each goes next. A compared go must have done the move it was sent (`didAsSent`): a go that
  turned its move down would match itself and compare nothing.

## Step 2, Instagram, as built

- **The runner** (`apps/extension/src/auto/instagram.ts`, extension 0.158.0). `go` split as Alignable's is: its own
  checks, the ask (`planNext`), `asTold` with `beforeGo`, `dailyGo`, `idleGo`, `waitAsTold` and `workNext`, then its
  own planning, unchanged.
- **Switched off** (`PLAN_DECIDES` is still empty), to go in by itself after a day's plan has matched.
- **`savesAway` is true for Instagram.** Its own order already held its followers' save till the person's away, as
  Threads' and X's does (a first day waits, a later save is left while the rest goes on), so the rule in `nextMove`
  was already its rule. The runner also turns down a save sent while they're at their computer.
- **Decision 159 is untouched.** Who may be messaged is the list's to say (`outreach.today`), and a picked piece of
  work is found on that list and sent by the same code.
- **Tested** in core (`outreach-plan.test.ts`) and in the extension (`instagram-plan-next.test.ts`): each kind of
  move, the moves it turns down, and 26 situations compared, with when each goes next.

## Step 2, LinkedIn, as built

- **The runner** (`apps/extension/src/auto/linkedin.ts`, extension 0.159.0). `go` split as Alignable's is: its own
  checks, the ask (`planNext`), `asTold` with `beforeGo`, `dailyGo`, `idleGo`, `waitAsTold` and `workNext`, then its
  own planning, unchanged.
- **Switched off** (`PLAN_DECIDES` is still empty), to go in by itself after a day's plan has matched.
- **`savesAway` stays `false`.** LinkedIn's tab opens away from the front and a save puts itself off, as
  Alignable's does: checked against its runner, and compared in its test.
- **The helpful post is a move now** (`post`, `RunnerMove` in `plan.ts`). LinkedIn's runner puts today's helpful
  post up on its own where the person lets it (decision 50), between the day's reading and the list, and the rules
  had no move for it. `nextMove` plans it only for a runner's own ask (`here`), where the kit says the runner posts
  (`kit.posts`: LinkedIn and Facebook), their Posting choice is on its own, the day's reading has asked for the post
  (or Collect is off), and it's due (`helpfulDue`). Facebook's goes only in its hours; LinkedIn's whenever its day
  goes. The plan that's shown still leaves it out, and says so: HandsFreeOS can't tell there when the AI will have
  one written.
- **With none written yet the go goes on.** The runner looks again in 30 minutes (`HELPFUL_AGAIN_MS`) and asks
  HandsFreeOS once more in the same go, with the same clock and pace, for what goes meanwhile (`go`, `postGo`). The
  post is looked for once a go, whatever is sent: sent it twice, or with HandsFreeOS out of reach by then, the
  runner plans the rest itself and finds the post not due.
- **Tested** in core (`outreach-plan.test.ts`: when the post is sent, and never on the plan that's shown) and in
  the extension (`linkedin-plan-next.test.ts`): each kind of move, the moves it turns down, and 38 situations
  compared, 14 of them about the helpful post, with when each goes next. Each rule of the post's, broken on
  purpose, fails a situation.

## Step 2, Facebook, as built

- **The runner** (`apps/extension/src/auto/run.ts`, extension 0.160.0). `go` split as the others' are: its own
  checks, the ask (`planNext`), `asTold` with `beforeGo`, `dailyGo`, `watchGo`, `idleGo`, `waitAsTold` and
  `workNext`, then its own planning. Its own planning is the code it had, moved into those functions so a move sent
  and a move planned are done by the same lines.
- **Switched off** (`PLAN_DECIDES` is still empty), to go in by itself after a day's plan has matched.
- **The look for a referral is a move now** (`refer`, `RunnerMove` in `plan.ts`; `kit.refers`, Facebook alone).
  Facebook's runner looks for a referral, or an ask after two, to do for the person (decision 185) every half hour
  in its hours, once the day's reading is done and before the helpful post, the newest posts and the list. The rules
  had no move for it. `nextMove` plans it only for a runner's own ask (`here`), in the hours, when it's due
  (`referDue`). The plan that's shown still leaves it out, and says so: HandsFreeOS can't tell there whether one
  will be due.
- **The helpful post and the newest posts were already Facebook's in `nextMove`** (`kit.posts` in its hours only,
  `kit.watches`), as were its pace (`STARTED_GAP_MS`), its steps spread over what's left of the hours, and the idle
  look that ends with the hours. Each was compared with the runner, and none needed a change.
- **A look with nothing to do lets the go go on.** `refer` and `post` are the go's own to try, each once a go
  (`go`, `referGo`, `postGo`): done, the go ends there at the pace sent. With no referral due (looked for again in
  30 minutes, `REFER_AGAIN_MS`) or no post written yet (`HELPFUL_AGAIN_MS`), the runner asks HandsFreeOS once more
  in the same go, with the same clock and pace, for what goes meanwhile: three asks at most. Sent the same look
  twice, or with HandsFreeOS out of reach by then, it plans the rest itself and finds the look not due.
- **Nothing new outside its hours, whatever it's sent.** A referral, the helpful post and the newest posts go only
  in the working hours, after Start my day too: sent one outside them, the runner turns it down.
- **Its day is its own to read first.** Stop for today, a warning, noting off and an ask of theirs in line hold it
  before it asks, as before. Outside its hours it waits without a word, as it did.
- **One order changed, with nothing to see:** outside its hours it asks whether a comment research of theirs reads
  before it fetches the list, where it asked after, as HandsFreeOS must be told (`here.research`). A reply to
  someone who wrote back still goes before the research reads.
- **Tested** in core (`outreach-plan.test.ts`: when the look is sent, and never on the plan that's shown or to
  another network) and in the extension (`facebook-plan-next.test.ts`): each kind of move, the moves it turns
  down, and 72 situations compared, 10 about a referral, 18 about the helpful post and 9 about the newest posts,
  with when each goes next. 33 rules of the runner's and of `nextMove`, each broken on purpose, each fail a test.

## Step 3, as built

- **One command, one table.** `outreach.plan.change` (`ops/plan.ts`) takes a row's key from the plan and `now`,
  `skip`, `at` (with `time`, as 15:30 on the business's clock) or `back`. It keeps the newest change to each row for
  the day in `addon_outreach.plan_changes` (`20261027036900_outreach_plan_changes.sql`: a person's own, hidden from a
  view of them, one a person, network and row). An earlier day's rows count for nothing and go with the next change.
  It says `outreach.plan.changed`, which the web's Plan hears.
- **A row's key** (`plan-changes.ts`): `job:<read>` for a once-a-day read, `work:<workKey>` for a piece of the
  list's work (a step, a message to write, a message to send). The plan gives each row its `key`, what it can be told
  (`can`) and a change in force on it (`changed`), and lists what's skipped or moved to later (`changes`).
- **The rules read the changes** (`nextMove`, `changesAt`, `workInLine`, `listWithoutOut`): what's skipped, or moved
  to a time still ahead, is left out; what was put first, or moved and now due, is the next move, in the order said.
  Ahead of it stay the runner's own checks, what the person asked of it (`asking`), a first day's lists
  (`holdsTheDay`), a batch's wait (`waitsAgain`) and a read put off till they're away (`passOver`). Outside the
  hours only replies go. With no changes a day runs exactly as before: the runners' comparison tests pass untouched.
- **How it reaches the extension without a new build.** `outreach.today` leaves the people held off the list when
  the extension asks (`forRunner` in `ops/today.ts`; the app's own Today shows everyone), so a runner planning its
  own go works from the same list `nextMove` does. The list sent with a move (`outreach.plan.next`) is cut the same
  way.
- **Where HandsFreeOS doesn't decide the order** (`decidesFor` in `ops/plan.ts`: the network in `PLAN_DECIDES`, and
  the working computer's build from `ASKS_SINCE`), a row for someone offers Skip today and Move to a time, and a read
  offers nothing. Do now, or a change to a read, is refused there (`outreach_plan_order_not_here`). A move there
  holds the step till its time and puts nothing first (`changesLead: false` for the plan that's shown).
- **Refused with what to do:** a row gone from the plan (`outreach_plan_row_gone`), a time past
  (`outreach_plan_time_past`), a time after the hours end (`outreach_plan_time_late`), anything new once they're over
  (`outreach_plan_day_over`), and more than 100 changes a network a day (`outreach_plan_changes_full`).
- **The buttons.** The web's row menu, time box and "Skipped or moved today" (`plan-change.tsx`, `plan-view.tsx`);
  the phone's row sheet with every half hour left till the plan ends (`plan.tsx`, `planMoveTimes`). The words are
  core's (`PLAN_CHANGE_WORDS`, `PLAN_CHANGE_UI`). The phone sends it with signal (`outreach.plan.change` is in the
  phone's contract).
- **The Assistant** has it as `outreach_change_plan`, asking first on a card, and its checklist has the five new
  items (`assistant/ledger/outreach.json`).
- **Not built: a wake.** A change takes hold at the runner's next go: a few minutes off while it works, up to an
  hour (`IDLE_MS`) when it has nothing to do. Waking the extension on `outreach.plan.changed` needs extension code
  that keeps the pace between steps, so it's left for its own change.
- **Tested** in core without a database (`outreach-plan-changes.test.ts`, 30 tests; 16 of the rules broken on
  purpose, each failing a test) and with one (`outreach-plan-ops.test.ts`, `outreach-plan-change-list.test.ts`,
  `outreach-own-rows.test.ts`), and on the phone (`plan.test.tsx`).

## Rules for the steps after

- **A change of the person's to the plan never lets a step past a hold or a limit:** it only leaves a row out or
  picks what's next. A new hold in `nextMove` goes ahead of `changed.first`. And `outreach.today` keeps leaving the
  same people out for the extension as `nextMove` does (`listWithoutOut`), until step 5.

- **A change to a runner's order goes into `nextMove` too**, and for Threads and X into `follows.ts` as well (for
  Alignable, `alignable.ts`; for Instagram, `instagram.ts`; for LinkedIn, `linkedin.ts`; for Facebook, `run.ts`),
  until step 5 makes `nextMove` the only order. Otherwise the plan shows a day the extension won't do, and a go
  planned without HandsFreeOS differs from one it decides. Each runner's `*-plan-next.test.ts` compares the two.
- **A move only some runners do is sent only to those** (`kit.posts` for the helpful post, `kit.refers` for the look
  for a referral), and a runner turns down any move it doesn't know, so a new move never reaches a build that can't
  do it.
- **Every network's runner asks now.** What's left of step 2 is switching each on (`PLAN_DECIDES`), a pull request
  of its own per switch, after a day's plan has matched what its build really did.
- **Compare when a go wakes next, too,** as Alignable's test does: that's how the idle look's difference was found.
- **A network joins step 2 by its own pull request:** its runner's `go` split the way `follows.ts` is (its own
  checks, the ask, `asTold`, then its own planning), its situations compared in a test. Its name goes into
  `PLAN_DECIDES` after, by itself, once its build is out and a day's plan has matched what it did. An older extension
  keeps planning for itself, as it never asks.
- **What only the computer knows goes in `PlanHere`,** never guessed on the server: the plan that's shown says what it
  can't see.
- **The safety rules stay where they're enforced today** (core's limits, the readers' warnings, the warm-up and
  Instagram's follower check): the app deciding the order never lets a step past them.
