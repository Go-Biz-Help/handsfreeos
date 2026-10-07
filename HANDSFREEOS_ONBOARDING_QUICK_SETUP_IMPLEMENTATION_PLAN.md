# Quick setup for a new business (onboarding) — Implementation Plan

A new owner spends about 20 minutes getting set up today, on the web only: sign up, Create business, four quick
questions, then setup steps that each drop a whole settings page in front of them (eight screens of carrier
registration, the full Services editor, a booking page that can start switched off). Quick setup for onboarding
replaces all of it with one guided run of simple questions, one per screen, that skips what doesn't apply and keeps
the answers as it goes. At the end the business can take a lead from start to finish: a number (or one on the way),
a booking page if customers book a time, and its AI teammate on with training wheels.

It is built like the AI teammate's quick setup (`HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md`), and the AI
teammate's part of it is that quick setup's own screens.

> **Status: steps 1 to 5 of §11 are built** (the fixes, GoHighLevel by token only, the nineteen kinds of business,
> the shared part in core: the stops and screens, the answers and what each one sets, `onboarding_setup.get`,
> `onboarding_setup.save` and `onboarding_setup.finish`, the summary and the words; and signing up on the web and the
> phone). The flow chart is the
> "Onboarding quick setup" artifact; the questions and the owner's answers are `onboarding-setup/questions.md` in the
> project files.

---

## 1. Decisions (Go Biz Help, 2026-10-06)

57 questions, each with a pick. The owner took every pick except the ones in bold below.

| Question                  | Decision                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Where it lives            | It replaces Create business, the quick questions and the setup steps, with one guided flow                              |
| How it asks               | One question per screen, big answers to tap, skipping what doesn't apply; a live summary beside the questions           |
| Leaving halfway           | It keeps the answers, so they can carry on later, on the computer or the phone                                          |
| The AI teammate           | Inside this flow, minus what was already asked                                                                          |
| Signing up                | Google on sign-up and sign-in; the email check is a 6-digit code typed on any device; passwords stay 12 characters      |
| The address               | Asked once, up front, and used everywhere; it sets the time zone, shown to confirm                                      |
| What you do               | 8 big buttons and a search, instead of a list of 116                                                                    |
| Words                     | "Business" everywhere in setup, never "workspace"                                                                       |
| Hours and services        | Each asked once and used everywhere; services are one simple list with a name, and an optional price and length         |
| The team                  | "How many people work with you?" stays, with an optional "Invite them now"                                              |
| **Logo and colour**       | **Asked in setup, and used on the booking page, website chat, invoices and emails** (18B, new work)                     |
| Review link               | Asked in setup, optional, with help finding it                                                                          |
| EIN                       | Asked once; local with one, toll-free without, as today                                                                 |
| **The number**            | **Picked near their address with "Show me others", and they can search too** (22 A and B)                               |
| Carrier registration      | One "Check these details" screen with everything already known filled in; sample texts written for them                 |
| **Privacy policy, terms** | **Asked for the carriers, as today** (26B)                                                                              |
| Fees                      | Paid inside setup, coming right back (27A)                                                                              |
| Waiting for approval      | They carry on, and the end shows what already works                                                                     |
| Customers                 | "Where are your customers now?" goes straight to its way in; columns matched for them; phone contacts picked in the app |
| **GoHighLevel**           | **Only with a private integration token: HandsFreeOS is doing away with its GoHighLevel app** (33)                      |
| Booking                   | "Do customers book a time with you?"; the calendar and booking page made for them, switched on from the start           |
| Payments                  | Everyone is asked, Stripe or Square, with Later; today's payment defaults stay                                          |
| Email and chat            | Split: the chat is offered in the AI part; email starts with their HandsFreeOS address                                  |
| **No website**            | **Offer to build a simple page for them** (43B, new work)                                                               |
| **The phone app**         | **Everything works on the phone too, sign-up and creating the business included** (45B)                                 |
| Your cell                 | Asked in setup, confirmed with a quick call                                                                             |
| Done                      | When the business can take a lead start to finish; the AI is turned on with training wheels after the test chat         |
| After setup               | A short Home card for what's left, and the tour                                                                         |
| Agencies                  | An agency can set up a client's business and invite the owner to finish; it can save answers as a starting point        |
| **Who it's for**          | **A large number of business types, not only five, and the AI quick setup to match** (56)                               |

The flow chart named nine calls the answers didn't cover. The owner hasn't changed any, so they stand:

