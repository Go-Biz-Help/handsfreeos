-- =============================================================================
-- A signed file is kept (Real Estate, step 3).
--
--        Anyone who could write a customer's records could delete any file
--        on them, and nothing recorded what a file held when it arrived. A
--        signed contract or disclosure has to outlast every mistake, so
--        Chris decided (2026-09-30) that a signed document is never deleted,
--        only replaced by a newer version marked as the one that counts.
--
--        **A lock.** `file.lock` sets locked_at, locked_by, locked_reason
--        (signed, final or record) and, when an add-on asked for it,
--        locked_by_addon. From then on nobody deletes the file, marks it
--        deleted, renames it, changes what it is, or unlocks it: not an
--        owner, not the worker. Deleting the whole business still removes
--        it (private.purging_workspace), and merging two customers still
--        moves it to the one kept. A lock outlasts the add-on that set it:
--        deleting an add-on's data leaves the client's signed papers locked
--        on the client's record.
--
--        **A fingerprint.** The worker records every file's SHA-256 when it
--        arrives (sha256, hashed_at), once, and nobody else writes it. What a
--        locked file held can always be checked against what is stored.
--
--        Storage needs nothing new: people already can't delete objects
--        (20260912000400), and the worker removes an object only after its
--        row was marked deleted, which a lock now refuses.
-- =============================================================================

alter table app.files
  add column locked_at timestamptz,
  add column locked_by uuid references app.users (id) on delete set null,
  add column locked_reason text check (locked_reason in ('signed', 'final', 'record')),
  add column locked_by_addon text check (locked_by_addon ~ '^[a-z]{2,16}$'),
  add column sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column hashed_at timestamptz,
  add constraint files_lock_whole check ((locked_at is null) = (locked_reason is null)),
  add constraint files_hash_whole check ((sha256 is null) = (hashed_at is null));

create index files_locked_by_idx on app.files (locked_by) where locked_by is not null;

comment on column app.files.locked_at is
  'When the file was locked (a signed document, Real Estate step 3). A locked file is never deleted, renamed or unlocked, except when the whole business is deleted.';
comment on column app.files.sha256 is
  'The SHA-256 of the stored object, recorded once by the worker when the file arrived.';

create or replace function private.guard_locked_file()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.locked_at is not null and not private.purging_workspace(old.workspace_id) then
      raise exception '% is signed and kept, so it can''t be deleted', old.name
        using errcode = '42501', detail = 'file_locked';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.locked_at is not null or new.sha256 is not null then
      raise exception 'A file is locked and fingerprinted after it arrives, not as it is added'
        using errcode = '42501', detail = 'file_lock_is_later';
    end if;
    return new;
  end if;

  -- A locked file keeps what it is. Only where it hangs (a customer merged into another) and its fingerprint's
  -- first recording may change.
  if old.locked_at is not null and (
       new.locked_at is distinct from old.locked_at
       or new.locked_by is distinct from old.locked_by
       or new.locked_reason is distinct from old.locked_reason
       or new.locked_by_addon is distinct from old.locked_by_addon
       or new.deleted_at is distinct from old.deleted_at
       or new.name is distinct from old.name
       or new.status is distinct from old.status
       or new.mime_type is distinct from old.mime_type
       or new.size_bytes is distinct from old.size_bytes) then
    raise exception '% is signed and kept, so it can''t be changed or deleted', old.name
      using errcode = '42501', detail = 'file_locked';
  end if;

  if old.locked_at is null and new.locked_at is not null
     and (new.status <> 'ready' or new.deleted_at is not null) then
    raise exception 'Only a file that finished uploading can be locked'
      using errcode = '23514', detail = 'file_not_ready';
  end if;

  if new.sha256 is distinct from old.sha256 or new.hashed_at is distinct from old.hashed_at then
    if old.sha256 is not null or current_user = 'authenticated' then
      raise exception 'A file''s fingerprint is recorded once, by HandsFreeOS'
        using errcode = '42501', detail = 'file_hash_is_ours';
    end if;
  end if;
  return new;
end $$;

create trigger files_locked_guard before insert or update or delete on app.files
  for each row execute function private.guard_locked_file();
