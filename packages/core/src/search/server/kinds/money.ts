/**
 * Money (money.read): estimates and invoices by number (the whole of it, or its counter), an amount typed as money,
 * title, notes and customer, drafts included; payments that went through, by amount, the card's last 4, or their
 * invoice's number or customer. Never a provider's or an idempotency id.
 *
 * Each statement adds core's member rule as the money lists do (`estimateMemberClause`, `invoiceMemberClause`), so a
 * member finds only the bills of jobs they're on, view-as included; row security still decides. A bill whose
 * customer isn't live (in the bin, erased or merged) keeps only the name, with no way to call or text them.
 */
import { sql } from 'drizzle-orm';
import { documentNumberMatches } from '../../../money/numbering';
import { PAYMENT_METHOD_LABELS } from '../../../money/words';
import { estimateMemberClause, invoiceMemberClause } from '../../../queries/money';
import type { SearchHit } from '../../../schemas/search';
import { searchHref } from '../../href';
import type { SearchProbes } from '../../probes';
import { fieldHolding, fieldSnippet, hitOf, holdsAll, isoOf, wordsLeft } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { LIVE_PERSON, likeAll, numberMatches } from '../sql';

interface DocRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  title: string | null;
  notes: string | null;
  status: string;
  total_cents: string | number;
  currency: string;
  due_on: string | null;
  sent_at: Date | null;
  first_viewed_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  person_id: string | null;
  customer: string | null;
  customer_live: boolean;
  phone_e164: string | null;
  email: string | null;
}

interface PaymentRow extends Record<string, unknown> {
  id: string;
  amount_cents: string | number;
  currency: string;
  card_last4: string | null;
  method: keyof typeof PAYMENT_METHOD_LABELS;
  received_at: Date | null;
  created_at: Date;
  invoice_id: string;
  number: string | null;
  person_id: string | null;
  customer: string | null;
  customer_live: boolean;
  phone_e164: string | null;
  email: string | null;
}

const why = (field: string, snippet: SearchHit['why']['snippet'] = null): SearchHit['why'] => ({
  field,
  label: null,
  snippet,
  page: null,
});

/** The tier a document matched at, in core: the same tests as its SQL. */
function explainDoc(r: DocRow, p: SearchProbes): Pick<SearchHit, 'tier' | 'exact' | 'why'> {
  if (p.number && documentNumberMatches(r.number, p.number))
    return { tier: 0, exact: true, why: why('number') };
  if (p.amount !== null && Number(r.total_cents) === p.amount)
    return { tier: 0, exact: true, why: why('amount') };
  if (holdsAll([r.number, r.title], p)) return { tier: 2, exact: false, why: why('title') };
  // Tier 3: the customer or the notes, whichever holds the words the number and title don't.
  const field = fieldHolding(wordsLeft([r.number, r.title], p), [
    { field: 'customer', text: r.customer },
    { field: 'note', text: r.notes },
  ]);
  if (field === 'note')
    return { tier: 3, exact: false, why: why('note', fieldSnippet(r.notes, p)) };
  if (field === 'customer')
    return { tier: 3, exact: false, why: why('customer', fieldSnippet(r.customer, p)) };
  return { tier: 3, exact: false, why: why('title') };
}

const contactOf = (r: {
  person_id: string | null;
  customer_live: boolean;
  phone_e164: string | null;
  email: string | null;
}) =>
  r.person_id && r.customer_live
    ? { personId: r.person_id, phoneE164: r.phone_e164, email: r.email }
    : null;

function docHit(r: DocRow, docKind: 'invoice' | 'estimate', plan: SearchPlan): SearchHit {
  const noun = docKind === 'invoice' ? 'Invoice' : 'Estimate';
  const title = r.number
    ? `${noun} #${r.number}`
    : [`Draft ${noun.toLowerCase()}`, r.title].filter(Boolean).join(' · ');
  const late = docKind === 'invoice' && r.status === 'overdue';
  return hitOf({
    kind: 'money',
    id: r.id,
    title,
    subtitle: r.number ? r.title : null,
    href: searchHref(plan.workspaceId, { type: docKind, id: r.id }),
    ...explainDoc(r, plan.p),
    badges: [
      ...(r.status === 'void' ? ['void'] : []),
      ...(r.status === 'draft' ? ['draft'] : []),
      ...(late ? ['late'] : []),
      ...(docKind === 'invoice' && r.status === 'paid' ? ['paid'] : []),
    ],
    at: isoOf(r.created_at),
    contact: contactOf(r),
    amount: { cents: Number(r.total_cents), currency: r.currency.trim() },
    facts: {
      docKind,
      status: r.status,
      ...(r.number ? { number: r.number } : {}),
      ...(r.customer?.trim() ? { customer: r.customer.trim() } : {}),
      ...(r.due_on ? { dueOn: r.due_on } : {}),
      ...(r.sent_at ? { sentAt: isoOf(r.sent_at)!, openedAt: isoOf(r.first_viewed_at) } : {}),
      ...(r.paid_at ? { paidAt: isoOf(r.paid_at)! } : {}),
    },
  });
}