1. About 15 minutes, not 10: the logo, the simple page and the test chat each add a little.
2. The 8 buttons are the business list's own groups; "Something else" opens the rest, and the search finds all 116.
3. The logo comes from the website when it has one, and the colour from the logo.
4. The simple page is the booking page grown into a one-page site: one page to keep up, not a website builder.
5. The number comes after the page and booking, so the carriers see a real page and the opt-in.
6. GoHighLevel only by token, everywhere: Settings → Migrations and the agency area too.
7. On an iPhone, Sign in with Apple sits beside Google, as Apple requires.
8. Phone contacts are picked one by one, never the whole address book.
9. People invited during setup join as team members; an owner can make any of them an admin later.

---

## 2. What the repo has, and what it was missing

- **Create business** (`organization.create`): the name, the industry and a time zone from a list of seven.
- **Getting started** (`onboarding/`): four quick questions after Create business (the goal, where customers are,
  the website, the team's size) kept in `workspaces.settings.onboarding`, and a list of setup steps on Home
  (`BUSINESS_STEPS`) that each open a settings page. `loadOnboardingFacts` reads what each step has done.
- **The AI quick setup** (`ai-setup/`): the kinds of business, the AI teammate's screens, its answers, plan and
  summary.
- **Missing:** the business's address (nothing asked for it), one set of answers covering the whole setup and kept
  part way through, services with a price and a length, a booking page made from the answers and turned on, the
  review link in setup, and words for what each answer will change.

---

## 3. Kinds of business

The AI quick setup's nineteen kinds (`ai-setup/kinds.ts`) cover all 116 industries. Onboarding adds two things per
kind (`onboarding-setup/kinds.ts`, `ONBOARDING_KIND_INFO`):

- **Whether customers book a time**, the starting pick for "Do customers book a time with you?". It picks the goal
  (Getting booked, else Answering leads fast), ticks Book for Ava, and shows the booking stop. Yes for salons,
  fitness, health, pets, auto, lessons, legal and money, professional services and property management; No for the
  rest. A business that already has a calendar customers can book counts as Yes.
- **What the business calls what it sells**: "Services", "Classes and sessions", "Lessons and programs",
  "Properties", "How you help", "Kinds of insurance", "Packages", "Menu", "Rooms and trips", "What you rent",
  "Products" or "Programs". The booking calendar keeps the AI quick setup's name for it ("Service calls",
  "Appointments", "Lessons").

**The 8 buttons** (`ONBOARDING_PICKER`) are the business list's own groups: Home services and trades; Beauty and
fitness; Health and care; Real estate and property; Finance, legal and insurance; Events, food and hospitality;
Professional services; and Something else (pets, auto and vehicles, education and childcare, rentals and equipment,
retail, community, and anything else). A button opens the exact kinds in its groups (`industriesForPicker`); the
search finds any of the 116.

---

## 4. The screens

Thirteen stops (`ONBOARDING_SETUP_STOPS`). Signing up comes first and makes the business, so it isn't a screen here;
the AI teammate's stop is several screens. "Your look" and "A simple page" join after the hours when they're built
(§11).

| Stop | Screen                            | Asks                                                                                                                                                                         | Saved                                    |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Sign up                           | Google, Apple on an iPhone, or email with a 6-digit code (§11 step 5)                                                                                                        | Their account and the business           |
| 2    | Your business                     | Name, what you do, your address (it sets the time zone), your website or "We don't have one"                                                                                 | At once; Ava starts reading the website  |
| 3    | What do you want help with first? | The goal; how many people work with you, with an optional "Invite them now"                                                                                                  | At once: invitations, Getting started    |
| 4    | About your business               | What you do, your services (name, optional price and length), where you work; do customers book a time?                                                                      | At "Stay in the loop"                    |
| 5    | When are you open?                | Open hours                                                                                                                                                                   | At "Stay in the loop"                    |
| 6    | Where are your customers now?     | GoHighLevel, a spreadsheet, another CRM, phone contacts, or nowhere yet                                                                                                      | At once: Getting started                 |
| 7    | Your booking page is ready        | Nothing: it shows the page. Only when customers book a time                                                                                                                  | At once: the services, calendar and page |
| 8    | Your business number              | Do you have an EIN?, the number, then "Check these details" for the carriers                                                                                                 | Today's number commands                  |
| 9    | Get paid, and get reviews         | Stripe, Square or Later; the Google review link                                                                                                                              | At once: the review link                 |
| 10   | Your AI teammate                  | The AI quick setup's screens: what Ava helps with, quick facts, Meet Ava, how Ava sounds, what Ava learned, qualifying questions (if ticked), website chat (if there's none) | At "Stay in the loop"                    |
| 11   | Stay in the loop                  | Get the phone app or turn on notifications; your cell                                                                                                                        | Everything else                          |
| 12   | Try Ava, then turn it on          | The test chat; Turn on with training wheels                                                                                                                                  | The AI quick setup's own                 |
| 13   | It's already working for you      | Nothing: what works now, and what's still on its way                                                                                                                         |                                          |

