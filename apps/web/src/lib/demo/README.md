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
- **What the world can hold** (`world.ts`): texts, calls with a transcript, website chats from a visitor who isn't
  known until they give a name, drafts waiting for an OK, visits, hand-offs to a person (and Take it), estimates
  with the customer's approval, invoices made from them, services, and campaigns. `teammateAutomatic` makes the AI
  teammate read as answering on its own, for scenes past its training. A business with no AI teammate (Bright
  Path has none) gets one made up, in training.
- **Made-up ids start with `de300000-0000-4000-8000-`** (`demoId`), so an answer for one can't be mistaken for a
  real record.

## Adding a scene

1. Add a file in `scenes/` exporting a `DemoScene`, and list it in `scenes/index.ts`.
2. Give each step:
   - a `label` (the panel's line) and a `voiceover`: what a narrator says while it plays, a sentence or two, spoken,
     in plain words, never naming a weekday the scene works out (Admin → Demo player shows them as one script);
   - `change` for what it makes up, written against the world (`world.ts`), never the screen;
   - `live` for the entity types the screens on show should fetch again;
   - `run` for what the pointer does (`DemoPlayer` in `scenes/types.ts`). Aim at a `data-testid` as `@id`.
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
     `scenes/ask-look.ts` and `scenes/ask-do.ts` are built this way.
   - **Out loud:** `p.say` speaks a line to it instead of typing (`scenes/ask-voice.ts`). It turns talking on and
     the turn hears the words as written (`ears.ts`, through `scriptVoice` in `lib/voice/session.ts`), so no
     microphone is used. A spoken yes confirms the one waiting card, and a line its voice can't say plays as a
     pause.
   - **Only what the Assistant can do.** It can't search notes or messages (Search everything is for people only),
     so a scene that finds something that way plays in the Search box instead.
5. If a screen the scene opens asks for something `respond.ts` doesn't answer yet, the browser console says
   `demo: no made-up answer for …`. Add the answer there, typed with `Ok<…>` so the compiler checks its shape.
6. Cover it in `e2e/demo-player.spec.ts`: play it to the end with Space, and check what it shows.
