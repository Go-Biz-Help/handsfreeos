# Getting started — Implementation Plan

A new business should reach a working setup without anybody showing them around. Today it gets one card on
Home, **Finish setting up**, with five items (two already ticked), and the card disappears for good the moment the
first customer arrives. This plan replaces it with a guide: four quick questions after **Create business**, a wizard
through the few things every business needs, a checklist on Home for the rest, and a short tour of the menu.
Teammates get a short list of their own, and an agency sees where every client business has got to.

> **Status: planned, nothing built.** The screens are in `design/onboarding` (twelve boards, most clickable in
> Play). Read them with this plan.

---

## 1. Decisions (Chris, 2026-09-29)

| Question                   | Decision                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape                      | **Quick questions, then a wizard, then a checklist and a tour.** Create business → 4 questions → the wizard walks the must-dos → Home with the checklist → a 5-stop tour. |
| The quick questions        | **All four**: what do you want help with first; where are your customers now; what's your website; how many people work with you                                          |
| Must-dos                   | **Business number & texting, teach the AI teammate, bring in customers, calendar & booking page**                                                                         |
| "Getting paid"             | Picking it makes **connect payments a fifth must-do**                                                                                                                     |
| In the guide, easy to skip | **Invite your team, connect payments, email & website chat, get the phone app**                                                                                           |
| Skipping                   | **Every step has Skip for now.** The whole guide can be hidden and brought back from Get help                                                                             |
| When the guide goes away   | **Once every step is done or skipped.** Not after a set time                                                                                                              |
| Who sees it                | **Owners and admins get the business guide. Teammates get a short list of their own** (the phone app, their calendar, sign-in) and the tour                               |
| Agencies                   | **An agency sees every client's setup and can do steps for them**                                                                                                         |

Choices the decisions didn't spell out, made on the boards and open to change (§10):

- **The business number always goes first**, whatever the answers: carrier review takes days (toll-free) to weeks
  (local), and everything else can happen while it runs.
- **The number step asks about an EIN before showing numbers.** A business without one has to take toll-free before
  buying, because a local number can't be released while it's in review (`docs/operations.md`, "Texting and calls").
- **"Add them as you go" counts as done** on the customers step. It's a real answer, not a skip.
- **The website answer is used twice**: for the AI teammate's website scan and for the calendar's services.
- **The teammate list has four rows**: the phone app, notifications, their calendar, and a passkey. On the phone the
  app row is already ticked.
- **Steps that need a computer say so on the phone** and offer "Email me a link".

## 2. What the repo has, and what it is missing

**Has:**

- `apps/web/src/app/onboarding/` — **Create business** ("Step 1 of 1"), which runs `organization.create` and lands
  on Home.
- `apps/web/src/components/home/setup-checklist.tsx` and `action-center-intro.tsx`: the five-item card and "This
  page becomes your Action Center". Home shows them only while the business has no customers and nothing needs
  attention (`app/app/w/[workspaceId]/page.tsx`).
- A way to tell whether each step is done, spread over the queries that own it (§3).
- `users.settings`, written by `user.update_profile`, for things one person chooses; `workspaces.settings`, for
  things the business chooses.
