# Webinars with live polls the AI pops up

A business runs a webinar in its own HandsFreeOS video call: the presenter (and a few teammates) on camera, up to 500
people watching. Before it starts, the business makes a set of poll questions. During it, the AI hears the presenter
and pops each question up on everyone's screen at the right moment. Every answer lands on the attendee's contact, and
the answers decide who is worth following up with first.

It builds on the video calls (`docs/video-calls.md`), sessions-mode calendars (each seat its own Join link), Forms
(`docs/forms.md`) and the listener that already hears each person's microphone on its own.

**Where it stands (2026-10-30):** the owner answered the 26 questions; part 1, the webinar room, is built (migration
20261027019600, "Webinars" in `docs/video-calls.md`), and so is part 2, live polls (migrations 20261027019700 and
20261027019800, "Live polls" in `docs/video-calls.md`), part 3, the AI asking them (migration 20261027019900,
"The AI asking" there), part 4, slides (migration 20261027020000, "Slides" there), and part 5, who to follow up
with (migration 20261027020100, "Who to follow up with" there). All five parts are built, and so is scheduling
webinars (one date or repeating, with the Webinar calendar type), at the end.

## Decisions (the owner, 2026-10-29 23:15 UTC)

The questions, each with its choices, are in the Claude Doc "Live polls in video calls: questions". These are settled;
ask before going against one.

| #   | Answer                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A webinar room first** (presenter on camera, everyone else watching), then polls on top. Polls work in small calls too.                                                                                                                                                                                                                                                  |
| 2   | **Up to 500** at once, raised later if people need more. Each viewer's minutes are usage, like calls today.                                                                                                                                                                                                                                                                |
| 3   | **Every business**, part of video calls (core), not an add-on.                                                                                                                                                                                                                                                                                                             |
| 4   | **The presenter and up to 3 teammates** talk and are on camera. Attendees are muted and off camera, use chat, reactions and raise hand, and the presenter can bring one on stage. **The presenter chooses whether attendees may turn their cameras on, and whether only the team sees them or everyone does.** The presenter or the presentation is always the big screen. |
| 5   | **Both:** registration on the webinar's booking page (own Join link, reminders), plus a link anyone can use with a door form (name, email, phone). Either way each person is a contact.                                                                                                                                                                                    |
| 6   | **The notice** calls already show before joining, plus "Your answers are saved by [business]". Joining is agreeing.                                                                                                                                                                                                                                                        |
| 7   | **Replays later**, as their own part. No recording for now.                                                                                                                                                                                                                                                                                                                |
| 8   | **Polls are made in Forms**, a new "Live poll" kind, picked on the webinar.                                                                                                                                                                                                                                                                                                |
| 9   | Multiple choice, yes/no, a 1 to 10 rating, and a short typed answer.                                                                                                                                                                                                                                                                                                       |
| 10  | **Cue phrases** per question, written by the AI from the question and the slides, editable, matched by meaning.                                                                                                                                                                                                                                                            |
| 11  | **Both:** the AI drafts the questions and their points from the slides and a goal, or the business writes them.                                                                                                                                                                                                                                                            |
| 12  | **Pops up on its own when the AI is sure;** when it's only fairly sure, the presenter gets "Ask now?" and taps once.                                                                                                                                                                                                                                                       |
| 13  | The presenter and teammates on stage trigger polls; **never an attendee**.                                                                                                                                                                                                                                                                                                 |
| 14  | **A panel only the team sees:** the next question, Ask now, Skip, Close, answers coming in.                                                                                                                                                                                                                                                                                |
| 15  | **60 seconds by default**, per question; closes early once nearly everyone answered, or on Close.                                                                                                                                                                                                                                                                          |
| 16  | **Per question:** show the totals after it closes, or keep them private.                                                                                                                                                                                                                                                                                                   |
| 17  | **Pop-ups can be buttons too:** book a call, claim my spot, talk to someone, timed the same way.                                                                                                                                                                                                                                                                           |
| 18  | **Slides are presented from inside HandsFreeOS**, so the AI knows which slide is up; it listens too. No screen share needed.                                                                                                                                                                                                                                               |
| 19  | A question whose moment passed **waits for the next good one**; any still not asked show in the panel near the end.                                                                                                                                                                                                                                                        |
| 20  | **Everything saved on the contact:** each answer like a form answer, whether they came, how long they stayed, and the buttons they pressed.                                                                                                                                                                                                                                |
| 21  | **Points plus the AI's reason:** points per answer (the AI suggests them), for staying to the end and for pressing a button, and one line from the AI on why.                                                                                                                                                                                                              |
| 22  | **Hot, Warm or Cold** from the points; the business sets the lines.                                                                                                                                                                                                                                                                                                        |
| 23  | **The business picks** what happens to hot ones: a ranked list; the list plus the top of Home and a workflow from the label; or the AI texts every hot one within 5 minutes of the end. **The last is the default.**                                                                                                                                                       |
| 24  | **Registrants get messages to join.** Anyone who misses it completely is followed up, gets the replay once replays exist, and is asked to register for the next one when another is scheduled.                                                                                                                                                                             |
| 25  | **Five parts**, each usable on its own (below).                                                                                                                                                                                                                                                                                                                            |
| 26  | **It waits until it's built:** the owner's first webinar runs on it.                                                                                                                                                                                                                                                                                                       |

