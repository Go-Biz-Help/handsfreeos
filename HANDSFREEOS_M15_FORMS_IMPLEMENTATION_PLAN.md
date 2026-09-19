# M14 — Forms, Surveys & Quizzes

One builder. A form, a survey and a quiz are the same object in three modes, the way the calendar is
one definition in many views and a workflow is one definition in three editors.

## Decisions (Chris, 2026-09-18)

| Question | Answer |
| --- | --- |
| Scope | **One builder, three modes**: `form`, `survey`, `quiz` |
| Quiz | **Both** graded (right answers, score, pass mark) and outcome (answers route to a result) |
| On submit | Create/update the customer · start a workflow · create a lead or task · **take a payment or deposit** |
| Delivery | Public link · website embed · **inside the AI teammate chat** · QR code |
| Logic | **Branching + calculations** (show/hide, scores, simple math like sq ft × rate) |
| Identity | **The business chooses per form** — identified by default, anonymous when switched on |

Assumed from earlier milestones, not re-asked:

- The Assistant builds and changes forms through tools, and **confirms before anything goes live**
  (M4/M12 rule: customer-facing changes wait for the person's OK).
- Published versions are immutable; answers stay on the version they were given on (M6 rule).
- Every change is an event in the audit log, and the Assistant can only do what the signed-in person can.

## Shape

### The definition (`packages/core/src/forms/`)

Mirrors `packages/core/src/workflows/` file for file, because that pattern already carries three
editors over one definition:

| File | What it holds |
| --- | --- |
| `definition.ts` | `FormDefinition` v1 — mode, pages, `questions[]` with stable ids, settings, results |
| `questions.ts` | The question catalog: short text, long text, choice, checkboxes, dropdown, number, money, date, time, rating/NPS, scale, phone, email, address, file upload, signature, section, page break, payment |
| `logic.ts` | Show/hide rules (reuses `workflows/conditions.ts` operators), `calculations[]`, scoring |
| `ops.ts` | Patch ops — `add_question`, `update_question`, `move_question`, `delete_question`, `add_page`, `set_logic`, `set_settings`, `set_result` — applied all-or-nothing, returning inverse ops for Undo |
| `describe.ts` | Plain English per question + `diffForms(a, b)` for the Describe preview and history |
| `ai-tools.ts` | Flat strict tool defs so the AI builder emits ops, same as the workflow builder |
| `render.ts` | Given a definition and the answers so far, the next visible question — one engine for the public page, the embed and the AI teammate chat |
| `score.ts` | Grading, outcome routing, calculation results |
| `templates.ts` | Built-in starters (below) |

### The database (`supabase/migrations/`)

- `20260926000100_forms_core.sql` — `forms`, `form_versions` (immutable published JSON), `form_questions_index` for reporting
- `20260926000200_forms_responses.sql` — `form_responses` (version id, person id or null, answers JSON, score, outcome, payment id, partials) and `form_response_answers` for per-question reporting
- `20260926000300_forms_delivery.sql` — public slugs/tokens, embed allow-list, QR, per-form identity and anti-spam settings

RLS by workspace like every other table; the public routes read through a token, never the workspace key.

### Commands (`packages/core/src/commands/form.ts`, `form-response.ts`)

`form.create` · `form.apply_ops` · `form.publish` · `form.unpublish` · `form.archive` ·
`form.duplicate` · `form.set_delivery` · `response.submit` · `response.save_partial` ·
`response.delete`. Submit runs the follow-ups in one transaction: match-or-create the person,
fill custom fields, create the lead/task, take the payment, then emit `form.submitted` so workflows
can trigger on it.

### The app (`apps/web/src/app/app/w/[workspaceId]/forms/`)

- **List** — forms with mode badge, views, starts, completions, completion rate
- **Editor** — three ways in, all on the same definition: question list (default), **Describe it** (the
  Assistant builds and edits it), and live preview beside them
- **Results** — per-question summaries (bars for choice, average for rating, table for text), score
  distribution for quizzes, one response in full, CSV export
- **Share** — public link, embed snippet, QR code, "ask this in chat" toggle

### Public surfaces

- `apps/web/src/app/f/[slug]/page.tsx` — the public form, one question or one page at a time, save-and-resume
- `apps/web/src/app/embed/v1/form.js` — embed script beside the existing chat widget
- AI teammate chat — the teammate asks the questions conversationally and writes the same response row
- QR — generated from the public link, downloadable as PNG and SVG

### Assistant tools (`packages/core/src/assistant/tools.ts`)

| Tool | Autonomy |
| --- | --- |
| `list_forms`, `get_form`, `form_results` | auto |
| `build_form` (from a description), `change_form` (ops) | confirm |
| `publish_form`, `unpublish_form` | confirm |
| `send_form` (text or email it to a customer) | confirm |

### Starters

Intake / contact us · quote request with instant estimate · review request · customer satisfaction
survey (NPS) · post-job feedback · staff training quiz · "which service do you need?" outcome quiz ·
new client onboarding · paid deposit order form.

## Build order

1. `forms/definition.ts`, `questions.ts`, `logic.ts` + tests
2. `forms/ops.ts` (+ inverse ops) + tests
3. `forms/render.ts`, `score.ts` + tests
4. Migrations 0054–0056, schema types
5. `commands/form.ts` — create, apply ops, publish, archive, duplicate
6. `commands/form-response.ts` — submit, partial, follow-ups, `form.submitted` event
7. Queries: list, one form, results aggregation, CSV
8. API routes + `packages/api-client`
9. Forms list + question-list editor
10. Live preview
11. `forms/describe.ts` + `ai-tools.ts` — the Describe editor
12. Results screens + export
13. Public form page (`/f/[slug]`), save-and-resume, anti-spam
14. Embed script + QR + share screen
15. Payment questions on the form, through the existing M9 connections
16. AI teammate asks the form in chat
17. Workflow trigger `form.submitted` + workflow action "send a form"
18. Assistant tools + confirm cards
19. Starters and the agency template push (M6 mechanism)
20. Mobile (offline fill via PowerSync), docs, CI

Each numbered step is a commit; CI green before the next one starts.
