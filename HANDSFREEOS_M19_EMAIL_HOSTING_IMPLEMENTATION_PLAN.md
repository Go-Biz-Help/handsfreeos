# M19 — HandsFreeOS is the business's email

Today a business can send from its own domain, but its mail still arrives somewhere else: Gmail,
Outlook, or a host it pays for. HandsFreeOS only hears the replies to what it sent, and mail to the
business's `…@mail.handsfreeos.com` address. M19 lets a business point its domain's mail at
HandsFreeOS, so every address at `lonestarhvac.com` arrives here and nobody needs Google or Outlook
for email.

It starts with HandsFreeOS itself: `chris@handsfreeos.com` becomes Chris's own mailbox in the
HandsFreeOS business. Then the same thing opens to every business.

## Decisions (Chris, 2026-09-29)

| Question                              | Answer                                                                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who gets it                           | **Every business**, so nobody has to have Google or Outlook                                                                                                                                                      |
| Mail from people who aren't customers | **Kept and sorted aside**: customer mail in the Inbox as today, the rest in **Other mail**, junk in **Spam**. Nothing is lost.                                                                                   |
| A person's own address (`chris@…`)    | **Private to that person.** Shared addresses (`office@…`) go to the team Inbox. The person can move a customer thread from their mailbox into the team Inbox.                                                    |
| Rollout                               | **This plan, then HandsFreeOS's own business** on `handsfreeos.com`, then every business                                                                                                                         |
| `handsfreeos.com`                     | HandsFreeOS's own business may send and receive on it. `support@` and `help@` stay with the support desk. This replaces "the two routes never meet" (the support desk, 0070) for every address except those two. |
| Price                                 | **No extra cost.** Receiving comes with every plan.                                                                                                                                                              |
| Postmark plan                         | **Platform, when Step 6 needs it.** Chris upgrades then. Until then the support server already covers `handsfreeos.com`.                                                                                         |
| When a person leaves                  | **An owner decides**, address by address, since a person's address may really be a shared one like `support@`. Make it shared, give it to someone else, or remove it.                                            |

Carried over, not re-asked:

- Every change is a command, row-level security decides who sees what, and providers talk to the
  worker.
- Every business keeps its `…@mail.handsfreeos.com` address, and it keeps working after the business
  receives on its own domain.
- No other business may use `handsfreeos.com` or any subdomain of it. The `email_domain_ours`
  refusal stays for everyone else.
- A business proves a domain is its own before it sends or receives on it.

## Where it stands today

| Piece                                | Before M19                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receiving at a business's own domain | Not built. Only `mail.handsfreeos.com` has an MX to Postmark, and the worker only routes recipients there (`routeInbound` in `apps/worker/src/http/email.ts`).                                                  |
| Sending from its own domain          | Built: `email_domain.add`, DKIM and Return-Path, a daily check (`packages/core/src/commands/email.ts`, `apps/worker/src/handlers/email.ts`, `apps/worker/src/scheduled.ts`).                                    |
| Replies                              | Come back through `Reply-To: <slug>+<token>@mail.handsfreeos.com`, even on a business's own domain.                                                                                                             |
| Addresses                            | Belong to the business. `app.email_addresses` has no owner.                                                                                                                                                     |
| Private mail                         | None. Every thread is readable by the whole business, apart from the opt-in "each member sees their own threads" (0083), which never hides anything from owners and admins.                                     |
| Mail from strangers                  | Lead intake makes a customer and a lead (up to 50 a day). Automated mail, and mail over the cap, waits in **Mail from people not in Contacts**.                                                                 |
| Automatic mail (lists, auto-replies) | Dropped before it is stored (`isAutomatic` in `apps/worker/src/processors/postmark.ts`).                                                                                                                        |
| Spam                                 | Never read. Postmark's `X-Spam-Score` is ignored.                                                                                                                                                               |
| `handsfreeos.com`                    | Refused by core and by a check on `app.email_domains`. Its MX goes to Postmark's **HandsFreeOS Support** server. The worker keeps `support@` and `help@` and drops the rest, so mail to `chris@` is lost today. |
| Postmark                             | One inbound domain per server. Pro allows 10 servers, Platform has no limit. The worker holds the account token but never calls `/servers`.                                                                     |
| DNS checks                           | TXT and CNAME only (`apps/worker/src/email/dns.ts`). No MX.                                                                                                                                                     |
| Writing to anyone                    | Built: `message.send` takes `toEmail`.                                                                                                                                                                          |

