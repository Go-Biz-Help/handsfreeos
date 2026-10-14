# AI Sales Coach — phone calls, texts and Zoom

AI Sales Coach (`salescoach`) coaches a business's people while they sell. It works in three places:

- **On a phone call**, it listens as the customer talks and shows the rep, on screen, what to say next, how to
  answer an objection, and the facts the customer just asked about.
- **In a written conversation** (a text, Messenger, Instagram, the website chat or an email), it shows two or three
  good replies above the message box. One tap puts a reply in the box to edit, and nothing sends on its own.
- **On a Zoom call**, the same coaching shows in a HandsFreeOS panel inside Zoom.

After each call, meeting or conversation it writes the notes, a summary and a follow-up draft onto the customer's
timeline, turns what the rep promised into tasks, and scores the call against the business's script.

It was two planned add-ons, AI Sales Coach and Live Sales Assist (`salesassist`). They're one add-on now, built
under the planned id `salescoach`.

**Where it stands (2026-10-14):** rounds 0 and 1 are built, in `development` (staff hand it to test businesses), with
the differences from this plan noted under "What changed while building". `docs/salescoach.md` is the guide for working
on it. Rounds 2 to 4 are next.

## Decisions (Chris, 2026-10-14)

| Question                          | Answer                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales Coach and Live Sales Assist | **One add-on**, `salescoach`. Live Sales Assist comes off the vote list, its votes count for Sales Coach, and its id is never reused.                                                                                                        |
| What's built first                | **Phone calls and written conversations**, then Zoom. They already run inside HandsFreeOS, so they don't wait on Zoom's review. The Zoom app is registered at the start so the review clock starts.                                          |
| Who gets it                       | **Businesses with the add-on on.** Reply suggestions are part of the add-on, not core.                                                                                                                                                       |
| Which calls                       | **Every kind:** calls in the web app, calls on a cell (forwarded, or placed from the phone app), and Zoom meetings.                                                                                                                          |
| When it listens                   | **Every answered call, on its own.** The rep can stop it for that call.                                                                                                                                                                      |
| The phone app during a cell call  | **Both:** a live coaching screen in the app (the rep goes on speaker and opens it; a notification at the call's start takes them there), and a push for big moments only, like an objection.                                                 |
| Reply suggestions                 | **Two or three choices above the message box**, on texts (SMS and RCS), Messenger, Instagram, the website chat and email. A tap puts one in the box to edit. Nothing sends on its own.                                                       |
| The AI teammate                   | **Unchanged.** While the teammate handles a conversation it keeps drafting as it does today. The coach suggests only when a person is replying.                                                                                              |
| Where scripts come from           | **The AI drafts them** from the business's services, prices and knowledge base; **owners upload their own** script, which the AI splits into steps and objections; and **it learns from wins**, suggesting answers that worked as new lines. |
| What counts as a win              | **Any of:** a job booked within a few days, an estimate accepted, a payment, or a Pipeline deal marked won.                                                                                                                                  |
| After every call or conversation  | **All four:** notes and a summary on the customer's timeline, a follow-up text or email draft the rep sends, tasks from what the rep promised ("I'll send the quote Friday"), and a score against the script.                                |
| Who sees scores and history       | **The rep, owners and admins.** Owners can give the permission (`salescoach.review`) to anyone else, like a sales manager.                                                                                                                   |
| Listening on Zoom                 | **Zoom's own Realtime Media Streams**, through a HandsFreeOS Zoom App. No bot joins the meeting.                                                                                                                                             |
| Consent                           | **The current notice is enough.** "This call may be recorded." stays on by default; the coach doesn't listen on a number whose notice the business turned off. Zoom shows its own notice that an app is using the meeting.                   |
| What's kept                       | **Transcripts, notes and scores.** Phone calls' recordings are kept as they are today; Zoom audio isn't kept.                                                                                                                                |
| Language                          | **English first, Spanish next.**                                                                                                                                                                                                             |
| Price, once add-on billing exists | **A flat monthly price per business, plus usage** (coached minutes) from the wallet. Until then staff hand it out free in `beta`, and usage is counted.                                                                                      |

## How it fits HandsFreeOS's rules

- **Providers talk to the worker.** Twilio's live audio, Zoom's sign-in, webhooks and media streams, and Deepgram
  all meet the worker. Zoom's secrets live only in the worker's environment.
- **The web talks to Supabase Auth and the API.** Cards reach the web, the Zoom panel and the phone app through an
  API stream, checked like any query, never from the worker directly.
- **Every change is a command.** The worker writes cards, suggestions, notes, tasks and scores through
  `salescoach.*` commands, as the system acting for the add-on.
- **Records first.** A coached call or conversation is a record of kind `coached_call`, tied to the customer, so
  the timeline, tasks and search work on it unchanged. Playbooks are records too. The add-on's own tables
  (`addon_salescoach`) hold only the live cards and suggestions, which are short-lived.
- **Core never points into the add-on.** Core gives any add-on a way to hear a call live and to put panels beside
  the call bar and above the message box. The add-on uses them; core doesn't know it's there.
- **The AI asks first for anything that goes out.** Suggestions and follow-up drafts are only put in the box. A
  follow-up sent by the Assistant is risk 2 and waits for the rep's OK.

## Round 0: what core builds first

1. **Hearing a person's call live.** Today only the AI teammate's calls are streamed; a person's call is recorded
   and transcribed after it ends. When an add-on that listens is on, the TwiML for an answered call (browser,
   forwarded phone, and the phone app's cell calls) adds a one-way `<Start><Stream>` to the worker with both sides,
   carrying a sealed ticket like the AI teammate's stream does. The worker transcribes it live with Deepgram (as the
   voice agent already does), tells the two sides apart, and hands the words to each running add-on's worker half
   that declared it listens. A call it heard live keeps that transcript, so it isn't transcribed a second time.
2. **A live stream from the API.** A server-sent-events stream for a person's live cards, by permission, so the
   web, the Zoom panel and the phone app all get cards within a second or two.
3. **Two new add-on slots.** `call.panels` beside the web's active call bar, and `composer.suggestions` above the
   inbox's message box. Each is loaded only while its add-on runs, in its own error boundary, like the others.
4. **The phone app's live screen and a push category** for a call moment, in `push.ts`, with its own switch.
5. **Zoom's pieces**, built when round 3 starts:
   - **A person's own add-on connection.** A Zoom sign-in belongs to one rep, like a mailbox. `app.addon_connections`
     gets a `user_id` (null for the business's own), with row security so a rep sees only theirs.
   - **One Zoom webhook address.** Zoom sends every event for every rep to one address, so the per-connection
     `/webhooks/addon/<token>` doesn't fit. The worker gets `/webhooks/zoom`: Zoom's URL check, its signature check,
     then each delivery kept once and handed to the add-on whose connection holds that Zoom user.
   - **Zoom's page headers** on the panel's route only, which Zoom requires before it opens an app page.

### What changed while building rounds 0 and 1

- **The stream starts when the call is answered**, through Twilio's REST API (`startCallStream`) on the new
  `call.answered` event, rather than a `<Start><Stream>` in the TwiML. Only answered calls are heard (no ringing), and
  the worker knows who on the team is on the call before it listens.
- **No new API stream.** HandsFreeOS already broadcasts every event's ids to a business's open screens (Supabase
  Realtime), and the web reads what changed through the API. A new card is an event (`salescoach.card.added`), so the
  rep's screen reads the cards again within a second. The phone asks every 3 seconds while its live screen is open.
- **The live transcript doesn't replace the after-call one yet**, so a coached call is transcribed twice for now.
- **The push about an objection is an add-on notice**, under the `addons` switch, not a category of its own yet.
- **A coached call is the add-on's own row about core's call**, not a record of its own kind: core's call is already
  the record on the customer's timeline, and the add-on adds its notes there as a timeline line, and the promises as
  tasks. The write-up stays private to the rep and the people who review (`salescoach.review`).
- **`composer.suggestions` waits for round 2**, which uses it.
- **Stopping the coach for one call** stops the cards and keeps nothing, but the worker still hears the call to its
  end until core can end one add-on's listening mid-call.

## Round 1: the add-on, on phone calls

- Started with `pnpm addon:new salescoach …`, in `development`. Live Sales Assist comes off `planned.ts`.
- **Playbooks.** Settings → Sales Coach: one per kind of call (first call, estimate review, follow-up), each with
  script steps, objections and the business's answers, and talking points. The AI drafts the first from what
  HandsFreeOS knows about the business; an owner can upload their own script instead.
- **Live call coaching.** Beside the call bar: the script step the rep is on and what to say next; an objection card
  when the customer raises one; a facts card when they ask about a service, price or opening the knowledge base
  answers (never made up); and talk time. The rep can stop it for the call. Aim: a card within 2 seconds of the
  customer finishing.
- **The phone app.** The live screen during a cell call, and a push only for an objection.
- **After the call.** Notes, summary, follow-up draft, tasks and score on the customer's timeline.

## Round 2: written conversations

- **Reply suggestions** above the message box, on every channel listed above, whenever a customer writes and a
  person (not the AI teammate) is handling the conversation. They follow the business's tone and words to use and
  avoid, and the playbook's answers when the customer raises an objection.
- **After a conversation goes quiet**, the same notes, tasks and score as a call.

## Round 3: Zoom

- The HandsFreeOS Zoom App: a user-managed General app with an in-meeting surface, Realtime Media Streams, and the
  audio and transcript scopes. Each rep signs in to their own Zoom once.
- In a meeting the rep opens HandsFreeOS in Zoom's Apps panel; coaching starts on its own (`startRTMS()`), and they
  can stop it. The same panel opens in a browser tab at `/app/w/<business>/a/salescoach/live` for a second screen.
- The customer is found by the participants' email, or the rep picks them.
- Zoom reviews the app before anyone outside Go Biz Help's Zoom account can add it. It needs the privacy policy, a
  test login and a demo video, and takes weeks, so it's submitted as soon as round 3 works.

## Round 4: learning and coaching over time

- **Learning from wins.** Calls and conversations that end in a win are compared with those that don't, and
  answers that worked are offered to the owner as new playbook lines ("this answer to price closed 6 of 9").
- **Trends.** A rep's talk time, objections won and steps skipped over time; the owner's view of every rep.
- **Spanish** calls and conversations.

## What HandsFreeOS needs from outside

- **Zoom:** a developer account under Go Biz Help, the app registered at the start, and Zoom credits for Realtime
  Media Streams. Whether they work when the host is on Zoom's free plan or the web client isn't in Zoom's docs;
  round 3 checks.
- **Worker settings:** Zoom's client id and secret, and its webhook secret token. `docs/operations.md` gets a
  "Zoom" section saying where each comes from.
- **Deepgram:** live minutes on every coached call. Calls heard live aren't transcribed again afterwards, so the
  extra cost is the difference between live and after-call rates.

Zoom sources: developers.zoom.us/docs/rtms/meetings/, …/getting-started/, …/add-features/, and the Realtime Media
Streams changelog of June 25, 2025.
