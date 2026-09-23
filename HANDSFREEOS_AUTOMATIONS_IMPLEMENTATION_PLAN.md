# Automations — one page for everything HandsFreeOS does on its own

HandsFreeOS already did a lot on its own: the Action Center, the AI teammate's greetings and follow-ups,
reminders, waitlist offers and the invoice reminders. But each one was switched on or off somewhere different.
**Settings → Automations** puts every automation on one page, in plain words: a name, one sentence, a tag for what
it touches, a switch, and **Adjust** for its timing and wording. Most are on by default. Then it adds the rest of
the list, one stage at a time.

## Decisions (Chris, 2026-09-22)

| Question                              | Answer                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope                                 | **Build what fits the platform now.** Social, blog, email campaigns, promotions, ad platforms and AI phone calls wait for their own features ([later plan](HANDSFREEOS_AUTOMATIONS_LATER_PLAN.md))      |
| New lead at night                     | Text **at any hour only within 15 minutes** of their own form or message; otherwise when quiet hours end. The greeting, and a reply to a lead's own message, **ignore the AI teammate's working hours** |
| Who sends what the AI writes          | **Training mode decides**: drafts to approve while the teammate trains, sent on its own once it graduates, nothing while it's off                                                                       |
| Fixed wording (reminders, form links) | **Sends even while the teammate trains**, as reminders always have                                                                                                                                      |
| Money                                 | **Always asks first**, apart from the invoice reminders a business set up                                                                                                                               |
| Follow-ups after silence              | 9 steps (4 h, then days 1, 2, 4, 7, 10, 14, 21, 30), then **monthly for 6 months**. Both editable. **On for every business**, existing ones too (release note in `docs/operations.md`)                  |
| Re-engage dead leads                  | **Off by default**; an owner reads the wording before it can go on. **Open leads only**, never lost ones                                                                                                |
| Briefings                             | **Two emails a day**: morning (today's jobs, what needs attention, who to call) and evening (what's still open, plus the counted day)                                                                   |
| Pipeline                              | **Changes the records itself** and notes why on the timeline. Forward only, never reopens won or lost. Stage matching is guessed from names, fixable in Adjust                                          |
| Maintenance due                       | A service's "repeats every N months", with a per-customer override; maintenance plans count                                                                                                             |
| Outreach campaigns                    | **A simple version now**: pick contacts by tag or stage, AI drafts each, a person approves all in one screen, throttled, texting consent only                                                           |
| Confirm yesterday's jobs              | **Staff first** (push with one-tap answers), then the owner's morning email and an Action Center card                                                                                                   |
| Referral mentioned                    | Action Center card with one-tap "create lead, referred by X", **and** the AI thanks the customer                                                                                                        |
| Intake questions                      | On by default, but "Pick a form to start" until a form is chosen                                                                                                                                        |
| The old Action Center settings        | **Merged into Automations**; the old address redirects                                                                                                                                                  |
| Delivery                              | **Staged PRs**, each shippable                                                                                                                                                                          |

## Shape

### The catalog (`packages/core/src/automations/`)

