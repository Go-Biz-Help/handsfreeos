# Coaching the AI teammate: feedback on its replies

Today a person teaches the AI teammate only by editing or rejecting a training-wheels draft. The test console and
the messages it sends on its own have no way to say "not like that". And what it learns goes to the end of the
business profile's Policies, which the prompt cuts at 80 words, so later lessons often never reach the AI.

This adds feedback on any reply the AI wrote, in a test or for real, and an Instructions list the AI reads in full.

## Decisions (Chris, 2026-10-15)

| Question                    | Answer                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What feedback does          | **The AI suggests one rule and a person OKs it.** When the note is unclear it asks one quick question first ("All customers or just this one?"), with answers to tap. |
| The test console            | **All four**: thumbs up or down, write the better reply, say why, and retry the turn with the fix                                                                     |
| Messages it sent on its own | **All four places**: on the message in the inbox, on the reply's sheet in Activity, in the phone app, and a Review list of what it sent on its own                    |
| Where the rules live        | **A new Instructions list** in the AI teammate's settings. The AI reads every one; each can be edited or deleted. Lessons already added to Policies move there.       |

Kept from Automations (2026-09-22), not re-asked:

- Nothing the AI suggests is used until a person OKs it.
- A suggestion that goes against what the AI already knows says so, and a person picks which is right.

## How it works

1. **Feedback.** On a reply the AI wrote, a person taps thumbs up or down. Thumbs down opens "What should it have
   said?" (the reply, to edit) and "Why?" (a short note). `ai_teammate.give_feedback` keeps it on
   `app.teammate_feedback`, one per person per reply.
2. **The read.** `ai_teammate.feedback_given` brings the worker's lesson read (`automations.lesson`), with the
   feedback as the newest correction. It always runs for feedback: a person is waiting for it, so Automations'
   "Learn from corrections" switch doesn't stop it. It ends one of four ways, kept on the feedback:
   - **a rule**: a `teammate_lessons` row, which the person saves or drops right there;
   - **a question**, when it can't tell what the feedback means. The person taps an answer or writes one
     (`ai_teammate.answer_feedback`), and it reads again with the answer. It asks once, never twice;
   - **nothing to learn**, with why ("It already has a rule for this");
   - **it couldn't read it**, and the person can try again.
3. **Saving the rule.** `teammate_lesson.apply` now adds the line to the Instructions list instead of Policies. A
   clash with a fact (hours, a knowledge item) still swaps those words when the person picks the new one. A
   suggestion nobody saves stays on Home's "Learn from corrections" card, as before.
4. **The prompt.** Every reply, call and test reads the whole list, in an `<instructions>` block. The fixed rules
   still come first: an instruction never beats them.
5. **Retry with the fix** (the test console only). The same turn runs again with the better reply and the note
   as a one-off coaching line, and with any rule just saved.

## Data

- `app.teammate_instructions`: the list. Text up to 300 characters, at most 50 per teammate. Where it came from
  (`person` or `lesson`), and the lesson.
- `app.teammate_feedback`: the rating, the better reply, the note, what the customer said and what the AI replied,
  the run (and the message, for a real one), and the read's state, question, answer and lesson. It follows its run:
  whoever may read the run may read its feedback.
- `app.teammate_lessons.feedback_ids`: the feedback a lesson was read from, beside `draft_ids`. A lesson can now
  clash with an instruction too (`conflict.place` `instruction`).
- Feedback names its reply by run or by message. The phone doesn't keep a message's run, and syncing it would make
  every phone copy everything again, so the server finds the run from the message.

## Who can do what

- **Give feedback and answer its question:** anyone with `inbox.use` (the test console needs `ai_team.manage`).
- **Save a rule, and change the Instructions list:** `ai_team.manage`. A clash with the business profile or a
  knowledge item also needs `knowledge.manage`. Someone without these is told who can.

## Screens

| Where                        | What                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Test console (web and phone) | Thumbs on each reply, the feedback form, the suggestion, and Retry with the fix            |
| Inbox conversation (web)     | Thumbs on each message the AI wrote, with the same form and suggestion                     |
| Activity → a reply's sheet   | The same                                                                                   |
| AI teammate → Review         | What it sent on its own, newest first, with the customer's message; "Not rated yet" or all |
| AI teammate → Instructions   | The list: add, edit and delete; where each came from                                       |
| Phone conversation           | Thumbs on each message the AI wrote, with the same form and suggestion                     |

## Moving the old lessons

The migration moves each applied lesson's line out of Policies and into the list, once. Apply it just before the
merge: until the new code is out, the AI doesn't read the lines that moved.

## Not yet

- Thumbs up teaches nothing yet. It's kept, and counts as rated in Review.
- Drafts keep their own path (Approve, Edit, Reject): their corrections already feed the same read.
- The phone has no Review list or Instructions screen yet.
