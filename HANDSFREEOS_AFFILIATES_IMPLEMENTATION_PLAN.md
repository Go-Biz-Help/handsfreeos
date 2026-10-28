# Affiliates: people sell HandsFreeOS and earn a share

The owner (27 Oct 2026): "i need to add an affiliate system so people can sell HandsFreeOS and get a percentage of the
sales".

**Where it stands (28 Oct 2026):** the owner answered questions 1 to 14 at 20:10 UTC on 27 Oct, and 15 to 20, on
codes, on 28 Oct at 00:12 UTC ("move forward with all of your picks"). Part 1 is live: links that are remembered and
carried through sign-up, applying, and the Admin area's Affiliates page (migration `20261027014000_affiliates.sql`).
Part 2 is built: plan payments and their refunds are kept, and affiliates earn their share
(`20261027014200_affiliate_commissions.sql`). Part 3 is built: discount and trial codes
(`20261027014300_affiliate_codes.sql`). Part 4, payouts, is next.

This is about selling **HandsFreeOS itself**. It's separate from Partners (`HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md`),
where a business pays its own partners for its own customers. It's called **Affiliates** so the two never get mixed
up: its tables live in `platform`, beside the founding spots, and staff run it from the Admin area.

## Decisions (the owner, 27 Oct 2026)

| #   | Question                       | Answer                                                                                                                  |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | What share?                    | **40%**, which the owner can change for everyone and for each affiliate.                                                |
| 2   | For how long?                  | **Each payment in the customer's first 12 months.**                                                                     |
| 3   | What counts?                   | **The plan only**, never usage (texts, calls, AI).                                                                      |
| 4   | How long a click counts        | **90 days.**                                                                                                            |
| 5   | Who can join?                  | **Anyone can apply**; the owner approves each one in the Admin area.                                                    |
| 6   | Must affiliates be customers?  | **No.** Any HandsFreeOS sign-in can apply and have an affiliate page without buying a plan.                             |
| 7   | How they're paid               | **Stripe Express**, straight to their bank. US only to start.                                                           |
| 8   | When                           | **Monthly, for payments at least 30 days old.**                                                                         |
| 9   | Smallest payout                | **$25**, less carried to the next month.                                                                                |
| 10  | Stripe's payout fees           | **HandsFreeOS pays them.**                                                                                              |
| 11  | Codes                          | **Affiliates make their own:** a percent or dollar discount up to 50% off, for some months or forever, or a free trial. |
| 12  | Affiliates of affiliates       | **No**, one level.                                                                                                      |
| 13  | Their page                     | **Link and codes, clicks, sign-ups, paying businesses by name, earned and paid.**                                       |
| 14  | Terms                          | **Claude drafts simple ones** for the owner's lawyer to check.                                                          |
| 15  | Who pays for a code's discount | **It's shared:** the affiliate earns their share of what the customer actually pays.                                    |
| 16  | How long a free trial is       | **7, 14 or 30 days**, the affiliate picks.                                                                              |
| 17  | During a trial                 | **The card is taken at sign-up and charged when the trial ends.** The founding spot is held, and given back on cancel.  |
| 18  | A trial, then a discount       | **Yes**, one code can give both.                                                                                        |
| 19  | The owner's control            | **50% off is the limit for everyone**, raised or lowered for one affiliate; any code can be turned off; house codes.    |
| 20  | A link for each code           | **Yes**, it fills the code in. Typing the code works too.                                                               |

The questions and the follow-ups on codes are in the project files, `affiliates/questions.md`.

## How it works, in plain words

1. **Joining.** Somebody signed in to HandsFreeOS applies at `app.handsfreeos.com/affiliate`: their name, the code
   their link will carry, how they'll share it, and that they live in the US. Staff with `platform.affiliates.manage`
   (support admins) approve or turn them down under Admin → Affiliates. Approving emails them their link; turning
   down emails a short note, and they may apply again 30 days later.
2. **The link.** `handsfreeos.com/?ref=<code>`. The website's proxy (`apps/site/src/proxy.ts`) keeps the code in a
   cookie for 90 days, counts a click the first time a browser arrives on that code, and sends them on to the same page
   without `?ref=`. The last link clicked wins.
3. **Sign-up.** The website adds `?ref=` and `?ref_at=` to its sign-up links. The app's sign-up keeps them on the new
   account (`affiliate_ref`, `affiliate_ref_at` in its sign-up details, email or Google alike). An affiliate may also
   share `app.handsfreeos.com/sign-up?ref=<code>`; that counts from when it's opened.
