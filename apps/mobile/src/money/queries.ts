/**
 * Money's SQL on the phone's copy.
 *
 * **What a person may see is already decided before this runs.** The money tables are visibility-filtered in the copy
 * itself: an owner or an admin gets the business's documents through the `business_v1` bucket, and a member gets only
 * the estimates and invoices for the jobs they are on, through their own `me_v1` bucket (migration 0056's
 * `member_viewer_ids`). So these queries never filter by person — there is nothing here to hide. What the *screen*
 * still has to get right is the parts that are about the whole business (the three headline figures, Payments and
 * Plans), and that is core's `seesWholeBusiness` and `moneyTabsFor`.
 *
 * Balances are worked out here rather than read: `invoices.balance_cents` is a generated column, and Postgres 17
 * doesn't replicate generated columns (the plan's pitfall 9).
 */

/** SQLite's `trim`, not Postgres's `btrim`: the phone's copy is SQLite, and an unknown function makes the whole
 * query answer nothing rather than raise where a screen would notice. */
const personName = (alias: string) =>
  `coalesce(nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), ''), 'Customer')`;

/** The balance the database generates, as SQLite works it out from the columns the phone does have. */
const BALANCE = `max(i.total_cents - i.amount_paid_cents,
  min(0, i.total_cents - i.amount_paid_cents + i.amount_refunded_cents))`;

/** A payment still on its way: a bank transfer settling, which keeps an invoice from reading as overdue. */
const SETTLING = `EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'processing')`;

/** Every invoice the phone has for this business, newest first, with its customer and what it comes to. */
export const INVOICES_SQL = `
  SELECT i.id, i.number, i.status, i.purpose, i.origin, i.title, i.person_id,
    i.total_cents, i.amount_paid_cents, i.amount_refunded_cents, i.due_on, i.terms,
    i.sent_at, i.first_viewed_at, i.paid_at, i.voided_at, i.created_at,
    i.subtotal_cents, i.discount_cents, i.discount_percent_bp, i.taxable_base_cents,
    i.tax_cents, i.tax_rate_bp, i.tax_label, i.notes, i.attendee_id, i.estimate_id, i.subscription_id,
    ${BALANCE} AS balance_cents,
    ${SETTLING} AS settling,
    ${personName('pe')} AS person_name, pe.email AS person_email, pe.phone_e164 AS person_phone
  FROM invoices i
  LEFT JOIN people pe ON pe.id = i.person_id
  WHERE i.workspace_id = ?
  ORDER BY i.created_at DESC, i.id DESC`;

/** One invoice, the same way. */
export const INVOICE_SQL = `${INVOICES_SQL.replace('WHERE i.workspace_id = ?', 'WHERE i.workspace_id = ? AND i.id = ?')}`;

/** Every estimate the phone has, newest first. */
export const ESTIMATES_SQL = `
  SELECT e.id, e.number, e.status, e.title, e.person_id, e.total_cents, e.subtotal_cents,
    e.discount_cents, e.discount_percent_bp, e.taxable_base_cents, e.tax_cents, e.tax_rate_bp,
    e.tax_label, e.deposit_cents, e.expires_on, e.sent_at, e.first_viewed_at, e.accepted_at,
    e.declined_at, e.voided_at, e.created_at, e.notes,
    ${personName('pe')} AS person_name, pe.email AS person_email, pe.phone_e164 AS person_phone
  FROM estimates e
  LEFT JOIN people pe ON pe.id = e.person_id
  WHERE e.workspace_id = ?
  ORDER BY e.created_at DESC, e.id DESC`;

export const ESTIMATE_SQL = `${ESTIMATES_SQL.replace('WHERE e.workspace_id = ?', 'WHERE e.workspace_id = ? AND e.id = ?')}`;

/** A document's lines, in the order they were written. */
export const INVOICE_LINES_SQL = `
  SELECT id, name, description, quantity, unit_label, unit_price_cents, taxable, discount_cents, amount_cents
  FROM invoice_lines WHERE workspace_id = ? AND invoice_id = ? ORDER BY position, id`;

export const ESTIMATE_LINES_SQL = `
  SELECT id, name, description, quantity, unit_label, unit_price_cents, taxable, discount_cents, amount_cents
  FROM estimate_lines WHERE workspace_id = ? AND estimate_id = ? ORDER BY position, id`;

