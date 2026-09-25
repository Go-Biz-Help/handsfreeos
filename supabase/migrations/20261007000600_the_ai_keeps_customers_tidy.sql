-- =============================================================================
-- 0107 · The AI keeps every customer's tags and details up to date.
--
--        Three ways in, one engine (apps/worker/src/contact-ai):
--
--          - **When asked.** The Assistant tags or untags many customers at
--            once and changes any of a customer's details, as the person
--            asking ("via Assistant"), after they press OK.
--          - **On its own.** A customer's new message, call, booking, deal,
--            payment or form brings a look at that customer a few minutes
--            later (Settings → Automations: "Tag customers for you" and
--            "Keep contact details up to date").
--          - **Looking back.** A pass over the whole list, or the customers
--            with one tag, that an owner or admin starts and can stop:
--            `app.contact_ai_sweeps`, one running at a time per business.
--
--        **Everything is written down twice.** Each change the AI makes is a
--        command like any other, so it has its event and its audit row, with
--        the AI's reason in `audit_logs.reason` and channel `contact_ai`.
--        And every look it takes, whether or not it changed anything, is a
--        row of `app.contact_ai_reviews`: what it was asked about, what it
--        said, what was done with it, and what was left alone and why. A
--        review is never changed afterwards.
-- =============================================================================

-- ---------- the passes over the whole list ----------
create table app.contact_ai_sweeps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  requested_by uuid references app.users (id) on delete set null,
  -- What the person asked for in their own words ("anyone who asked about solar is Solar interest").
  instructions text not null default '' check (length(instructions) <= 2000),
  -- The tags it may put on or take off; empty is every tag the business has.
  tag_ids uuid[] not null default '{}',
  -- Only the customers with this tag; null is everybody.
  only_tag_id uuid references app.tags (id) on delete set null,
  -- Also fill in and correct names, emails, numbers and addresses.
  fix_details boolean not null default false,
  status text not null default 'running' check (status in ('running', 'done', 'cancelled', 'failed')),
  -- How many customers it set out to look at, and how far it has got.
  total int not null default 0 check (total >= 0),
  reviewed int not null default 0 check (reviewed >= 0),
  changed int not null default 0 check (changed >= 0),
  tags_added int not null default 0 check (tags_added >= 0),
  tags_removed int not null default 0 check (tags_removed >= 0),
  details_changed int not null default 0 check (details_changed >= 0),
  -- The last customer looked at: it goes through them in id order, so a restart picks up there.
  cursor_id uuid,
  -- Why it is waiting (today's AI limit) or why it stopped, in words a person reads.
  note text check (length(note) <= 500),
  cancelled_by uuid references app.users (id) on delete set null,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index contact_ai_sweeps_one_running on app.contact_ai_sweeps (workspace_id)
  where status = 'running';
create index contact_ai_sweeps_workspace_idx on app.contact_ai_sweeps (workspace_id, created_at desc);
create index contact_ai_sweeps_requested_by_idx on app.contact_ai_sweeps (requested_by);
create index contact_ai_sweeps_cancelled_by_idx on app.contact_ai_sweeps (cancelled_by);
create index contact_ai_sweeps_only_tag_idx on app.contact_ai_sweeps (only_tag_id);
create trigger contact_ai_sweeps_updated_at before update on app.contact_ai_sweeps
  for each row execute function private.set_updated_at();
create trigger contact_ai_sweeps_immutable before update on app.contact_ai_sweeps
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'requested_by');

-- ---------- every look the AI took ----------
create table app.contact_ai_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- activity: something happened with the customer; sweep: a pass over the list.
  trigger text not null check (trigger in ('activity', 'sweep')),
  sweep_id uuid references app.contact_ai_sweeps (id) on delete set null,
  -- The event that brought it on (activity), for tracing it back.
  cause_event_id uuid,
  -- changed: at least one tag or detail changed; unchanged: nothing needed to; skipped: it didn't look
  -- (nothing to go on, switched off); failed: the AI couldn't answer.
  outcome text not null check (outcome in ('changed', 'unchanged', 'skipped', 'failed')),
  -- What the AI said, each change with its reason.
  decision jsonb not null default '{}'::jsonb,
  -- What was done with it: the tags put on and taken off, the details changed, and what was left alone and why.
  applied jsonb not null default '{}'::jsonb,
  note text check (length(note) <= 500),
  model text,
  -- The audit rows of its changes share it.
  correlation_id uuid,
  created_at timestamptz not null default now()
);
create index contact_ai_reviews_person_idx on app.contact_ai_reviews (person_id, created_at desc);
create index contact_ai_reviews_workspace_idx on app.contact_ai_reviews (workspace_id, created_at desc);
create index contact_ai_reviews_sweep_idx on app.contact_ai_reviews (sweep_id) where sweep_id is not null;
-- A log: a review is never changed after it's written (deleting a customer or a business still takes theirs).
create trigger contact_ai_reviews_append_only before update on app.contact_ai_reviews
  for each row execute function private.forbid_change();

-- A review and a pass belong to one business, like the customer and the tag they name.
create or replace function private.check_contact_ai_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'contact_ai_reviews' then
    if not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
       or (new.sweep_id is not null and not exists (select 1 from app.contact_ai_sweeps s
                     where s.id = new.sweep_id and s.workspace_id = new.workspace_id)) then
      raise exception 'That belongs to another business'
        using errcode = '23514', detail = 'cross_workspace';
    end if;
  elsif new.only_tag_id is not null and not exists (select 1 from app.tags t
          where t.id = new.only_tag_id and t.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger contact_ai_sweeps_check_refs before insert or update on app.contact_ai_sweeps
  for each row execute function private.check_contact_ai_refs();
create trigger contact_ai_reviews_check_refs before insert on app.contact_ai_reviews
  for each row execute function private.check_contact_ai_refs();

-- ---------- RLS ----------
alter table app.contact_ai_sweeps enable row level security;
create policy contact_ai_sweeps_select on app.contact_ai_sweeps for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Starting and stopping a pass over the whole list is setting up tags (contact_ai.start_sweep, cancel_sweep).
create policy contact_ai_sweeps_insert on app.contact_ai_sweeps for insert to authenticated
  with check (private.has_permission(workspace_id, 'tags.manage') and requested_by = (select auth.uid()));
create policy contact_ai_sweeps_update on app.contact_ai_sweeps for update to authenticated
  using (private.has_permission(workspace_id, 'tags.manage'))
  with check (private.has_permission(workspace_id, 'tags.manage'));
create policy contact_ai_sweeps_service_all on app.contact_ai_sweeps for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.contact_ai_sweeps to authenticated;
grant insert on app.contact_ai_sweeps to authenticated;
-- Stopping it is all a person may change.
grant update (status, note, cancelled_by, finished_at, updated_at) on app.contact_ai_sweeps to authenticated;
grant select, insert, update, delete on app.contact_ai_sweeps to service_actor;
revoke all on app.contact_ai_sweeps from anon;

alter table app.contact_ai_reviews enable row level security;
create policy contact_ai_reviews_select on app.contact_ai_reviews for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Only the worker writes them.
create policy contact_ai_reviews_service_all on app.contact_ai_reviews for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.contact_ai_reviews to authenticated;
grant select, insert, delete on app.contact_ai_reviews to service_actor;
revoke all on app.contact_ai_reviews from anon;
