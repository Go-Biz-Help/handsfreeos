-- =============================================================================
-- Other mail and Spam (M19, step 2).
--
--        A business's inbox has held customer mail only. A stranger became a
--        lead or waited under "Mail from people not in Contacts", and
--        newsletters, receipts and auto-replies were dropped before anyone
--        saw them. Once a business receives all of its domain's mail (step
--        1), that loses mail, and nothing may be lost (Chris, 2026-09-29).
--
--        So a thread now has a folder. Customer mail stays in the Inbox as it
--        always has. Mail from a stranger that lead intake doesn't take, and
--        a stranger's automatic mail, goes to Other mail. What Postmark's
--        filter scores as spam goes to Spam, and is deleted after 30 days.
--        Only Inbox threads wake anything up: the AI teammate, workflows,
--        push, the Action Center and the timeline hear nothing from the
--        other two until a person moves a thread into the Inbox.
--
--        A thread keeps its folder: new mail in it doesn't move it; people
--        do. A sender rule remembers where someone put a sender's mail, so
--        the next new thread from them goes there too.
-- =============================================================================

create type app.conversation_folder as enum ('inbox', 'other', 'spam');

alter table app.conversations
  add column folder app.conversation_folder not null default 'inbox';

comment on column app.conversations.folder is
  'Where the thread lives: the Inbox, Other mail (strangers and automatic mail) or Spam. Set when the thread starts; only people move it.';

-- Other mail and Spam are read a folder at a time; the Inbox keeps using the indexes it has.
create index conversations_folder_idx on app.conversations (workspace_id, folder, last_message_at desc)
  where folder <> 'inbox';

-- ---------- where a sender's mail goes ----------
create table app.email_sender_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  address text not null
    check (address = lower(address) and position('@' in address) > 1 and length(address) <= 320),
  folder app.conversation_folder not null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_sender_rules_one_per_sender unique (workspace_id, address)
);

comment on table app.email_sender_rules is
  'Where new mail from a sender goes, as a person chose when they moved one of that sender''s threads.';

create trigger email_sender_rules_updated_at before update on app.email_sender_rules
  for each row execute function private.set_updated_at();
create trigger email_sender_rules_immutable before update on app.email_sender_rules
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'address', 'created_by');

-- The same people who move threads: anyone who uses the inbox.
alter table app.email_sender_rules enable row level security;

create policy email_sender_rules_select on app.email_sender_rules for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy email_sender_rules_insert on app.email_sender_rules for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid()));
create policy email_sender_rules_update on app.email_sender_rules for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy email_sender_rules_delete on app.email_sender_rules for delete to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'));
create policy email_sender_rules_service_all on app.email_sender_rules for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.email_sender_rules from public, anon;
grant select, insert, update, delete on app.email_sender_rules to authenticated, service_actor;

-- ---------- Spam is kept 30 days ----------
-- Every business's spam older than the cut-off, a batch at a time, with the files its messages carried so the
-- worker can remove them from storage. Its messages go with it (on delete cascade). Nobody else deletes
-- threads, so this is a function rather than a grant.
create or replace function private.delete_old_spam(p_before timestamptz, p_limit int)
returns table (conversation_id uuid, workspace_id uuid, media jsonb)
language sql security definer set search_path = '' as $$
  with gone as (
    delete from app.conversations c
    where c.id in (
      select s.id from app.conversations s
      where s.folder = 'spam' and coalesce(s.last_message_at, s.created_at) < p_before
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

revoke all on function private.delete_old_spam(timestamptz, int) from public;
grant execute on function private.delete_old_spam(timestamptz, int) to service_actor;
