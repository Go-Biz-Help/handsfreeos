-- =============================================================================
-- Add-on alerts on Home, the phone and email (Real Estate, step 5).
--
--        An add-on had no way to tell anyone anything: Home's cards were a
--        closed list of core's own kinds, and so were the phone's push
--        switches. Chris decided (2026-09-30) that a late or at-risk duty
--        reaches people by email, phone push and a Home card, and the audit
--        planned "Action Center sources" with the first add-on. This is
--        core's one door for every add-on.
--
--        **An alert.** An add-on's worker raises one in app.addon_alerts:
--        its own key for it, what it's about (a private record seals it,
--        step 4), how serious (info, attention, at_risk, critical), the words,
--        where it opens (a page of the add-on's), the add-on permission it
--        takes to see it, and optionally exactly who it's for. It is cleared
--        when the add-on says so, or when the add-on is turned off.
--
--        **Home.** One new card kind, `addon_alert`, drawn from the alert and
--        named after the add-on. A restrictive policy shows it only to people
--        who hold the alert's permission (and are among its audience, when it
--        names one, and see its record, when that's private) while the add-on
--        runs. An alert that asks for it is acknowledged from the card.
--
--        **The phone and email.** One push switch, `addons`, and one email
--        switch, `addonEmail` ("An add-on needs you"), each on unless turned
--        off. The phone keeps no add-on cards: its streams leave the kind out,
--        and a push opens the add-on's page on the web.
--
--        **Turning it off.** private.addon_cancel_work clears the add-on's
--        alerts and resolves their cards, private.addon_verify says so
--        (`no_alerts_showing`), and a purge deletes them.
-- =============================================================================

create table app.addon_alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  addon_generation integer not null default 1,
  -- The add-on's own name for it ("duty:<id>:overdue"), so raising it again updates the same alert.
  key text not null check (length(key) between 1 and 200),
  custom_record_id uuid references app.custom_records (id) on delete set null,
  person_id uuid references app.people (id) on delete set null,
  severity text not null check (severity in ('info', 'attention', 'at_risk', 'critical')),
  title text not null check (length(btrim(title)) between 1 and 200),
  detail text check (detail is null or length(detail) <= 1000),
  -- A page of the add-on's, under /app/w/<business>/a/<addon>/.
  href text not null check (href ~ '^/a/[a-z]{2,16}(/.*)?$' and length(href) <= 500),
  permission text not null,
  -- Exactly who it's for; empty is everyone holding the permission.
  audience_user_ids uuid[] not null default '{}' check (cardinality(audience_user_ids) <= 50),
  assignee_user_id uuid references app.users (id) on delete set null,
  due_at timestamptz,
  needs_ack boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by uuid references app.users (id) on delete set null,
  -- What it said last time it was raised: a change is news again.
  fingerprint text not null default '',
  -- What people were last told by push and email, and when: a retried notice never tells them twice.
  notified_fingerprint text,
  notified_at timestamptz,
  raised_at timestamptz not null default now(),
  cleared_at timestamptz,
  -- Why it went, in the add-on's word (done, waived, addon_off): its Home card closes with it.
  clear_reason text check (clear_reason is null or clear_reason ~ '^[a-z][a-z_]{0,39}$'),
  check ((cleared_at is null) = (clear_reason is null)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, addon_id, key),
  check (permission like addon_id || '.%')
);
create index addon_alerts_open_idx on app.addon_alerts (workspace_id, addon_id) where cleared_at is null;
create index addon_alerts_record_idx on app.addon_alerts (custom_record_id) where custom_record_id is not null;
create index addon_alerts_person_idx on app.addon_alerts (person_id) where person_id is not null;
create index addon_alerts_assignee_idx on app.addon_alerts (assignee_user_id) where assignee_user_id is not null;
create index addon_alerts_acknowledged_by_idx on app.addon_alerts (acknowledged_by)
  where acknowledged_by is not null;
create trigger addon_alerts_updated_at before update on app.addon_alerts
  for each row execute function private.set_updated_at();
create trigger addon_alerts_immutable before update on app.addon_alerts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'addon_id', 'key');

comment on table app.addon_alerts is
  'What an add-on needs someone to see: a Home card (kind addon_alert), a push and an email (Real Estate step 5). Only the worker writes it.';

alter table app.addon_alerts enable row level security;
-- The worker alone writes alerts, and only while the add-on may write here. People see them as Home cards (below).
create policy addon_alerts_service_all on app.addon_alerts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace()
              and (cleared_at is not null or private.addon_writable(workspace_id, addon_id)));
grant select, insert, update, delete on app.addon_alerts to service_actor;
revoke all on app.addon_alerts from anon, authenticated;

