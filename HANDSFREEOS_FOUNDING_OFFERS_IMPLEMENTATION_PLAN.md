# Founding Offers — Implementation Plan

Scarcity that is real: a cap the database enforces, a counter the website reads from that
same cap, and an admin surface where spots are granted, revoked and freed.

Phases 1 and 2 of the growth plan only. Phases 3 and 4 sell more of the same thing and have
nothing to enforce, so they need no machinery beyond the monthly plan this builds.

> **Status: Phase 1 is built.** Migration `20261003000100`, the Drizzle mirror, the core commands
> and queries, the worker's two signed-out routes, `/admin/founding`, and the website. Sixteen tests
> cover the cap. Phase 2's $497 checkout is not built and needs a Stripe account connected first
> (§8, §11). Both offers ship `draft`, so nothing is live until somebody opens them.
>
> Building it changed three things in this plan; §3, §5 and §6 below say what and why.

---

## 1. The decisions this is built on

| Question               | Decision                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is a spot?        | One **business — an `app.organizations` row**. Caps count organizations.                                                                                             |
| When is it consumed?   | **When you approve or give it.** A free seat is on the business's workspace at once and stays until you revoke it (§1.1). No self-serve claiming.                    |
| When it sells out      | Waitlist, and the next offer down is shown as the alternative.                                                                                                       |
| The monthly plan       | **One plan, $97/month.** All features, one workspace, unlimited users, unlimited contacts. Replaces Starter $99 / Growth $249 / Pro $499.                            |
| Revoking a spot        | **14-day grace**, warned in-app and by email, then the workspace converts to $97/month. The spot returns to the pool the moment you revoke, not when the grace ends. |
| The $497               | **Stripe Checkout, in the app**, on the HandsFreeOS platform account.                                                                                                |
| The website shows      | **Exact remaining count** and a progress bar. No countdown clock — quantity only.                                                                                    |
| What "lifetime" covers | **The core platform, forever.** Usage (AI, calls, SMS, numbers) always comes out of the wallet. Future premium add-ons are sold separately, to lifetime holders too. |
| Founding partner usage | **$10 starting credit.** A card is required before the balance runs out.                                                                                             |
| A second workspace     | The founding deal covers **one workspace**. Every further workspace is $97/month.                                                                                    |

### 1.1 Free seats are on until you take them back (decided 2026-10-15)

The owner's call, after three approved founding partners lapsed because nobody followed their claim links:

- **Any business can be given a seat,** whether or not it applied: `founding.give`, from **Give a seat** on
  `/admin/founding`.
- **A free seat is never held behind a link.** Approving or giving one puts it on the business's workspace at once,
  with its plan and starting credit, and only revoking takes it back.
- **A seat held from before, or one that lapsed, is turned on from its row,** reusing that seat rather than taking
  a second.
- **The $497 seat keeps its claim link and its fourteen-day hold,** because it waits on a payment.
- The cap and the open/closed switch still apply to every seat.

### The two offers

| Offer                         | Cap               | Price      | Wallet                                   |
| ----------------------------- | ----------------- | ---------- | ---------------------------------------- |
| `founding_partner` — Phase 1  | 25 organizations  | $0 forever | $10 credit, card before it runs out      |
| `founding_lifetime` — Phase 2 | 100 organizations | $497 once  | Card at checkout, wallet funded normally |
| `monthly` — the fallback      | uncapped          | $97/month  | Card at checkout                         |

---

## 2. What the repo has, and what it is missing

**Has.** The usage wallet (`app.usage_wallets`, the ledger, the rate card, per-business
enforcement) already bills AI, calls and SMS against a prepaid balance, and already charges a
card on the HandsFreeOS platform Stripe account through `apps/worker/src/money/recharge.ts`.
That is the "+ paid usage" half of every offer, and it is done.

**Missing.** Any notion of a plan. `20260930000800_usage_wallet.sql` says so outright:

