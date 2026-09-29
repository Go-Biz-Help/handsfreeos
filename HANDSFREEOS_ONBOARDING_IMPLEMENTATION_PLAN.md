# Getting started — Implementation Plan

A new business should reach a working setup without anybody showing them around. Today it gets one card on
Home, **Finish setting up**, with five items (two already ticked), and the card disappears for good the moment the
first customer arrives. This plan replaces it with a guide: four quick questions after **Create business**, a wizard
through the few things every business needs, a checklist on Home for the rest, and a short tour of the menu.
Teammates get a short list of their own, and an agency sees where every client business has got to.

> **Status: step 1 of §11 is built** (the core: the catalogue, `onboarding.status`, the commands, the words and
> their tests). Nothing shows on a screen yet. The screens are in `design/onboarding` (twelve boards, most clickable
> in Play). Read them with this plan.

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
| Businesses that exist      | **They get the guide on Home too**, with what they've already done ticked                                                                                                 |
| The phone app step         | **Sends the test links** (TestFlight and Google Play internal testing) **until Chris says to switch** to the store versions                                               |
| Texting turned down later  | **A card on Home, plus the email that already goes out.** The guide stays gone                                                                                            |
| When the AI step is done   | **The teammate exists and its knowledge isn't thin.** It stays in training until it has earned its approvals, as today                                                    |
| Today's checklist items    | **Confirm email and Create business go. Passkey and Google sign-in become "Sign in faster" on everyone's list**, owners included                                          |

Choices the decisions didn't spell out, made on the boards and open to change:

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
- The phone app isn't in the stores yet; the store addresses in `apps/site/src/content/site.ts` are empty. The app
  step sends the test links instead (§3).

## 3. The steps

One catalogue in `packages/core/src/onboarding/`, so the web, the phone and the agency view agree on what each step
is, when it's done and what it says.

| Step         | Who sees it (permission)                | Must-do?                   | Done when                                                                                                                  | Waiting, or needs a fix                                                                                                                                                    |
| ------------ | --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number`     | `channels.manage`                       | Yes, always first          | `phone.setup_status.nextStep` is `awaiting_approval` or `ready`: a number is bought and the registration sent              | Waiting while `awaiting_approval` (day count shown); needs a fix when `rejected`                                                                                           |
| `payments`   | `money.manage`                          | Only when the goal is paid | A `payment_connection.list` item is `active`                                                                               | Waiting while the provider is still checking it (no capability on yet, as Settings → Payments says); needs a fix on `capabilities.needsInfo`, `reauth_required` or `error` |
| `customers`  | `records.import` or `migrations.manage` | Yes                        | `crm.summary` people + companies > 0, **or** "Add them as you go" chosen                                                   | Waiting while an import or migration is counting or running                                                                                                                |
| `calendar`   | `calendars.manage`                      | Yes                        | An active calendar with at least one service, and the booking page on with a public calendar on it                         | —                                                                                                                                                                          |
| `ai`         | `ai_team.manage` and `knowledge.manage` | Yes                        | The teammate exists and its knowledge isn't thin (`ai_teammate.get`; thin is under 5 items or the profile under half full) | Still to do, saying "Keep what's right", while the website scan has suggestions nobody has kept                                                                            |
| `team`       | `members.invite`                        | No. Hidden for "Just me"   | More than one member, or an invitation that hasn't expired                                                                 | —                                                                                                                                                                          |
| `email_chat` | `channels.manage`                       | No                         | A mailbox `active` **and** the chat widget seen on the site (`email.setup_status`, `chat_widget.list` `install.seen`)      | Shows "1 of 2" when one is done                                                                                                                                            |

Those seven are the **business steps**: shared by everyone who manages the business, and what the agency view
counts. The **personal steps** belong to one person:

| Step            | Who       | Done when                                                                       |
| --------------- | --------- | ------------------------------------------------------------------------------- |
| `app`           | Everyone  | This person has a phone registered (`push_device.list`), or the phone says so   |
| `sign_in`       | Everyone  | They have a passkey or Google sign-in (read in the browser, as today)           |
| `notifications` | Teammates | That phone has push allowed (a phone registers only once it is)                 |
| `my_calendar`   | Teammates | They have an `active` Google or Outlook connection (`calendar_connection.list`) |

An owner or admin sees the business steps plus `app` and `sign_in` under "When you're ready" (9 rows, "3 of 9
done" on the boards). A teammate, anyone without `workspace.update`, sees only the four personal steps.

What only the device knows comes in with the request (`device: { signIn, app, notifications }` on
`onboarding.status` and `onboarding.finish`): the browser reads the person's passkeys and Google sign-in, and the
phone knows it is the app and whether notifications are allowed. A step `waiting` on someone else (the carriers, a
provider checking an account, an import running) counts as done: the person's part is.

**The phone app links.** Until the app is in the stores, "Get the phone app" opens a small sheet with one link
for iPhone and one for Android, each with a QR code to scan from a computer:

- iPhone (TestFlight): `https://testflight.apple.com/join/GBEM8rJU`
- Android (Google Play internal testing): `https://play.google.com/apps/internaltest/4701652122344223804`