4. **The business.** `organization.create` calls `private.affiliate_note_signup`, which credits the new business to
   the affiliate, on the web or the phone, as it's made. Only the account's first business counts, only an approved
   affiliate's code, never the person's own, and only within 90 days of the click. Staff can credit a business by hand,
   move it or take it off, from its page under Admin → Businesses.
5. **Earning** (part 2). Each time that business pays for its plan in its first 12 months, the affiliate earns their
   share of what it paid: $38.80 on a full $97 month at 40%, $198.80 on a full $497 year. Every plan payment is kept
   in `platform.plan_payments` by the founding command that records it (`founding.record_checkout_paid` for a page,
   `founding.record_renewal` for the card charged), and the share is earned in the same transaction
   (`packages/core/src/affiliates/earn.ts`). Each share waits 30 days, then it's ready to pay.
6. **Refunds** (part 2). A refund made in Stripe's dashboard arrives on our own account's webhook
   (`/webhooks/stripe/platform`, `refund.created`, `refund.updated`, `refund.failed`), routed to the business by the
   payment it gives back, and `founding.record_refund` keeps it in `platform.plan_refunds`. One that goes through takes
   back the same share of what went back, never more than was earned on that payment; one the bank turns down after it
   went through gives it back.
7. **Codes** (part 3). An approved affiliate makes their own on their page: a percent or dollars off each payment,
   for some months or for good, a free trial of 7, 14 or 30 days, or a trial then a discount, for one plan or any.
   Staff make them for an affiliate, or house codes that belong to nobody, under Admin → Affiliates. Each code has its
   own link, `handsfreeos.com/?code=<code>`: the website keeps it like a `?ref=` link (no click is counted) and hands
   it to sign-up, the new account keeps it as `affiliate_code`, and the plan page fills it in. Typing it on the plan
   page works too, under "Have a code?". The plan page shows what it takes off each plan before Pay
   (`founding.code_preview`), and `founding.buy` takes it, checking it again.
8. **A trial** (part 3) makes the plan page's Stripe page a setup page: it keeps the card and charges nothing. The spot
   turns on with its first month or year starting when the trial ends, and the hourly sweep charges the card then,
   the way it renews any month or year. Stopping it renewing during the trial gives the spot back when the trial ends.
   A card refused then is a renewal refused: the business is asked to pay with another card, and the spot stays on.
9. **Getting paid** (part 4). Once a month, through Stripe Express, for payments at least 30 days old; under $25
   waits.

## Rules worth knowing before changing anything

- **Credited as it's made, or never.** A business that already existed never counts, and once a business has an
  affiliate, a later link doesn't change it. Only staff move it.
- **Nobody earns on their own business.** The database checks it, for links and by hand.
- **The click never refuses anything.** A link that went wrong must never stop somebody signing up:
  `affiliate_note_signup` answers null rather than failing, and the website's click count is sent after the page.
- **The program's events are `platform.*`.** They have no business in scope, so the worker reads who to tell through
  `private.affiliate_to_tell` and `private.affiliate_staff_to_tell`.
- **A paused affiliate's link credits nobody; an ended one is for good.** What they already sent stays theirs.
- **Clicks carry no token.** A count is all the public route can change, and nobody is paid on clicks.
- **The phone has the Admin area's Affiliates screen**, for staff. The affiliate's own page is on the web only.
- **Commissions are kept as they happened, never changed.** `platform.affiliate_commissions` holds each share
  `earned`, `taken_back` by a refund (negative) or `given_back` when a refund failed. A total is always a sum. A payment
  earns once and a refund takes back once and gives back once: unique indexes hold it.
- **Earned on what was actually paid, at the share then.** A discount (part 3) lowers what's earned with it
  (decision 15). Changing a share counts from the next payment.
- **The 12 months run from the start of the business's first paid month or year,** counted by what each payment pays
  for (`period_from`), not when it was paid, so a renewal paid late still counts for the month it's for.
- **Only what a business pays after it's credited counts**, and only while its affiliate is approved. A paused
  affiliate earns nothing on new payments, though the business's 12 months still run.
- **A commission is the affiliate's, not the referral's.** Staff moving a business to somebody else, or the business
  closing its account for good, leaves what was already earned where it is.
