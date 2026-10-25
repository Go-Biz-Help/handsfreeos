# Forms, surveys and quizzes (M15)

One builder. A form, a survey and a quiz are the same definition with a different `mode`, which is why a
business can turn a feedback survey into a scored quiz without rebuilding it, and why there is one editor,
one engine and one set of results screens rather than three of each.

## Where things are

| What                                | Where                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| The definition, the ops, the engine | `packages/core/src/forms/`                                                          |
| Commands                            | `packages/core/src/commands/form.ts`, `form-response.ts`                            |
| Reads                               | `packages/core/src/queries/form.ts`                                                 |
| Tables                              | migrations `0073`–`0078`, and `0085` for the phone                                  |
| The app                             | `apps/web/src/app/app/w/[workspaceId]/forms/`, `apps/web/src/components/forms/`     |
| The phone                           | `apps/mobile/src/forms/`                                                            |
| The public page                     | `apps/web/src/app/f/[site]/[slug]/`, served by `apps/worker/src/http/forms.ts`      |
| The AI builder                      | `apps/worker/src/forms/builder.ts` (tools in `packages/core/src/forms/ai-tools.ts`) |
| The Assistant's tools               | `apps/worker/src/assistant/tools-forms.ts`                                          |
| The AI teammate's tools             | `ask_form` / `answer_form` in `apps/worker/src/ai-team/tools.ts`                    |

## The shape

`forms/` mirrors `workflows/` file for file, for the reason that pattern exists: several editors have to be
several views of one thing rather than several things that drift.

- **`definition.ts`** — a versioned tree: `mode`, pages of questions with stable ids, calculations, the
  results people land on, what happens on submit, and the settings.
- **`ops.ts`** — the only way anything changes a form. A batch goes in all together or not at all, and every
  op hands back its inverse, so Undo is a list of ops rather than a saved copy.
- **`render.ts`** — which questions are showing, whether an answer will do, what the numbers come to, and
  where somebody lands. The editor's preview, the public page and the server all run this, which is what
  keeps them from disagreeing.
- **`describe.ts`** — plain English for a change ("“Your phone”: made it required") and `diffForms`.
- **`ai-tools.ts`** — the flat tools the builder calls, and the checking that turns them into ops.
- **`starters.ts`** — nine forms a business can publish as they come.

## Rules worth knowing before changing anything

**A draft is the business's own working copy.** Nobody outside it can open a draft, which is why the
Assistant may build and change forms on its own, and why publishing is a separate act with a confirmation.

**Publishing never opens a closed form.** Fixing a typo on a form you closed for the season leaves it
closed.

**An answer to a question that isn't showing is dropped, not recorded.** The engine prunes the answers to
what was visible, and it settles — taking one answer away can hide the next question. The server prunes
again on arrival, which is also what stops a crafted POST filling in a hidden question.

**A form never rubs anything out.** It fills a blank field on a customer and adds what wasn't there; a
customer leaving the email box empty this time doesn't erase the address on file.

**Answers keep the version they were given on**, and each answer carries the question's wording as it read
at the time. Rewording a question never rewrites what somebody already said.

