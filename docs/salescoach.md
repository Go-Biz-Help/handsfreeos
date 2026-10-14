# AI Sales Coach

AI Sales Coach (`salescoach`) coaches a business's people while they sell. While someone on the team is on a phone
call, it listens and shows them, from the business's own playbook, what to say next, the answer to an objection and
the facts the customer just asked about. After the call it writes the notes, a follow-up to send, a task for each thing
the rep promised, and a score. The decisions and the rounds still to come are in
`HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md`; this guide is for working on what's built.

**Where it stands (2026-10-14):** round 0 (core's live listening), round 1 (phone calls) and round 2's suggested
replies in written conversations are built, in `development`: staff hand it to test businesses. Round 2's write-up of a
conversation once it goes quiet, Zoom (round 3) and learning from wins (round 4) are next.

## Where things are

| What                                      | Where                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest, words, playbook rules (pure)    | `packages/core/src/addons/salescoach/` (`manifest.ts`, `words.ts`, `playbooks.ts`)                                                                    |
| Suggested replies (what's asked, checks)  | `packages/core/src/addons/salescoach/suggest.ts`, `ops/suggestions.ts`; the worker's `suggest.ts`; the web's `composer-suggestions.tsx`               |
| What the AI is asked, its checks, scoring | `packages/core/src/addons/salescoach/coach.ts`                                                                                                        |
| Commands and queries                      | `packages/core/src/addons/salescoach/ops/` (`playbooks.ts`, `calls.ts`), its tables' mirror in `tables.ts`                                            |
| Hearing a person's call live (core)       | `apps/worker/src/telephony/live.ts` (`onCallAnswered`, `LiveCallSession`), `apps/worker/src/http/live-calls.ts` (the socket)                          |
| The add-on's worker half                  | `apps/worker/src/addons/salescoach/` (`live.ts`, `after-call.ts`, `draft.ts`, `business.ts`)                                                          |
| The stand-in model's answers              | `SALESCOACH_RULES` in `apps/worker/src/ai/scripted.ts`                                                                                                |
| Web                                       | `apps/web/src/addons/salescoach/`; its page `app/app/w/[workspaceId]/a/salescoach/`; the call bar's slot in `active-call-bar.tsx`                     |
| Phone                                     | `apps/mobile/src/addons/salescoach/`; its route under `(more)/a/salescoach/`                                                                          |
| Database                                  | `supabase/migrations/20261027003600_addon_salescoach.sql`, `20261027003700_salescoach_suggestions.sql`                                                |
| Tests                                     | `packages/core/test/addons/salescoach*.test.ts`; `apps/worker/test/salescoach-live.test.ts`, `salescoach-draft.test.ts`, `salescoach-suggest.test.ts` |

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
5. **Coaching.** Sales Coach starts the coached call with the usual playbook (`salescoach.call.begin`). When the
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

## Rules worth knowing before changing anything

- **The coach says only what's in the playbook and the knowledge base.** No prices, promises or facts of its own:
  the instructions say so, and a card naming a step or an objection that isn't in the playbook loses the name.
- **The score is worked out, never the model's number** (`scoreCall`): steps covered half, objections answered three
  tenths, a fair share of the talking a fifth (full marks between 35 and 60 percent), over whatever applies.
- **Nothing goes out on its own.** The follow-up is a draft the rep copies; the cards are suggestions. Tasks are the
  only thing made for the rep, and they're theirs.
- **Who sees what.** A coached call: the rep on it and whoever holds `salescoach.review` (admins by default; owners
  always). Its cards: the rep alone, even for reviewers. Only the worker writes either; the rep only puts a card
  away. Row security holds all of it (restrictive policies in the migration).
- **Consent.** The coach listens only where the number's recording notice is on (Chris, 2026-10-14). Zoom shows its
  own notice when round 3 comes.
- **Every call, on its own, and the rep can stop it** (Chris, 2026-10-14). The coach listens on every answered call
  of someone with `salescoach.use`. **Stop coaching this call** (`salescoach.call.stop`, the rep alone, while it's
  live) marks it `stopped`: no more cards or asks to the AI, nothing kept at the end, no write-up. Row security lets
  the rep make that one change to their own call and no other.
- **Core never points into the add-on.** Core's live listening hands lines to any add-on that declares `liveCalls`;
  its tables reference core's calls, never the other way round.

## Not yet

- **Hanging up the stream when the coach is stopped.** A stopped call stops asking the AI, but the worker still
  hears it to the end (and it's billed as live speech) until core can end one add-on's listening mid-call.
- **A written conversation's write-up** (round 2's second half): the notes, tasks and score once it goes quiet.
- **Suggested replies in the phone app's message box.** They're on the web (desktop and phone-sized) for now.
- **Zoom** (round 3): a person's own add-on connection, one Zoom webhook address, the in-meeting app.
- **Learning from wins, trends, Spanish** (round 4).
- **The live transcript replacing the after-call one**, so a coached call isn't transcribed twice.
- **Its own push switch.** Objection pushes go as add-on notices (the `addons` switch) for now.
