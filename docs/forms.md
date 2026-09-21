# Forms, surveys and quizzes (M15)

One builder. A form, a survey and a quiz are the same definition with a different `mode`, which is why a
business can turn a feedback survey into a scored quiz without rebuilding it, and why there is one editor,
one engine and one set of results screens rather than three of each.

## Where things are

| What                                | Where                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| The definition, the ops, the engine | `packages/core/src/forms/`                                                          |
| Commands                            | `packages/core/src/commands/form.ts`, `form-response.ts`                            |
| Reads                               | `packages/core/src/queries/form.ts`                                                 |
| Tables                              | migrations `0073`–`0078`, and `0085` for the phone                                  |
| The app                             | `apps/web/src/app/app/w/[workspaceId]/forms/`, `apps/web/src/components/forms/`     |
| The phone                           | `apps/mobile/src/forms/`                                                            |
| The public page                     | `apps/web/src/app/f/[site]/[slug]/`, served by `apps/worker/src/http/forms.ts`      |
| The AI builder                      | `apps/worker/src/forms/builder.ts` (tools in `packages/core/src/forms/ai-tools.ts`) |
| The Assistant's tools               | `apps/worker/src/assistant/tools-forms.ts`                                          |
| The AI teammate's tools             | `ask_form` / `answer_form` in `apps/worker/src/ai-team/tools.ts`                    |

## The shape

`forms/` mirrors `workflows/` file for file, for the reason that pattern exists: several editors have to be
several views of one thing rather than several things that drift.

- **`definition.ts`** — a versioned tree: `mode`, pages of questions with stable ids, calculations, the
  results people land on, what happens on submit, and the settings.
- **`ops.ts`** — the only way anything changes a form. A batch goes in all together or not at all, and every
  op hands back its inverse, so Undo is a list of ops rather than a saved copy.
- **`render.ts`** — which questions are showing, whether an answer will do, what the numbers come to, and
  where somebody lands. The editor's preview, the public page and the server all run this, which is what
  keeps them from disagreeing.
- **`describe.ts`** — plain English for a change ("“Your phone”: made it required") and `diffForms`.
- **`ai-tools.ts`** — the flat tools the builder calls, and the checking that turns them into ops.
- **`starters.ts`** — nine forms a business can publish as they come.

## Rules worth knowing before changing anything

**A draft is the business's own working copy.** Nobody outside it can open a draft, which is why the
Assistant may build and change forms on its own, and why publishing is a separate act with a confirmation.

**Publishing never opens a closed form.** Fixing a typo on a form you closed for the season leaves it
closed.

**An answer to a question that isn't showing is dropped, not recorded.** The engine prunes the answers to
what was visible, and it settles — taking one answer away can hide the next question. The server prunes
again on arrival, which is also what stops a crafted POST filling in a hidden question.

**A form never rubs anything out.** It fills a blank field on a customer and adds what wasn't there; a
customer leaving the email box empty this time doesn't erase the address on file.

**Answers keep the version they were given on**, and each answer carries the question's wording as it read
at the time. Rewording a question never rewrites what somebody already said.

**Ids are made by us, never by a model.** The AI builder writes labels; `formToolCallsToOps` stamps the
ids and tells the model what they are.

## The public page

`/f/<site>/<form>`, served by the worker as the booking page is, and never the draft. What protects it:

- per-address rate limits and a honeypot field, which is answered with a sheet that writes nothing;
- the key handed back when a sheet is started — knowing a response's id is not enough to write to it;
- the form's own closing rules, checked again inside the transaction;
- a frame rule built from the sites the business listed, so an embedded form is framed by them and nobody
  else (`apps/web/src/lib/forms/frame.ts`).

Embedding is a plain iframe with `?embed=1`; the page drops our frame and padding.

## Answering in a conversation

A form marked "the AI teammate may ask this" (`in_chat`) becomes two teammate tools. The teammate holds no
state: the sheet is the same row the public page writes, found by customer and form, so a conversation that
stops halfway can be finished on the link and the other way round.

## On the phone (M17)

Built, and nothing in `forms/` had to change — the engine really was ready.

- **`app.forms` and `app.form_versions` are published; `app.form_responses` is not.** Its
  `resume_token_hash` is a secret column by `packages/db/test/sync-secrets.test.ts`'s rule, and PowerSync's
  first copy of a table reads every column whatever the stream selects. A phone filling a form in needs the
  questions, not a row.
- **`form_versions.is_active`** is a stored flag meaning _a phone should hold this one_: the form's active
  version, while the form is live. A stream cannot join, which is the same reason `sync_window` is stored.
- **`form_response.record`** makes the answer sheet and sends it in one go, with an id from the phone, then
  hands over to `form_response.submit` so every consequence — the customer, the lead, the workflows — is the
  form's own behaviour and not a second set of rules.
- **`apps/mobile/src/forms/`** and `app/.../forms/[formId].tsx` render it with core's `formState` and
  `answerProblem`, so what the phone accepts is what the server accepts.
- **A file, a signature or a card payment stops the whole form** with "open this one on the web", rather
  than rendering the other questions and quietly dropping that one.

## What is not built yet

**Agency templates for forms.** M6's template mechanism pushes workflows to client businesses; forms would
use the same one, and `diffForms` already describes what an update would do.
