-- =============================================================================
-- 0059 · People and their own cells.
--          - app.user_phones: a person's own cell, which "Call" rings to
--            connect them to a customer from the business number. HandsFreeOS
--            verifies it with a call ("Press 1 to confirm this is your
--            phone"): people add and remove their own numbers, the worker
--            records each verification call (for its rate limit) and the
--            moment the person pressed 1. One verified cell per person.
--          - 'bridge' in app.call_answered_via: a call placed through the
--            person's own cell. Nothing in this migration uses it, so the enum
--            value can be added here.
--          - possible_duplicate_of on people and companies: a record made with
--            no signal is created even when it looks like one that exists, and
--            says so ("Possible duplicate of …") until someone deals with it.
--          - Account deletion without deleting the sign-in (which would
--            cascade through the business's records): app.users.deleted_at and
--            private.anonymize_user, which the worker's job calls. It removes
--            the person's memberships (a business's or agency's only owner is
--            refused by the last-owner rules, so they hand ownership over
--            first), their cells, devices, receipts and Assistant chats, and
--            disconnects their own calendar, then scrubs the profile to "Former
--            teammate". Everything they did stays, credited to that name.
--            Ending their sessions and blocking sign-in happen in Auth, from the
--            worker. A deleted account can't join a business again.
--        Grants and the foreign-key indexes are in 0060.
-- =============================================================================

-- ---------- a person's own cells ----------
create table app.user_phones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users (id) on delete cascade,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- When the person pressed 1 on the verification call (the worker's).
  verified_at timestamptz,
  -- The verification calls placed so far, and the last one: the worker's rate limit.
  verification_count integer not null default 0 check (verification_count between 0 and 1000),
  last_verification_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_phones_user_e164_key unique (user_id, e164)
);
-- One verified cell per person: verifying another takes the place of the first (the worker clears it first).
create unique index user_phones_one_verified on app.user_phones (user_id) where verified_at is not null;
create trigger user_phones_updated_at before update on app.user_phones
  for each row execute function private.set_updated_at();
-- A different number is a different row.
create trigger user_phones_immutable before update on app.user_phones
  for each row execute function private.forbid_tenant_column_change('user_id', 'e164');

-- Verification is HandsFreeOS's: people add a number unverified and never write the verification columns (they have
-- no update grant at all; this holds the insert). The test is on current_user, which no role can fake, so this
-- function must stay SECURITY INVOKER.
create or replace function private.guard_user_phone()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.verified_at is not null or new.verification_count <> 0 or new.last_verification_at is not null then
      raise exception 'Only HandsFreeOS verifies a phone' using errcode = '42501', detail = 'user_phone_verification_protected';
    end if;
  elsif (new.verified_at, new.verification_count, new.last_verification_at)
        is distinct from (old.verified_at, old.verification_count, old.last_verification_at) then
    raise exception 'Only HandsFreeOS verifies a phone' using errcode = '42501', detail = 'user_phone_verification_protected';
  end if;
  return new;
end $$;
create trigger user_phones_guard before insert or update on app.user_phones
  for each row execute function private.guard_user_phone();

alter table app.user_phones enable row level security;
create policy user_phones_select on app.user_phones for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_phones_insert on app.user_phones for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_phones_delete on app.user_phones for delete to authenticated
  using (user_id = (select auth.uid()));
-- The worker places the verification and bridge calls for the people of the business it is scoped to.
create policy user_phones_service_select on app.user_phones for select to service_actor
  using (user_id in (select private.system_scope_user_ids()));
create policy user_phones_service_update on app.user_phones for update to service_actor
  using (user_id in (select private.system_scope_user_ids()))
  with check (user_id in (select private.system_scope_user_ids()));

-- ---------- calls through the person's own cell ----------
alter type app.call_answered_via add value if not exists 'bridge';

-- ---------- possible duplicates ----------
alter table app.people
  add column possible_duplicate_of uuid references app.people (id) on delete set null,
  add constraint people_possible_duplicate_check check (possible_duplicate_of is distinct from id);