They live in one place, `packages/core/src/onboarding/app-links.ts`, which the web, the phone's teammate list and
the emails all read. When Chris says the store versions are out, that file changes to the store addresses (and
`apps/site/src/content/site.ts` gets them too). Google Play's internal testing installs only for Google accounts on
the test's tester list in Play Console; anyone else sees "app not available".

Two details:

- **"Invited" today counts expired invitations** (`workspace.get` counts any not accepted or revoked, and
  invitations expire after 7 days). The `team` step counts only live ones.
- **The order** comes from the first question: answering leads fast puts `ai` second, getting booked puts
  `calendar` second, getting paid puts `payments` second, getting organized puts `customers` second. `number` is
  always first.

## 4. What's kept, and where

No new tables. Everything fits the settings documents that already exist. (The one migration is for the new Home
card, §6.)

**The business's answers and skips**, in `workspaces.settings.onboarding`, with its own command (added to
`SETTINGS_WITH_THEIR_OWN_COMMAND`, so `workspace.update` refuses it):

```ts
{
  answers?: { goal: 'leads' | 'booked' | 'paid' | 'organized';
              customersIn: 'sheet' | 'ghl' | 'crm' | 'phone' | 'none';
              teamSize: 'solo' | 'small' | 'big' };
  skipped?: Partial<Record<BusinessStepKey, { at: string; by: string }>>;
  customersAsYouGo?: { at: string; by: string };
}
```

The website answer goes into `settings.website`, which Settings → Workspace already edits and workflows use as
`{{business.website}}`; the AI step starts its website scan from it. Skips belong to the business, not the person,
because the agency view and a second owner need to see them.

**One person's view**, in `users.settings.onboarding`, keyed by workspace (the document is per person, not per
business):

```ts
{ [workspaceId: string]: { hidden?: boolean; tourDoneAt?: string;
                           finishedAt?: string;   // set once, the first time every step on their list was done or skipped
                           skipped?: Partial<Record<PersonalStepKey, string>> } }
```

The onboarding commands write it, not `user.update_profile`, so a client never has to send every business's entry
back to change one. `finishedAt` is kept per person because each person's list is different: an owner's includes
their own phone and sign-in, and a teammate's is only theirs.

Both documents already sync to the phone (`apps/sync/sync-config.yaml`), so nothing in the sync config changes.

**Why `finishedAt` is stored and not only worked out:** a mailbox that signs out next month shouldn't bring the
guide back. Once every step has been done or skipped, the guide is finished for good. After that, problems go where
they go today: the Action Center (`connection_error`, and the new `texting_rejected`, §6) and the settings pages.

**Businesses that already exist** need nothing moved: no `finishedAt` means the guide shows. Their steps are worked
out from what they've already set up, so most arrive ticked. One that's already complete finishes without showing
anything.

## 5. Commands and queries

All through the kernel, with events, outbox and audit rows as usual. Refusals follow CLAUDE.md's error rules: say
what's wrong, then what to do, and clients branch on `rule`.