> nothing here reads a plan, an entitlement or a trial — there is no such thing in this repo
> yet. If a later milestone adds one, resist the urge to "unify" the two.

That instruction is followed here: plans get their own tables and their own Stripe objects.
The wallet spends a prepaid balance; a plan bills on a cycle. They stay apart.

**Also missing.** `apps/site` is entirely static — it has no API client and no environment
beyond a chat widget key. The live counter is the first data the marketing site ever reads.

**The Stripe seam exists; the Stripe account is not connected.**
`apps/worker/src/payments/stripe.ts` has two halves. Most of it is Stripe **Connect** — the
business's own customers paying _them_, with a `Stripe-Account` header and no platform fee —
which is the wrong seam for this. But `stripe.ts:571` also has a `platform` block whose comment
is exactly the distinction that matters:

> Our own charges: the usage wallet's top-ups. Every call here passes `null` where a seller's
> account would go, which is the whole of what makes the money ours.

`platform.ensureCustomer`, `platform.saveMethod`, `platform.forgetMethod` and `platform.charge`
are all written. **None of it has ever run.**

- Every Stripe variable in `apps/worker/src/env.ts` is optional — `env.STRIPE_SECRET_KEY || null`.
  The worker starts fine without them, and `apps/worker/fly.toml` names the secrets the worker
  refuses to start without and the optional ones that turn features on. Stripe is in neither
  list, because no Stripe account has been connected.
- `WALLET_MODE = "off"` in `fly.toml`, so the wallet records nothing in production either.

So this plan does not inherit a working payment path. It inherits a well-shaped seam and has to
supply the account behind it. See §8 and §11.

---

## 3. Data model

New migrations under `supabase/migrations/`, following the house numbering
(`20261003000100_…` onward) and the `app.` / `private.` split.

### `app.founding_offers` — the campaign, and its cap

```
id                  text primary key        -- 'founding_partner' | 'founding_lifetime'
name                text not null
seat_cap            integer not null        -- 25, 100. You may raise it; see §4.
price_cents         integer not null        -- 0, 49700
status              app.offer_status        -- 'draft' | 'open' | 'closed'
show_counter        boolean not null        -- whether the website prints the number
starting_credit_cents integer not null default 0
sort                integer not null
```

The cap lives in a row, not a constant, because "unless I allow it" was a requirement. Raising
`seat_cap` from 25 to 26 opens exactly one more spot, and the change is written to the audit
log with who did it.

### `app.founding_grants` — one row per organization holding a spot

```
id                uuid primary key
offer_id          text not null references app.founding_offers (id)
organization_id   uuid not null references app.organizations (id) on delete cascade
workspace_id      uuid references app.workspaces (id)   -- the one workspace the deal covers
status            app.grant_status
reserved_at       timestamptz not null
activated_at      timestamptz
expires_at        timestamptz          -- a reservation's deadline to pay/claim
revoked_at        timestamptz
revoked_by        uuid                 -- staff
revoke_reason     text
grace_ends_at     timestamptz
granted_by        uuid not null        -- staff who approved
```

**As built:** `platform.founding_grant_status` is `'reserved' | 'active' | 'revoked' | 'expired'`,
and the tables live in `platform` beside the rate card and the support desk rather than in `app`.

The draft of this plan gave a grant its own `grace` status _and_ said a revocation frees the seat
at once — which cannot both be true of one column. The seat and the notice are two facts, so they
are two rows: the grant goes `revoked` and stops holding a seat, and `app.workspace_plans` goes to
`grace` with a date. Only `app.workspace_plans` stays in `app`, because it is a tenant fact the app
reads on every gate. That split is also what keeps `revoke_reason` out of any policy a business can
read through.

**An organization may hold at most one grant that counts.** Enforced by a partial unique index
on `organization_id` where `status in ('reserved','active','grace')`.

### `app.founding_applications` — the queue and the waitlist

