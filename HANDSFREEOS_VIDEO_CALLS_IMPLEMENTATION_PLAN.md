# Video calls of our own: LiveKit — Implementation Plan

A business can pick **HandsFreeOS video** for a calendar or a service, beside Zoom and Google Meet. When an
appointment is booked there, nobody has to connect anything: the customer gets a link in their confirmation and
reminders, opens it in the browser at the time of the call, and is in. No app, no account, no download. The team joins
from the appointment, on the web or the phone. The call looks like the business, with its name and colors. When
"Record and transcribe" is on, the transcript goes through the same summary, tasks and follow-up steps as a Zoom
call's. Later, AI Sales Coach can listen in, with no Zoom app in between.

The calls run on LiveKit Cloud, rented by the minute. LiveKit is open source, so the calls can move to our own servers
later without rewriting the screens.

> **Status: not started.** Every pick in §1 is open until the owner confirms.

---

## 1. Decisions to make (Go Biz Help)

Each has a pick. Open until the owner confirms.

| Question                            | Pick                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core or add-on                      | **Core.** It needs its own keys and a webhook route, which an add-on can't hold yet ("Not yet" in the add-on guide), the same reason Zoom is core                                    |
| Provider                            | **LiveKit Cloud**, Ship plan ($50 a month) to start. Self-hosting stays possible later                                                                                               |
| Instead of Zoom and Meet, or beside | **Beside.** A fourth choice for the Online place and each service: "No video", "Google Meet", "Zoom", "HandsFreeOS video". Nothing about Zoom or Meet changes                        |
| What people see                     | "Video call" on the booking page and in messages. The call page shows the business's name and look, as the booking page does. The word LiveKit never shows                           |
| How customers join                  | In the browser, from a link of their own in the confirmation and reminders. Each attendee's link is signed like their change-or-cancel link, and retires with it                     |
| Who on the team can join            | The appointment's staff, and anyone with `appointments.write` who can see the appointment (so a manager can step in)                                                                 |
| When a call can be joined           | From 15 minutes before the start until an hour after the end. Someone already in can stay longer, up to 4 hours in all                                                               |
| Waiting                             | A customer who's early waits on the call page ("Dale will be with you shortly") and is let in as soon as someone from the team joins. No admit button in the first version           |
| How many people                     | Up to 10 per call                                                                                                                                                                    |
| Screen sharing                      | Everyone in the call can share a screen                                                                                                                                              |
| Chat inside the call                | Not in the first version                                                                                                                                                             |
| Record and transcribe               | The same switch and the same consent notice as Zoom and Meet. Only sound is recorded, each person on their own, never video                                                          |
| Keep the recording                  | No. The sound is deleted once the transcript is saved, the same rule as today ("the raw recording is not kept")                                                                      |
| Billing                             | On the wallet at 1.5×, like texts, calls and speech: a line for each person's minute in a call, one for recording, and the transcript on the existing `speech.recording.minute` line |
| Plans                               | Every plan                                                                                                                                                                           |
| AI Sales Coach                      | Phase 2 (§9). It can listen to our calls, and everyone in the call sees "AI Sales Coach is listening", the same rule as in Zoom                                                      |
| The phone app                       | The team gets a call screen in the app (a store build, §7). Customers on a phone use the browser page                                                                                |
| Health records (HIPAA)              | Not offered. LiveKit lists a signed agreement for health data, but not clearly on the Ship plan; ask LiveKit's sales team if a business needs it                                     |

---

## 2. What it costs

LiveKit's prices are from livekit.com/pricing (read 2026-10-24); Deepgram's are the rate card's
(`packages/core/src/money/rates.ts`). Our cost for one hour, two people, before the 1.5× markup:

| Piece                               | How it's counted                                | Not recorded | Recorded   |
| ----------------------------------- | ----------------------------------------------- | ------------ | ---------- |
| The call                            | 120 person-minutes × $0.0005                    | $0.06        | $0.06      |
| Network (video sent to each person) | About 1 GB × $0.12, once past the plan's 250 GB | ~$0.12       | ~$0.12     |
| Saving each person's sound          | Track egress, 120 minutes × $0.001              | —            | $0.12      |
| The transcript                      | Deepgram pre-recorded, 120 minutes × $0.0052    | —            | $0.62      |
| **Total**                           |                                                 | **~$0.18**   | **~$0.92** |

- The Ship plan's $50 a month includes 150,000 person-minutes (about 1,250 two-person hours), 250 GB of network and
  600 recording minutes. Past those, the rates above apply.
- The network figure is an estimate for 720p video. It's checked while building (§14), since it's the biggest cost
  of a call that isn't recorded.
- At 1.5×, a business pays about 27¢ for an hour's call and about $1.38 for a recorded one.

---

## 3. What the repo has, and what it's missing

- **The video choice** (`VideoProvider` in `packages/core/src/calendar/config.ts`) on a calendar's Online place and
  per service (`ServiceOverrides`), with `record`.
- **The appointment's place** (`AppointmentLocation` in `packages/core/src/schemas/calendar.ts`): `video`,
  `meetingUrl`, `meetingError`, `record`.
- **Signed customer links** (`apps/worker/src/booking/links.ts`): a short HMAC code per attendee over
  `attendeeId:manageVersion`, so raising `manage_version` retires every link sent before.
- **The business's public look** (`apps/worker/src/look/public.ts`), which the booking page uses.
- **Transcripts and the AI pass:** `app.appointment_transcripts`, `appointment.attach_transcript` (emits
  `appointment.transcript_ready`), `appointment.call_review` and `app.call_suggestions`, and the two-hour
  `appointment.transcript_watch` (`apps/worker/src/meetings/transcripts.ts`).
- **Hearing a call live** for add-ons: `LiveFanout` (`apps/worker/src/addons/live-fanout.ts`), `LiveCall` with
  `kind: 'meeting'`, and per-side live listening with Deepgram (`apps/worker/src/telephony/live.ts`).
- **The speech service:** `SpeechServices.transcribe` (`apps/worker/src/voice-agent/speech.ts`), with Deepgram and a
  fake.
- **Speech billing in running totals** (`apps/worker/src/money/speech-usage.ts`).
- **The worker's sign-in check** for people (`authenticate` in `apps/worker/src/http/common.ts`), and public routes
  with rate limits and honeypots (`booking.ts`, `portal.ts`, `video-links.ts`).
- **Missing:** the LiveKit provider (rooms, join tokens, its webhook, saving sound), a record of each call and who was
  in it, the join pages and call screens (web and phone), the customer's own join link in messages, the transcript
  built from each person's sound, the billing lines, and a local LiveKit for development and the browser tests.

---

## 4. The provider (worker)

- **One seam, a real one and a fake,** like `meetings/provider.ts`: `apps/worker/src/video/provider.ts` with
  `createRoom`, `joinToken`, `startTrackEgress`, `stopEgress`, `deleteRoom` and `verifyWebhook`.
  - `apps/worker/src/video/livekit.ts` uses `livekit-server-sdk`.
  - `apps/worker/src/video/fake.ts` stands in locally and in tests.
- **Keys live on the worker only:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. The API already refuses
  any name with `SECRET` in it (`apps/api/src/env.ts`); add `^LIVEKIT_` to that list so the key is refused too.
- **A room per appointment,** made by the worker when the first person asks to join, named for the call
  (`hfos_<call id>`). Its settings: at most 10 people, closed 5 minutes after the last one leaves, and the call's id
  in its metadata.
- **Nothing is made ahead of time.** Unlike Zoom, there's no meeting to create, move or delete when the appointment
  changes, so `appointment.meeting_sync` never runs for HandsFreeOS video. Cancelling or moving the appointment is
  enough: the join routes read the appointment each time.
- **Join tokens** last 10 minutes (long enough to connect) and name the person: `team:<user id>` or
  `customer:<attendee id>`, with their name and side (`team` or `customer`) as attributes. Grants: join this room,
  publish camera, microphone and screen, subscribe. No data messages and no recording rights.