**The address** (`onboarding-setup/address.ts`) is a US address: street, an optional suite, city, state and a 5-digit
ZIP code, as the carriers' registration needs it. The state picks the time zone, and a few ZIP code ranges pick
another where a state has two (`timeZoneForAddress`); someone who picks their own time zone keeps it when the address
changes. It's kept in `workspaces.settings.address` (`workspace.update` checks it). Quotes, invoices and campaign
emails carry it when Settings → Payments has no address typed (`businessPostalAddress`), and the number stop uses it
for the texting registration and the number search.

**The summary** beside the questions (`onboardingSetupSummary`) follows the answers before anything is saved and
what's set up after:

> Lone Star HVAC: HVAC in Austin, Texas, on Central time. Open Mon–Fri 7:00 AM–6:00 PM. 6 services, from your
> website. 1,240 customers so far, with more moving over from GoHighLevel. Texts will come from (512) 555-0142 once
> the carriers approve it, usually in 1 to 3 weeks. Calls work now. Customers pay by card through Stripe. Thank-you
> texts ask for a Google review. Ava replies to new leads within a minute, with training wheels.

What a screen still needs before Next is `onboardingSetupScreenProblems` ("Add what customers book, so your booking
page has something to book."), plus the AI quick setup's checks on its screens. Every label is in
`onboarding-setup/words.ts`; the AI part's screens keep the AI quick setup's words.

---

## 5. What's kept, and the commands

**The answers** are one document (`OnboardingSetupAnswers`): the setup's own (goal, team size, whether customers
book a time, where customers are, the EIN, how customers pay, the review link) and the AI quick setup's under `ai`,
since "About your business" and "When are you open?" answer the AI part's questions too. AI services gained an
optional price and length (`AiSetupService`), which the AI quick setup now uses too: its booking services get the
length and price, and the profile shows the price.

**While someone is part way through**, `workspaces.settings.onboardingSetup` keeps the answers, the furthest screen
finished, the kind they were answered for, and who started and finished it. Only the setup's commands write it:
`workspace.update` refuses the key. It's read forgivingly, and carrying on works like the AI quick setup's: the
answers of the screens finished over today's picks, with what's picked by kind picked again when the kind changed
on the first screen. The AI part's answers stay in this record, not the AI quick setup's, because the screens come
in a different order.

**What it starts from** (`onboarding-setup/state.ts`, read by `onboarding-setup/load.ts` as each area's own screen
reads it): the AI quick setup's state, plus the address, the review link, Getting started's answers, the number,
payments and customers as Getting started's steps see them, the booking page, the team and who's invited, the
bookable services, the price list, the person's own hours, and their phones.

**The answers start** (`startingOnboardingSetupAnswers`) from what the business said before (Getting started's
answers, its payments connection, its review link), else from its kind. The AI part starts from the AI quick
setup's picks for that goal, with Book ticked only when customers book a time, or from an agency's saved answers.

**What each answer sets**, worked out the same way on the web, the phone and the commands, with what will change in
words (`onboarding-setup/plan.ts`):

- **Leaving a screen** saves what later stops or other people need: the business itself, invitations, Getting
  started's answers (they order Home's card), "Add them as you go", the booking page (the carriers look at it on the
  number stop), and the review link.
- **"Stay in the loop"** saves the rest at once (`planOnboardingSetup`): the AI quick setup's own plan (open hours,
  the profile, facts, answers, a website chat and the teammate, which stays off), services with a price on the price
  list by name (each tied to the bookable service of its name), and the person's own hours from the open hours while
  they have none of their own.

