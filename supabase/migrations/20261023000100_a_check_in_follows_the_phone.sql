-- =============================================================================
-- A check-in follows the phone (Real Estate round seven, step 1, core).
--
--        Chris decided (2026-10-05): during a check-in with Share where I am on, the phone keeps sharing where
--        it is until the check-in ends, so if contacts are told they see the latest spot, not where the person
--        checked in. Only that latest spot is kept, never a trail, and it's cleared 30 days after the check-in
--        ends, the ones before this round too.
--
--        `follows` says the phone is sharing (set at check-in, when it took a first reading with the person's
--        OK); `safety.where` moves the one spot on while the check-in is open. The worker's nightly pass calls
--        private.clear_old_safety_spots() in batches.
-- =============================================================================

alter table app.safety_checkins add column follows boolean not null default false;
comment on column app.safety_checkins.follows is
  'The phone shares where it is until the check-in ends (round seven): safety.where moves latitude, longitude and located_at, keeping only the latest.';

-- Spots kept no longer than 30 days after a check-in ended (checked out, answered, or its planned end for one that
-- never was). Batches, like the receipts' clean-up.
create index safety_checkins_spot_idx on app.safety_checkins
  (coalesce(checked_out_at, resolved_at, planned_end_at)) where latitude is not null;
create or replace function private.clear_old_safety_spots(p_limit integer default 5000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update app.safety_checkins c
  set latitude = null, longitude = null, located_at = null
  where c.id in (
    select x.id from app.safety_checkins x
    where x.latitude is not null
      and coalesce(x.checked_out_at, x.resolved_at, x.planned_end_at) < now() - interval '30 days'
    order by coalesce(x.checked_out_at, x.resolved_at, x.planned_end_at)
    limit greatest(1, least(coalesce(p_limit, 5000), 50000)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function private.clear_old_safety_spots(integer) from public;
grant execute on function private.clear_old_safety_spots(integer) to service_actor;
