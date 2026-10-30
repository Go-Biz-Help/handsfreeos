# HandsFreeOS video calls (20261027013000, 20261027013300, 20261027013500, 20261027014600, 20261027019600, 20261027019800, 20261027019900)

HandsFreeOS's own Zoom-like calls. A calendar's Online place (or one service on it) can say **HandsFreeOS video
call**, and each appointment booked there gets its own call, with nothing for the business to connect. Customers
join from their own Join link in any browser, with no app and no sign-up; the team joins from the appointment. LiveKit
carries the video and sound.

Part 1, the call itself on the web, is built, and so is part 2, the AI hearing it: captions, "AI notes on", the
transcript on the appointment and today's After the call. So is part 3, the Sales Coach in the call: its cards beside
the video, and its write-up and score after. Part 4, the team's call screen in the phone app, is built too and reaches
phones with the next store build ("On the phone" below). So is part 5, calls any time: **Video call** on a customer's
page and in a conversation, and **Switch to video** during a phone call, send the customer their own link and open the
call ("Calls any time" below). A session's call is a **webinar**: up to 500 people, the presenter big and everyone
else watching, with a link anyone can use ("Webinars" below), and any call can carry **live polls**: questions and buttons that pop
up on customers' screens, asked by the team or by the AI when it hears them reach each one, with the answers landing
on their contacts ("Live polls" below;
`HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md` is the plan they come from). Support turns calls on per business in /admin until every business gets them. Setting up LiveKit (the account, the worker's secrets and the
webhook) is "Video calls: LiveKit" in `docs/operations.md`.

## Where things are

