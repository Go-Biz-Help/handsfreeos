# The demo player

Scripted scenes that play on the real screens of a business, for recorded videos and live shows. HandsFreeOS staff
open it with `?demo` on any page of a business of their own. They pick a scene, and each press of Space (or →, Page
Down, or a presentation clicker) plays the next step. A pointer moves and clicks as a person would.

The panel on the left lists every step, so the presenter knows what comes next. The app moves right of it, so the
panel can be left out of what's shared, and H hides it. It stays open in that browser until Exit.

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
  - Ask HandsFreeOS streams the scene's scripted answer, and Confirm on its card answers from the scene.
  - Everything else goes through untouched.
- **Both sides answer the same way.** Server Components go through `apiServer`'s middleware (`server.ts`). The
  browser goes through a patched `fetch` (`browser.ts`), so the API client and the Assistant's calls to the worker
  both get the answers.
- **The screens catch up.** After a step changes something, `emitLocalChange` (in `lib/realtime/live-provider.tsx`)
  tells this tab's screens, as a broadcast would, so they fetch again.
- **What the world can hold** (`world.ts`): texts, calls with a transcript, website chats from a visitor who isn't
  known until they give a name, drafts waiting for an OK, visits, hand-offs to a person (and Take it), estimates
  with the customer's approval, invoices made from them, and campaigns. `teammateAutomatic` makes the AI teammate
  read as answering on its own, for scenes past its training.
- **Made-up ids start with `de300000-0000-4000-8000-`** (`demoId`), so an answer for one can't be mistaken for a
  real record.

## Adding a scene

1. Add a file in `scenes/` exporting a `DemoScene`, and list it in `scenes/index.ts`.
2. Give each step:
   - a `label` (the panel's line) and, if it helps, `say` (a line for the presenter);
   - `change` for what it makes up, written against the world (`world.ts`), never the screen;
   - `live` for the entity types the screens on show should fetch again;
   - `run` for what the pointer does (`DemoPlayer` in `scenes/types.ts`). Aim at a `data-testid` as `@id`.
3. A step's `change` lands before its `run`, so a page the run opens already shows it. When the step is a click
   that makes the app fetch again by itself (Take it, Turn into an invoice, Send), leave those types out of `live`,
   or the screen changes before the click.
4. `scenes/kit.ts` has the shared pieces: `startConversation` for a new text, call or website chat, `openConversation`
   to open it from the Inbox, and `replyAsMe` to type and send a reply as the presenter (`p.type`, then
   `p.refresh`). A `byMe` message in the world is that reply, signed with the presenter's name (`p.me`).
5. If a screen the scene opens asks for something `respond.ts` doesn't answer yet, the browser console says
   `demo: no made-up answer for …`. Add the answer there, typed with `Ok<…>` so the compiler checks its shape.
6. Cover it in `e2e/demo-player.spec.ts`: play it to the end with Space, and check what it shows.
