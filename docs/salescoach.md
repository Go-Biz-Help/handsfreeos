# AI Sales Coach

AI Sales Coach (`salescoach`) coaches a business's people while they sell. While someone on the team is on a phone
call, in a Zoom meeting or in a HandsFreeOS video call, it listens and shows them, from the business's own playbook,
what to say next, the answer to an objection and the facts the customer just asked about. After the call it writes
the notes, a follow-up to send, a task for each thing the rep promised, and a score. The decisions and the rounds still to come are in
`HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md`; this guide is for working on what's built.

**Where it stands (2026-10-31):** rounds 0 to 4 are built, in `development` (staff hand it to test businesses):
core's live listening, phone calls, written conversations (suggested replies, and a write-up once one goes quiet),
Zoom meetings, lessons from wins, trends with the owner's view of every rep, and Spanish. Round 5, selling the
question-led way, has two of its three parts built: the method and the script builder, then live coaching and the
score by stage (see "The question-led method"). Zoom
meetings use their own Zoom app, set up as in "The coaching Zoom app" in `docs/calendar-setup.md`, and need Zoom's
review before anyone outside Go Biz Help's Zoom account can add it.

## Where things are

| What                                      | Where                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest, words, playbook rules (pure)    | `packages/core/src/addons/salescoach/` (`manifest.ts`, `words.ts`, `playbooks.ts`)                                                                                                                                                                                                                                                                                                                                                 |
| The question-led method (pure)            | `packages/core/src/addons/salescoach/method.ts` (stages, openings, rules, the builder's questions, which script a call opens with); the worker's `draft.ts` (`salescoach.playbook.brief`, `salescoach.playbook.draft`); the web's `script-builder.tsx`                                                                                                                                                                             |
| Trends and the owner's view               | `packages/core/src/addons/salescoach/trends.ts` (the math, pure), `ops/trends.ts` (`salescoach.trends`); the web's `trends-view.tsx` (`?view=trends`)                                                                                                                                                                                                                                                                              |
| Learning from wins                        | `packages/core/src/addons/salescoach/learn.ts`, `ops/learning.ts`; the worker's `learn.ts`; the web's `lessons-view.tsx`                                                                                                                                                                                                                                                                                                           |
| A quiet conversation's write-up           | the worker's `quiet.ts`; `salescoach.conversation.finish` in `ops/calls.ts`                                                                                                                                                                                                                                                                                                                                                        |
| Suggested replies (what's asked, checks)  | `packages/core/src/addons/salescoach/suggest.ts`, `ops/suggestions.ts`; the worker's `suggest.ts`; the web's `composer-suggestions.tsx`                                                                                                                                                                                                                                                                                            |
| What the AI is asked, its checks, scoring | `packages/core/src/addons/salescoach/coach.ts`                                                                                                                                                                                                                                                                                                                                                                                     |
| Commands and queries                      | `packages/core/src/addons/salescoach/ops/` (`playbooks.ts`, `calls.ts`), its tables' mirror in `tables.ts`                                                                                                                                                                                                                                                                                                                         |
| Hearing a Zoom meeting live (core)        | `packages/core/src/commands/live-meeting.ts` (`live_meeting.claim`), `apps/worker/src/meetings/live.ts` (`RtmsStream`, `ZoomLiveSession`), `zoom-live.ts` (the coaching Zoom app), `live-routes.ts` (its sign-in, link and webhook)                                                                                                                                                                                                |
| Hearing a HandsFreeOS video call live     | core's `video_call.coach`, `apps/worker/src/video-calls/coach.ts`; the cards beside the video in the web's `components/video-call/call-coach.tsx` (docs/video-calls.md, part 3)                                                                                                                                                                                                                                                    |
| The Zoom panel                            | the web's `zoom-panel.tsx` (`?view=zoom`), `app/zoom/page.tsx` (where the Zoom app starts), `app/zoom/connect/` (linking Zoom), `components/settings/zoom-coach-card.tsx`, `lib/zoom-app.ts` (Zoom's required headers)                                                                                                                                                                                                             |
| Hearing a person's call live (core)       | `apps/worker/src/telephony/live.ts` (`onCallAnswered`, `LiveCallSession`), `apps/worker/src/http/live-calls.ts` (the socket)                                                                                                                                                                                                                                                                                                       |
| The add-on's worker half                  | `apps/worker/src/addons/salescoach/` (`live.ts`, `after-call.ts`, `draft.ts`, `business.ts`)                                                                                                                                                                                                                                                                                                                                       |
| The stand-in model's answers              | `SALESCOACH_RULES` in `apps/worker/src/ai/scripted.ts`                                                                                                                                                                                                                                                                                                                                                                             |
| Web                                       | `apps/web/src/addons/salescoach/`; its page `app/app/w/[workspaceId]/a/salescoach/`; the call bar's slot in `active-call-bar.tsx`                                                                                                                                                                                                                                                                                                  |
| Phone                                     | `apps/mobile/src/addons/salescoach/`; its route under `(more)/a/salescoach/`                                                                                                                                                                                                                                                                                                                                                       |
| Database                                  | `supabase/migrations/20261027004500_addon_salescoach.sql`, `20261027004600_salescoach_suggestions.sql`, `20261027004700_salescoach_conversations.sql`, `20261027004800_salescoach_learning.sql`, core's `20261027004900_live_meetings.sql`, `20261027005000_salescoach_zoom.sql`, core's `20261027005100_live_meeting_accounts.sql`, `20261027021300_salescoach_call_kinds.sql`, `20261027021400_salescoach_coaching_by_stage.sql` |
| Tests                                     | `packages/core/test/addons/salescoach*.test.ts`; `apps/worker/test/salescoach-live.test.ts`, `salescoach-draft.test.ts`, `salescoach-suggest.test.ts`, `salescoach-learn.test.ts`, `salescoach-zoom.test.ts`                                                                                                                                                                                                                       |

## The question-led method

Sales Coach sells by asking (Chris, 2026-10-31, from the owner's sales training). The rep asks more than they tell:
calm, curious questions let the customer say what they have now, what's wrong with it, what they want instead, what
waiting would cost and how much it matters, in their own words. Only then does the rep show how the business fixes
the problems the customer named, and ask whether it feels right. `method.ts` holds it once, for the screens and every
prompt.

1. **The stages** (`SALES_STAGES`), in order: Connect, Their situation, The problem, What they want, If nothing
   changes, How much it matters, Bridge, Show how, Ask for a yes. Each has a line on what it's for
   (`SALES_STAGE_ABOUT`). A script step names its stage (`PlaybookStep.stage`, in `details`, so no column) and may
   say how to say it (`tip`: "Slow down"). A step from before stages, or from a pasted script that fits none, has
   `null`.
2. **The kinds of call** the builder writes (`BUILDER_KINDS`): a new lead who asked to be called, a booked call, an
   older lead and a cold call, each with its own opening (`CALL_OPENINGS`); the rest of the call is the same stages.
   The kinds from before (first call, estimate, follow-up, any) stay, with openings of their own. The table's check
   widened in `20261027021300_salescoach_call_kinds.sql`.
3. **The builder** (Playbooks → **Build my scripts**). `salescoach.playbook.brief` has the AI answer what it can of
   six questions (`SALES_BRIEF_QUESTIONS`: what you sell, who buys, their usual problems, the result they want, why
   people pick you, the next step) from the business's profile and knowledge, blank where they don't say. The owner
   fills in or fixes them ("Tell us" marks the blank ones), ticks the kinds of call, and `salescoach.playbook.draft`
   writes one script for each with those answers (`brief`). Each opens in the editor to check and save, one after
   another; nothing is saved until then. The answers aren't kept: the next build asks the AI again.
4. **Its own script** (Playbooks → **Use my own script**). A pasted script is kept in its words and the coach
   follows it as written; its steps get the stages they fit.
5. **Objections** are answered the same way (`OBJECTION_RULES`): clarify what they mean, talk it over together, then
   let them solve it with a question; "send me some information", "just send a quote", "call me back" and "I need to
   think it over" turn into a set time to talk again.
6. **Which script a call opens with** (part 2, `callKindFor`). `salescoach.call.begin` reads how the call started
   from core's records (`callStart`): a HandsFreeOS video call or Zoom meeting, or a call with a customer whose
   appointment starts within half an hour, is a booked call. A call the rep made is a new lead when the customer's
   newest open lead is 14 days old or less (`NEW_LEAD_DAYS`), an older lead past that, and a cold call when nobody
   on file is on it. A call the customer made, or to a customer with no open lead, gets the usual script. The
   business's script of that kind (the usual one first, then the oldest) is used when it has one; otherwise the
   usual script, as before.
7. **Coaching live by stage** (part 2). The coach's instructions (`COACH_SYSTEM`) carry the method's rules, the
   stages and the objection rules. A card can be the next question for the stage the call is in, built from the
   customer's own words (the playbook's [brackets] filled in), and carries a `tip` on how to say it ("Slow down,
   sound concerned"), from the step's own tip when it has one. A **nudge** (card kind `nudge`) says kindly when the
   rep strays: the offer or price before the customer said their problem, doing most of the talking, two questions
   at once, telling instead of asking, pushing or skipping a stage, with the question to ask instead. The worker
   shows a nudge at most once for the same thing and not within 90 seconds of the last (`nudgeAllowed`). Screens
   show a **stage bar** for a script whose steps name stages: the stages it goes through (`playbookStages`), the one
   the call is in (`stageAt`: the step's own, or the one before for a step without one), and the step. The card's
   tip column and the `nudge` kind came in `20261027021400_salescoach_coaching_by_stage.sql`.
8. **The score by stage** (part 2). For a script whose steps name stages, `scoreCall` counts stages, not steps: a
   stage is done once any of its steps was, and that half of the score is the stages done over the stages the
   script names. The write-up says whether the rep showed the offer or price before the customer said their
   problem (`pitchedEarly`); then that half keeps three quarters (`PITCHED_EARLY_KEEPS`). `score.stages` keeps the
   stages done and skipped and the flag, and the write-up shows them, with a tip naming the first stage skipped and
   the question to ask there. A script without stages is scored by step, as before, and older write-ups have no
   `stages`.

## How a coached call goes

1. **Answered.** `call.update_status` emits `call.answered` the moment a call is first answered: in a browser, on a
   forwarding phone after its "press 1", or by the customer on a call the team placed (from a browser or through
   someone's own cell). Its payload names who on the team is on it (`teamUserId`) when that's known.
2. **Who listens.** The worker's `onCallAnswered` asks which add-ons hear it (`liveListenersFor`): those whose manifest
   says `liveCalls`, whose worker half has `liveCalls` hooks, that run in the business, where the person on the call
   holds the permission the manifest names. Nothing listens on a number whose callers aren't told the call may be
   recorded (`routing.announceRecording`), nor when nobody on the team is known to be on it. A forwarding phone
   counts when it's someone's own verified cell.
3. **The stream.** It asks Twilio to send the call's audio to `wss://<worker>/webhooks/twilio/voice/live`, both sides,
   with a sealed ticket naming the business, the call, the person and the add-ons (`startCallStream`, Twilio's
   Streams resource). Nothing about the call changes: it's still recorded and transcribed afterwards as before.
4. **Hearing it.** `LiveCallSession` opens one `listen` per side on the speech service the AI teammate uses (Deepgram,
   or the stand-in), and hands each finished line to each add-on in order, as the system acting for it. Twilio's
   `inbound` track is the party whose call it is: the customer on a call they made, the rep on one the team placed.
   Listening is billed as live speech, both sides.
5. **Coaching.** Sales Coach starts the coached call with the script for how it started, else the usual playbook
   (`salescoach.call.begin`, "Which script a call opens with" above). When the
   customer finishes something worth answering (`cardMoment`: three words or more, at most every four seconds, one
   ask at a time), the fast model reads the playbook, the business's brief and short knowledge answers, and the last
   few minutes, and says which script step the call is at and whether there's a card. `checkedCard` holds it to the
   playbook; `salescoach.card.add` keeps it and emits `salescoach.card.added`, whose live update makes the rep's
   screen read the cards again. An objection is pushed to the rep's phone too.
6. **After.** When the stream stops, `salescoach.call.end` keeps what was said and the `salescoach.after_call` job asks
   for the write-up. `checkedAfterCall` holds it to the limits and works out the score; `salescoach.call.finish` puts
   the summary and notes on the customer's timeline and makes a task for each promise, assigned to the rep.

## Suggested replies in a written conversation

1. **A customer writes** (`message.received`: a text, Messenger, Instagram, the website chat, the portal or an email).
   The add-on's subscriber queues one `salescoach.suggest` job for the conversation two seconds later
   (`SUGGEST_AFTER_MS`), deduplicated, so a burst of messages gets one set.
2. **The job reads the conversation as it is then.** Nothing while the AI teammate answers it (`handled_by = 'ai'`: it
   drafts its own, the owner's decision), for a person's own mail (`private_to`), outside the Inbox, or when the newest
   message isn't the customer's (someone already replied).
3. **The fast model** reads the usual playbook, the business's brief and short knowledge answers, and the latest 12
   messages, and suggests two or three different replies. `checkedSuggestions` holds them to the channel's length
   (`SUGGEST_CHARS`: a text stays under 320 characters), drops repeats, keeps three at most, and names a playbook
   objection only when it's there.
4. **`salescoach.suggestions.put`** keeps them for the customer's newest message only, one set per conversation, and
   emits `salescoach.suggestions.ready` as a conversation event (the live updates say no more than that, as for any
   conversation's), so a screen with the conversation open reads them again.
5. **The web** draws them above the message box (`composer.suggestions`, on the desktop inbox and the phone-sized
   web). A click puts the words in the box to edit; nothing is sent from here. `salescoach.suggestions` stops
   answering them once anyone writes after the customer's message.

## A written conversation's write-up

1. **Queued when a customer writes**, beside the suggestions: one `salescoach.conversation_quiet` job per conversation,
   a quiet spell later (`QUIET_MS`, three hours).
2. **Still going?** The job reads what was said since the conversation's last write-up. If anyone wrote within the
   quiet spell, it runs again three hours after the newest message.
3. **Whose it is.** Only when someone on the team took part (a message with a person as its sender; the AI
   teammate's have none), and that person (the latest to write) holds `salescoach.use`. Never a person's own mail, nor
   what isn't in the Inbox.
4. **The write-up** is a call's (`afterCallPrompt` with `kind: 'conversation'`): the follow-up is a gentle nudge, and
   the score is worked out the same way. `salescoach.conversation.finish` keeps it as a coached record of the
   conversation (`calls.conversation_id`, once per stretch, ending at `through_message_id`), puts the summary and notes
   on the customer's timeline and makes a task for the rep for each promise. The Coached tab lists it beside the calls,
   with its channel.

## A coached Zoom meeting

0. **Adding the app.** Coaching in Zoom uses its own Zoom app, "HandsFreeOS Sales Coach", apart from the one that
   makes meeting links (Chris, 2026-10-14). A rep adds it from Zoom's App Marketplace, or presses **Connect Zoom** in
   HandsFreeOS (Settings → My calendar, or the Zoom panel). Zoom signs them in, then `/zoom/connect` asks them to
   sign in to HandsFreeOS and pick the business, and the worker links the Zoom user to them there
   (`live_meeting_account.link`, `app.live_meeting_accounts`). That's how HandsFreeOS knows they're an active person
   here. No Zoom token is kept.
1. **Opening it.** In a Zoom meeting, the rep opens HandsFreeOS from Zoom's **Apps** button. Zoom loads `/zoom` (the
   Zoom app's Home URL) in its own browser; signed out, it goes through sign-in first (a password or an emailed code;
   Google's sign-in doesn't open inside Zoom). `/zoom` opens the page of an add-on whose manifest says
   `liveCalls.zoom`, in a business where it runs and the rep holds its permission: Sales Coach's `?view=zoom`. With
   more than one business, the rep picks.
2. **Claiming it.** The panel (`zoom-panel.tsx`) reads the meeting and the rep through Zoom's app SDK
   (`@zoom/appssdk`: `getMeetingUUID`, `getMeetingContext`, `getUserContext`) and claims the meeting
   (`live_meeting.claim`, core). That needs an add-on that listens, and the rep's Zoom linked through the coaching app,
   which is how the worker knows the stream came from them; without it the panel offers Connect Zoom, which opens
   the sign-in in the computer's browser. It finds the customer from the appointment
   HandsFreeOS made the meeting for (its first attendee); otherwise the rep picks one, or coaches without one.
3. **The stream.** With a customer known, the panel asks Zoom to start the meeting's Realtime Media Stream
   (`startRTMS`) at once; otherwise after the rep picks. Zoom shows everyone that an app is listening. Zoom then calls
   the coaching app's `/webhooks/zoom-live` with `meeting.rtms_started`; the worker takes the newest waiting claim on
   that meeting whose rep's linked Zoom account started it (Zoom's `operator_id`), and opens `ZoomLiveSession`.
   **Zoom's auto-start** (the app set to start as its person joins) sends the stream before the panel has claimed
   anything. Then the worker claims the meeting for the Zoom user who started it, when they're linked here and an
   add-on listens for them (`live_meeting.auto_claim`, in the business they linked most recently), and coaches it
   without a customer, telling the rep's words by their name in HandsFreeOS. Opening the panel finds that claim live
   and offers **Pick the customer** (the appointment's, when the meeting was made for one, is taken at once); the
   write-up lands on whoever was named by the time the meeting ends. A stream nobody here can be heard for is left
   alone, and Zoom tells the meeting the app couldn't reach it.
   **One meeting, one coached call.** Zoom can start two streams for one meeting under two of its ids (the app's own
   start and the auto-start, a moment apart). A person is in one meeting at a time, so a stream for someone already
   heard is left alone; one under another id while their claim of the last ten minutes waits takes that claim; and
   the panel, opened in a meeting Zoom started hearing on its own, finds that live claim.
4. **Hearing it.** `RtmsStream` connects to Zoom's signaling and media sockets, signs both handshakes with the
   coaching Zoom app's id and secret, asks only for Zoom's own English transcript, and answers Zoom's keep-alives. Each transcript
   message names its speaker: the rep (by the name they show in the meeting) is the team's side, anyone else the
   customer's. Lines go to the add-ons exactly as a phone call's do (`addons/live-fanout.ts`), so the cards come the
   same way, on the panel and on the Live call tab. No audio reaches HandsFreeOS. It's billed by the minute as `speech.meeting.minute` (3¢: Zoom's
   Developer Pack credits at 1.5×; see "The AI's hearing and voice" in `docs/operations.md`).
5. **After.** When Zoom ends the stream (the meeting ends, or the rep presses **Stop coaching**, which stops the
   stream in Zoom), the claim is ended and the meeting is written up like a call: notes on the customer's timeline
   ("Marco’s video call was coached…"), a task for each promise, and a score.

## A coached HandsFreeOS video call

HandsFreeOS's own video calls (docs/video-calls.md, part 3) reach the coach the way Zoom meetings do, with nothing
to claim or connect. While the call's AI notes are on, each stretch of it is a live meeting of the first person on
the team in it who's coached, and the AI's listener hands it every line, both sides. The cards show beside the video
for them, as above the call bar on a phone call. When the stretch is over it's written up and scored like any
call ("Dana’s video call was coached…"). The team turning AI notes off for the call stops the coach and forgets it:
no lines, no cards, no write-up.

## Learning from wins

1. **A win** (Chris, 2026-10-14) is a job booked (`appointment.booked`), an estimate accepted (`estimate.accepted`),
   an invoice paid (`invoice.paid`) or a Pipeline deal won (`lead.won`). The add-on hears each and marks the customer's
   coached calls and conversations from the week before (`WIN_WINDOW_MS`) as won, and how (`salescoach.win.note`).
   The Coached tab shows it beside the score.
2. **Every write-up notes how each objection was answered**: the rep's answer, shortened, and which of the
   playbook's objections it is (`objectionId`, checked against the playbook). Write-ups from before round four have
   neither, and are read as having none.
3. **Once a week** (`salescoach.learn`, armed when the add-on turns on, from then) and whenever an owner presses
   **Look again now** (the `salescoach.learn.now` action), each playbook in use is looked at over the last 90 days.
   `tallyObjections` counts, for each of its objections, the records it came up in and the wins among them;
   `newInWins` gathers what came up in wins that the playbook lacks. The AI is asked only when an objection has at
   least 3 wins (`LESSON_MIN_WINS`) or something new came up in at least 2 (`NEW_MIN_WINS`).
4. **`checkedLessons`** holds the AI's suggestions to the numbers: a better answer only for an objection with enough
   wins, never one the playbook already says, and a new objection only when the wins it cites are real and distinct.
   The numbers are worked out from the records ("came up 9 times, and 6 ended in a win"), never the model's.
5. **`salescoach.lessons.put`** keeps them, one open per objection (a newer one replaces it), and doesn't suggest one
   again within 30 days of someone dismissing it.
6. **Owners and admins decide** (`salescoach.manage`), under Playbooks → **What's working**: **Use it** changes the
   playbook (a better answer replaces the objection's, a new objection is added) and keeps the lesson as used; **Not
   now** dismisses it. Nothing in a playbook changes without a person.

## Spanish

The coach follows the customer's language, as the AI teammate does (M18, "match the customer"): what the rep says
to the customer is in the customer's language; what's for the team stays in English, the language HandsFreeOS and
the playbooks are in.

1. **Hearing it.** On a phone call, the speech service hears English and Spanish, switching freely (Deepgram's
   `multi`), and says which each line was in. On Zoom, the transcript starts in English with Zoom's language
   identification on (`src_language` 9, `enable_lid`), and each line names its language (`RTMS_LANGUAGES`: 9 English,
   28 Spanish). Each line keeps its language (`CallLine.language`). A written conversation's language is the one the
   AI teammate noted on it (`conversations.language`); otherwise the model goes by the messages.
2. **The call's language** (`callLanguage`): the one most of the customer's lines were in, the latest winning a tie;
   else the team's; else unknown, and the model goes by the words. Each ask tells the model when it's known
   (`languageTag`).
3. **In Spanish:** a card's `say`, each suggested reply's text, and the write-up's `followUp`. The playbook may be in
   English; the model carries its meaning over and adds nothing.
4. **In English:** card titles, the summary, notes, promises (the rep's tasks), objections as noted, tips, and
   reply labels. Lessons from wins are written in the playbook's language too.
5. **Kept:** the write-up's `language` (what was heard first, then the conversation's, then the model's). The
   Coached tab says "In Spanish" beside such a call.

## Trends and the owner's view

The **Trends** tab (`?view=trends`) shows how coached calls are going over 4, 12 or 26 weeks (`&weeks=`, 12 by
default), each number against the same number of weeks before. It's worked out from the write-ups already kept,
never stored, by `salescoach.trends`:

1. **Which records count:** coached calls, Zoom meetings and written conversations that were written up
   (`state = 'done'`). Stopped and failed ones have no score.
2. **The weeks** run Monday to Sunday in the business's time zone (`workspaces.timezone`); the last is this week, so
   far. A week with nothing coached is a gap on the chart, not a zero.
3. **The numbers** (`tallyTrend`): the average score; **talk time**, the rep's average share of the talking on calls
   and meetings only (a text's share of the words says nothing about talking too much); objections answered and
   script steps done, added up across the write-ups; and **wins** (a job booked, an estimate accepted, a payment or a
   deal won within a week, as in "Learning from wins").
4. **Steps skipped most** (`skippedSteps`): counted against each playbook's steps as they are now, from calls whose
   playbook had the same number of steps then (a step's id is its place in the script, so an edited playbook's old
   calls would name other steps), and only once a step has been on at least 3 calls.
5. **Who sees what** is row security's call, as for the Coached tab: a rep reads only their own coached calls, so
   they see their own trend. Whoever reviews (`salescoach.review`; owners always) sees the owner's view first: the
   team's numbers and score by week, and a row for every rep who was coached in the period or the one before, most
   coached first. Each opens that rep's own (`&rep=`).

The AI can ask too (`salescoach_trends`): "how's Dana doing on calls?"

## Rules worth knowing before changing anything

- **The method is in HandsFreeOS's own words** (Chris, 2026-10-31). It came from the owner's sales training, but
  names no outside program and copies none of its text; the owner's own business may still paste that training's
  script as its own. A test holds the prompts to it.
- **Nothing that misleads** (Chris, 2026-10-31). The rep says who they are and why they're calling; nothing acts as
  if the customer should already know them, poses as anyone official, or uses props or tricks to seem like
  something it's not.
- **"If nothing changes" questions, kindly** (Chris, 2026-10-31): built only from what the customer said, never
  made-up deadlines, urgency, scarcity or scary facts. And never a suggestion to borrow, use a card or loan, or take
  money from savings to pay: only the payment options the business has.
- **The coach says only what's in the playbook and the knowledge base.** No prices, promises or facts of its own:
  the instructions say so, and a card naming a step or an objection that isn't in the playbook loses the name.
- **The score is worked out, never the model's number** (`scoreCall`): steps covered half (stages, for a script with
  them, less when the offer came before the problem), objections answered three tenths, a fair share of the talking
  a fifth (full marks between 35 and 60 percent), over whatever applies. The model says only which steps were done
  and whether the offer came early.
- **Nudges are kind and rare**: one per thing a call, never within 90 seconds of the last, never
  pushed to the phone. They say what to ask instead, not what the rep did wrong.
- **Nothing goes out on its own.** The follow-up is a draft the rep copies; the cards are suggestions. Tasks are the
  only thing made for the rep, and they're theirs.
- **Who sees what.** A coached call: the rep on it and whoever holds `salescoach.review` (admins by default; owners
  always). Its cards: the rep alone, even for reviewers. Only the worker writes either; the rep only puts a card
  away. Row security holds all of it (restrictive policies in the migration).
- **Deleting a coached call** (Chris, 2026-10-16) is for good and at once, not through the Deleted bin: what was said,
  the cards and the write-up. What it made stays: the timeline line and the tasks for what was promised. Only owners,
  unless an owner gives `salescoach.delete` (Settings → Permissions), as with `records.delete`. Not while the coach is
  still hearing it or writing it up (`salescoach_call_in_progress`). The AI never deletes (`salescoach.call.delete` is
  risk 4). Row security holds it (`calls_delete`, `20261027008200_salescoach_delete_calls.sql`).
- **The Assistant** does the rest of what a person does here: the live call and its cards, suggested replies,
  playbooks and what the coach learned (each operation's `ai`). Writing or archiving a playbook, using a lesson and
  stopping a call wait for the person's OK; putting a card away runs on its own.
- **Consent.** The coach listens only where the number's recording notice is on (Chris, 2026-10-14). On Zoom, Zoom
  shows its own notice that an app is listening, and the panel says so too. On a HandsFreeOS video call, it's the
  call's AI notes notice, and it listens only while they're on.
- **Every call, on its own, and the rep can stop it** (Chris, 2026-10-14). The coach listens on every answered call
  of someone with `salescoach.use`. **Stop coaching this call** (`salescoach.call.stop`, the rep alone, while it's
  live) marks it `stopped`: no more cards or asks to the AI, nothing kept at the end, no write-up. Row security lets
  the rep make that one change to their own call and no other.
- **Core never points into the add-on.** Core's live listening hands lines to any add-on that declares `liveCalls`;
  its tables reference core's calls and live meetings, never the other way round. `/zoom` finds the add-on's page
  from the catalogue (`liveCalls.zoom`), not by name.
- **A Zoom stream is heard only for whoever claimed it.** A stream nobody claimed in the last hour, or one started by
  a Zoom account other than the claimant's linked one, is left alone; and the worker connects only to Zoom's own
  servers (`trustedStreamUrl`).

## Not yet

- **Round 5's part 3** (Chris, 2026-10-31): the AI caller using the same scripts, up to "how much it matters", and
  booking a person to present and close.

- **Hanging up the stream when the coach is stopped.** A stopped call stops asking the AI, but the worker still
  hears it to the end (and it's billed as live speech) until core can end one add-on's listening mid-call.
- **Suggested replies in the phone app's message box.** They're on the web (desktop and phone-sized) for now.
- **Finding the customer by the participants' email** in Zoom. Zoom's `getMeetingParticipantsEmail` needs its own
  approval; the appointment, or the rep's pick, says who it is for now.
- **Picking up a Zoom stream again** after the worker restarts mid-meeting. The rep presses Start coaching again.
- **Zoom webinars and Zoom Phone.** Meetings only.
- **Other languages.** English and Spanish are what the coach is built and tested for; another language is heard
  only where the speech service hears it, and the model follows it as best it can.
- **Trends in the phone app.** The Trends tab opens on the web from the phone for now.
- **The live transcript replacing the after-call one**, so a coached call isn't transcribed twice.
- **Its own push switch.** Objection pushes go as add-on notices (the `addons` switch) for now.