```
id              uuid primary key
offer_id        text not null
business_name   text not null
contact_name    text not null
email           citext not null
phone           text
website         text
industry        text
team_size       text
note            text                -- what they wrote
status          app.application_status
source          text                -- utm/referrer, for Phase 3's channel analysis
reviewed_at     timestamptz
reviewed_by     uuid
decision_note   text                -- your words, shown to nobody but staff
claim_token     text unique         -- issued on approval
claim_expires_at timestamptz
grant_id        uuid references app.founding_grants (id)
created_at      timestamptz not null
```

`platform.founding_application_status` is `'pending' | 'approved' | 'declined' | 'waitlisted' | 'expired' | 'withdrawn'`.

**As built:** `claim_token` is `claim_token_hash bytea` — only the sha256 is stored and the link is
returned once, the way an invitation's is. It is worth a free account for life, so it is worth more
care than an invitation, not less.

One partial unique index on `lower(email)` where `status in ('pending','approved')` stops the
same person filling the queue.

### `app.workspace_plans` — what a workspace is entitled to, and why

```
workspace_id        uuid primary key references app.workspaces (id) on delete cascade
organization_id     uuid not null
plan                app.plan_kind       -- 'founding_free' | 'founding_lifetime' | 'monthly'
status              app.plan_status     -- 'active' | 'past_due' | 'grace' | 'canceled'
grant_id            uuid references app.founding_grants (id)
price_cents         integer not null
stripe_customer_id  text
stripe_subscription_id text
current_period_end  timestamptz
grace_ends_at       timestamptz
canceled_at         timestamptz
```

This is the row every entitlement check reads. A founding workspace has
`plan in ('founding_free','founding_lifetime')` and no Stripe subscription. Every other
workspace — including a founding partner's _second_ workspace — is `'monthly'` with one.

### `app.founding_checkouts` — the $497 sessions

```
id                  uuid primary key
grant_id            uuid not null references app.founding_grants (id)
stripe_session_id   text unique
status              app.checkout_status  -- 'pending' | 'succeeded' | 'failed' | 'expired'
amount_cents        integer not null
paid_at             timestamptz
```

Written by the worker only, same as `app.wallet_recharges`.

---

## 4. The cap, and why it cannot be oversold

A count-then-insert is a race: two approvals at once both read 24 and both write, and you owe
26 people a free lifetime account you promised 25 of.

So the cap is taken the way the wallet takes a balance — `private.founding_claim_spot()` locks
the `app.founding_offers` row with `select … for update`, counts grants in
`('reserved','active','grace')` for that offer, and raises if the count has reached
`seat_cap`. **As built:** there is no separate claim function to route through, because a function somebody can
forget to call is not a guarantee. `private.guard_founding_seat` is a trigger on
`platform.founding_grants` itself: it locks the offer's row, counts, and refuses. Every path — a
command, a migration, psql, the worker — hits it. Unlike `private.guard_usage_wallet` there is no
system-actor bypass, deliberately: a cap the worker can step around is not a cap.

**A revoked spot frees immediately.** `'revoked'` is not in the counted set, so the moment you
revoke, remaining goes up by one and the next waitlisted applicant can be approved — even
though the revoked business is still inside its 14-day grace and still working normally.

---

## 5. The lifecycle

```
                apply
                  │
                  ▼
             ┌─────────┐   you decline    ┌──────────┐
             │ pending │ ───────────────▶ │ declined │
             └────┬────┘                  └──────────┘
                  │ you approve                 ▲
                  │                             │ cap full
       ┌──────────┴───────────┐            ┌────┴──────┐
       │  claim_spot() locks  │            │ waitlisted│
       │  the offer row       │            └───────────┘
       └──────────┬───────────┘
                  ▼
            grant: reserved  ──── 14 days, no claim/payment ───▶ expired (spot returns)
                  │
      ┌───────────┴────────────┐
      │                        │
 free offer:              $497 offer:
 they claim link          Stripe Checkout succeeds
      │                        │
      └───────────┬────────────┘
                  ▼
             grant: active
             workspace_plans: founding_free | founding_lifetime
             wallet credited $10 (free offer only)
                  │
                  │ you revoke, with a reason
                  ▼
             grant: grace  (spot freed NOW; 14-day clock starts)
                  │
        ┌─────────┴──────────┐
        │                    │
  they add a card       grace expires
  → plan 'monthly'      → plan 'monthly', status 'past_due'
                           → app degrades per existing wallet enforcement
```

