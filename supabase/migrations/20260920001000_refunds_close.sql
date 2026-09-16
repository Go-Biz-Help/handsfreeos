-- =============================================================================
-- 0053 · A refund gives money back. It never puts it back on the bill.
--
--        Until now a refund reopened the invoice it was made on: the balance
--        was `total − paid + refunded`, and the roll-up (0047) put a refunded
--        invoice back to partly paid or sent and cleared `paid_at`. So the
--        reminder ladder chased the customer for the money they had just been
--        given back, the overdue job could mark it late, Home counted it in
--        "$ affected", the customer's own page offered Pay for it, and it could
--        never be voided, because something had been paid on it.
--
--        That is not what a refund is anywhere else. Stripe, Square and
--        QuickBooks all keep a refunded invoice paid and record the money
--        going back beside it. So here too:
--        - **What is owed is `total − paid`.** A refund only ever uses up an
--          overpayment first — a credit still shows as a negative balance until
--          it has gone back — and never reopens what was owed.
--        - **Paid is what was paid, gross.** An invoice is paid once what came
--          in reaches its total, and giving money back later never unpays it or
--          clears `paid_at`.
--        - **To bill again, the business voids it and sends a new one.** Voiding
--          becomes possible once everything paid on it has been given back
--          (`invoice.void` in core says so in words); nothing here changes who
--          may void.
--
--        "Refunded" and "Partly refunded" are worked out for the screen from
--        these figures, the way "Opened" and "Paying" are, and never stored.
-- =============================================================================

-- ---------- what is still owed ----------
-- Nothing reads the column through an index, a view or a policy (checked against pg_depend), so the
-- expression can be swapped in place. Postgres 17 rewrites the stored values as it does.
alter table app.invoices
  alter column balance_cents set expression as (
    greatest(total_cents - amount_paid_cents, least(0, total_cents - amount_paid_cents + amount_refunded_cents))
  );

comment on column app.invoices.balance_cents is
  'What is still owed: total less what was paid. A refund only uses up an overpayment; it never reopens the bill.';

-- ---------- what an invoice has been paid ----------
-- The same recount as 0047, under the same row lock, with one rule changed: the status and paid_at follow
-- what was paid, gross. The refunded figure is still counted, so the screens and the customer's page can say
-- what went back and when. SECURITY DEFINER, for the reason 0047 gives: it writes columns no role is granted.
create or replace function private.money_roll_up_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_invoice uuid;
  v_paid bigint;
  v_refunded bigint;
  v_total bigint;
  v_voided timestamptz;
  v_status app.invoice_status;
begin
  if tg_op = 'DELETE' then v_invoice := old.invoice_id; else v_invoice := new.invoice_id; end if;
  select i.total_cents, i.voided_at, i.status into v_total, v_voided, v_status
    from app.invoices i where i.id = v_invoice for update;
  if not found then
    return null;
  end if;
  select coalesce(sum(p.amount_cents), 0) into v_paid
    from app.payments p where p.invoice_id = v_invoice and p.status = 'succeeded';
  select coalesce(sum(r.amount_cents), 0) into v_refunded
    from app.refunds r where r.invoice_id = v_invoice and r.status = 'succeeded';
  update app.invoices i set
    amount_paid_cents = v_paid,
    amount_refunded_cents = v_refunded,
    -- Refunds play no part: money going back never clears when the invoice was paid.
    paid_at = case
      when v_voided is not null then i.paid_at
      when v_total > 0 and v_paid >= v_total then coalesce(i.paid_at, now()) end,
    status = case
      when v_voided is not null or v_status = 'draft' then v_status
      when v_total > 0 and v_paid >= v_total then 'paid'::app.invoice_status
      when v_paid > 0 then 'partly_paid'::app.invoice_status
      -- Only if what was paid ever fell. Payments only move forward (0047), so today this never runs; it is
      -- kept so a payment row that goes can't leave an invoice saying it was paid.
      when v_status in ('paid', 'partly_paid') then 'sent'::app.invoice_status
      else v_status end
  where i.id = v_invoice;
  return null;
end $$;

-- ---------- the invoices a refund already reopened ----------
-- Only invoices with a refund that went through can have been reopened, so only those are looked at. Each is
-- put back where the rule above would have left it:
-- - paid in full: paid again, and paid on the day the payment that settled it arrived (the old recount
--   cleared that day, and the payments still say when it was);
-- - a sent invoice with money on it: partly paid. An overdue one stays overdue — the job marked that, not the
--   refund — and a draft or a voided invoice keeps its status, exactly as the recount does.
update app.invoices i set
  status = case
    when i.status = 'draft' then i.status
    when i.total_cents > 0 and i.amount_paid_cents >= i.total_cents then 'paid'::app.invoice_status
    when i.status = 'sent' and i.amount_paid_cents > 0 then 'partly_paid'::app.invoice_status
    else i.status end,
  paid_at = case
    when i.total_cents > 0 and i.amount_paid_cents >= i.total_cents then coalesce(i.paid_at, (
      select min(settled.received_at)
      from (
        select p.received_at,
          sum(p.amount_cents) over (order by p.received_at, p.id) as running_cents
        from app.payments p
        where p.invoice_id = i.id and p.status = 'succeeded'
      ) as settled
      where settled.running_cents >= i.total_cents), now())
    else i.paid_at end
where i.voided_at is null
  and exists (select 1 from app.refunds r where r.invoice_id = i.id and r.status = 'succeeded');

-- ---------- function privileges ----------
-- `create or replace` keeps 0047's grants; they are restated so this file says who may run what on its own.
revoke all on function private.money_roll_up_invoice() from public;
grant execute on function private.money_roll_up_invoice() to authenticated, service_actor;
