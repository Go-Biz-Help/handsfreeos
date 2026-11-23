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
- Mail for a domain still waiting on the MX check (`pending`) is filed too, once Postmark has made the domain's
  server: Postmark hands us its mail from then on, before our check says `on`. The owner's decision, 22 Nov 2026
  ("Yes, file it in the Inbox"), after a business that had just moved its MX had mail arrive and go unfiled.
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

**Own mail in the same list (Chris, 2026-11-10).** Chris didn't want his own mail kept apart from
the team's, so it now shows in one list with a mark. His picks:

- **Web and phone.** `inbox.list` (`mailbox` `team`) returns the team's threads and the viewer's own,
  and core's `inInbox` does the same on the phone, which already held its person's own threads. No
  migration and no sync change.
- **The mark** is a lock and **Only you** on the row (`conversationChips`' `private` chip, first),
  the same words the thread shows inside.
- **Which boxes.** Someone's own mail is theirs, so it's in **Mine** and **All**. It's never in
  **Unassigned**, **Needs a person** or the AI teammate's box. Their own Other mail and Spam show
  in the team's **Other mail** and **Spam**, and Archived lists theirs too.
- ~~**My mail stays** as a filter that shows only their own, with its own Inbox, Other mail and
  Spam.~~ Gone the next day, below.
- **Badges** count their own unread mail in Mine and All (and the menu's Inbox badge), on their
  screen only. Waiting, Needs a person and the AI teammate's count stay the team's.
- **The AI teammate never reads or answers anyone's own mail**, as before. (Changed 2026-11-22: it
  reads and drafts on an address whose own person turns the switch on, and still never answers. See
  "Let Ava read this mail" below.)
- A sender who writes to both someone's own address and a team one is **two rows**, never one with
  two lanes (`GROUP_KEY` and `customerKeyOf` keep own mail apart), so sharing or answering one never
  reaches the other.

**One Inbox, no My mail page (Chris, 2026-11-11).** The row of My mail, Other mail and Spam buttons
still opened a page of his own mail, and Chris wanted one Inbox. He picked design A from the
"One Inbox" canvas:

- **The three buttons and the My mail page are gone**, on the web and the phone. His own mail is
  only ever in the one list, marked **Only you**. An old `?mail=mine` link shows everything.
- **Other mail and Spam move into the menu beside the search**, under Open, Snoozed, Closed and
  Archived (core's `INBOX_SHOW`, `inboxShowOf`, `inboxShowPick`). Other mail shows its unread count
  and Spam how many it holds, and a **dot** on the menu means something unread waits in Other mail.
  Picking a status keeps the box (Mine stays Mine); picking Archived, Other mail or Spam shows that
  box's open conversations, and a status from there goes back to the person's usual box.
- **On the phone it's one chip** in place of Open, Snoozed and Closed, opening a sheet with the same
  choices less Archived, which never reaches the phone.
- Other mail and Spam show **a line above the list** saying what's in them and how a thread gets
  out (Move to Inbox, Not spam), with **Back to Open**.
- At phone width on the web the menu sits beside **Unread**, since the search is in the top bar.
- The Assistant keeps `mailbox` `mine` for "only my own mail"; only the screens lost the page.

**Changing addresses after setup (Chris, 2026-11-22).** Burroughs Digital added `blake@` first, so
it became the address customers hear from and could never be Blake's own. Chris approved the
"Guided email setup" canvas ("after setup also need to be able to change the email, add more, change
who can see it"). Its Settings part and the switch that lets the AI teammate read someone's own
mail (below) are built; the guided questions come next. What changed from the rules above:

- **Settings → Email opens on Your addresses.** Each row says who reads it and which one customers
  hear from (the default; the free address is the **Backup** once an own address is). **Change**
  opens one box: rename it while it has carried no mail, pick who reads it, make it the one
  customers hear from, or remove it. **Add an address** is a box too, on any verified domain.
- **The default can become one person's own.** `email_address.update` takes `defaultToId`, the team
  address that takes over, and does both in one go. Without it the refusal
  (`email_address_owner_default`) asks for one.
- **Its own person hands an address back to the team** (`ownerUserId: null`,
  `private.hand_back_email_address`). The mail they already got stays theirs alone; new mail is the
  team's. Nobody else can do it for them, and it never goes straight to another person
  (`email_address_owner_is_theirs`). Once they've left, an owner still decides, as before.
- **One address can be removed on its own** (`email_address.remove`,
  `private.remove_email_address`), where before it only went with its whole domain. The mail it
  carried stays where it is. New mail to it goes to the domain's catch-all, the team's Inbox, since
  mail is never dropped because nobody has that address. Never the default, never the last free
  address (the backup), and a person's own only by that person.
- **The Assistant** does the same on Confirm cards: `manage_email_settings` hands back and names the
  takeover, and `do_email_address_remove` removes one address, keeping its mail. Removing a left
  person's address with its mail is still never offered.
- Changing or removing an address takes `channels.manage`, so someone without it asks an owner or
  admin to add the address again as the team's.

**Let Ava read this mail (Chris, 2026-11-22).** "Need to add a toggle that allows Ava to read the
Only me emails and it can be changed after setup as well." This reverses the 2026-11-10 pick above
for the addresses whose own person says so, and only this far: the AI teammate reads and drafts, and
the person sends.

- **The switch is on the address** (`email_addresses.ai_reads`), under each of a person's own
  addresses on Settings → Email, and in the Add and Change boxes while **Only me** is picked. It
  starts off.
- **Only the address's own person turns it on** (`email_address.set_ai_reads`, through
  `private.set_email_address_ai_reads`). Not an admin adding their address, and not an owner: the
  refusal (`email_address_ai_reads_is_theirs`) says whose it is. People can't write the column any
  other way, and a team address has no such switch (`email_address_ai_reads_team`: the team's mail
  follows the teammate's own Channels). It takes `inbox.use`, not `channels.manage`, so a member
  without Settings can still ask the Assistant to flip it.
- **It goes off when the address changes hands** (handed back, given to someone else): the yes was
  one person's.
- **What on does.** New mail to the address that lands in their Inbox queues one job per thread
  (`ai_teammate.own_mail_draft`, on `email.filed`, after a short wait so a few mails get one draft).
  The teammate reads the last six mails of the thread, the business profile and its knowledge, and
  writes a draft answer as the person. Newsletters, automatic mail, Other mail and Spam get none,
  and neither does a thread they already answered. A teammate that is off drafts nothing.
- **Where the draft lives.** On the thread itself (`conversations.ai_draft`: the words, which mail it
  answers, when), never in the team's drafts or the teammate's runs, which the whole business reads.
  A check keeps it on private threads only, so the policies that hide the thread hide the draft.
  It goes when they answer, when new mail comes, when they put it away
  (`conversation.ai_draft_dismiss`), when the thread stops being theirs (shared, or reassigned), and
  when they turn the switch off.
- **Nothing is sent.** The thread shows the draft on a card marked **Only you see this**, with
  **Use this draft** (it fills the message box, where they change what they like and send as
  themselves) and **No thanks**. There is no run, tool call, customer link, task or approval, and
  only its person can send from the address, as before.
- **What the history says.** That the switch changed and that a draft was made on a private thread,
  never its words or who wrote in. The tokens count toward the business's daily AI limit as the
  teammate's.
- **The Assistant** flips the switch on a card that names the address and the teammate
  (`do_email_address_set_ai_reads`), reads the draft back to its person in `get_conversation`
  (`draftAnswer`), and puts it away (`do_conversation_ai_draft_dismiss`). It runs as the person, so
  nobody else is read a draft.
- **The phone** has the switch in its guided setup ("Who reads each one?"), and shows the draft in
  a thread on the same card (`apps/mobile/src/components/inbox/own-mail-draft.tsx`). The draft isn't
  in the phone's copy: it is asked of `conversation.get` while there's signal
  (`src/inbox/use-own-mail-draft.ts`), when the thread opens, when new mail shows (again after 8
  and 30 seconds, since the teammate writes a little after the mail lands) and when the app comes
  back to the front. So it needed no sync change. The card's words are core's
  (`OWN_MAIL_DRAFT_WORDS`).

**The guided questions: what the server does (Chris, 2026-11-22).** The same canvas, one question at
a time: which email, the addresses, who reads each one, the one customers hear from, where mail
arrives, then **Check it over** and **Set it up**. The server side is below, then the web screens;
the phone's come next.

- **The questions' rules live once**, in `packages/core/src/messaging/email-guided.ts`: the answers
  (`EmailGuidedAnswers`), which screens a path has, what each screen still needs
  (`emailGuidedProblems`), the plan the answers make, and every word the screens say
  (`EMAIL_GUIDED_WORDS`). The web and the phone both read it. `email_setup.get` hands back the
  answers to start from (`guided`).
- **Nothing changes until Set it up.** A website name is looked up before it is added
  (`email_setup.look_up`): the worker reads its mail and name-server records and files what it saw
  in `app.email_domain_lookups`, one row a business, so the first question can say where the name
  is looked after and where its mail goes today. A name that doesn't exist says so. Forty look-ups
  an hour a business (`email_lookup_limit`).
- **Set it up is one command** (`email_setup.apply`). It checks the answers again, adds the name if
  it is new, and writes the plan (`email_domains.plan`): the team address customers hear from, the
  other addresses (`addresses`, each the team's or one person's own), and whether mail arrives in
  HandsFreeOS. A verified name gets its addresses at once; a new one gets them when its records
  verify, as before, and the free address carries the mail until then.
- **It only adds.** An address already set up keeps who reads it, and none is removed. Those changes
  stay in Settings → Email, where each one is asked on its own.
- **"Let Ava read this mail" in a plan is its own person's to write.** A trigger on the plan
  (`email_domains_plan_ai_reads_guard`) refuses a person planning the switch on for someone else's
  address, so the yes that the worker carries out later is still theirs.
- **The old mail records.** The worker keeps the name's MX records as it last saw them
  (`email_domains.mx_records`, with priorities). The last step lists ours to add and the old ones
  to delete, and says which are still there; the steps email names them too. Receiving still turns
  on only when ours is the only record at the lowest priority.

**The guided questions: the web screens (Chris, 2026-11-22).**

- **One page**, `/onboarding/<business>/email`, on the shared guided-setup frame
  (`apps/web/src/components/guided-setup/frame.tsx`): the questions and Check it over in
  `email-setup/guided-flow.tsx`, the last step and Done in `email-setup/guided-last.tsx`. Only
  someone who can change the business's email opens it.
- **The answers save as they are given** (`guided_setup.save_draft`, setup `email`), with the
  question they were left on and who was answering, so leaving and coming back lands on the same
  question. Nothing is saved until something is answered, and Set it up puts the saved answers away.
- **The last step** is for a website name with something left: its records to add, then our mail
  record to add and the old ones to delete, each marked found or still there. It checks again on its
  own every minute for ten minutes, and **Send these steps** emails them to whoever looks after the
  website. What it lists and says is worked out once, in core (`emailGuidedLastStep`,
  `emailGuidedDone`), for the phone too.
- **Home's card** (`emailGuidedHomeOf`) says "Set up your business email", "Finish your email
  records" or "Bring your mail in", and opens the page on the questions or the last step.
- **Settings → Email** has no form for typing a website name any more. With none yet, **Use your own
  website name** has **Set it up**. With one, **Your website name** has two rows, **Mail coming in**
  and **Records** (folded once they're all found), **Open the steps** while something is left, and
  **Run the guided setup again** under it. The Assistant still adds a name without the questions
  (`manage_email_settings` add_domain), and does Set it up itself (`do_email_setup_apply`).
- **Addresses in the page's address:** `?from=settings` (Finish later goes back to Settings),
  `?at=records` (the last step), `&d=<website name's id>` (which one, with more than one),
  `?again=1` (the questions, whatever is left) and `?done=1` (Done).
- **Not built yet:** "Send a test" on Done and in Settings.

**The guided questions: the phone's screens (Chris, 2026-11-22).**

- **The same setup, one question a screen.** Home's card opens it full screen
  (`app/w/<business>/email-setup`): the questions and Check it over in
  `apps/mobile/src/components/email-setup/guided-flow.tsx`, the last step and Done in
  `guided-last.tsx`. It reads the same rules and words as the web
  (`messaging/email-guided.ts`) and saves the same answers (`guided_setup.save_draft`), so answers
  begun on the web carry on here, and the other way round. `?at=records`, `&d=` and `?again=1` mean
  what they do on the web.
- **The phone's frame for guided setups** is `apps/mobile/src/components/guided-setup/frame.tsx`,
  with the web frame's names (`GuidedPage`, `ChoiceTile`, `GuidedFooter`, `WelcomeBack`,
  `useGuidedDraft`): the question's number and Saved in the top bar beside **Finish later**, how far
  along under it, Back and Next pinned at the bottom. The other guided setups use it too.
- **What only the phone says** is in `apps/mobile/src/email-setup/words.ts`: "tap" where the web
  says "click", and that Settings → Email is on the web. The phone has no Settings → Email, so
  Done's **Email settings** opens it in the browser.
- **The last step leads with "Easier on a computer"**: **Email me the steps**, or send them to
  whoever looks after the website (`email_domain.send_steps`). The records are there too, to read
  off, hold to copy, or **Share**.
- **No live updates for email on the phone.** The setup asks again after **Check now**, every minute
  while something is left, and when the app comes back to the front. It needs signal.
- **`email_setup.save` has no screen now.** The older three-part flow from Home's card is gone, on
  the web and the phone. The command stays for phones that haven't updated, and the Assistant sets
  email up with `do_email_setup_apply` instead of `do_email_setup_save`.
- **"Saved" only once it is.** In both frames the tick dims the moment an answer changes and comes
  back once that answer is kept, and what was just answered is sent at once when the page or screen
  is left: a reload, a closed tab, Back, the app put away. Before, a reload inside the 700 ms wait
  came back a question behind.

### Step 5 — HandsFreeOS's own business (done, 2026-09-30)

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

**As done (2026-09-30):**

- `chris@handsfreeos.com` receives in **Inbox → My mail** (since 2026-11-11, the one Inbox, marked **Only you**). The domain was verified and receiving by
  00:24 UTC on 2026-09-30.
- The first test emails didn't arrive. Postmark held them, marked **Retry**, because neither the
  support server's nor the production server's inbound stream had a webhook. Setting it, with a new
  webhook password, fixed it. "Postmark Part M" now covers this under "If it goes wrong".

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