Nothing is deleted. A revoked grant keeps its reason and its staff id forever, which is what
makes the decision defensible if the business asks.

---

## 6. Commands and queries

New `packages/core/src/commands/founding.ts` and `packages/core/src/queries/founding.ts`,
registered in the existing `commands/index.ts` and `queries/index.ts`. All follow
`defineCommand` and inherit the kernel's permission, risk, emit and receipt handling.

**Staff commands** — permission `platform.founding.manage`, a new entry alongside
`platform.rates.manage` in the staff role table:

| Command              | What it does                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `founding.approve`   | Takes the spot through `private.founding_claim_spot()`, creates the grant `reserved`, issues a claim token, sends the invite email |
| `founding.decline`   | Closes an application with a staff-only note                                                                                       |
| `founding.waitlist`  | Moves an application to the waitlist, with an email                                                                                |
| `founding.revoke`    | Frees the spot now, sets `grace_ends_at`, writes the reason, notifies the business                                                 |
| `founding.restore`   | Undoes a revoke while the grace is still running — if the spot has since been filled, it fails rather than overselling             |
| `founding.setCap`    | Raises or lowers `seat_cap`. Lowering below the number already held is refused                                                     |
| `founding.setStatus` | `draft` / `open` / `closed` for an offer                                                                                           |

**Public commands** — rate-limited in `RATE_LIMITED`, the way `invitation.accept` already is:

| Command          | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `founding.apply` | From the site's application form. 5/minute per address                        |
| `founding.claim` | Redeems a claim token. Free offer: activates. $497: opens Checkout. 10/minute |

**Worker-only commands** — `actors: ['system']`, so `routes.ts` never mounts them:

| Command                       | What it does                                             |
| ----------------------------- | -------------------------------------------------------- |
| `founding.recordCheckout`     | Records what Stripe said, activates the grant on success |
| `founding.expireReservations` | The nightly sweep that returns unclaimed spots           |
| `founding.endGrace`           | Converts a grace that ran out to `monthly` / `past_due`  |

**Queries:**

- `platform.founding` — staff: every offer with counts, the queue, the grants, the waitlist.
- `founding.mine` — a signed-in business: which offer they hold, and their grace if revoked.

---

## 7. The live counter

The marketing site has no API client today, so the counter follows the pattern the public
booking pages already use: **an unauthenticated worker route, read server-side by Next.js and
cached.**

**As built** in `apps/worker/src/http/founding.ts`, with a second route beside it
(`POST /public/founding/apply`) and one hop the plan did not foresee: the form posts to a route
handler on the marketing site, which forwards to the worker. The worker's CORS allowlist is the
app's origin, and widening it for the site would widen it for every route behind it. The hop
forwards `x-forwarded-for` so the per-address limits still count the visitor.

The route:

```
GET /public/founding/counts
→ { offers: [ { id, name, cap, claimed, remaining, priceCents, status } ], generatedAt }
```

No auth, rate-limited per address, and it reads only the four numbers the page prints — never
who holds a spot. `apps/site` gets a `src/lib/founding.ts` that fetches it with
`next: { revalidate: 60 }`, so a burst of traffic costs one query a minute, and a
`<FoundingCounter>` component rendering:

> **7 of 25 founding partner spots left**
> ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ 18 claimed

If the worker is unreachable the component renders the offer without a number rather than
failing the page — a marketing site should never 500 because a counter is down.