- **No events for commissions.** What an affiliate earns isn't the business's to read in its history, and a
  business's worker may only write events in its own scope. The business's own `founding.paid`, `founding.renewed`
  and `founding.refund_recorded` are its events; the commission rows are the record.
- **An affiliate reads their own commissions,** and the names of the businesses that earned them through
  `private.affiliate_my_businesses()`; how many signed up through `private.affiliate_my_signups()`. Never which
  businesses signed up without paying, and never anybody else's.
- **A code is never changed.** It's made, then turned off or on. At most 20 of an affiliate's are on at once. An
  affiliate turns their own; staff turn any, and one staff turned off only staff turn back on.
- **The limit is checked twice.** No code takes off more than the limit (50% for everyone, `affiliate_settings`, or
  the affiliate's own, `affiliates.max_discount_bp`) when it's made and again when it's used, so lowering it counts at
  once. Dollars off are held to the limit of the cheapest plan the code is for. A house code goes up to 90%. Nothing
  goes past 90%, so a payment is never nothing.
- **What was bought is kept.** A checkout keeps the full price, what the code takes off each payment, for how long,
  and any trial (`founding_checkouts`), and the plan carries them on (`workspace_plans.discount_cents`,
  `discount_until`, `trial_ends_at`). Turning a code off, or lowering a limit, never changes what a business that used
  it pays. `private.founding_charge_cents` says what each renewal charges.
- **A discount lasts by payments that start in it.** "For 3 months" is the first three monthly payments, counted from
  the first one (after any trial). On a yearly plan it's each year that starts within those months: the first year
  for 1 to 12 months, two years for 13 to 24.
- **A code credits the business when it pays with it,** to the code's affiliate, if nobody has it yet and it never
  paid for a plan before (`private.founding_checkout_paid`, how `code`). A business already credited stays with its
  affiliate. Nobody uses their own code, nor a code on a business they made.
- **Changing the code before paying** closes the page under way and makes a new one; the hold on the spot stays.

## Build order

1. **Tracking, applying and the Admin area** (built, `20261027014000`). The tables `platform.affiliate_settings`,
   `affiliates`, `affiliate_clicks` and `affiliate_referrals`; the commands `affiliate.apply`,
   `affiliates.save_settings`, `affiliate.decide`, `affiliate.set_status`, `affiliate.set_rate`, `affiliate.set_code`
   and `affiliate.set_business`; the queries `affiliate.mine`, `platform.affiliates`, `platform.affiliate` and
   `platform.affiliate_of_business`; the emails; the website's proxy; the sign-up carry; `/affiliate`; Admin →
   Affiliates on the web and the phone; and the Affiliate block on a business's page.
2. **Commissions and refunds** (built, `20261027014200`). The tables `platform.plan_payments`, `plan_refunds` and
   `affiliate_commissions`; the command `founding.record_refund` and the refund events on our own account's webhook;
   earned, waiting and ready on the affiliate's page with sign-ups and paying businesses by name, and on theirs under
   Admin → Affiliates with what each business earned and each share. **The owner adds three events to Stripe's "Your
   account" destination** (`refund.created`, `refund.updated`, `refund.failed`): see "Stripe: our own account's
   payments" in `docs/operations.md`. Until then refunds aren't heard and shares aren't taken back.
3. **Codes** (built, `20261027014300`; decisions 11 and 15 to 20). The table `platform.affiliate_codes`; the
   commands `affiliate.make_code`, `affiliate.turn_code`, `affiliates.make_code`, `affiliates.turn_code` and
   `affiliate.set_max_discount`, and the limit on `affiliates.save_settings`; the query `founding.code_preview`, and a
   code on `founding.buy`; codes on the affiliate's page and under Admin → Affiliates, with house codes; "Have a code?"
   on the plan page; the trial's setup page at Stripe; renewals charged with the discount; the code's link on the
   website and through sign-up. `private.founding_buy(uuid, text)`, without a code, is kept so the API running
   before the deploy still buys; a later migration drops it.
4. **Monthly payouts** through Stripe Express, from HandsFreeOS's own balance, reusing Partners' Express accounts
   (`apps/worker/src/payments/stripe.ts`).
5. **The website's Affiliates page** with Apply, the **terms** affiliates accept before they get their link, and a
   link from the account menu.

## Before payouts go live

- The owner's accountant or lawyer reads the terms. Stripe files the 1099s, as it does for Partners.
- The terms say affiliates must tell people they earn from it (an FTC rule), and must not spam or promise what
  HandsFreeOS doesn't.
