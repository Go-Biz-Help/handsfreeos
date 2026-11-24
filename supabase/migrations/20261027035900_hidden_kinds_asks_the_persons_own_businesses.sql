-- =============================================================================
-- The kinds of records hidden from a person are looked for in their own
-- businesses (speed audit, Nov 2026).
--        - An add-on's kinds of records are hidden wherever the add-on isn't
--          running. private.hidden_record_kinds() says which, and the read
--          policy of app.custom_records asks it: once a statement, for every
--          statement by a signed-in person that reads a record (a deal, a job,
--          a social post), and again inside private.custom_record_visible() for
--          each relationship such a statement reads.
--        - It read every add-on's kinds on the whole platform to answer, and
--          asked private.running_addons() about each one, before looking at
--          whose business the kind was in: `workspace_id in (select …)` is
--          joined after the table is read. So the more businesses turn an
--          add-on on, the slower every record is to read for everybody, add-on
--          or not: about 17 millionths of a second for each kind there is.
--          Today that's 3 kinds. With 186 (the local test database) it was
--          2.8 ms each time it was asked, and 110 of the 190 ms of database
--          time that opening one Real Estate listing took.
--        - Here the person's businesses are found first and their kinds looked
--          up by index (custom_record_types_addon_idx), as
--          private.private_kinds_seen_whole() beside it already does: 0.06 ms.
--          The answer is the same (compared for each of the 2,094 people in
--          the local test database).
--        - Replaces one function, same name, arguments and grants. Nothing is
--          added or dropped, so it can go on before the code or after.
-- =============================================================================

create or replace function private.hidden_record_kinds()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select t.id from app.custom_record_types t
  where t.addon_id is not null
    and t.workspace_id = any (array(select private.accessible_workspace_ids()))
    and not (t.addon_id = any (private.running_addons(t.workspace_id)));
end
$$;
