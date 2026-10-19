# Partners: reaching your customers through someone else's audience

Chris (18 Oct 2026): "add a feature where we can also identify people with large followings of our target audience,
or admins and moderators of fb groups and ask them if they'd be interested in a partnership so instead of only
reaching out to our target audience we can take advantage of another user's audience."

**Where it stands (19 Oct 2026):** Chris answered every question below on 18 Oct 2026 and said to build it. Stages 1
to 3 are built: finding and asking partners, partners in core with their page, and payouts (see "Build order").
Stage 4, finding partners by search, is built too.

Social Outreach today finds the people who might buy (docs/outreach.md). This adds a second kind of person to find:
someone who already has your customers' attention, asked to send them your way for a share of what they pay.

## Decisions (Chris, 18 Oct 2026)

| #   | Question                                             | Answer                                                                                                                                                                                                         |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who should it look for?                              | **All three:** admins and moderators of Facebook groups your target audience is in; creators whose followers are your target audience (Instagram, LinkedIn, Facebook); and businesses with the same customers. |
| 2   | How is a "large following" judged?                   | **Fit first, size second.** The AI scores how well their audience matches yours, then its size and how active it is. A busy 2,000-member local group can beat a quiet 50,000 one.                              |
| 3   | What's offered?                                      | **A commission on each client they send.**                                                                                                                                                                     |
| 4   | What does the first message ask?                     | **Whether they're open to a partnership at all.** The details and the call link go once they say yes.                                                                                                          |
| 5   | When is a commission earned?                         | **When the client pays in HandsFreeOS.** HandsFreeOS sees the payment. A client who pays some other way is marked by hand.                                                                                     |
| 6   | How much?                                            | **A share of what the client pays,** at a rate the business sets, which can differ for one partner.                                                                                                            |
| 7   | For how long?                                        | **Each payment in the client's first 12 months.**                                                                                                                                                              |
| 8   | Who pays the partner, and when?                      | **HandsFreeOS,** once a month, for payments at least 30 days old so a refund never has to be clawed back. HandsFreeOS charges the business's card the total and pays each partner.                             |
| 9   | Do partner messages wait for an OK?                  | **Always,** whatever Sending says. There's usually one chance with each partner.                                                                                                                               |
| 10  | Warm them up first?                                  | **Yes.** Follow them, like and comment on their posts, or be active in their group, for a few days first.                                                                                                      |
| 11  | Where do partners live?                              | **Their own Partners list,** with its own stages, and each partner's clients and earnings beside them.                                                                                                         |
| 12  | Do partners get a page?                              | **Yes, their own.** Their link, the clients they sent, what they've earned, and their bank details for payouts.                                                                                                |
| 13  | Can a partner be pitched as a customer?              | **Never.** Once someone's a partner prospect, they only get partner messages, on every network.                                                                                                                |
| 14  | Keep Alignable's referral swap?                      | **Yes, beside the commission** (decision 79). A business with the same customers can earn commission and get referrals back.                                                                                   |
| 15  | Which networks?                                      | **All four at once.** Instagram's and Alignable's partner steps run as soon as each network's own steps do (they're still looked at, decision 78).                                                             |
| 16  | Who pays Stripe's fees?                              | **The business,** added to its monthly charge and shown on its statement (Chris, 18 Oct 2026).                                                                                                                 |
| 17  | What's the smallest payout?                          | **$25,** with less carried to the next month. A business can set a lower one for its partners.                                                                                                                 |
| 18  | Partners outside the US?                             | **Later.** US partners first.                                                                                                                                                                                  |
| 19  | A refund made in Stripe's or Square's own dashboard? | **Recorded,** as one made in HandsFreeOS is: it counts on the invoice, and takes back the partner's share (Chris, 18 Oct 2026).                                                                                |

## How it works, in plain words

1. **A partner playbook.** A playbook whose goal is **Find partners** (already a goal; nothing reads it yet) says
   whose audience you want: your customers, as the playbook's audience, niche and area already describe them, and
   which kinds of partner to look for.
2. **Finding them.** On each network, the extension notes who runs a group your audience is in, who has a big
   following, and which businesses serve the same people. The AI checks each one: who's their audience, how well it
   matches yours, how big and how active it is.
