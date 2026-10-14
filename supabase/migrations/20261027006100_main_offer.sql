-- =============================================================================
-- The main offer, step 1 (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Part 1).
--        The business's one main offer: who it helps, the result, how fast,
--        how, the guarantee and the price, built and scored with the AI. It's
--        core's, so add-ons share it without reading each other's data, and it
--        shows only while an add-on that uses it is on (an add-on's manifest
--        `uses`); the commands refuse otherwise.
--        A draft is edited while the live version keeps running; publishing
--        keeps it as a numbered version that never changes, with its score.
--        Not the promotions under Knowledge (app.offers), HandsFreeOS's own
--        founding offers, or Real Estate's offers on a home.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'main_offer';

-- ---------- the permission ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'main_offer.manage'),
  ('admin', 'main_offer.manage');
insert into app.customizable_permissions (permission, requires) values ('main_offer.manage', '{}');

-- ---------- the offer: one a business, with the draft being edited ----------
create table app.main_offers (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  -- The parts as they're being edited (packages/core/src/main-offer/parts.ts); null when no draft is open.
  draft jsonb check (draft is null or (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 40000)),
  -- Goes up with every save, so a score is for the draft it read and two editors can't undo each other.
  revision integer not null default 0 check (revision >= 0),
  -- The AI's score of the draft at scored_revision (only the worker's command writes one); stale once the draft
  -- moves on.
  score jsonb check (score is null or jsonb_typeof(score) = 'object'),
  scored_revision integer,
  draft_by uuid references app.users (id) on delete set null,
  draft_at timestamptz,
  -- The version running now; null until the first is published.
  live_version integer check (live_version is null or live_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger main_offers_updated_at before update on app.main_offers for each row execute function private.set_updated_at();

-- ---------- each version published, never changed ----------
create table app.main_offer_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  version integer not null check (version >= 1),
  parts jsonb not null check (jsonb_typeof(parts) = 'object' and octet_length(parts::text) <= 40000),
  -- The one-line offer, as published.
  line text not null check (length(btrim(line)) between 1 and 600),
  score jsonb not null check (jsonb_typeof(score) = 'object'),
  -- Why it went live below the bar (Use it anyway); null when it cleared it.
  anyway text check (anyway is null or length(btrim(anyway)) between 1 and 300),
  published_by uuid references app.users (id) on delete set null,
  published_at timestamptz not null default now(),
  unique (workspace_id, version)
);
create trigger main_offer_versions_append_only before update on app.main_offer_versions
  for each row execute function private.forbid_change();

alter table app.main_offers enable row level security;
alter table app.main_offer_versions enable row level security;

-- Everyone in the business reads it: the people reaching out say it. Only main_offer.manage changes it.
create policy main_offers_select on app.main_offers for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy main_offers_insert on app.main_offers for insert to authenticated
  with check (private.has_permission(workspace_id, 'main_offer.manage'));
create policy main_offers_update on app.main_offers for update to authenticated
  using (private.has_permission(workspace_id, 'main_offer.manage'))
  with check (private.has_permission(workspace_id, 'main_offer.manage'));
create policy main_offers_service_all on app.main_offers for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy main_offer_versions_select on app.main_offer_versions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy main_offer_versions_insert on app.main_offer_versions for insert to authenticated
  with check (private.has_permission(workspace_id, 'main_offer.manage') and published_by = (select auth.uid()));
create policy main_offer_versions_service_all on app.main_offer_versions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update on app.main_offers to authenticated;
grant select, insert, update on app.main_offers to service_actor;
grant select, insert on app.main_offer_versions to authenticated;
grant select, insert on app.main_offer_versions to service_actor;
revoke all on app.main_offers, app.main_offer_versions from anon;