alter table app.companies
  add column possible_duplicate_of uuid references app.companies (id) on delete set null,
  add constraint companies_possible_duplicate_check check (possible_duplicate_of is distinct from id);
comment on column app.people.possible_duplicate_of is
  'The customer this one may duplicate, set when it was created with no signal and looked like an existing one.';
comment on column app.companies.possible_duplicate_of is
  'The company this one may duplicate, set when it was created with no signal and looked like an existing one.';

-- Foreign keys don't see RLS: the record it may duplicate is in the same business.
create or replace function private.check_possible_duplicate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.possible_duplicate_of is not null and not exists (
       select 1 from app.people p
       where tg_table_name = 'people' and p.id = new.possible_duplicate_of and p.workspace_id = new.workspace_id
       union all
       select 1 from app.companies c
       where tg_table_name = 'companies' and c.id = new.possible_duplicate_of and c.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger people_check_possible_duplicate before insert or update of possible_duplicate_of on app.people
  for each row execute function private.check_possible_duplicate();
create trigger companies_check_possible_duplicate before insert or update of possible_duplicate_of on app.companies
  for each row execute function private.check_possible_duplicate();

-- ---------- account deletion ----------
alter table app.users add column deleted_at timestamptz;
comment on column app.users.deleted_at is
  'When the person deleted their account: the profile is scrubbed to "Former teammate" (private.anonymize_user) and the records they made stay.';

-- A deleted account never joins a business or an agency again, whichever way it tries (an invitation, a new
-- organization).
create or replace function private.refuse_deleted_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from app.users u where u.id = new.user_id and u.deleted_at is not null) then
    raise exception 'This account has been deleted' using errcode = '42501', detail = 'account_deleted';
  end if;
  return new;
end $$;
create trigger workspace_memberships_refuse_deleted before insert on app.workspace_memberships
  for each row execute function private.refuse_deleted_account();
create trigger organization_memberships_refuse_deleted before insert on app.organization_memberships
  for each row execute function private.refuse_deleted_account();

-- The worker's account-deletion job. Runs in the job's transaction: a refusal (an only owner) leaves everything as
-- it was.
create or replace function private.anonymize_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.users u where u.id = p_user) then
    raise exception 'No such person' using errcode = 'P0002', detail = 'user_not_found';
  end if;
  -- Memberships first: the last-owner rules refuse a business's or agency's only owner.
  delete from app.organization_memberships m where m.user_id = p_user;
  delete from app.workspace_memberships m where m.user_id = p_user;
  delete from app.user_phones p where p.user_id = p_user;
  delete from app.push_devices d where d.user_id = p_user;
  delete from app.command_receipts r where r.user_id = p_user;
  delete from app.assistant_threads t where t.user_id = p_user;
  -- Their own calendar stops blocking the business's: disconnected, its sealed tokens gone here (as 0017's guard does
  -- for people; the worker's scope bypasses that guard), its busy times by 0017's trigger.
  update app.calendar_connections c set status = 'disconnected', disconnected_at = now(), token_enc = null,
    token_key_id = null, pkce_verifier_enc = null, oauth_state_hash = null, next_sync_at = null
  where c.user_id = p_user and c.status <> 'disconnected';
  update app.users u set
    full_name = 'Former teammate',
    email = 'deleted-' || replace(u.id::text, '-', '') || '@deleted.handsfreeos.invalid',
    avatar_url = null,
    settings = '{}'::jsonb,
    deleted_at = coalesce(u.deleted_at, now())
  where u.id = p_user;
end $$;

-- ---------- function privileges ----------
revoke all on function
  private.guard_user_phone(), private.check_possible_duplicate(), private.refuse_deleted_account(),
  private.anonymize_user(uuid)
  from public;
grant execute on function
  private.guard_user_phone(), private.check_possible_duplicate(), private.refuse_deleted_account()
  to authenticated, service_actor;
grant execute on function private.anonymize_user(uuid) to service_actor;