The same route feeds the app's own upgrade screens, so the number a prospect sees and the
number the app enforces are the same number.

---

## 8. The $497

Stripe Checkout on the **platform** secret key, hand-rolled `fetch`, matching the house rule in
`payments/provider.ts` — no vendor SDK on the server.

### What has to be provisioned first

This is setup work on your side, not code. Without it nothing in this section runs:

| Secret                   | What it is                                                                                         | Needed for         |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------ |
| `STRIPE_SECRET_KEY`      | The **live** platform key, `sk_live_…`. A test key in production is refused by `env.ts` on purpose | Every charge       |
| `STRIPE_WEBHOOK_SECRET`  | The signing secret for the endpoint below                                                          | Confirming payment |
| `STRIPE_PUBLISHABLE_KEY` | Public, for the card form                                                                          | Saving a card      |

Set with `fly secrets import` for `handsfreeos-worker`, per `docs/operations.md` Part 6.

`STRIPE_CLIENT_ID` is **not** needed. That one is Connect — businesses linking their own Stripe
so their customers can pay them — and is a separate decision. Note the guard in `env.ts`: if you
ever set `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY` becomes mandatory.

### The extra code the seam needs

`platform.charge` does off-session PaymentIntents against a saved card. Checkout is a hosted
page for someone who has no card on file yet, so `PaymentProvider.platform` gains one method —
`createCheckout(input): Promise<{ url, sessionId }>` — implemented for Stripe, and left
`unsupported` for Square the way `platform.supported` already handles that.

### The flow

1. `founding.claim` with a valid token for the paid offer writes an `app.founding_checkouts`
   row `pending` and schedules a job.
2. The job creates a Checkout Session (`mode: 'payment'`, the grant id in `client_reference_id`,
   an idempotency key from the grant id) and returns the URL.
3. `POST /public/founding/webhook` verifies the Stripe signature with `STRIPE_WEBHOOK_SECRET`,
   and on `checkout.session.completed` runs `founding.recordCheckout`.
4. That command activates the grant and writes `app.workspace_plans`.

**The spot is already reserved before they ever reach Stripe**, so a slow card cannot lose
someone the place you promised them. A reservation that is never paid expires after 14 days and
the spot returns.

A `FOUNDING_MODE` environment switch (`off` / `shadow` / `on`) mirrors `WALLET_MODE`, so the
tables can fill and the counter can render before a single card is charged.

---

## 9. Where the gate actually bites

Four places, all reading `app.workspace_plans`:

1. **Onboarding.** Creating an organization needs a claim token or a $97 subscription. Without
   either, onboarding ends on the plan picker.
2. **A second workspace.** Refused for a founding org unless that workspace has its own
   `monthly` plan. This is the rule that stops one founding spot becoming an agency's whole
   client book.
3. **Grace expiry.** `founding.endGrace` flips the plan to `monthly` / `past_due`, and the
   existing per-business wallet enforcement degrades outbound exactly as it does for an unpaid
   wallet. No new degradation ladder is invented.
4. **The offers themselves.** With an offer `closed` or its cap reached, `founding.apply`
   accepts the application as `waitlisted` and the app and site both show the next offer down.

---

## 10. Site and admin changes

**`apps/site`**

- `src/content/site.ts` — the three plans become one $97 plan plus the two founding offers.
  `extraSeatPrice` and `includedSeats` are deleted; unlimited users means nothing counts seats.
  `planComparison` collapses to a single feature list.
- `src/app/pricing/page.tsx` — rewritten around the founding offers with the live counter, the
  $97 plan below them, and honest wording that usage is billed separately.
- `src/app/founding/page.tsx` — new. The offer, the counter, and the application form.
- `src/app/page.tsx` — a counter strip above the fold.
- `src/content/faqs.ts` — pricing FAQs rewritten; new ones for what lifetime covers, what usage
  costs, and what happens when spots run out.

