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
  DNS. Email domains also get the fix branded domains got in `20261012050100`: a name is held only
  once it is proved, so nobody can sit on a name another business needs.
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
  only its owner sends from it. Only an address on a receiving domain can have an owner.
- `app.conversations` and `app.messages` gain `private_to`, copied from the address's owner.
  Row-level security adds `private_to is null or private_to = auth.uid()` to **every** select arm, so
  owners and admins don't read someone else's mailbox either. `packages/db/test` proves it.
- Nothing copies private mail anywhere else: no timeline activity, no customer summary, no AI
  teammate, no Action Center, no workflow. Push goes to the owner only. Attachments are stored under
  `<workspace>/private/<user>/…`, with a storage policy to match. The Assistant can read a person's
  own mailbox, because it runs as that person.
- **Share with the team** (`conversation.share`, the owner only) clears `private_to` on the thread
  and its messages. From then on it is a normal team thread.
- Private threads have the same folders, so each person has their own Inbox, Other mail and Spam.

### HandsFreeOS's own business

- `app.workspaces` gains `is_platform`, which only a staff admin sets (the pattern of `phone_model`
  in `20261010000800`). At most one workspace has it.
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
- One batched change to `apps/sync/sync-config.yaml` carries `folder` and `private_to` to the phone.
  It narrows the streams in place, as 0083 did, so no app build syncs mail its person shouldn't see.

## Build order

Each step is its own commits, with CI green before the next. Each migration goes on the hosted
database before its step reaches `main`.

### Step 1 — Receive on a domain

1. Migration: the `receiving` columns, `private.email_receiving_route`, `workspaces.is_platform`, the
   `handsfreeos.com` trigger, and proof before a name is held. The Drizzle mirror.
2. Core: `email_domain.receive` and `email_domain.stop_receiving`, `workspace.set_platform` (staff
   only), the `email_domain_ours` exception, and their error messages.
3. Worker: MX lookup in `dns.ts`, the receiving check job, routing in `http/email.ts`, and no
   Reply-To on receiving domains.
4. Tests: routing (the address, the catch-all, the support desk first), the `handsfreeos.com`
   exception, and who may set the flag. Creating Postmark servers waits for Step 6, since the support
   server already covers `handsfreeos.com`.

### Step 2 — Other mail and Spam

1. Migration: `conversations.folder`, `app.email_sender_rules`, and folding in the unmatched mail.
2. Core: filing in `email.receive`, `email.filed`, `conversation.move`, sender rules, and the new
   `inbox.list` boxes.
3. Worker: keep automatic mail, read `X-Spam-Score`, and delete spam after 30 days.
4. Tests: nothing that reacts to `message.received` fires for Other mail or Spam.

### Step 3 — Private mailboxes

1. Migration: `email_addresses.owner_user_id`, `private_to` on conversations and messages, the
   policies, and the storage paths.
2. Core: an owner on `email_address.create` and `email_address.update`, who may send from it,
   `conversation.share`, and keeping private threads away from activities, summaries, the Action
   Center and the AI teammate.
3. Tests in `packages/db/test`: an owner, an admin and a member can't read someone else's mailbox, its
   messages or its attachments.

### Step 4 — Screens

Settings → Email and the Inbox on the web, the phone's boxes, the one sync change (then run
`sync.yml` on the branch), `pnpm openapi`, and the phone's schema.

### Step 5 — HandsFreeOS's own business

Set `is_platform` on the HandsFreeOS business, add `handsfreeos.com`, add `chris@` as Chris's
mailbox, then send and receive from outside. `docs/operations.md` gets a short section on it.

### Step 6 — Every business

1. The Postmark plan (below).
2. Worker: create and remove a Postmark server for each receiving domain, all posting to the one
   webhook address.
3. `docs/operations.md`: turning it on, the MX change, moving back to another host, and trouble.
4. Offer it: a business turns it on in Settings → Email.

## Still to decide, before the step that needs it

- **Postmark plan (Step 6).** Each receiving domain needs its own Postmark server. Pro stops at 10
  servers, and at least two are in use. Platform has no limit. The other way is to receive through a
  service that takes many domains at once, such as Amazon SES, and keep Postmark for sending.
- **Price (Step 6).** Whether receiving comes with every plan or costs extra. Postmark counts every
  inbound email, spam included.
- **When a person leaves (Step 3).** What happens to their address and their private mail: it goes
  to the team Inbox, it's handed to an owner, or it's deleted after a set time.

## Not in this milestone

- Reading HandsFreeOS mail in Apple Mail, Outlook or Gmail (IMAP or POP).
- Bringing a business's old mail over from Google or Outlook.
- Vacation replies, forwarding to another address, and folders beyond Inbox, Other mail, Spam and
  Archive.
- Personal addresses on `mail.handsfreeos.com`.