-- ---------- Home ----------
alter table app.attention_items drop constraint attention_items_kind_check;
alter table app.attention_items add constraint attention_items_kind_check check (kind in (
  'hot_lead', 'unanswered_lead', 'stale_opportunity', 'missing_next_action', 'unconfirmed_appointment',
  'ai_approval', 'customer_waiting', 'overdue_task', 'estimate_waiting', 'invoice_overdue',
  'wallet_low', 'wallet_empty', 'wallet_card_declined',
  'job_not_thanked', 'referral_mentioned', 'maintenance_due',
  'pipeline_mismatch', 'quiet_after_price', 'job_unconfirmed', 'job_never_completed', 'job_no_address',
  'client_quiet', 'promise_due', 'revenue_moved',
  'channel_quiet', 'connection_error', 'connection_silent', 'ai_unreviewed', 'ai_corrections', 'website_changed',
  'faq_suggestions', 'offer_lapsing', 'texting_rejected',
  'addon_alert'));

-- Whether the caller sees an add-on's alert: its add-on runs, they hold its permission, and it's for them.
create or replace function private.addon_alert_visible(p_alert uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.addon_alerts a
    where a.id = p_alert
      and a.workspace_id in (select private.accessible_workspace_ids())
      and private.addon_in_use(a.workspace_id, a.addon_id, false)
      and private.has_permission(a.workspace_id, a.permission)
      and (cardinality(a.audience_user_ids) = 0 or (select auth.uid()) = any (a.audience_user_ids))
      -- About a private record (step 4): only for the people who see it.
      and (a.custom_record_id is null or private.custom_record_visible(a.custom_record_id)))
$$;
grant execute on function private.addon_alert_visible(uuid) to authenticated, service_actor;

-- People read the alerts they see (Home's card shows where one opens); only the worker writes them.
grant select on app.addon_alerts to authenticated;
create policy addon_alerts_select on app.addon_alerts for select to authenticated
  using (private.addon_alert_visible(id));

-- A card about an alert is about the alert's record too, so a private record seals it (step 4's trigger).
create or replace function private.keep_attention_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.subject_type = 'task' then
    select t.custom_record_id into new.custom_record_id from app.tasks t where t.id = new.subject_id;
  elsif new.subject_type = 'addon_alert' then
    select a.custom_record_id into new.custom_record_id from app.addon_alerts a where a.id = new.subject_id;
  end if;
  new.sealed := new.custom_record_id is not null and private.record_is_private(new.custom_record_id);
  return new;
end $$;

create policy attention_items_addon on app.attention_items as restrictive for all to authenticated
  using (kind <> 'addon_alert' or private.addon_alert_visible(subject_id))
  with check (kind <> 'addon_alert' or private.addon_alert_visible(subject_id));

