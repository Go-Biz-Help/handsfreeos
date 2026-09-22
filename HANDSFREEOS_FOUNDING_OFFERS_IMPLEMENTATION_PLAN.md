# Founding Offers — Implementation Plan

Scarcity that is real: a cap the database enforces, a counter the website reads from that
same cap, and an admin surface where spots are granted, revoked and freed.

Phases 1 and 2 of the growth plan only. Phases 3 and 4 sell more of the same thing and have
nothing to enforce, so they need no machinery beyond the monthly plan this builds.

---

## 1. The decisions this is built on

| Question | Decision |
| --- | --- |
| What is a spot? | One **business — an `app.organizations` row**. Caps count organizations. |
| When is it consumed? | **When you approve it.** Apply → you review → you approve. No self-serve claiming. |
| When it sells out | Waitlist, and the next offer down is shown as the alternative. |
| The monthly plan | **One plan, $97/month.** All features, one workspace, unlimited users, unlimited contacts. Replaces Starter $99 / Growth $249 / Pro $499. |
| Revoking a spot | **14-day grace**, warned in-app and by email, then the workspace converts to $97/month. The spot returns to the pool the moment you revoke, not when the grace ends. |
| The $497 | **Stripe Checkout, in the app**, on the HandsFreeOS platform account. |
| The website shows | **Exact remaining count** and a progress bar. No countdown clock — quantity only. |
| What "lifetime" covers | **The core platform, forever.** Usage (AI, calls, SMS, numbers) always comes out of the wallet. Future premium add-ons are sold separately, to lifetime holders too. |
| Founding partner usage | **$10 starting credit.** A card is required before the balance runs out. |
| A second workspace | The founding deal covers **one workspace**. Every further workspace is $97/month. |

### The two offers

| Offer | Cap | Price | Wallet |
| --- | --- | --- | --- |
| `founding_partner` — Phase 1 | 25 organizations | $0 forever | $10 credit, card before it runs out |
| `founding_lifetime` — Phase 2 | 100 organizations | $497 once | Card at checkout, wallet funded normally |
| `monthly` — the fallback | uncapped | $97/month | Card at checkout |

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

**Note on the existing Stripe code.** `apps/worker/src/payments/stripe.ts` is Stripe
**Connect** — the business's own customers paying *them*, with `Stripe-Account` headers and no
platform fee. It is the wrong seam for this. The $497 is HandsFreeOS's own revenue and belongs
on the platform secret key, alongside wallet top-ups. `STRIPE_SECRET_KEY`,
`STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` already exist in the worker environment.

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

`app.grant_status` is `'reserved' | 'active' | 'grace' | 'revoked' | 'expired' | 'released'`.

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

`app.application_status` is `'pending' | 'approved' | 'declined' | 'waitlisted' | 'expired' | 'withdrawn'`.

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
workspace — including a founding partner's *second* workspace — is `'monthly'` with one.

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
`seat_cap`. Everything that consumes a spot goes through that function; nothing inserts into
`app.founding_grants` directly. A `private.guard_founding_grant` trigger refuses a direct
insert, the same deliberate duplication `private.guard_usage_wallet` already uses — the command
is where the rule is readable, the trigger is where it is true.

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

| Command | What it does |
| --- | --- |
| `founding.approve` | Takes the spot through `private.founding_claim_spot()`, creates the grant `reserved`, issues a claim token, sends the invite email |
| `founding.decline` | Closes an application with a staff-only note |
| `founding.waitlist` | Moves an application to the waitlist, with an email |
| `founding.revoke` | Frees the spot now, sets `grace_ends_at`, writes the reason, notifies the business |
| `founding.restore` | Undoes a revoke while the grace is still running — if the spot has since been filled, it fails rather than overselling |
| `founding.setCap` | Raises or lowers `seat_cap`. Lowering below the number already held is refused |
| `founding.setStatus` | `draft` / `open` / `closed` for an offer |

**Public commands** — rate-limited in `RATE_LIMITED`, the way `invitation.accept` already is:

| Command | What it does |
| --- | --- |
| `founding.apply` | From the site's application form. 5/minute per address |
| `founding.claim` | Redeems a claim token. Free offer: activates. $497: opens Checkout. 10/minute |

**Worker-only commands** — `actors: ['system']`, so `routes.ts` never mounts them:

| Command | What it does |
| --- | --- |
| `founding.recordCheckout` | Records what Stripe said, activates the grant on success |
| `founding.expireReservations` | The nightly sweep that returns unclaimed spots |
| `founding.endGrace` | Converts a grace that ran out to `monthly` / `past_due` |

**Queries:**

- `platform.founding` — staff: every offer with counts, the queue, the grants, the waitlist.
- `founding.mine` — a signed-in business: which offer they hold, and their grace if revoked.

---

## 7. The live counter

The marketing site has no API client today, so the counter follows the pattern the public
booking pages already use: **an unauthenticated worker route, read server-side by Next.js and
cached.**

New route in `apps/worker/src/http/founding.ts`:

```
GET /public/founding/counts
→ { offers: [ { id, name, cap, claimed, remaining, priceCents, status } ], generatedAt }
```

No auth, rate-limited per address, and it reads only the four numbers the page prints — never
who holds a spot. `apps/site` gets a `src/lib/founding.ts` that fetches it with
`next: { revalidate: 60 }`, so a burst of traffic costs one query a minute, and a
`<FoundingCounter>` component rendering:

> **7 of 25 founding partner spots left**
> ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  18 claimed

If the worker is unreachable the component renders the offer without a number rather than
failing the page — a marketing site should never 500 because a counter is down.

The same route feeds the app's own upgrade screens, so the number a prospect sees and the
number the app enforces are the same number.

---

## 8. The $497

Stripe Checkout on the **platform** secret key, hand-rolled `fetch`, matching the house rule in
`payments/provider.ts` — no vendor SDK on the server.

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