3. **Warming up.** For a few days, Today's list likes and comments on their posts, or has you join in their group.
4. **Asking.** Then one short message, about them and their audience, asking whether they're open to a partnership.
   It waits for your OK.
5. **Yes.** The AI reads their answer. On a yes, it writes the details: what's in it for them and your link to book a
   call. That waits for your OK too.
6. **The call.** A call booked through that link moves them to **Call booked**. It isn't counted as a demo.
7. **Made a partner.** You press **Make partner** after the call. They get their own page: their referral link, the
   clients they've sent and what they've earned, and where they add their bank details.
8. **Clients.** Someone who books through their link is their client. Each payment that client makes in HandsFreeOS in
   their first 12 months earns the partner their share. A refund takes it back off.
9. **Payouts.** Once a month, HandsFreeOS adds up what's owed for payments at least 30 days old, charges the
   business's card, and pays each partner through Stripe.

## Where it goes in the code

**Social Outreach finds and asks; core keeps partners, commissions and payouts.** CLAUDE.md and
docs/addon-architecture.md say billing and other money an add-on needs are built in core as their own step, never
worked around in the add-on, and core never points into an add-on. Commissions come from core's invoices and payments,
and payouts move money, so both live in core as the **Partners** core feature (`CORE_FEATURES`), which Social Outreach
says it uses. Another add-on (Sales Coach, say) could use it later.

### What's there already (the code, 18 Oct 2026)

- **Playbooks** (`addon_outreach.playbooks`, `PlaybookDetails` in packages/core/src/addons/outreach/playbooks.ts) have
  the goal `partner`, "Find partners", which nothing reads. Their audience, niche, area, signs and skip words describe
  the people a playbook is after.
- **Group admins and moderators:** saving a group's members reads its admins and moderators first and keeps them
  (`group_people.runs_group`, without telling admins from moderators); `groups.members` holds its size, and the AI's
  group check says whether the group fits a playbook.
- **No one's following is kept:** profiles have only their mutual friends. Followers are read nowhere yet.
- **The AI's check** (`checks`, packages/core/src/addons/outreach/checks.ts) asks only "could this person be a
  customer?".
- **Stages** (packages/core/src/addons/outreach/stages.ts) are worked out from what happened, and have no partner
  stage.
- **Messages** wait in `sends` by kind (opener, pitch, video, follow-up, check-in, reply); `goesAsItIs` decides which
  go on their own.
- **Don't pitch and Never contact** are kept on profiles and cover a customer's other profiles (`pitchable`,
  `contactable`, `neverTwins` in packages/core/src/addons/outreach/ops/common.ts).
- **The booking link's ref:** `?ref=` on a booking page is kept on `app.appointment_attendees.link_ref`. Social
  Outreach's demo link uses `so-…` and notes a demo when it books (`outreach.demo.note`).
- **Money:** HandsFreeOS takes money for a business through its own Stripe or Square account, and never holds any.
  `payment.recorded`, `invoice.paid` and `refund.recorded` are outbox events. A dispute was only logged, not stored,
  until stage 2b.
  **Nothing pays money out to anyone today.** HandsFreeOS's own Stripe account can charge a business's saved card
  (wallet top-ups, texting fees and RCS renewals do).
- **Portals:** only a business's own contacts can sign in to its portal (`portal_access`). There's no partner sign-in.
- **The catalogue** lists `affiliates`, `commissions` and `referralprogram` as planned add-ons with no code. Partners
  in core is what they'd build on.

## Stage 1: find and ask partners (Social Outreach)

### Partner playbooks

- `goal: 'partner'` makes a playbook a partner playbook. Its audience, niche, area, signs and skip words describe
  **the audience you want to reach through partners**: your customers.
- A new field, `partnerKinds`: group admins, creators, businesses (all three by default).
- Its `link` is the booking link for partner calls; its `offer` says what's in it for a partner, in a line the AI
  uses; a partner playbook needs no video.
- A new `dataVersion` upgrade fills the field in for every playbook kept.

### Finding them on each network