| What                                         | Where                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Tables, the /admin switch and the rate line  | `supabase/migrations/20261027013000_video_calls.sql`                                                                              |
| Rules and words both apps share              | `packages/core/src/meetings/video-calls.ts` (`VIDEO_CALL_WORDS`, `effectiveVideo`, `videoCallLinkOpens`)                          |
| Commands and the read                        | `packages/core/src/commands/video-call.ts`; the switch is `video-calls-switch.ts`                                                 |
| Where an appointment's call comes from       | `locationFor` in `packages/core/src/calendar/booking.ts`; the meeting job in `apps/worker/src/meetings/sync.ts`                   |
| LiveKit, and the stand-in                    | `apps/worker/src/video-calls/livekit.ts`, `fake.ts`, behind `provider.ts`                                                         |
| Tickets, the customer's Join, knocking       | `apps/worker/src/video-calls/routes.ts`                                                                                           |
| LiveKit's webhooks, acted on                 | `apps/worker/src/video-calls/reports.ts`; mute, remove and End for everyone in `handlers.ts`, from the events                     |
| The customer's page                          | `/j/<code>` (`apps/web/src/components/booking/join-session.tsx`), then `components/video-call/customer-call.tsx`                  |
| The call's own link                          | `/call/<id>` (`apps/web/src/app/call/[callId]/page.tsx`, `components/video-call/link-call.tsx`)                                   |
| The call screen                              | `apps/web/src/components/video-call/` (`call-room.tsx`, `call-stage.tsx`, `call-panels.tsx`, `pre-join.tsx`)                      |
| Join and who joined, on the appointment      | `apps/web/src/components/calendar/video-call-block.tsx`                                                                           |
| The Online place's choice                    | `LocationsModule` and `ServicesModule` in `apps/web/src/components/calendars/modules.tsx`                                         |
| The switch in /admin                         | `apps/web/src/components/admin/video-calls-block.tsx`                                                                             |
| The browser test                             | `apps/web/e2e/video-call.spec.ts`, on a real LiveKit server in CI                                                                 |
| What the AI heard, and the listener's list   | `supabase/migrations/20261027013300_video_call_words.sql` (`app.video_call_lines`, `video_calls_to_hear`)                         |
| The listener                                 | `apps/worker/src/media.ts` (the `media` process in `fly.toml`), `video-calls/listener.ts`                                         |
| Hearing each person, captions, lines         | `apps/worker/src/video-calls/hearing.ts`; LiveKit's media library only in `listener-room.ts`                                      |
| The transcript, once a stretch is over       | `video_call.keep_words` (core), queued by `onVideoCallEnded` in `apps/worker/src/video-calls/handlers.ts`                         |
| The coach in the call                        | `apps/worker/src/video-calls/coach.ts` (`CallCoach`, `finishCoaching`); `video_call.coach` (core)                                 |
| The coach's cards beside the video           | `apps/web/src/components/video-call/call-coach.tsx` (the `call.panels` slot), placed by `call-room.tsx`                           |
| The phone's call screen                      | `apps/mobile/src/video-call/` (`phone-call.tsx`, `room.tsx`, `team-call.ts`), at `app/app/w/[workspaceId]/call/`                  |
| The coach's card on the phone                | `apps/mobile/src/addons/salescoach/call-card.tsx`, the phone registry's `CallCard`                                                |
| LiveKit in the phone's build                 | `apps/mobile/app.json` (its plugins and the camera and microphone words), `app.config.ts` (no screen share)                       |
| Calls any time: the link and the line        | `supabase/migrations/20261027014600_video_calls_any_time.sql`; `video_call.start` and `keepTimelineLine` (core)                   |
| Which call a customer's `/j/` link opens     | `apps/worker/src/video-calls/links.ts` (`resolveCustomerLink`); the start route in `video-calls/routes.ts`                        |
| Video call and Switch to video, on the web   | `apps/web/src/components/video-call/start-call.tsx`, used by `record-page.tsx`, `conversation-view.tsx` and `active-call-bar.tsx` |
| Video call and Switch to video, on the phone | `apps/mobile/src/video-call/start-call.tsx`, used by the customer's screen, the conversation and `call-sheet.tsx`                 |
| Notes from the call, on the timeline         | `components/video-call/call-notes.tsx` on the web, `src/video-call/call-notes.tsx` on the phone                                   |
| Webinars: columns, the door's lookup, sweep  | `supabase/migrations/20261027019600_webinar_room.sql`                                                                             |
| Webinars: who may send what, words           | `mayPublish`, `roomRightsOf`, `WEBINAR_WORDS` in `packages/core/src/meetings/video-calls.ts`; `rightsOf` in `video-call.ts`       |
| Webinars: the camera choice and the stage    | `video_call.set_attendee_video`, `video_call.stage` (core); LiveKit told in `apps/worker/src/video-calls/handlers.ts`             |
| Webinars: the link anyone can use            | `webinar.register` (`packages/core/src/commands/webinar.ts`), `apps/worker/src/http/webinar-door.ts`, the web's `/live/<key>`     |
| Webinars: starting now, missed it            | `apps/worker/src/video-calls/webinars.ts`                                                                                         |
| Webinars: the calendar's settings            | `WebinarSettings` in `apps/web/src/components/calendars/modules.tsx` (`locations.webinar` in the calendar's config)               |
| Live polls: tables                           | `supabase/migrations/20261027019700_live_poll_kinds.sql`, `20261027019800_live_polls.sql`                                         |
| Live polls: rules, the pop-up, the totals    | `packages/core/src/meetings/polls.ts`; what a poll may ask is `pollProblems` in `forms/definition.ts`                             |
| Live polls: commands and reads               | `packages/core/src/commands/video-call-poll.ts`                                                                                   |
| Live polls: the room told, the jobs          | `apps/worker/src/video-calls/polls.ts`; the customer's routes in `video-calls/routes.ts`                                          |
| Live polls: the pop-up and the team's panel  | `components/video-call/poll-popup.tsx`, `poll-panel.tsx`, placed by `call-room.tsx`                                               |
| Live polls: the AI asking, in the call       | `apps/worker/src/video-calls/poll-cues.ts`, made by `listener.ts`; `videoCallPollCueState` (core)                                 |
| Live polls: when-to-ask phrases by the AI    | `apps/worker/src/forms/poll-cue-routes.ts`; the editor's side in `apps/web/src/lib/forms/poll-cues.ts`                            |

## How a call goes

1. **Booked.** An online appointment whose place (or service) says HandsFreeOS video call gets its call from the
   worker's meeting job (`video_call.open`), and the appointment's link becomes the team's way in, `/call/<id>`. The
   customer's confirmation, reminders and change notices carry their own Join link, `/j/<code>`, instead.
2. **The customer opens their link.** It opens the call itself from an hour before the start until the end, and for
   as long after as the call is still going (`videoCallLinkOpens`). They see the business's name, logo and colour, a
   camera and microphone check with the name on their booking filled in, and **Join**. A link opened inside
   Facebook's or Instagram's own browser is told to open in Safari or Chrome.
