# M18 — The AI teammate does the work

M7 gave every business an AI teammate that answers by text, email and website chat, qualifies,
books and hands off. M18 lets it finish the job while the customer is still in the conversation:
join a waitlist, set up repeat visits, check the service area, look up and send bills and quotes,
sign someone up for a plan, see a photo, tell them where their job stands and, last, pick up the
phone.

The rule stays the same as M7: the teammate works only for the customer in the conversation it is
answering, every change is a command that checks that again, and anything with money in it waits
for a person.

## Decisions (Chris, 2026-09-22)

| Question              | Answer                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| "Real time"           | **Both**: live phone calls, and faster text and chat                                                     |
| Money actions         | **Always need a person's OK** (payment links, bills, quotes, plans), even once the teammate is automatic |
| Quotes                | **The owner chooses**: the teammate builds one from the price list, or only sends ones staff made        |
| Photos                | **All four**: rough price range, is it a fit, a note for staff, ask for a better photo                   |
| Jobs                  | **One visit or a project of several visits**                                                             |
| "On my way"           | **Yes, with an arrival time**, from a button in the phone app                                            |
| Service area          | **The owner picks**: ZIP codes, miles from an address, or an area drawn on a map; **several areas** each |
| Promotions            | **A simple offers list** the owner types in (name, details, end date)                                    |
| Repeat service        | **Both**: repeat visits on the calendar and paid maintenance plans                                       |
| Add to an appointment | **All three**: another service, another person, notes and details                                        |
| Payment links         | **Existing bills, deposits, and new bills** (new bills still need an OK)                                 |
| Privacy               | **Phone or email on file is trusted**; a website chat visitor proves who they are with a texted code     |
| Staff alerts          | **Phone app alert and a text to the person's cell** (email stays as an option, off by default)           |
| Businesses            | **All kinds**: home services, studios and salons, offices                                                |
| Language              | **Match the customer**: reply in the language they write or speak                                        |

Carried over from M7, not re-asked:

- No tool takes a person, lead or conversation id. The worker fills them in from the run and the
  command checks them again (`packages/core/src/ai-team/reach.ts`).
- A change the customer sees is held until the reply goes out (automatic) or a person approves the
  draft (training wheels). Money is an **approval** draft in every mode, decided by an owner or admin,
  like today's discount.
- Every AI command is on `AI_EMPLOYEE_COMMANDS`; the kernel refuses anything else.
- An unverified website chat never reads back or changes an existing customer's records.

## Where it stands today

| Task                                   | Before M18                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Open times, book, move, cancel         | Works (`find_times`, `book`, `reschedule`, `cancel`)                         |
| Find their appointments                | Upcoming only (`my_appointments`)                                            |
| Add to an appointment                  | Not built: a visit holds one service                                         |
| Service area                           | ZIP territories exist (`app.territories`); the teammate reads only free text |
| Waitlist                               | Built (`waitlist.*`); not the teammate's                                     |
| Repeat visits / plans                  | Built (`series.create`, `subscription.start`); not the teammate's            |
| Business facts, FAQs                   | Works (`search_knowledge`, the grounding brief)                              |
| Promotions                             | Not built; only `offer_discount` (approval)                                  |
| Find, update contact, notes, tasks     | Works (fills blank fields only)                                              |
| Deals                                  | Moves open leads between open stages; can't create one, set value, win/lose  |
| Quotes                                 | Built (`estimate.*`); not the teammate's                                     |
| Qualification                          | Works (`record_answers`, forms)                                              |
| Payment links, bill and payment status | Built (`invoice.*`, `payments`); not the teammate's                          |
| Where a job stands                     | No jobs; appointments only                                                   |
| Photos                                 | Stored (`messages.media`); the model sees "(sent a photo)"                   |
| Alert staff, hand off                  | Works; staff hear by email only                                              |
| Phone calls                            | Not live: TwiML ringing and voicemail, transcripts afterwards                |

## Phases

Five steps, easiest wins first. Each step is its own set of commits, CI green before the next.

### Step 1 — Connect what is already built

New settings (all in `TeammateConfig` v1 with defaults, so no upgrade step; stored documents parse
unchanged):