| File          | What it holds                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.ts`  | `AUTOMATIONS`: id, group, label, one sentence, effect (`texts` / `alerts` / `records`), where its switch lives (`binding`), who writes the words (`customerFacing`), what it needs, its Adjust panel |
| `settings.ts` | `workspaces.settings.automations`: the switches no other document owned, read forgivingly                                                                                                            |
| `state.ts`    | `automationRows` (on, working, needs setup, drafts while training) and `automationPatch` (the change a switch makes, for the document it lives in)                                                   |
| `delivery.ts` | `sendModeOf`: the one send rule — fixed wording sends; AI words draft while training, send once graduated, never while off                                                                           |

The catalog owns no behaviour. A row's switch is the setting that automation always read: an Action Center kind
(`settings.attention.kinds`), an AI teammate skill (`ai_teammates.config`), or a switch in
`settings.automations`. Nothing is migrated, and every existing reader keeps working.

### Commands

`automations.save_settings` saves `settings.automations`. The page saves the other two through their own
commands (`attention.save_settings`, `ai_teammate.save_config`), so everything that listens to them still hears
it.

### New Action Center kinds

Every new kind follows the same checklist: `attention/kinds.ts` (list, labels, subject, permissions, handle
label), a `kindSwitches` default, a detector in `attention/detectors/`, its facts loader, the worker's subjects,
the Home words, and a migration re-creating `attention_items_kind_check` (like
`20260930000900_wallet_warnings.sql`).

## What each automation is

**E** exists · **G** new switch over existing code · **K** new Action Center kind · **J** scheduled job · **R**
reacts to an event · **T** AI teammate change.

| Group                | Automation                    | How                                                                          | Stage |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------- | ----- |
| Leads and sales      | New lead greeting             | E (`respond.newLeads`) + T: 15-minute night window                           | 1, 2a |
|                      | Hot lead alert                | E (`hot_lead`)                                                               | 1     |
|                      | Unanswered-message alert      | E (`unanswered_lead`, `customer_waiting`)                                    | 1     |
|                      | Follow-ups after silence      | E (`followUp`) + T: the 9-step ladder, then monthly                          | 1, 2a |
|                      | Follow-ups when never replied | T: same ladder, written from the form's answers                              | 2a    |
|                      | Chase an offered time         | J + T: offered times, no reply, slot still free                              | 2a    |
|                      | Re-engage dead leads          | J, off by default, wording read first                                        | 2a    |
|                      | Outreach campaigns            | New campaigns feature                                                        | 5     |
| Appointments         | Day-before confirmation       | G `dayBefore` in `booking/reminders.ts`                                      | 1     |
|                      | Day-of reminder               | G `dayOf` in `booking/reminders.ts`                                          | 1     |
|                      | Unconfirmed visit alert       | E (`unconfirmed_appointment`) + the confirmation request                     | 1     |
|                      | Waitlist slot opened          | G `waitlist` in `booking/waitlist.ts`                                        | 1     |
|                      | Intake questions              | R on booking: the chosen form's link                                         | 2b    |
|                      | Maintenance due               | R + J: `service_schedules`, a rebook ask before it's due                     | 2c    |
| After the job        | Overdue invoices              | E (`invoice_overdue`)                                                        | 1     |
|                      | Job finished, no thank-you    | R + J + T: the teammate's thank-you (a `task` run), else K `job_not_thanked` | 2b    |
|                      | Referral mentioned            | K `referral_mentioned` + `app.referrals` + T                                 | 2b    |
| Daily briefings      | Morning brief                 | E + G `morningBrief`; adds today's jobs, who to call and unconfirmed jobs    | 1, 3a |
|                      | End-of-day close-out + report | J `evening_brief.send`                                                       | 3a    |
| Pipeline and records | Stale opportunities           | E (`stale_opportunity`), with the follow-up in the business's words          | 1     |
|                      | Leads with no next step       | E (`missing_next_action`)                                                    | 1     |
|                      | Quotes with no decision       | E (`estimate_waiting`)                                                       | 1     |
|                      | Open / move deals             | R: stage roles in `settings.automations.pipeline`, forward only              | 3b    |
|                      | Pipeline reality check        | K `pipeline_mismatch`                                                        | 3b    |
|                      | Engaged leads not in pipeline | R: a deal made for them (Chris: make it, no card)                            | 3b    |
|                      | Went quiet after a price      | K `quiet_after_price`                                                        | 3b    |
|                      | Confirm yesterday's jobs      | K `job_unconfirmed` + the job-check push                                     | 3b    |
|                      | Booked, never completed       | K `job_never_completed`                                                      | 3b    |
|                      | Jobs missing an address       | K `job_no_address`                                                           | 3b    |
|                      | Job window passed             | J: push the staff member when the job's time has passed                      | 3b    |
| Service and handoffs | Overdue tasks                 | E (`overdue_task`)                                                           | 1     |
|                      | Aging handoff                 | J: pushes at 1 h and 4 h (`automations/handoff.ts`), owner told at 4 h       | 4a    |
|                      | Client going quiet            | K `client_quiet`                                                             | 4a    |
|                      | Requests never answered       | K `promise_due` (promises not kept), over `app.promises`                     | 4a    |
|                      | Decisions expiring            | `ai_approval` urgent 2 h before, plus a push (`automations/expiring.ts`)     | 4a    |
| Marketing            | Drafts awaiting review        | E (`ai_approval`), always on; campaigns join it in stage 5                   | 1     |
| Ads and money        | Balance running low           | E (`wallet_low`)                                                             | 1     |
|                      | Revenue moved                 | K `revenue_moved`, from payments                                             | 4a    |
| Health and quality   | Channel went quiet            | K `channel_quiet`                                                            | 4b    |
|                      | Connected system silent       | K `connection_silent`, from each connection's last sync                      | 4b    |
|                      | Connection error              | K `connection_error` (always on) + push switch `connections`                 | 4b    |
|                      | Nobody reviewing the AI       | K `ai_unreviewed`                                                            | 4b    |
|                      | Repeated corrections          | K `ai_corrections`, over `app.teammate_lessons`                              | 4b    |
|                      | Website changed               | K `website_changed` + a weekly automatic re-read                             | 4b    |
|                      | FAQ suggestions               | K `faq_suggestions`                                                          | 4b    |

## Build order

1. **The page, the catalog and the switches** — no behaviour changes. Every existing automation gets its row;
   the day-before and day-of reminders, waitlist offers and the morning email get a business-wide switch
   (on by default). Settings → Action Center redirects here.
2. **a. Leads** — the night greeting, the follow-up ladder, never-replied, chasing an offered time, re-engaging
   dead leads. **b. Appointments and after the job** — intake questions, the thank-you, referrals
   (`app.thank_yous`, `app.referrals`, and the Action Center kinds `job_not_thanked` and `referral_mentioned`).
   **c. Maintenance due** — `services.repeat_months`, a plan's service and `visit_every_months`, a customer's own
   `app.service_schedules`, the daily `automations.maintenance` job with `app.maintenance_reminders`, and the
   Action Center kind `maintenance_due`.
3. **a. Briefings** — the morning email's additions and the evening email. **b. Pipeline and jobs**
   (Chris, 2026-09-23):
   - **Moving deals** also marks them **won** when the customer says yes: the quote is accepted, or the job is
     done. Always noted on the timeline, forward only.
   - **Someone really talking with you** (a back-and-forth, or a real call) who has no open deal gets a lead made
     for them in the first stage, with the reason noted.
   - **Went quiet after a price**: a Home card 2 days after a price with no reply; the follow-up texts carry on.
   - **Wrong stage**: when a deal's stage disagrees with what happened and it couldn't move itself, a card with a
     one-tap move.
   - **Job check**: 30 minutes after a job ends, the staff member on it gets a push (Done / Didn't happen / Still
     there). Unanswered, a second push that evening; then the owner's morning email and a Home card.
   - **Booked, never completed**: a card 3 days after the job's time.
   - **No address**: for services done at the customer's address, a card 2 days before; it clears when the
     address is added.
4. **a. Service, handoffs and revenue** (Chris, 2026-09-23):
   - **Aging hand-off**: after the 15-minute alert, a second push to whoever it was handed to at 1 hour; at 4
     hours the owner is told too and the card turns urgent.
   - **Client going quiet**: a card to check in. A regular is 3+ past paid visits; quiet is twice their usual gap
     between visits, at least 60 days. Skipped when "Maintenance due" already covers them.
   - **Promises not kept**: the AI reads what the team wrote (texts and emails) and call transcripts for a promise
     with a time ("I'll send the quote Tuesday"), a word check first; a card when nothing happened by then.
   - **Decisions expiring**: an approval or draft turns urgent 2 hours before it expires, with a push to whoever
     can approve it.
   - **Revenue moved**: a Monday card only when last week's money in was 30% or more above or below the usual
     week, with the main reason.

   **b. Health and quality** (Chris, 2026-09-23):
   - **Channel went quiet**: a card when a channel (texts, calls, email, web chat) got nothing for 3 times its usual
     quiet stretch, and at least 1 business day.
   - **Connections** (Stripe, Square, Google Calendar, phone number, email inbox): an error (sign-in expired, access
     removed) is urgent at once with a push to owners and admins; silence (no data for 3 times its usual gap) is a
     normal card.
   - **Nobody reviewing the AI**: a card when drafts waited over 7 days with none approved or rejected, or in
     automatic mode nobody opened its conversations in 7 days.
   - **Repeated corrections**: after 3 similar corrections in 14 days, a card with one suggested line for the AI's
     instructions; one tap adds it.
   - **Website changed**: re-read the site weekly; when prices, hours or services changed, a card shows what
     changed, with "Update what the AI knows".
   - **FAQ suggestions**: a card as soon as the same question the AI couldn't answer comes up 3 times; type an
     answer and it's saved to the AI's knowledge.

5. **Outreach campaigns.**

Each stage adds its rows to the catalog as it ships, so the page never shows a switch that does nothing.