- **The webhook,** `POST /webhooks/livekit`, checks LiveKit's signature (a JWT signed with our secret, carrying the
  body's hash) and ignores rooms it doesn't know. It handles:
  - `participant_joined` and `participant_left`: who was in the call and for how long, for the appointment's history
    and for billing (§10).
  - `track_published`: in a recorded call, each person's microphone is saved on its own (§8).
  - `egress_ended`: that person's sound is ready to transcribe.
  - `room_finished`: the call is over; the transcript can be put together.
- **Two new tables,** with row-level security like `app.appointment_transcripts` (whoever can see the appointment can
  read them), mirrored in Drizzle:
  - `app.video_calls`: workspace, appointment, room name, `state` (`waiting`, `live`, `ended`), started and ended
    times, and whether it's recorded.
  - `app.video_call_parts`: each time someone was in a call: their side, user or attendee, name, joined and left
    times, and in a recorded call their saved sound's place and egress id.
- **A look-up for the webhook,** `private.video_call_by_room(text)`, like `private.appointment_by_meeting_id`,
  since the webhook names a room, not a business.
- **Commands:** `video_call.join` (people) and `video_call.join_online` (a customer, from their link) check the
  window and the appointment, make the call row if it's the first join, and return what the worker needs for the
  token. `video_call.started`, `.part_joined`, `.part_left` and `.ended` are the worker's (system only).

## 5. Getting the link to people

- **The choice:** add `hfos` to `VideoProvider`. Settings → Calendars → Locations, on the Online place: "Make a
  HandsFreeOS video link". The same under Services & lengths. No connection needed, so no Settings → My calendar card.
- **The customer's link:** `/j/<public ref><code>`, signed the same way as `/m/…` with its own purpose
  (`hfos:video-join:v1`) so the two codes never match. Raising the attendee's `manage_version` retires both.
- **Where it shows:** for HandsFreeOS video, `meetingUrl` stays empty, because each attendee has their own link. So
  everywhere the link goes out asks for the attendee's link instead:
  - the confirmation and reminders (`apps/worker/src/booking/messages.ts`, "Join here: …");
  - the calendar invite file (`booking/ics.ts`);
  - the customer's portal;
  - what the AI teammate tells a customer who asks (`apps/worker/src/assistant/tools-scheduling.ts`).
- **The team's link:** the event written into the staff member's own Google or Outlook calendar gets the team's call
  page as its location (`apps/worker/src/calendar/sync.ts`).
- **The booking page** says "Video call", and "This call is recorded and transcribed" when it is, as for Zoom.

## 6. The call pages (web)

Read `apps/web/AGENTS.md` and Next's docs in `node_modules/next/dist/docs/` first.

- **Built on `livekit-client` and `@livekit/components-react`'s pieces,** styled with our own components
  (`apps/web/src/components/ui`), not LiveKit's default look.
- **The customer's page,** `/j/[token]`, signed out, in the business's look:
  - Before the window: the appointment's title and time, "This call opens at 1:45 pm".
  - In the window: a camera and microphone check (see yourself, pick devices, test sound), the name on the booking
    filled in, then **Join the call**.
  - After it: "This call has ended." A cancelled or moved appointment says so, with the change-or-cancel link.
- **The team's page,** `/app/w/[workspaceId]/call/[appointmentId]`, opened from **Join** on the appointment sheet
  (`components/calendar/appointment-sheet.tsx`). Beside the video: the customer's record and the appointment's notes.
- **In the call, both sides:** video tiles, mute, camera off, share screen, leave. "This call is recorded and
  transcribed" stays on screen in a recorded call.
- **Headers:** check that the web's headers allow the camera and microphone on these pages, and that LiveKit's
  address is allowed to connect.
- All words live once in `@hfos/core`, and refusals follow "Error messages" in `CLAUDE.md`. For example: "This call
  opens at 1:45 pm, 15 minutes before it starts. Come back then." or "This appointment was cancelled, so its call is
  closed."

