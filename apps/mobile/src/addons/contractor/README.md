# Contractor Operations on the phone

Part 6 of `HANDSFREEOS_CONTRACTOR_OPERATIONS_IMPLEMENTATION_PLAN.md`: the pages the manifest says the phone draws
(`ui.phone` in `packages/core/src/addons/contractor/manifest.ts`), drawn from the phone's own copy so a crew can
work a job with no signal. The rules are in `docs/contractor.md`, "On the phone".

## Where things go

- **Routes** sit inside More, at the web's own addresses:
  `src/app/app/w/[workspaceId]/(tabs)/(more)/a/contractor/…` (`index.tsx` is Jobs, `jobs/[jobId].tsx`,
  `visits/[appointmentId].tsx`). `_layout.tsx` there is the gate: only someone holding `contractor.use`. A route
  file is thin: it reads its params and draws a component from this folder.
- **Screens** are `jobs.tsx`, `job.tsx` and `work-order.tsx`. Each is a container with the hooks (`JobScreen`) and
  a view that only draws (`JobView`), so tests draw the view with plain props.
- **Cards the job and the work order share** are `materials.tsx`, `time.tsx` and `notes.tsx`.
- **`src/addons/registry.ts`** gives core the row in More (`more.tsx`) and the Work order row on a visit's page in
  Calendar (`visit-panel.tsx`, the `VisitPanel` slot). Only the routes and the registry import from here (lint
  holds it); inside, import relatively.
- **A screen is live** once its route is in `src/links/addon-screens.ts`.

## Reading

- `useContractorCopy(workspaceId, reach)` (`copy.ts`) reads the rows; core's views
  (`@hfos/core/addons/contractor/views/phone`) work out what the server's queries would answer, and
  `packages/core/test/addons/contractor-phone.test.ts` holds them to the server. Never shape rows in a screen: if
  a view is missing something, add it to the view and its test.
- Three reaches, so a list doesn't read every job's time and notes: `lists`, `job` and `visit`.
- `useCoContext()` (`kit.tsx`): who is looking, the minute now, and the business's today and time zone.
- **No money is on the phone** (the owner's decision 11). Don't add a price, a budget or a cost to a screen: the
  rows aren't there, and they must not be.

## Writing

- Every change is a command, through the functions in `actions.ts`, which call `change(name, input, { optimistic })`
  (`src/changes`). Six may wait with no signal (`ANYTIME` in `src/changes/commands.ts`): a tick, a count, a break,
  a note, a phase's status and a service call's % done. Two need signal (`ONLINE`): a job's status and taking a
  note off.
- **Optimistic rows**: each action writes what the person should see into `addon_phone_rows` in the same
  transaction. `src/sync/__tests__/phone-sql.test.ts` checks every SQL string against the phone's tables (SQLite,
  not Postgres).
- **A count adds.** `countMaterial` sends how much more was used, wasted or sent back, never a total.
- **A photo or a recording is a file first.** `keepJobFile` keeps it on the phone and uploads it as one of the
  job's files; the tick or the note that points at it waits for the upload (`dependsOn`).
- **What a waiting change is called** (on the phone's Changes page, and when signing out) is in
  `src/changes/describe-contractor.ts`.
- After changing `commands.ts`: refresh `packages/core/test/contract/mobile-contract.json` (see
  `packages/core/test/mobile-contract.test.ts`), then prettier on it.

## Words

The phone's own words are core's `CONTRACTOR_PHONE_WORDS` (`phone-words.ts`). What the web says too (a status, a
material's counts, a note) comes from `words.ts`, so both say the same thing. Refusals say what's wrong, then what
to do; curly apostrophes.

## Tests

`__tests__/actions.test.ts` runs the changes on the phone's real database (the harness in
`src/changes/__tests__/harness`), and `__tests__/screens.test.tsx` draws the views. `__tests__/fixtures.tsx` seeds
one small business for both.
