-- =============================================================================
-- 0105 · Who bills into which account. A business can connect several
--        Stripe and Square accounts — two of the same provider as easily as
--        one of each (0046) — and until now anybody who could bill could bill
--        into any of them. A team where each person's work is paid to their
--        own account needs to say whose account is whose, so each account now
--        says who may use it (`used_by`, and the people it names, `user_ids`):
--
--          everyone      everybody who bills may use it. What every account
--                        was until now, and still the default.
--          chosen        only the people it names.
--          only_theirs   only the people it names, and those people use only
--                        the accounts that name them — never an account open
--                        to everyone. "Maria bills into her own account and
--                        nothing else", in one setting on her account.
--
--        The whole rule is private.payment_account_usable(), and it is the
--        same for owners: an owner who wants to bill into an account that
--        names somebody else adds themselves to it (they are the ones who
--        choose, so nothing is ever out of their reach).
--
--        **Enforced where the account is chosen, by a person.** An invoice or
--        a plan a person points at an account they may not use is refused by
--        a trigger, whatever path the write took. What the business itself
--        chose — a calendar's deposit account, the default an automatic
--        invoice falls back to, the account a plan's card was saved on — is
--        the worker's and the booking page's, and those write as the system,
--        so they are not second-guessed here; the commands make sure a person
--        who names no account is given one they may use.
--
--        "Everyone who bills" is owners and admins today. The people an
--        account names are anybody in the business, so a member named on one
--        is ready for the day members bill.
-- =============================================================================

create type app.payment_account_use as enum ('everyone', 'chosen', 'only_theirs');

alter table app.payment_connections
  add column used_by app.payment_account_use not null default 'everyone',
  add column user_ids uuid[] not null default '{}',
  -- An account open to everyone names nobody; one kept to some people names at least one of them.
  add constraint payment_connections_used_by_people
    check ((used_by = 'everyone') = (cardinality(user_ids) = 0)),
  add constraint payment_connections_user_ids_size check (cardinality(user_ids) <= 50);

comment on column app.payment_connections.used_by is
  'Who may bill into this account (0105): everyone who bills, only the people in user_ids, or only them and they into nothing that is open to everyone.';
comment on column app.payment_connections.user_ids is
  'The people this account is kept to (0105). Empty exactly when it is open to everyone.';

-- Each person once, in the order they were chosen; somebody newly chosen belongs to the business.
create or replace function private.guard_payment_account_people()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_added uuid;
begin
  select coalesce(array_agg(x.u order by x.n), '{}'::uuid[]) into v_ids
  from (
    select t.u, min(t.n) as n from unnest(new.user_ids) with ordinality as t(u, n)
    where t.u is not null group by t.u
  ) x;
  for v_added in
    select a.u from unnest(v_ids) as a(u)
    where tg_op = 'INSERT' or not (a.u = any (old.user_ids))
  loop
    if not private.workspace_has_user(new.workspace_id, v_added) then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  end loop;
  new.user_ids := v_ids;
  return new;
end $$;
create trigger payment_connections_people before insert or update of used_by, user_ids
  on app.payment_connections for each row execute function private.guard_payment_account_people();

-- People choose who uses an account, beside renaming it and making it the default (0046's column grants).
grant update (used_by, user_ids) on app.payment_connections to authenticated;
grant select (used_by, user_ids) on app.payment_connections to authenticated;

-- ---------- the rule ----------
-- May this person bill into this account? An account kept to people: when it names them. An account open to
-- everyone: unless an account that is theirs alone (only_theirs) names them — they bill into those instead. An
-- account that has ended keeps nobody anywhere.
create or replace function private.payment_account_usable(p_ws uuid, p_connection uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.payment_connections c
    where c.id = p_connection and c.workspace_id = p_ws
      and case when c.used_by = 'everyone' then not exists (
            select 1 from app.payment_connections k
            where k.workspace_id = p_ws and k.used_by = 'only_theirs' and k.status <> 'disconnected'
              and p_user = any (k.user_ids))
          else p_user = any (c.user_ids) end)
$$;

-- An invoice or a plan a person points at an account: one they may use. The system — the worker, the booking
-- page, the AI teammate once an owner has said yes — writes as the business, and is not asked.
create or replace function private.check_payment_account_usable()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or new.connection_id is null
     or coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.connection_id is not distinct from old.connection_id then
    return new;
  end if;
  if not private.payment_account_usable(new.workspace_id, new.connection_id, v_user) then
    raise exception 'That payment account is kept for other people on the team'
      using errcode = '42501', detail = 'payment_account_not_yours';
  end if;
  return new;
end $$;
create trigger invoices_payment_account_usable before insert or update of connection_id on app.invoices
  for each row execute function private.check_payment_account_usable();
create trigger subscriptions_payment_account_usable before insert or update of connection_id
  on app.subscriptions for each row execute function private.check_payment_account_usable();

-- ---------- function privileges ----------
revoke all on function
  private.guard_payment_account_people(), private.payment_account_usable(uuid, uuid, uuid),
  private.check_payment_account_usable()
  from public;
grant execute on function
  private.guard_payment_account_people(), private.payment_account_usable(uuid, uuid, uuid),
  private.check_payment_account_usable()
  to authenticated, service_actor;
