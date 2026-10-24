-- =============================================================================
-- Facebook lead ads (funnels): somebody fills in a business's lead ad form on
-- Facebook or Instagram, and they arrive here as a customer and a lead.
--
--        Meta's webhook says only that a lead came, on which Page and form.
--        The worker fetches it with the Page's token (it needs the
--        leads_retrieval permission, and the Page's Leads Access letting
--        HandsFreeOS in), and core's meta_lead.receive files it through Lead
--        intake's own rules: the "Facebook lead ad" row's switch, pipeline and
--        day, and one lead per lead however often Meta says it.
--
--        **The forms we've seen** are kept (app.meta_lead_forms): their name,
--        and which of their own consent boxes is about texts, so a ticked one
--        is recorded as the customer's OK to text. An hourly catch-up asks
--        Meta for each form's newest leads, since a webhook can be lost.
--
--        **Where they came from** is a touch of its own, kind lead_form, with
--        the ad, so the customer's "Where they came from" shows it.
-- =============================================================================

-- ---------- one row a business for each new channel, as for the others ----------
drop index app.intake_sources_channel_unique;
create unique index intake_sources_channel_unique on app.intake_sources (workspace_id, kind)
  where kind in ('text', 'call', 'email', 'messenger', 'instagram', 'facebook_lead_ad', 'indeed');

-- ---------- what each Page lets us read ----------
alter table app.meta_accounts
  -- unknown until a lead is fetched; ok; not_allowed (the sign-in didn't allow leads); blocked (Leads Access).
  add column leads_access text not null default 'unknown'
    check (leads_access in ('unknown', 'ok', 'not_allowed', 'blocked')),
  add column last_lead_at timestamptz,
  add column leads_checked_at timestamptz;

grant select (leads_access, last_lead_at, leads_checked_at) on app.meta_accounts to authenticated;

-- ---------- the lead forms ----------
create table app.meta_lead_forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  account_id uuid not null references app.meta_accounts (id) on delete cascade,
  -- Meta's id for the form.
  form_id text not null check (form_id ~ '^[0-9]{1,40}$'),
  name text not null default '' check (length(name) <= 300),
  -- The keys of the form's own consent boxes whose words are about texts.
  text_consent_keys text[] not null default '{}',
  last_lead_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, form_id)
);

create index meta_lead_forms_workspace_idx on app.meta_lead_forms (workspace_id);

create trigger meta_lead_forms_updated_at before update on app.meta_lead_forms
  for each row execute function private.set_updated_at();
create trigger meta_lead_forms_immutable before update on app.meta_lead_forms
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'account_id', 'form_id');

alter table app.meta_lead_forms enable row level security;

-- Whoever sees the business's Pages sees their lead forms; only the worker writes them.
create policy meta_lead_forms_select on app.meta_lead_forms for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy meta_lead_forms_service_all on app.meta_lead_forms for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.meta_lead_forms from public, anon;
grant select on app.meta_lead_forms to authenticated;
grant select, insert, update, delete on app.meta_lead_forms to service_actor;

-- ---------- a lead form's touch ----------
alter table app.attribution_touches drop constraint attribution_touches_kind_check;
alter table app.attribution_touches add constraint attribution_touches_kind_check
  check (kind in ('started', 'returned', 'lead_form'));

-- The form a lead_form touch came through, so "Where they came from" can name it.
alter table app.attribution_touches
  add column lead_form_id uuid references app.meta_lead_forms (id) on delete set null;
create index attribution_touches_lead_form_idx on app.attribution_touches (lead_form_id)
  where lead_form_id is not null;

-- ---------- where a Page's leads go ----------
-- Meta names only the Page. Its Facebook Page here, or else the Instagram account linked to it: either holds the
-- Page's token, which is what reads the lead.
create or replace function private.meta_lead_route(p_page_id text)
returns table (account_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id
  from app.meta_accounts a join app.workspaces w on w.id = a.workspace_id
  where a.page_id = p_page_id and a.status <> 'disconnected'
  order by (a.platform = 'facebook') desc, a.connected_at
  limit 1
$$;

revoke all on function private.meta_lead_route(text) from public;
grant execute on function private.meta_lead_route(text) to service_actor;
