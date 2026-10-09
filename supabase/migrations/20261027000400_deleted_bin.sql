-- =============================================================================
-- Deleting for good: the Deleted bin.
--
--        Until now a customer, a conversation or a booking could only be
--        archived: put away, and kept for good. Chris asked to delete them
--        for real, and decided how (2026-10-08):
--
--          1. Only owners delete for good (records.delete). An owner can give
--             it to a role or a person in Settings → Permissions.
--          2. What's deleted waits 30 days in a Deleted bin, where it can be
--             brought back. After that it's gone.
--          3. Deleting a customer takes everything only about them: their
--             texts, emails, chats, calls and recordings, notes, tasks,
--             files, leads, bookings and form answers.
--          4. Their invoices, quotes and payments stay, with just their name.
--          5. Several can be deleted at once.
--
--        **In the bin** a row stays where it is and carries its bin item
--        (`bin_item_id`). Row-level security hides marked rows from people,
--        customers and the worker. A phone drops them through the columns its
--        streams already read (sync_window, archived_at, deleted_at), so the
--        sync config doesn't change. A customer in the bin is archived but
--        stays readable, so a bill that names them still shows the name;
--        core's queries leave them out.
--
--        **Into the bin**: private.bin_put, one customer, conversation or
--        booking at a time, after private.bin_preview has shown what goes
--        with it. It refuses what can't go: a plan still billing, a signed
--        file, history on a record that's being kept (a hold), a message
--        still going out, a call still going on, or a booking still to come
--        (the command cancels those first). Some things don't come back with
--        a restore, and the delete box says so: workflows stop, Home's cards
--        and the AI's waiting drafts go, a place on a waitlist is given up,
--        and the customer's portal signs out.
--
--        **Back out**: private.restore_bin_item clears the marks and
--        unarchives what the bin archived. A conversation whose line has had
--        a new thread since joins that thread.
--
--        **Emptying** is the worker's, after 30 days or when an owner deletes
--        now: private.purge_bin_batch deletes a batch at a time. Events and
--        audit lines keep the line and drop the details (the owner's rule,
--        2026-09-28), except the one that says who deleted it and when. For a
--        customer, everything else that names them goes too, and one with
--        bills is left as a name-only record the bills move to.
--
--        One index changes shape (one thread per line, now among the threads
--        not in the bin), so this migration drops and makes an index: push it
--        with the Supabase CLI ("Push with the Supabase CLI" in
--        docs/operations.md).
-- =============================================================================

-- ---------- the permission ----------
insert into app.role_permissions (role, permission) values ('owner', 'records.delete');
insert into app.customizable_permissions (permission, requires)
values ('records.delete', '{records.read,records.write,records.archive}');

-- ---------- the bin ----------
create table app.bin_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null check (kind in ('person', 'conversation', 'appointment')),
  record_id uuid not null,
  -- What it was called: for the bin's list, and for the line kept once it's gone.
  name text not null check (length(name) between 1 and 300),
  -- How much went with it ({"messages": 40, "bookings": 2, ...}), and what the bin's list shows beside it.
  contents jsonb not null default '{}'::jsonb check (jsonb_typeof(contents) = 'object'),
  -- What the bin changed that bringing it back undoes: the ids it archived, and the files it marked deleted.
  undo jsonb not null default '{}'::jsonb check (jsonb_typeof(undo) = 'object'),
  deleted_by uuid references app.users (id) on delete set null,
  deleted_at timestamptz not null default now(),
  purge_after timestamptz not null default now() + interval '30 days',
  -- When emptying started (30 days on, or an owner's "Delete now"). It can't be brought back after.
  purging_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, kind, record_id)
);
create index bin_items_list_idx on app.bin_items (workspace_id, deleted_at desc, id desc);
create index bin_items_due_idx on app.bin_items (purge_after) where purging_since is null;
create trigger bin_items_updated_at before update on app.bin_items
  for each row execute function private.set_updated_at();
create trigger bin_items_immutable before update on app.bin_items
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'kind', 'record_id', 'deleted_by',
    'deleted_at');

comment on table app.bin_items is
  'The Deleted bin (2026-10-08): a customer, conversation or booking deleted, and everything that went with it, kept 30 days and then emptied by the worker.';

alter table app.bin_items enable row level security;
-- Who may delete for good sees the bin. Nobody writes it but the functions below.
create policy bin_items_select on app.bin_items for select to authenticated
  using (private.has_permission(workspace_id, 'records.delete'));
create policy bin_items_service_all on app.bin_items for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.bin_items to authenticated;
grant select, update, delete on app.bin_items to service_actor;
revoke all on app.bin_items from anon;

-- ---------- the marks ----------
alter table app.people
  add column bin_item_id uuid references app.bin_items (id),
  -- A customer emptied from the bin who had bills: this record keeps only their name, for the bills.
  add column erased_at timestamptz;
alter table app.conversations add column bin_item_id uuid references app.bin_items (id);
alter table app.messages add column bin_item_id uuid references app.bin_items (id);
alter table app.calls add column bin_item_id uuid references app.bin_items (id);
alter table app.activities add column bin_item_id uuid references app.bin_items (id);
alter table app.tasks add column bin_item_id uuid references app.bin_items (id);
alter table app.leads add column bin_item_id uuid references app.bin_items (id);
alter table app.appointments add column bin_item_id uuid references app.bin_items (id);
alter table app.appointment_attendees add column bin_item_id uuid references app.bin_items (id);
alter table app.files add column bin_item_id uuid references app.bin_items (id);
alter table app.relationships add column bin_item_id uuid references app.bin_items (id);
alter table app.form_responses add column bin_item_id uuid references app.bin_items (id);

create index people_bin_idx on app.people (bin_item_id) where bin_item_id is not null;
create index conversations_bin_idx on app.conversations (bin_item_id) where bin_item_id is not null;
create index messages_bin_idx on app.messages (bin_item_id) where bin_item_id is not null;
create index calls_bin_idx on app.calls (bin_item_id) where bin_item_id is not null;
create index activities_bin_idx on app.activities (bin_item_id) where bin_item_id is not null;
create index tasks_bin_idx on app.tasks (bin_item_id) where bin_item_id is not null;
create index leads_bin_idx on app.leads (bin_item_id) where bin_item_id is not null;
create index appointments_bin_idx on app.appointments (bin_item_id) where bin_item_id is not null;
create index appointment_attendees_bin_idx on app.appointment_attendees (bin_item_id) where bin_item_id is not null;
create index files_bin_idx on app.files (bin_item_id) where bin_item_id is not null;
create index relationships_bin_idx on app.relationships (bin_item_id) where bin_item_id is not null;
create index form_responses_bin_idx on app.form_responses (bin_item_id) where bin_item_id is not null;
-- A customer's and a lead's files, whatever state they're in (files_record_idx only has the ready ones).
create index files_customer_idx on app.files (record_id) where record_type in ('person', 'lead');

comment on column app.people.bin_item_id is
  'In the Deleted bin, with everything about them: hidden from lists, archived, and emptied after 30 days.';
comment on column app.people.erased_at is
  'Emptied from the bin with bills left: a record with only the name, which the bills moved to.';

-- One thread per customer per line (0089), among the threads not in the bin: someone deleted who writes again
-- starts a new one.
drop index app.conversations_one_per_line;
create unique index conversations_one_per_line on app.conversations (
  workspace_id,
  channel,
  counterpart,
  coalesce(
    case when channel = 'email' then email_address_id else phone_number_id end,
    '00000000-0000-0000-0000-000000000000'::uuid)
) where bin_item_id is null;
comment on index app.conversations_one_per_line is
  'One thread per customer per line of the business (0089), among the threads not in the Deleted bin. The '
  'expression is the lane: a number for a text, an address for mail, and the nil uuid for a chat or for a '
  'business with no line to send from.';

