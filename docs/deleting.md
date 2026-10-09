# Deleting for good: the Deleted bin

Archive puts a customer, a conversation or a booking away and keeps it for good. Delete for good takes it out of
HandsFreeOS: it waits 30 days in **Settings → Deleted bin**, where an owner can bring it back, and then the worker
empties it. This round covers customers, conversations and bookings; leads, companies and a business's own kinds of
records are still archive-only.

## Where things are

| What                       | Where                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tables, rules and emptying | migration `20261027000400_deleted_bin.sql`; `20261027000500` keeps Social Outreach's profiles                                                                |
| Commands                   | `packages/core/src/commands/bin.ts`: `person.delete`, `conversation.delete`, `appointment.delete`, `bin.restore`, `bin.empty`                                |
| Reads                      | `packages/core/src/queries/bin.ts`: `bin.preview` (what goes with it) and `bin.list` (the bin)                                                               |
| What it says               | `packages/core/src/bin-words.ts`, for the web and the phone alike                                                                                            |
| Emptying, and calendars    | `apps/worker/src/bin/index.ts` (`bin.sweep` daily, `bin.purge`), and `apps/worker/src/calendar/sync.ts`                                                      |
| The web                    | `apps/web/src/components/bin/`, Settings → Deleted bin, and Delete on Contacts, the Inbox and a booking's sheet                                              |
| The phone                  | `apps/mobile/src/bin/calls.ts` and `apps/mobile/src/components/bin/delete-sheet.tsx`                                                                         |
| Tests                      | `packages/db/test/deleted-bin.test.ts`, `packages/core/test/deleted-bin.test.ts`, `apps/worker/test/deleted-bin.test.ts`, `apps/web/e2e/deleted-bin.spec.ts` |

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

And the defaults he kept:

- **The AI never deletes.** The commands are risk 4, which is never offered to it. It can still archive with an OK.
- **The phone deletes only with signal.** It isn't saved up to run later.
- **A booking still to come** asks whether to tell the customer it's cancelled, as Cancel does.
- **The audit log keeps one line** for each thing deleted (who, when and its name). Its older lines keep their line and
  lose their details, as for add-ons (2026-09-28).
- **Kept on purpose:** the texting opt-out list and email unsubscribes, so someone who said STOP is never texted
  again. Social Outreach keeps the Facebook profile and its Don't pitch mark, no longer linked to a contact.
- **Can't be deleted:** anything on a legal hold. Real Estate deals stay archive-only (2026-10-03).
- **A deleted customer who writes again** comes in as a new customer.
- **Outside services keep their own copies:** Facebook and Instagram their chats, Twilio its logs, Stripe and Square
  their payments.

## Rules worth knowing before changing anything

**Rows stay where they are while in the bin.** Each carries `bin_item_id`, and restrictive row-level security hides
marked rows from people, customers and the worker. Code that needs to read the bin sets `app.read_bin`
(`private.reading_bin()`); the worker does it through `readingBin`. A customer in the bin stays readable but frozen,
so a bill that names them still shows the name.

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

**The sync config doesn't change.** Phones drop what's in the bin through the columns their streams already read
(`sync_window`, `archived_at`, `deleted_at`), because any change to `apps/sync/sync-config.yaml` makes PowerSync
copy everything again.

## On the phone

An owner deletes one customer (Details → Delete for good…), one conversation (… → Delete for good…) or one booking
(Delete for good… under its buttons). The sheet says what the web's box says, from `bin-words.ts`. With no signal it
says so and does nothing. Selecting several, and the bin itself, are on the web.

## Not yet

- **Leads, companies and a business's own kinds of records** are archive-only until the next round.
- **A customer in the bin shows under Archived on phones** until the bin is emptied, and a name-only record kept for
  bills stays there after. Phones keep archived customers; leaving these out needs a sync config change, best
  batched with the next one.
