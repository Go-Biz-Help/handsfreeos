-- =============================================================================
-- 0025 · The knowledge base. Each business keeps one: a profile (what they
--        do, services, area, hours, policies, tone of voice, words to use and
--        avoid) and items of four kinds (FAQs, articles, facts, and documents
--        whose text came from an uploaded file). Workflow AI steps and the
--        Assistant write only from the profile and published items, found by
--        Postgres full-text search (a weighted tsvector) plus trigram
--        similarity for typos. "Scan our website" reads the business's own
--        site and proposes suggestions; so do questions the AI couldn't answer
--        (gaps) and agency starter packs. Nothing enters the knowledge base
--        until a person accepts it. knowledge.manage (owners, admins) edits,
--        scans and accepts; everyone in the workspace reads. Website and
--        document text is data, never instructions.
-- =============================================================================

create type app.knowledge_item_kind as enum ('faq', 'article', 'fact', 'document');
create type app.knowledge_item_status as enum ('draft', 'published', 'archived');
create type app.knowledge_item_source as enum ('manual', 'website_scan', 'ai_suggestion', 'agency_pack');
create type app.knowledge_scan_status as enum ('queued', 'running', 'done', 'failed', 'cancelled');
create type app.knowledge_suggestion_reason as enum ('scan', 'gap', 'pack');
create type app.knowledge_suggestion_status as enum ('pending', 'accepted', 'rejected');

-- ---------- the profile: one per business ----------
create table app.knowledge_profiles (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  -- core's KnowledgeProfile (description, services, service area, hours, policies, tone, words to use and
  -- avoid, signature). Core validates it; the database keeps it an object of sane size.
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 65536),
  -- Whether AI may quote prices from the knowledge base. Off until the business turns it on.
  allow_prices boolean not null default false,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_profiles_updated_by_idx on app.knowledge_profiles (updated_by);
create trigger knowledge_profiles_updated_at before update on app.knowledge_profiles for each row execute function private.set_updated_at();
create trigger knowledge_profiles_immutable before update on app.knowledge_profiles for each row execute function private.forbid_tenant_column_change('workspace_id');

-- ---------- items ----------
-- The search document: the title weighs most (A), then the tags (B), then the text (C), in English. It is a
-- function because a generated column needs an immutable expression and array_to_string is only marked
-- stable (it is immutable over text[]).
create or replace function private.knowledge_search_vector(p_title text, p_tags text[], p_body text)
returns tsvector language sql immutable parallel safe set search_path = '' as $$
  select setweight(to_tsvector('english'::regconfig, coalesce(p_title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(p_tags, ' '), '')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(p_body, '')), 'C')
$$;
revoke all on function private.knowledge_search_vector(text, text[], text) from public;
grant execute on function private.knowledge_search_vector(text, text[], text) to authenticated, service_actor;

create table app.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind app.knowledge_item_kind not null,
  -- An FAQ's question; an article's, fact's or document's title.
  title text not null check (length(btrim(title)) between 1 and 300),
  -- An FAQ's answer; the article, the fact, or the document's text.
  body text not null default '' check (length(body) <= 200000),
  tags text[] not null default '{}'
    check (cardinality(tags) <= 20 and array_position(tags, null) is null and length(array_to_string(tags, '')) <= 800),
  -- Only published items reach the AI.
  status app.knowledge_item_status not null default 'draft',
  source app.knowledge_item_source not null default 'manual',
  -- The page a website-scan item came from.
  source_url text check (source_url is null or (length(source_url) <= 2000 and source_url ~* '^https?://')),
  -- A document's uploaded file.
  file_id uuid references app.files (id) on delete set null,
  -- How often an AI step or the Assistant used it, and when last (the system records it).
  use_count integer not null default 0 check (use_count >= 0),
  last_used_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (private.knowledge_search_vector(title, tags, body)) stored
);
create index knowledge_items_list_idx on app.knowledge_items (workspace_id, status, kind, updated_at desc);
-- websearch_to_tsquery('english', …) against the weighted document.
create index knowledge_items_search_idx on app.knowledge_items using gin (search);
-- Typos: trigram similarity on titles.
create index knowledge_items_title_trgm_idx on app.knowledge_items using gin (title extensions.gin_trgm_ops);
create index knowledge_items_file_id_idx on app.knowledge_items (file_id);
create index knowledge_items_created_by_idx on app.knowledge_items (created_by);
create index knowledge_items_updated_by_idx on app.knowledge_items (updated_by);
create trigger knowledge_items_updated_at before update on app.knowledge_items for each row execute function private.set_updated_at();
create trigger knowledge_items_immutable before update on app.knowledge_items for each row execute function private.forbid_tenant_column_change('workspace_id', 'source', 'created_by');