**A response in the Deleted bin takes its answers out of sight with it** (20261027010300). A response goes
in the bin with its customer, their leads' responses included. A lead deleted on its own leaves the customer's
responses and answers where they are (docs/deleting.md, "A lead, a company or a record takes only what's about
it"). While a response is in the bin, `form_answers_follow_response` hides its answers from everyone in the
business: they're a row each with no bin mark of their own, so until then Results still counted and quoted them.
Results and anything else that reads answers by form or by business leave them out, Bring back brings them back,
and the worker reads them as it always has.

**Ids are made by us, never by a model.** The AI builder writes labels; `formToolCallsToOps` stamps the
ids and tells the model what they are.

## The public page

`/f/<site>/<form>`, served by the worker as the booking page is, and never the draft. What protects it:

- per-address rate limits and a honeypot field, which is answered with a sheet that writes nothing;
- the key handed back when a sheet is started — knowing a response's id is not enough to write to it;
- the form's own closing rules, checked again inside the transaction;
- a frame rule built from the sites the business listed, so an embedded form is framed by them and nobody
  else (`apps/web/src/lib/forms/frame.ts`).

Embedding is a plain iframe with `?embed=1`; the page drops our frame and padding.

## Videos and steps (funnels)

A form can walk somebody through a funnel: a video, their details, a longer video, a few questions
(`HANDSFREEOS_FUNNELS_IMPLEMENTATION_PLAN.md`).

- **One page at a time** (`settings.onePageAtATime`) gives each page its own screen with Back and Next. Next checks
  that page with `pageProblems`; the consent box and the send button are on the last page. A sheet picked up
  again starts where they left off (`pageToResume`). The editor's question list shows where each page starts,
  "Start a new page", and the switch once there is more than one page.
- **A video question** (`type: 'video'`, `forms/video.ts`) plays a YouTube, Vimeo or Loom link the business
  pasted. They host and stream it; we never upload it. Its answer is how much they watched, 0 to 100, so show-if
  rules, Results, the timeline ("Watched 85%") and the export work on it unchanged.
- **The gate** (`config.minPercent`) is `answerProblem`'s: Next waits, and the server refuses the sheet at submit,
  until they've watched that much. Loom can't be tracked, so `formProblems` refuses a gate on it.

**What rules here:**

- **No provider script runs on the page.** The page talks to the player's frame by message (`playerHello`,
  `readPlayerMessage`) and reads only messages from that player's own origin (`VIDEO_ORIGINS`). The public page
  is on the business's domain or ours, and YouTube's or Vimeo's script has no business there.
- **Watched means watched.** The furthest point moves on only while they play at the edge of what they've seen
  (`watchTick`), so dragging the bar ahead doesn't count, and the answer only goes up.
- **The gate is a nudge, not proof.** The browser reports the position, so a determined person can fake it.
- **The AI teammate doesn't ask a form with a video** in a conversation (`NOT_IN_CHAT_TYPES`), and the phone sends
  one to the web (`NOT_ON_THE_PHONE`).

## Details saved part way, and personal links (funnels)

- **A page that saves their details** (`page.savesContact`, one a form). Shown one page at a time, leaving it runs
  `form_response.save_contact`: the customer is matched or made, the blanks that page's answers fill are written,
  the lead opens, and the texting box (which sits on that page) is recorded. Sending at the end keeps that customer
  and that lead. Both go through `settleCustomer`, so the rules are the same ones sending always had. It takes the
  same "are you a person" check sending does, through `POST /public/form/<site>/<form>/<sheet>/contact`.
- **A personal link** (`app.form_links`, 20261027010900) is `/f/<site>/<form>?k=<key>`. A workflow's **Send a form**
  makes one for each customer (`form_link.create`). The key is random and only its hash is kept; it works 30 days.
  Opening it (`GET …/personal/<key>`) hands the page their first name, which contact details we have, and their
  unfinished sheet from a link; starting with it binds the sheet to them (`form_link_id`), and the key writes to
  that sheet as well as its own resume key does (`assertHolder`).
- **What a personal link changes** (`FillContext` in `forms/personal.ts`, passed to every `render.ts` function):
  a question filling a contact detail on file (first name, last name, email, phone) is skipped, and a page left
  empty isn't shown. `{{person.first_name}}` (with `| default:"there"`, as workflows write it) works in the title,
  intro, page headings, questions and text blocks, from what they typed or the link (`fillFormWords`).

**What rules here:**

- **Nothing on file is shown back.** Only the first name, for the greeting. The personal route even leaves their own
  earlier email and phone answers out of the sheet it returns: a forwarded link would show them to whoever opened it.
- **A form never writes over what's on file**, personal link or not. Asked again ("Details changed?"), a different
  phone joins their other numbers instead, so a forwarded link can't change somebody's details.
- **A link we texted needs no robot check**: the worker skips Turnstile when the page's key is a live personal key.
- **Filling a blank on a customer we already had emits `person.updated`**, and both commands declare it. Before
  this, a returning customer whose form filled in a missing detail was refused by the kernel.

## Booking a time, and stopped partway (funnels)

