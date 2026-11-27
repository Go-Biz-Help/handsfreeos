-- =============================================================================
-- Receipts and expenses, b (the owner, 25 Nov 2026: "Receipts and expenses: I
-- snap a receipt, it gets filed, and each month I see money in and money out").
--
--        - app.expenses: what the business spent, one row a purchase: the day,
--          the amount (and the tax in it, when the receipt says), who it was
--          paid to, a category, how it was paid and a note. Money → Expenses
--          on the web and the phone, and the Assistant from a photo of a
--          receipt (on a Confirm card).
--        - Only whoever manages money (money.manage) sees or changes them: what
--          the business spends, like everything it is owed, is the whole
--          business's money. A member's role never reaches them.
--        - A receipt is a file whose record is its expense (record type
--          `expense`, 20261027036700): reserved by expense.begin_receipt_upload,
--          uploaded straight to Storage and confirmed like any file, and read
--          and uploaded only by whoever manages money. Nothing tags it, no
--          timeline hears of it, and search leaves it out.
--        - Removing an expense marks it deleted (`deleted_at`) and deletes its
--          receipt; nothing reads a deleted one again.
--
-- Only widens.
-- =============================================================================

-- ---------- what the business spent ----------
create table app.expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The day on the receipt, in the business's own calendar.
  spent_on date not null,
  -- The whole amount paid, tax and tip in it.
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  -- The tax in that amount, when the receipt says.
  tax_cents bigint check (tax_cents is null or (tax_cents >= 0 and tax_cents <= amount_cents)),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  -- Who it was paid to: the store, the supplier, the person.
  vendor text not null check (char_length(btrim(vendor)) between 1 and 120),
  -- core's EXPENSE_CATEGORIES (money/expenses.ts).
  category text not null check (category ~ '^[a-z_]{1,40}$'),
  -- core's EXPENSE_PAID_WITH: card, cash, check, bank or other.
  paid_with text check (paid_with is null or paid_with ~ '^[a-z_]{1,20}$'),
  note text check (note is null or char_length(note) <= 1000),
  -- Typed on a screen, or read off a receipt by the Assistant and confirmed.
  source text not null default 'person' check (source in ('person', 'assistant')),
  created_by uuid references app.users (id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table app.expenses is
  'What the business spent, a purchase a row, with its receipt as a file (record type expense). Only for whoever manages money.';
create index expenses_by_day_idx on app.expenses (workspace_id, spent_on desc, created_at desc, id desc)
  where deleted_at is null;
create trigger expenses_updated_at before update on app.expenses
  for each row execute function private.set_updated_at();
create trigger expenses_immutable before update on app.expenses
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by', 'source');

alter table app.expenses enable row level security;
create policy expenses_select on app.expenses for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
create policy expenses_insert on app.expenses for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid())
    and deleted_at is null);
create policy expenses_update on app.expenses for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy expenses_service_all on app.expenses for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert on app.expenses to authenticated;
grant update (spent_on, amount_cents, tax_cents, vendor, category, paid_with, note, deleted_at, deleted_by)
  on app.expenses to authenticated;
grant select, insert, update, delete on app.expenses to service_actor;
revoke all on app.expenses from anon;

-- ---------- a receipt: a file on its expense, only for whoever manages money ----------
-- A receipt has nothing to tag.
alter table app.record_tags
  add constraint record_tags_not_expense check (record_type <> 'expense');

drop policy files_select on app.files;
create policy files_select on app.files for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and (not sealed or private.custom_record_visible(record_id))
         and (record_type <> 'expense'::app.record_type or private.has_permission(workspace_id, 'money.manage')));
drop policy files_insert on app.files;
create policy files_insert on app.files for insert to authenticated
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        when 'form'::app.record_type then 'forms.manage'
        when 'expense'::app.record_type then 'money.manage'
        else 'records.write'
      end)
    and created_by = (select auth.uid()) and status = 'pending'::app.file_status and deleted_at is null
    and (not sealed or private.custom_record_visible(record_id)));
drop policy files_update on app.files;
create policy files_update on app.files for update to authenticated
  using (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        when 'form'::app.record_type then 'forms.manage'
        when 'expense'::app.record_type then 'money.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)))
  with check (
    private.has_permission(workspace_id,
      case record_type
        when 'knowledge'::app.record_type then 'knowledge.manage'
        when 'port'::app.record_type then 'channels.manage'
        when 'document'::app.record_type then 'documents.manage'
        when 'form'::app.record_type then 'forms.manage'
        when 'expense'::app.record_type then 'money.manage'
        else 'records.write'
      end)
    and (not sealed or private.custom_record_visible(record_id)));

-- Carried over from 20261027035400 with one more clause: a receipt is uploaded by someone who manages money.
create or replace function private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'pending' and f.deleted_at is null
        and f.created_by = auth.uid() and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'knowledge' or private.has_permission(f.workspace_id, 'knowledge.manage'))
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (f.record_type <> 'document' or private.has_permission(f.workspace_id, 'documents.manage'))
        and (f.record_type <> 'form' or private.has_permission(f.workspace_id, 'forms.manage'))
        and (f.record_type <> 'expense' or private.has_permission(f.workspace_id, 'money.manage'))
        and (not f.sealed or private.custom_record_visible(f.record_id)))
    when 'imports' then exists (
      select 1 from app.imports i
      where i.object_path = p_name and i.status = 'pending'
        and i.created_by = auth.uid() and i.workspace_id in (select private.accessible_workspace_ids()))
    when 'brand-uploads' then exists (
      select 1 from app.workspaces w
      where w.id = private.path_workspace(p_name)
        and w.settings -> 'look' -> 'upload' ->> 'path' = p_name
        and w.settings -> 'look' -> 'upload' ->> 'by' = (select auth.uid())::text
        and coalesce(w.settings -> 'look' -> 'upload' ->> 'sent', 'false') = 'false'
        and private.has_permission(w.id, 'workspace.update'))
    else false
  end;
end
$$;

-- Carried over from 20261027035400 with one more clause: a receipt is read by someone who manages money.
create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.bin_item_id is null
        and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage'))
        and (f.record_type <> 'expense' or private.has_permission(f.workspace_id, 'money.manage'))
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
  end;
end
$$;
