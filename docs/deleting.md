# Deleting for good: the Deleted bin

Archive puts something away and keeps it for good. Delete for good takes it out of HandsFreeOS: it waits 30 days in
**Settings → Deleted bin**, where an owner can bring it back, and then the worker empties it. The first round covered
customers, conversations and bookings; the second (`20261027000800`) added leads, companies and records of a
business's own kinds. An add-on's records stay archive-only.

## Where things are

| What                       | Where                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables, rules and emptying | migration `20261027000400_deleted_bin.sql`; `20261027000500` keeps Social Outreach's profiles; `20261027000800` adds leads, companies and records; `20261027009700` hides a binned response's answers                   |
| Commands                   | `packages/core/src/commands/bin.ts`: `person.delete`, `conversation.delete`, `appointment.delete`, `lead.delete`, `company.delete`, `custom_record.delete`, `bin.restore` and `bin.empty`                               |
| Reads                      | `packages/core/src/queries/bin.ts`: `bin.preview` (what goes with it) and `bin.list` (the bin)                                                                                                                          |
| What it says               | `packages/core/src/bin-words.ts`, for the web and the phone alike                                                                                                                                                       |
| Emptying, and calendars    | `apps/worker/src/bin/index.ts` (`bin.sweep` daily, `bin.purge`), and `apps/worker/src/calendar/sync.ts`                                                                                                                 |
| The web                    | `apps/web/src/components/bin/`, Settings → Deleted bin, and Delete on Contacts, the Inbox, a booking's sheet, a lead, a company and a record                                                                            |
| The phone                  | `apps/mobile/src/bin/calls.ts` and `apps/mobile/src/components/bin/delete-sheet.tsx`                                                                                                                                    |
| Tests                      | `deleted-bin.test.ts` and `deleted-bin-more.test.ts` in `packages/db/test` and `packages/core/test`; `packages/core/test/bin-words.test.ts`; `apps/worker/test/deleted-bin.test.ts`; `apps/web/e2e/deleted-bin.spec.ts` |

## The owner's decisions (2026-10-08)

Chris answered the plan's five questions with "1b, 2b, 4c, 5b" (the third kept its default), and kept the plan's
defaults.

1. **Only owners delete for good** (`records.delete`). An owner can give it to a role or a person in Settings →
   Permissions.
2. **A Deleted bin** keeps what's deleted 30 days, where it can be brought back. Then it's gone.
3. **Deleting a customer takes everything only about them:** their texts, emails, chats, calls and recordings, notes,
   tasks, files, leads, bookings and form answers.
4. **Their invoices, quotes and payments stay**, with just their name on them.
5. **Several at once:** tick customers on Contacts, or press Select in the Inbox.

And the defaults kept:

- **The AI never deletes.** The commands are risk 4, which is never offered to it. It can still archive with an OK.
- **The phone deletes only with signal.** It isn't saved up to run later.
- **A booking still to come** asks whether to tell the customer it's cancelled, as Cancel does.
- **The audit log keeps one line** for each thing deleted (who, when and its name). Its older lines keep their line and
  lose their details, as for add-ons (2026-09-28).
- **Kept on purpose:** the texting opt-out list and email unsubscribes, so someone who said STOP is never texted
  again. Social Outreach keeps the Facebook profile and its Don't pitch mark, no longer linked to a contact.
- **Can't be deleted:** anything on a legal hold. Real Estate deals stay archive-only (2026-10-03), and so does every
  add-on's record, and anything an add-on keeps that needs it (a company that's one of Real Estate's vendors).
  One exception (2026-10-16): AI Sales Coach's coached calls can be deleted for good, at once and without the bin,
  by owners or whoever an owner gives `salescoach.delete` (see "Rules worth knowing" in `docs/salescoach.md`).
- **A deleted customer who writes again** comes in as a new customer.
- **Outside services keep their own copies:** Facebook and Instagram their chats, Twilio its logs, Stripe and Square
  their payments.

## Rules worth knowing before changing anything