- **A "Book a time" question** (`type: 'booking'`, `forms/booking.ts`) shows a calendar's open times as buttons,
  read from `GET /public/form/<site>/<form>/times/<question>`. Its answer is the time, the session and how it
  reads. Sending the form books it inside the same transaction (`bookTheTime`), with the calendar's own
  `appointment.book_online`, so the confirmation, the video link and the reminders are the calendar's. The booking
  joins the form's lead rather than opening another (`leadId`), and a form can book a calendar whose booking page
  is off (`throughForm`): a presentation booked only through its funnel.
- **The link's `ref` goes on the booking.** A form opened with `?ref=` (a Social Outreach demo link, or a partner's)
  keeps it on the sheet when it starts (`form_responses.link_ref`, 20261027012200), so it holds when they stop
  partway and come back on another link. The time booked on it keeps it on the booking
  (`appointment_attendees.link_ref`), as a booking page does, so the demo or the partner's referral counts by itself.
  Anything that isn't a ref a booking keeps (`linkRefOf`) is left off.
- **A session that filled up meanwhile** refuses the whole send with `form_booking_taken` (the time in words, and
  the question in `details`), so nothing is half done; the page clears the pick and reads the times again.
- **Stopped partway.** Shown one page at a time, each save carries the page they're on (`at_page_id`,
  `last_active_at`, 20261027011000). Every five minutes the worker's `forms.stopped_sweep` finds sheets whose
  person we know, quiet for 30 minutes (and under a week), and `form_response.mark_stopped` marks that page once
  and emits `form.stopped`. A workflow starts on it with **Somebody stops partway through a form**, filtered by
  `trigger.form_id` and `trigger.page_title`, and its texts can say `{{trigger.page_title}}`.

**What rules here:**

- **A form never takes money**, so it can't book a calendar that takes a deposit or the full price (`formIssues`,
  and again when it's sent).
- **The time reads in the calendar's words.** The server writes the label again from the time and the calendar's
  zone, whatever the page sent.
- **A seat in a shared session isn't one customer's appointment**, so only a booking of their own takes the lead.
- **The AI teammate and the phone** don't ask a form with a booking question (`NOT_IN_CHAT_TYPES`,
  `NOT_ON_THE_PHONE`).

## Answering in a conversation

A form marked "the AI teammate may ask this" (`in_chat`) becomes two teammate tools. The teammate holds no
state: the sheet is the same row the public page writes, found by customer and form, so a conversation that
stops halfway can be finished on the link and the other way round.

## On the phone (M17)

Built, and nothing in `forms/` had to change — the engine really was ready.

- **`app.forms` and `app.form_versions` are published; `app.form_responses` is not.** Its
  `resume_token_hash` is a secret column by `packages/db/test/sync-secrets.test.ts`'s rule, and PowerSync's
  first copy of a table reads every column whatever the stream selects. A phone filling a form in needs the
  questions, not a row.
- **`form_versions.is_active`** is a stored flag meaning _a phone should hold this one_: the form's active
  version, while the form is live. A stream cannot join, which is the same reason `sync_window` is stored.
- **`form_response.record`** makes the answer sheet and sends it in one go, with an id from the phone, then
  hands over to `form_response.submit` so every consequence — the customer, the lead, the workflows — is the
  form's own behaviour and not a second set of rules.
- **It runs as the teammate, so 0109 lets a teammate write that sheet.** With `records.write`, a person may
  start a sheet from the app (`source = 'app'`, no key, nobody on it yet), send it while it is open, and
  write its answers and the form's count for the day. A sheet from the link, the embed, a QR code or a
  conversation is still the worker's alone, a sent sheet is never edited, and the key's and the visitor's
  hashes stay unreadable, so a sheet is read through `READABLE_SHEET`. A teammate's send doesn't count
  against Lead intake's day, which measures what arrives on its own. Until 0109 every one was refused, and
  nothing had run the command against a database.
- **`apps/mobile/src/forms/`** and `app/.../forms/[formId].tsx` render it with core's `formState` and
  `answerProblem`, so what the phone accepts is what the server accepts.
- **A file, a signature or a card payment stops the whole form** with "open this one on the web", rather
  than rendering the other questions and quietly dropping that one.

## What is not built yet

**Agency templates for forms.** M6's template mechanism pushes workflows to client businesses; forms would
use the same one, and `diffForms` already describes what an update would do.