| Network   | Group admins and moderators                     | Creators with big followings                                       | Businesses with the same customers                           |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Facebook  | Who runs each group saved, already read         | People and Pages in your groups with a following, their count read | Group members whose intro says they serve the same people    |
| LinkedIn  | Who runs a LinkedIn group, once groups are read | Authors found by post search, with their followers read            | People and companies found by search                         |
| Instagram | None (no groups)                                | Accounts found by search, hashtags and the accounts it suggests    | Local businesses' accounts                                   |
| Alignable | None                                            | None                                                               | Your town's businesses, and those whose Ideal Partner is you |

- **Followers, read:** a new `followers` count on each profile, read off the profile's page on Facebook, LinkedIn
  and Instagram, and off group pages for each group's size (as now). A group admin's audience is their groups'
  members.
- **The AI's partner check:** a check of its own (reason `partner`) asks "Could this person send us customers?" with
  the partner playbook's audience. It answers: good, maybe or not; what kind of partner; who their audience is and
  how big; why, in up to three short reasons. It counts against the day's checks.
- **The list's order:** fit first, then audience size, then how active it is (posts this week, members' posts).

### Group admins: a settled rule, changed by Chris

docs/outreach.md has said from the start that group admins and moderators are never approached, so a group never
throws the person out. Chris's request is to approach them, so this is his decision changing that rule: they're
still never approached as customers, and a partner playbook asks them only about partnering, warmed up first, each
message with the person's OK.

### Never pitched as customers

- A profile with a partner row is never pitched as a customer: `pitchable` leaves it out, on every network, as it
  leaves out Don't pitch. Someone on Don't pitch or Never contact is never asked to partner either.
- A customer can be asked to partner. Happy customers make the best partners.

### The Partners list's stages

Stored (unlike customer stages, which are worked out), in a new table, `addon_outreach.partners`, one row per person
working a profile:

| Stage           | When                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| **Found**       | The AI's partner check says good or maybe                                    |
| **Warming up**  | The first like, comment or follow                                            |
| **Asked**       | The first message went                                                       |
| **Interested**  | Their answer read as a yes, or marked by hand                                |
| **Call booked** | A call booked through the partner link, or marked by hand                    |
| **Partner**     | **Make partner** pressed (stage 2 makes them a partner in core)              |
| **Not now**     | They said no or not now, or you stopped (they can be asked again in 90 days) |

### The messages

