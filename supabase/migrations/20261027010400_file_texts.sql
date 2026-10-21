-- =============================================================================
-- Search everything, stage 5: words inside files
-- (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The database", Migration B).
--
--        The worker reads the words of text PDFs, plain text, CSV, Word and
--        Excel files, with no AI and no cost, and keeps them here, one row a
--        file, so search finds a file by what it says as well as its name.
--        A file's words are read exactly when the file could be opened, and
--        follow it: hidden while it's in the Deleted bin, back when it comes
--        back, gone when it's deleted for good. Port papers and knowledge
--        files are never read.
--
--        `words` is the text split as core splits a search for it
--        (`searchWords`, packages/core/src/search/probes.ts), so "1042",
--        "0142", "smith" and "gulfcoastrealty" match inside a file as they
--        do in a message or on a contact.
--
-- Only adds: two functions a person may call, a table nothing publishes, and
-- the worker's triggers and finder. No column on a published table, so
-- PowerSync copies nothing again.
-- =============================================================================

-- The words of a text as core splits them for a search (search/probes.ts, `searchWords`): folded, every run of
-- anything that isn't a letter or a digit made one space, and a run of digits without its leading zeros. So
-- "INV-001042", "(504) 555-0142", "dana.smith@gmail.com" and "www.gulfcoastrealty.com" give 1042; 504 555 142;
-- dana smith gmail com; www gulfcoastrealty com. regexp_replace is immutable, so a stored column may use it.
create or replace function private.search_words(p text) returns text
  language sql immutable parallel safe set search_path = '' as $$
    select regexp_replace(regexp_replace(private.search_fold(p), '[^[:alnum:]]+', ' ', 'g'),
                          '(^| )0+([0-9])', '\1\2', 'g') $$;
comment on function private.search_words(text) is
  'A text''s words as core''s searchWords() in packages/core/src/search/probes.ts splits them: folded, anything '
  'that isn''t a letter or a digit one space, digits without leading zeros.';
revoke all on function private.search_words(text) from public;
grant execute on function private.search_words(text) to authenticated, service_actor;

create table app.file_texts (
  file_id uuid primary key references app.files (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  state text not null check (state in ('done', 'truncated', 'no_text', 'unsupported', 'too_large', 'unreadable')),
  text text not null default '' check (char_length(text) <= 100000),
  -- Where each page (PDF) or sheet (Excel) starts in `text`, counted in characters from 0, so a hit can say "page 3".
  pages integer[] not null default '{}' check (cardinality(pages) <= 2000),
  chars integer not null default 0 check (chars between 0 and 100000),
  -- The reader's version: a better reader reads older rows again through the sweep.
  reader smallint not null check (reader between 1 and 100),
  extracted_at timestamptz not null default now(),
  -- The words, without positions. Stored, because this table is never published.
  words tsvector generated always as (strip(to_tsvector('simple'::regconfig, private.search_words(text)))) stored
);
comment on table app.file_texts is
  'The words the worker read inside a file (Search 5), for search. Read exactly when the file could be opened; '
  'never port papers or knowledge files; never published to phones.';
-- Search's window of the files read most recently (SEARCH_WINDOWS.fileWords): only rows holding words, so a business's
-- photos and voice notes, each a row with none, never take a document's place in it. The searcher repeats `chars > 0`
-- word for word (WITH_WORDS, packages/core/src/search/server/kinds/files.ts), so the planner uses this.
create index file_texts_recent_idx on app.file_texts (workspace_id, extracted_at desc) where chars > 0;

-- The same business as its file (the appointment_transcripts pattern, 20261027003400).
create function private.check_file_text_refs() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from app.files f where f.id = new.file_id and f.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514',
      detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
revoke all on function private.check_file_text_refs() from public;
create trigger file_texts_check_refs before insert or update on app.file_texts
  for each row execute function private.check_file_text_refs();

alter table app.file_texts enable row level security;
-- A file's words are read exactly when the file could be opened: the inner read brings files_select (sealed) and
-- files_not_binned with it, and the rest copies the storage read rule (20261027000400), with port papers and
-- knowledge files never, and a hidden add-on kind's records never (custom_record_visible). Tied to the row, as
-- form_answers_follow_response is (20261027010300), so reading a business's words probes their files by key
-- instead of reading every file the person can see first.
create policy file_texts_select on app.file_texts for select to authenticated using (
  workspace_id in (select private.accessible_workspace_ids())
  and exists (
    select 1 from app.files f
    where f.id = file_texts.file_id
      and f.status = 'ready' and f.deleted_at is null
      and f.record_type not in ('port', 'knowledge')
      and (f.record_type <> 'custom_record' or private.custom_record_visible(f.record_id))));
create policy file_texts_service_all on app.file_texts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.file_texts to authenticated;
grant select, insert, update, delete on app.file_texts to service_actor;
revoke all on app.file_texts from anon;

-- Deleting a file for good forgets its words, whoever deletes it: file.delete is a person's command, and a person
-- may only read file_texts. Putting it in the bin sets bin_item_id in the same statement (20261027000400), so this
-- doesn't fire, the words stay hidden, and Bring back shows them again.
create function private.forget_file_text() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from app.file_texts t where t.file_id = new.id;
  return new;
end $$;
revoke all on function private.forget_file_text() from public;
create trigger files_forget_text after update of deleted_at on app.files for each row
  when (old.deleted_at is null and new.deleted_at is not null and new.bin_item_id is null)
  execute function private.forget_file_text();

-- The worker's catch-up, across businesses, as private.bin_due is: files with no words yet, or read by an older
-- reader. Never one deleted, in the bin or still uploading, so a file whose read found it gone isn't asked for again;
-- and not in its first five minutes, while file.attached reads it.
create function private.files_without_text(p_limit integer, p_reader smallint)
returns table (file_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select f.id, f.workspace_id, w.organization_id
  from app.files f
  join app.workspaces w on w.id = f.workspace_id
  left join app.file_texts t on t.file_id = f.id
  where f.status = 'ready' and f.deleted_at is null and f.bin_item_id is null
    and f.record_type not in ('knowledge', 'port')
    and f.created_at < now() - interval '5 minutes'
    and (t.file_id is null or t.reader < p_reader)
  order by f.created_at
  limit greatest(1, least(coalesce(p_limit, 100), 500))
$$;
revoke all on function private.files_without_text(integer, smallint) from public;
grant execute on function private.files_without_text(integer, smallint) to service_actor;