## 7. The phone app (team)

- `@livekit/react-native`, `@livekit/react-native-webrtc`, and their Expo plugins (`@livekit/react-native-expo-plugin`,
  `@config-plugins/react-native-webrtc`), with `registerGlobals()` at startup.
- **This is new native code, so it ships as a store build,** not an over-the-air update. Follow
  `apps/mobile/store/README.md` and `release-checklist.md`.
- **Update the permission wording** in `apps/mobile/app.json`. Today the camera is "to take photos" and the microphone
  "only while you talk out loud to the Assistant…". Apple rejects wording that doesn't match what the app does.
- **Keep the call going with the screen locked:** iOS's background audio for calls. Showing calls in the phone's own
  call screen (CallKit) can come later.
- **The appointment screen** (`components/calendar/meeting.tsx`): `meetingOf` learns `hfos`, and Join opens the in-app
  call screen instead of a link.
- **Sync is unchanged.** The choice lives inside the appointment's `location`, which the phone already has, and the
  call's details are read from the API when online. `apps/sync/sync-config.yaml` doesn't change.

## 8. Recording and the transcript

Only in calls set to record, which the customer was told about before booking.

- **Each person's microphone is saved on its own.** On `track_published` for a microphone, the worker starts a track
  egress for that track. Its sound goes to a private Storage bucket (`video-audio`), at
  `<workspace>/<call>/<part>.ogg`. Video is never saved. Saving each person separately means the transcript knows
  exactly who said what, with no guessing from voices.
- **Each file is transcribed** (`video_call.transcribe_part`, a job queued on `egress_ended`) with
  `SpeechServices.transcribe`, the speech service the worker already uses, and billed as `speech.recording.minute`.
- **The transcript is put together** (`video_call.transcript`, queued on `room_finished`, waiting until every part is
  transcribed): each person's lines in time order, named ("Dale: …", "Maria: …"). It's saved with
  `appointment.attach_transcript`, provider `hfos` (a migration lets `appointment_transcripts.provider` be `hfos`).
  That emits `appointment.transcript_ready`, so the summary, tasks, follow-up email and record changes all work
  unchanged.
- **Then the sound files are deleted.** A daily sweep deletes any older than a day, in case a job died partway.
- **The two-hour check** (`appointment.transcript_watch`) covers HandsFreeOS video too, with reasons we can know
  exactly instead of settings to fix: nobody joined, the call was under a minute, or something failed on our side
  ("Try again in a few minutes. If it still fails, contact support.").

## 9. AI Sales Coach in our calls (phase 2)

- **The worker joins the room as a hidden listener** (`@livekit/rtc-node`), only when an add-on that listens
  (`liveCalls`) runs in the business and someone from the team on the call holds its permission.
- **It hears each person's microphone separately** and streams it to Deepgram live, as `telephony/live.ts` does for
  each side of a phone call. Each finished line goes to `LiveFanout` as a `LiveCall` with `kind: 'meeting'`. The side
  comes from the person's token, not from matching names as in Zoom.
- **No claim step:** the call page knows the appointment and the customer, so the coach starts with the call.
- **The coach's panel** shows beside the team's call page through `<AddonSlot>`; core never imports the add-on.
- **Everyone in the call sees "AI Sales Coach is listening".**
- **Billed as `speech.live.minute`,** which exists. The listener is a person-minute on LiveKit, not one of its agent
  minutes, since those are for agents run on LiveKit's own servers (check, §14).
- **A worker restart drops the listener.** It rejoins rooms still live when the worker starts, so a deploy loses a
  few seconds of coaching, not the call.

## 10. Money

- **Two new rate lines** in `USAGE_KEYS` and `SEED_RATES` (`packages/core/src/money/rates.ts`), with a migration that
  widens `platform.usage_rates_key_check` and inserts the rates. `20261027007900_zoom_meetings_on_the_wallet.sql` is
  the model.
  - `video.participant.minute`: each person's minute in a call. Cost about 1,500 micros: LiveKit's $0.0005, plus
    about 8 MB of network at $0.12 a GB. Billed at 1.5× in running totals.
  - `video.recording.minute`: each person's minute of saved sound. Cost 1,000 micros (track egress).
