# Funnels — video, a step-by-step link, booking inside it, and live check-ins

A business sends one link and HandsFreeOS walks the person through it. They give their name, watch a short video,
leave their details, watch a longer one, answer a few questions, and book a live session, all on one page that moves
forward. Around it, the business's workflows text them before, during and after the session, and the system knows
who actually joined. Leads arrive on their own from Facebook lead ads and from Indeed's applicant emails.

It started with Christina Robbins's network-marketing recruiting funnel (built in GoHighLevel), but nothing here is
about recruiting. A contractor's "watch this, then book an estimate" page or a coach's webinar sign-up uses the same
pieces.

> **Status: stage 1 is built** (the video question and one page at a time); stages 2 to 6 are next. Decisions
> below are the owner's (2026-10-23). "Picks to confirm" are mine and stay open until the owner says yes.
>
> - **Stage 1, as built.** Smaller and safer than §1 in two ways. The page talks to the player's frame by message
>   and loads no YouTube or Vimeo script, so nothing of theirs runs on the business's page; and the public page
>   has no frame rule of its own to change (its only rule is who may frame _us_). It also needed something §1
>   assumed: the public page showed every page down one screen, so `settings.onePageAtATime` (Back, Next, "Step 2
>   of 3", picking up where they left off) and the editor's page breaks came with it. The gate is checked at
>   submit, where the server re-checks every answer; there is no server step between pages yet. Details are in
>   "Videos and steps" in `docs/forms.md`.

## Decisions (Chris, 2026-10-23)

| Question                               | Answer                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Who it's for                           | **Every business.** General pieces in core, not a recruiting add-on                                                |
| Where videos live                      | **A pasted link** (YouTube, Vimeo). They host and stream it; we play it on the page and track how much was watched |
| Skipping ahead                         | **The business picks per video**: "Next shows after X% watched", or free to move on                                |
| The flow                               | **One link, step by step.** One form with pages, not separate pages joined by texts                                |
| Booking the live session               | **Inside the funnel.** The last step shows the next sessions; one tap books, and the Zoom details go out           |
| Text consent for Facebook leads        | **Both places.** The Facebook form's consent box counts, and the funnel asks again for anyone who didn't tick it   |
| A link that already knows who they are | **Skip the name step.** Greet them by name and go straight on                                                      |
| In the first version                   | **Stopped-partway follow-up, Zoom attendance, Indeed by email**                                                    |
| Not in the first version               | A ready-made recruiting template. Christina's funnel is set up by hand as the first real test                      |

## Picks to confirm

| Question                             | Pick                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a personal link shows           | Only the first name, for the greeting. The link itself is a random key with nothing personal in it, and the page never shows the email or phone on file                     |
| How long a personal link works       | 30 days, then it opens as the plain link (they type their details again)                                                                                                    |
| Loom and other players               | YouTube and Vimeo first: both report how far somebody got. Loom plays but can't gate or track, so the editor says so                                                        |
| How strict the video gate is         | A nudge, not proof: the viewer's browser reports progress, so a determined person can fake it. Good enough for "please watch first"                                         |
| When "stopped partway" fires         | 30 minutes with no activity on a started sheet whose person we know. Once per page reached, so coming back and stopping later fires again                                   |
| Missed Facebook leads                | Webhooks first, plus an hourly catch-up that asks Meta for each connected form's newest leads, since Meta can drop a webhook                                                |
| How the AI reads Indeed's emails     | The AI pulls out the details, not fixed patterns, so a change to Indeed's layout doesn't break it                                                                           |
| How we know who joined the Zoom call | Each attendee gets their own Join link on the business's domain (or ours), which records the click and sends them on to Zoom. Zoom's own join events come later, as a check |
| What a click counts as               | "Clicked Join", not "in the call". Link previews and email scanners open links too, so only a real browser in the session's window counts                                   |
| When an attendee counts as a no-show | They never clicked Join by the session's end. A click is marked as it happens, so a workflow can text only the people who haven't clicked 5 minutes in                      |
| The phone app                        | A form with a video or a booking step shows "open this one on the web", like a file or a payment does today. Staff don't fill funnels in on the phone                       |

## What's already there

Most of the flow needs no building. Her nine steps, against what exists:

| Her step                        | Today                                                                                                                            | Missing                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1. Leads in, contact made, link | Lead intake (`crm/intake.ts`), the intake API key, a workflow on `lead.created` with `send_form`                                 | Facebook lead ads, Indeed, a personal link          |
| 2. Teaser video                 | Form pages (`forms/definition.ts`)                                                                                               | A video question                                    |
| 3. Details, name carried over   | Pages, answer targets (`person.email`, `person.phone`), the SMS consent box                                                      | Saving the contact mid-form, skipping known answers |
| 4. 15-minute overview           | —                                                                                                                                | The video question again, with its gate             |
| 5. Questionnaire                | Choices, scoring, show-if, results with `redirectUrl`                                                                            | —                                                   |
| 6. Book Tuesday or Thursday     | Calendars in `sessions` mode with seats (`calendar/config.ts`), `appointment.book_online`, Zoom links (`HANDSFREEOS_MEETINGS_…`) | A booking question inside the form                  |
| 7. Before, during, after texts  | Workflows: `appointment.booked`, waits on `appointment.starts_at` in minutes, wait for `message.received`, AI classify branches  | Per-attendee joined / attended / no-show events     |
| 8. Routing                      | Branches, tags, `move_lead_stage`, `enrol_workflow`, `end`                                                                       | —                                                   |
| 9. Three-way call               | A second calendar for the Business Expansion Leader; a text with its booking link                                                | —                                                   |

## Shape

### 1. The video question (`forms/questions.ts`)

A new question type, `video`, whose answer is **how much they watched, 0 to 100**. Making it an answer rather
than a side table means everything forms already do works on it unchanged: show-if ("watched 80% or more"), results,
the response's timeline entry, CSV export, and workflow conditions on the response.

- **Config:** `url` (YouTube or Vimeo, checked and turned into the player's embed address in core so the editor,
  the page and the server agree), `minPercent` (null is free to skip; 1–100 holds the page's Next button until
  then), and `caption`.
- **On the page:** the player's own API (YouTube's IFrame API, Vimeo's Player) reports progress. The page keeps the
  furthest point reached and saves it with the page's other answers through the existing save path. Seeking ahead
  doesn't count as watched.
- **Checked again on arrival:** the server refuses Next past a gated video whose saved percent is under the bar,
  the same way it re-prunes hidden answers today.
- **The frame rule:** the public form page allows frames from `www.youtube-nocookie.com` and `player.vimeo.com`
  only. Nothing else changes in `lib/forms/frame.ts`, which governs who may frame _us_.
- **The editor:** paste a link, see the video, pick "Anyone can move on" or "Next shows after \_\_% watched". A link
  we can't play says so ("That’s a Loom link. It plays, but we can’t tell how much was watched, so it can’t hold
  the Next button.").

### 2. Saving the contact mid-form (`forms/definition.ts`, `commands/form-response.ts`)

Today a sheet from a link has nobody on it until the final submit. A funnel needs the contact made at step 3, both so
her CRM updates then and so "stopped partway" has somebody to text.

- **A page setting, "Save their details here."** When the person leaves that page, the sheet runs the form's
  `onSubmit.person` rules early: match or create the customer, write the mapped answers, add the tags, record the
  SMS consent box if it's on that page, and open the lead if the form opens one. It's the same code submit runs,
  moved behind one function, so there is one set of rules.
- **Final submit still runs everything,** and finding the person already on the sheet just fills what's still blank
  ("a form never rubs anything out").
- **One page per form** may carry it, and only a page whose questions include a phone or an email.

### 3. Personal links (`forms/links.ts`, the worker's `send_form`)

- **`send_form` makes a personal link:** a sheet started for that customer, with a random key in the link
  (`/f/<site>/<form>?k=<key>`). The key is the only thing that ties the link to the contact: no name, email, phone or
  id is ever in the address. Only a hash of the key is kept, as with resume keys today. It works for 30 days.
- **Opening it** picks up that sheet, so the contact is known from the first page and "stopped partway" works even
  before step 3.
- **"Skip when we know it"** on a question mapped to a customer field: hidden when the customer already has that
  field. That's how the name step disappears for a known person.
- **Their name in the words:** `{{person.first_name}}` works in page titles, a text block and a video's caption
  ("Glad you’re here, Dana"), with a fallback for when we don't know it. Rendered in core's `render.ts`.
- **Email and phone are never shown** on a personal link, not even partly hidden, since a forwarded link would show
  them to whoever opens it. Known ones are skipped. An "Update my details" link asks for them fresh, without showing
  what's on file, and the new answers fill in as a form's answers always do.
- The plain link keeps working for anyone, as today.

### 4. The booking question (`forms/questions.ts`, `calendar/booking.ts`)

A new question type, `booking`. Its answer is the session they picked.

- **Config:** a calendar, optionally a service, and how far ahead to show (default 2 weeks).
- **On the page:** the open times from the same engine the booking page uses, as buttons ("Tue, Oct 28 · 7:00 pm ·
  12 seats left"). Full sessions don't show.
- **On submit:** the worker runs `appointment.book_online` for the customer on the sheet, inside the submit, with
  the sheet's id as the booking's `clientId` so a retried submit can't book twice. The confirmation, the Zoom link
  and the reminders are the calendar's own.
- **A session filling up between showing it and submitting** refuses with the rule and says what to do: "The
  Thursday 7:00 pm session just filled up. Pick another time." The page shows the times again with their answers
  kept.
- **Checks:** a group session must enroll only the new person in `appointment.booked` workflows (the payload's
  `personIds`); add a test that proves it.

### 5. Stopped partway (`workflows/definition.ts`, a worker job)

- **A new workflow trigger, `form.stopped`:** "Somebody stops partway through a form", with filters on the form and
  the furthest page reached. Its payload carries the person, the form, the page and each video's watched percent, so
  a text can say "you were halfway through the overview".
- **The job** (`forms.stopped`, every 5 minutes) finds started sheets with a person, no activity for 30 minutes, and
  a page reached that hasn't fired yet. A submit afterwards ends any run waiting on it through the existing
  `wait` → `form.submitted` event.

### 6. Facebook lead ads (`apps/worker/src/social/`)

Built on the Facebook connection we already have, not a new one.

- **Ask Meta for more:** `leadgen` added to the Page's webhook fields (`APP_FIELDS` in `graph.ts`, and
  `subscribed_apps`), and the lead permissions added to the sign-in. Expect `leads_retrieval` and
  `pages_manage_ads`; check Meta's current docs when building, as `docs/meta-messaging.md` says for conversions.
- **When a lead arrives,** Meta sends only its id. The worker fetches the lead (`GET /{leadgen_id}`) with the Page's
  token, then runs intake with a new kind, `facebook_lead_ad` ("Facebook lead ad"), so the daily cap, the pipeline
  and the dedupe are intake's own. The lead's id is the dedupe key.
- **What's kept:** name, email and phone on the customer; every other answer on the lead and the timeline, as the
  intake API does; an `attribution_touches` row with the ad and the form, so "Where they came from" shows the ad.
- **Consent:** a ticked consent box on the lead form records SMS consent with the source "Facebook lead form: <form
  name>". Unticked leaves it unknown, and the funnel asks (decision above).
- **The hourly catch-up** reads each connected form's leads since the last one seen (pick above).
- **Settings → Facebook & Instagram** gets a "Lead ads" section: which Pages send leads, the last one received, and
  the Leads Access step when Meta blocks us ("Facebook is keeping this Page’s leads from HandsFreeOS. In Meta
  Business Suite, open Settings → Leads Access and add HandsFreeOS.").

### 7. Indeed by email (`commands/email-inbound.ts`, `crm/intake.ts`)

Indeed has no general way to send applicants to another app, but it emails the employer for each one.

- **Where the email comes from:** any inbox HandsFreeOS already reads (a connected Gmail or Outlook, or a hosted
  mailbox) or one forwarded to it. Nothing new to connect if their inbox is connected.
- **Spotting it:** from an Indeed address with an applicant subject. Today `looksAutomatedEmail` drops these as
  automated, so the Indeed check runs first.
- **Reading it:** the AI pulls the name, the job, the email (often Indeed's relay address, which still reaches the
  applicant) and a phone if one is given. Then intake with a new kind, `indeed` ("Indeed"). The email's
  `Message-ID` is the dedupe key.
- **No text consent** comes from Indeed, so the first touch is an email with the funnel link, and the funnel's
  contact step asks for texts.
- **Settings → Lead intake** gets an "Indeed" row: on or off, the pipeline, and how to forward if their inbox isn't
  connected.

### 8. Who joined the live session (`commands/appointment.ts`, `apps/worker/src/meetings/`)

Today attendance is all-or-nothing: marking an appointment completed marks every attendee attended. A group session
needs it per person.

- **`attendee.set_attendance`** (staff and system): `joined`, `attended` or `no_show` for one attendee. Staff can
  tick it on the session's attendee list on the web and the phone.
- **New workflow triggers,** each for that one person: `attendee.joined` ("Somebody joins a session"),
  `attendee.attended` and `attendee.no_show`. With a wait on `attendee.joined` and a 5-minute timeout, "Were you able
  to log on?" goes only to the people who haven't.
- **How we know they joined: their own Join link.** Each attendee's confirmation, reminders and the workflow's
  texts carry `/j/<key>` instead of the Zoom address. It's on the business's own domain when one is serving
  (`publicOrigin`, as form links are), so it reads as theirs ("book.yourbusiness.com/j/…", the same address their forms use), and on ours otherwise.
  Opening it records who and when, then sends them on to the meeting. It needs no paid Zoom plan and no Zoom review,
  works the same for Google Meet, and keeps the meeting's real address out of texts.
  - **One key per attendee,** kept only as a hash, as with every other link. It works from an hour before the session
    to its end; outside that it shows the session's time instead of sending them on.
  - **Only a person counts.** Text apps and email scanners open links to make previews, which would mark everyone as
    joined. So the link answers with a small "Joining your session…" page that sends the browser on with a script:
    previews don't run it, and known preview and scanner visitors are left out too.
  - **A forwarded link** still records against the attendee it was made for. That's rare and harmless here.
  - **A click isn't "in the call".** Somebody can click and get stuck, which is exactly when "Were you able to log
    on?" helps. Staff can still tick attendance by hand.
- **At the session's end** everyone booked who never clicked becomes `no_show`, and everyone who did `attended`.
- **Later, as a check: Zoom's own events.** The link-making Zoom app can subscribe to `meeting.participant_joined`
  and `meeting.participant_left` on the existing `/webhooks/zoom`, matched to attendees by registrant (where the
  host's plan allows registration) or name. That turns "clicked" into "was in the call for 40 minutes". It needs a
  Zoom app change and maybe another Zoom review, so it's the last stage, not a blocker.

## The database

New files in `supabase/migrations`, numbered above the newest at build time, each mirrored in Drizzle:

- **Forms:** `form_responses.last_active_at`, `furthest_page_id` and `stopped_pages` (for the stopped job), and
  `personal_key_hash` with `personal_expires_at`. Video and booking live in the definition's JSON: no column.
- **Intake:** `facebook_lead_ad` and `indeed` on the intake kind enum.
- **Social:** `meta_lead_forms` (the Page, the form, the last lead seen) for the catch-up.
- **Attendance:** `joined` on `attendee_status`, `joined_at` and `join_key_hash` on `appointment_attendees`, and the
  Zoom registrant id.
- **Events:** the new workflow trigger events wherever the event list is checked.

The hosted database gets each migration before `main` does ("Apply new migrations" in `docs/operations.md`).

## Outside setup

- **Meta:** App Review for the lead permissions, with a screencast of a test lead arriving. This can take days or
  weeks, so submit as soon as stage 4 works on the stand-in. Add a "Lead ads" part to "Facebook and Instagram
  messages: Meta" in `docs/operations.md`, and a line to the privacy page's `#meta` section.
- **Zoom (last stage only):** the participant events and any new scope on the link-making app, and its review.
- **Nothing for Indeed** beyond a forwarding rule in the business's own inbox when it isn't connected.

## Build order

Staged PRs, each shippable:

1. **Video question.** Type, editor, player tracking, the gate, the frame rule, the phone's "open on the web".
2. **The funnel's middle.** Saving the contact mid-form, personal links, "skip when we know it", names in the words.
3. **Booking inside the form,** then **stopped partway.** Christina's funnel can go live here, with Zapier in front
   for leads.
4. **Facebook lead ads** on the stand-in, then App Review. Zapier drops off once approved.
5. **Indeed by email.**
6. **Attendance:** per-attendee marking and triggers with the tracked Join links (staff can tick too). Zoom's own
   events follow as a separate PR once Zoom approves.

Run `pnpm openapi` after each new command or query.

## Tests

- **Core:** the video URL check, the gate in `render.ts`, skip-when-known, `{{person.first_name}}` with and without a
  name, the booking question's answer check.
- **Kernel and database:** the mid-form save runs submit's person rules once; a personal key opens only its own
  sheet and nothing after it expires; the booking at submit is idempotent on a retry; joining a session enrolls only
  the new person; attendance per attendee under RLS.
- **Worker:** a Facebook lead webhook fetches, dedupes and records consent; the catch-up finds a lead the webhook
  missed; an Indeed email becomes a lead and a non-applicant Indeed email doesn't; the stopped job fires once per
  page; a Join link records the right attendee, ignores a link preview, and serves on the business's domain; Zoom
  participant events mark the right attendee.
- **Browser (`apps/web/e2e/funnel.spec.ts`):** a personal link skips the name, the video holds Next until 80% on the
  stand-in player, the contact saves at step 3, a session books inside the form, and the confirmation carries the
  Zoom link.

## Not in this plan

- A ready-made recruiting funnel and its workflows (not picked for the first version).
- Indeed's own APIs (partner-only) and other job boards.
- Uploading videos to HandsFreeOS.
- Tracking for Loom, Wistia and other players.
- Sending conversions back to Meta (`docs/meta-messaging.md`, "Not yet").
