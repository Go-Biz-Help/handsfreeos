-- =============================================================================
-- 0098 · Retiring several fields at once.
--
--        Archiving a custom field takes its value off every record that has
--        one (`private.clear_retired_custom_field`), and every write to a
--        record's values is checked against the fields that are still live
--        (`private.check_custom_values`). Each was right alone, and together
--        they could not retire two fields in one statement: taking the first
--        value off a customer re-checked the customer's *other* values, one
--        of which belonged to the second field — archived by the same
--        statement a moment earlier — and the whole thing was refused with
--        "There is no field … on this record".
--
--        Taking a migration back archives every field it made in one
--        statement, so any customer holding two imported values stopped the
--        rollback dead, six times over, and the move could then be neither
--        finished nor deleted.
--
--        **What is checked now is what is being written.** A value that is
--        new on the record, or changed, must belong to a live field, exactly
--        as before. A value that was already there and is untouched was
--        checked when it was written; carrying it through an unrelated change
--        — or through the change that is about to remove it — is not a new
--        claim about anything.
-- =============================================================================

create or replace function private.check_custom_values()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_entity app.custom_field_entity := tg_argv[0]::app.custom_field_entity;
  v_stray text;
begin
  if new.custom = '{}'::jsonb or (tg_op = 'UPDATE' and new.custom = old.custom) then
    return new;
  end if;
  select e.key into v_stray from jsonb_each(new.custom) as e
  where (tg_op = 'INSERT' or not (old.custom ? e.key) or old.custom -> e.key is distinct from e.value)
    and not exists (
      select 1 from app.custom_fields f
      where f.workspace_id = new.workspace_id and f.entity = v_entity and f.archived_at is null
        and f.id::text = e.key)
  limit 1;
  if v_stray is not null then
    raise exception 'There is no field % on this record', v_stray
      using errcode = '23514', detail = 'unknown_custom_field';
  end if;
  return new;
end $$;