| Name                      | Kind    | Permission             | What it does                                                                                                                                                                                                                      |
| ------------------------- | ------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding.save_answers` | command | `workspace.update`     | Saves the four answers; writes the website, typed as people type it ("lonestarhvac.com"), to `settings.website` as a link                                                                                                         |
| `onboarding.skip`         | command | `workspace.read`       | `{ step, skipped: boolean }`: skips a step, or brings it back. A business step needs `workspace.update` (`onboarding_business_step`); a personal one is the person's own (`onboarding_not_your_step` when it isn't on their list) |
| `onboarding.as_you_go`    | command | `workspace.update`     | Records "Add them as you go", or takes it back                                                                                                                                                                                    |
| `onboarding.set_view`     | command | `workspace.read`       | Hides the guide or shows it again, and records the tour finished; this person's own view                                                                                                                                          |
| `onboarding.finish`       | command | `workspace.read`       | Sets this person's `finishedAt` once every step on their list is done, waiting or skipped. Refused otherwise (`onboarding_not_finished`), naming the steps still open. Says the same after                                        |
| `onboarding.send_link`    | command | `workspace.read`       | Emails this person a link to one step ("Email me a link" on the phone). The worker sends it from the event                                                                                                                        |
| `onboarding.status`       | query   | `workspace.read`       | The business steps in order, each `todo`, `waiting`, `needs_fix`, `done` or `skipped`, with its facts; counts; `complete`; `finishedAt`; this person's `hidden` and `tourDoneAt`; and the personal list                           |
| `onboarding.clients`      | query   | `org.templates.manage` | For each business in the organization: done count, total, the step that's stuck and why, and when the owner last signed in                                                                                                        |
| `onboarding.remind`       | command | `org.templates.manage` | Emails a business's owners a reminder with their next step. Once a day per business at most                                                                                                                                       |

- `onboarding.status` reads the same tables, by the same rules, as the screens that own them
  (`onboarding/load.ts`: the texting readiness from `messaging/store.ts`, the AI's "enough knowledge" from its own
  warning), so a step can never disagree with its own settings page.
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
- **Businesses that already exist** get the same card on Home, above the Action Center. They never went through the
  questions, so the card offers "Answer 4 quick questions to put these in order" (the questions page, then back to
  Home) and uses the default order until then. The wizard isn't opened for them; each row still opens its wizard
  screen. The tour is offered once, from the card.
- **The tour** (board 7): five stops (Home, Inbox, Pipeline, Calendar, Ask HandsFreeOS), shown once after the
  wizard and again from Get help. Anchored to `data-tour` attributes on the sidebar rows. On a phone-width browser
  it points at the bottom bar instead, and skips Ask HandsFreeOS. A small component of our own: there's no tour
  library in the app, and five popovers don't need one.
- **Get help** (board 8): "Getting started · 3 of 9" (shows the guide again) and "Take the tour". A dot on Get help
  while the guide is hidden and unfinished. Hiding shows a toast: "Getting started is hidden. It's under Get help
  whenever you want it."
- **Agency** (board 11): a Setup column (the seven business steps) and All / Stuck / Setting up / Done filters on
  **Client businesses**. A
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

**Texting turned down after the guide is gone**

The `number` step counts as done once the details go to the carriers, and they can refuse weeks later. Owners
already get `textingRejectedEmail`. Nothing puts it on Home today: `connection_error` only covers a phone number
whose status is `failed`, not a refused registration. So a new Action Center kind, `texting_rejected`:

- Raised when a registration's status becomes `rejected`, for owners and admins, always on (like `connection_error`).
- Its words quote the carriers' `rejection_reason` and say what to do: fix the details in Settings → Texting & calls
  and send them again. The button opens that page.
- It clears when a new registration is sent, or one is approved.
- Built by the checklist every new kind follows (`HANDSFREEOS_AUTOMATIONS_IMPLEMENTATION_PLAN.md`, "New Action
  Center kinds"): `attention/kinds.ts`, a `kindSwitches` default, a detector, its facts loader, the worker's
  subjects, the Home words, and a migration re-creating `attention_items_kind_check`. The hosted database gets that
  migration before `main` does (`docs/operations.md`, "Apply new migrations").

## 7. Words

Every title, detail, waiting line, refusal and toast lives in `packages/core/src/onboarding/words.ts`, the way the
Add-ons page's words live in `addons/words.ts`. The web and the phone import them.

## 8. Tests

- `packages/core/test/onboarding/`: each step's done, waiting and needs-fix rules; the order for each goal; `payments`
  becoming a must-do for "paid"; `team` hidden for "just me"; expired invitations not counting; `onboarding.finish`
  refused while a step is open; an existing, fully set-up business finishing without a card; the agency count
  leaving out personal steps.
- `texting_rejected`: raised on a refused registration, quotes the reason, clears on a new one or an approval.
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

None. The five from the first draft were settled on 2026-09-29 and are in §1. One thing to do outside the code:

- **The Android testers list.** Google Play's internal test installs only for Google accounts added in Play
  Console. Until the store version is out, each new business's owner (and their team) has to be added there, or the
  Android link won't work for them.

## 11. Build order

Each step ships alone and leaves the tree green.

1. ✅ **Core**: the catalogue, `onboarding.status`, the commands, the words, and their tests. `pnpm openapi`.
2. **Home**: `GettingStarted` replaces `SetupChecklist`, with skip, hide, the Get help entry and the finish card,
   for new and existing businesses. The phone app links sheet. The e2e specs move with it.
3. **The quick questions** after Create business, and the order they set.
4. **The wizard**, one step at a time: `number` (with `NumberStep` exported), `ai`, `customers` (with the way back
   from a migration), `calendar`, then `payments` (with the worker's `returnTo`).
5. **The tour.**
6. **Teammates**: the personal list on the web.
7. **Phone**: the owner's card, the teammate list, and "Email me a link" (the worker's email).
8. **Agency**: `onboarding.clients`, the Setup column and sheet, and `onboarding.remind`.
9. **The `texting_rejected` card**, with its migration applied to the hosted database first.
10. **Measuring**: a saved count over `app.events` for skips and finishes, beside the Matomo page-view funnel.
