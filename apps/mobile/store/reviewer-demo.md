# The demo business a reviewer signs into

HandsFreeOS is useless without an account, and both stores refuse an app they can't get into. So there is one
permanent demo business, seeded by a script rather than made by hand, and one login that can't be locked out.

## The login

| Field    | Value                                                                               |
| -------- | ----------------------------------------------------------------------------------- |
| Email    | `app-review@handsfreeos.com` (override with `HFOS_DEMO_EMAIL`)                      |
| Password | Chris's choice, given to the script as `HFOS_DEMO_PASSWORD`, at least 12 characters |
| Business | Bright Path Home Services                                                           |
| Role     | Owner — so nothing in the app is hidden from the reviewer, money included           |

Put the email and password in **App Store Connect → App Review Information → Sign-in required**, and in
**Play Console → App content → App access → All or some functionality is restricted**. Nowhere else — not in this
repository, not in a commit, not in a screenshot.

### Why it can't be locked out

- **It signs in with a password, not an emailed code.** The phone's sign-in screen offers a code first, with
  **Use my password** underneath; the password path never needs an inbox a reviewer can't read. (The email should
  still be a real mailbox Chris can open — see the checklist below.)
- **The account is already confirmed.** The script creates it through Auth with `email_confirm: true`, so there is no
  confirmation link to click.
- **There is no unlock to get past.** Face ID and fingerprint unlock are set up per install and are always skippable,
  so a fresh install asks the reviewer for nothing.
- **There is no second factor and no phone verification.** The reviewer never has to receive anything.
- **It owns its own business alone.** No teammate can change its role, and nothing can remove it.
- **It is not the dev seed.** `pnpm db:seed`'s accounts belong to the development stack; this one is built by its own
  script, with its own guard, and neither touches the other. (On a development machine `pnpm db:reset` clears both, of
  course. The demo business that matters lives in the hosted project, which nothing resets.)

## What's in it

Twelve customers and three companies around Houston, a Jobs pipeline with seven leads spread across New, Quoted,
Scheduled, Won and Lost, five tasks (two done), eight notes, calls and visits on the timeline, six appointments across
this week, two estimates waiting and three invoices — one paid in cash, one sent and unpaid, one still a draft. The
customers were created at staggered times over the last few months, so it reads like a business that has been running
rather than one made this morning.

Every number is a 555 number and every customer address is an `example.com` or `.example` domain, both of which can
never reach a real person.

## What a reviewer can and can't do

| Can                                                                        | Can't, and why                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Open every tab, read every record, move a lead, complete a task            | See a conversation or a call — the business has no phone number yet                                                  |
| Make and reschedule an appointment                                         | Book through the public booking page: the demo calendar is a draft, which is all staff booking needs                 |
| Write an estimate or an invoice, and record cash against one               | Take a card payment: that happens on the provider's own page, and the demo business has no payment account connected |
| Turn the phone to airplane mode and watch changes queue and then send      | —                                                                                                                    |
| See the Assistant's consent screen, because this account hasn't agreed yet | —                                                                                                                    |
| Delete the account from More → Settings, which is what Apple checks for    | —                                                                                                                    |

The two gaps are honest and both are said out loud in the review notes in
[`listing-app-store.md`](listing-app-store.md). **The inbox is the one worth closing before the first submission**, and
it is the only thing about the demo that costs money: see the checklist.

## Seeding it

```sh
HFOS_DEMO_PASSWORD="$DEMO_PASSWORD" pnpm db:seed:demo
```

Against the hosted project, the same command with the hosted project's connection variables in the environment
(`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, `DATABASE_URL_WORKER`,
`SUPABASE_DB_URL`). Never put them in a file in this repository.

`apps/worker/scripts/seed-demo.ts` is the script, and its header explains the three rules it keeps. The one that
matters most: **it needs no carrier, no mailbox, no payment provider and no worker running**, which is why it is the
only seed in this repository that can be pointed at production at all — the development stand-ins refuse to load when
`NODE_ENV=production`, and this script never asks for one.

It runs once. If the reviewer's account already exists it says so and changes nothing, so it can't double the data by
accident.

### It can't be un-seeded, and that is on purpose

A business cannot be deleted from HandsFreeOS. Tried, on the local stack: deleting the organization cascades to its
memberships and `private.protect_last_org_owner()` stops it ("An organization must keep at least one Owner"); past
that, `app.events` and `app.audit_logs` both hold it with ON DELETE RESTRICT; past _that_,
`private.forbid_change()` answers "app.audit_logs is append-only". Three guards, all deliberate — the same design that
makes account deletion anonymize a person rather than delete them.

So don't plan on undoing it. To build a different demo business:

- **locally**, `pnpm db:reset` and seed again;
- **on a real project**, seed a second one under another address (`HFOS_DEMO_EMAIL=…`) and point both consoles at
  that one. The old one sits there costing nothing.

Which is a good reason to get the customer list and the story right before running it against the hosted project.

## Before the first submission

1. **Make `app-review@handsfreeos.com` a real mailbox.** Nothing in the reviewer's path needs it, but a password reset
   or a future sign-in change would, and it is the address in two store consoles.
2. **Give the demo business a phone number**, so the inbox and the call log have something in them. One number in the
   HandsFreeOS Twilio subaccount, bought in the app under Texting & calls, is a dollar or two a month. Then either
   have a few conversations with it from a phone Chris owns, or extend the seed to forge received messages now that
   there is a number for them to have arrived at.
3. **Re-seed after go-live, not before.** The demo business lives in the hosted database, and it should be seeded once
   the hosted project is the real one so it isn't lost in a migration.
4. **Check the password in a real build**, on both phones, before handing it to a reviewer: sign out, install fresh,
   tap **Use my password**, and get in.