## Build order

1. **The webinar room.** A session's HandsFreeOS call becomes a webinar: up to 500 people, the presenter big, the
   camera choices, bringing someone on stage, the link anyone can use with its door form, the "starting now" message
   and the follow-up for anyone who missed it.
2. **Live polls.** "Live poll" forms; picking one on a webinar; Ask now from the team's panel; the pop-up on
   attendees' screens; answers saved on contacts as form answers; totals shown or kept private; button pop-ups.
3. **The AI pops them up.** Cue phrases; the listener hands the team's words to a matcher; sure means open it,
   fairly sure means "Ask now?" in the panel; questions whose moment passed wait.
4. **Slides inside HandsFreeOS.** Upload a PDF, present it from the call (the worker already draws PDF pages), the
   AI drafts questions, points, cues and the slide each fits.
5. **Who to follow up with.** Points, the AI's one line, Hot, Warm and Cold, the ranked list, the top of Home, a
   workflow from the label, and the AI texting hot ones (the default).

## Part 1: the webinar room

### What a webinar is

- **A HandsFreeOS call for a session is a webinar** (`app.video_calls.format = 'webinar'`). A session is an
  appointment of kind `session`, published on a sessions-mode calendar, where each person books a seat and gets their
  own Join link. A one-on-one booking's call stays a meeting (`'meeting'`), with up to 10 people as today. The format
  is set when the call is made and never changes.
- **Up to 500 people at once** (`WEBINAR_MAX_PEOPLE`), the listener aside. A sessions calendar already holds at most
  500 seats. The 501st is told it's full.

### Who does what in the room

- **The team** (anyone who joins with `video_call.join`) talks, shares a screen and is on camera, as today.
- **Attendees** (customers on their Join links, and anyone let in) are muted with cameras off. They watch, chat,
  react and raise a hand. Their tickets can't publish a microphone or a screen; a camera only when the presenter
  allows it.
- **On stage:** a teammate brings an attendee on stage (`video_call.stage`), which lets them use their microphone and
  camera until they're sent back (`on_stage`). The worker changes their permissions in LiveKit from the event.
- **The camera choice** (the owner's 4): `attendee_video` is `off` (default), `team` (attendees may turn their
  camera on, and only the team sees it) or `everyone` (everyone sees everyone). Its default comes from the calendar
  (`webinar.attendeeVideo`); the team changes it during the webinar (`video_call.set_attendee_video`), and the worker
  changes every attendee's permissions in LiveKit from the event. With `team`, each attendee's own page allows only
  the team's identities to receive their camera (LiveKit's track subscription permissions), so it's enforced by
  LiveKit, not just hidden.
- **The big screen** is always a shared screen when there is one, else whoever on stage spoke last (the first of the
  team in, until someone speaks). The rest of the team and anyone on stage sit beside it. Attendees'
  cameras, when anyone may see them, are a strip under it showing at most 12 at a time.
- **Names:** attendees' pages list only the team and how many are watching, never the other attendees. In the room an
  attendee's name starts as their first name; the team's screens read full names from `video_call.get`.

### Getting in

- **Registration** is the session's booking page, as today: each seat gets its own Join link and the calendar's
  reminders.
