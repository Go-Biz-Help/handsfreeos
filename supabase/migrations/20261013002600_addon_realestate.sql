-- =============================================================================
-- Real Estate Agent (realestate), step 6: its permissions, and its own tables.
--
--        Started with `pnpm addon:new realestate` (docs/addon-architecture.md,
--        HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md). A deal is a record of
--        its kind `realestate_deal`, kept to the people on it (step 4); these
--        tables hold what the add-on knows about each one, and follow the
--        deal's privacy through their record column (addon_table_policies).
--        Core never points at them.
--
--        **deals**: one per deal record. Which side (buyer or listing), its
--        stage and how it ended, the lead it came from, its commission (in
--        cents and basis points; the final figure is set with Approve
--        exceptions, owners and admins by default),
--        and its health as last worked out.
--        **deal_roles**: what each person on the deal does there (agent,
--        co-agent, coordinator, assistant); the main agent is the record's own.
--        **deal_links**: two deals that belong together, a row each way: both
--        sides of the same home, or a client's sale and their next purchase.
--        **deal_history**: what changed on a deal, append-only.
-- =============================================================================

select private.register_addon_permissions('realestate', '[
  {"key": "realestate.use", "label": "Work on deals", "description": "Open deals, and work the ones they’re on.",
   "defaultRoles": ["admin", "member"]},
  {"key": "realestate.all_deals", "label": "See every deal",
   "description": "Every deal in the business, not only the ones they’re on.", "defaultRoles": ["admin"],
   "requires": ["realestate.use"]},
  {"key": "realestate.except", "label": "Approve exceptions",
   "description": "Mark a duty done without its proof or waive it, with a reason, and set a deal’s final commission.",
   "defaultRoles": ["admin"], "requires": ["realestate.use"]},
  {"key": "realestate.manage", "label": "Run the deal settings",
   "description": "The list of duties, the alerts, business days and the add-on’s other settings.",
   "defaultRoles": ["admin"], "requires": ["realestate.use"]}
]'::jsonb);

select private.create_addon_schema('realestate');

-- ---------- deals ----------
create table addon_realestate.deals (
  record_id uuid primary key references app.custom_records (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  side text not null check (side in ('buyer', 'listing')),
  -- Where it stands (the add-on's own stages for its side), and since when.
  stage text not null check (stage ~ '^[a-z][a-z_]{0,39}$'),
  stage_entered_at timestamptz not null default now(),
  -- How it ended: closed, the contract terminated, the listing or search given up, or ended some other way.
  outcome text check (outcome in ('closed', 'terminated', 'lost', 'ended')),
  outcome_at timestamptz,
  outcome_reason text check (outcome_reason is null or length(outcome_reason) <= 500),
  -- The Pipeline lead it started from, when it did.
  lead_id uuid references app.leads (id) on delete set null,
  -- Commission: the agreed rate or flat amount, any credit given back, the business's split, what that comes to,
  -- and the final figure once someone with Approve exceptions sets it.
  commission_rate_bp integer check (commission_rate_bp between 0 and 10000),
  commission_flat_cents bigint check (commission_flat_cents >= 0),
  commission_credit_cents bigint not null default 0 check (commission_credit_cents >= 0),
  commission_split_bp integer check (commission_split_bp between 0 and 10000),
  expected_commission_cents bigint check (expected_commission_cents >= 0),
  final_commission_cents bigint check (final_commission_cents >= 0),
  final_commission_by uuid references app.users (id) on delete set null,
  final_commission_at timestamptz,
  -- Its health as last worked out (step 10), with the reasons it gives.
  health text not null default 'green' check (health in ('green', 'yellow', 'red')),
  health_reasons jsonb not null default '[]'::jsonb
    check (jsonb_typeof(health_reasons) = 'array' and pg_column_size(health_reasons) <= 16384),
  health_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, record_id),
  check ((outcome is null) = (outcome_at is null)),
  check (commission_rate_bp is null or commission_flat_cents is null),
  check ((final_commission_cents is null) = (final_commission_at is null))
);
create index deals_workspace_idx on addon_realestate.deals (workspace_id, stage) where outcome is null;
create index deals_lead_idx on addon_realestate.deals (lead_id) where lead_id is not null;
create index deals_created_by_idx on addon_realestate.deals (created_by) where created_by is not null;
create index deals_final_by_idx on addon_realestate.deals (final_commission_by)
  where final_commission_by is not null;

-- A deal row is about one of the add-on's deal records in the same business, and its lead is the business's too.
create or replace function addon_realestate.check_deal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
      select 1 from app.custom_records r
      join app.custom_record_types t on t.id = r.type_id
      where r.id = new.record_id and r.workspace_id = new.workspace_id
        and t.addon_id = 'realestate' and t.key = 'realestate_deal') then
    raise exception 'A deal is one of Real Estate Agent''s deal records in this business'
      using errcode = '23514', detail = 'realestate_not_a_deal';
  end if;
  if new.lead_id is not null and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id)
     and not exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger deals_check before insert or update of record_id, workspace_id, lead_id on addon_realestate.deals
  for each row execute function addon_realestate.check_deal();