-- ---------- the website, and each scan of it ----------
create table app.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  -- One website per business for now.
  workspace_id uuid not null unique references app.workspaces (id) on delete cascade,
  url text not null check (length(url) <= 2000 and url ~* '^https://[^/[:space:]]+'),
  -- Crawl settings (paths to include or skip, a lower page cap). The worker's hard limits apply whatever is set.
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 16384),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_sources_created_by_idx on app.knowledge_sources (created_by);
create trigger knowledge_sources_updated_at before update on app.knowledge_sources for each row execute function private.set_updated_at();
create trigger knowledge_sources_immutable before update on app.knowledge_sources for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

create table app.knowledge_scans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  source_id uuid not null references app.knowledge_sources (id) on delete cascade,
  status app.knowledge_scan_status not null default 'queued',
  -- Each page read: {url, title, hash, bytes, status}. A rescan compares hashes and proposes only changes.
  pages jsonb not null default '[]'::jsonb check (jsonb_typeof(pages) = 'array' and pg_column_size(pages) <= 262144),
  suggestion_count integer not null default 0 check (suggestion_count >= 0),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array' and pg_column_size(errors) <= 65536),
  started_by uuid references app.users (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One scan at a time per website: a second "Scan" while one is queued or running conflicts.
create unique index knowledge_scans_one_live on app.knowledge_scans (source_id) where status in ('queued', 'running');
create index knowledge_scans_source_idx on app.knowledge_scans (source_id, created_at desc);
create index knowledge_scans_workspace_id_idx on app.knowledge_scans (workspace_id);
create index knowledge_scans_started_by_idx on app.knowledge_scans (started_by);
create trigger knowledge_scans_updated_at before update on app.knowledge_scans for each row execute function private.set_updated_at();
create trigger knowledge_scans_immutable before update on app.knowledge_scans for each row execute function private.forbid_tenant_column_change('workspace_id', 'source_id');

-- ---------- suggestions: nothing enters the knowledge base until a person accepts it ----------
create table app.knowledge_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind app.knowledge_item_kind not null,
  -- The item as proposed: {title, body, tags}. Text from websites and customers is data, never instructions.
  proposed jsonb not null check (jsonb_typeof(proposed) = 'object' and pg_column_size(proposed) <= 262144),
  reason app.knowledge_suggestion_reason not null,
  status app.knowledge_suggestion_status not null default 'pending',
  -- The scan it came from (the page is in `source`).
  scan_id uuid references app.knowledge_scans (id) on delete set null,
  -- Where it came from: {url} for a scan, {runId, stepKey, question} for a gap, {packId, version} for a pack.
  source jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object' and pg_column_size(source) <= 16384),
  -- The item a rescan proposes to change, or the item an accepted suggestion became.
  item_id uuid references app.knowledge_items (id) on delete set null,
  -- Gaps group by a normalized question: a repeat raises similar_count on the pending suggestion
  -- (INSERT … ON CONFLICT) instead of adding another, so the owner writes the answer once.
  group_key text check (group_key is null or length(group_key) between 1 and 300),
  similar_count integer not null default 1 check (similar_count >= 1),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'pending') = (decided_at is null))
);
create unique index knowledge_suggestions_group_unique on app.knowledge_suggestions (workspace_id, group_key)
  where status = 'pending' and group_key is not null;