-- ---------- hidden ----------
-- The worker reads a booking in the bin only while it tells the customer it's cancelled or takes it off a Google
-- or Outlook calendar, and says so for that one transaction.
create or replace function private.reading_bin()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.read_bin', true), '') = 'on'
$$;
grant execute on function private.reading_bin() to authenticated, service_actor, portal_actor;

create policy conversations_not_binned on app.conversations as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy messages_not_binned on app.messages as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy calls_not_binned on app.calls as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy activities_not_binned on app.activities as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy tasks_not_binned on app.tasks as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy leads_not_binned on app.leads as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy files_not_binned on app.files as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy relationships_not_binned on app.relationships as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy form_responses_not_binned on app.form_responses as restrictive for all
  to authenticated, portal_actor, service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy appointments_not_binned on app.appointments as restrictive for all
  to authenticated, portal_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy appointment_attendees_not_binned on app.appointment_attendees as restrictive for all
  to authenticated, portal_actor
  using (bin_item_id is null) with check (bin_item_id is null);
-- The worker: bookings in the bin only to read, and only when it says so.
create policy appointments_service_reads_bin on app.appointments as restrictive for select to service_actor
  using (bin_item_id is null or private.reading_bin());
create policy appointments_service_insert_not_binned on app.appointments as restrictive for insert to service_actor
  with check (bin_item_id is null);
create policy appointments_service_update_not_binned on app.appointments as restrictive for update to service_actor
  using (bin_item_id is null) with check (bin_item_id is null);
create policy appointments_service_delete_not_binned on app.appointments as restrictive for delete to service_actor
  using (bin_item_id is null);
create policy appointment_attendees_service_reads_bin on app.appointment_attendees as restrictive for select
  to service_actor using (bin_item_id is null or private.reading_bin());
create policy appointment_attendees_service_insert_not_binned on app.appointment_attendees as restrictive for insert
  to service_actor with check (bin_item_id is null);
create policy appointment_attendees_service_update_not_binned on app.appointment_attendees as restrictive for update
  to service_actor using (bin_item_id is null) with check (bin_item_id is null);
create policy appointment_attendees_service_delete_not_binned on app.appointment_attendees as restrictive for delete
  to service_actor using (bin_item_id is null);

-- A customer in the bin stays readable (the bills that name them), but nobody changes them, and a customer reads
-- nothing of theirs.
create policy people_insert_not_binned on app.people as restrictive for insert to authenticated, service_actor
  with check (bin_item_id is null and erased_at is null);
create policy people_update_not_binned on app.people as restrictive for update to authenticated, service_actor
  using (bin_item_id is null and erased_at is null) with check (bin_item_id is null and erased_at is null);
create policy people_delete_not_binned on app.people as restrictive for delete to authenticated, service_actor
  using (bin_item_id is null);
create policy people_portal_not_binned on app.people as restrictive for select to portal_actor
  using (bin_item_id is null);

-- Nor is one merged away (private.merge_people writes past the policies, and already refuses merging into an
-- archived customer, which one in the bin is).
create or replace function private.forbid_merging_binned()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merged_into_id is distinct from old.merged_into_id
     and (old.bin_item_id is not null or old.erased_at is not null) then
    raise exception '% is in the Deleted bin. Bring them back first, then merge them.',
      coalesce(nullif(btrim(concat_ws(' ', old.first_name, old.last_name)), ''), 'This customer')
      using errcode = '55000', detail = 'person_in_bin';
  end if;
  return new;
end $$;
create trigger people_merge_not_binned before update of merged_into_id on app.people
  for each row execute function private.forbid_merging_binned();

-- Whatever lands in a thread in the bin goes in with it: a reply the AI was already writing, a late delivery.
create or replace function private.follow_thread_into_bin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.conversation_id is not null then
    select c.bin_item_id into new.bin_item_id from app.conversations c where c.id = new.conversation_id;
  end if;
  if new.bin_item_id is not null then
    new.sync_window := false;
  end if;
  return new;
end $$;
create trigger messages_follow_thread_into_bin before insert on app.messages
  for each row execute function private.follow_thread_into_bin();
create trigger calls_follow_thread_into_bin before insert on app.calls
  for each row execute function private.follow_thread_into_bin();

-- ---------- phones ----------
-- What phones keep: nothing in the bin. Tasks, bookings and links work their flag out on every write; these are
-- 0056's rules (and round six's for links) with the bin added.
create or replace function private.task_sync_window()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.sync_window := (new.done_at is null or new.done_at >= now() - interval '90 days') and new.bin_item_id is null;
  return new;
end $$;

create or replace function private.appointment_sync_window()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.sync_window := new.ends_at >= now() - interval '90 days' and new.bin_item_id is null;
  return new;
end $$;

-- Attendees and staff carry their appointment's flag; an attendee in the bin (one customer's seat in a group
-- session) has its own. Staff rows have no mark, hence the jsonb.
create or replace function private.appointment_child_sync_window()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_window boolean;
begin
  select a.sync_window into v_window from app.appointments a where a.id = new.appointment_id;
  new.sync_window := coalesce(v_window, true) and (to_jsonb(new) ->> 'bin_item_id') is null;
  return new;
end $$;

create or replace function private.keep_relationship_seal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select s.seal_scope, s.seal_open, s.seal_viewer_ids, s.seal_all, s.sync_window
  into new.seal_scope, new.seal_open, new.seal_viewer_ids, new.seal_all, new.sync_window
  from private.relationship_seal(new.a_custom_record_id, new.b_custom_record_id) s;
  new.sync_window := new.sync_window and new.bin_item_id is null;
  return new;
end $$;
drop trigger relationships_seal on app.relationships;
create trigger relationships_seal
  before insert or update of seal_scope, seal_open, seal_viewer_ids, seal_all, sync_window, bin_item_id
  on app.relationships for each row execute function private.keep_relationship_seal();

-- Messages, calls and timeline lines come back by time, or with a thread that opens again; never from the bin.
create or replace function private.restore_sync_window_by_time()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) ->> tg_argv[0])::timestamptz >= now() - interval '12 months'
     and (to_jsonb(new) ->> 'bin_item_id') is null then
    new.sync_window := true;
  end if;
  return new;
end $$;

create or replace function private.conversation_restore_sync_window()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.messages m set sync_window = true
  where m.conversation_id = new.id and not m.sync_window and m.bin_item_id is null;
  update app.calls c set sync_window = true
  where c.conversation_id = new.id and not c.sync_window and c.bin_item_id is null;
  return null;
end $$;