3. **Getting in** (the owner's 6a). A customer on their own link goes straight in once someone from the team is in
   the call. Until then they see "Dana will be right with you", their page asks again every few seconds, and the
   people on the appointment get a push. Anyone else on the call's link asks to be let in, and the team lets them in
   or turns them away.
4. **The team joins** with **Join video call** on the appointment, which opens `/call/<id>` in a tab of its own, or
   with **Join** on the appointment in the phone app, which opens the call screen there (part 4). The push about
   someone waiting opens the call too. Someone signed in who can't see the appointment asks to be let in like anyone
   else.
5. **In the call:** camera, microphone, screen share from a computer, chat, background blur, reactions and raise
   hand. The team can let people in, turn them away, mute or remove someone, and end the call for everyone. A
   dropped connection reconnects on its own; a second tab or phone takes over from the first.
6. **The AI listens** (part 2) while the call's AI notes are on, which they are unless the team turns them off for
   that call. The worker's listener joins unseen and hears each person's microphone on its own. Each person's sound
   goes to Deepgram only while they talk. The words go to everyone as captions (CC) and are kept as lines, each with
   who said it. Everyone sees **AI notes on**.
7. **The coach** (part 3), in a business with AI Sales Coach, for someone on the team it's on for. What the listener
   hears goes to it line by line, as a Zoom meeting's transcript does. Its cards show beside the video, or over the
   top of it on a phone, and the call is written up and scored once it's over.
8. **After.** The appointment lists who joined and for how long, a customer's attendance is marked from whether they
   were really in, and everyone's minutes go on the business's balance as one line, `video.minute`. A minute after
   the call ends, what the AI heard becomes the appointment's transcript. Today's After the call starts from it, as
   with Zoom: the summary, tasks, a follow-up email and record changes, each waiting for a person.

A call that isn't for an appointment (part 5) starts with **Video call** or **Switch to video** instead of a booking,
and ends as its own line on the customer's timeline instead of on an appointment. Steps 3 and 5 to 7 are the same.

## The owner's decisions (2026-10-27)

The owner answered the 16 questions with "all picks except 12b". These are settled; ask before going against one.

| #   | Decision                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- |
| 1   | LiveKit carries the video.                                                                                    |
| 2   | It's called "HandsFreeOS video call" in HandsFreeOS. Customers see the business's own name, never this.       |
| 3   | Customers see the business's name, logo and colour, with a small "Powered by HandsFreeOS".                    |
| 4   | It's the default for new Online places and ones with no link; Zoom, Meet and pasted links stay as they are.   |
| 5   | Calls start from booked appointments, a customer's page, a conversation, and Switch to video on a phone call. |
| 6   | A customer on their own link goes straight in once the team is there; anyone else waits to be let in.         |
| 7   | Up to 10 people on camera; bigger sessions come later with a presenter-and-audience view.                     |
| 8   | The AI listens on every call, after the notice; the host can turn it off for one call.                        |
| 9   | The notice is on the booking page, in the confirmation and before joining; joining is agreeing.               |
| 10  | No recording, just the words.                                                                                 |
| 11  | A CC button with live captions for everyone.                                                                  |
| 12  | Screen share (from a computer), chat, background blur, reactions and raise hand.                              |
| 13  | The team joins in the HandsFreeOS app too, with the coach's cards; that needs a new store build.              |
| 14  | The business pays on its usage balance at 1.5×.                                                               |
| 15  | Nothing else in the first version.                                                                            |
| 16  | Test businesses first; every business once parts 1 to 3 are in.                                               |

The build order: (1) the call on the web; (2) the AI hears it: the listener, captions, the transcript and today's
After the call, the notice, AI notes on or off for one call; (3) the Sales Coach in the call; (4) the phone app;
(5) calls any time, from a customer's page, a conversation or a phone call; (6) later: big sessions, recordings,
joining by phone, team-only meetings.

## Rules worth knowing before changing anything

- **Only the worker talks to LiveKit.** It alone holds LiveKit's three values; the API refuses to start with any
  `LIVEKIT_*` in its environment, and the web build must never carry them. Nobody gets into a room without a ticket
  the worker signed, and it signs one only once core's commands say the person may come in.
- **Every change is a command,** LiveKit's reports included: `video_call.joined`, `.left` and `.finished` keep who
  was in and for how long. The worker tells LiveKit about a mute, a removal or End for everyone from the events those
  commands write, never from the request.
- **A person's identity in the room is their row of `app.video_call_people`.** The room is `hf-<call id>`. The AI's
  listener (part 2) is the one identity that isn't a row: it's never shown, counted or charged as a person.
- **Tickets last 15 minutes,** long enough to connect. Someone back on an old ticket after they were taken out or
  turned away is taken straight out again by `reports.ts`.
- **Who someone is to the call (`hfos.kind`) is a label for the screen, nothing more.** The team's powers come from
  commands with permissions: `video_call.join` needs `appointments.write`, and letting in, muting, removing and
  ending check the same. Nothing trusts what a page says about itself.
- **LiveKit's webhooks are checked against our key** (a signed token over the body), stored once per event id, and
  worked through in order. A room that isn't one of ours is answered and dropped.
- **A guest's request to come in is theirs alone.** Their page makes a random key and keeps it for the tab; the
  worker stores only its hash, so only that page can ask how it stands or come in on it.
- **The call's own link may be passed on,** so what it shows anyone who isn't on the team is the business's name and
  look, never the appointment's title or the customer.
- **Chat and reactions aren't kept.** They travel between the people in the call and go with it. No video or sound is
  kept either (decision 10).
- **Background blur happens in the person's own browser,** before their camera is sent. Its model comes from its
  publisher's CDN the first time someone turns blur on, so a browser that can't fetch it simply can't blur.
- **Switching calls off doesn't take the choice away.** While a business has calls off, a place set to HandsFreeOS
  makes no call (`effectiveVideo`) and Settings says why. A call already made doesn't open: its own link says video
  calls aren't on for the business right now, and a customer's Join link says there's no online meeting yet.
- **Up to 10 people at once** (`VIDEO_CALL_MAX_PEOPLE`), the listener aside. The eleventh is told the call is full.

### The AI hearing the call (part 2)

- **The listener is the `media` process,** beside the worker in the same Fly app with the same secrets. It is not
  part of the worker's own process. It needs LiveKit and Deepgram. Without either it says so in its log and waits.
  LiveKit's media library (`@livekit/rtc-node`) is native code built only for glibc, which is why the worker's image
  is Debian. Only `listener-room.ts` imports it, so tests and the worker never load it.
- **It joins only what `private.video_calls_to_hear()` lists:** live calls with AI notes on, in a business with
  calls on. It checks the room first and joins only when someone is in it and no other listener is. It leaves once
  it's been alone 10 seconds, so an empty room closes.
- **One listener a call.** Every listener has the same identity (`hfos-listener`), so a second one joining replaces
  the first. The replaced one leaves the call to the other for a minute.
- **The listener is hidden, and its ticket can't publish sound or video,** only data (captions). Its ticket is
  signed by the worker like everyone's. It's never a row of the call's people, so it's never counted or charged as
  one.
- **Only talking is sent.** Each person's sound passes a voice gate (`GATE` in `hearing.ts`). Talking is sent with
  300 ms from before it and 1.2 s after, so Deepgram hears the pause that ends a sentence. Quiet is never sent, and
  Deepgram bills only what it's sent. The seconds sent go on the balance about once a minute as `speech.live.minute`.
  That's the same line as the phone's live speech.
- **Captions come only from the listener.** They travel on `hfos.captions`, a guess first and then the finished
  words. The screens show them with CC on. The listener is unseen, so its messages come from nobody in the room, and
  the call screen ignores that topic from anyone in it.
- **"AI notes on" is the room's metadata** (`hfos.ai`), which the listener sets as it joins. AI notes turned off
  clear it at once (`onVideoCallAiChanged`), and the listener leaves on its next look.
- **Lines are kept as they're heard,** a few at a time (`video_call.heard`), so a listener that restarts mid-call
  (a deploy) loses only its last few seconds. Each line's key carries the listener's own session, so a restarted
  listener's lines never clash with the last one's.
- **AI notes off forgets.** `video_call.set_ai` (the team's, `appointments.write`) deletes the lines heard so far in
  the same transaction, and `video_call.heard` keeps nothing for a call whose notes are off.
- **One transcript a stretch.** When the room closes, `video_call.ended` queues `video_call.keep_words` 20 seconds
  later, once the last lines are in. It makes the lines up to the stretch's end into the appointment's transcript
  (provider `handsfree`, kept once per stretch) and deletes them. Fewer than 15 words isn't kept: "Can you hear me?"
  is no conversation. A call that isn't for an appointment keeps its transcript on the call instead (part 5).
- **The transcript emits `appointment.transcript_ready`** exactly as Zoom's does, so After the call, the timeline's
  summary and the suggestions need nothing of their own. The words themselves never go in an event or the
  activity log.
- **The notice** is on the booking page (`aiNotes` on a place or service), in the confirmation and reminders
  (`whereLine`), and on the page before joining, for the customer and for anyone on the call's link. Joining is
  agreeing (decision 9).

### The coach in the call (part 3)

- **Each stretch of the call is a live meeting** (`app.live_meetings`, provider `handsfree`, the stretch's LiveKit
  room id as its meeting id) of the one person on the team it's coached for. Add-ons that listen (`liveCalls`) hear
  it as they hear a Zoom meeting, so the coach needs nothing of its own for our calls. Nobody claims it: the call
  knows who's in it.
- **Who's coached:** the first person on the team in the call that an add-on listens for (`liveListenersFor`), the
  host first, then whoever joined first. `video_call.coach` makes the live meeting only while the call is live, its
  AI notes are on and that person is in it. The customer is the one in the call, else the call's, else the
  appointment's first. While nobody in the call is coached, the listener asks again every 15 seconds.
- **The listener hands each line to the coach** as it's finished, the team's people on the team's side and everyone
  else on the customer's. Lines heard before it began (a rep who joined late, a listener that restarted) come first,
  from the lines kept so far.
- **The media process has the worker's services** (`services-env.ts`), so the coach thinks, bills and pushes there
  as it does on a phone call.
- **AI notes off forgets the coaching too.** The listener leaves, and the add-ons hear the end with nothing to keep
  (`forgotten`): the coach's call is stopped with no lines, its cards (which quote the customer) are deleted, and
  nothing is written up.
- **Leaving otherwise doesn't end it.** A listener that leaves (alone, a deploy, another listener took over) leaves
  the live meeting live, and the next listener carries on with the same one. When the stretch is over, the job that
  keeps its words (`video_call.keep_words`) first finishes any coaching still live from the lines kept, so the
  write-up has everything that was said.
- **The cards beside the video** are the add-ons' `call.panels` slot, the same one above the phone's call bar. The
  call's page sits outside the business's pages, so it brings the business's add-ons, the person's permissions and
  the live updates along itself (`call-coach.tsx`). Only the team sees it.

### On the phone (part 4)

- **Only the team joins in the app.** Customers and anyone else join on their links in a browser; the phones claim
  neither `/j` nor `/call` (`app.json`), so those links never open the app.
- **The same doors as the web's.** Join asks the worker for a ticket (`/v1/video-calls/join`, which runs
  `video_call.join`), the screen reads `video_call.get` every few seconds, and Let in, Turn away, Mute, Remove, End for
  everyone and AI notes off or on are the same commands. Nothing is kept on the phone, so
  `apps/sync/sync-config.yaml` is unchanged and a call needs signal.
- **Where it opens:** `videoCallAppPath`, `/app/w/<business>/call/<id>`. Join on the appointment opens it for a
  HandsFreeOS call (`callIdOfLink` reads the call from the appointment's link); Zoom and Meet still open their own
  apps. The push about someone waiting opens it too. On the web that path is a page that goes on to `/call/<id>`, so
  an older phone build, which doesn't know it, opens the browser and lands in the same call.
- **Before joining**, the screen says what the call is, who's waiting or in it already, and that AI takes notes when
  it does, with the microphone and camera to start with. Nothing turns on until Join; the phone asks for the camera
  and microphone the first time, and someone who said no is sent to Settings (`media.ts`).
- **In the call:** the person you're talking to fills the screen with you in the corner, more people share a grid,
  and a screen shared from a computer goes big. Microphone, camera, Flip, where the sound comes out (the iPhone's
  own picker; on Android speaker, phone or headphones), captions, People, Chat, and Leave or End for everyone. The
  screen stays awake while the call is open.
- **The coach's newest card sits over the top of the video** for someone with `salescoach.use`: the phone registry's
  `CallCard`, read from `salescoach.live` every 3 seconds, as the Live call screen does.
- **LiveKit loads with the first call** (`load-room.ts`), so the app doesn't start it, or its WebRTC, at launch.
- **While the app is open.** There's no background sound on an iPhone (no `audio` background mode) and no foreground
  service on Android, so the camera and microphone stop when the person leaves the app, and the call carries on when
  they come back. A call is something the phone is in front of you for.
- **A new store build,** because LiveKit's WebRTC is native code: the release run's fingerprint makes one rather than
  an over-the-air update. Until people update, Join on their phone opens the browser as before. The camera and
  microphone words, and what each Android permission is for, are in `apps/mobile/store/permissions.md`.

### Calls any time (part 5)

- **Video call** on a customer's page and in a conversation, and **Switch to video** on a phone call's bar (the call
  sheet on the phone), all run `video_call.start` through the worker's `/v1/video-calls/start`. It needs
  `appointments.write` and `inbox.use`, and the business must have calls on. In one change it makes the call, hosted
  by whoever pressed it, and sends the customer their own link as that person (`message.send`, so quiet hours, STOP
  and the conversation work as for any message). The screen then opens the call for them.
- **How the link goes** (`videoCallInviteChannel`): in a conversation, on its own channel; otherwise a text, else an
  email. A customer with both on the web or phone is asked which. Someone who texted STOP, or a business that can't
  text yet, gets the email. In quiet hours only a person's **Send the link anyway** sends a text, as in the composer.
- **The customer's own link is `/j/<key>`,** the same path as a booking's Join link. The key is 32 random letters and
  digits, and only its hash is kept (`link_key_hash`); a booking's link is 18 long, so `resolveCustomerLink` tells
  them apart by length. It opens the call for a day after it was made, and for as long as the call is going
  (`customerCallLinkOpens`); after that it says the call is over. Its page shows the business's name and look, never
  the customer's.
- **The customer goes straight in once the team is there** (the owner's 6a), as on an appointment: until then they
  wait, and whoever started it gets the push that someone is waiting.
- **The AI notice comes before joining** (decision 9): the link's message says AI takes notes, and so does the page
  before Join. A call is made with its AI notes on, and the host can turn them off for that call as usual.
- **Its own line on the timeline:** "Dana had a video call · 12:04" (`keepTimelineLine`), written when the first
  stretch ends and kept up to date by later ones, timed by the customer's own time in the call. The AI's summary
  becomes the line's body, and **Notes from the call** on it opens After the call and the transcript.
- **Transcripts and After the call** belong to an appointment or to one of these calls (`video_call_id`, exactly one
  of the two). The transcript emits `appointment.transcript_ready` with the customer and no appointment, so the
  summary and suggestions need nothing new. Search never reads transcripts (decision 15).
- **The phone asks `workspace.get` whether calls are on,** once while the app is open, since nothing about calls is
  kept on the phone. `apps/sync/sync-config.yaml` is unchanged.

### Webinars (20261027019600)

The owner's answers of 29 October 2026 are in `HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md`; this is part 1 of it.

- **A session's call is a webinar** (`video_calls.format`), set when the call is made (`madeAs`) and never changed.
  Everything else stays a meeting. A webinar holds 500 (`WEBINAR_MAX_PEOPLE`), a meeting 10; the room's size is set
  by the first ticket used in it.
- **What each person may send is in their ticket** (`rightsOf` → `video_call.join`, `.enter` and `.knock_status` →
  the worker's ticket). The team sends everything. Attendees are muted with no screen share, and get a camera only
  when the camera choice allows one. Someone brought on stage (`video_call.stage`, three at most, never the team)
  talks and is on camera. LiveKit holds them to it: the ticket's `canPublishSources`, and on a change the worker's
  `updateParticipant` from the event, which also stops anything they may no longer send.
- **The same rights are attributes** (`hfos.format`, `hfos.video`, `hfos.stage`), read back with `roomRightsOf` by
  every page and the phone, so the buttons match what LiveKit allows. The worker updates them with the permissions.
- **The camera choice** (`video_calls.attendee_video`: off, team, everyone) starts from the calendar's
  `locations.webinar.attendeeVideo` and is the team's to change in the call. With **team**, an attendee's own page
  lets only the team's identities receive their camera (LiveKit's track subscription permissions): enforced by
  LiveKit, not just hidden.
- **The layout** (`call-stage.tsx`): a shared screen big, else whoever on stage spoke last; the rest of the team and
  anyone on stage beside it; attendees' cameras, when this page may see them, in a strip of 12 at most.
- **Attendees never see each other's names:** their People panel lists who's presenting and how many are watching,
  raised hands are toasted to the team only, and an attendee's name in the room starts as their first name.
- **Waiting for the team** gives one push for the crowd every ten minutes, not one per person.
- **The link anyone can use** (`/live/<key>`, 24 public letters and digits in `door_key`) shows the webinar and a
  door form. `webinar.register` books a seat on the session exactly as the booking page does (matching, consent,
  the session caps; up to 500 bookings an hour on a sessions calendar). Only a customer made from that very form gets
  their own Join link back; anyone already on file is sent theirs (`webinar.join_link`), so typing someone else's
  details gets nobody in as them. A webinar that asks for payment points to the booking page instead.
- **Starting now** (`webinar.starting`, every minute): webinars that started in the last 15 minutes
  (`private.webinars_starting`) text, else email, each person booked who isn't in yet their own Join link, then
  `video_call.starting_told` marks the call so it goes once. Off with the calendar's `webinar.startingNow`.
- **Missed it:** `attendee.no_show` on a webinar queues `webinar.missed`, which waits out quiet hours and tells them
  when the next session on the calendar with seats is, with its link anyone can use, unless they've booked a later
  one already. Off with `webinar.missedFollowUp`. The replay joins it once replays exist.

### Live polls (20261027019700, 20261027019800)

Part 2 of `HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md`. Any HandsFreeOS call can carry one; a webinar is where it
matters.

- **A poll is a form** made as a **Live poll** (`mode = 'poll'`, "Live polls" in `docs/forms.md`). A call picks one
  (`video_calls.poll_form_id`, `video_call.set_poll`); a session's call starts with its calendar's
  (`locations.webinar.pollFormId`), taken only while that form is a live poll and not archived.
- **One question is up at a time.** The team asks from the poll panel (`video_call.poll_open`, Ask now); asking
  another closes the one that's up (`replaced`). A question asked once isn't asked again; one skipped
  (`video_call.poll_skip`) can be. Each asking is a row in `app.video_call_polls`, one per call and question, and a
  unique index keeps one open per call.
- **It closes** when its time is up (`liveOf(q).seconds`, 60 by default; the worker's `video_call.poll_close` job at
  `closes_at`, which leaves alone a question asked again since), once 90% of the customers in the call answered
  (`closesEarly`: the answer that gets it there closes it, in the same transaction), or on the team's Close.
- **The room is told by the worker, from the events,** on LiveKit's `hfos.polls` data topic. Pages trust a poll
  message only when LiveKit delivered it with nobody's name on it, which is how the server's messages arrive, so
  someone in the call sending the same topic is ignored. A page that joins late, or comes back after a drop, asks
  `GET /public/join/<token>/poll` what's up.
- **Answers come in on the customer's own Join link** (`POST /public/join/<token>/poll`, `video_call.poll_answer`).
  The first answer to a question stands; one sent after closing gets "closed" back (a few seconds' grace for answers
  already on their way). Only someone in the call answers, as themselves: their seat is their contact.
- **Each person's answers are one form response on their contact** (`form_responses.video_call_id`, one per call,
  form and person), filled in as the questions come with the ordinary `form_answers`, so Results, the timeline and
  the record read them unchanged. When a stretch of the call ends, `video_call.polls_finish` (10 seconds later, for
  late answers) sends each sheet, so `form.submitted` starts the workflows on "Somebody answers a form".
- **Totals** go to the team's panel live (`video_call.polls`, read every 2 seconds while a question is up), and to
  everyone after closing only when the question says **Show everyone the totals when it closes**. What people typed
  and who pressed a button are the team's alone.
- **A button** (`type = 'button'`) is pressed as its answer (`true`). **Book** opens the calendar's booking page, a
  **link** opens its https page in a new tab, and **talk to someone** just tells the team.
- **A poll can't be filled in anywhere else:** it has no public page, the AI teammate can't ask it, the phone's Forms
  list leaves it out, and `form_response.*` refuses it (`form_is_poll`).

#### The AI asking (20261027019900)

Part 3 of the plan: the owner's 10, 12, 13 and 19.

- **It hears the team only.** The listener hands each finished line to `CallPollCues` (`poll-cues.ts`), which keeps
  the team's (`video_call_people.kind = 'team'`) and drops everyone else's, someone on stage included. So the AI
  asks only in a call it hears: AI notes on. The panel says so when they're off.
- **A quick model decides** (the calls' model, `voiceAi`, thinking off): the newest team line and the three before
  it, against the questions not asked yet, each with its kind, choices and **when-to-ask phrases** (`live.cues`). It
  answers sure, fairly or no, with a one-line reason. A call with no published poll, or the AI off, never reaches it,
  and neither does a line while a question is up, in the 20 seconds after one closed, or under a dozen letters. One
  question to the model at a time per call; its tokens go on the business's AI as `meetings`, and an empty budget or
  balance stops it for ten minutes.
- **Sure** pops the question up as the system (`video_call.poll_open`, `opened_by = 'ai'`), when the call's
  `poll_ai` is `ask`. Core holds the AI to it: `poll_ai_off`, `poll_question_open` (it never takes one down),
  `poll_too_soon` and `poll_skipped` (a question the team skipped is theirs), and the matcher lets a refusal go.
- **Fairly sure**, or sure while `poll_ai` is `suggest`, sends `{t: 'suggest'}` on `hfos.polls` to the team's
  identities only (LiveKit's `destinationIdentities`), at most once per question every two minutes. `PollOffer`
  shows **Ask now?** over the stage for 30 seconds, panel open or not; customers' pages ignore it anyway.
- **How far it goes** is `video_calls.poll_ai` (ask, suggest, off): from the calendar's `locations.webinar.pollAi`,
  changed in the panel (`video_call.set_poll_ai`).
- **A question whose moment passed** simply waits for the next time the team's words fit. In the last five minutes
  before the appointment's end, the panel lists those not asked yet with Ask now.
- **When-to-ask phrases** are written by the business, by the AI from the editor (**Write them for me** on a question,
  or for every question without any: `POST /v1/forms/ai/cues` on the worker, which saves nothing; the editor puts
  them in the draft as edits), or by the Assistant's form builder, which makes live polls with them.

## Running it locally

Without LiveKit the worker uses its stand-in: tickets connect to nothing and the call screen shows a stand-in for
the video, which is enough for the commands, getting in and the tests. To see real video, run LiveKit's server in
Docker as "Video calls: LiveKit" in `docs/operations.md` says, and give the worker its dev keys. The browser test
(`e2e/video-call.spec.ts`) runs only when the worker is on LiveKit, as it is in CI.

To hear calls too, run the listener beside the worker: `pnpm --filter @hfos/worker media`. With the stand-in speech
service (`VOICE_AGENT=fake`, the default on a laptop), anyone talking is heard as "Hello, can you hear me?", which is
enough to see captions and lines arrive. With `DEEPGRAM_API_KEY` and `VOICE_AGENT=deepgram` it hears the real words.

## Not yet

- From the phone app: sharing the phone's screen (Android's screen share service is taken out of the manifest),
  background blur, reactions and raising a hand. A hand raised on a computer still shows on the phone as a note.
- Bluetooth earbuds for a call on Android 12 and later, which needs the "Nearby devices" permission; the phone's
  speaker, earpiece and wired headphones work, and on an iPhone AirPods too, from its own picker.
- A call that keeps going with the phone app in the background, or locked.
- Starting a call from the Assistant. It can let people in, mute, remove and end a call as the call screen does,
  but **Video call** goes on to open the call for whoever pressed it, so for now it's only a button.
- Screen share from a phone's browser, which phones don't allow; they can watch someone else's.
- Joining by phone, recordings, breakout rooms and picture backgrounds.
- Slides inside HandsFreeOS (with the AI matching each question to its slide) and scoring who to follow up: parts 4
  and 5 of `HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md`. Live polls on the phone's call screen: the team asks from the web
  for now.
- Webinar controls on the phone: it shows who's presenting, but the camera choice and Bring on stage are on the web.
