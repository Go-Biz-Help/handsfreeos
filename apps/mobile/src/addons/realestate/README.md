# Real Estate Agent on the phone

Round six of `HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md`: the add-on's pages the manifest says the phone draws
(`ui.phone` in `packages/core/src/addons/realestate/manifest.ts`), drawn from the phone's own copy so they work with
no signal. The boards are `design/realestate/Phone*.dc.html` (76–93).

## Where things go

- **Routes** sit inside More, so the tab bar stays, at the web's own addresses:
  `src/app/app/w/[workspaceId]/(tabs)/(more)/a/realestate/…` (`index.tsx` is Deals, `duties.tsx`,
  `deals/[dealId]/index.tsx`, `deals/[dealId]/dates.tsx`…). `_layout.tsx` there is the gate: only someone holding
  `realestate.use`, which they hold only while the add-on runs here. A route file is thin: it reads its params and
  draws a component from this folder.
- **Components and hooks** are in this folder (`src/addons/realestate/`), by group, with their tests in
  `__tests__/`. Only the routes and `src/addons/registry.ts` import from here (lint holds it); inside, import
  relatively.
- **A screen is live** once its route is in `src/links/addon-screens.ts`. Until then links to it (pushes, emails,
  Home cards, the Assistant, More) open the web. `links/__tests__/addon-screens.test.ts` checks each listed route is
  declared by the manifest and has its file.

## Reading

- `useRealestateCopy(workspaceId, reach)` (`copy.ts`) reads the rows; core's views
  (`@hfos/core/addons/realestate/views/*`) work out what the server's query would answer, and
  `packages/core/test/addons/realestate-phone-*.test.ts` holds each to the server. Never shape rows in a screen; if a
  view is missing something, add it to the view (and its parity test).
- `useReContext()` (`kit.tsx`): who is looking, the minute now, the business's today and time zone, and whether they
  see every deal.
- **A deal kept as its summary** (someone who sees every deal, not on this one) has its summary, duties and dates on
  the phone and nothing else: views say `full: false`, `partial: true` or return null. Say so (`SummaryChip`,
  `RE_PHONE_WORDS.summaryNote`) and load the rest with signal (`useLiveAnswer` with the server's query;
  `NeedsSignalCard` with no signal). A query the phone asks for is listed in `QUERIES` in
  `packages/core/test/mobile-contract.test.ts`.
- **Documents' current versions are kept on the phone** (round seven, Chris 2026-10-05; this replaces round six's
  "open with signal"): `src/sync/document-keeper.ts` downloads them on Wi‑Fi into the person's encrypted kept files,
  and the document sheet opens one with no signal (`openKeptDocument`, Quick Look on iPhone, the phone's viewer on
  Android). A replaced or void version is kept only when pinned (Keep on this phone).
- **A listing's lockboxes** (round seven, board 98) aren't in the phone's copy: Showings asks for them with signal
  (`lockboxes.tsx`, `realestate.lockbox.list`), and they never carry the code. Don't add a way to show it here;
  the code goes to the confirmed agent by itself, and only the web shows it again.

## Writing

- Every change is a command, through `change(name, input, { optimistic })` (`src/changes`). The ones that may wait
  with no signal are `ANYTIME` or `FRESH` in `src/changes/commands.ts`, as their definition says (`offline`). A thing
  the phone makes takes the phone's id (`newId()`), so a later change can refer to it (`dependsOn`).
- **Optimistic rows**: write what the person should see at once into the synced rows in the same transaction, e.g.
  `UPDATE addon_phone_rows SET data = json_set(data, '$.status', 'done') WHERE id = ?`. They leave at the next
  checkpoint once the change is handled; the uploader sends only the change. `src/sync/__tests__/phone-sql.test.ts`
  checks every SQL string against the phone's tables (SQLite, not Postgres).
- **Needs signal** (AI drafts, exceptions and waivers, confirming a term, offers, export, holds): `SignalButton` with
  the board's reason. `change()` sends an online command straight away and refuses with `NEEDS_SIGNAL` with none. An
  online command the phone sends is `ONLINE` in `commands.ts` and in `ONLINE_COMMANDS` in the contract test.
- After changing `commands.ts` or the contract's lists: `UPDATE_CONTRACT=1 pnpm --filter @hfos/core exec vitest run
test/mobile-contract.test.ts`, then prettier on `packages/core/test/contract/mobile-contract.json`.

## Words

Shared words are core's: `RE_PHONE_WORDS` and `RE_MORE_WORDS` (`phone-words.ts`), and a group's own words in
`packages/core/src/addons/realestate/phone-words-<group>.ts`. Reuse what core already says (`words.ts`,
`client-words.ts`, `offer-words.ts`, `history-words.ts`, `rule-words.ts`, `states.ts`…) so the web and the phone say
the same thing. Refusals say what's wrong, then what to do; curly apostrophes.

## Check-ins

Showing safety is core (`src/safety/`, `src/components/safety/`): a tour stop, a showing or an open house offers
**Check in** with `CheckInSheet`, prefilled from the appointment.
