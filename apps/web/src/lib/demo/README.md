# The demo player

Scripted scenes that play on the real screens of a business, for recorded videos and live shows. HandsFreeOS staff
start it from Admin → Demo player, or open it with `?demo` on any page of a business of their own (`?demo=<scene id>`
loads that scene). They pick a scene, and each press of Space (or →, Page Down, or a presentation clicker) plays the
next step. A pointer moves and clicks as a person would.

The panel on the left lists every step with its voiceover, so the presenter knows what comes next and what to say;
the microphone button hides the voiceover, and Copy the voiceover copies the scene's as one script. The app moves
right of the panel, so it can be left out of what's shared, and H hides it. It stays open in that browser until Exit.

## Where it plays

- **The founder plays it in Bright Path Home Services**, the made-up home-services business that
  `apps/worker/scripts/seed-demo.ts` writes for app-store reviewers. Admin → Demo player finds it by name
  (`DEMO_BUSINESS` in `scenes/index.ts`, which must match the seed's `BUSINESS`), opens it as its owner
  (`platform.view_as.start`) and loads the business with a whole page load, never a move inside the app: the cookie
  below is for the business's pages only, and a page first loaded in Admin didn't see it.
- **While the player is open, the "You're in … as its owner" banner steps aside** (`data-demo="on"` on the page),
  so it stays out of a recording, and the panel says it instead. Outside a scene, what the founder changes there is
  real, and it is the reviewers' business: stay inside the scenes.
- **Anyone else in support plays it in a business of their own.** Never in support's read-only look, and never
  while viewing the app as a teammate.

## How it works

- **Nothing is sent or saved.** A scene's people, messages, drafts and campaigns are made up. They exist only in
  the answers this app gives for them, and real records are never changed or hidden.
- **One cookie says where the scene is up to** (`hfos-demo`, scoped to the business's pages, see `state.ts`). It
  holds the scene, when each step ran, and the business's and AI teammate's names.
- **The answers.** `respond.ts` builds the scene's records again from the cookie for every request, by running each
  step's `change` in order (`scenes/index.ts`), and answers from them:
  - a query that names a made-up record gets a made-up answer;
  - the inbox list, the inbox counts and the pending drafts get the real answer with the scene's rows added;
  - a command on a made-up record answers OK and changes nothing;
  - Ask HandsFreeOS streams the scene's scripted answer (its steps, any look-up cards like what you're owed or a
    day's appointments, its words, then a Confirm card for each thing it asks to do), and Confirm answers from the
    scene.
  - Everything else goes through untouched.
- **Both sides answer the same way.** Server Components go through `apiServer`'s middleware (`server.ts`). The
  browser goes through a patched `fetch` (`browser.ts`), so the API client and the Assistant's calls to the worker
  both get the answers.
- **The screens catch up.** After a step changes something, `emitLocalChange` (in `lib/realtime/live-provider.tsx`)
  tells this tab's screens, as a broadcast would, so they fetch again.
- **What the world can hold** (`world.ts`): texts, calls with a transcript (or missed), website chats from a
  visitor who isn't known until they give a name, emails, Messenger and Instagram messages (with the ad the customer
  tapped), photos, drafts waiting for an OK (with what approving does: book, move or cancel a visit, or send a quote's
  link; what the presenter changed; what it used from Knowledge), visits, hand-offs to a person (and Take it),
  estimates with the customer's approval, invoices made from them, services, campaigns, leads with a page of their
  own, and Home's cards for a lesson from the presenter's change and for a referral (Create lead). Since scenes
  31 to 38 it also holds visits on the calendar with no conversation (booked online, by the AI teammate or by
  staff, with a price, an address, a Zoom or HandsFreeOS call and the reminders sent), the AI's notes from a
  recorded call (summary, transcript, suggested task and follow-up email), a lead's video call with its chat,
  invoices for a visit (a deposit, or the job's bill paid by card), Google Calendar busy times, and documents to
  sign (a PDF in `public/demo/`, opened and signed with a picture of a signature). Since scenes 40 to 45 and 65:
  a webinar (a visit with `seats` and `webinar`: who came, how long, and how the poll scored them), Google reviews
  and their answers (`reviewsConnected` shows Google as connected), Knowledge's promotions, leads on the Pipeline
  board (`onBoard`), a spreadsheet's import and the people it made, and notes, which Search finds by their words
  along with the scene's texts. `teammateAutomatic` makes the AI teammate read as answering on its own, for scenes
  past its training. A business with no AI teammate (Bright Path has none) gets one made up, in training. Since
  scenes 46 to 49: a call the AI teammate places (`direction: 'outbound'` on a call message, worded in the Inbox as
  core's `callPreview` words it), the call AI Sales Coach listens to (`coach`, with its cards), a teammate's ask for
  an add-on (`ask` on a draft: an approval, not a reply), and what Social Outreach drafted (`outreach`). Scene 39:
  quick setup's progress (`setup`): the website typed, the AI teammate reading it, what it read, and Save.
- **Made-up ids start with `de300000-0000-4000-8000-`** (`demoId`), so an answer for one can't be mistaken for a
  real record.
- **The calendar's answers are in `respond-calendar.ts`:** a visit as the calendar and its sheet read it, the
  presenter added to the calendar's people with made-up hours when they aren't on the team (Bright Path's founder
  isn't), Google busy times, call notes and transcripts, and a document's page. The calendar list adds the scene's
  visits to the real ones. A visit's invoice comes from `money.for_record`, and invoices that aren't from an
  estimate get a made-up Stripe connection, so a card payment has an account to land in. A visit's HandsFreeOS call
  (`video_call.get`) and a webinar's scored people (`video_call.leads`) are there too.
- **Growing the business is in `respond-growth.ts`:** reviews, promotions, the Pipeline board, the contacts list
  and an import's progress, each the real answer with the scene's rows on top, and Search everything with the
  scene's notes and texts in their groups, matched and marked the way the server does (`@hfos/core`'s search
  helpers). It answers only when one of them holds every word typed.
- **A scene's own answers** (`answers` on `DemoScene`, by operation name) come first, whatever the request names:
  scene 40's `import.create` and `import.start`, so the file never reaches Storage (the wizard skips the upload for
  bucket `hfos-demo`) and nobody is added to the business. Scenes 47 and 49 answer their add-on's look-ups this way
  (`salescoach.live`, `outreach.waiting`) and the presses on them (Got it, Send, Approve all). An answer can
  start from the real one (`real`), for a scene that changes part of it: scene 39 shows the business's quick setup
  as a new owner's (`ai_setup.get`). It can also give back a whole `Response`: `ai_team.test` names the worker's test
  chat (`/v1/ai-team/test`), which scene 39 streams with replies made up for the questions it asks.
- **An add-on the business hasn't turned on** can show as on: `addons` on `DemoScene` (`['salescoach']`). While it
  plays, `account.me` and `workspace.get` answer with it in the business's add-ons and every one of its permissions
  held, so the side menu has its row and its pages open past the gate. Nothing is turned on: only the scene's own
  answers reach the add-on, and every other request to it is refused as before. Starting a scene that has one, or
  leaving one, draws the whole page again (the side menu doesn't redraw on a move to another page).

## Adding a scene

1. Add a file in `scenes/` exporting a `DemoScene`, and list it in `scenes/index.ts`.
2. Give each step:
   - a `label` (the panel's line) and a `voiceover`: what a narrator says while it plays, a sentence or two, spoken,
     in plain words, never naming a weekday the scene works out (Admin → Demo player shows them as one script);
   - `change` for what it makes up, written against the world (`world.ts`), never the screen;
   - `live` for the entity types the screens on show should fetch again;
   - `run` for what the pointer does (`DemoPlayer` in `scenes/types.ts`). Aim at a `data-testid` as `@id`.
     `p.go` takes an address with a query string too, such as the calendar on a day with a visit's sheet open
     (`calendarPath` in `scenes/calendar-kit.ts`).
3. A step's `change` lands before its `run`, so a page the run opens already shows it. When the step is a click
   that makes the app fetch again by itself (Take it, Turn into an invoice, Send), leave those types out of `live`,
   or the screen changes before the click.
4. `scenes/kit.ts` has the shared pieces: `startConversation` for a new text, call or website chat,
   `openConversation` to open it from the Inbox, and `replyAsMe` to type and send a reply as the presenter (`p.type`,
   then `p.refresh`). A `byMe` message in the world is that reply, signed with the presenter's name (`p.me`). For Ask
   HandsFreeOS: `answered` waits for an answer to finish, `confirmEach` presses Confirm on each waiting card in
   turn, `textedConversation` is a text it sent for the presenter, and `p.closeAssistant` gets it out of the way.
   Word cards and steps as the worker words them (`apps/worker/src/assistant`), so a scene shows only what it
   really does.
   - **Most Ask HandsFreeOS scenes are only words:** `scenes/ask-kit.ts` builds one from beats (`askScene`). An
     `ask` beat types the question and streams its scripted answer, then points at what it shows; a `confirm` beat
     says yes to the answer's cards; `reply` is a customer texting back, opened in the Inbox. `ran(...)` lists the
     answer's steps by the labels the worker shows for each tool (`PREPARING` for a card's tool with none), and
     `textCard`, `approveTextCard` and `textsSent` are the texting cards and the conversations they start.
     `scenes/ask-look.ts` and `scenes/ask-do.ts` are built this way. `beatStep` turns one beat into a step, for a
     scene that asks Ask HandsFreeOS part way through (`scenes/paperwork-calls.ts`, scene 38).
   - **Calendar, money and paperwork scenes** (`scenes/calendar-money.ts`, `scenes/paperwork-calls.ts`) use
     `scenes/calendar-kit.ts`: `calendarPath`, `openVisit`, `bookedText` (the booking text as the worker words it)
     and `REMINDERS`.
   - **Out loud:** `p.say` speaks a line to it instead of typing (`scenes/ask-voice.ts`). It turns talking on and
     the turn hears the words as written (`ears.ts`, through `scriptVoice` in `lib/voice/session.ts`), so no
     microphone is used. A spoken yes confirms the one waiting card, and a line its voice can't say plays as a
     pause.
   - **The AI teammate's scenes** use `scenes/teammate-kit.ts`: `customerSays`, `teammateSays` (past its
     training), `draftReply` and `approveDraft` (in training), `newPerson` and `regular`, and `changeWords`, which
     edits the end of a draft as a person would. A photo is a file in `public/demo/`, in bucket `hfos-demo`, shown
     as it is. A Home card is aimed at by `[data-testid="attention-card"][data-item="<id>"]`; `@id` takes no
     descendant, so write a CSS selector there. A toast's button is gone by the time a presenter has finished
     talking: open its page with `p.go` in the next step.
   - **In the app** (`kind: 'app'`): scenes that show a screen rather than the AI teammate or Ask HandsFreeOS.
     `p.attach` drops a file on a file picker (point at its drop zone first), and `p.type` types into a box such as
     the Search box.
   - **Add-ons** (`scenes/calls-coach.ts`, `scenes/addons.ts`) name theirs in `addons` and answer its look-ups in
     `answers`. Their words are made up for the scene, AI Sales Coach's playbook and cards included. `p.point` scrolls a target into view when a box that scrolls cuts it
     off, such as an add-on's row low in the side menu.
   - **Only what the Assistant can do.** It can't search notes or messages (Search everything is for people only),
     so a scene that finds something that way plays in the Search box instead.
5. If a screen the scene opens asks for something `respond.ts` doesn't answer yet, the browser console says
   `demo: no made-up answer for …`. Add the answer there, typed with `Ok<…>` so the compiler checks its shape.
6. Cover it in `e2e/demo-player.spec.ts`: play it to the end with Space, and check what it shows.