| Operation                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding_setup.get`    | The state, the answers to start from, today's picks alone (Start over), how far it got and when it was finished. Needs `workspace.update`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `onboarding_setup.save`   | Keeps the answers and the furthest screen, and saves what can't wait: on the first screen the name, kind, address, time zone and website (the worker reads the site once per address); on the goal, invitations as team members and Getting started's answers; on customers, those answers and "Add them as you go"; on the booking stop, the services, your hours, the calendar (turned on) and the booking page (made and turned on); on payments, the review link. Risk 2, `workspace.update`; `onboarding_setup.started` once per run |
| `onboarding_setup.finish` | "Stay in the loop": checks every screen's answers, runs `ai_setup.finish` with the AI part's answers, then the price list, your hours and Getting started's answers. Refuses stale answers (`revision_conflict`). Risk 2, `workspace.update`; `onboarding_setup.finished`                                                                                                                                                                                                                                                                 |

Each part runs the command it already has, in the same transaction, with its own permission and events. Someone
already in the business, or already invited, is a note rather than a refusal ("sam@… is already in this business"),
and so is a calendar that can't be turned on yet. Run again with nothing changed, Save and finish change nothing.

---

## 6. How the screens behave

`onboarding-setup/flow.ts` and `answers.ts`, so the web and the phone only draw them:

- **Where they open** (`onboardingSetupFirstScreen`): the screen after the furthest one finished; a finished setup
  opens on its last screen.
- **Which screens show** (`onboardingSetupScreens`): booking only when customers book a time; qualifying questions
  and the website chat as the AI quick setup decides. Next and Back skip the rest.
- **The counter** (`onboardingSetupProgress`): "3 of 13 · About your business", by stop, with signing up counted.
- **The first screen** (`onboardingSetupBusinessDraftOf`, `withBusinessAddress`, `onboardingSetupBusinessOf`): the
  business as it is, the time zone following the address unless someone picked their own, and the website left out
  when there's none.
- **Before Next** (`onboardingSetupScreenProblemsOf`): each problem at the answer it's about, by path
  ("business.address.postalCode", "ai.services"), the same paths the API's refusals use.
- **Kept answers** (`cleanOnboardingSetupAnswers`): checked, and on "What Ava learned", what's ticked kept and the
  rest turned down.

---

## 7. Web

Step 6 of §11. The screens replace Create business, the quick questions and the setup steps: a new owner lands on
them after signing up, and Getting started's Home card points at them until they're finished. Each stop uses the
screen that already does the job where there is one (the number search and registration, the GoHighLevel move, the
spreadsheet import, payments sign-in), opened in place and coming straight back. Settings → Payments shows the
setup's address when no other is typed there, and stops warning that documents go out without one.

---

## 8. Phone

Step 7 of §11. Every stop works in the phone app too, signing up and creating the business included (45B), with the
same answers kept, so someone can start on one and finish on the other. On the phone: contacts picked one by one,
notifications turned on right there, and the summary as a "See the summary" sheet.

---

## 9. Agencies

Step 11 of §11. An agency can set up a client's business and invite the owner by email to check it and finish. It
can save its answers as a starting point for clients: the goal, hours and payment choice, plus the AI quick setup's
saved answers. Never a client's name, address, services, number or customers.

---

## 10. Not asked, kept as today

Pipeline stages and automations; texting quiet hours (8 pm to 8 am); sales tax, payment terms, reminders and
deposits; email from the HandsFreeOS address (Gmail, Outlook or their own domain later); the thank-you text after a
job, on; and everything the AI quick setup keeps as today.

---

## 11. Build order

Each step is its own draft pull request, merged in order.

1. **Fixes** (built, #189): the booking page that could start off, the texting fee checkout that landed in Settings,
   the website not filled in for texting and chat, and the dead Terms and Privacy links on sign-up.
2. **GoHighLevel by token only** (built, #196), in Settings → Migrations and the agency area too.
3. **Many business types** (built, with the AI quick setup): nineteen kinds for all 116 industries.
4. **The shared part** (built): the stops, the answers and what each one sets, kept across devices, the summary,
   the words, and `onboarding_setup.get`, `.save` and `.finish`.
5. **Signing up** (built): Google, Apple on iPhones and the 6-digit code, on the web and the phone. Each button shows
   once its provider is on in Supabase (`signInProviders`, from Supabase's own settings), so nothing waits on a
   deploy. The sign-up email carries the code instead of a link, and an unconfirmed account that signs in with its
   password confirms with a code right there. Someone invited signs up and comes straight back to the invitation. The
   phone's Google sign-in returns to `handsfreeos://auth/callback`; Apple's name, shared only the first time, is kept
   on the profile. The steps in Supabase, Google and Apple are in `docs/operations.md` ("Check the Auth settings",
   "Sign in with Google", "Sign in with Apple").
6. **The web screens** (§7).
7. **The phone screens** (§8), creating the business included.
8. **Logo and colour,** on the booking page, chat, invoices and emails: a new stop after the hours. Needs a database
   change.
9. **The simple page,** for a business with no website: a new stop after the logo. Needs a database change.
10. **Phone contacts** in the phone app.
11. **Agencies** (§9). Needs a database change.

---

## 12. Tests

- `packages/core/test/onboarding-setup.test.ts`: the address and time zones, the kinds and the 8 buttons, the
  stops, screens and counter, the record read forgivingly, the picks and carrying on (a changed kind picks again),
  the booking page and price list plans, services with a price and a length in the AI quick setup's plan, the
  summary, and the screens' behaviour.
- `packages/core/test/onboarding-setup-commands.test.ts` (local database): the look-up and who may use it; the first
  screen saving the business and reading the website once; picks after the kind changed; invitations and Getting
  started's answers; "Add them as you go"; the booking page made, turned on, and not made twice; the review link;
  "Stay in the loop" setting up the teammate, the price list and its new prices; running it again changing nothing;
  and stale answers refused.