-- Acknowledging an alert that asks for it ("I've seen this"), from its Home card.
create or replace function private.acknowledge_addon_alert(p_ws uuid, p_alert uuid)
returns table (acknowledged_at timestamptz, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz;
begin
  if not private.addon_alert_visible(p_alert) then
    raise exception 'That alert isn''t there, or isn''t yours' using errcode = '42501',
      detail = 'addon_alert_not_yours';
  end if;
  select a.acknowledged_at into v_at from app.addon_alerts a
  where a.id = p_alert and a.workspace_id = p_ws and a.needs_ack and a.cleared_at is null
  for update;
  if not found then
    raise exception 'That alert doesn''t ask to be acknowledged' using errcode = '23514',
      detail = 'addon_alert_no_ack';
  end if;
  if v_at is not null then
    return query select v_at, false;
    return;
  end if;
  update app.addon_alerts a set acknowledged_at = now(), acknowledged_by = auth.uid()
  where a.id = p_alert
  returning a.acknowledged_at into v_at;
  return query select v_at, true;
end $$;
revoke execute on function private.acknowledge_addon_alert(uuid, uuid) from public;
grant execute on function private.acknowledge_addon_alert(uuid, uuid) to authenticated;

-- ---------- the push switch ----------
-- `addons` is on by default: an add-on's alert is something a person asked the add-on to watch for.
create or replace function private.push_on(p_settings jsonb, p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key not in ('customerWaiting', 'missedCall', 'urgent', 'approval', 'booking', 'assigned',
                                    'payment', 'wallet', 'jobs', 'connections', 'addons') then
    raise exception 'Unknown push switch: %', p_key using errcode = '22023', detail = 'push_switch_unknown';
  end if;
  if jsonb_typeof(p_settings -> 'push' -> p_key) = 'boolean' then
    return (p_settings -> 'push' ->> p_key)::boolean;
  end if;
  return p_key <> 'payment';
end $$;

comment on column app.users.settings is
  'Per-person choices, each top-level key saved whole: theme; notifications, the email switches (unansweredEmail, attentionDigest, aiHandoff, bookingEmail, paymentEmail, agencyDigest, eveningSummary, addonEmail), each on unless false; push, the phone''s switches (customerWaiting, missedCall, urgent, approval, booking, assigned, payment, wallet, jobs, connections, addons), each on unless false except payment: private.push_on.';

-- ---------- turning an add-on off, checking, and deleting its data ----------
create or replace function private.addon_cancel_work(p_ws uuid, p_addon text)
returns table (jobs integer, deliveries integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_jobs integer;
  v_deliveries integer;
begin
  perform private.assert_worker_scope(p_ws);
  update app.scheduled_jobs j set status = 'cancelled', finished_at = now(), locked_at = null, locked_by = null,
    last_error = 'addon_inactive'
  where j.workspace_id = p_ws and j.addon_id = p_addon and j.status = 'pending';
  get diagnostics v_jobs = row_count;
  update app.webhook_deliveries d set status = 'ignored', processed_at = now(), locked_at = null, locked_by = null,
    last_error = 'addon_inactive'
  where d.workspace_id = p_ws and d.addon_id = p_addon and d.status = 'pending';
  get diagnostics v_deliveries = row_count;
  -- Its alerts go, and their Home cards with them: nothing it raised waits for it to come back.
  update app.attention_items i set state = 'resolved', resolved_at = now(), resolution = 'addon_off'
  where i.workspace_id = p_ws and i.kind = 'addon_alert' and i.state <> 'resolved'
    and i.subject_id in (select a.id from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon);
  update app.addon_alerts a set cleared_at = now(), clear_reason = 'addon_off'
  where a.workspace_id = p_ws and a.addon_id = p_addon and a.cleared_at is null;
  return query select v_jobs, v_deliveries;
end $$;

create or replace function private.addon_verify(p_ws uuid, p_addon text)
returns table (check_name text, ok boolean, found bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_state text;
  v_n bigint;
begin
  perform private.assert_worker_scope(p_ws);
  select i.state into v_state from app.addon_installations i where i.workspace_id = p_ws and i.addon_id = p_addon;
  if v_state is null then
    return;
  end if;
  if v_state = 'enabled' then
    select count(*) into v_n from app.custom_record_types t
    where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is not null;
    return query select 'record_kinds_shown'::text, v_n = 0, v_n;
    return;
  end if;
  -- Off, arriving, leaving or gone: it runs nowhere here.
  select count(*) into v_n from app.workspace_access wa
  where wa.workspace_id = p_ws
    and wa.permissions && array(select private.addon_permissions(p_addon));
  return query select 'no_permissions_held'::text, v_n = 0, v_n;
  select count(*) into v_n from app.scheduled_jobs j
  where j.workspace_id = p_ws and j.addon_id = p_addon and j.status = 'pending';
  return query select 'no_jobs_pending'::text, v_n = 0, v_n;
  select count(*) into v_n from app.webhook_deliveries d
  where d.workspace_id = p_ws and d.addon_id = p_addon and d.status = 'pending';
  return query select 'no_deliveries_pending'::text, v_n = 0, v_n;
  select count(*) into v_n from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon and t.archived_at is null;
  return query select 'record_kinds_hidden'::text, v_n = 0, v_n;
  select count(*) into v_n from app.relationship_types r
  where r.workspace_id = p_ws and r.addon_id = p_addon and r.archived_at is null;
  return query select 'relationship_types_hidden'::text, v_n = 0, v_n;
  select count(*) into v_n from app.addon_alerts a
  where a.workspace_id = p_ws and a.addon_id = p_addon and a.cleared_at is null;
  select v_n + count(*) into v_n from app.attention_items i
  where i.workspace_id = p_ws and i.kind = 'addon_alert' and i.state <> 'resolved'
    and i.subject_id in (select a.id from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon);
  return query select 'no_alerts_showing'::text, v_n = 0, v_n;
  if v_state in ('uninstalled', 'purging', 'purged') then
    select count(*) into v_n from app.addon_resources r
    where r.workspace_id = p_ws and r.addon_id = p_addon and r.status <> 'released';
    return query select 'no_resources_held'::text, v_n = 0, v_n;
  end if;
  if v_state = 'purged' then
    v_n := private.addon_owned_rows(p_ws, p_addon);
    return query select 'no_rows_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    where r.workspace_id = p_ws and t.addon_id = p_addon and r.purged_at is null;
    return query select 'records_tombstoned'::text, v_n = 0, v_n;
    select count(*) into v_n from app.relationships r
    join app.relationship_types t on t.id = r.type_id
    where r.workspace_id = p_ws and t.addon_id = p_addon;
    return query select 'no_relationships_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon;
    return query select 'no_alerts_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.addon_installations i
    where i.workspace_id = p_ws and i.addon_id = p_addon and (i.settings <> '{}'::jsonb or i.flags <> '{}'::jsonb);
    select v_n + count(*) into v_n from app.addon_user_settings s where s.workspace_id = p_ws and s.addon_id = p_addon;
    return query select 'no_settings_left'::text, v_n = 0, v_n;
    select count(*) into v_n from (
      select 1 from app.role_permission_overrides o
      where o.workspace_id = p_ws and o.permission in (select private.addon_permissions(p_addon))
      union all
      select 1 from app.member_permission_overrides o
      where o.workspace_id = p_ws and o.permission in (select private.addon_permissions(p_addon))) x;
    return query select 'no_permission_choices_left'::text, v_n = 0, v_n;
    select count(*) into v_n from app.events e
    where e.workspace_id = p_ws and e.addon_id = p_addon and not (e.payload ? '_redacted');
    select v_n + count(*) into v_n from app.audit_logs a
    where a.workspace_id = p_ws and a.addon_id = p_addon and (a.before is not null or a.after is not null);
    return query select 'history_details_removed'::text, v_n = 0, v_n;
  end if;
end $$;

create or replace function private.purge_addon_batch(p_ws uuid, p_addon text, p_limit integer default 5000)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_table regclass;
  v_n integer;
  v_kinds uuid[];
  v_types uuid[];
  v_permissions text[];
begin
  perform private.assert_worker_scope(p_ws);
  perform 1 from app.addon_installations i
  where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'purging'
  for update;
  if not found then
    raise exception 'That add-on''s data isn''t being deleted here' using errcode = '55000', detail = 'addon_not_purging';
  end if;
  insert into private.addon_purges (workspace_id, addon_id) values (p_ws, p_addon) on conflict do nothing;

  -- 1. Its own tables, a batch at a time. Its foreign keys between its own tables cascade (the catalogue test),
  --    so the order doesn't matter.
  for v_table in
    select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'addon_' || p_addon and c.relkind = 'r'
    order by c.relname
  loop
    execute format('delete from %s where ctid in (select ctid from %s where workspace_id = $1 limit $2)',
      v_table, v_table) using p_ws, p_limit;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
      return true;
    end if;
  end loop;

  -- 1b. Its alerts, and their Home cards (Real Estate step 5).
  delete from app.attention_items i
  where i.workspace_id = p_ws and i.kind = 'addon_alert'
    and i.subject_id in (select a.id from app.addon_alerts a where a.workspace_id = p_ws and a.addon_id = p_addon);
  delete from app.addon_alerts a
  where a.id in (select x.id from app.addon_alerts x where x.workspace_id = p_ws and x.addon_id = p_addon
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 2. The relationships it managed, then the types themselves.
  select coalesce(array_agg(t.id), '{}') into v_types from app.relationship_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon;
  delete from app.relationships r
  where r.id in (select x.id from app.relationships x where x.workspace_id = p_ws and x.type_id = any (v_types)
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  delete from app.relationship_types t where t.id = any (v_types);

  -- 3. Its records reduced to their names: what pointed at one still reads, and nothing else about it is kept.
  select coalesce(array_agg(t.id), '{}') into v_kinds from app.custom_record_types t
  where t.workspace_id = p_ws and t.addon_id = p_addon;
  update app.custom_records r set purged_at = now(), archived_at = coalesce(r.archived_at, now()),
    notes = null, custom = '{}'::jsonb, field_times = '{}'::jsonb
  where r.id in (select x.id from app.custom_records x
                 where x.workspace_id = p_ws and x.type_id = any (v_kinds) and x.purged_at is null
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 4. History keeps its lines and loses the add-on's details (the owner's decision, 2026-09-28).
  update app.events e set payload = jsonb_build_object('_addon', e.payload -> '_addon', '_redacted', true)
  where e.id in (select x.id from app.events x
                 where x.workspace_id = p_ws and x.addon_id = p_addon and not (x.payload ? '_redacted')
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;
  update app.audit_logs a set before = null, after = null
  where a.id in (select x.id from app.audit_logs x
                 where x.workspace_id = p_ws and x.addon_id = p_addon and (x.before is not null or x.after is not null)
                 limit p_limit);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
    return true;
  end if;

  -- 5. Its settings, and the business's own choices about its permissions.
  select coalesce(array_agg(p), '{}') into v_permissions from private.addon_permissions(p_addon) p;
  delete from app.role_permission_overrides o where o.workspace_id = p_ws and o.permission = any (v_permissions);
  delete from app.member_permission_overrides o where o.workspace_id = p_ws and o.permission = any (v_permissions);
  delete from app.addon_user_settings s where s.workspace_id = p_ws and s.addon_id = p_addon;
  update app.addon_installations i set settings = '{}'::jsonb, flags = '{}'::jsonb, state = 'purged',
    last_error = null
  where i.workspace_id = p_ws and i.addon_id = p_addon;
  delete from private.addon_purges where workspace_id = p_ws and addon_id = p_addon;
  return false;
end $$;