/** Every payment the phone has, newest first, with the invoice and customer it belongs to. */
export const PAYMENTS_SQL = `
  SELECT p.id, p.invoice_id, p.amount_cents, p.method, p.provider, p.status, p.received_at,
    p.card_brand, p.card_last4, p.created_at,
    i.number AS invoice_number, ${personName('pe')} AS person_name,
    (SELECT coalesce(sum(r.amount_cents), 0) FROM refunds r
       WHERE r.payment_id = p.id AND r.status = 'succeeded') AS refunded_cents
  FROM payments p
  LEFT JOIN invoices i ON i.id = p.invoice_id
  LEFT JOIN people pe ON pe.id = i.person_id
  WHERE p.workspace_id = ?
  ORDER BY coalesce(p.received_at, p.created_at) DESC, p.id DESC`;

/** One invoice's payments and refunds, for its own screen. */
export const INVOICE_PAYMENTS_SQL = `
  SELECT id, amount_cents, method, provider, status, received_at, card_brand, card_last4, created_at
  FROM payments WHERE workspace_id = ? AND invoice_id = ?
  ORDER BY created_at DESC, id DESC`;

export const INVOICE_REFUNDS_SQL = `
  SELECT id, payment_id, amount_cents, status, reason, refunded_at, created_at
  FROM refunds WHERE workspace_id = ? AND invoice_id = ?
  ORDER BY created_at DESC, id DESC`;

/** The plans people are on. Owners and admins only — a member's copy has no `subscriptions` rows at all. */
export const SUBSCRIPTIONS_SQL = `
  SELECT s.id, s.plan_name, s.price_cents, s."interval", s.interval_count, s.status, s.person_id,
    s.next_billing_on, s.card_brand, s.card_last4, s.paused_at, s.cancelled_at, s.created_at,
    ${personName('pe')} AS person_name
  FROM subscriptions s
  LEFT JOIN people pe ON pe.id = s.person_id
  WHERE s.workspace_id = ?
  ORDER BY s.created_at DESC, s.id DESC`;

/**
 * The three headline figures, worked out on the phone from the copy (the API's `money.summary` is the server's own
 * sum, and it needs signal). Only ever shown to someone who sees the whole business.
 */
export const SUMMARY_SQL = `
  SELECT
    coalesce(sum(CASE WHEN i.status IN ('sent','partly_paid','overdue') THEN ${BALANCE} ELSE 0 END), 0)
      AS outstanding_cents,
    coalesce(sum(CASE WHEN i.status IN ('sent','partly_paid','overdue') THEN 1 ELSE 0 END), 0)
      AS outstanding_count,
    coalesce(sum(CASE WHEN i.status IN ('sent','partly_paid','overdue') AND ${SETTLING}
      THEN ${BALANCE} ELSE 0 END), 0) AS settling_cents,
    coalesce(sum(CASE WHEN i.status IN ('sent','partly_paid','overdue') AND NOT ${SETTLING}
      AND i.due_on IS NOT NULL AND i.due_on < ? AND ${BALANCE} > 0 THEN ${BALANCE} ELSE 0 END), 0)
      AS overdue_cents,
    coalesce(sum(CASE WHEN i.status IN ('sent','partly_paid','overdue') AND NOT ${SETTLING}
      AND i.due_on IS NOT NULL AND i.due_on < ? AND ${BALANCE} > 0 THEN 1 ELSE 0 END), 0)
      AS overdue_count
  FROM invoices i WHERE i.workspace_id = ?`;

/** What came in over the window, and what went back out of it. */
export const COLLECTED_SQL = `
  SELECT
    coalesce((SELECT sum(p.amount_cents) FROM payments p
      WHERE p.workspace_id = ? AND p.status = 'succeeded'
        AND coalesce(p.received_at, p.created_at) >= ?), 0) AS collected_cents,
    coalesce((SELECT sum(r.amount_cents) FROM refunds r
      WHERE r.workspace_id = ? AND r.status = 'succeeded'
        AND coalesce(r.refunded_at, r.created_at) >= ?), 0) AS refunded_cents`;

/** Money's changes on this phone: cash and checks recorded here, and documents sent from here. */
export const MONEY_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND (name LIKE 'invoice.%' OR name LIKE 'estimate.%' OR name = 'subscription.request_card')
    AND (state != 'sent' OR sent_at >= ?)
  ORDER BY seq`;

/** This person's role in the business, which decides whether they see the business's money or only their jobs'. */
export const MY_ROLE_SQL = `
  SELECT role FROM workspace_access WHERE workspace_id = ? AND user_id = ? LIMIT 1`;