- **Counted from `participant_left`:** each part's minutes, rounded up per part, added to the running totals the way
  `money/speech-usage.ts` does.
- **Go Biz Help pays the $50 plan.** The minutes it includes aren't passed on to any one business.

## 11. Privacy and safety

- **Every join is checked each time:** the link or the person's sign-in, the window, the appointment's state, and
  who's allowed. Tokens are short-lived and name one person in one room.
- **Customers' links** are found only by their code, retire with `manage_version`, and their routes have per-address
  limits and a honeypot, like the booking routes.
- **The webhook** is checked by signature; unknown rooms are ignored.
- **Calls are encrypted on the way,** but LiveKit's servers handle the sound and video in between. LiveKit's own
  end-to-end encryption would stop recording and the coach from working, so it's not used.
- **Nothing is kept at LiveKit.** Saved sound lands in our Storage and is deleted after the transcript.
- **Deleting:** call rows and parts go with their appointment (`on delete cascade`), as transcripts do. In
  `docs/deleting.md`, add LiveKit to "Outside services keep their own copies" (its logs, never media).
- **Update `/privacy` on the site** to name LiveKit as a processor. LiveKit's standard data agreement comes with the
  Ship plan.

## 12. Setup and docs

- **`docs/operations.md`:** "Video calls: LiveKit": make the LiveKit Cloud project, set the worker's three secrets on
  Fly, and point LiveKit's webhook at `<worker>/webhooks/livekit`.
- **Locally:** the fake by default, so there's nothing to set up. For real calls on a laptop and in the browser tests,
  `livekit-server --dev` (free, one binary), added to "Run it locally" in `README.md`.
- **`docs/calendar-setup.md`:** a short "HandsFreeOS video" section beside Zoom's.

## 13. Build order

1. **The provider** (§4): keys, the fake, rooms, tokens, the webhook, the two tables and the commands. No screens.
2. **Calls on the web** (§5, §6, §10): the choice in settings, the customer's link in messages, both call pages, and
   the billing lines. Ships when billing works, so no call goes unbilled.
3. **Recording and transcripts** (§8): saving each person's sound, the transcript, the AI pass, the two-hour check.
4. **The phone app** (§7): the call screen, as a store build.
5. **The browser test** (§15).
6. **AI Sales Coach in our calls** (§9).

Each step ships on its own. Steps 3 and 4 can run side by side.

## 14. Check first

- **Supabase Storage as the place sound is saved:** LiveKit's egress writes to S3-compatible storage, and Supabase
  Storage has an S3 endpoint. If they don't work together, use a small separate bucket whose keys only the worker
  holds.
- **The network per call** at our video settings (simulcast, 720p at most), since it's the biggest cost of a call
  that isn't recorded.
- **A listener run on our worker** counts as person-minutes, not LiveKit agent minutes.
- **Webhook order:** whether `egress_ended` can come after `room_finished`, and how LiveKit retries a failed delivery.
- **Apple's review** of the camera and microphone wording and the background audio mode.

## 15. Tests

- **Core:** the commands' permissions and validation; joining is refused outside the window, on a cancelled or
  deleted appointment, and for someone on the team who isn't allowed; `hfos` needs an Online place.
- **Worker:** tokens grant the right side and nothing more; the webhook with good and bad signatures; unknown rooms
  ignored; sound saved only in recorded calls and only from microphones; the transcript puts each person's lines in
  order; minutes are billed once per part; a retired or wrong link is refused.
- **DB:** row-level security on `video_calls` and `video_call_parts`; Drizzle parity; the usage keys' parity.
- **Web e2e:** book an online visit set to HandsFreeOS video; open the customer's link and the team's Join in two
  browsers, against the local LiveKit with Chromium's fake camera; each sees the other; leave. With recording on, the
  fake speech service's transcript arrives and the scripted AI's task can be added.
