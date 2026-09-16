-- =============================================================================
-- 0050 · Who sees money, and what they may do with it. Two permissions:
--        money.manage (owner, admin) creates, sends, voids and refunds;
--        money.read (owner, admin, member) sees. The catalogue is open to
--        everyone with money.read; connected accounts, plans and the numbering
--        counters are owners and admins only.
--
--        The member rule is the new thing here, and it is the product's first
--        real per-row visibility: a member sees a document, its lines, its
--        payments and its refunds when they are staffed on the appointment it
--        is linked to, or they are the assignee of the lead it is linked to.
--        **A document tied to neither is owner business.** It is enforced in
--        RLS, through one definer helper the queries apply as their predicate
--        too, so a missing WHERE in a query layer can never widen it. Owners
--        and admins never pay for the lookup: they match the money.manage
--        policies in 0045 and 0047 and never reach these.
--
--        Also here: the grants for 0044-0048 (payment_connections keeps its
--        own column grants in 0046, next to the guard that hides the tokens),
--        an index that leads with its column for every foreign key those
--        migrations added (0020's rule; a nullable key's index is partial over
--        the rows that have one, as in 0043), and the two new webhook
--        providers.
-- =============================================================================

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'money.read'), ('owner', 'money.manage'),
  ('admin', 'money.read'), ('admin', 'money.manage'),
  ('member', 'money.read');

-- ---------- the member rule ----------
-- The one place the rule lives, and the whole of it. Written so the plan is two primary-key probes and nothing
-- else: app.appointment_attendees by id, then app.appointment_staff by its own (appointment_id, user_id) key.
-- The booking arm is a scalar subquery rather than a join because a join leaves the order to the planner, and
-- the tenant is checked on the staff row rather than on the attendee for the same reason — a second indexable
-- equality on the attendee invites a walk down the workspace index instead. They are the same answer:
-- appointment_staff and appointment_attendees for one appointment always carry that appointment's workspace.
-- Measured over 6,000 visits: 5 buffer hits, 0.04 ms. A null id matches nothing, which is what makes a
-- document with neither a lead nor a booking owner business. SECURITY DEFINER, so the answer does not depend
-- on what the caller may already see.
create or replace function private.money_member_sees(p_ws uuid, p_lead uuid, p_attendee uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from app.leads l
      where l.id = p_lead and l.workspace_id = p_ws and l.assignee_user_id = auth.uid())
    or exists (
      select 1 from app.appointment_staff s
      where s.appointment_id = (select a.appointment_id from app.appointment_attendees a where a.id = p_attendee)
        and s.user_id = auth.uid() and s.active and s.workspace_id = p_ws)
$$;

-- The same rule, reached from a line, a payment or a refund: they follow their document.
create or replace function private.money_estimate_visible(p_ws uuid, p_estimate uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.estimates e
    where e.id = p_estimate and e.workspace_id = p_ws
      and private.money_member_sees(e.workspace_id, e.lead_id, null))
$$;

create or replace function private.money_invoice_visible(p_ws uuid, p_invoice uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.invoices i
    where i.id = p_invoice and i.workspace_id = p_ws
      and private.money_member_sees(i.workspace_id, i.lead_id, i.attendee_id))
$$;

-- A member is someone who may see money but not manage it. Saying that here, rather than leaving it to the
-- order two permissive policies happen to be OR-ed in, keeps the lookup off every row an owner reads.
create policy estimates_member_select on app.estimates for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_member_sees(workspace_id, lead_id, null));
create policy estimate_lines_member_select on app.estimate_lines for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_estimate_visible(workspace_id, estimate_id));
create policy invoices_member_select on app.invoices for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_member_sees(workspace_id, lead_id, attendee_id));
create policy invoice_lines_member_select on app.invoice_lines for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_invoice_visible(workspace_id, invoice_id));
create policy payments_member_select on app.payments for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_invoice_visible(workspace_id, invoice_id));
create policy refunds_member_select on app.refunds for select to authenticated
  using (private.has_permission(workspace_id, 'money.read')
    and not private.has_permission(workspace_id, 'money.manage')
    and private.money_invoice_visible(workspace_id, invoice_id));

-- ---------- grants: people ----------
-- The catalogue and the documents. Nothing here is deleted: a product is archived and a document is voided, so
-- an invoice still says the same thing next year and a number is never reused. Lines are the exception — they
-- are edited until the document goes out, and the guard in 0045 freezes them the moment it does.
grant select, insert, update on app.products, app.plans to authenticated;
grant select, insert, update on app.document_counters to authenticated;
grant select, insert, update on app.estimates, app.invoices to authenticated;
grant select, insert, update, delete on app.estimate_lines, app.invoice_lines to authenticated;
-- A cash or cheque payment a person records, and a refund they ask for. Everything the provider says, and
-- everything an invoice has been paid, is written by the roll-up and the worker (0047).
grant select, insert on app.payments, app.refunds to authenticated;
grant select, insert, update on app.subscriptions to authenticated;

