-- Automations, stage 5: outreach campaigns.
--
-- A campaign is one text to a list of customers, picked by tag or pipeline stage: the owner writes one line of
-- what it's for, the AI writes each person's text from their own history, a person reads and approves them all on
-- one screen, and the worker sends them a few an hour, in open hours only. Texts only, to people who agreed to
-- texts. Replies land in the inbox like any other text.
--
-- `app.campaign_recipients` is one row per person picked: their draft, whether they were left out and why, and
-- what became of their text. The client id is fixed when the row is made, so approving twice sends once.

create table app.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  -- What it's for, in the owner's words: "Fall tune-up special, $89 this month".
  goal text not null check (length(btrim(goal)) between 1 and 500),
  -- Who: {tagIds: [...], stageIds: [...]} (anyone with one of the tags, or an open deal in one of the stages).
  audience jsonb not null default '{}'::jsonb check (jsonb_typeof(audience) = 'object'),
  -- Texts an hour while it sends.
  per_hour integer not null default 20 check (per_hour between 1 and 200),
  status text not null default 'drafting'
    check (status in ('drafting', 'review', 'sending', 'paused', 'done', 'cancelled')),
  created_by uuid references app.users (id) on delete set null,
  approved_by uuid references app.users (id) on delete set null,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- When the next text goes, while it sends (the worker keeps it; the progress screen shows it).
  next_send_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_workspace on app.campaigns (workspace_id, created_at desc);
create index campaigns_created_by_idx on app.campaigns (created_by);
create index campaigns_approved_by_idx on app.campaigns (approved_by);
create trigger campaigns_updated_at before update on app.campaigns
  for each row execute function private.set_updated_at();
create trigger campaigns_immutable before update on app.campaigns
  for each row execute function private.forbid_tenant_column_change('workspace_id');

create table app.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  campaign_id uuid not null references app.campaigns (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  status text not null default 'drafting'
    check (status in ('drafting', 'ready', 'skipped', 'removed', 'approved', 'sent', 'failed')),
  -- Why they were left out: texted_recently, in_conversation, booked_soon, not_opted_in, no_phone, no_draft.
  skip_reason text check (skip_reason is null or length(skip_reason) <= 60),
  draft text check (draft is null or length(draft) <= 480),
  -- A person changed the AI's words.
  edited boolean not null default false,
  client_id text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  message_id uuid references app.messages (id) on delete set null,
  sent_at timestamptz,
  error text check (error is null or length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, person_id)
);
create index campaign_recipients_status on app.campaign_recipients (campaign_id, status);
create index campaign_recipients_workspace_idx on app.campaign_recipients (workspace_id);
create index campaign_recipients_person_idx on app.campaign_recipients (person_id);
create index campaign_recipients_message_idx on app.campaign_recipients (message_id) where message_id is not null;
create trigger campaign_recipients_updated_at before update on app.campaign_recipients
  for each row execute function private.set_updated_at();
create trigger campaign_recipients_immutable before update on app.campaign_recipients
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'campaign_id', 'person_id',
    'client_id');

-- A recipient belongs to one business, like its campaign and its customer.
create or replace function private.check_campaign_recipient_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.campaigns c where c.id = new.campaign_id and c.workspace_id = new.workspace_id)
     or not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger campaign_recipients_check_refs before insert or update on app.campaign_recipients
  for each row execute function private.check_campaign_recipient_refs();

-- ---------- RLS ----------
alter table app.campaigns enable row level security;
alter table app.campaign_recipients enable row level security;

create policy campaigns_select on app.campaigns for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy campaigns_insert on app.campaigns for insert to authenticated
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy campaigns_update on app.campaigns for update to authenticated
  using (private.has_permission(workspace_id, 'workflows.manage'))
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy campaigns_service_all on app.campaigns for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy campaign_recipients_select on app.campaign_recipients for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy campaign_recipients_insert on app.campaign_recipients for insert to authenticated
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy campaign_recipients_update on app.campaign_recipients for update to authenticated
  using (private.has_permission(workspace_id, 'workflows.manage'))
  with check (private.has_permission(workspace_id, 'workflows.manage'));
create policy campaign_recipients_service_all on app.campaign_recipients for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.campaigns to authenticated;
grant update (name, goal, per_hour, status, approved_by, approved_at, started_at, finished_at, updated_at)
  on app.campaigns to authenticated;
grant select, insert, update, delete on app.campaigns to service_actor;
revoke all on app.campaigns from anon;

grant select, insert on app.campaign_recipients to authenticated;
grant update (status, skip_reason, draft, edited, updated_at) on app.campaign_recipients to authenticated;
grant select, insert, update, delete on app.campaign_recipients to service_actor;
revoke all on app.campaign_recipients from anon;
