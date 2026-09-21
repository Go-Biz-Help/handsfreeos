-- =============================================================================
-- 0077 · More than one phone number per business.
--
--        The rule this removes has been in the schema since day one:
--
--          create unique index phone_numbers_one_live_per_workspace
--            on app.phone_numbers (workspace_id)
--            where status in ('provisioning', 'active', 'releasing');
--
--        One number per business, enforced by the database, with a matching
--        `number_exists` refusal in phoneNumberBuy. It was right for one
--        milestone and wrong for every business with a second location, a
--        dispatch line, or a toll-free number beside its local one.
--
--        `phone_numbers_live_e164` STAYS. The two indexes look alike and mean
--        opposite things: the one going away said "a business has one number",
--        and the one staying says "a live number belongs to one business".
--        The second is not a milestone decision, it is how routing works —
--        private.phone_route() looks a number up by e164 and expects one row.
--
--        **Which number is "the" one** then needs an answer, because a brand
--        new conversation has no number yet. This copies email exactly:
--        app.email_addresses.is_default plus a partial unique index has solved
--        the identical problem since 0002, and pickFromAddress already encodes
--        the preference chain (explicit, then the conversation's, then the
--        default, then any). A uuid in workspaces.settings would be a foreign
--        key with no referential integrity and no way to say "exactly one".
--
--        **Nothing changes for a business with one number.** Every live number
--        today is backfilled as its workspace's default — the index being
--        dropped guarantees there is at most one, so the backfill is exact —
--        and defaultNumber() orders by is_default first and then by the same
--        `created_at desc` liveNumber() used. A one-number business gets the
--        same row it got yesterday. That is the property to defend in review.
-- =============================================================================

drop index app.phone_numbers_one_live_per_workspace;

alter table app.phone_numbers
  add column is_default boolean not null default false;

comment on column app.phone_numbers.is_default is
  'The number a new conversation sends from, and what Settings shows first. Exactly one per workspace among '
  'live numbers, kept by private.phone_numbers_keep_default(). Mirrors app.email_addresses.is_default.';

-- Exactly one, and only ever a number that could actually send. A released or failed number left holding the
-- default would silently send nothing.
create unique index phone_numbers_one_default on app.phone_numbers (workspace_id)
  where is_default and status in ('provisioning', 'active', 'releasing');

-- The backfill. Exact, because the index just dropped allowed at most one live number per workspace.
update app.phone_numbers set is_default = true
  where status in ('provisioning', 'active', 'releasing');

-- ---------- the default always exists, and is always sendable ----------
-- A business must never be left with live numbers and no default: every outbound path falls back to it, so a
-- null default is a business that cannot start a conversation. Two cases to keep true — the first live number
-- becomes the default, and a default that stops being live hands off to the oldest number that still is.
create or replace function private.phone_numbers_keep_default()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  -- The enum's own array type, not `text[]`: there is no `app.phone_number_status = text` operator, and
  -- because a plpgsql body is not type-checked until it runs, `text[]` here applied cleanly and then failed
  -- on the first number anybody bought.
  v_live app.phone_number_status[] :=
    array['provisioning', 'active', 'releasing']::app.phone_number_status[];
begin
  -- A default that is no longer live still holds the flag, because the unique index below only covers live
  -- rows. Tidy it away when a live number takes over. This cannot *prevent* two defaults — the index is
  -- checked as the row is written, long before an AFTER trigger runs — which is why the command clears the
  -- old default itself, the way payment_connection.set_default does.
  if tg_op <> 'DELETE' and new.is_default then
    update app.phone_numbers set is_default = false
      where workspace_id = v_ws and id <> new.id and is_default;
  end if;

  -- Nobody holds it, and somebody could. The oldest live number takes it: a business that bought a second
  -- number should not find its original one quietly demoted.
  --
  -- **Only on an arrival or a departure.** Moving the default is two statements — clear the old, set the
  -- new — because a partial unique index is checked as each row is written, long before an AFTER trigger
  -- could tidy up. Handing off in the gap between those two put the old number straight back, and the
  -- second statement then collided with the index: `phone_number.set_default` was refused for every
  -- business with more than one number, which is every business this milestone is for.
  --
  -- What this gives up: somebody who clears a default and sets nothing leaves the workspace without one
  -- until the next number arrives or changes status. No command does that — `set_default` only ever sets —
  -- and the next insert or status change heals it.
  if tg_op = 'INSERT' or tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and old.status is distinct from new.status) then
    if not exists (
      select 1 from app.phone_numbers
      where workspace_id = v_ws and is_default and status = any(v_live)
    ) then
      update app.phone_numbers set is_default = true
        where id = (
          select id from app.phone_numbers
          where workspace_id = v_ws and status = any(v_live)
          order by created_at, id limit 1
        );
    end if;
  end if;
  return null;
end $$;

-- After, not before: this fixes up the rest of the workspace rather than the row being written, and it has to
-- see the row's new state to know whether anything needs fixing. Runs after guard_phone_number_update, so a
-- person's write is still refused by the guard before this ever sees it.
create trigger phone_numbers_keep_default
  after insert or update of is_default, status or delete on app.phone_numbers
  for each row execute function private.phone_numbers_keep_default();

-- ---------- a person may set the default, and nothing else new ----------
-- The guard lists what a person may NOT change, so a new column is writable unless it says otherwise. That is
-- the right default here — picking which number you send from is exactly the kind of thing an admin does —
-- but the status rule needs widening to match 0073, which already let a `provisioning` number be released and
-- which this migration must not quietly undo.
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
    raise exception 'People can only start releasing a number that is in use or still being set up'
      using errcode = '42501', detail = 'phone_number_status_transition';
  end if;
  return new;
end $$;