- The Assistant can already change almost every setting on request (`docs/operations.md`, "Setting the business up
  by asking"). It can't do sign-ins, DNS, pasting the chat snippet, imports, migrations or carrier approval.
- Emails when carriers approve or turn down texting (`textingApprovedEmail`, `textingRejectedEmail` in
  `apps/worker/src/emails/templates.ts`, sent on `registration.status_changed`).
- A daily agency digest that already walks every client business (`apps/worker/src/agency-digest.ts`).
- The founding claim link (`app/founding/[token]`), which picks a workspace and claims a spot.

**Missing:**

- Anything that remembers a skipped step, a hidden guide, or the answers to the questions.
- One place that says how far a business has got. `workspace.get` carries no setup flags.
- A tour, a "get the app" prompt, and any setup view for agencies.

**In the way:**

- The founding-offers plan (§9 there) ends onboarding on a **plan picker** when there's no claim token or
  subscription. That isn't built. When it is, it goes **between Create business and the questions**, so the numbering
  becomes "Step 1 of 4".
- The phone app is on **TestFlight only**; the store addresses in `apps/site/src/content/site.ts` are empty. Until
  they're filled, "Get the phone app" has nowhere to send people (§10).

## 3. The steps

One catalogue in `packages/core/src/onboarding/`, so the web, the phone and the agency view agree on what each step
is, when it's done and what it says.

| Step         | Who sees it (permission)                | Must-do?                   | Done when                                                                                                                  | Waiting, or needs a fix                                                                          |
| ------------ | --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `number`     | `channels.manage`                       | Yes, always first          | `phone.setup_status.nextStep` is `awaiting_approval` or `ready`: a number is bought and the registration sent              | Waiting while `awaiting_approval` (day count shown); needs a fix when `rejected`                 |
| `payments`   | `money.manage`                          | Only when the goal is paid | A `payment_connection.list` item is `active`                                                                               | Waiting while `pending` or `capabilities.needsInfo`; needs a fix on `reauth_required` or `error` |
| `customers`  | `records.import` or `migrations.manage` | Yes                        | `crm.summary` people + companies > 0, **or** "Add them as you go" chosen                                                   | Waiting while an import or migration is counting or running                                      |
| `calendar`   | `calendars.manage`                      | Yes                        | A calendar with at least one service, and the booking page on (`calendar.list`, `service.list`, `booking_site.get`)        | —                                                                                                |
| `ai`         | `ai_team.manage` and `knowledge.manage` | Yes                        | The teammate exists and its knowledge isn't thin (`ai_teammate.get`; thin is under 5 items or the profile under half full) | Waiting while the website scan has suggestions nobody has kept (`knowledge_scan.get`)            |
| `team`       | `members.invite`                        | No. Hidden for "Just me"   | More than one member, or an invitation that hasn't expired                                                                 | —                                                                                                |
| `email_chat` | `channels.manage`                       | No                         | A mailbox `active` **and** the chat widget seen on the site (`email.setup_status`, `chat_widget.list` `install.seen`)      | Shows "1 of 2" when one is done                                                                  |
| `app`        | Everyone                                | No                         | This person has a phone registered (`push_device.list`)                                                                    | —                                                                                                |

The teammate's own list, for anyone without `workspace.update`:

| Step            | Done when                                                                       |
| --------------- | ------------------------------------------------------------------------------- |
| `app`           | They have a phone registered                                                    |
| `notifications` | That phone has push allowed                                                     |
| `my_calendar`   | They have an `active` Google or Outlook connection (`calendar_connection.list`) |
| `sign_in`       | They have a passkey or Google sign-in (read in the browser, as today)           |

Two details:

- **"Invited" today counts expired invitations** (`workspace.get` counts any not accepted or revoked, and
  invitations expire after 7 days). The `team` step counts only live ones.
- **The order** comes from the first question: answering leads fast puts `ai` second, getting booked puts
  `calendar` second, getting paid puts `payments` second, getting organized puts `customers` second. `number` is
  always first.

## 4. What's kept, and where

No new tables. Everything fits the settings documents that already exist.

**The business's answers and skips**, in `workspaces.settings.onboarding`, with its own command (added to
`SETTINGS_WITH_THEIR_OWN_COMMAND`, so `workspace.update` refuses it):

```ts
{
  answers?: { goal: 'leads' | 'booked' | 'paid' | 'organized';
              customersIn: 'sheet' | 'ghl' | 'crm' | 'phone' | 'none';
              teamSize: 'solo' | 'small' | 'big' };
  skipped?: Partial<Record<StepKey, { at: string; by: string }>>;
  customersAsYouGo?: { at: string; by: string };
  finishedAt?: string;   // set once, the first time every step is done or skipped
}
```

The website answer goes into `settings.website`, which Settings → Workspace already edits and workflows use as
`{{business.website}}`; the AI step starts its website scan from it. Skips belong to the business, not the person,
because the agency view and a second owner need to see them.

**One person's view**, in `users.settings.onboarding`, keyed by workspace (the document is per person, not per
business):

```ts
{ [workspaceId: string]: { hidden?: boolean; tourDoneAt?: string;
                           skipped?: Partial<Record<PersonalStepKey, string>> } }
```

`user.update_profile` replaces a top-level key whole, so the client sends the whole `onboarding` object with
`expectedSettings`. Its schema and reader sit beside the others (`account/menu.ts`, `assistant/consent.ts`).

Both documents already sync to the phone (`apps/sync/sync-config.yaml`), so nothing in the sync config changes.

**Why `finishedAt` is stored and not only worked out:** a mailbox that signs out next month shouldn't bring the
guide back. Once every step has been done or skipped, the guide is finished for good. After that, problems go where
they go today: the Action Center (`connection_error`) and the settings pages.

## 5. Commands and queries

All through the kernel, with events, outbox and audit rows as usual. Refusals follow CLAUDE.md's error rules: say
what's wrong, then what to do, and clients branch on `rule`.