| Setting            | Where            | Default                   | Meaning                                                                                        |
| ------------------ | ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `book.waitlist`    | Book             | on                        | Put a customer on the waitlist of a full calendar (only where it's on)                         |
| `book.repeats`     | Book             | off                       | Book repeat visits (only on calendars that let customers repeat)                               |
| `book.serviceArea` | Book             | on                        | Check the customer's ZIP against the business's areas before offering times                    |
| `deals.enabled`    | new Deals module | off                       | Open a lead when there is none, set its value, mark it won or lost                             |
| `money.bills`      | Money            | off                       | Look up the customer's bills and payments; resend a pay link (approval)                        |
| `money.newBills`   | Money            | off                       | Propose a new bill from the price list (approval)                                              |
| `money.quotes`     | Money            | `off`                     | `off` · `send_only` (staff-made quotes) · `build` (from the price list too)                    |
| `money.plans`      | Money            | off                       | Offer a maintenance plan; signing up waits for approval                                        |
| `handOff.alerts`   | Hand-off         | push + text on, email off | How the team hears the teammate needs a person (email stays on for teammates saved before M18) |

New tools (`packages/core/src/ai-team/tools.ts`, runners in `apps/worker/src/ai-team/tools.ts`):

| Tool                  | Skill                | Autonomy | Runs                                                                           |
| --------------------- | -------------------- | -------- | ------------------------------------------------------------------------------ |
| `check_service_area`  | book                 | auto     | Territory match for a ZIP (`app.territories`); `find_times` takes `postalCode` |
| `join_waitlist`       | book                 | draft    | `waitlist.join_for_customer`                                                   |
| `book_repeating`      | book                 | draft    | `series.book_for_customer`                                                     |
| `open_deal`           | deals                | auto     | `lead.create` for this customer when they have no open lead                    |
| `set_deal_value`      | deals                | auto     | `lead.update` (value only)                                                     |
| `close_deal`          | deals                | auto     | `lead.close_for_customer` (won, or lost with a reason)                         |
| `my_bills`            | money.bills          | auto     | This customer's invoices: number, total, balance, status, due date             |
| `send_payment_link`   | money.bills          | approval | `invoice.send_for_customer`                                                    |
| `propose_bill`        | money.newBills       | approval | `invoice.create_for_customer` from catalogue items, then sent                  |
| `my_quotes`           | money.quotes         | auto     | This customer's estimates and where each stands                                |
| `send_quote`          | money.quotes         | approval | `estimate.send_for_customer`                                                   |
| `propose_quote`       | money.quotes = build | approval | `estimate.create_for_customer` from catalogue items, then sent                 |
| `record_quote_answer` | money.quotes         | approval | `estimate.record_answer_for_customer` (yes with their name, or no)             |
| `offer_plan`          | money.plans          | approval | `subscription.start_for_customer` (the customer adds a card on their link)     |

**As built:** resending a bill or a quote that already went out is a message carrying its link (a
`share_link` action shown on the card), not a command, so `invoice.send_for_customer` and
`estimate.send_for_customer` were not needed; a draft the team hasn't sent stays theirs to send. The
commands are `invoice.create_for_customer`, `estimate.create_for_customer`,
`estimate.answer_for_customer` and `subscription.start_for_customer`, and the Deals switch sits under
Qualify.

Money tools share one approval draft per reply, as the discount does today (`TeammateDraftPreview`
gains the new action kinds; `ai_teammate.send_draft` carries them out as the teammate with the
approver's name). The customer is told only that the team is getting it ready.

Every new command is `actors: ['ai_employee']`, on `AI_EMPLOYEE_COMMANDS`, risk ≤ 2, keeps to the
run's customer with `assertAiReach`, refuses in an unverified chat, and the money ones refuse
without `approvedBy`.

Context: the run's brief lists the business's plans (name, price, what's included) when
`money.plans` is on, and the catalogue (name, price) when a builder tool is on and prices may be
quoted (`allowPrices`).

Alerts: `conversation.handed_off` gets a push (`apps/worker/src/push/moments.ts`) and a text to each
recipient's verified cell (`app.user_phones`), from the business number, once per hand-off.

Build order for step 1 (all done, 2026-09-22):

1. This plan
2. Settings: the new fields, their labels and diffs, the builder's switches
3. Service area: `check_service_area`, `postalCode` on `find_times`
4. Waitlist: `join_waitlist`, `waitlist.join_for_customer`, the held action
5. Repeat visits: `book_repeating`, `series.book_for_customer`, the held action
6. Deals: `open_deal`, `set_deal_value`, `close_deal`, `lead.close_for_customer`
7. Money look-ups: `my_bills`, `my_quotes`, plans and catalogue in the brief
8. Money approvals: the draft kinds, the four money commands, `send_draft`, the inbox and Action Center lines
9. Alerts: push and text on hand-off
10. The prompt, the scripted provider for tests, docs

### Step 2 — Small new pieces

- **Offers list**: `app.offers` (name, details, starts, ends, active); a screen under Knowledge; the
  brief lists live offers; the teammate shares them and never invents one.
- **Service areas, three ways**: `app.service_areas` with kind `zip` · `radius` (address, miles) ·
  `polygon` (drawn on a map), several per business, each optionally tied to calendars. ZIP
  territories move across. Addresses are geocoded once and kept.
- **More on one visit**: `appointment_services` (extra services, their time and price);
  `add_to_appointment` for a service, a person (`appointment.add_attendee`) or notes (gate code,
  pets, what's wrong).
- **Past visits**: `my_appointments` takes `when: 'past'`; the brief carries the last visit.
- **Reply in their language**: the prompt answers in the customer's language; hand-off lines and the
  STOP wording are translated from a fixed list, never by the model.
- **Chat verification**: a code texted to the phone on file lifts the website chat's limits for that
  conversation.

### Step 3 — Photos

- `AiContent` gains an image block (`packages/ai`), and Anthropic's provider sends it.
- The run attaches the last few photos from the batch (resized, from storage, signed for the call).
- `request_photos` asks for the shots it needs; `note_photos` writes what they show on the lead.
- A price range comes only from the price list and the business's own "sizing guide" knowledge,
  said as a range and never as a quote; the owner switches ranges off.

### Step 4 — Jobs and "On my way"

- `app.jobs`: a job is one or more visits, with a status (scheduled, on the way, in progress,
  waiting on parts, done) and a note the customer may see.
- `job_status` tells the customer where their job stands.
- The phone app's **On my way** button texts the customer with a rough arrival time (from the
  device's location to the visit's address) and sets the job to on the way.

### Step 5 — Live phone answering

- A voice agent on the business number, streaming speech in and out (Twilio Media Streams), using
  the same tools, the same holds and the same hand-off (a warm transfer to a person's cell).
- The owner chooses when it answers: always, after hours, or when nobody picks up.
- Money still waits for an OK: on a call it says the team will text the link.
- Faster text and chat: shorter debounce for chat and text once replies are automatic.