select private.addon_table_policies('addon_realestate.deals', 'realestate.use', 'realestate.use', null, 'record_id');

-- ---------- deal_roles ----------
create table addon_realestate.deal_roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  user_id uuid not null references app.users (id) on delete cascade,
  role text not null check (role in ('agent', 'co_agent', 'coordinator', 'assistant')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deal_record_id, user_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index deal_roles_deal_idx on addon_realestate.deal_roles (workspace_id, deal_record_id);
create index deal_roles_user_idx on addon_realestate.deal_roles (user_id);

-- Only someone on the deal has a part in it.
create or replace function addon_realestate.check_deal_role()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
      select 1 from app.custom_records r
      where r.id = new.deal_record_id
        and (r.owner_user_id = new.user_id or new.user_id = any (r.team_user_ids))) then
    raise exception 'Put them on the deal first, then say what they do on it'
      using errcode = '23514', detail = 'realestate_role_not_on_deal';
  end if;
  return new;
end $$;
create trigger deal_roles_check before insert or update of deal_record_id, user_id on addon_realestate.deal_roles
  for each row execute function addon_realestate.check_deal_role();

select private.addon_table_policies('addon_realestate.deal_roles', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');

-- ---------- deal_links ----------
create table addon_realestate.deal_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  other_record_id uuid not null,
  -- same_home: the buyer's and the seller's side of one sale; sale_and_purchase: a client's sale and next home.
  kind text not null check (kind in ('same_home', 'sale_and_purchase')),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (deal_record_id, other_record_id, kind),
  check (deal_record_id <> other_record_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade,
  foreign key (workspace_id, other_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index deal_links_deal_idx on addon_realestate.deal_links (workspace_id, deal_record_id);
create index deal_links_other_idx on addon_realestate.deal_links (workspace_id, other_record_id);
create index deal_links_created_by_idx on addon_realestate.deal_links (created_by) where created_by is not null;

select private.addon_table_policies('addon_realestate.deal_links', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');

-- ---------- deal_history ----------
create table addon_realestate.deal_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('person', 'system', 'ai')),
  actor_user_id uuid references app.users (id) on delete set null,
  -- What changed, in one word: opened, stage, outcome, reopened, commission, final_commission, linked…
  what text not null check (what ~ '^[a-z][a-z_]{0,39}$'),
  before jsonb check (before is null or pg_column_size(before) <= 16384),
  after jsonb check (after is null or pg_column_size(after) <= 16384),
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index deal_history_deal_idx on addon_realestate.deal_history (workspace_id, deal_record_id, at);
create index deal_history_actor_idx on addon_realestate.deal_history (actor_user_id) where actor_user_id is not null;

select private.addon_table_policies('addon_realestate.deal_history', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- What happened stays as it happened.
create trigger deal_history_append_only before update on addon_realestate.deal_history
  for each row execute function private.forbid_change();
