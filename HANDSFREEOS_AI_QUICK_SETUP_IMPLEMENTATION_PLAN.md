# Quick setup for the AI teammate — Implementation Plan

Setting up the AI teammate is too much for a new business. Today it's a preset picker, then eleven settings pages
with about fifty choices, and the knowledge it needs lives somewhere else again (Knowledge, Calendars, Settings).
Quick setup replaces that first screen with a short run of simple questions, one per screen, that skips what doesn't
apply. At the end the business has a teammate that knows its business, website and services, a test chat to try
it, and a button to turn it on with training wheels. Everything else stays on today's full settings page, one link
away.

> **Status: steps 1 and 2 of §11 are built** (core: the kinds, the answers, the plan and its words, `ai_setup.get`,
> `ai_setup.save` and `ai_setup.finish`; the worker: reading the website for the screens, and insurance questions
> that aren't emergencies). The flow chart the owner approved is the "AI quick setup flow" artifact.

---

## 1. Decisions (Go Biz Help, 2026-10-05)

61 questions, each with a pick. The owner took every pick except the ones in bold below.

| Question                       | Decision                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Where it lives                 | It replaces today's first screen, on the AI teammate page and in Getting started                                               |
| How it asks                    | One question per screen, big answers to tap, about 5 minutes (10 to 12 screens), skipping what doesn't apply                   |
| Live summary                   | Beside the questions ("Ava replies to new leads within a minute.")                                                             |
| Skipping it                    | A small "Set it up myself" link to today's screens                                                                             |
| Leaving halfway                | It keeps the answers                                                                                                           |
| **Phone app**                  | **Web and phone at the same time** (8B); **owners set it up on a computer and on their phone** (59 A and B)                    |
| Name                           | "Quick setup"                                                                                                                  |
| What it knows already          | Reuses Getting started's goal and website; picks answers by kind of business                                                   |
| Presets                        | Replaced by "What should Ava help with?", tick all that fit (all five jobs), pre-ticked from the Getting started goal          |
| Website scan                   | Starts on the first screen, so it's read by the end; one screen to keep what it found; it fills the business profile to check  |
| No website                     | A few questions about the business, plus an optional PDF upload (offered to everyone)                                          |
| Quick facts                    | 6 to 8 yes/no taps that change by kind of business; up to 3 "What do customers ask you most?" answers                          |
| Asked once, filled everywhere  | Services (Knowledge and Calendars), open hours (Settings and Knowledge), service area (what Ava says and the ZIP check)        |
| Prices                         | Asked, with "No" picked                                                                                                        |
| Tone                           | Asked: friendly, professional, or short and simple                                                                             |
| Ready to test                  | Today's bar (5 answers and half the profile)                                                                                   |
| Book with no calendar          | Quick setup makes one from the services                                                                                        |
| **Qualifying questions**       | **Ava suggests them from the website** (30B), else starter questions for the kind of business                                  |
| A lead qualifies               | Owners and admins hear                                                                                                         |
| Not asked, kept as today       | Follow-up schedule (shown in the summary), phone calls off, money off, first text after 1 minute, channels, limits             |
| Website chat                   | An optional screen with the code to paste, so Ava can start today                                                              |
| When Ava answers               | Asked: all the time, only when closed, or set hours                                                                            |
| Name                           | Asked, with "Ava" filled in                                                                                                    |
| **Saying it's AI**             | **Asked, as today** (40B)                                                                                                      |
| Hand-off                       | Owners and admins hear; the owner's cell is asked and confirmed with a call from the business number                           |
| **Hand-off alerts**            | **Push them to get the phone app; email alerts stay off** (43B)                                                                |
| Last screen                    | A test chat with questions made from their business, a short report with "Add the answer", then "Turn on with training wheels" |
| Training wheels                | 20 approvals, not asked; it can be turned on before any channel works                                                          |
| Running it again               | Allowed: it shows what will change and asks first; businesses that have a teammate run it from More settings                   |
| **Today's full settings page** | **Tidied in this same project** (56B), e.g. Limits and Autonomy under "Advanced"                                               |
| **Agencies**                   | **Can save their answers as a starting point for client businesses, now** (58B)                                                |
| **Who it's designed around**   | **A mix: home services, salons, offices, plus real estate agents and insurance agents** (60)                                   |
| The feeling at the end         | "It knows my business"                                                                                                         |

Choices the decisions didn't spell out, made here and open to change:

- **The kind of business decides the picks**, from the workspace's industry (§3), so there's nothing new to store.
- **Nothing in the business changes until Save**, except the first screen: its name, kind and website are saved
  straight away so the scan can start.
- **Save runs each area's own command** (§5), so permissions, events and the activity log are the same as doing it
  by hand. The teammate is saved as a revision headed "Quick setup".
- **A fact a person rewrote is theirs.** Quick setup tags its own facts and never rewrites one whose words changed.
- **A chat the business already has stays as it is.** Who answers it is decided on its own page.
- **The booking calendar is named "Service calls"** for home services and "Appointments" for everyone else. A service
  area is made only when the answer is a list of ZIP codes; towns stay words Ava reads.

---

## 2. What the repo has, and what it was missing

- **The teammate** (`packages/core/src/ai-team`): one settings document per business, saved as revisions, with
  presets and rules that list what's wrong. It's created off; `ai_teammate.set_status` turns it on.
- **Knowledge** (`commands/knowledge.ts`): the business profile, items (facts, Q&As, articles), the website and its
  scans, and suggestions waiting for a person.
- **Getting started** (`onboarding/`): the goal and the website, asked after Create business.
- **Missing:** a way to ask a few questions and turn the answers into all of the above at once, a place to keep
  answers part way through, picks by kind of business beyond "home services or not", and words for what will change.

---

## 3. Kinds of business

`ai-setup/kinds.ts`. Six kinds, from the industry: **home** (the Home services group), **salon** (beauty and
grooming by appointment), **office** (health offices, and firms that see clients), **real estate**, **insurance**
and **other**. A kind picks:

- **Jobs ticked on top of the goal's:** salons and offices add Book; real estate and insurance add Qualify.
- **Quick facts:** 6 to 8 yes/no questions, each a knowledge fact with a fixed title. A No is kept too ("We don't
  offer financing."), so Ava never guesses, except where a No isn't worth telling customers (Licensed and insured).
  Health offices are asked about new patients and insurance; other offices about new clients.
- **Starter qualifying questions**, used when the website gives none. No question asks who someone is (family,
  children, schools, safety, religion, age, health): `PROTECTED_WORDS` checks the starters and the ones Ava suggests.
  They have no apostrophes, so a text never drops to the slower encoding.
- **How "Where do you work?" is asked**, and the tone it starts with (offices, real estate and insurance:
  professional; the rest: friendly).
- **Topics that always go to a person:** insurance adds claims and what a policy covers.

The teammate's own "Suggested questions" use the same starters (`suggestedQuestions`).

---

## 4. The screens

Twelve screens; two show only when they apply. A summary beside them (`aiSetupSummary`) follows the answers.

| #   | Screen                                   | Asks                                                             | Notes                                                      |
| --- | ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Your business                            | Name, kind of business, website ("We don't have one")            | Saved at once; the scan starts                             |
| 2   | What should Ava help with?               | The five jobs                                                    | Pre-ticked from the goal and the kind                      |
| 3   | About your business                      | What you do, services, where you work                            | Filled from the website when it's read                     |
| 4   | When are you open, and when should Ava…? | Open hours; all the time, only when closed, or set hours         |                                                            |
| 5   | Quick facts                              | The kind's yes/no taps                                           |                                                            |
| 6   | Meet Ava                                 | Name, how it says it's AI                                        |                                                            |
| 7   | How should Ava sound?                    | Tone, prices                                                     | "Keep what I wrote" when a person wrote their own tone     |
| 8   | What Ava learned from your website       | Keep or untick what the scan found; up to 3 top questions; a PDF | No website: the questions and the PDF only                 |
| 9   | Qualifying questions                     | Keep, edit or add                                                | Only when Qualify is ticked                                |
| 10  | Stay in the loop                         | The owner's cell; get the phone app                              | The cell is confirmed with a call from the business number |
| 11  | Add Ava to your website?                 | Yes or not now                                                   | Only for a website without a chat                          |
| 12  | Try Ava, then turn it on                 | —                                                                | Shows what will change first when there's a teammate       |

What a screen still needs before Next is `aiSetupStepProblems`, in the teammate's name ("Add the services customers
book, so Ava can book them."). The test chat starts with `aiSetupTestQuestions`: where it works, a quick fact, a
price, booking, the hours and "Are you a real person?". Every label is in `ai-setup/words.ts`, shared by the web and
the phone.

---

## 5. What's kept, and the commands

**While someone is part way through**, `workspaces.settings.aiSetup` keeps the answers, the furthest screen
finished, and the kind they were answered for, plus who started it, who last finished it and how many times.
Only quick setup's commands write it: `workspace.update` refuses the key. It's read forgivingly: answers that no
longer read count as never given. Carrying on uses the answers of the screens finished and today's picks for the
rest; when the kind changed on screen 1, what's picked by kind (jobs, facts, tone, questions) is picked again.

**What it starts from** (`ai-setup/state.ts`, read by `ai-setup/load.ts` as each area's own screen reads it): the
business's name, kind, goal and website, open hours, the teammate, the profile, the facts quick setup wrote, booking
services and calendars, service areas, the team's email address, the chat, texting, and the scan.

**The answers start** (`startingAiSetupAnswers`) from the teammate when there is one, else from an agency's saved
answers (§9), else from the goal and the kind. The profile, facts and tone are read back, so a second run with
nothing changed changes nothing.

**The plan** (`planAiSetup`) is worked out the same way on the web, on the phone and in Save, with what will change
in words: open hours; the profile (prices kept by service name, the hours written from the open hours); facts to add,
change or archive; answers; findings to keep or turn down; services, a booking calendar and a service area; the chat;
and the teammate, as `diffTeammateConfigs` words it, or "Sets up Ava, your AI teammate".

| Operation         | What it does                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_setup.get`    | The state, the answers to start from, today's picks alone (Start over), how far it got. Needs `ai_team.manage`                                                                                           |
| `ai_setup.save`   | Keeps the answers and the furthest screen. On screen 1, saves the name, kind and website and starts the scan unless the site was read already. Risk 1, `ai_team.manage`; `ai_setup.started` once per run |
| `ai_setup.finish` | Save: runs the plan with each area's own command in one transaction, then sets up or saves the teammate, which stays off. Refuses stale answers (`revision_conflict`). Risk 2; `ai_setup.finished`       |

Save carries on past what someone else decided meanwhile (a finding already kept or turned down) and past a
calendar that can't be turned on yet; each comes back as a note ("Service calls can't be turned on yet. …").

---

## 6. Reading the website (worker)

Saving screen 1 with a website asks Ava to read it (`ai_setup.read_requested`), once per address: again only when
nothing came of it for 10 minutes (the site was down, or no AI was set up). The worker's `ai_setup.read_site` job
(`apps/worker/src/ai-setup/read-site.ts`) reads the start page, its footer included, and up to two more pages on
the same site: its services first, then where it works, then about, hours or contact. It honours robots.txt, and
every request goes through `fetchUrl` like the website scan. The model reads the pages as quoted data and says:

- **What the business does, its services, where it works and its open hours**, which the screens start from where
  the business hasn't said (§5); the person checks them on screens 3 and 4.
- **The answers to its kind's quick facts** (`quickFactsFor`, listed for the model by key): yes only when the pages
  say so, no only when they clearly say not, and nothing for the rest. They fill in screen 5 for the facts the
  business hasn't answered and has no fact for; one a person wrote stays theirs.
- **Qualifying questions for its leads** (30B), checked against `PROTECTED_WORDS` and kept without apostrophes;
  the kind's starters when it finds none.

`aiSetupFoundFrom` checks and trims what it says (12 services, 6 questions, hours that can be open hours, quick facts
the business is asked), and `ai_setup.note_found` (the worker only) keeps it in the website's settings in
Knowledge, for that address only. For two minutes after it's asked, `ai_setup.get` says Ava is reading
(`state.reading`), so the screens wait for it; what arrives later still fills in the screens not finished yet.
The tokens count as Knowledge's. Without a model, or when robots.txt or the site keeps it out, nothing is kept and
the screens ask instead.

**Questions aren't emergencies** (`ai-team/guardrails.ts`): "Does my policy cover flooding?", "What if my pipes
burst, am I covered?" and a buyer's "Has the house had any flooding?" no longer read as a flood. "My house is
flooding, am I covered?" still does, and so does anything happening right now. An insurance business's "What a
policy covers" and "Insurance claims" go to a person by what customers say ("Am I covered…", "deductible",
"claim"), not only those exact words.

## 7. Web

The screens of §4 on the AI teammate page and in Getting started's AI step, with "Set it up myself" leading to
today's screens. Turning it on is `ai_teammate.set_status`. Read `apps/web/AGENTS.md` first.

## 8. Phone

The same screens in the phone app (8B, 59), from the same core functions and words, so an owner can start on the
computer and finish on the phone.

## 9. Agencies

An agency saves its answers as a starting point for client businesses (58B): only the answers that aren't about one
business (`AI_SETUP_TEMPLATE_FIELDS`: jobs, when Ava answers, name, how it says it's AI, tone, prices, qualifying
questions). They apply only to a business without a teammate. They're kept on the organization; that's a database
change, applied to the hosted database before it merges.

## 10. Tidying today's full settings page

Limits and Autonomy move under "Advanced", and the page gets "Run quick setup again" (56B).

---

## 11. Build order

Each step is its own pull request.

1. **Core** ✓: kinds, answers, plan, summary, words; `ai_setup.get`, `ai_setup.save`, `ai_setup.finish`; tests.
2. **Worker** ✓: the profile and qualifying questions from the website; the insurance false alarm.
3. **Web**: the screens, the summary, the test chat and its report, turning it on.
4. **Phone**: the same screens.
5. **Agencies**: saving answers as a starting point (with its migration).
6. **Tidy**: today's full settings page.

## 12. Tests

- `packages/core/test/ai-setup.test.ts`: the kinds and their picks, the screens, carrying on, where the answers
  start, the plan and its words, the summary, what a screen still needs, and the test questions.
- `packages/core/test/ai-setup-commands.test.ts` (local database): the look-up, keeping the answers, the first
  screen and its scan, Save with everything it makes, a second run that changes nothing, a revision headed "Quick
  setup", stale answers, and who may run it; asking for the website to be read once, keeping what was read for
  its address only, and only from the worker.
- `apps/worker/test/ai-setup-read-site.test.ts` (the stand-in website): which pages it reads, robots.txt, the
  pages reaching the model only as quoted data, what's kept and where the screens start, and nothing kept without
  a model or for a website that changed.
- `packages/core/test/ai-team-guardrails.test.ts`: insurance and home-history questions that aren't emergencies,
  the reports that still are, and an insurance business's topics found by what customers say.