function paymentHit(r: PaymentRow, plan: SearchPlan): SearchHit {
  const p = plan.p;
  const tier =
    (p.amount !== null && Number(r.amount_cents) === p.amount) ||
    (p.card4 && r.card_last4 === p.card4)
      ? 0
      : 3;
  const field =
    p.amount !== null && Number(r.amount_cents) === p.amount
      ? 'amount'
      : p.card4 && r.card_last4 === p.card4
        ? 'card'
        : p.number && documentNumberMatches(r.number, p.number)
          ? 'number'
          : 'customer';
  return hitOf({
    kind: 'money',
    id: r.id,
    title: `Payment · ${PAYMENT_METHOD_LABELS[r.method] ?? 'Payment'}`,
    href: searchHref(plan.workspaceId, { type: 'invoice', id: r.invoice_id }),
    tier,
    exact: tier === 0,
    why: why(field, field === 'customer' ? fieldSnippet(r.customer, p) : null),
    badges: ['paid'],
    at: isoOf(r.received_at ?? r.created_at),
    contact: contactOf(r),
    amount: { cents: Number(r.amount_cents), currency: r.currency.trim() },
    facts: {
      docKind: 'payment',
      ...(r.number ? { invoiceNumber: r.number } : {}),
      ...(r.customer?.trim() ? { customer: r.customer.trim() } : {}),
      ...(r.received_at ? { paidAt: isoOf(r.received_at)! } : {}),
    },
  });
}

/** One statement for invoices or estimates; `d` is the alias the member clause expects. */
function documents(plan: SearchPlan, docKind: 'invoice' | 'estimate') {
  const { p } = plan;
  const d = sql.raw(docKind === 'invoice' ? 'i' : 'e');
  const table = sql.raw(docKind === 'invoice' ? 'app.invoices i' : 'app.estimates e');
  const member =
    docKind === 'invoice' ? invoiceMemberClause(plan.ctx) : estimateMemberClause(plan.ctx);
  const exact = sql`(${numberMatches(sql`${d}.number`, p.number)}
    or ${p.amount !== null ? sql`${d}.total_cents = ${p.amount}` : sql`false`})`;
  const titled = likeAll(
    sql`lower(coalesce(${d}.number, '') || ' ' || coalesce(${d}.title, ''))`,
    p.likes,
  );
  const words = likeAll(
    sql`lower(coalesce(${d}.number, '') || ' ' || coalesce(${d}.title, '') || ' ' || coalesce(${d}.notes, '') || ' ' ||
        concat_ws(' ', p.first_name, p.last_name))`,
    p.likes,
  );
  const order =
    plan.sort === 'name'
      ? sql`sort_name, ${d}.id`
      : plan.sort === 'recent'
        ? sql`${d}.created_at desc, ${d}.id desc`
        : sql`tier, (${d}.status = 'void'), ${d}.created_at desc, ${d}.id`;
  return sql`select ${d}.id, ${d}.number, ${d}.title, ${d}.notes, ${d}.status::text as status, ${d}.total_cents,
      ${d}.currency, ${docKind === 'invoice' ? sql`${d}.due_on::text` : sql`null::text`} as due_on,
      ${d}.sent_at, ${d}.first_viewed_at, ${docKind === 'invoice' ? sql`${d}.paid_at` : sql`null::timestamptz`} as paid_at,
      ${d}.created_at, ${d}.person_id,
      nullif(concat_ws(' ', p.first_name, p.last_name), '') as customer,
      (p.id is not null and ${LIVE_PERSON('p')}) as customer_live, p.phone_e164, p.email::text as email,
      lower(coalesce(${d}.number, ${d}.title, '')) as sort_name,
      case when ${exact} then 0 when ${titled} then 2 else 3 end as tier
    from ${table}
    left join app.people p on p.id = ${d}.person_id
    where ${d}.workspace_id = ${plan.workspaceId} ${member}
      and (${exact} or ${words})
      ${plan.onlyMine && plan.me ? sql`and ${d}.assignee_user_id = ${plan.me}` : sql``}
    order by ${order}
    limit ${plan.limit}`;
}

export const moneySearcher: KindSearcher = {
  key: 'money',
  async find(db, plan) {
    const { p } = plan;
    // Bills aren't archived; the Archived page has nothing here.
    if (plan.archivedOnly) return [{ kind: 'money', label: null, icon: null, hits: [] }];
    const invoices = await db.rows<DocRow>(documents(plan, 'invoice'));
    const estimates = await db.rows<DocRow>(documents(plan, 'estimate'));
    const paymentExact = sql`(${p.amount !== null ? sql`pay.amount_cents = ${p.amount}` : sql`false`}
      or ${p.card4 ? sql`pay.card_last4 = ${p.card4}` : sql`false`})`;
    const payments = await db.rows<PaymentRow>(
      sql`select pay.id, pay.amount_cents, pay.currency, pay.card_last4, pay.method::text as method,
            pay.received_at, pay.created_at, i.id as invoice_id, i.number, i.person_id,
            nullif(concat_ws(' ', p.first_name, p.last_name), '') as customer,
            (p.id is not null and ${LIVE_PERSON('p')}) as customer_live, p.phone_e164, p.email::text as email
          from app.payments pay
          join app.invoices i on i.id = pay.invoice_id ${invoiceMemberClause(plan.ctx)}
          left join app.people p on p.id = i.person_id
          where pay.workspace_id = ${plan.workspaceId} and pay.status = 'succeeded'
            and (${paymentExact}
              or ${numberMatches(sql`i.number`, p.number)}
              or ${likeAll(sql`lower(concat_ws(' ', p.first_name, p.last_name))`, p.likes)})
            ${plan.onlyMine && plan.me ? sql`and i.assignee_user_id = ${plan.me}` : sql``}
          order by ${
            plan.sort === 'recent'
              ? sql`coalesce(pay.received_at, pay.created_at) desc, pay.id desc`
              : sql`(case when ${paymentExact} then 0 else 3 end), pay.received_at desc nulls last, pay.created_at desc`
          }
          limit ${plan.limit}`,
    );
    return [
      {
        kind: 'money',
        label: null,
        icon: null,
        hits: [
          ...invoices.map((r) => docHit(r, 'invoice', plan)),
          ...estimates.map((r) => docHit(r, 'estimate', plan)),
          ...payments.map((r) => paymentHit(r, plan)),
        ],
      },
    ];
  },
};