- **The link anyone can use** (the owner's 5c): every webinar has one, `/live/<key>` on the business's domain, shown
  on the session with Copy. Its page has the business's look, the webinar's title and time, and a door form (name,
  email, phone, and the texting consent the booking page asks for). Sending it books a seat on that session
  (`webinar.register`, which matches customers and keeps their boxes exactly as the booking page does) and then:
  before the start, "You're registered" with their own Join link; from an hour before to the end, straight into the
  call. Only a customer made from that form gets the link on the page; anyone already on file is sent theirs, so
  nobody gets in as someone else by typing their details. A full or cancelled session says so, and one that asks
  for payment points to the booking page.
- **The notice** (the owner's 6): the page before joining says AI takes notes when it does, as today.

### The messages (the owner's 24)

- **Starting now.** At the start, everyone booked who isn't in the call yet gets a text (else an email) with their own
  Join link: "[Title] is starting now. Join here: …". On by default (`webinar.startingNow`).
- **Missed it.** When the session's attendance is closed and someone is marked a no-show, they get one message: if
  the same calendar has a later session with seats, "Sorry we missed you at [Title]. The next one is [when]. Save
  your seat: [its link anyone can use]"; otherwise "We'll let you know when there's another one." On by default
  (`webinar.missedFollowUp`). Workflows on "Somebody missed a session" still start for anything more. The replay joins
  this message once replays exist.
- Both go through `message.send`, so quiet hours, STOP and the conversation work as for any message.

### The pieces

- **Migration:** `app.video_calls` gains `format`, `attendee_video` and `door_key`; `app.video_call_people` gains
  `on_stage`. Existing calls for sessions become webinars.
- **Core:** `meetings/video-calls.ts` (formats, sizes, words, `maxPeopleOf`, what an attendee may publish), the
  calendar's `webinar` settings, `video_call.set_attendee_video`, `video_call.stage`, the door's booking.
- **Worker:** tickets with per-person publish rights and the room size, permission updates from the events, the
  `/live/` routes, the starting-now job and the missed-it message.
- **Web:** the webinar stage and the team's controls (camera choice, On stage, how many are watching), the `/live/`
  page, the calendar's Webinar settings and the session's link anyone can use.
- **Phone:** the team's call screen shows the stage only (team and anyone on stage) in a webinar.
- **The Assistant** covers the new commands and settings (`assistant-coverage.test.ts`).

## Part 2: live polls

- **A form's `mode` gains `poll`.** Its questions are limited to multiple choice, yes/no, a 1 to 10 rating and a short
  typed answer. Each question has `seconds` (default 60) and `showResults`. A poll can also hold button items (book a
  call, a link such as Claim my spot, talk to someone).
- **A webinar picks a poll** (`video_calls.poll_form_id`, defaulting from the session's calendar).
- **Opening one** (`video_call.poll_open`, the team's): a row in `app.video_call_polls` (the call, the question, opened
  by a person or the AI, when it closes). The worker sends it to the room on its own data topic; attendees' pages show
  the pop-up. It closes at its time, once nearly everyone answered, or on Close.
- **Answering:** the attendee's page posts to the worker on their own Join link; one answer per person per question.
  Each person's answers are one form response on their contact, filled in as the questions come, so the timeline,
  the workflows on form answers and the record all work unchanged.
- **Totals** go to the team live, and to everyone after closing when the question says so.

## Part 3: the AI pops them up

- **Cue phrases** per question (`cues`), written by the AI when the poll is saved, editable.
- **The listener hands each finished line from the team** to a matcher in the media process (the owner's 13: never
  an attendee, even one brought on stage). It compares the last few lines with the questions not yet asked. Sure: it
  opens the question (as the AI). Fairly sure: it sends "Ask now?" to the team alone. The call's `poll_ai` (ask,
  suggest, off; from the calendar) says how far it goes.
- **Waiting:** a question whose moment passed stays queued; in the last few minutes the panel lists those not asked.

## Part 4: slides inside HandsFreeOS

- **Upload a PDF** to the webinar (PowerPoint and Keynote save as one). The worker draws its pages (as for documents).
- **Present it from the call:** the presenter's arrows move the slide; the room is told which slide is up; attendees'
  big screen shows it. No screen share.
- **The AI reads the slides** and gives each question the slide it fits and its cues (built). A question near its
  slide is likelier to pop up, still on the presenter's words, and its slide coming up offers it to the team.
- **The AI drafts the poll** from what the webinar is for and its slides (built with part 5, the owner's 11): the
  questions and a closing button, each with its points, cues and slide, as edits in the draft to read and change.

## Part 5: who to follow up with

- **Points** per answer (the AI suggests, the business changes), for staying to the end, and for pressing a button.
- **The AI's one line** on why, written after the webinar from the answers and what was said to them.
- **Hot, Warm or Cold** from the points, with the lines set on the poll.
- **What happens to hot ones** is the business's choice per poll: the ranked list; the list plus the top of Home and
  a workflow from the label; or the AI texts every hot one within 5 minutes of the end (the default), which waits for
  a person's OK while the AI teammate is on Training wheels.
- **Built** (migration 20261027020100): scored once the call's answers are sent; a card on Home (`webinar_hot`) for a
  hot one the poll puts there or the AI teammate couldn't text; the trigger **Somebody is rated after a webinar**
  whatever the choice; the line on their timeline; and the ranked list on the webinar's appointment. "Who to follow up
  with" in `docs/video-calls.md` has the details.

## Afterwards: scheduling webinars (the owner, 2026-10-30 13:58 UTC)

"Need a webinar calendar type this way we can add scheduled recurring webinars or a single webinar. Should be able to
create a webinar without a webinar calendar and then that creates the webinar calendar at the same time."

- **The Webinar calendar type** (preset `webinar`): Fixed sessions on a HandsFreeOS video call, 500 seats, a
  waitlist, one hour, staff repeats up to 52.
- **New webinar** on the Calendar page (`webinar.schedule`): one date, or every week, every 2 weeks or every month on
  the same weekday. With no webinar calendar, it makes "Webinars" and turns it on.
- **Built** with no migration. "Scheduling a webinar" in `docs/video-calls.md` has the details. Still to come: the
  same on the phone app.
