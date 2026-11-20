-- =============================================================================
-- The texting registration's checks read a business's pages in its own
-- browser, or from a screenshot, when its website's security won't show
-- them to our server.
--
--        SiteGround showed the worker a robot check instead of every one of
--        Full Spectrum's pages on 20 November (website, privacy policy,
--        terms, contact page), so its checks could say nothing. The owner
--        wants the checks to catch everything a reviewer would, so nobody
--        sends twice (2026-11-20). The ways past, never a way round:
--
--        **app.site_checks** is each "Finish the check on my site": a
--        one-time code (only its sha-256 kept) that opens the business's
--        site in the person's browser, where our own chat or form code reads
--        the site's pages and hands them to the worker. It works for half an
--        hour, for that site only.
--
--        **app.site_pages** is what was read that way, one row per page and
--        source: 'browser' (from a site check, used for half an hour) or
--        'screenshot' (the AI's write-up of a screenshot of a page that still
--        wouldn't open, used for a month). The checks read these before, or
--        instead of, the worker's own read. Pages are trimmed to the parts
--        the checks read (core's trimPageHtml).
--
--        Only the worker writes either; people who manage the business's
--        channels may see them. Neither is in the powersync publication.
--
--        The AI reading a screenshot counts as 'site_screenshot' usage.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'site_screenshot';

create table app.site_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- The site's host without www: pages from anywhere else are refused.
  site text not null check (char_length(site) between 1 and 253),
  start_url text not null check (char_length(start_url) <= 2048),
  -- The pages the registration names, read first.
  urls jsonb not null default '[]'::jsonb
    check (jsonb_typeof(urls) = 'array' and pg_column_size(urls) <= 65536),
  requested_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  pages integer not null default 0 check (pages >= 0 and pages <= 1000),
  finished_at timestamptz
);
create index site_checks_workspace_idx on app.site_checks (workspace_id, created_at desc);
create trigger site_checks_immutable before update on app.site_checks
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.site_checks enable row level security;

create policy site_checks_select on app.site_checks for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy site_checks_service_all on app.site_checks for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.site_checks from public;
grant select on app.site_checks to authenticated;
grant select, insert, update, delete on app.site_checks to service_actor;

create table app.site_pages (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- core's sitePageKey: host without www, path, sorted query.
  key text not null check (char_length(key) between 1 and 2048),
  source text not null check (source in ('browser', 'screenshot')),
  url text not null check (char_length(url) <= 2048),
  final_url text check (char_length(final_url) <= 2048),
  status integer check (status between 0 and 999),
  html text not null check (char_length(html) <= 300000),
  check_id uuid references app.site_checks (id) on delete cascade,
  read_by uuid references app.users (id) on delete set null,
  read_at timestamptz not null default now(),
  primary key (workspace_id, key, source)
);
create index site_pages_check_idx on app.site_pages (check_id) where check_id is not null;
create trigger site_pages_immutable before update on app.site_pages
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.site_pages enable row level security;

create policy site_pages_select on app.site_pages for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy site_pages_service_all on app.site_pages for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.site_pages from public;
grant select on app.site_pages to authenticated;
grant select, insert, update, delete on app.site_pages to service_actor;

-- Which business a site check's code belongs to, for the worker's public routes (the browser on the business's own
-- site knows only the code), like private.chat_widget_lookup. Only a code still working is found.
create or replace function private.site_check_lookup(p_token_hash text)
returns table (check_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, ws.organization_id
  from app.site_checks c
  join app.workspaces ws on ws.id = c.workspace_id
  where p_token_hash ~ '^[0-9a-f]{64}$' and c.token_hash = p_token_hash and c.expires_at > now()
$$;

revoke all on function private.site_check_lookup(text) from public;
grant execute on function private.site_check_lookup(text) to service_actor;
