# HandsFreeOS video calls (20261027013000)

HandsFreeOS's own Zoom-like calls. A calendar's Online place (or one service on it) can say **HandsFreeOS video
call**, and each appointment booked there gets its own call, with nothing for the business to connect. Customers
join from their own Join link in any browser, with no app and no sign-up; the team joins from the appointment. LiveKit
carries the video and sound.

Part 1, the call itself on the web, is built. The AI hearing the call, the Sales Coach in it, the phone app and calls
that aren't for an appointment come next ("The owner's decisions" and "Not yet" below). Support turns calls on per
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
6. **After.** The appointment lists who joined and for how long, a customer's attendance is marked from whether they
   were really in, and everyone's minutes go on the business's balance as one line, `video.minute`.

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

## Running it locally

Without LiveKit the worker uses its stand-in: tickets connect to nothing and the call screen shows a stand-in for
the video, which is enough for the commands, getting in and the tests. To see real video, run LiveKit's server in
Docker as "Video calls: LiveKit" in `docs/operations.md` says, and give the worker its dev keys. The browser test
(`e2e/video-call.spec.ts`) runs only when the worker is on LiveKit, as it is in CI.

## Not yet

- The AI hearing the call, captions and the notice (part 2), and the Sales Coach in the call (part 3).
- The phone app's call screen (part 4). Until then the team's Join on the phone opens the call in the browser.
- Calls that aren't for an appointment (part 5).
- Screen share from a phone's browser, which phones don't allow; they can watch someone else's.
- Joining by phone, recordings, big sessions, breakout rooms and picture backgrounds.