-- ---------- grants: the worker ----------
grant select, insert, update, delete on app.products, app.plans, app.document_counters, app.estimates,
  app.estimate_lines, app.invoices, app.invoice_lines, app.payments, app.refunds, app.subscriptions
  to service_actor;
revoke all on app.products, app.plans, app.document_counters, app.estimates, app.estimate_lines, app.invoices,
  app.invoice_lines, app.payments, app.refunds, app.subscriptions from anon;

-- ---------- webhooks from the two providers that ship ----------
alter table app.webhook_deliveries
  drop constraint webhook_deliveries_provider_check,
  add constraint webhook_deliveries_provider_check
    check (provider in ('twilio', 'postmark', 'microsoft', 'google', 'fake', 'workflow', 'stripe', 'square'));

-- ---------- 0044 · the catalogue ----------
create index products_workspace_id_idx on app.products (workspace_id);
create index products_service_id_idx on app.products (service_id) where service_id is not null;
create index products_created_by_idx on app.products (created_by) where created_by is not null;
create index plans_workspace_id_idx on app.plans (workspace_id);
create index plans_created_by_idx on app.plans (created_by) where created_by is not null;

-- ---------- 0045 · the documents and their lines ----------
create index estimates_assignee_user_id_idx on app.estimates (assignee_user_id) where assignee_user_id is not null;
create index estimates_accepted_by_idx on app.estimates (accepted_by) where accepted_by is not null;
create index estimates_voided_by_idx on app.estimates (voided_by) where voided_by is not null;
create index estimates_created_by_idx on app.estimates (created_by) where created_by is not null;
create index estimate_lines_workspace_id_idx on app.estimate_lines (workspace_id);
create index estimate_lines_product_id_idx on app.estimate_lines (product_id) where product_id is not null;
create index invoices_assignee_user_id_idx on app.invoices (assignee_user_id) where assignee_user_id is not null;
create index invoices_estimate_id_idx on app.invoices (estimate_id) where estimate_id is not null;
create index invoices_attendee_id_idx on app.invoices (attendee_id) where attendee_id is not null;
create index invoices_subscription_id_idx on app.invoices (subscription_id) where subscription_id is not null;
create index invoices_connection_id_idx on app.invoices (connection_id) where connection_id is not null;
create index invoices_voided_by_idx on app.invoices (voided_by) where voided_by is not null;
create index invoices_created_by_idx on app.invoices (created_by) where created_by is not null;
create index invoice_lines_workspace_id_idx on app.invoice_lines (workspace_id);
create index invoice_lines_product_id_idx on app.invoice_lines (product_id) where product_id is not null;

-- ---------- 0046 · connected accounts ----------
create index payment_connections_workspace_id_idx on app.payment_connections (workspace_id);
create index payment_connections_created_by_idx on app.payment_connections (created_by) where created_by is not null;

-- ---------- 0047 · payments and refunds ----------
create index payments_workspace_id_idx on app.payments (workspace_id);
create index payments_connection_id_idx on app.payments (connection_id) where connection_id is not null;
create index payments_recorded_by_idx on app.payments (recorded_by) where recorded_by is not null;
create index refunds_workspace_id_idx on app.refunds (workspace_id);
create index refunds_connection_id_idx on app.refunds (connection_id) where connection_id is not null;
create index refunds_requested_by_idx on app.refunds (requested_by) where requested_by is not null;

-- ---------- 0048 · subscriptions ----------
create index subscriptions_plan_id_idx on app.subscriptions (plan_id) where plan_id is not null;
create index subscriptions_lead_id_idx on app.subscriptions (lead_id) where lead_id is not null;
create index subscriptions_connection_id_idx on app.subscriptions (connection_id) where connection_id is not null;
create index subscriptions_created_by_idx on app.subscriptions (created_by) where created_by is not null;

-- ---------- function privileges ----------
revoke all on function
  private.money_member_sees(uuid, uuid, uuid), private.money_estimate_visible(uuid, uuid),
  private.money_invoice_visible(uuid, uuid)
  from public;
grant execute on function
  private.money_member_sees(uuid, uuid, uuid), private.money_estimate_visible(uuid, uuid),
  private.money_invoice_visible(uuid, uuid)
  to authenticated, service_actor;