**`apps/web`**

- `src/app/admin/founding/page.tsx` — the offers with caps you can raise, the pending queue with
  approve / decline / waitlist, the grants with revoke, and the waitlist.
- `src/components/admin/admin-shell.tsx` — a nav entry gated on `platform.founding.manage`.
- `src/app/claim/[token]/page.tsx` — where an approved applicant lands.
- Onboarding and the plan picker updated for the gate in §9.

---

## 11. Open items

1. **The three live plans are being deleted.** Starter, Growth and Pro and all their comparison
   copy go away, replaced by one $97 plan. If anyone is already signed up against that page,
   they need grandfathering that this plan does not describe.
2. **$97 for unlimited users is a large drop** from $249 Growth — roughly 60% — and the old Pro
   tier's multi-business pricing is now $97 per workspace. Worth a second look before the
   pricing page ships.
3. **Application form fields** — §3 lists a guess (business name, contact, email, phone,
   website, industry, team size, note). Confirm before the migration, since changing them later
   means another migration.
4. **Email copy** for approve, decline, waitlist, claim reminder, revoke warning and grace
   expiry is not written. Six templates in `apps/worker/src/emails/templates`.
5. **The Stripe Price object** for the $497 and the $97/month — create them in the Stripe
   dashboard and reference by id, or build them inline with `price_data`.
6. **`WALLET_MODE` is `off` in production**, so nothing is metering AI, calls or SMS today.
   Every offer here is "+ paid usage", and the founding partner's $10 credit is a wallet
   balance. The wallet therefore has to go `shadow` → `on` before or alongside Phase 1, or the
   free tier is free in a way nobody intended. `fly.toml` documents the rollout, and the change
   is a reviewed commit rather than a secret, by design.
7. **No Stripe account is connected at all.** Both the $497 and the $97/month depend on it, as
   does the wallet's own top-up. This is the single longest pole in the plan and it is setup,
   not code — see the table in §8.

### The order these unblock in

```
Stripe platform key + webhook secret on the worker
        │
        ├──▶ WALLET_MODE = shadow ──▶ on        (usage billing, the $10 credit)
        │
        └──▶ founding.claim → Checkout          (the $497)
                    │
                    └──▶ the $97/month plan      (the fallback every gate falls back to)
```

Phase 1 can ship without Stripe if the 25 founding partners are approved by hand and their
wallets are credited by support — `platform.wallets.adjust` already exists. Phase 2 cannot.

---

## 12. Build order

Each step is committable and leaves the tree green.

1. Migrations, the enums, `private.founding_claim_spot()` and the guard triggers, plus the
   Drizzle schema in `packages/db`.
2. Core commands and queries, with tests for the cap race, one-grant-per-org, revoke-frees-now,
   and restore-fails-when-refilled.
3. The worker: the public counts route, the claim and webhook routes, the Stripe Checkout job,
   and the nightly expiry and grace sweeps.
4. The admin page and its nav entry.
5. The enforcement points in §9.
6. The site: counter, pricing rewrite, application page, FAQs.
7. Seed the two offers, and a demo seed that fills a few spots so the counter has something to
   show in development.

### What is done

1. ✅ Migration `20261003000100`, the guard, the offers seeded `draft`.
2. ✅ Drizzle mirror, checked column-for-column by the existing parity test.
3. ✅ Core commands and queries, registered and typechecked.
4. ✅ `packages/db/test/founding-cap.test.ts` — sixteen tests, two of which fail if the row lock is
   removed (checked by removing it).
5. ✅ The worker's two signed-out routes.
6. ✅ `/admin/founding`.
7. ✅ The website: one $97 plan, live counters, `/founding`, rewritten FAQs.
8. ⬜ The $497 checkout — needs a Stripe account connected (§8).
9. ⬜ The six emails (§11.4), and the nightly sweeps that expire a reservation and end a grace.