create index knowledge_suggestions_pending_idx on app.knowledge_suggestions (workspace_id, created_at desc) where status = 'pending';
create index knowledge_suggestions_workspace_id_idx on app.knowledge_suggestions (workspace_id);
create index knowledge_suggestions_scan_id_idx on app.knowledge_suggestions (scan_id);
create index knowledge_suggestions_item_id_idx on app.knowledge_suggestions (item_id);
create index knowledge_suggestions_decided_by_idx on app.knowledge_suggestions (decided_by);
create trigger knowledge_suggestions_updated_at before update on app.knowledge_suggestions for each row execute function private.set_updated_at();
create trigger knowledge_suggestions_immutable before update on app.knowledge_suggestions for each row execute function private.forbid_tenant_column_change('workspace_id', 'reason');

-- ---------- agency starter packs (organization level) ----------
-- Pushed to client businesses as suggestions (reason 'pack'), the way workflow templates are pushed.
create table app.knowledge_packs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  -- [{kind, title, body, tags}]
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and pg_column_size(items) <= 1048576),
  -- Raised on every change; a suggestion names the version it came from.
  version integer not null default 1 check (version >= 1),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_packs_org_idx on app.knowledge_packs (organization_id, lower(name));
create index knowledge_packs_created_by_idx on app.knowledge_packs (created_by);
create trigger knowledge_packs_updated_at before update on app.knowledge_packs for each row execute function private.set_updated_at();
create trigger knowledge_packs_immutable before update on app.knowledge_packs for each row execute function private.forbid_tenant_column_change('organization_id', 'created_by');

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_knowledge_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_table_name = 'knowledge_items' then
    v_ok := new.file_id is null or exists (select 1 from app.files f where f.id = new.file_id and f.workspace_id = new.workspace_id);
  elsif tg_table_name = 'knowledge_scans' then
    v_ok := exists (select 1 from app.knowledge_sources s where s.id = new.source_id and s.workspace_id = new.workspace_id);
  elsif tg_table_name = 'knowledge_suggestions' then
    v_ok := (new.scan_id is null or exists (
        select 1 from app.knowledge_scans s where s.id = new.scan_id and s.workspace_id = new.workspace_id))
      and (new.item_id is null or exists (
        select 1 from app.knowledge_items i where i.id = new.item_id and i.workspace_id = new.workspace_id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger knowledge_items_check_refs before insert or update of file_id on app.knowledge_items
  for each row execute function private.check_knowledge_refs();
create trigger knowledge_scans_check_refs before insert on app.knowledge_scans for each row execute function private.check_knowledge_refs();
create trigger knowledge_suggestions_check_refs before insert or update of scan_id, item_id on app.knowledge_suggestions
  for each row execute function private.check_knowledge_refs();

-- ---------- permissions ----------
insert into app.role_permissions (role, permission) values
  ('owner', 'knowledge.manage'), ('admin', 'knowledge.manage');

-- ---------- RLS: everyone reads; knowledge.manage edits, scans and decides; the system proposes and counts use ----------
alter table app.knowledge_profiles enable row level security;
alter table app.knowledge_items enable row level security;
alter table app.knowledge_sources enable row level security;
alter table app.knowledge_scans enable row level security;
alter table app.knowledge_suggestions enable row level security;
alter table app.knowledge_packs enable row level security;

-- Changes by people say who made them (updated_by), for "last changed by".
create policy knowledge_profiles_select on app.knowledge_profiles for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy knowledge_profiles_insert on app.knowledge_profiles for insert to authenticated
  with check (private.has_permission(workspace_id, 'knowledge.manage') and updated_by = (select auth.uid()));
create policy knowledge_profiles_update on app.knowledge_profiles for update to authenticated
  using (private.has_permission(workspace_id, 'knowledge.manage'))
  with check (private.has_permission(workspace_id, 'knowledge.manage') and updated_by = (select auth.uid()));
create policy knowledge_profiles_service_all on app.knowledge_profiles for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Items are archived, never deleted: run logs keep the ids of the items an AI step used.
create policy knowledge_items_select on app.knowledge_items for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy knowledge_items_insert on app.knowledge_items for insert to authenticated
  with check (private.has_permission(workspace_id, 'knowledge.manage') and created_by = (select auth.uid())
    and updated_by = (select auth.uid()) and use_count = 0 and last_used_at is null);
create policy knowledge_items_update on app.knowledge_items for update to authenticated
  using (private.has_permission(workspace_id, 'knowledge.manage'))
  with check (private.has_permission(workspace_id, 'knowledge.manage') and updated_by = (select auth.uid()));
create policy knowledge_items_service_all on app.knowledge_items for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy knowledge_sources_select on app.knowledge_sources for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy knowledge_sources_insert on app.knowledge_sources for insert to authenticated
  with check (private.has_permission(workspace_id, 'knowledge.manage') and created_by = (select auth.uid()));
create policy knowledge_sources_update on app.knowledge_sources for update to authenticated
  using (private.has_permission(workspace_id, 'knowledge.manage'))
  with check (private.has_permission(workspace_id, 'knowledge.manage'));
create policy knowledge_sources_service_all on app.knowledge_sources for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- People queue a scan; its progress and results are the worker's.
create policy knowledge_scans_select on app.knowledge_scans for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy knowledge_scans_insert on app.knowledge_scans for insert to authenticated
  with check (private.has_permission(workspace_id, 'knowledge.manage') and started_by = (select auth.uid())
    and status = 'queued' and pages = '[]'::jsonb and suggestion_count = 0 and errors = '[]'::jsonb
    and started_at is null and finished_at is null);
create policy knowledge_scans_service_all on app.knowledge_scans for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Only the system proposes (scans, gaps, packs). A person decides a pending one, once.
create policy knowledge_suggestions_select on app.knowledge_suggestions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy knowledge_suggestions_update on app.knowledge_suggestions for update to authenticated
  using (status = 'pending' and private.has_permission(workspace_id, 'knowledge.manage'))
  with check (status in ('accepted', 'rejected') and decided_by = (select auth.uid())
    and private.has_permission(workspace_id, 'knowledge.manage'));
create policy knowledge_suggestions_service_all on app.knowledge_suggestions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Packs are the agency's, like workflow templates.
create policy knowledge_packs_select on app.knowledge_packs for select to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'));
create policy knowledge_packs_insert on app.knowledge_packs for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.templates.manage') and created_by = (select auth.uid()));
create policy knowledge_packs_update on app.knowledge_packs for update to authenticated
  using (private.has_org_permission(organization_id, 'org.templates.manage'))
  with check (private.has_org_permission(organization_id, 'org.templates.manage'));
-- A push job (scoped to a business and its organization) reads the pack it turns into suggestions.
create policy knowledge_packs_service_all on app.knowledge_packs for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

-- ---------- grants ----------
grant select, insert on app.knowledge_profiles, app.knowledge_items, app.knowledge_sources, app.knowledge_scans
  to authenticated;
grant update (profile, allow_prices, updated_by) on app.knowledge_profiles to authenticated;
-- use_count and last_used_at are the system's; source and file_id are fixed when an item is made.
grant update (kind, title, body, tags, status, source_url, updated_by) on app.knowledge_items to authenticated;
grant update (url, settings) on app.knowledge_sources to authenticated;
grant select on app.knowledge_suggestions to authenticated;
grant update (status, item_id, decided_by, decided_at) on app.knowledge_suggestions to authenticated;
grant select, insert, update on app.knowledge_packs to authenticated;

grant select, insert, update on app.knowledge_profiles, app.knowledge_items, app.knowledge_sources,
  app.knowledge_scans to service_actor;
grant select, insert, update, delete on app.knowledge_suggestions to service_actor;
grant select on app.knowledge_packs to service_actor;
revoke all on app.knowledge_profiles, app.knowledge_items, app.knowledge_sources, app.knowledge_scans,
  app.knowledge_suggestions, app.knowledge_packs from anon;

-- ---------- function privileges ----------
revoke all on function private.check_knowledge_refs() from public;
grant execute on function private.check_knowledge_refs() to authenticated, service_actor;