| Name                      | Kind    | Permission             | What it does                                                                                                                                                                                            |
| ------------------------- | ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding.save_answers` | command | `workspace.update`     | Saves the four answers; writes the website to `settings.website`                                                                                                                                        |
| `onboarding.skip`         | command | `workspace.update`     | `{ step, skipped: boolean }`: skips a business step, or brings it back                                                                                                                                  |
| `onboarding.as_you_go`    | command | `workspace.update`     | Records "Add them as you go"                                                                                                                                                                            |
| `onboarding.finish`       | command | `workspace.update`     | Sets `finishedAt` once `onboarding.status` says every step is done or skipped. Refused otherwise, with the steps still open                                                                             |
| `onboarding.send_link`    | command | `workspace.read`       | Emails this person a link to one step ("Email me a link" on the phone). The worker sends it from the event                                                                                              |
| `onboarding.status`       | query   | `workspace.read`       | The business steps in order, each `todo`, `waiting`, `needs_fix`, `done` or `skipped`, with its facts; counts; `complete`; `finishedAt`; this person's `hidden` and `tourDoneAt`; and the personal list |
| `onboarding.clients`      | query   | `org.templates.manage` | For each business in the organization: done count, total, the step that's stuck and why, and when the owner last signed in                                                                              |
| `onboarding.remind`       | command | `org.templates.manage` | Emails a business's owners a reminder with their next step. Once a day per business at most                                                                                                             |

- `onboarding.status` reads the same tables the owning queries read, through shared functions in core, so a step
  can never disagree with its own settings page. Hidden and personal skips go through `user.update_profile`.
- `onboarding.clients` and `onboarding.remind` use the organization scope, like `workflow_template.list`.
  `org.templates.manage` is what organization owners and admins hold, the same people who see the agency area. An
  organization owner or admin already has a role in every business of the organization, so the query reads each
  one under row-level security, one business at a time, the way the agency digest does.
- `onboarding.send_link` and `onboarding.remind` follow `membership.invite`: the command emits an event, the
  worker's handler map picks it up, and the template goes in `apps/worker/src/emails/templates.ts`.
- Register each in `queries/index.ts` or `commands/index.ts`, add it to the ordered lists in
  `packages/core/test/commands.test.ts`, and run `pnpm openapi`; CI checks `packages/api-client` is fresh.

## 6. Screens

The boards in `design/onboarding` show each one.

**Web**

- **Create business** (board: none, unchanged apart from "Step 1 of 3").
- **The quick questions** (board 1): `/onboarding/questions`, "Step 2 of 3". Chips, one website field, and a live
  "Your setup, in this order" panel. Skip these questions keeps the default order.
- **The wizard** (boards 2 to 5b): `/app/w/[workspaceId]/setup/[step]`. A rail of the must-dos in their order, with
  the optional steps listed underneath as "Later, from your checklist"; Back, Skip for now, and one primary button.
  Finish later goes to Home. Each step **mounts the existing component** rather than rebuilding it. Most need a
  small change to live outside their page:
  - `number`: the EIN question, then the number search, then `A2pWizard`. The search is `NumberStep`, private to
    `texting-page.tsx` (2,000 lines); export it. `A2pWizard` already takes its data as props.
  - `ai`: `TeammatePresetPicker` (Answer new leads, Qualify leads, Book visits) and the name, then `WebsiteScan`.
    The scan refreshes through `router.refresh()`, so the step is a server page that loads it, as the knowledge page
    does.
  - `customers`: `ImportWizard` embeds as it is. `ConnectSourceButton` sends people to the migration's own page after
    the scan; give it a way back to the wizard, since counting a big account takes a while.
  - `calendar`: not `CalendarBuilder` (1,000 lines, tied to its page). Create a service calendar with the business's
    hours, then `ServicesPage` (filled from the scan), the Google/Outlook buttons, and the booking site switch.
  - `payments`: `connectPaymentAccount(workspaceId, provider)`. The sign-in always comes back to
    `/settings/payments` (`apps/worker/src/http/oauth.ts`); add a `returnTo` limited to the app's own setup pages.
- **Home** (board 6): `GettingStarted` replaces `SetupChecklist`. It shows until `finishedAt` or `hidden`, whether
  or not the business has customers; once there are, the Action Center sits under it. Two groups, The basics and
  When you're ready, each row with its state and one button. The next open must-do is highlighted. Right-hand
  cards: who can help (the agency, when there is one, and ⌘J). When the last step is done or skipped, the card
  shows "You're set up" once, lists what was skipped with where to find each, and `onboarding.finish` runs.
- **The tour** (board 7): five stops (Home, Inbox, Pipeline, Calendar, Ask HandsFreeOS), shown once after the
  wizard and again from Get help. Anchored to `data-tour` attributes on the sidebar rows. On a phone-width browser
  it points at the bottom bar instead, and skips Ask HandsFreeOS. A small component of our own: there's no tour
  library in the app, and five popovers don't need one.
- **Get help** (board 8): "Getting started · 3 of 8" (shows the guide again) and "Take the tour". A dot on Get help
  while the guide is hidden and unfinished. Hiding shows a toast: "Getting started is hidden. It's under Get help
  whenever you want it."
- **Agency** (board 11): a Setup column and All / Stuck / Setting up / Done filters on **Client businesses**. A
  business opens a side sheet with its steps. "Do it for them" opens the client's workspace at that wizard step;
  "Email a reminder" runs `onboarding.remind`. Stuck means a step needs a fix, or the owner hasn't signed in for 5
  days with must-dos open. The daily agency digest gets one line per stuck business.

**Phone** (boards 9 and 10)

- The owner's Home gets the same card, shorter: the count, the next step highlighted, and each row with one button.
  Steps that need a computer (customers, payments, email & chat) show "Email me a link".
- A teammate's Home gets "Get set up": their four rows, and the tour.
- Both read `onboarding.status` from the API, the way Home already calls `attention.list`. It isn't added to the
  sync streams: it's small, needs signal to act on anyway, and a change to `apps/sync/sync-config.yaml` makes every
  phone copy everything again.
- The notifications row is answered on the phone itself, from the phone's own permission.

## 7. Words

Every title, detail, waiting line, refusal and toast lives in `packages/core/src/onboarding/words.ts`, the way the
Add-ons page's words live in `addons/words.ts`. The web and the phone import them.

## 8. Tests

- `packages/core/test/onboarding/`: each step's done, waiting and needs-fix rules; the order for each goal; `payments`
  becoming a must-do for "paid"; `team` hidden for "just me"; expired invitations not counting; `onboarding.finish`
  refused while a step is open.
- `packages/db/test`: the new settings keys are refused by `workspace.update`; someone without `workspace.update`
  can't skip a business step; an agency admin can read `onboarding.clients` for its own businesses and no others.
- `packages/core/test/commands.test.ts`: the new names in its ordered lists.
- `apps/web/e2e/auth-and-onboarding.spec.ts` (expects "2 of 5 done") and `add-ons.spec.ts` look for today's
  `setup-checklist`. They move to the new card, and a new spec walks questions → wizard (skipping) → Home → hide →
  Get help → show.
- `packages/core/src/assistant/places-map.ts` describes today's checklist to the Assistant; it describes the new one.

## 9. Measuring it

No new tracking. The wizard's steps are their own pages, so Matomo's page views (web and phone) already give the
funnel from `/onboarding` to each step. Skips, finishes and "Add them as you go" are commands, so their events are
in `app.events` to count. The agency view is the other half: which step businesses get stuck on.

## 10. Open items

1. **The phone app step before the stores.** Hide "Get the phone app" until the store addresses are filled, or
   send a TestFlight invite meanwhile?
2. **Texting turned down after the guide finished.** The owners already get `textingRejectedEmail`. Proposed: the
   guide stays finished, and the Action Center gets a card too. Check whether `connection_error` covers a refused
   registration today, and add it if not.
3. **When the AI step counts as done.** Proposed: the teammate exists and its knowledge isn't thin. It stays in
   training (drafts wait for an OK) until it has earned its approvals, as it does today.
4. **Businesses that already exist.** Proposed: no guide on Home for businesses created before this ships; they can
   open it from Get help.
5. **Today's checklist items.** Confirm email and Create business go (they're always done). Passkey and Google
   sign-in move to everyone's personal list, owners included.

## 11. Build order

Each step ships alone and leaves the tree green.

1. **Core**: the catalogue, `onboarding.status`, the commands, the words, and their tests. `pnpm openapi`.
2. **Home**: `GettingStarted` replaces `SetupChecklist`, with skip, hide, the Get help entry and the finish card.
   The e2e specs move with it.
3. **The quick questions** after Create business, and the order they set.
4. **The wizard**, one step at a time: `number` (with `NumberStep` exported), `ai`, `customers` (with the way back
   from a migration), `calendar`, then `payments` (with the worker's `returnTo`).
5. **The tour.**
6. **Teammates**: the personal list on the web.
7. **Phone**: the owner's card, the teammate list, and "Email me a link" (the worker's email).
8. **Agency**: `onboarding.clients`, the Setup column and sheet, and `onboarding.remind`.
9. **Measuring**: a saved count over `app.events` for skips and finishes, beside the Matomo page-view funnel.