-- ---------- the bin at work ----------
-- Present only inside one of the functions below, in its own transaction (the row is never committed, as with
-- 0093's purge and the merge): while it is, the rules that keep history fixed let the bin through.
create table private.bin_work (
  workspace_id uuid primary key
);
revoke all on private.bin_work from public;

create or replace function private.bin_working(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_ws is not null and exists (select 1 from private.bin_work w where w.workspace_id = p_ws)
$$;
grant execute on function private.bin_working(uuid) to public;

-- Events and audit lines: as 20261013000300 wrote it, and the bin dropping their details as it empties.
create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.purging_workspace((to_jsonb(old) ->> 'workspace_id')::uuid) then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - array['payload', 'before', 'after']) = (to_jsonb(old) - array['payload', 'before', 'after'])
     and (((to_jsonb(old) ->> 'addon_id') is not null
           and private.purging_addon((to_jsonb(old) ->> 'workspace_id')::uuid, to_jsonb(old) ->> 'addon_id'))
          or private.bin_working((to_jsonb(old) ->> 'workspace_id')::uuid)) then
    return new;
  end if;
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '42501';
end $$;

-- A system timeline line: as 20261022000100 wrote it, plus going into and out of the bin (bookkeeping, like the
-- phone's flag), and going for good as the bin empties.
create or replace function private.forbid_system_activity_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (private.purging_workspace(old.workspace_id) or private.bin_working(old.workspace_id)) then
    return old;
  end if;
  if old.kind = 'system' then
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'seal_scope', 'seal_viewer_ids', 'bin_item_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'seal_scope', 'seal_viewer_ids', 'bin_item_id']) then
      return new;
    end if;
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['sync_window', 'updated_at', 'person_id'])
         = (to_jsonb(old) - array['sync_window', 'updated_at', 'person_id'])
       and coalesce(private.merging_person(old.person_id::text, new.person_id::text), false) then
      return new;
    end if;
    -- An add-on's own line, losing its words while that add-on's data is deleted.
    if tg_op = 'UPDATE' and old.subtype = 'addon_line'
       and (to_jsonb(new) - array['body', 'meta', 'updated_at']) = (to_jsonb(old) - array['body', 'meta', 'updated_at'])
       and new.meta -> 'addon' = old.meta -> 'addon' and new.body is null
       and coalesce(private.purging_addon(old.workspace_id, old.meta -> 'addon' ->> 'id'), false) then
      return new;
    end if;
    raise exception 'System timeline entries cannot be changed' using errcode = '42501', detail = 'system_activity_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- 20261012150100's rule, plus the bin: a thread brought back into the one that took its line moves its messages
-- there.
create or replace function private.forbid_tenant_column_change()
returns trigger language plpgsql set search_path = '' as $$
declare
  cols text[] := tg_argv;
  c text;
  old_v text;
  new_v text;
begin
  foreach c in array cols loop
    execute format('select ($1).%I::text, ($2).%I::text', c, c) into old_v, new_v using old, new;
    if old_v is distinct from new_v and not coalesce(private.merging_person(old_v, new_v), false)
       and not private.bin_working((to_jsonb(old) ->> 'workspace_id')::uuid) then
      raise exception '% is immutable on %.%', c, tg_table_schema, tg_table_name using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- 0005's rule for files, plus the bin marking a customer's files deleted while they're in it (whoever may delete
-- for good may do that without files.delete).
create or replace function private.guard_file_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_in_scope boolean := coalesce(private.system_scope_workspace() = new.workspace_id, false);
begin
  if old.status is distinct from new.status then
    if not (old.status = 'pending' and new.status = 'ready') then
      raise exception 'A file only moves from pending to ready' using errcode = '23514', detail = 'file_status_transition';
    end if;
    if not (v_in_scope or coalesce(old.created_by = auth.uid(), false)) then
      raise exception 'Only the uploader confirms a file' using errcode = '42501', detail = 'file_confirm_forbidden';
    end if;
  end if;
  if old.deleted_at is distinct from new.deleted_at then
    if not (v_in_scope or coalesce(old.created_by = auth.uid(), false)
            or coalesce(private.has_permission(new.workspace_id, 'files.delete'), false)
            or private.bin_working(new.workspace_id)) then
      raise exception 'Deleting this file needs the files.delete permission' using errcode = '42501', detail = 'file_delete_forbidden';
    end if;
    new.deleted_by := case when new.deleted_at is null then null else coalesce(auth.uid(), new.deleted_by) end;
  end if;
  return new;
end $$;

-- ---------- what goes ----------
-- Everything not yet in the bin that goes with one customer, conversation or booking.
create type private.bin_rows as (
  people uuid[],
  leads uuid[],
  conversations uuid[],
  messages uuid[],
  calls uuid[],
  activities uuid[],
  tasks uuid[],
  appointments uuid[],
  attendees uuid[],
  files uuid[],
  relationships uuid[],
  responses uuid[]
);

create or replace function private.bin_rows_of(p_kind text, p_record uuid)
returns private.bin_rows language plpgsql stable security definer set search_path = '' as $$
declare
  r private.bin_rows;
  v_ws uuid;
begin
  r := row('{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}')::private.bin_rows;
  if p_kind = 'person' then
    select p.workspace_id into v_ws from app.people p where p.id = p_record;
    -- The customer, and the duplicates merged into them (empty shells that still carry their details).
    r.people := array(select p.id from app.people p
                      where (p.id = p_record or p.merged_into_id = p_record) and p.bin_item_id is null);
    r.leads := array(select l.id from app.leads l where l.person_id = any (r.people) and l.bin_item_id is null);
    r.conversations := array(select c.id from app.conversations c
                             where c.person_id = any (r.people) and c.bin_item_id is null);
    r.calls := array(
      select k.id from app.calls k where k.person_id = any (r.people) and k.bin_item_id is null
      union
      select k.id from app.calls k where k.conversation_id = any (r.conversations) and k.bin_item_id is null);
    -- Their bookings: the ones nobody else is on (with what hangs off them), and their own seat on the others.
    -- A class time (a session) is the business's schedule, so only their seat on it goes, even when they were alone.
    r.appointments := array(
      select x.id from (
        select t.appointment_id as id from app.appointment_attendees t where t.person_id = any (r.people)
        union
        select a.id from app.appointments a where a.lead_id = any (r.leads)
      ) x
      join app.appointments a on a.id = x.id and a.bin_item_id is null and a.kind = 'booking'
      where not exists (select 1 from app.appointment_attendees o
                        where o.appointment_id = x.id and not (o.person_id = any (r.people))));
    r.attendees := array(select t.id from app.appointment_attendees t
                         where (t.person_id = any (r.people) or t.appointment_id = any (r.appointments))
                           and t.bin_item_id is null);
    r.tasks := array(
      select t.id from app.tasks t where t.person_id = any (r.people) and t.bin_item_id is null
      union
      select t.id from app.tasks t where t.lead_id = any (r.leads) and t.bin_item_id is null);
    r.files := array(select f.id from app.files f
                     where ((f.record_type = 'person' and f.record_id = any (r.people))
                         or (f.record_type = 'lead' and f.record_id = any (r.leads)))
                       and f.bin_item_id is null);
    r.relationships := array(select x.id from app.relationships x
                             where (x.a_person_id = any (r.people) or x.b_person_id = any (r.people))
                               and x.bin_item_id is null);
    r.responses := array(
      select f.id from app.form_responses f where f.person_id = any (r.people) and f.bin_item_id is null
      union
      select f.id from app.form_responses f where f.lead_id = any (r.leads) and f.bin_item_id is null);
  elsif p_kind = 'conversation' then
    select c.workspace_id into v_ws from app.conversations c where c.id = p_record and c.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.conversations := array[p_record];
    r.calls := array(select k.id from app.calls k where k.conversation_id = p_record and k.bin_item_id is null);
  elsif p_kind = 'appointment' then
    select a.workspace_id into v_ws from app.appointments a where a.id = p_record and a.bin_item_id is null;
    if v_ws is null then
      return r;
    end if;
    r.appointments := array[p_record];
    r.attendees := array(select t.id from app.appointment_attendees t
                         where t.appointment_id = p_record and t.bin_item_id is null);
  else
    raise exception 'Nothing of that kind goes in the bin' using errcode = '22023', detail = 'bin_kind';
  end if;

  r.messages := array(select m.id from app.messages m
                      where m.conversation_id = any (r.conversations) and m.bin_item_id is null);
  -- Timeline lines: theirs and their leads', each message's and call's, and each booking's.
  r.activities := array(
    select a.id from app.activities a
    where a.workspace_id = v_ws and a.person_id = any (r.people) and a.bin_item_id is null
    union
    select a.id from app.activities a
    where a.workspace_id = v_ws and a.lead_id = any (r.leads) and a.bin_item_id is null
    union
    select a.id from app.messages m join app.activities a on a.id = m.activity_id
    where m.id = any (r.messages) and a.bin_item_id is null
    union
    select a.id from app.calls k join app.activities a on a.id = k.activity_id
    where k.id = any (r.calls) and a.bin_item_id is null
    union
    select a.id from app.appointment_attendees t
    join app.activities a on a.workspace_id = v_ws and a.person_id = t.person_id
    where t.id = any (r.attendees) and a.bin_item_id is null
      and a.meta ->> 'appointmentId' = t.appointment_id::text);
  return r;
