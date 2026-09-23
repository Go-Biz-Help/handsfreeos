-- =============================================================================
-- 0095 · Room for two hundred fields.
--
--        A business keeps up to 200 custom fields per kind of record, up from
--        50. Fifty was a guess about the businesses we would meet, and the
--        first real GoHighLevel account had 163 customer fields, 103 of them
--        holding answers. At 50, the rest could only come across as lines in
--        the notes, which nobody can sort, filter or fill in again.
--
--        **The values get room too.** A record's answers travel inside it, in
--        `custom`, capped at 16 KB. That was sized for fifty short answers;
--        two hundred, with a few long ones among them, would hit it and be
--        refused. The cap goes to 64 KB, measured the same way (stored size,
--        after compression), for customers, companies and leads alike.
--
--        Still a wall, not a wish: the count is checked at commit exactly as
--        before, and only the number changes.
-- =============================================================================

create or replace function private.custom_field_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from app.custom_fields f
  where f.workspace_id = new.workspace_id and f.entity = new.entity and f.archived_at is null;
  if v_count > 200 then
    raise exception 'That is as many fields as a record can carry (200)'
      using errcode = '23514', detail = 'too_many_custom_fields';
  end if;
  return null;
end $$;

alter table app.people drop constraint people_custom_check,
  add constraint people_custom_check
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 65536);
alter table app.companies drop constraint companies_custom_check,
  add constraint companies_custom_check
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 65536);
alter table app.leads drop constraint leads_custom_check,
  add constraint leads_custom_check
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 65536);
