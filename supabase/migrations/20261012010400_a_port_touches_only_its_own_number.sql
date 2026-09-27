-- =============================================================================
-- A port claims and releases only its own business's number.
--
--        `number_ports_insert` asked only for `channels.manage`, so a row
--        could be written with a `phone_number_id` already filled in — any
--        business's number — and then `private.port_release_number` (security
--        definer) set that number to `released` by id alone, and
--        `private.port_claim_number` would set it to `porting`. The commands
--        never do this (`number_port.start` writes a draft and nothing else),
--        so it is the backstop that was missing.
--
--        Two halves, either of which closes it:
--          - a person inserts only a fresh draft: no number, nothing the
--            carrier said, nothing the worker stamps — the same line
--            `private.guard_number_port_update` already draws for updates;
--          - both functions touch a number only in the port's own business.
-- =============================================================================

drop policy if exists number_ports_insert on app.number_ports;
create policy number_ports_insert on app.number_ports for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage')
    and status = 'draft' and phone_number_id is null and account_id is null
    and provider_sid is null and provider_status is null and rejection_reason is null
    and last_error is null and next_poll_at is null and poll_count = 0 and scheduled_for is null
    and submitted_at is null and carrier_submitted_at is null and completed_at is null);

-- Unchanged apart from reading the port's number only when it is in the port's business, and
-- `workspace_id = v_ws` on each write to app.phone_numbers.
create or replace function private.port_claim_number(p_port uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_e164 text;
  v_by uuid;
  v_held uuid;
  v_number uuid;
  v_prev text := current_setting('app.system_scope.workspace_id', true);
begin
  -- The number the port points at counts only when it is this business's own.
  select p.workspace_id, p.e164, p.created_by, n.id
    into v_ws, v_e164, v_by, v_held
    from app.number_ports p
    left join app.phone_numbers n on n.id = p.phone_number_id and n.workspace_id = p.workspace_id
    where p.id = p_port;
  if v_ws is null then
    raise exception 'No port with that id' using errcode = '23503', detail = 'no_number_port';
  end if;
  if not (coalesce(private.system_scope_workspace() = v_ws, false)
          or private.has_permission(v_ws, 'channels.manage')) then
    raise exception 'You cannot move this business''s numbers'
      using errcode = '42501', detail = 'number_port_not_yours';
  end if;

  -- Somebody else is already moving it. This function can see across businesses where the person calling it
  -- cannot, so it says so plainly rather than letting the insert below fail on phone_numbers_live_e164 and
  -- reach a business as "That already exists."
  if exists (select 1 from app.phone_numbers n
             where n.e164 = v_e164 and n.workspace_id <> v_ws
               and n.status in ('provisioning', 'porting', 'active', 'releasing')) then
    raise exception 'That number is already with another business'
      using errcode = '23505', detail = 'number_already_moving';
  end if;

  perform set_config('app.system_scope.workspace_id', v_ws::text, true);

  -- The port's own row first, then any row this business already has for the number: a port that was turned
  -- down and is being sent again re-takes the same row rather than leaving a released one behind it.
  --
  -- **Ordered, because a business can hold several rows for one e164** — every release-and-re-port leaves
  -- one behind. `limit 1` with no order picks whatever the plan hands back, and picking a released row while
  -- a live sibling exists collides with phone_numbers_live_e164 the moment it is set to `porting`.
  if v_held is null then
    select n.id into v_held from app.phone_numbers n
      where n.workspace_id = v_ws and n.e164 = v_e164
      order by (n.status in ('porting', 'active')) desc, n.created_at desc
      limit 1;
  end if;

  if v_held is null then
    -- Local unless the carrier says otherwise when it lands. Toll-free ports are rare and get corrected
    -- then; guessing toll-free here would send the wrong registration chain.
    insert into app.phone_numbers (workspace_id, e164, number_type, status, created_by)
    values (v_ws, v_e164, 'local', 'porting', v_by)
    returning id into v_number;
  else
    /*
     * **Never demotes a working number.** `private.phone_route()` only answers for an `active` number, so
     * moving one to `porting` takes it off routing outright: every call and text to it would reach nobody.
     * A business that already holds the number and starts a second port for it would do exactly that, and
     * so would `number_port.complete` if it ever ran twice. A number that is already theirs and already
     * working needs no claiming — it is claimed.
     */
    update app.phone_numbers set status = 'porting', released_at = null
      where id = v_held and workspace_id = v_ws and status <> 'active';
    v_number := v_held;
  end if;

  if v_number is null then
    raise exception 'That number could not be claimed' using errcode = '23503', detail = 'no_number_port';
  end if;

  update app.number_ports set phone_number_id = v_number where id = p_port;

  perform set_config('app.system_scope.workspace_id', coalesce(v_prev, ''), true);
  return v_number;
end $$;

-- Let the number go again. A port that is off — called off, turned down, failed — must not keep another
-- business from trying for the same number, and must not keep counting against this one's ceiling. The port
-- keeps pointing at the row: a business that tried to move a number should be able to see that it tried.
create or replace function private.port_release_number(p_port uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_number uuid;
  v_prev text := current_setting('app.system_scope.workspace_id', true);
begin
  select p.workspace_id, n.id into v_ws, v_number
    from app.number_ports p
    left join app.phone_numbers n on n.id = p.phone_number_id and n.workspace_id = p.workspace_id
    where p.id = p_port;
  if v_ws is null then
    raise exception 'No port with that id' using errcode = '23503', detail = 'no_number_port';
  end if;
  if not (coalesce(private.system_scope_workspace() = v_ws, false)
          or private.has_permission(v_ws, 'channels.manage')) then
    raise exception 'You cannot move this business''s numbers'
      using errcode = '42501', detail = 'number_port_not_yours';
  end if;
  if v_number is null then
    return;
  end if;

  perform set_config('app.system_scope.workspace_id', v_ws::text, true);
  -- Only a number this port is actually holding. A number that already landed is `active` and is the
  -- business's own now: cancelling a stale port row must never take a working number off them.
  update app.phone_numbers set status = 'released', released_at = now()
    where id = v_number and workspace_id = v_ws and status = 'porting';
  perform set_config('app.system_scope.workspace_id', coalesce(v_prev, ''), true);
end $$;
