# HandsFreeOS video calls (20261027013000, 20261027013300, 20261027013500)

HandsFreeOS's own Zoom-like calls. A calendar's Online place (or one service on it) can say **HandsFreeOS video
call**, and each appointment booked there gets its own call, with nothing for the business to connect. Customers
join from their own Join link in any browser, with no app and no sign-up; the team joins from the appointment. LiveKit
carries the video and sound.

Part 1, the call itself on the web, is built, and so is part 2, the AI hearing it: captions, "AI notes on", the
transcript on the appointment and today's After the call. So is part 3, the Sales Coach in the call: its cards beside
the video, and its write-up and score after. The phone app and calls that aren't for an appointment come next ("The
owner's decisions" and "Not yet" below). Support turns calls on per
business in /admin until every business gets them. Setting up LiveKit (the account, the worker's secrets and the
webhook) is "Video calls: LiveKit" in `docs/operations.md`.

## Where things are

| What                                        | Where                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Tables, the /admin switch and the rate line | `supabase/migrations/20261027013000_video_calls.sql`                                                             |
| Rules and words both apps share             | `packages/core/src/meetings/video-calls.ts` (`VIDEO_CALL_WORDS`, `effectiveVideo`, `videoCallLinkOpens`)         |
| Commands and the read                       | `packages/core/src/commands/video-call.ts`; the switch is `video-calls-switch.ts`                                |
| Where an appointment's call comes from      | `locationFor` in `packages/core/src/calendar/booking.ts`; the meeting job in `apps/worker/src/meetings/sync.ts`  |
| LiveKit, and the stand-in                   | `apps/worker/src/video-calls/livekit.ts`, `fake.ts`, behind `provider.ts`                                        |
| Tickets, the customer's Join, knocking      | `apps/worker/src/video-calls/routes.ts`                                                                          |
| LiveKit's webhooks, acted on                | `apps/worker/src/video-calls/reports.ts`; mute, remove and End for everyone in `handlers.ts`, from the events    |
| The customer's page                         | `/j/<code>` (`apps/web/src/components/booking/join-session.tsx`), then `components/video-call/customer-call.tsx` |
| The call's own link                         | `/call/<id>` (`apps/web/src/app/call/[callId]/page.tsx`, `components/video-call/link-call.tsx`)                  |
| The call screen                             | `apps/web/src/components/video-call/` (`call-room.tsx`, `call-stage.tsx`, `call-panels.tsx`, `pre-join.tsx`)     |
| Join and who joined, on the appointment     | `apps/web/src/components/calendar/video-call-block.tsx`                                                          |
| The Online place's choice                   | `LocationsModule` and `ServicesModule` in `apps/web/src/components/calendars/modules.tsx`                        |
| The switch in /admin                        | `apps/web/src/components/admin/video-calls-block.tsx`                                                            |
| The browser test                            | `apps/web/e2e/video-call.spec.ts`, on a real LiveKit server in CI                                                |
| What the AI heard, and the listener's list  | `supabase/migrations/20261027013300_video_call_words.sql` (`app.video_call_lines`, `video_calls_to_hear`)        |
| The listener                                | `apps/worker/src/media.ts` (the `media` process in `fly.toml`), `video-calls/listener.ts`                        |
| Hearing each person, captions, lines        | `apps/worker/src/video-calls/hearing.ts`; LiveKit's media library only in `listener-room.ts`                     |
| The transcript, once a stretch is over      | `video_call.keep_words` (core), queued by `onVideoCallEnded` in `apps/worker/src/video-calls/handlers.ts`        |
| The coach in the call                       | `apps/worker/src/video-calls/coach.ts` (`CallCoach`, `finishCoaching`); `video_call.coach` (core)                |
| The coach's cards beside the video          | `apps/web/src/components/video-call/call-coach.tsx` (the `call.panels` slot), placed by `call-room.tsx`          |

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
4. **The team joins** with **Join video call** on the appointment, which opens `/call/<id>` in a tab of its own.
   Someone signed in who can't see the appointment asks to be let in like anyone else.
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
  is no conversation. A call that isn't for an appointment keeps nothing yet (part 5).
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

## Running it locally

Without LiveKit the worker uses its stand-in: tickets connect to nothing and the call screen shows a stand-in for
the video, which is enough for the commands, getting in and the tests. To see real video, run LiveKit's server in
Docker as "Video calls: LiveKit" in `docs/operations.md` says, and give the worker its dev keys. The browser test
(`e2e/video-call.spec.ts`) runs only when the worker is on LiveKit, as it is in CI.

To hear calls too, run the listener beside the worker: `pnpm --filter @hfos/worker media`. With the stand-in speech
service (`VOICE_AGENT=fake`, the default on a laptop), anyone talking is heard as "Hello, can you hear me?", which is
enough to see captions and lines arrive. With `DEEPGRAM_API_KEY` and `VOICE_AGENT=deepgram` it hears the real words.

## Not yet

- The phone app's call screen (part 4). Until then the team's Join on the phone opens the call in the browser.
- Calls that aren't for an appointment (part 5).
- Screen share from a phone's browser, which phones don't allow; they can watch someone else's.
- Joining by phone, recordings, big sessions, breakout rooms and picture backgrounds.