end $$;
revoke all on function private.bin_rows_of(text, uuid) from public;

-- A record's kept-ness: a legal hold, or a retention hold not yet over.
create or replace function private.record_kept(p_record uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when bool_or(h.kind = 'legal') then 'on a legal hold'
    when bool_or(h.held_until is null) then 'kept while it’s open'
    else 'kept until ' || to_char(max(h.held_until), 'FMMonth FMDD, YYYY') end
  from app.record_holds h
  where h.custom_record_id = p_record and h.lifted_at is null
    and (h.kind = 'legal' or h.held_until is null or h.held_until > now())
  having count(*) > 0
$$;
revoke all on function private.record_kept(uuid) from public;

-- Why these rows can't go, in words for the person deleting, or nothing. p_name names the customer.
create or replace function private.bin_blocker(p_kind text, p_name text, r private.bin_rows,
  out rule text, out message text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_record uuid;
  v_record_name text;
  v_kept text;
  v_file text;
  v_at timestamptz;
  v_tz text;
  v_when text;
begin
  if p_kind = 'person' and exists (
    select 1 from app.subscriptions s
    where s.person_id = any (r.people) and s.status in ('active', 'past_due', 'paused')) then
    rule := 'bin_plan_running';
    message := format('%s has a plan that’s still billing. Cancel it on their Money tab first, then delete them.',
      p_name);
    return;
  end if;

  select f.name into v_file from app.files f
  where f.id = any (r.files) and f.locked_at is not null and f.deleted_at is null
  limit 1;
  if v_file is not null then
    rule := 'bin_signed_file';
    message := format('%s has a signed file, %s, and signed files are kept for good. Archive them instead.',
      p_name, v_file);
    return;
  end if;

  -- History on a record that's being kept (Real Estate: a deal still open, closed within its years, or on legal
  -- hold).
  select x.record_id into v_record from (
    select a.custom_record_id as record_id from app.activities a
    where a.id = any (r.activities) and a.custom_record_id is not null
    union all
    select t.custom_record_id from app.tasks t where t.id = any (r.tasks) and t.custom_record_id is not null
    union all
    select c.custom_record_id from app.conversations c
    where c.id = any (r.conversations) and c.custom_record_id is not null
    union all
    select a.custom_record_id from app.appointments a
    where (a.id = any (r.appointments)
           or a.id in (select t.appointment_id from app.appointment_attendees t where t.id = any (r.attendees)))
      and a.custom_record_id is not null
    union all
    select coalesce(x.a_custom_record_id, x.b_custom_record_id) from app.relationships x
    where x.id = any (r.relationships) and coalesce(x.a_custom_record_id, x.b_custom_record_id) is not null
  ) x
  where private.record_kept(x.record_id) is not null
  limit 1;
  if v_record is not null then
    select cr.name into v_record_name from app.custom_records cr where cr.id = v_record;
    v_record_name := coalesce(v_record_name, 'a record');
    v_kept := private.record_kept(v_record);
    rule := 'bin_record_kept';
    message := case p_kind
      when 'person' then format('%s is on %s, which is %s, so their history there has to stay. Archive them instead.',
        p_name, v_record_name, v_kept)
      when 'conversation' then format('This conversation is part of %s, which is %s, so it has to stay. Archive it instead.',
        v_record_name, v_kept)
      else format('This booking is part of %s, which is %s, so it has to stay.', v_record_name, v_kept) end;
    return;
  end if;

  if exists (select 1 from app.messages m
             where m.id = any (r.messages)
               and (m.status = 'sending' or (m.status = 'queued' and m.error_code is distinct from 'scheduled'))) then
    rule := 'bin_still_sending';
    message := case when p_kind = 'person'
      then format('A message to %s is still going out. Try again in a minute.', p_name)
      else 'A message in this conversation is still going out. Try again in a minute.' end;
    return;
  end if;

  if exists (select 1 from app.calls k
             where k.id = any (r.calls) and k.status in ('initiated', 'ringing', 'in_progress')) then
    rule := 'bin_call_live';
    message := case when p_kind = 'person'
      then format('A call with %s is still going on. Try again when it ends.', p_name)
      else 'A call in this conversation is still going on. Try again when it ends.' end;
    return;
  end if;

  -- A booking still to come is cancelled first: the command does it, and tells the customer if asked to.
  select a.starts_at, coalesce(w.timezone, 'UTC') into v_at, v_tz
  from app.appointments a join app.workspaces w on w.id = a.workspace_id
  where a.status = 'scheduled' and a.ends_at > now()
    and (a.id = any (r.appointments)
         or a.id in (select t.appointment_id from app.appointment_attendees t
                     where t.id = any (r.attendees) and t.status = 'booked'))
  order by a.starts_at
  limit 1;
  if v_at is not null then
    v_when := to_char(v_at at time zone v_tz, 'FMMonth FMDD');
    rule := 'bin_upcoming_booking';
    message := case when p_kind = 'person'
      then format('%s has a booking still to come, on %s. Cancel it first, then delete them.', p_name, v_when)
      else format('This booking is still to come, on %s. Cancel it first, then delete it.', v_when) end;
    return;
  end if;
end $$;
revoke all on function private.bin_blocker(text, text, private.bin_rows) from public;

-- What a customer, a conversation or a booking is called in the bin.
create or replace function private.bin_name(p_kind text, p_record uuid)
returns text language sql stable security definer set search_path = '' as $$
  select left(coalesce(case p_kind
    when 'person' then (
      select nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') from app.people p where p.id = p_record)
    when 'conversation' then (
      select coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), mc.name,
        '@' || mc.username, nullif(btrim(v.name), ''), v.email, v.phone_e164,
        case when c.channel in ('sms', 'email') then c.counterpart end)
      from app.conversations c
      left join app.people p on p.id = c.person_id
      left join app.meta_contacts mc on mc.conversation_id = c.id
      left join app.chat_visitors v on v.conversation_id = c.id
      where c.id = p_record)
    when 'appointment' then (
      select coalesce(nullif(btrim(a.title), ''), s.name)
      from app.appointments a left join app.services s on s.id = a.service_id where a.id = p_record)
  end, case p_kind when 'person' then 'A customer' when 'conversation' then 'A conversation' else 'A booking' end), 300)
$$;
revoke all on function private.bin_name(text, uuid) from public;

-- How much goes with it, for the delete box and the bin's list. `bills` stay (the owner's decision 4), and
-- `upcoming` bookings are cancelled first. A conversation or a booking doesn't count itself.
create or replace function private.bin_contents(p_kind text, p_record uuid, r private.bin_rows)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'upcoming', nullif((
      select count(*) from app.appointments a
      where a.status = 'scheduled' and a.ends_at > now()
        and (a.id = any (r.appointments)
             or a.id in (select t.appointment_id from app.appointment_attendees t
                         where t.id = any (r.attendees) and t.status = 'booked'))), 0),
    'conversations', case when p_kind = 'person' then nullif(cardinality(r.conversations), 0) end,
    'messages', nullif(cardinality(r.messages), 0),
    'calls', nullif(cardinality(r.calls), 0),
    'notes', nullif((select count(*) from app.activities a where a.id = any (r.activities) and a.kind = 'note'), 0),
    'tasks', nullif(cardinality(r.tasks), 0),
    'leads', nullif(cardinality(r.leads), 0),
    'bookings', case when p_kind = 'person' then nullif(cardinality(r.attendees), 0) end,
    'files', nullif((select count(*) from app.files f where f.id = any (r.files) and f.deleted_at is null), 0),
    'forms', nullif(cardinality(r.responses), 0),
    'bills', case when p_kind = 'person' then nullif(
      (select count(*) from app.invoices i where i.person_id = any (r.people))
      + (select count(*) from app.estimates e where e.person_id = any (r.people))
      + (select count(*) from app.subscriptions s where s.person_id = any (r.people)), 0) end,
    'channel', (select c.channel::text from app.conversations c where p_kind = 'conversation' and c.id = p_record),
    'startsAt', (select a.starts_at from app.appointments a where p_kind = 'appointment' and a.id = p_record),
    'who', (select jsonb_agg(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') order by t.created_at)
            from app.appointment_attendees t join app.people p on p.id = t.person_id
            where p_kind = 'appointment' and t.appointment_id = p_record)
  ))
