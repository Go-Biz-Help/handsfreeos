# PayPal: businesses take payments with PayPal beside Stripe and Square

The owner (20 Nov 2026): "lets start integrating paypal into the payments options along side stripe and square".

**Where it stands (20 Nov 2026):** the owner picked 1a, 2a, 3a and 4a at 19:19 UTC on 20 Nov (every
recommendation below). Part 1, the real Stripe and Square fields on the customer's pages, is PR #696. Parts 2 to 5 are
built and tested, and go out as one PR once #696 merges. Connect PayPal stays Coming soon
(`NEXT_PUBLIC_PAYPAL_ENABLED`, `EXPO_PUBLIC_PAYPAL_ENABLED`) until PayPal approves HandsFreeOS as a partner; the
setup steps are "Money: PayPal" in `docs/operations.md`.

This is about a **business taking money from its own customers** (invoices, pay links, booking deposits). It has
nothing to do with how HandsFreeOS bills businesses for their plan.

## What is already there

- `app.payment_provider` has had `'paypal'` since `20260920000300_payment_connections.sql`, and
  `apps/worker/src/payments/provider.ts` was written as one seam for Stripe, Square, "PayPal, NMI and Authorize.net
  later". Connections, the pay routes, refunds, webhooks and jobs never name a provider, so PayPal is a third adapter
  rather than a new system.
- The API already refuses to start with any `PAYPAL_` setting (`apps/api/src/env.ts`), so PayPal's secrets can only
  live on the worker.
- **Gap found on 20 Nov 2026:** the customer's pay page (`apps/web/src/components/money/public-invoice.tsx`) and the
  booking deposit step (`apps/web/src/components/booking/deposit-pay.tsx`) only handle the stand-in's `hostedUrl`.
  Stripe's Payment Element and Square's card field were never built, so with a real account Pay answers "We couldn’t
  open the payment form just now." The live database had one live Stripe connection and no payment ever taken
  through a provider (257 payments, all recorded by hand).

## Decisions (the owner, 20 Nov 2026)

| #   | Question                                | Answer (all were the recommendation)                                                                                                                            |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fix the Stripe and Square card box too? | **Yes, first, in its own PR.** PayPal's buttons go in the same spot on the same pages.                                                                          |
| 2   | How a business connects PayPal          | **One Connect PayPal button** (PayPal's partner sign-up), like Stripe and Square. Live use needs PayPal to approve HandsFreeOS as a partner; sandbox works now. |
| 3   | How PayPal shows up for the customer    | **Extra buttons on every pay page** (PayPal, Venmo, Pay Later, PayPal's card button) whenever PayPal is connected. Venmo and Pay Later can be switched off.     |
| 4   | What the first version covers           | **One-time payments**: invoices, pay links, booking deposits, and refunds. Plans stay on Stripe or Square.                                                      |

The questions in full, with the other options: `/mnt/project-files/paypal/questions.md` in the project.

## How PayPal fits the seam

| Seam (`PaymentProvider`)                      | PayPal                                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorizeUrl`                                | Partner Referrals API (`/v2/customer/partner-referrals`): the business signs in to PayPal and grants us permission.                                                                 |
| `exchangeCode`                                | The return carries `merchantIdInPayPal`; we read the seller's status with `/v1/customer/partners/{partner}/merchant-integrations/{merchant}`.                                       |
| Calls for the business                        | Our own client id and secret plus a `PayPal-Auth-Assertion` naming the seller, so there's no seller token to keep fresh (like Stripe).                                              |
| `flow`                                        | `client_confirm`: `prepare` creates the order (`/v2/checkout/orders`), the browser's PayPal button approves it, `confirmFromClient` captures it.                                    |
| `authorize` / `capture` / `voidAuthorization` | Orders with `intent: AUTHORIZE` for a booking deposit hold.                                                                                                                         |
| `refund`                                      | `/v2/payments/captures/{id}/refund`.                                                                                                                                                |
| `fees`                                        | `seller_receivable_breakdown` on the capture: known at once.                                                                                                                        |
| `webhooks`                                    | One platform webhook; each event's signature is checked against PayPal's certificate and `PAYPAL_WEBHOOK_ID`. Captures, holds, disputes, the seller's account, and consent revoked. |
| `subscriptions`, saved cards, `platform`      | Refused in plain words (pick 4a), like Square's `platform`.                                                                                                                         |

New worker settings: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PARTNER_MERCHANT_ID`, `PAYPAL_BN_CODE`,
`PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT`. The stand-in (`apps/worker/src/payments/fake.ts`) gets a PayPal too, so the
tests, the seed and local development never need a PayPal account.

## Build order

1. **Card box for Stripe and Square** (PR #696): Stripe's Payment Element and Square's card field on the invoice page
   and the deposit step, in place of the "couldn't open the payment form" dead end
   (`apps/web/src/components/money/provider-fields.tsx`). Migration `20261027031100_payment_method_from_provider.sql`.
   - Stripe's box offers every way the business switched on (we still never name the methods), with the one picked
     on our page first. So the way a payment was made is now the provider's answer: `PaymentResult.method`, and
     `invoice.record_payment` takes it on the provider's first answer only.
   - Square's bank transfer needs Plaid's sign-in on the page, which isn't built. Square doesn't report an
     `ACH_PROCESSING` capability on locations today, so real Square accounts already offer card alone; if one ever
     offers a bank transfer, the page says to pay by card instead of showing a dead form.
2. **PayPal in the worker:** the adapter, its stand-in, the sign-in and its return, webhooks, refunds. Tests beside
   the Stripe and Square ones.
3. **Settings and onboarding:** Connect PayPal in Settings → Payments and the onboarding payments step (web and phone),
   the account card, Venmo and Pay Later switches; the Assistant's coverage and ledger items.
4. **The customer's pages:** PayPal's buttons on the invoice page, pay links and the deposit step; new payment methods
   `paypal` and `venmo` (migrations `20261027031200` and `20261027031300`), shown in Money → Payments and on receipts.
   - The buttons sit above the card box ("or" between them), or alone when PayPal is the account the money goes to.
     They show beside another account only when the PayPal account is open to everyone (`apps/worker/src/payments/payable.ts`).
   - A deposit is an order with `intent: AUTHORIZE`, captured once the time is confirmed. Venmo and Pay Later are off
     there (they can't be held), and a PayPal account without the hold permission isn't offered for a deposit. A time
     that goes while the customer is in PayPal's window asks PayPal for nothing: approving an order holds no money.
   - Plans refuse a PayPal account (`paypal_one_time_only`).
5. **Docs:** "Money: PayPal" in `docs/operations.md`, click by click: the partner application, the REST app, the
   webhook and the worker's settings.
