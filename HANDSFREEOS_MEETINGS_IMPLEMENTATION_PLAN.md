# Video meetings: Zoom and Google Meet — Implementation Plan

A business can pick Zoom or Google Meet for a calendar or a service. When an appointment is booked there,
HandsFreeOS makes the meeting link by itself and puts it everywhere the appointment shows: the confirmation, the
reminders, the customer's portal and the staff member's own calendar. When a Zoom call ends, HandsFreeOS fetches
the transcript, writes a summary note on the customer's timeline, and suggests tasks and next steps. The small ones
happen on their own; the rest wait for a person's OK. If the person's Zoom or Google settings mean no transcript
will come, HandsFreeOS tells them, with the steps to fix it.

> **Status: steps 1 to 6 of §12 are built.** The owner took every pick in §1 (2026-10-13).
>
> - **Step 1, Google Meet links.** Smaller than §3 and §6: the choice lives on the calendar's **Online** place
>   (Settings → Calendars → Locations, "Make a Google Meet link"), not yet per service; the link goes in the
>   appointment's `location.meetingUrl` (with `location.video = 'google_meet'`), so no new columns, no migration
>   and no sync change; it's made when the host's Google Calendar event is written, so it needs the host's Google
>   Calendar connected and the calendar's "Add to people's calendars" on. Reminders and the portal carry it; a
>   confirmation sent before the link exists says "Online".
> - **Step 2, the Zoom connection.** `app.meeting_connections` (20261027003200), `meeting_connection.connect`,
>   `.disconnect`, `.activate`, `.fail` and `meeting_connection.list`, Zoom's sign-in on the shared
>   `/oauth/:provider/start` and `/callback` (with a stand-in locally), and a Video meetings card on
>   Settings → My calendar. `.check_settings` and the settings columns come with step 4. Setup is "Zoom" in
>   `docs/calendar-setup.md`.
> - **Step 3, Zoom meetings.** Smaller than §5 and §6: the choice is "Make a Zoom link" on the calendar's Online
>   place; the meeting's link, id, times and any "why there's no link" live in the appointment's `location`
>   (no new columns); `appointment.meeting_sync` makes, moves, remakes and deletes it, and `appointment.make_meeting_link`
>   (the appointment's **Make link** button) tries again. Recording (`auto_recording`) waits for step 5. A reassigned
>   appointment gets a new meeting in the new host's Zoom; the old host's stays in their account.
> - **Step 4, the Zoom settings check.** `settings_checked_at` and `settings_problems` on
>   `app.meeting_connections` (20261027003300), `meeting_connection.check_settings` (Check again) and
>   `.record_settings`, the job `meeting_connection.settings_check` (after connecting, on Check again, daily), and the
>   problems with their fixes on the Zoom card. Smaller than §7: Zoom's lock settings need an admin's account, so a
>   locked switch isn't told apart (each fix says to ask the Zoom admin); the push and notification wait for step 5,
>   when "Record and transcribe" decides who needs them; the Google Meet half waits for step 7.
> - **Step 5, Zoom transcripts.** "Record and transcribe" on the Zoom place (`record`), the notice on the booking
>   page and in the confirmation, `auto_recording: cloud`, `POST /webhooks/zoom`, `app.appointment_transcripts`
>   (20261027003400), `appointment.attach_transcript` (emits `appointment.transcript_ready` for step 6),
>   `appointment.transcripts`, and the two-hour missing-transcript email. Transcripts are kept as text in their
>   own table rather than as files.
> - **Step 6, the AI pass.** `appointment.call_review` asks the AI (`packages/core/src/meetings/review.ts`) and
>   `call_suggestion.record` keeps the answer: the summary on the transcript and, as a note, on the customer's
>   timeline; tasks and a follow-up email in `app.call_suggestions` (20261027003500), decided with
>   `call_suggestion.decide` (approve, edited or not, runs `task.create` or `message.send` as that person; or
>   dismiss) and listed by `call_suggestion.list`. Smaller than §9: no record changes (a deal's stage, a next
>   appointment) are suggested yet, and suggestions use their own approve buttons on the appointment rather than
>   the AI teammate's approvals inbox. `activity.log` now also takes the system actor, for the summary note.

---

## 1. Decisions to make (Go Biz Help)

Each has a pick. Open until the owner confirms.

| Question                             | Pick                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Core or add-on                       | **Core.** An add-on can't hold its own credentials or webhook routes yet ("Not yet" in the add-on guide)   |
| Whose Zoom account makes the meeting | The staff member the appointment is with; if they haven't connected Zoom, the calendar's default host      |
| Where the choice lives               | On the calendar (default) and on each service (override): "No video", "Zoom", "Google Meet"                |
| In-person and video both offered     | A service can be "Video", "In person" or "Customer picks" at booking                                       |
| Meeting made when                    | When the appointment is confirmed; moved when it's moved; deleted when it's cancelled                      |
| No connection at booking time        | The appointment is still booked; the staff member and owners are told to connect, with a "Make link" retry |
| Record and transcribe                | Asked per calendar, off by default; the confirmation tells the customer the call is recorded               |
| Consent                              | The booking page shows "This call is recorded and transcribed" when it's on; no recording without it       |
| What the AI may do after a call      | Note and summary on their own (risk 0–1); tasks, follow-up messages and record changes ask first (2–3)     |
| Keep the transcript                  | Yes, as a file on the appointment, deleted with it (see `docs/deleting.md`); the raw recording is not kept |
| Google Meet transcripts              | Phase 2, after Zoom; Workspace plans only                                                                  |
| Settings check                       | After connecting, daily, and after any call whose transcript didn't arrive                                 |
| Plans                                | Every plan; the AI follow-ups count toward AI usage like other teammate actions                            |

---

## 2. What the repo has, and what it's missing

- **Calendar connections** (`commands/calendar-connection.ts`, `apps/worker/src/calendar/`,
  `app.calendar_connections`): one Google or Outlook connection per person. Reads busy times and writes
  appointments into their calendar, **with no guests**, so the calendar never emails the customer. Google asks for
  `calendar.freebusy` and `calendar.events.owned`.
- **Appointments** (`commands/appointment.ts`, `appointment-online.ts`, `appointment-ai.ts`) and their
  confirmations and reminders.
- **Tasks** (`commands/task.ts`), notes and the timeline, files, and the AI teammate's approvals
  (`docs/addon-architecture.md`, "The AI sees an operation only when it declares `ai`").
- **Missing:** a Zoom connection, a meeting link on an appointment, a per-calendar/service video choice, a webhook
  route for Zoom, transcript fetching, the "after the call" AI pass, and the settings check.

---

## 3. Google Meet links (smallest piece)

- When the worker writes an appointment into the staff member's Google Calendar, it adds
  `conferenceData.createRequest` (type `hangoutsMeet`) and passes `conferenceDataVersion=1`. Google returns the
  Meet link; the worker saves it on the appointment through `appointment.set_meeting` (§6).
- The current `calendar.events.owned` scope should be enough to make a Meet link on an event the person owns.
  **Check this first** against Google's docs and the fake; if it isn't, adding a scope means Google's review again
  (see "The calendar" in `docs/operations.md`).
- Outlook users who pick Google Meet: not offered. The service settings only show Meet when the staff member has a
  Google connection; otherwise they see "Connect Google Calendar to use Google Meet".
- The event still has no guests. The customer gets the link from HandsFreeOS's own confirmation and reminders.

## 4. Zoom connection

- A new provider beside Google and Outlook: **Settings → My calendar → Video meetings → Connect Zoom**, the same
  OAuth dance (PKCE, sealed `TokenSet`, `reauth_required` on a bad token) as `apps/worker/src/calendar/`.
- Table `app.meeting_connections` (one live per person per workspace), mirroring `calendar_connections`:
  provider (`zoom`, later `google_meet` for transcript access), status, account email, scopes, sealed tokens,
  `zoom_user_id`, `zoom_account_id`, `settings_checked_at`, `settings_problems jsonb`.
- Commands: `meeting_connection.connect`, `.activate`, `.disconnect`, `.fail`, `.check_settings`.
- Keys live on the worker only: `ZOOM_OAUTH_CLIENT_ID`, `ZOOM_OAUTH_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET`. The API
  already refuses anything with `_OAUTH_` in its name.
- Zoom scopes (granular): `meeting:write:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`,
  `user:read:user`, `user:read:settings`, `cloud_recording:read:list_recording_files`.
- Zoom's Marketplace review is needed before other businesses can connect. Write it up as "Video meetings: Zoom"
  in `docs/operations.md`, with the same "on your laptop there's nothing to set up" fake as the calendars.
- Disconnecting Zoom (or Zoom's "app uninstalled" webhook) marks the connection gone and tells the person.

## 5. Making the Zoom meeting

- On `appointment.confirmed`, `.rescheduled` and `.cancelled` events, the worker creates, moves or deletes the Zoom
  meeting for the host (`POST /users/me/meetings`), then saves the link with `appointment.set_meeting`.
- When the calendar has "Record and transcribe" on, the meeting is made with `settings.auto_recording = "cloud"`,
  so the host never has to press Record.
- Waiting room on, passcode on; join link includes the passcode.
- Retries like other provider work. After the last failure, the appointment shows "No meeting link yet — Make link"
  and the staff member hears why (for example "Your Zoom connection needs signing in again. Reconnect in
  Settings → My calendar.").

## 6. The appointment's meeting

- New columns on `app.appointments`: `meeting_provider`, `meeting_url`, `meeting_external_id`,
  `meeting_passcode_enc`, `meeting_status` (`none`, `pending`, `ready`, `failed`). Mirror in Drizzle.
- `appointment.set_meeting` (system only) and `appointment.make_meeting_link` (people, retry).
- Calendars and services get `video_provider` (`none`, `zoom`, `google_meet`) and `record_calls boolean`;
  services can leave it to the calendar.
- The link shows in: the appointment screen (web and phone, with a "Join" button), the confirmation and reminder
  emails and texts, the customer's portal, the event in the staff member's own calendar (as its location), and what
  the AI teammate tells a customer who asks.
- Sync: the meeting columns go to the phone. That is a change to `apps/sync/sync-config.yaml`; batch it with
  anything else waiting (see "Sync" in `CLAUDE.md`).

## 7. Checking the settings that transcripts need

### Zoom (we can read these)

After connecting, once a day, and when an expected transcript doesn't arrive, `meeting_connection.check_settings`
reads `GET /users/me` and `GET /users/me/settings`, and records each problem:

| Problem             | How we tell                                          | What the person sees                                                                                                                    |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Free Zoom plan      | `type` is Basic                                      | "Zoom only saves recordings and transcripts on paid plans. Upgrade in Zoom, or turn off Record and transcribe in Settings → Calendars." |
| Cloud recording off | `recording.cloud_recording` is false                 | "Turn on Cloud recording in Zoom: Settings → Recording → Cloud recording."                                                              |
| Transcript off      | `recording.recording_audio_transcript` is false      | "Turn on Create audio transcript in Zoom: Settings → Recording → Cloud recording → Advanced cloud recording settings."                  |
| Locked by an admin  | the account's lock settings say these are locked off | "Your Zoom admin has turned this off for everyone. Ask them to turn on Cloud recording and Audio transcript."                           |

- Problems only matter on calendars with "Record and transcribe" on, and only for people who host there.
- They show as a banner on **Settings → My calendar**, a line on the calendar's settings, and one push and
  notification when a problem first appears (not every day). Each has a "Check again" button.
- Exact Zoom field names get confirmed against Zoom's API docs while building; the fake mirrors them.

### Google Meet (we mostly can't read these)

- Google has no simple API to read a person's transcript setting. Two layers:
  1. When we make the event, ask Google's Meet API to turn on automatic transcripts for that meeting (its
     artifact settings for a meeting space). Workspace plans only; **check it works** with our scopes before
     relying on it.
  2. Fallback: if a Meet call ended and no transcript came within 2 hours, tell the host, with steps:
     "Turn on transcripts in Meet: during the call, Activities → Transcripts. Your Google Workspace admin may need
     to allow it." Personal Gmail accounts are told transcripts need Google Workspace.

## 8. Fetching the transcript

- **Zoom:** a webhook route on the worker, `POST /webhooks/zoom`, checks Zoom's signature and answers Zoom's URL
  check. On `recording.transcript_completed` it finds the appointment by `meeting_external_id`, downloads the
  `.vtt` transcript, and saves it with `appointment.attach_transcript`, which stores it as a file on the
  appointment and emits `appointment.transcript_ready`. Recording files are not downloaded.
- If no transcript comes within 2 hours of the meeting's end, the worker checks the settings again (§7) and tells
  the host what's off.
- **Google Meet (phase 2):** after the event ends, the worker looks up the conference record and its transcript
  through the Meet API. That needs a Meet scope on a separate Google connection, so it is its own Google review.

## 9. After the call: the AI pass

On `appointment.transcript_ready`, a worker job reads the transcript with the appointment, the customer and the
business's knowledge, and produces:

- **A summary note** on the customer's timeline (who, what was discussed, what was agreed). Runs on its own.
- **Suggested tasks** ("Send quote for the duct cleaning by Friday", assigned and dated). Wait for an OK.
- **Suggested follow-up message** to the customer, drafted in the business's tone. Waits for an OK.
- **Suggested record changes** (a deal's stage, a field on the customer, a next appointment). Wait for an OK.

Each suggestion goes through existing commands with `ai` declared (`task.create`, the message send, record
updates), so the approvals inbox, risk levels and the activity log work unchanged. A person can tick all, edit,
or dismiss. Nothing risk 4 is offered. The note links back to the transcript.

## 10. Web and phone

- **Settings → My calendar → Video meetings:** Connect Zoom, connection state, settings problems, Check again.
- **Settings → Calendars → (calendar) and → Services:** video choice and Record and transcribe, with the consent
  wording shown.
- **Appointment screen:** link, Join, Copy, Make link (on failure), and after the call: transcript, summary and
  the suggestions waiting.
- **Booking page:** "Video call (Zoom)" and the recording notice when on.
- Phone: the same, with Join opening the Zoom or Meet app.
- All words for these live once in `@hfos/core`; refusals follow "Error messages" in `CLAUDE.md`.

## 11. Privacy and safety

- Recording is off unless the business turns it on, and the customer is told before booking.
- Transcripts are files under the business's row-level security; deleting the appointment or customer deletes them.
- Zoom's webhook is checked by signature; unmatched meetings are ignored.
- Update `/privacy` on the site, and the Zoom and Google review write-ups.

## 12. Build order

1. **Google Meet links** (§3, §6): columns, `appointment.set_meeting`, the calendar/service choice, the link in
   confirmations and screens. Uses the Google connection that exists.
2. **Zoom connection** (§4) with the fake; Settings screen.
3. **Zoom meetings** (§5): make, move, delete; Make link retry.
4. **Settings check** (§7, Zoom) and its alerts.
5. **Zoom transcripts** (§8) and the webhook; Zoom Marketplace review starts here.
6. **The AI pass** (§9) and its approvals.
7. **Google Meet transcripts** (§7 and §8, Meet), after its own Google review.

Each step ships on its own. Steps 1 and 2 can run side by side.

## 13. Tests

- Core: the new commands' permissions and validation; a meeting is made, moved and deleted with the appointment;
  `record_calls` needs the consent wording; suggestions go through approvals at the right risk.
- Worker: the Zoom fake (OAuth, meetings, settings, webhooks with good and bad signatures); each settings problem
  makes the right message; a missing transcript triggers a check; Meet `conferenceData` on the Google fake.
- DB: row-level security on `meeting_connections` and transcript files; Drizzle parity.
- Web e2e: connect Zoom (fake), pick Zoom for a service, book, see the link, receive a fake transcript, approve a
  suggested task.
