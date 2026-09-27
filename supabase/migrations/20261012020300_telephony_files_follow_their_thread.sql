-- =============================================================================
-- A recording, a texted photo or a mail attachment follows its thread (SEC-M4).
--
--        The `telephony` bucket answered "can this person open the business?"
--        and nothing else, so 0083's narrowed member — who cannot read a call
--        or a message on a thread that is not theirs — could still list
--        `<business>/calls/` and play every recording and voicemail, open every
--        picture message and every mail attachment, straight from Storage with
--        their own sign-in. The rows were narrowed; the files they point at
--        were not.
--
--        Now a file in it reads exactly as the row it belongs to reads:
--
--          not narrowed  as before — anyone who can open the business, which
--                        is who can read its calls and messages
--          narrowed      a call or a message on one of their threads that is
--                        this file: its own folder (`calls/<call>/…`,
--                        `messages/<message>/…`) or the path it keeps
--                        (`recording_object_path`, a message's `media`, which is
--                        how a mail attachment's `email/<hash>/…` is found and
--                        how an imported copy shared by two records is)
--
--        No new rule: the same member_viewer_ids test as the policies on
--        app.calls and app.messages, written out because this function runs as
--        its owner and so reads past RLS. The lookups key on a primary key or on
--        the member's own list (its GIN index), and only run for a narrowed
--        member; everybody else pays what they paid before.
--
--        All four buckets in one place, as before: `attachments` and
--        `migrations` are port_papers' (20261001000600), carried over unchanged.
-- =============================================================================

create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage')))
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
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end
$$;