$$;
revoke all on function private.bin_contents(text, uuid, private.bin_rows) from public;

create or replace function private.bin_assert_may_delete(p_ws uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.has_permission(p_ws, 'records.delete'), false) then
    raise exception 'Only an owner of this business deletes for good. Ask an owner, or archive it instead.'
      using errcode = '42501', detail = 'delete_forbidden';
  end if;
end $$;
revoke all on function private.bin_assert_may_delete(uuid) from public;

-- Marks the rows with the bin item and hides them from phones, and answers what bringing them back undoes.
create or replace function private.bin_mark(p_item uuid, r private.bin_rows)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_undo jsonb;
begin
  v_undo := jsonb_build_object(
    'people', to_jsonb(array(select p.id from app.people p where p.id = any (r.people) and p.archived_at is null)),
    'leads', to_jsonb(array(select l.id from app.leads l where l.id = any (r.leads) and l.archived_at is null)),
    'conversations', to_jsonb(array(select c.id from app.conversations c
                                    where c.id = any (r.conversations) and c.archived_at is null)),
    'files', to_jsonb(array(select f.id from app.files f where f.id = any (r.files) and f.deleted_at is null)));

  -- Archived, so phones put them away with what they already hide.
  update app.people p set bin_item_id = p_item, archived_at = coalesce(p.archived_at, now())
  where p.id = any (r.people);
  update app.leads l set bin_item_id = p_item, archived_at = coalesce(l.archived_at, now())
  where l.id = any (r.leads);
  update app.conversations c set bin_item_id = p_item, archived_at = coalesce(c.archived_at, now())
  where c.id = any (r.conversations);
  update app.messages m set bin_item_id = p_item, sync_window = false where m.id = any (r.messages);
  update app.calls k set bin_item_id = p_item, sync_window = false where k.id = any (r.calls);
  update app.activities a set bin_item_id = p_item, sync_window = false where a.id = any (r.activities);
  -- Their triggers work the phone's flag out.
  update app.tasks t set bin_item_id = p_item where t.id = any (r.tasks);
  update app.appointments a set bin_item_id = p_item where a.id = any (r.appointments);
  update app.appointment_attendees t set bin_item_id = p_item, sync_window = false where t.id = any (r.attendees);
  update app.relationships x set bin_item_id = p_item where x.id = any (r.relationships);
  update app.form_responses f set bin_item_id = p_item where f.id = any (r.responses);
  -- Marked deleted, which is how phones leave a file out.
  update app.files f set bin_item_id = p_item, deleted_at = coalesce(f.deleted_at, now()) where f.id = any (r.files);
  return v_undo;
end $$;
revoke all on function private.bin_mark(uuid, private.bin_rows) from public;

-- What doesn't come back: workflows stop with their approvals, Home's cards and the AI's waiting drafts and calls
-- go, a place on a waitlist is given up, and the customer's portal signs out.
create or replace function private.bin_let_go(p_ws uuid, r private.bin_rows)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[] := r.people || r.leads || r.conversations || r.appointments || r.attendees || r.tasks;
  v_drafts uuid[];
begin
  -- A run's approvals still waiting go with it, as when a run is stopped by hand (the worker's cancelRunWork).
  with stopped as (
    update app.workflow_runs w set status = 'stopped', end_reason = 'deleted', ended_at = now()
    where w.workspace_id = p_ws and w.status in ('running', 'waiting', 'awaiting_approval', 'held')
      and (w.person_id = any (r.people) or w.lead_id = any (r.leads) or w.conversation_id = any (r.conversations)
           or w.appointment_id = any (r.appointments))
    returning w.id)
  update app.workflow_approvals a set status = 'cancelled', decided_at = now(), via = 'system'
  where a.run_id in (select s.id from stopped s) and a.status = 'pending';
  -- Calls the AI was still to make (waiting for an OK, or queued) aren't made, and their OKs aren't asked.
  with off as (
    update app.ai_calls k set status = 'cancelled', reason = 'deleted'
    where k.workspace_id = p_ws and k.status in ('awaiting_approval', 'queued')
      and (k.person_id = any (r.people) or k.attendee_id = any (r.attendees) or k.missed_call_id = any (r.calls))
    returning k.draft_id)
  select array(select o.draft_id from off o where o.draft_id is not null) into v_drafts;
  delete from app.ai_teammate_drafts d where d.id = any (v_drafts) and d.status = 'pending';
  delete from app.attention_items i
  where i.workspace_id = p_ws
    and (i.person_id = any (r.people) or i.lead_id = any (r.leads) or i.conversation_id = any (r.conversations)
         or i.subject_id = any (v_ids));
  delete from app.ai_teammate_drafts d
  where d.workspace_id = p_ws and d.status = 'pending'
    and (d.conversation_id = any (r.conversations) or d.person_id = any (r.people) or d.lead_id = any (r.leads));
  update app.waitlist_entries e set status = 'removed'
  where e.workspace_id = p_ws and e.status in ('waiting', 'offered')
    and (e.person_id = any (r.people) or e.appointment_id = any (r.appointments));
  delete from app.portal_sessions s where s.person_id = any (r.people);
end $$;
revoke all on function private.bin_let_go(uuid, private.bin_rows) from public;