- New kinds: `partner_ask` (the first message, with no link), `partner_follow_up` (at most two, a week apart),
  `partner_details` (after a yes: what's in it for them, and the call link) and `partner_reply`. Kinds of their own,
  so a partner's drafts are written as partners' and never mixed with a customer's conversation. A migration widens
  `sends_kind_check`.
- **Every partner message waits for an OK:** `goesAsItIs` says no to them whatever Sending says, and each waits for
  an OK of its own, never Approve all.
- **On Today**, in a part of its own (`partners`), so builds made before it never see them: a like first, the ask a
  day later, follow-ups, the details after a yes, and replies, each within what the customers' steps left of the
  day's limits.
- **The AI writes them** about the person and their audience ("your group of 4,000 Austin homeowners"), in the
  person's voice (`voice.ts`), and asks about interest only.
- **Counted** against the day's first messages, at most 3 partner asks a day, so customer messages still go.
- **Their answers** are read as customers' are (yes, a question, later, no), moving them along the stages.

### The partner call

- The partner link carries its own ref, `sp-…` (as the demo link carries `so-…`), so a call booked through it moves
  them to **Call booked** and is never counted as a demo. A new `outreach.partner.call`, run by the worker on
  `appointment.booked`.

### Screens (web and phone)

- **Partners**, a view of its own in Social Outreach: a chip for each stage with its count, and a row for each
  person with their kind (Group admin, Creator, Business), network, audience ("Runs 2 groups, 14,200 members",
  "28.2K followers"), why they fit, and what's next. Buttons: **Interested**, **Call booked**, **Make partner**,
  **Not now**.
- **Today:** partner warm-ups and asks in the day's list, each to OK.
- **Results:** partners asked, interested, calls booked and partners made.

## Stage 2: partners in core

- **Tables:** `app.partners` (a contact of the business who's its partner: their rate, their 12 months, their code,
  and whether they're active, paused or ended); `app.partner_referrals` (each client they sent: how, link or by hand,
  and when their first payment was); `app.partner_commissions` (each payment's share, or a refund's taking back: the
  amount, the rate, when it was earned, when it's free to pay out, and its payout).
- **Make partner** (Social Outreach) runs core's `partner.add` on the person's contact, made from their profile if
  there's none yet.
- **The referral link:** the business's booking link with `?ref=pa-<code>`. A booking through it makes that person
  the partner's client (`partner.referral_note`, run by the worker on `appointment.booked`). **Referred by** on a
  person marks one by hand.
- **Commissions:** on `payment.recorded`, a payment by a client in their first 12 months earns the partner their
  share; on `refund.recorded`, the refunded part is taken back. **New in core:** a dispute is stored, with an event,
  so its commission is held.
- **The partner's page:** a portal of the business for the partner's contact (`portal_access`, as clients have):
  their link, the clients they've sent, what's earned, what's waiting and what's been paid. They accept the
  business's partner terms there first.
- **The business's settings:** its default rate, and the terms partners accept.

### How stage 2 is built (18 Oct 2026)

**A core feature, `partners`** (`CORE_FEATURES`), on while an add-on that uses it runs: Social Outreach says
`uses: ['main_offer', 'partners']`. People's commands refuse while it's off (`partners_not_in_use`), as the main
offer's do. The worker's keep counting all the same: a partner was promised their share, and nothing is earned without
one. Owners and admins hold a new permission, `partners.manage`, which an owner can give anyone in Settings →
Permissions. Make partner on the Partners list needs it, since it promises the business's money, and makes the contact
a partner here too (`partner.add`).

**Its settings** (`settings.partners`, `partners.save_settings`, kept beside `money`): the default rate (10% to
start), the terms partners accept (with a version that goes up when they change), the smallest payout ($25, or lower
if the business says, decision 17), and the calendar the referral link books.

**The tables:**

- `app.partners`: the partner's contact (one partner per contact), a code of 10 letters and digits for their link,
  their own rate when it isn't the default, active, paused or ended, and the version of the terms they accepted, with
  when.
- `app.partner_referrals`: a client of theirs (each customer is one partner's: the first to send them), how (link or
  by hand), the booking it came from, when, and when their first payment after it was. A customer deleted for good
  lets go of it, so what was earned stays.
- `app.partner_commissions`: a share earned on a payment, or taken back on a refund or a lost dispute: what it was
  worked out on, the rate, the amount (negative when taken back), when it was earned, when it's free to pay out (30
  days after, decision 8), held while a dispute is open, and payments in a provider's test mode marked so they're
  never paid out.

**How it's worked out:**

- A booking through `?ref=pa-<code>` (the attendee's `link_ref`) makes its customer the partner's client, unless
  they're already someone's or they're the partner (`partner.referral_note`, the worker on `appointment.booked`).
- **Referred by** on a customer sets or clears it by hand (`partner.referral_set`). A client who has earned their
  partner something, even what a refund took back since, stays theirs: the database holds it too, since a commission's
  referral never cascades.
- Each payment that succeeds (`payment.recorded`): a client's first payment after they were referred starts their 12
  months (decision 7), and each payment in them earns an active partner their rate of what the client paid
  (`partner.commission_note`). Only what they pay after they were sent counts. A paused or ended partner earns
  nothing on new payments, though the client's 12 months still run.
- A refund (`refund.recorded`) takes back the same rate of what was refunded, never more than was earned
  (`partner.commission_take_back`). It comes off with what it takes from: while that still waits its 30 days, so
  does what's taken back; once that's free to pay out, it comes off at once.
- **Whichever the worker notes first**, it comes out the same: a deposit paid as the customer booked, noted before
  the booking is, still earns once the booking makes them a client; a refund noted before its payment comes off as
  soon as the payment earns. The worker's three steps run core's commands in the event's own transaction
  (`apps/worker/src/partners/handlers.ts`), so a retry adds nothing.
- **Disputes** (2b, 18 Oct 2026): `app.payment_disputes` keeps each one from Stripe's and Square's webhooks
  (`payment.record_dispute`), with `dispute.opened` and `dispute.closed`. It's open while the business answers it at
  the provider, then won, lost, or closed (an inquiry that ended with no money taken), and it settles once: a late
  "still open" changes nothing. It never un-pays the invoice. An open one holds what its payment earned a partner
  (`heldCents`, neither waiting nor free to pay out), a lost one takes back the share of what the bank took
  (`partner.commission_dispute_note`, on `dispute.closed`), and a won or closed one lets it go. As with refunds, a
  lost dispute noted before its payment earned comes off as soon as it does.

**Build order:**

1. **2a:** the core feature, its permission and settings, the tables, referrals, commissions on payments and refunds,
   and Make partner.
2. **2b:** disputes (built). A refund made in Stripe's or Square's own dashboard is recorded since decision 19
   (built 18 Oct 2026, with stage 3): the worker keeps one HandsFreeOS never asked for from the refund's own events
   (`payment.record_dashboard_refund`), so it counts on the invoice and `refund.recorded` takes back the partner's
   share. Stripe's `refund.created` and `refund.failed` are now among the webhook's events (Stripe Part 4 in
   docs/operations.md); `charge.refunded` carries the charge and not the refund, so it's passed over rather than
   pinned on a refund of ours that's still waiting. A refund of ours the provider answers before our job keeps its id
   is matched by its payment and its amount. Still open: a refund the bank turns down after it went through stays
   counted, since a refund's status only moves forward.
3. **2c:** the partner's page (built 18 Oct 2026). A partner signs in to the business's portal as any client does
   (`portal_access.give`, whose email tells a partner about their partner page instead of a client's to-do). Home
   has a card and the menu a **Partner** page for them while partners are on (`portal.home`'s `partner`). The page
   (`portal.partner`) has their share, the business's terms to accept first (`portal.partner_accept_terms`, refused
   with `partner_terms_changed` when the terms changed since they opened them), and only then their link; what
   they earned, what's waiting its 30 days, what's free to pay out and what a dispute holds, worked out as the
   business's Partners page works it out; and the clients they sent by first name and last initial, never more. An
   ended partner keeps the page and what they earned, without a link. `portal_actor` reads all of it through five
   look-ups that hand back only the signed-in partner's own (`portal.partner()` and the four beside it, migration
   20261027008800); the partner tables stay shut to the portal. **Send their page** on the business's screens comes
   with 2d.
4. **2d:** the screens, on the web and the phone: Settings → Partners, the partners with their clients and
   commissions, and Referred by on a customer. Make partner shows only to whoever holds Manage partners. The Deleted
   bin says when a contact is a partner: deleting one for good takes their partner record and what they earned with
   it.
   - **The web (built 18 Oct 2026):** Settings → Partners, for whoever holds Manage partners while partners are on.
     The share, the smallest payout and the calendar save as they're changed; the terms wait for **Save the terms**,
     since saving new ones asks every partner to accept them again. Below them, the partners with what all of them
     have earned, and each one's page: their own share or the business's, Pause, Bring them back and End the
     partnership (which asks first), their link, **Send their page** (`portal_access.give`, for whoever may let
     customers into the portal), their clients, and each share earned or taken back, with what it was worked out on
     and when it's free to pay out. A customer's page has a **Partner** card: Make them a partner (`partner.add`) and
     **Sent by**, set by hand (`partner.referral_set`). Make partner on the Partners list, on the web and the phone,
     shows only to whoever holds Manage partners (`partnerMarksFor`'s `makePartner`). The words are core's
     (`partners/business-words.ts`), so the phone says the same. The Deleted bin's box says when a customer is a
     partner (`bin_contents`' `partners`, migration 20261027008900).
   - **The phone (built 18 Oct 2026):** Settings → Partners under This business, for whoever holds Manage partners
     while partners are on. How partners are paid shows to read, with **Change these on the web**, since setting the
     business up stays on the web as the phone's other settings do; then the partners with what they've earned. A
     partner's page has everything the web's has, with **Share their link** through the phone's own share sheet in
     place of copying it, and their own share set from a sheet. A customer's page has the same Partner card. All of
     it needs signal: the queries are the phone's contract's, and the three partner commands are online ones, never
     queued.

## Stage 3: payouts (core)

- **The partner's bank:** Stripe Connect Express, set up from their page with Stripe's own form (bank details, tax
  details and identity are Stripe's, never HandsFreeOS's). US partners first.
- **The business's card:** kept for partner payouts on HandsFreeOS's own Stripe account, as texting fees keep theirs.
- **Each month:** for each business, what's owed for payments at least 30 days old is added up as one payout; the
  card is charged off-session, once per month by its key; then each partner is paid by a Stripe transfer tied to
  that charge. A declined card waits and is tried again, with the owner told, as wallet recharges do. A partner who
  hasn't set up their bank yet has their share kept for them.
- **Stripe's fees are the business's** (decision 16): added to the month's charge, each on its own line of the
  statement.
- **The smallest payout** (decision 17): $25 unless the business sets a lower one in its partner settings. A partner
  owed less than that has it carried to the next month.
- **Tax forms:** Stripe files each partner's 1099 for HandsFreeOS, the platform paying them.
- **docs/operations.md** gets a section: turning on Express accounts and tax forms in Stripe.

### How stage 3 is built (18 Oct 2026)

**Opened one business at a time.** Nothing is charged or paid for a business until staff open partner payouts for
it (`partner.set_payouts_open`, the new staff permission `platform.partner_payouts.manage`), as the usage wallet's
stages are moved one business at a time. That waits on "Before stage 3 goes live" below. Closing them stops what
hasn't been charged yet; a payout already charged still pays its partners.

**The tables** (migration 20261027009000):

- `app.partner_payout_billing`: one row a business. Whether payouts are open, the card on HandsFreeOS's own Stripe
  account (a card of its own, beside the usage wallet's, on the same Stripe customer), and the last month its
  payout was worked out. Only the worker and staff write it; a person with Manage money may only take the card off
  (`partner.payout_forget_card`).
- `app.partner_payout_accounts`: a partner's Stripe Express account, and what Stripe says of it: whether they
  finished its form, whether Stripe can send their money to their bank, and what it still needs.
- `app.partner_payouts`: a month's payout. What the partners are owed, Stripe's three fees, the charge, its tries
  and what the card company said.
- `app.partner_payout_lines`: each partner's part of it, and the transfer that paid them. Each commission names
  the line that pays it (`payout_line_id`).

**How a month is worked out** (`partner.payout_build`, `packages/core/src/partners/payouts.ts`):

- **Once a month, in the business's own time zone.** The worker asks for the businesses whose month hasn't been
  worked out (`private.partner_payouts_due`): open, with a card, and something earned that no payout has taken. A
  business that adds its card mid-month has that month's payout within the hour, then one on each first.
- **Who's paid:** each partner owed at least the smallest payout whose bank at Stripe can take it. What's owed is
  what's free to pay out that no payout has taken, not held by a dispute, less what was taken back. Ended and
  paused partners are paid what they earned before. The rest wait, with nothing charged for them: less than the
  smallest payout carries to the next month, and a partner without a bank has it kept until they set one up.
- **Live pays live, test pays test.** A worker with a live Stripe key pays live payments only; one with a test key
  pays only payments taken in a provider's test mode. So Chris can try it all in Stripe's test mode first.
- **Stripe's fees, each on its own line** (decision 16): $2 for each partner's account paid that month, 0.25% +
  25¢ for each payout to their bank, then the card fee of 2.9% + 30¢ on the whole charge. The charge is the least
  that leaves everything else once Stripe takes its card fee, each fee rounded up to the cent. A card from outside
  the US costs Stripe more, and HandsFreeOS takes the difference.
- **A declined card** (`partner.payout_record_charge`) is tried again on the usage wallet's ladder: six hours, a
  day, three days. A new card tries at once. When the ladder gives up, or payouts were closed or the card taken off
  before the try, the payout fails: its lines are cancelled and what they held is free to pay out in next month's.
- **Each partner** is paid by a transfer tied to the charge (`partner.payout_record_transfer`). One Stripe won't
  take for them yet is held, and sent once their account can take it. A payout is paid once every partner on it
  is.

**What's shown:** what a partner earned now says what's on its way in a payout and what's been paid, on the
business's screens and the partner's page; payable leaves both out. `partner.payouts` gives the business its card,
the next payout as it stands (who it would pay, who waits and why, and what it would charge), and its payouts;
`partner.payout_get` gives a month's statement; `partner.get` gives a partner's bank and their payout lines. The
partner's page (`portal.partner`) gives their bank, what they've been paid and what's on its way, through three new
look-ups; a cancelled line isn't theirs to see. The words are core's (`partners/payout-words.ts`).

**Build order:**

1. **3a (built):** decision 19, refunds made in Stripe's or Square's own dashboard (stage 2b's note).
2. **3b (built):** the tables, the rules, the commands and the look-ups above, in core.
3. **3c (built):** the worker (`apps/worker/src/partners/payouts.ts`, `payout-routes.ts`):
   - The payout card goes on through Stripe's own page (`POST /v1/partners/payout-card`, Manage money), on the
     business's Stripe customer at HandsFreeOS, only once payouts are open.
   - A partner sets up their bank from their page (`POST /public/portal/:token/partner/payouts`): the first press
     makes their Express account (US, transfers only) and opens Stripe's form, asking for everything up front; the
     way back reads the account from Stripe; once it's set up, their Stripe page opens from there.
   - Stripe's `account.updated` and `capability.updated` for a partner's account come on the Connect webhook, are
     routed to the partner, and the account is read back from Stripe.
   - The hourly `partner_payouts.plan` works out each business's month and arms a job for each payout with work
     left. `partner_payouts.charge` charges the card once per try by its key; anything but a success is a decline,
     as the wallet's top-ups have it. `partner_payouts.pay` sends each partner their part by a transfer tied to the
     charge, once per line and account by its key. A new card tries a waiting payout at once.
   - The owners and admins are emailed when the card is declined, with when it's tried again, and when the month
     is given up on; a partner hears from the business when they're paid.
4. **3d (built):** the screens and docs:
   - **The web:** Settings → Partners has **Paying your partners**: the card (added through Stripe's page, taken
     off after a confirm, both for whoever manages money), the next payout as it stands (who it pays, who waits
     and why, and what it charges, with each of Stripe's fees), and each month's payout, whose statement opens
     beneath it. A partner's page has their bank's state and their part of each payout. A partner's own page in
     the portal has **Getting paid**: Set up payouts, Finish with Stripe, or Open your Stripe page, and what
     they've been paid. Earnings everywhere add what's on its way and what's been paid (`earningsTotals`).
   - **The phone:** the same to read, with **Change these on the web**.
   - **/admin:** a business's page opens or closes partner payouts, with a reason (`platform.partner_payouts.get`,
     `partner.set_payouts_open`).
   - **docs/operations.md:** "Paying partners: Stripe Express": turning on Express accounts and 1099s, trying it in
     test mode, opening payouts for a business, and what goes wrong.
   - Still open: Stripe's fees for filing 1099s aren't passed on; a line held for a partner deleted for good is
     sorted out by staff in Stripe.

## Before stage 3 goes live

- **Chris, with his accountant or lawyer:** HandsFreeOS charging businesses and paying their partners makes it the
  platform that pays them. Stripe holds and moves the money as the licensed party, but the business's terms, the
  partners' terms and the 1099s should be checked.
- **The questions asked before stage 3 are answered** (decisions 16 to 18, Chris, 18 Oct 2026): the business pays
  Stripe's fees (about 3% on the monthly charge, and about $2 a month per active partner plus 0.25% per payout),
  added to its monthly charge; the smallest payout is $25 unless the business sets a lower one; and partners outside
  the US come later.

## Stage 4: finding partners by search

Chris (19 Oct 2026) picked this as stage 4, over Instagram and Alignable, partners outside the US and the payout
loose ends: "Find partners by search". Until now partners were found only among the people the person's computer had
already saved: who runs their groups, who has a following among their friends and groups, and who says they run a
business. Stage 1's table above names the searches that were left for later; this builds them on LinkedIn and
Facebook.

**What it does.** Find partners, the once-a-day job on each network, first searches the network for people who could
partner, then reads the next people for the AI's partner check as it does now, those found by search among them.
Nothing is pressed: it opens a search, reads what it shows a screen at a time at a person's pace, and stops on any
warning.

- **Creators: post search.** Posts saying the playbook's words, the latest first, a few screens. Each post's author
  is kept as a creator to read: people on LinkedIn (never a company's page, as Find posts has it); people and Pages
  on Facebook. How many follow them is read off their profile when they're read, as now.
- **Businesses: people search.** People matching the words, a couple of pages. Each is kept with what the result
  shows (their headline, place and the lines under their name) as a business to read.
- **Group admins** aren't searched for. Who runs a group is read from the groups the person is in, as now.

**The words** are the partner playbooks' own, on the network: the quoted words in their signs, then their words to
search for groups, as Find posts takes a customer playbook's. Those already describe the customers, and people
posting about them, or saying they serve them, are who has their attention. On a partner playbook the builder calls
them **Words to search for groups and partners**. There's no new part to fill in.

**How much.** Two searches a day on each network (`PARTNER_SEARCHES_PER_DAY`), each word and kind once a week at most
(`PARTNER_SEARCH_AGAIN_DAYS`), the one searched longest ago first. None while the person already has three days of
partner reads waiting from searches (`PARTNER_LEADS_WAITING_MOST`), so it searches only when it needs more. LinkedIn
limits how much a free account searches for people, so its people search reads two pages. Search pages aren't
profiles, so they don't count against the day's profile reads; reading someone found does.

**What's kept** (migration 20261027009300):

- `addon_outreach.partner_leads`: someone a search found, for the person whose computer searched. The kind it looked
  for, the words, the network, and when. Nobody goes in Contacts: each is a profile with no customer, as a post's
  author is. It's let go once the AI has answered for them.
- `addon_outreach.partner_searches`: each word searched on a network for a kind, when it was last searched, and how
  many new people it found. Today's count and the weekly turn come from it.

**The commands:**

- `outreach.partners.searches`: the searches to do today on a network, each a kind and its words. None with no
  partner playbook in use there, or none wanting creators or businesses.
- `outreach.partner.leads`: a search's results as the computer read them, and that the search was done (it's sent
  even when nothing was found). It keeps the people not found already. It leaves out the person themselves, anyone on
  Don't pitch or Never contact, and anyone on the Partners list or checked lately.
- `outreach.partners.next` reads them too. A creator found by search needs no following known yet, but one known
  under 1,000 isn't read. A business found by search is left alone when the AI found they could be a customer, as now.
  Group admins come first, then creators and then businesses, as now. Within each, the biggest audiences known come
  first, then those found by search, newest first.
- **The AI's partner check** is told how they were found: "Found searching LinkedIn’s posts for “Austin
  homeowners”".

**The extension (0.65.0):** Find partners asks for today's searches, does each and sends what it found, pausing
between searches as a person typing the next would, then reads the next people. On LinkedIn: people search a page
at a time by its address, and post search, the latest first. On Facebook: people search and post search, scrolled a
screen at a time.

**Build order:**

1. **4a (built):** the tables, the words, the commands and the partner check's fact, in core and the worker.
2. **4b (built):** the searches in the extension's Find partners, on LinkedIn and Facebook (0.65.0).
3. **4c (built):** the builder's label on partner playbooks (web and phone, `playbookSectionTitle`),
   docs/outreach.md (decision 81) and the extension's README. Nothing changes in hosting, so docs/operations.md has
   nothing new.

## Build order

1. **Stage 1, in core:** partner playbooks, the partners table, the partner check, the stages, the new message kinds,
   never pitching partners as customers, and the partner call's ref. Its migration goes on the hosted database before
   `main`. Built first: partner playbooks, the partners table and `profiles.partner_found_at`, the partner check, the
   Partners list and its marks, and never pitching partners as customers (migration 20261027008400). Then the
   partner steps on Today, the message kinds and the stages they move, their answers, and the partner call's ref
   (migration 20261027008500).
2. **Stage 1, the extension:** followers read on each network's profiles, partners found from groups and searches,
   partner warm-ups and asks run as Today's other steps are. Built in 0.64.0 on Facebook and LinkedIn: followers read
   off the top of a profile, Find partners once a day after Check my friends, and the partner steps on the runner's
   list. Searches for creators and businesses beyond the groups and friends saved come later.
3. **Stage 1, the apps:** Partners on the web and the phone, and Today's partner items. Built: the Partners list
   under People on both (a chip for each stage, each row's marks by its stage), Today's Partners part, the partner
   numbers in Results (the person's own), copying a partner's draft noted as sent, and the morning push counting
   partner steps.
4. **Stage 2:** partners, referrals and commissions in core, and the partner's page.
5. **Stage 3:** payouts, after the open questions.
6. **Stage 4 (built):** finding partners by search on LinkedIn and Facebook.
7. **Chris tries each,** in Stripe's test mode first for payouts.
