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
2. **The app decides, the extension does.** Each runner's `go()` asks HandsFreeOS for its next move (`nextMove` on
   the server, with the list and the day it already has) and does it, saying how it went. One network at a time, the
   smallest first: Threads and X, then Alignable, Instagram, LinkedIn, and Facebook last. Each keeps its own pace,
   warnings and limits. With no connection, a runner goes on as it does today until it's back.
3. **Buttons on the plan:** do now, skip today, move to a time. Each is a command, so the Assistant can do it too.
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

## Rules for the steps after

- **A change to a runner's order goes into `nextMove` too** until step 2 makes `nextMove` the only order. Otherwise
  the plan shows a day the extension won't do.
- **Nothing the plan shows tells the extension anything** until step 2. Step 2 moves one network at a time, behind a
  build check, so an older extension keeps planning for itself.
- **The safety rules stay where they're enforced today** (core's limits, the readers' warnings, the warm-up and
  Instagram's follower check): the app deciding the order never lets a step past them.