**Rows stay where they are while in the bin.** Each carries `bin_item_id`, and restrictive row-level security hides
marked rows from people, customers and the worker. Code that needs to read the bin sets `app.read_bin`
(`private.reading_bin()`); the worker does it through `readingBin`. A customer in the bin stays readable but frozen,
so a bill that names them still shows the name.

**A form response's answers follow it** (20261027009700). They're a row each with no `bin_item_id` of their own, so
`form_answers_follow_response` hides them from people whenever their response is hidden: in the bin, they're gone
from Forms → Results and from anything else that reads answers by form or by business, and Bring back shows them
again. They go with the response when the bin is emptied. The worker's own policies don't change.

**The box always asks first.** `bin.preview` says what goes with each thing and refuses what can't go yet: a plan
still billing, a signed file, a hold, a message still going out or a call still going on. Clients branch on its
`rule`, never on its words. A booking still to come doesn't stop a delete: the command cancels it first.

**Deleting a customer cancels their bookings still to come without telling them.** To tell them, cancel from the
calendar first. A class keeps its time; only their seat goes.

**Some things don't come back with Bring back**, and the bin says so: workflows stop, Home's cards and the AI's
waiting drafts go, a place on a waitlist is given up, and the customer's portal signs out. A conversation whose line
has had a new one since joins that one. A deleted booking's time isn't offered to the waitlist.

**Emptying is the worker's.** `bin.sweep` runs daily and starts on whatever has waited its 30 days; Delete now and
Empty the bin start at once. `bin.purge` empties an item a batch at a time and removes its files from Storage.
Bookings come out of Google and Outlook calendars when deleted and go back in when brought back; emptying waits up
to an hour for them first. Once emptying starts, nothing can bring it back.

**A customer with bills is left as a name-only record** (`erased_at`) that the bills point to.

**A partner's record goes with their contact** (20261027008900): what they earned, and which clients were theirs. The
box says so first (`partners` in what goes with them). A client a partner sent only lets go of their referral, so what
they earned the partner stays the partner's.

**A lead, a company or a record takes only what's about it, and what was put on it on purpose** (20261027000800).

- A lead takes its tasks, its files and the timeline lines that tell its own story (made, moved, won, lost). Its
  customer keeps their notes, calls, bookings, bills and form answers: notes made on a customer default to their
  open lead, so a lead on a note doesn't make it the lead's.
- A company takes its notes, tasks, files and relationships, and the leads that are only the company's. Its people
  stay, no longer at it once it's emptied, and so do their leads.
- A record takes its notes, tasks, files and relationships. Bookings on it stay.
- An add-on that keeps rows needing it stops the delete (`bin_addon_uses`), as a hold does. The database names the
  add-on as `{addon:<id>}`, and core puts in its name (`withAddonNames`).
- A lead in the bin on its own goes with its customer (or, for a company's own lead, its company) when they're
  emptied, and isn't brought back while they're in the bin (`bin_restore_parent`).
- Deleting a stage moves the leads in the bin that sit in it to another stage of its kind.

**The sync config doesn't change.** Phones drop what's in the bin through the columns their streams already read
(`sync_window`, `archived_at`, `deleted_at`), because any change to `apps/sync/sync-config.yaml` makes PowerSync
copy everything again.

## On the phone

An owner deletes one customer or company (Details → Delete for good…), one conversation (… → Delete for good…), one
booking (Delete for good… under its buttons) or one lead (Delete for good… at the foot of its page). The sheet says
what the web's box says, from `bin-words.ts`. With no signal it says so and does nothing. Selecting several, records
of a business's own kinds, and the bin itself, are on the web. A customer's Leads tab leaves out archived leads, as
the web's does, so a lead in the bin leaves it too.

## Not yet

- **A customer or a company in the bin shows under Archived on phones** until the bin is emptied, and a name-only
  record kept for bills stays there after. Phones keep archived customers and companies; leaving these out needs a
  sync config change, best batched with the next one.
- **An old link to a lead, a company or a record in the bin** says it isn't there any more, rather than where it went
  as a customer's page does.
- **Several leads, companies or records at once:** the commands take up to 100, but the screens delete one at a time.
