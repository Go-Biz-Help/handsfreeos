# Partners: reaching your customers through someone else's audience

Chris (18 Oct 2026): "add a feature where we can also identify people with large followings of our target audience,
or admins and moderators of fb groups and ask them if they'd be interested in a partnership so instead of only
reaching out to our target audience we can take advantage of another user's audience."

**Where it stands (18 Oct 2026):** Chris answered every question below the same day and said to build it. Nothing is
built yet. Stage 1 starts now.

Social Outreach today finds the people who might buy (docs/outreach.md). This adds a second kind of person to find:
someone who already has your customers' attention, asked to send them your way for a share of what they pay.

## Decisions (Chris, 18 Oct 2026)

| #   | Question                                | Answer                                                                                                                                                                                                         |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who should it look for?                 | **All three:** admins and moderators of Facebook groups your target audience is in; creators whose followers are your target audience (Instagram, LinkedIn, Facebook); and businesses with the same customers. |
| 2   | How is a "large following" judged?      | **Fit first, size second.** The AI scores how well their audience matches yours, then its size and how active it is. A busy 2,000-member local group can beat a quiet 50,000 one.                              |
| 3   | What's offered?                         | **A commission on each client they send.**                                                                                                                                                                     |
| 4   | What does the first message ask?        | **Whether they're open to a partnership at all.** The details and the call link go once they say yes.                                                                                                          |
| 5   | When is a commission earned?            | **When the client pays in HandsFreeOS.** HandsFreeOS sees the payment. A client who pays some other way is marked by hand.                                                                                     |
| 6   | How much?                               | **A share of what the client pays,** at a rate the business sets, which can differ for one partner.                                                                                                            |
| 7   | For how long?                           | **Each payment in the client's first 12 months.**                                                                                                                                                              |
| 8   | Who pays the partner, and when?         | **HandsFreeOS,** once a month, for payments at least 30 days old so a refund never has to be clawed back. HandsFreeOS charges the business's card the total and pays each partner.                             |
| 9   | Do partner messages wait for an OK?     | **Always,** whatever Sending says. There's usually one chance with each partner.                                                                                                                               |
| 10  | Warm them up first?                     | **Yes.** Follow them, like and comment on their posts, or be active in their group, for a few days first.                                                                                                      |
| 11  | Where do partners live?                 | **Their own Partners list,** with its own stages, and each partner's clients and earnings beside them.                                                                                                         |
| 12  | Do partners get a page?                 | **Yes, their own.** Their link, the clients they sent, what they've earned, and their bank details for payouts.                                                                                                |
| 13  | Can a partner be pitched as a customer? | **Never.** Once someone's a partner prospect, they only get partner messages, on every network.                                                                                                                |
| 14  | Keep Alignable's referral swap?         | **Yes, beside the commission** (decision 79). A business with the same customers can earn commission and get referrals back.                                                                                   |
| 15  | Which networks?                         | **All four at once.** Instagram's and Alignable's partner steps run as soon as each network's own steps do (they're still looked at, decision 78).                                                             |

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
  `payment.recorded`, `invoice.paid` and `refund.recorded` are outbox events. A dispute is only logged, not stored.
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

## Stage 3: payouts (core)

- **The partner's bank:** Stripe Connect Express, set up from their page with Stripe's own form (bank details, tax
  details and identity are Stripe's, never HandsFreeOS's). US partners first.
- **The business's card:** kept for partner payouts on HandsFreeOS's own Stripe account, as texting fees keep theirs.
- **Each month:** for each business, what's owed for payments at least 30 days old is added up as one payout; the
  card is charged off-session, once per month by its key; then each partner is paid by a Stripe transfer tied to
  that charge. A declined card waits and is tried again, with the owner told, as wallet recharges do. A partner who
  hasn't set up their bank yet has their share kept for them.
- **Tax forms:** Stripe files each partner's 1099 for HandsFreeOS, the platform paying them.
- **docs/operations.md** gets a section: turning on Express accounts and tax forms in Stripe.

## Before stage 3 goes live

- **Chris, with his accountant or lawyer:** HandsFreeOS charging businesses and paying their partners makes it the
  platform that pays them. Stripe holds and moves the money as the licensed party, but the business's terms, the
  partners' terms and the 1099s should be checked.
- **Open questions, each with a recommendation, asked before stage 3:**
  - **Stripe's fees** (about 3% on the monthly charge, and about $2 a month per active partner plus 0.25% per
    payout): **added to the business's monthly charge,** shown on its statement.
  - **The smallest payout:** **$25,** with less carried to the next month.
  - **Partners outside the US:** **later.**

## Build order

1. **Stage 1, in core:** partner playbooks, the partners table, the partner check, the stages, the new message kinds,
   never pitching partners as customers, and the partner call's ref. Its migration goes on the hosted database before
   `main`. Built first: partner playbooks, the partners table and `profiles.partner_found_at`, the partner check, the
   Partners list and its marks, and never pitching partners as customers (migration 20261027008400). Then the
   partner steps on Today, the message kinds and the stages they move, their answers, and the partner call's ref
   (migration 20261027008500).
2. **Stage 1, the extension:** followers read on each network's profiles, partners found from groups and searches,
   partner warm-ups and asks run as Today's other steps are.
3. **Stage 1, the apps:** Partners on the web and the phone, and Today's partner items.
4. **Stage 2:** partners, referrals and commissions in core, and the partner's page.
5. **Stage 3:** payouts, after the open questions.
6. **Chris tries each,** in Stripe's test mode first for payouts.
