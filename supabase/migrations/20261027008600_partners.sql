-- =============================================================================
-- Partners in core (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2a; docs/outreach.md decision 81).
--
--        Someone who sends the business its customers for a share of what
--        they pay. Social Outreach finds and asks them; once they're a
--        partner, they're core's, since what they earn comes from core's
--        payments. It shows only while an add-on that uses it is on (an
--        add-on's manifest `uses: ['partners']`); people's commands refuse
--        otherwise, while the worker's keep counting what was promised.
--
--        `partners` is the partner: their contact, the code in their link
--        (`?ref=pa-<code>` on the business's booking page), their own rate
--        when it isn't the business's default, and whether they're active,
--        paused or ended. `partner_referrals` is each client they sent, by
--        their link or marked by hand: each customer is one partner's, the
--        first to send them. `partner_commissions` is each payment's share
--        in the client's first 12 months, and what a refund takes back,
--        free to pay out 30 days after it's earned.
--
--        Only partners.manage (owners and admins, or whoever an owner gives
--        it) sees or changes any of it: it's what the business owes. The
--        worker writes the commissions. A customer deleted for good lets go
--        of their referral, so what they earned their partner stays.
--
-- Only adds: a permission, three tables, and partners' settings behind their own permission.
-- =============================================================================

-- ---------- the permission ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'partners.manage'),
  ('admin', 'partners.manage');
insert into app.customizable_permissions (permission, requires) values ('partners.manage', '{}');

-- ---------- partners' settings (settings.partners), behind their own permission as money's are ----------
create or replace function private.guard_owned_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if ((new.settings -> 'inbox') is distinct from (old.settings -> 'inbox')
      or (new.settings -> 'telephony') is distinct from (old.settings -> 'telephony'))
     and not private.has_permission(new.id, 'channels.manage') then
    raise exception 'Only someone who manages channels changes this'
      using errcode = '42501', detail = 'setting_needs_channels_manage';
  end if;
  if (new.settings -> 'money') is distinct from (old.settings -> 'money')
     and not private.has_permission(new.id, 'money.manage') then
    raise exception 'Only someone who manages money changes this'
      using errcode = '42501', detail = 'setting_needs_money_manage';
  end if;
  if (new.settings -> 'partners') is distinct from (old.settings -> 'partners')
     and not private.has_permission(new.id, 'partners.manage') then
    raise exception 'Only someone who manages partners changes this'
      using errcode = '42501', detail = 'setting_needs_partners_manage';
  end if;
  return new;
end $$;

-- ---------- the partners ----------
create table app.partners (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Their contact: one partner a contact.
  person_id uuid not null references app.people (id) on delete cascade,
  -- What their link carries (`pa-<code>`): letters and digits, unguessable.
  code text not null unique check (code ~ '^[A-Za-z0-9]{10}$'),
  -- Their own share in basis points; null for the business's default (settings.partners.rateBp).
  rate_bp integer check (rate_bp is null or rate_bp between 1 and 10000),
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  -- The version of the business's terms they accepted on their page, and when.
  terms_version integer check (terms_version is null or terms_version >= 1),
  terms_accepted_at timestamptz,
  added_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, person_id),
  check ((terms_version is null) = (terms_accepted_at is null))
);
create trigger partners_updated_at before update on app.partners
  for each row execute function private.set_updated_at();

-- ---------- the clients they sent ----------
create table app.partner_referrals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  partner_id uuid not null references app.partners (id) on delete cascade,
  -- Null once the customer is deleted for good: what they earned the partner stays.
  person_id uuid references app.people (id) on delete set null,
  how text not null check (how in ('link', 'by_hand')),
  -- The booking through their link it came from.
  appointment_id uuid references app.appointments (id) on delete set null,
  referred_at timestamptz not null,
  -- Their first payment after they were referred: their 12 months start then (decision 7).
  first_paid_at timestamptz,
  marked_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Each customer is one partner's.
  unique (workspace_id, person_id)
);
create index partner_referrals_partner on app.partner_referrals (partner_id);

-- ---------- what they earned ----------
create table app.partner_commissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  partner_id uuid not null references app.partners (id) on delete cascade,
  -- Never cascades: a client who earned their partner something stays theirs (partner.referral_set refuses).
  referral_id uuid not null references app.partner_referrals (id),
  -- The payment it's a share of, and for one taken back, the refund that took it.
  payment_id uuid not null references app.payments (id) on delete cascade,
  refund_id uuid references app.refunds (id) on delete cascade,
  kind text not null check (kind in ('earned', 'taken_back')),
  -- What it was worked out on (what the client paid, or what was refunded), and the rate then.
  base_cents bigint not null check (base_cents > 0),
  rate_bp integer not null check (rate_bp between 1 and 10000),
  -- Positive when earned, negative when taken back.
  amount_cents bigint not null check (amount_cents <> 0),
  earned_at timestamptz not null,
  -- Free to pay out 30 days after it's earned (decision 8). One taken back comes off with what it takes from: then,
  -- or at once when that's free already.
  payable_at timestamptz not null,
  -- A payment taken in a provider's test mode: kept to show, never paid out.
  test boolean not null default false,
  created_at timestamptz not null default now(),
  check ((kind = 'earned') = (amount_cents > 0)),
  check ((kind = 'earned') = (refund_id is null))
);
-- A payment earns once, and a refund takes back once.
create unique index partner_commissions_earned on app.partner_commissions (payment_id) where kind = 'earned';
create unique index partner_commissions_refund on app.partner_commissions (refund_id) where refund_id is not null;
create index partner_commissions_partner on app.partner_commissions (partner_id, earned_at);

-- ---------- who sees them: partners.manage, and the worker ----------
alter table app.partners enable row level security;
alter table app.partner_referrals enable row level security;
alter table app.partner_commissions enable row level security;

create policy partners_select on app.partners for select to authenticated
  using (private.has_permission(workspace_id, 'partners.manage'));
create policy partners_insert on app.partners for insert to authenticated
  with check (private.has_permission(workspace_id, 'partners.manage'));
create policy partners_update on app.partners for update to authenticated
  using (private.has_permission(workspace_id, 'partners.manage'))
  with check (private.has_permission(workspace_id, 'partners.manage'));
create policy partners_service_all on app.partners for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy partner_referrals_select on app.partner_referrals for select to authenticated
  using (private.has_permission(workspace_id, 'partners.manage'));
create policy partner_referrals_insert on app.partner_referrals for insert to authenticated
  with check (private.has_permission(workspace_id, 'partners.manage'));
create policy partner_referrals_delete on app.partner_referrals for delete to authenticated
  using (private.has_permission(workspace_id, 'partners.manage'));
create policy partner_referrals_service_all on app.partner_referrals for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy partner_commissions_select on app.partner_commissions for select to authenticated
  using (private.has_permission(workspace_id, 'partners.manage'));
create policy partner_commissions_service_all on app.partner_commissions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update on app.partners to authenticated;
grant select, insert, update on app.partners to service_actor;
grant select, insert, delete on app.partner_referrals to authenticated;
grant select, insert, update, delete on app.partner_referrals to service_actor;
grant select on app.partner_commissions to authenticated;
grant select, insert, update on app.partner_commissions to service_actor;
revoke all on app.partners, app.partner_referrals, app.partner_commissions from anon;