-- Puts one thing in the bin, as the person deleting it; answers the bin item.
create or replace function private.bin_put(p_kind text, p_record uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_gone boolean;
  v_name text;
  v_rows private.bin_rows;
  v_block record;
  v_item uuid;
begin
  if p_kind = 'person' then
    select p.workspace_id, p.bin_item_id is not null or p.erased_at is not null
    into v_ws, v_gone from app.people p where p.id = p_record for update;
    if v_ws is not null and not v_gone and exists (
      select 1 from app.people p where p.id = p_record and p.merged_into_id is not null) then
      raise exception 'This customer was merged into another one. Delete the one they were merged into instead.'
        using errcode = '55000', detail = 'bin_person_merged';
    end if;
  elsif p_kind = 'conversation' then
    select c.workspace_id, c.bin_item_id is not null
                           or (c.private_to is not null and c.private_to is distinct from auth.uid())
    into v_ws, v_gone from app.conversations c where c.id = p_record for update;
  elsif p_kind = 'appointment' then
    select a.workspace_id, a.bin_item_id is not null
    into v_ws, v_gone from app.appointments a where a.id = p_record for update;
  else
    raise exception 'Nothing of that kind goes in the bin' using errcode = '22023', detail = 'bin_kind';
  end if;
  if v_ws is null or v_gone then
    raise exception 'That isn’t here any more. Someone may have deleted it already. Refresh to see what’s left.'
      using errcode = 'P0002', detail = 'bin_record_gone';
  end if;
  perform private.bin_assert_may_delete(v_ws);

  v_name := private.bin_name(p_kind, p_record);
  v_rows := private.bin_rows_of(p_kind, p_record);
  select * into v_block from private.bin_blocker(p_kind, v_name, v_rows);
  if v_block.rule is not null then
    raise exception '%', v_block.message using errcode = '55000', detail = v_block.rule;
  end if;

  insert into private.bin_work (workspace_id) values (v_ws) on conflict do nothing;
  insert into app.bin_items (workspace_id, kind, record_id, name, contents, deleted_by)
  values (v_ws, p_kind, p_record, v_name, private.bin_contents(p_kind, p_record, v_rows), auth.uid())
  returning id into v_item;
  update app.bin_items b set undo = private.bin_mark(v_item, v_rows) where b.id = v_item;
  perform private.bin_let_go(v_ws, v_rows);
  delete from private.bin_work w where w.workspace_id = v_ws;
  return v_item;
end $$;
revoke all on function private.bin_put(text, uuid) from public;
grant execute on function private.bin_put(text, uuid) to authenticated;

-- What deleting these would take, or why it can't, for the delete box. Only what the caller may delete is
-- answered; anything else, or already gone, answers bin_record_gone.
create or replace function private.bin_preview(p_kind text, p_ids uuid[])
returns table (record_id uuid, name text, contents jsonb, rule text, message text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
  v_ws uuid;
  v_rows private.bin_rows;
  v_block record;
begin
  if p_kind not in ('person', 'conversation', 'appointment') then
    raise exception 'Nothing of that kind goes in the bin' using errcode = '22023', detail = 'bin_kind';
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    v_ws := case p_kind
      when 'person' then (select p.workspace_id from app.people p
                          where p.id = v_id and p.bin_item_id is null and p.erased_at is null)
      when 'conversation' then (select c.workspace_id from app.conversations c
                                where c.id = v_id and c.bin_item_id is null
                                  and (c.private_to is null or c.private_to = auth.uid()))
      else (select a.workspace_id from app.appointments a where a.id = v_id and a.bin_item_id is null) end;
    record_id := v_id;
    if v_ws is null or not coalesce(private.has_permission(v_ws, 'records.delete'), false) then
      name := null;
      contents := '{}'::jsonb;
      rule := 'bin_record_gone';
      message := 'That isn’t here any more. Someone may have deleted it already. Refresh to see what’s left.';
      return next;
      continue;
    end if;
    name := private.bin_name(p_kind, v_id);
    v_rows := private.bin_rows_of(p_kind, v_id);
    contents := private.bin_contents(p_kind, v_id, v_rows);
    select * into v_block from private.bin_blocker(p_kind, name, v_rows);
    rule := v_block.rule;
    message := v_block.message;
    return next;
  end loop;
end $$;
revoke all on function private.bin_preview(text, uuid[]) from public;
grant execute on function private.bin_preview(text, uuid[]) to authenticated;

-- ---------- back out ----------
-- Brings a bin item back, as the person doing it. A thread whose line has had a new thread since joins that one:
-- its messages and calls move there, and the new thread becomes the customer's if it had nobody.
create or replace function private.restore_bin_item(p_item uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item app.bin_items%rowtype;
  v_conv app.conversations%rowtype;
  v_into uuid;
  v_folded integer := 0;
  v_nil constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  select * into v_item from app.bin_items b where b.id = p_item for update;
  if not found then
    raise exception 'That isn’t in the Deleted bin any more. Refresh to see what’s left.'
      using errcode = 'P0002', detail = 'bin_item_gone';
  end if;
  perform private.bin_assert_may_delete(v_item.workspace_id);
  if v_item.purging_since is not null then
    raise exception '% is already being deleted for good, so it can’t be brought back.', v_item.name
      using errcode = '55000', detail = 'bin_item_emptying';
  end if;
  insert into private.bin_work (workspace_id) values (v_item.workspace_id) on conflict do nothing;

  for v_conv in select c.* from app.conversations c where c.bin_item_id = p_item loop
    select l.id into v_into from app.conversations l
    where l.workspace_id = v_conv.workspace_id and l.channel = v_conv.channel and l.counterpart = v_conv.counterpart
      and coalesce(case when l.channel = 'email' then l.email_address_id else l.phone_number_id end, v_nil)
        = coalesce(case when v_conv.channel = 'email' then v_conv.email_address_id else v_conv.phone_number_id end, v_nil)
      and l.bin_item_id is null and l.id <> v_conv.id;
    if v_into is not null then
      update app.messages m set conversation_id = v_into where m.conversation_id = v_conv.id;
      update app.calls k set conversation_id = v_into where k.conversation_id = v_conv.id;
      update app.conversations l set person_id = v_conv.person_id
      where l.id = v_into and l.person_id is null and l.private_to is null and v_conv.person_id is not null;
      delete from app.conversations c where c.id = v_conv.id;
      v_folded := v_folded + 1;
    end if;
  end loop;

  update app.people p set bin_item_id = null,
    archived_at = case when v_item.undo -> 'people' ? p.id::text then null else p.archived_at end
  where p.bin_item_id = p_item;
  update app.leads l set bin_item_id = null,
    archived_at = case when v_item.undo -> 'leads' ? l.id::text then null else l.archived_at end
  where l.bin_item_id = p_item;
  update app.conversations c set bin_item_id = null,
    archived_at = case when v_item.undo -> 'conversations' ? c.id::text then null else c.archived_at end
  where c.bin_item_id = p_item;
  -- Back on phones by 0056's rules: the last 12 months, or a thread still open.
  update app.messages m set bin_item_id = null,
    sync_window = m.occurred_at >= now() - interval '12 months'
      or exists (select 1 from app.conversations c where c.id = m.conversation_id and c.status <> 'closed')
  where m.bin_item_id = p_item;
  update app.calls k set bin_item_id = null,
    sync_window = k.started_at >= now() - interval '12 months'
      or exists (select 1 from app.conversations c where c.id = k.conversation_id and c.status <> 'closed')
  where k.bin_item_id = p_item;
  update app.activities a set bin_item_id = null, sync_window = a.occurred_at >= now() - interval '12 months'
  where a.bin_item_id = p_item;
  update app.tasks t set bin_item_id = null where t.bin_item_id = p_item;
  update app.appointments a set bin_item_id = null where a.bin_item_id = p_item;
  update app.appointment_attendees t set bin_item_id = null, sync_window = true where t.bin_item_id = p_item;
  update app.relationships x set bin_item_id = null where x.bin_item_id = p_item;
  update app.form_responses f set bin_item_id = null where f.bin_item_id = p_item;
  update app.files f set bin_item_id = null,
    deleted_at = case when v_item.undo -> 'files' ? f.id::text then null else f.deleted_at end
  where f.bin_item_id = p_item;

  delete from app.bin_items b where b.id = p_item;
  delete from private.bin_work w where w.workspace_id = v_item.workspace_id;
  return jsonb_build_object('kind', v_item.kind, 'recordId', v_item.record_id, 'name', v_item.name,
    'folded', v_folded);
end $$;
revoke all on function private.restore_bin_item(uuid) from public;
grant execute on function private.restore_bin_item(uuid) to authenticated;

-- ---------- emptying ----------
-- An owner's "Delete now": the items start emptying, and can't be brought back. Answers the ones that did.
create or replace function private.bin_start_purge(p_items uuid[])
returns table (bin_item_id uuid, workspace_id uuid, kind text, record_id uuid, name text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update app.bin_items b set purging_since = now(), purge_after = least(b.purge_after, now())
  where b.id = any (p_items) and b.purging_since is null
    and coalesce(private.has_permission(b.workspace_id, 'records.delete'), false)
  returning b.id, b.workspace_id, b.kind, b.record_id, b.name;
end $$;
revoke all on function private.bin_start_purge(uuid[]) from public;
grant execute on function private.bin_start_purge(uuid[]) to authenticated;

-- The worker's daily look: what's been in the bin 30 days starts emptying, and what started a day ago without
-- finishing is answered again. Across every business, as the old-spam sweep is.
create or replace function private.bin_due(p_limit integer default 100)
returns table (bin_item_id uuid, workspace_id uuid, organization_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 100), 1000));
begin
  return query
  with due as (
    update app.bin_items b set purging_since = now()
    where b.id in (
      select x.id from (
        select d.id, d.purge_after from app.bin_items d
        where d.purging_since is null and d.purge_after <= now()
        union all
        select d.id, d.purge_after from app.bin_items d
        where d.purging_since < now() - interval '1 day'
      ) x
      order by x.purge_after
      limit v_limit)
    returning b.id, b.workspace_id
  )
  select d.id, d.workspace_id, w.organization_id from due d join app.workspaces w on w.id = d.workspace_id;
end $$;
revoke all on function private.bin_due(integer) from public;
grant execute on function private.bin_due(integer) to service_actor;

-- History keeps its lines and drops their details (the owner's rule, 2026-09-28), except the lines that say what
-- was deleted, brought back or emptied, by whom and when.
create or replace function private.bin_redact(p_ws uuid, p_type text, p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_kept constant text[] := array['person.deleted', 'conversation.deleted', 'appointment.deleted', 'bin.restored',
    'bin.emptied'];
begin
  update app.audit_logs a set before = null, after = null
  where a.entity_type = p_type and a.entity_id = any (p_ids) and a.workspace_id = p_ws
    and (a.before is not null or a.after is not null)
    and not exists (select 1 from app.events e where e.id = a.event_id and e.event_type = any (v_kept));
  update app.events e set payload = '{"_redacted": true}'::jsonb
  where e.entity_type = p_type and e.entity_id = any (p_ids) and e.workspace_id = p_ws
    and not (e.payload ? '_redacted') and not (e.event_type = any (v_kept));
end $$;
revoke all on function private.bin_redact(uuid, text, uuid[]) from public;

-- What storage holds for these rows, for the worker to remove once they're gone: a message's own media (what came
-- with a text or a Messenger message, an email's attachments, a video sent in), a call's recording, and files.
-- Media that is one of the business's files (a fileId) is that file's, and stays with it.
create or replace function private.bin_objects(p_ws uuid, p_table text, p_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', o.bucket, 'objectPath', o.path)), '[]'::jsonb)
  from (
    select e ->> 'bucket' as bucket, e ->> 'objectPath' as path
    from app.messages m
    cross join lateral jsonb_array_elements(case when jsonb_typeof(m.media) = 'array' then m.media
                                                 else '[]'::jsonb end) e
    where p_table = 'messages' and m.id = any (p_ids) and e ->> 'fileId' is null
      and (e ->> 'objectPath' like p_ws::text || '/messages/%' or e ->> 'objectPath' like p_ws::text || '/email/%')
    union all
    select 'telephony', k.recording_object_path from app.calls k
    where p_table = 'calls' and k.id = any (p_ids) and k.recording_object_path like p_ws::text || '/calls/%'
    union all
    select f.bucket, f.object_path from app.files f
    where p_table = 'files' and f.id = any (p_ids) and f.locked_at is null
  ) o
  where o.bucket is not null and o.path is not null and o.path not like '%..%'
$$;
revoke all on function private.bin_objects(uuid, text, uuid[]) from public;

-- Empties one bin item a batch at a time, as the worker in that business: answers whether there's more, and what
-- to remove from storage now that its rows are gone.
create or replace function private.purge_bin_batch(p_ws uuid, p_item uuid, p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item app.bin_items%rowtype;
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  -- Each table, the kind of thing its events are about, and how many go at once (a thread takes its events with
  -- it, so fewer).
  v_steps constant text[][] := array[
    array['messages', 'message', '1'],
    array['calls', 'call', '1'],
    array['activities', 'activity', '1'],
    array['tasks', 'task', '1'],
    array['form_responses', 'form_response', '1'],
    array['relationships', 'relationship', '1'],
    array['files', 'file', '1'],
    array['appointment_attendees', 'attendee', '1'],
    array['appointments', 'appointment', '20'],
    array['leads', 'lead', '20'],
    array['conversations', 'conversation', '50']
  ];
  v_step text[];
  v_ids uuid[];
  v_objects jsonb;
  v_person app.people%rowtype;
  v_leads uuid[];
  v_keeper uuid;
begin
  perform private.assert_worker_scope(p_ws);
  select * into v_item from app.bin_items b where b.id = p_item and b.workspace_id = p_ws for update;
  if not found then
    return jsonb_build_object('more', false, 'objects', '[]'::jsonb);
  end if;
  if v_item.purging_since is null then
    raise exception 'That isn’t being emptied from the bin' using errcode = '55000', detail = 'bin_not_emptying';
  end if;
  insert into private.bin_work (workspace_id) values (p_ws) on conflict do nothing;

  -- 1. What went in with it, a batch at a time.
  foreach v_step slice 1 in array v_steps loop
    execute format('select array(select x.id from app.%I x where x.bin_item_id = $1 limit $2)', v_step[1])
      into v_ids using p_item, greatest(1, v_limit / v_step[3]::integer);
    if cardinality(v_ids) > 0 then
      v_objects := private.bin_objects(p_ws, v_step[1], v_ids);
      perform private.bin_redact(p_ws, v_step[2], v_ids);
      if v_step[1] = 'leads' then
        -- Whatever still names these leads (nothing should, but a timeline line can't be left pointing at nothing).
        delete from app.activities a where a.lead_id = any (v_ids);
        delete from app.tasks t where t.lead_id = any (v_ids);
      end if;
      execute format('delete from app.%I x where x.id = any ($1)', v_step[1]) using v_ids;
      delete from private.bin_work w where w.workspace_id = p_ws;
      return jsonb_build_object('more', true, 'objects', v_objects);
    end if;
  end loop;

  -- 2. A customer, and the duplicates merged into them: whatever else names them, one at a time.
  select * into v_person from app.people p where p.bin_item_id = p_item
  order by (p.id = v_item.record_id), p.id limit 1;
  if found then
    v_leads := array(select l.id from app.leads l where l.person_id = v_person.id);
    v_ids := array(select f.id from app.files f
                   where (f.record_type = 'person' and f.record_id = v_person.id)
                      or (f.record_type = 'lead' and f.record_id = any (v_leads)));
    v_objects := private.bin_objects(p_ws, 'files', v_ids);
    perform private.bin_redact(p_ws, 'file', v_ids);
    delete from app.files f where f.id = any (v_ids);
    -- Their seats and waits on bookings (in the bin with a booking, or a group session's).
    delete from app.appointment_attendees t where t.person_id = v_person.id;
    delete from app.waitlist_entries e where e.person_id = v_person.id;
    delete from app.activities a where a.person_id = v_person.id or a.lead_id = any (v_leads);
    delete from app.tasks t where t.person_id = v_person.id or t.lead_id = any (v_leads);
    delete from app.form_responses f where f.person_id = v_person.id or f.lead_id = any (v_leads);
    perform private.bin_redact(p_ws, 'lead', v_leads);
    delete from app.leads l where l.id = any (v_leads);
    -- What else holds their details: emails matched to them, what forms and chats took in, automations' and the
    -- AI's runs about them, where they came from, and their jobs.
    delete from app.email_inbound_unmatched u where u.resolved_person_id = v_person.id;
    delete from app.intake_submissions s where s.person_id = v_person.id;
    delete from app.chat_visitors v where v.person_id = v_person.id or v.verified_person_id = v_person.id;
    delete from app.attribution_touches t where t.person_id = v_person.id;
    delete from app.workflow_runs w where w.person_id = v_person.id;
    delete from app.ai_teammate_runs w where w.person_id = v_person.id;
    delete from app.ai_teammate_drafts d where d.person_id = v_person.id;
    delete from app.attention_items i where i.person_id = v_person.id;
    delete from app.jobs j where j.person_id = v_person.id;
    delete from app.record_tags t where t.record_type = 'person' and t.record_id = v_person.id;

    -- Their bills stay, with just their name (the owner's decision 4): on a record of their name alone.
    if exists (select 1 from app.invoices i where i.person_id = v_person.id)
       or exists (select 1 from app.estimates e where e.person_id = v_person.id)
       or exists (select 1 from app.subscriptions s where s.person_id = v_person.id) then
      insert into app.people (workspace_id, first_name, last_name, archived_at, erased_at)
      values (p_ws, v_person.first_name, v_person.last_name, now(), now())
      returning id into v_keeper;
      insert into private.person_merges (from_person_id, into_person_id, workspace_id)
      values (v_person.id, v_keeper, p_ws);
      update app.invoices i set person_id = v_keeper where i.person_id = v_person.id;
      update app.estimates e set person_id = v_keeper where e.person_id = v_person.id;
      update app.subscriptions s set person_id = v_keeper where s.person_id = v_person.id;
      delete from private.person_merges m where m.from_person_id = v_person.id;
    end if;

    perform private.bin_redact(p_ws, 'person', array[v_person.id]);
    -- The rest of what hangs off them (their portal, add-ons' rows about them, reminders, referrals they made)
    -- goes with them, and what only mentions them lets go.
    delete from app.people p where p.id = v_person.id;
    delete from private.bin_work w where w.workspace_id = p_ws;
    return jsonb_build_object('more', true, 'objects', v_objects);
  end if;

  -- 3. Done: the item itself.
  delete from app.bin_items b where b.id = p_item;
  delete from private.bin_work w where w.workspace_id = p_ws;
  return jsonb_build_object('more', false, 'objects', '[]'::jsonb);
end $$;
revoke all on function private.purge_bin_batch(uuid, uuid, integer) from public;
grant execute on function private.purge_bin_batch(uuid, uuid, integer) to service_actor;

-- ---------- what reads past row-level security ----------
-- A booking's manage page, a reply to a thread's email, the website chat's feed, a customer's portal and stored
-- files: none of them reach what's in the bin. Each is its last migration's, with the bin added.
create or replace function private.booking_manage_lookup(p_ref text)
returns table (attendee_id uuid, workspace_id uuid, organization_id uuid, manage_version integer)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id, a.manage_version
  from app.appointment_attendees a
  join app.workspaces w on w.id = a.workspace_id
  where p_ref ~ '^[0-9A-Za-z]{8}$' and a.public_ref = p_ref and a.bin_item_id is null
$$;

create or replace function private.conversation_by_reply_token(p_token text)
returns table (conversation_id uuid, workspace_id uuid, organization_id uuid, email_address_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id, c.email_address_id
  from app.conversations c join app.workspaces w on w.id = c.workspace_id
  where c.email_reply_token = lower(p_token) and c.bin_item_id is null
$$;

create or replace function private.chat_feed(p_since timestamptz)
returns table (kind text, conversation_id uuid, message_id uuid, direction app.direction, body text, sender text,
  sender_name text, occurred_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.* from (
    select 'message'::text, m.conversation_id, m.id, m.direction, m.body_text,
      case when m.direction = 'inbound' then 'visitor' when m.sent_by_teammate_id is not null then 'teammate' else 'person' end,
      case when m.sent_by_teammate_id is not null then t.name
        when m.direction = 'outbound' then nullif(split_part(btrim(u.full_name), ' ', 1), '') end,
      m.created_at
    from app.messages m
    left join app.ai_teammates t on t.id = m.sent_by_teammate_id
    left join app.users u on u.id = m.sent_by
    where m.channel = 'chat' and m.created_at > greatest(p_since, now() - interval '5 minutes')
      and m.status not in ('failed', 'undelivered') and m.bin_item_id is null
    union all
    select s.kind, s.conversation_id, null::uuid, null::app.direction, null::text, 'teammate', null::text, s.signaled_at
    from app.chat_signals s
    where s.signaled_at > greatest(p_since, now() - interval '5 minutes') and s.expires_at > now()
  ) as f (kind, conversation_id, message_id, direction, body, sender, sender_name, occurred_at)
  order by f.occurred_at
  limit 1000
$$;

create or replace function portal.record_people()
returns table (record_id uuid, person_id uuid, first_name text)
language sql stable security definer set search_path = '' as $$
  select rel.b_custom_record_id, p.id, p.first_name from app.relationships rel
  join app.relationship_types t on t.id = rel.type_id and t.portal_visible
  join app.people p on p.id = rel.a_person_id
  where rel.b_custom_record_id in (select portal.records()) and rel.bin_item_id is null and p.bin_item_id is null
  union
  select rel.a_custom_record_id, p.id, p.first_name from app.relationships rel
  join app.relationship_types t on t.id = rel.type_id and t.portal_visible
  join app.people p on p.id = rel.b_person_id
  where rel.a_custom_record_id in (select portal.records()) and rel.bin_item_id is null and p.bin_item_id is null
$$;

-- A customer's portal link is off while they're in the bin (20261018000700's, with the bin added): the sign-in
-- page says so and sends no code. Emptying the bin takes the link with them.
create or replace function private.portal_link_lookup(p_ref text)
returns table (access_id uuid, workspace_id uuid, organization_id uuid, person_id uuid, link_version integer,
  revoked boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id, a.person_id, a.link_version,
    a.revoked_at is not null or p.bin_item_id is not null or p.erased_at is not null
  from app.portal_access a
  join app.workspaces w on w.id = a.workspace_id
  join app.people p on p.id = a.person_id
  where a.public_ref = p_ref
$$;

-- Old spam goes after 30 days, but not what's in the bin: the bin keeps its own 30 days.
create or replace function private.delete_old_spam(p_before timestamptz, p_limit integer)
returns table (conversation_id uuid, workspace_id uuid, media jsonb)
language sql security definer set search_path = '' as $$
  with gone as (
    delete from app.conversations c
    where c.id in (
      select s.id from app.conversations s
      where s.folder = 'spam' and coalesce(s.last_message_at, s.created_at) < p_before and s.bin_item_id is null
      order by s.last_message_at nulls first
      limit p_limit
    )
    returning c.id, c.workspace_id
  )
  select g.id, g.workspace_id,
    coalesce((select jsonb_agg(f) from app.messages m, jsonb_array_elements(m.media) f
      where m.conversation_id = g.id), '[]'::jsonb)
  from gone g
$$;

create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.bin_item_id is null
        and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'telephony' then
      coalesce(private.path_workspace(p_name) in (select private.accessible_workspace_ids()), false)
      and (not private.inbox_narrowed(private.path_workspace(p_name))
        or exists (
          select 1 from app.calls c
          where c.workspace_id = private.path_workspace(p_name)
            and c.member_viewer_ids @> array[(select auth.uid())]
            and (c.recording_object_path = p_name
              or (split_part(p_name, '/', 2) = 'calls'
                and c.id = case when split_part(p_name, '/', 3)
                    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(p_name, '/', 3)::uuid end)))
        or exists (
          select 1 from app.messages m
          where m.workspace_id = private.path_workspace(p_name)
            and m.member_viewer_ids @> array[(select auth.uid())]
            and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
              or (split_part(p_name, '/', 2) = 'messages'
                and m.id = case when split_part(p_name, '/', 3)
                    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(p_name, '/', 3)::uuid end))))
      and not exists (
        select 1 from app.messages m
        where m.private_to is not null and m.private_to <> (select auth.uid())
          and m.workspace_id = private.path_workspace(p_name)
          and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
            or (split_part(p_name, '/', 2) = 'messages'
              and m.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
      -- Nothing a message or a call in the bin carried.
      and not exists (
        select 1 from app.messages m
        where m.bin_item_id is not null and m.workspace_id = private.path_workspace(p_name)
          and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
            or (split_part(p_name, '/', 2) = 'messages'
              and m.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
      and not exists (
        select 1 from app.calls c
        where c.bin_item_id is not null and c.workspace_id = private.path_workspace(p_name)
          and (c.recording_object_path = p_name
            or (split_part(p_name, '/', 2) = 'calls'
              and c.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end
$$;
