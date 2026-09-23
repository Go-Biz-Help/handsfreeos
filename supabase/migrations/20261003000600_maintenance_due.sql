-- =============================================================================
-- 0095 · Maintenance due.
--
--        Settings → Automations' "Maintenance due": when a customer's
--        recurring service comes round again (the AC tune-up every six
--        months), they get a text in the business's words with a link to
--        book it, two weeks before it's due; a second a week later; then a
--        card on Home so somebody calls them.
--
--        How often comes from three places, the most particular first:
--        - one customer's own schedule (`app.service_schedules`: every N
--          months, or never);
--        - the maintenance plan they're on, which now names the service it
--          covers and how often (`plans.service_id`,
--          `plans.visit_every_months`);
--        - the service itself (`services.repeat_months`).
--        A service with none of these never reminds anybody.
--
--        `app.maintenance_reminders` is the worker's record of each one, a
--        row per customer, service and due day: how many texts went, and
--        whether they booked, so nobody is asked twice for the same visit.
-- =============================================================================

-- ---------- how often ----------
alter table app.services
  add column repeat_months smallint check (repeat_months between 1 and 60);
comment on column app.services.repeat_months is
  'Maintenance: a customer who had this service is due again this many months later. Null: it doesn''t repeat.';

alter table app.plans
  add column service_id uuid references app.services (id) on delete set null,
  add column visit_every_months smallint check (visit_every_months between 1 and 60),
  add constraint plans_visit_schedule check ((service_id is null) = (visit_every_months is null));
create index plans_service_idx on app.plans (service_id) where service_id is not null;
comment on column app.plans.service_id is
  'Maintenance: the service this plan covers; its members are reminded every visit_every_months.';

-- ---------- one customer's own schedule ----------
create table app.service_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  service_id uuid not null references app.services (id) on delete cascade,
  -- Null: never remind this customer about this service.
  every_months smallint check (every_months between 1 and 60),
  updated_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index service_schedules_person_service on app.service_schedules (person_id, service_id);
create index service_schedules_workspace_idx on app.service_schedules (workspace_id);
create index service_schedules_service_idx on app.service_schedules (service_id);
create index service_schedules_updated_by_idx on app.service_schedules (updated_by);
create trigger service_schedules_updated_at before update on app.service_schedules
  for each row execute function private.set_updated_at();
create trigger service_schedules_immutable before update on app.service_schedules
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'person_id', 'service_id');

-- ---------- what the worker sent ----------
create table app.maintenance_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  service_id uuid not null references app.services (id) on delete cascade,
  -- The day the visit is due: the last one's day plus the schedule.
  due_on date not null,
  last_visit_id uuid references app.appointments (id) on delete set null,
  -- The plan they're on, when that's where the schedule came from.
  subscription_id uuid references app.subscriptions (id) on delete set null,
  sent_count smallint not null default 0 check (sent_count between 0 and 2),
  first_sent_at timestamptz,
  second_sent_at timestamptz,
  -- reminding: texts going out. booked: they booked it. card: two texts and nothing, so a person is asked.
  -- stopped: nothing more (they opted out, the schedule went, it can't reach them).
  status text not null default 'reminding' check (status in ('reminding', 'booked', 'card', 'stopped')),
  booked_appointment_id uuid references app.appointments (id) on delete set null,
  card_at timestamptz,
  reason text check (reason is null or length(reason) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'card' or card_at is not null)
);
create unique index maintenance_reminders_visit on app.maintenance_reminders (person_id, service_id, due_on);
create index maintenance_reminders_open on app.maintenance_reminders (workspace_id, status)
  where status in ('reminding', 'card');
create index maintenance_reminders_service_idx on app.maintenance_reminders (service_id);
create index maintenance_reminders_last_visit_idx on app.maintenance_reminders (last_visit_id);
create index maintenance_reminders_booked_idx on app.maintenance_reminders (booked_appointment_id);
create index maintenance_reminders_subscription_idx on app.maintenance_reminders (subscription_id);
create trigger maintenance_reminders_updated_at before update on app.maintenance_reminders
  for each row execute function private.set_updated_at();
create trigger maintenance_reminders_immutable before update on app.maintenance_reminders
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'person_id', 'service_id', 'due_on');

-- Both belong to one business, and so does everything they point at.
create or replace function private.check_maintenance_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id)
     or not exists (select 1 from app.services s where s.id = new.service_id
                      and s.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger service_schedules_check_refs before insert on app.service_schedules
  for each row execute function private.check_maintenance_refs();
create trigger maintenance_reminders_check_refs before insert on app.maintenance_reminders
  for each row execute function private.check_maintenance_refs();

-- A plan's service is one of the business's own.
create or replace function private.check_plan_service()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.service_id is not null and not exists (select 1 from app.services s
       where s.id = new.service_id and s.workspace_id = new.workspace_id) then
    raise exception 'That service belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger plans_check_service before insert or update of service_id on app.plans
  for each row execute function private.check_plan_service();

-- ---------- RLS ----------
alter table app.service_schedules enable row level security;
alter table app.maintenance_reminders enable row level security;

create policy service_schedules_select on app.service_schedules for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy service_schedules_insert on app.service_schedules for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write'));
create policy service_schedules_update on app.service_schedules for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy service_schedules_delete on app.service_schedules for delete to authenticated
  using (private.has_permission(workspace_id, 'records.write'));
create policy service_schedules_service_all on app.service_schedules for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy maintenance_reminders_select on app.maintenance_reminders for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy maintenance_reminders_service_all on app.maintenance_reminders for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update, delete on app.service_schedules to authenticated;
grant select on app.maintenance_reminders to authenticated;
grant select, insert, update, delete on app.service_schedules, app.maintenance_reminders to service_actor;
revoke all on app.service_schedules, app.maintenance_reminders from anon;

-- ---------- the card ----------
alter table app.attention_items
  drop constraint attention_items_kind_check,
  add constraint attention_items_kind_check check (kind in (
    'hot_lead',
    'unanswered_lead',
    'stale_opportunity',
    'missing_next_action',
    'unconfirmed_appointment',
    'ai_approval',
    'customer_waiting',
    'overdue_task',
    'estimate_waiting',
    'invoice_overdue',
    'wallet_low',
    'wallet_empty',
    'wallet_card_declined',
    'job_not_thanked',
    'referral_mentioned',
    'maintenance_due'
  ));