## How it works

### Receiving on a domain

- A verified sending domain can also **receive**. `app.email_domains` gains `receiving` (`off`,
  `pending`, `on`, `lapsed`), `inbound_server_id` and `mx_verified_at`.
- Turning it on (`email_domain.receive`, `channels.manage`, risk 2) shows one record:
  `MX @ 10 inbound.postmarkapp.com`. The worker creates a Postmark server for the domain
  (`POST /servers` with `InboundDomain`, `InboundHookUrl` and `InboundSpamThreshold`). It checks the
  MX every 15 minutes while pending and once a day after, as it does for branded domains. Receiving
  is `on` only once the MX answers.
- Only a verified domain can receive: DKIM and Return-Path already prove the business controls its
  DNS. Before Step 6 opens it to everyone, email domains also get the fix branded domains got in
  `20261012050100`: a name is held only once it is proved, so nobody can sit on a name another
  business needs.
- The worker routes a recipient on a receiving domain through a new
  `private.email_receiving_route(address)`: the address itself, or else the domain's catch-all (the
  business's default shared address). Mail is never dropped because nobody has that address.
- Routing order in the webhook: the support desk (`support@` and `help@handsfreeos.com`), a reply
  token, `mail.handsfreeos.com` addresses, then receiving domains.
- On a receiving domain the business sends with **no Reply-To**. The reply comes straight to the
  address, and In-Reply-To and References thread it (`email.receive` already does). A business that
  only sends keeps today's Reply-To.

### Sorting: Inbox, Other mail, Spam

- `app.conversations` gains `folder` (`inbox`, `other`, `spam`), default `inbox`.
- `email.receive` files each new thread:
  - **Spam**: Postmark's `X-Spam-Score` at 5 or above. Postmark's own threshold on the server stays
    high, so it refuses only the worst.
  - **Other mail**: automatic mail (lists, receipts, auto-replies), now kept instead of dropped, and
    strangers that lead intake doesn't take (it's off, over the cap, or the mail looks automated).
  - **Inbox**: customers, replies, and strangers lead intake turns into leads, as today.
