-- Releasing a number no longer waits for the carrier registration to finish.
--
-- The guard only ever allowed active -> releasing, which is fine for a number in service but leaves two ways to get
-- stuck: a purchase the worker never finished sits at `provisioning` for good, and `phone_numbers_one_live_per_workspace`
-- counts that row, so the business can never buy another number either. Owners and admins can now start releasing a
-- number that is still being set up. Everything else about the guard is unchanged: provider fields stay ours, and no
-- other status change is a person's to make.
--
-- The worker asks the carrier what it holds for the number before it gives up on one with no sid yet
-- (apps/worker/src/handlers/telephony.ts, onReleaseRequested), so a number that really was bought is still handed
-- back rather than quietly left on the bill.

create or replace function private.guard_phone_number_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.e164 is distinct from new.e164 or old.number_type is distinct from new.number_type
     or old.provider_sid is distinct from new.provider_sid or old.account_id is distinct from new.account_id
     or old.capabilities is distinct from new.capabilities or old.purchased_at is distinct from new.purchased_at
     or old.released_at is distinct from new.released_at or old.last_error is distinct from new.last_error then
    raise exception 'Only HandsFreeOS changes a number''s provider details' using errcode = '42501', detail = 'phone_number_provider_fields';
  end if;
  if old.status is distinct from new.status
     and not (old.status in ('active', 'provisioning') and new.status = 'releasing') then
    raise exception 'People can only start releasing a number that is in use or still being set up' using errcode = '42501', detail = 'phone_number_status_transition';
  end if;
  return new;
end $$;