- A thread keeps its folder, and a new message in it doesn't move it. **Move to Inbox** links or
  creates the contact (today's claim). **Not spam** moves a thread to Other mail. Either can also
  save a sender rule, "Always put mail from this sender in …" (`app.email_sender_rules`).
- Threads in Other mail and Spam emit `email.filed`, not `message.received`. So the AI teammate,
  workflows, push, the Action Center, the contact's timeline and the customer summary never see them.
  Moving a thread to the Inbox starts all of those from its next message.
- Spam is deleted after 30 days. Other mail is kept like any mail.
- **Mail from people not in Contacts** folds into Other mail. A data migration turns its rows into
  Other threads, and the list leaves Settings → Email.

### Private mailboxes

- `app.email_addresses` gains `owner_user_id`. An address with an owner is that person's mailbox, and
  only its owner sends from it. Only an address on the business's own domain can have an owner, and
  never the default one.
- `app.conversations` and `app.messages` gain `private_to`, set from the address's owner. The
  whole-business select policies gain "and it isn't private", and a third policy shows a private
  thread to its person. So owners and admins don't read someone else's mailbox either.
  `packages/db/test` proves it.
- **A private thread is never linked to a customer** (a check on `app.conversations`). Almost
  everything that copies mail where the team can read it finds that mail through the customer:
  the timeline, the AI's notes on a customer, campaigns, workflows and the Action Center. So an
  unlinked thread reaches none of them. It also emits `email.filed` or `email.private_queued`,
  never `message.received` or `message.queued`, writes no timeline activity, and keeps who and what
  out of the audit log. The Assistant can read a person's own mailbox, because it runs as that
  person.
- Attachments stay where they are. Storage refuses a file on someone else's private message,
  through an index over private messages' files.
- **Share with the team** (`conversation.share`, the owner only) clears `private_to` on the thread
  and its messages, and links it to the customer whose address it is. From then on it is a normal
  team thread.
- Private threads have the same folders, so each person has their own Inbox, Other mail and Spam.
- **When a person leaves**, each address they read waits for an owner (`email_address.reassign`,
  owners only), and the Action Center asks. The owner can:
  - **make it shared**: its mail, old and new, moves to the team Inbox;
  - **give it to someone else**: its mail goes with it;
  - **remove it**: the address and its mail are deleted.

  Until an owner decides, new mail to the address goes to the team Inbox, so nothing is missed. The
  old mail stays unread by anyone. While the person is still with the business, only they can share
  their mail.

### HandsFreeOS's own business

- `app.workspaces` gains `is_platform`, which only a staff admin sets (`own_business.set`, the
  pattern of `phone_model` in `20261010000800`). A domain belongs to one business, so only one of
  them can hold `handsfreeos.com` at a time.
- The check on `app.email_domains` becomes a trigger that allows `handsfreeos.com` itself for that
  workspace only. Subdomains stay refused for everyone. Core's `email_domain_ours` refusal lets that
  workspace through for the bare domain only.
- On `handsfreeos.com`, the reserved names stay reserved for that workspace too: `support`, `help`,
  `no-reply`, `alerts` and the rest of `RESERVED_LOCAL_PARTS`.
- Postmark already knows `handsfreeos.com`. It sends as it (`no-reply@`, `alerts@`), and the
  **HandsFreeOS Support** server already receives it. So nothing new is made at Postmark and no DNS
  changes. Receiving turns `on` once the worker sees the MX answer.

## Screens

- **Settings → Email**
  - "Use your own domain" gains **Receive mail here too**, with the MX record and a plain warning:
    "Once you change this, mail to every address at lonestarhvac.com comes to HandsFreeOS instead of
    where it goes now. Add everyone's address first."
  - Each address shows **Who reads it**: the team, or one person.
  - Every domain shows, not just the first (today only `domains[0]` does).
- **Inbox**, on the web and the phone: **My mail** (private), **Other mail** and **Spam** beside
  Mine, Unassigned and All. In a thread: **Move to Inbox**, **Not spam** and **Share with the team**.
- One batched change to `apps/sync/sync-config.yaml` carries `folder` and `private_to` to the phone
  (made in Step 3, since private mail must never reach another phone).
  It narrows the streams in place, as 0083 did, so no app build syncs mail its person shouldn't see.

## Build order

Each step is its own commits, with CI green before the next. Each migration goes on the hosted
database before its step reaches `main`.

### Step 1 — Receive on a domain (built, 2026-09-29)

1. Migration: the `receiving` columns, `private.email_receiving_route`, `workspaces.is_platform`, the
   `handsfreeos.com` trigger, and the reserved names on `handsfreeos.com`. The Drizzle mirror.
2. Core: `email_domain.receive`, `email_domain.stop_receiving` and `email_domain.record_receiving`,
   `own_business.set` (staff admins only), the `email_domain_ours` exception, and their error
   messages. Until Step 6 only HandsFreeOS's own business can turn receiving on
   (`email_receiving_not_yet`).
3. Worker: MX lookup in `dns.ts`, the receiving check job, routing in `http/email.ts`, and no
   Reply-To on receiving domains.
4. Tests: routing (the address, the catch-all, the support desk first), the `handsfreeos.com`
   exception, and who may set the flag. Creating Postmark servers waits for Step 6, since the support
   server already covers `handsfreeos.com`.

**As built:**

- Routing tries the address the mail was delivered to (Postmark's `OriginalRecipient`) first when
  it is on a receiving domain, then a reply token or a `mail.handsfreeos.com` address, then a
  receiving domain the headers name. Each receiving domain will have its own Postmark server, so a
  copy goes to the business it was delivered for, whatever its To line says.
- More than one business may carry the flag. `handsfreeos.com` itself can still belong to only one
  of them, since a domain belongs to one business.
- Removing `handsfreeos.com` from the business's settings never removes it at Postmark, because
  `no-reply@`, `alerts@` and the support desk send as it.
- The MX check lives on the mail service (`receives(domain)`). The local stand-in says yes except
  for `nomx-…` domains, and `lapsed-…` domains say yes once, then no.

### Step 2 — Other mail and Spam (built, 2026-09-29)

1. Migration: `conversations.folder`, `app.email_sender_rules`, and folding in the unmatched mail.
2. Core: filing in `email.receive`, `email.filed`, `conversation.move`, sender rules, and the new
   `inbox.list` boxes.
3. Worker: keep automatic mail, read `X-Spam-Score`, and delete spam after 30 days.
4. Tests: nothing that reacts to `message.received` fires for Other mail or Spam.

**As built:**

- **Steps 2 to 4 reach `main` together.** The phone syncs a fixed list of thread columns and has no
  folder yet, so until Step 4's sync change it would show Other mail and Spam in its Inbox. The web
  already keeps them apart: `inbox.list` has `other` and `spam` boxes, and every other box and the
  badge counts are the Inbox's.
- A new thread's folder, in order: a sender rule; a customer's mail (a contact, or an address with
  an Inbox thread) in the Inbox; a stranger's mail at `SPAM_SCORE` (5) or more in Spam; a stranger
  already set aside, a machine or an address that bounced in Other mail; then lead intake, which
  puts a stranger it takes in the Inbox and one it doesn't in Other mail.
- A customer's automatic mail (an out-of-office) is still not filed, as before, so it never opens
  or wakes their thread. A stranger's is kept in Other mail.
- Other mail and Spam emit `email.filed`, write no timeline activity, and count as unread, but set
  no "waiting for a reply" and schedule no reminder.
- **Mail from people not in Contacts** keeps the rows it already has, which can still be claimed
  or dismissed; no new mail goes there. The list leaves Settings → Email in Step 4 once it's empty,
  rather than by a data migration.
- `conversation.move` is for email threads only. `email_sender_rule.remove` forgets a rule; the
  list of rules comes with the screens in Step 4.
- Spam goes in a daily sweep (`email.spam_sweep`) through `private.delete_old_spam`, 200 threads at
  a time, and their attachments are removed from storage.

### Step 3 — Private mailboxes (built, 2026-09-29)

1. Migration: `email_addresses.owner_user_id`, `private_to` on conversations and messages, the
   policies, and the storage paths.
2. Core: an owner on `email_address.create` and `email_address.update`, who may send from it,
   `conversation.share`, `email_address.reassign` for when a person leaves, and keeping private
   threads away from activities, summaries, the Action Center and the AI teammate.
3. Tests in `packages/db/test`: an owner, an admin and a member can't read someone else's mailbox, its
   messages or its attachments.

**As built:**

- The sync change moved here from Step 4. Private mail reaches only its person's phone: a private
  thread's viewer list is them alone, so the existing `me_v1` arm carries it, and `business_v1`'s
  conversations and messages send only `private_to IS NULL`. Conversations add `folder` and
  `private_to`, and addresses add `owner_user_id`, in place (the header of `sync-config.yaml` says
  why). The phone's Inbox shows team Inbox threads only until Step 4 gives it boxes. Run `sync.yml`
  on the branch before this reaches `main`.
- Which mailbox a new email is in: the thread already on the address it came to decides, and a new
  one belongs to that address's person. A token or header match counts only when it is as private
  as the mail, so a reply never crosses between someone's own mail and the team's.
- The "latest thread" every automatic send uses (reminders, invoices, workflows, the AI teammate) is
  the team's only (`latestConversation`), so HandsFreeOS never writes into someone's own mail.
- The AI teammate can't pick a person's own address. The composer offers only the team's addresses
  and the person's own, and in a thread, only the ones that may answer there.
- Sender rules can't be saved from someone's own mailbox, because they are the team's.
- Removing a departed person's address deletes its mail at once, and a job removes the files. This
  replaces the 30 days first planned, since nothing could bring the mail back meanwhile.
- Push for someone's own mail came with Step 4.

### Step 4 — Screens (built, 2026-09-29)

Settings → Email and the Inbox on the web, the phone's boxes, push for someone's own mail, and
`pnpm openapi`. (The sync change was made in Step 3.)

**As built:**

- **Inbox, web and phone.** Beside Mine, Unassigned and All: **Other mail** and **Spam**, and **My
  mail** for whoever has an address of their own (`inbox.summary`'s `mail.own`). My mail has its own
  Inbox, Other mail and Spam, and a way back to the team's inbox. The web keeps it in the address
  (`?mail=mine`, `?box=other`); the default view adds nothing. The badges: unread in My mail and
  Other mail, and everything in Spam. Archived lists threads put away from any folder.
- **In a thread.** Email threads move between the folders from the More menu (the phone's sheet):
  from the Inbox to Other mail or Spam, from Other mail to the Inbox or Spam, and from Spam, **Not
  spam** (to Other mail) or the Inbox. The team's threads also offer "Always put their mail in …",
  which saves the sender rule. The list is `mailMoves` in core, shared by both.
- **Adding or linking the customer is the claim.** `conversation.link_person` puts an email thread
  in the Inbox, so a stranger's thread in Other mail becomes a customer's in one step. It never
  links the linker's own thread from the same address, which the database would refuse.
- **Someone's own thread** says "Only you" and offers **Share with the team**. It has no Assign,
  no Hand to the AI and no Add person, and its sender rules aren't saved.
- **Settings → Email.** Every domain shows (up to three), with "Another domain" to add one.
  - Each address on a domain says who reads it. The team's can be given to one person, which asks
    first, since only an owner can move it again, and only once they've left.
  - Once its person has left, the address offers the owner's three choices.
  - A new address becomes the default only while no domain address is.
  - **Receive mail here too** shows where receiving is open (HandsFreeOS's own business until
    Step 6), with the MX record, the plan's warning, and Stop.
  - **Where senders' mail goes** lists the sender rules, each with Remove.
  - **Mail from people not in Contacts** shows only while old rows remain.
- **The composer** labels someone's own address "(yours)". The phone's From address never picks
  an address someone owns for a team thread.
- **Admin.** A business's page in `/admin` sets "HandsFreeOS's own business" (staff with
  `platform.own_business.manage`).
- **Push.** New mail in someone's own Inbox buzzes their phones alone (`onOwnMailPush`, on
  `email.filed`). It uses the customer-message switch and category, whose Reply and Call work on
  it and which every app build knows. Other mail and Spam push nobody.

### Step 5 — HandsFreeOS's own business

Set `is_platform` on the HandsFreeOS business, add `handsfreeos.com`, add `chris@` as Chris's
mailbox, then send and receive from outside. `docs/operations.md` gets a short section on it.

**As prepared (2026-09-29):**

- No code is needed. The support server already receives all of `handsfreeos.com` and posts it to
  the same webhook, where the worker routes every address but `support@` and `help@` to the
  business that receives there. The production server already sends for the domain, and adding
  `handsfreeos.com` reuses the domain Postmark has.
- The steps are "Postmark Part M" in `docs/operations.md`: mark the business in `/admin`, add
  the domain and `chris@` (Only Chris) in Settings → Email, click Receive mail here, and test from
  outside.
- Before them, Steps 1–3's migrations go on the hosted database and Steps 1–4 reach `main`
  together, once CI and `sync.yml` are green on the branch.

### Step 6 — Every business (built, 2026-09-30)

1. Chris moves Postmark to the Platform plan, which has no limit on servers (Pro stops at 10).
2. Email domains are held only once proved, as branded domains are (`20261012050100`).
3. Worker: create and remove a Postmark server for each receiving domain, all posting to the one
   webhook address.
4. `docs/operations.md`: turning it on, the MX change, moving back to another host, and trouble.
5. Offer it: a business turns it on in Settings → Email.

**As built (2026-09-30):**

- **Open to every business.** `email_domain.receive` no longer asks whether the business is HandsFreeOS's own.
  The Postmark plan is the limit: Pro's 10 servers leave room for seven receiving domains. Past that, the
  business is told to ask support, and the worker logs an error.
- **A server per receiving domain.** The worker makes it when a business asks to receive
  (`openInbound`), named `Inbound · <domain>` so a retry or a domain turned on again finds it.
  - It only receives. It posts to the one webhook, and the spam threshold is 15, so Postmark refuses only the
    worst.
  - A refusal (602: another account receives the domain; 614: no room) turns receiving back off, and Settings →
    Email says why (`receiving_error`).
  - Stopping or removing closes the server: it's removed, or unhooked where Postmark won't let the API remove it.
  - handsfreeos.com keeps the support desk's server.
- **Proved by the business that claims it.** Every claim has a token for a TXT record at `_hfos-verify.<domain>`,
  as branded domains do.
  - A domain is verified only once its token was found.
  - The unique index covers verified claims only, a pending claim squats nothing, and one business at a time
    receives a name.
  - Postmark keeps one domain per name, so giving a name back to Postmark waits until no business claims it.
  - Domains verified before this change are recorded as proved.

## Not in this milestone

- Reading HandsFreeOS mail in Apple Mail, Outlook or Gmail (IMAP or POP).
- Bringing a business's old mail over from Google or Outlook.
- Vacation replies, forwarding to another address, and folders beyond Inbox, Other mail, Spam and
  Archive.
- Personal addresses on `mail.handsfreeos.com`.
- Uploading a new file to attach to an email from someone's own mailbox. A customer's files can
  still be attached, since they are on the customer's record for the team anyway.
