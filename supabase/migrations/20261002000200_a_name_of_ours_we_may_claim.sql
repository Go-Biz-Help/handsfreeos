-- =============================================================================
-- 0090 · One of our own names, claimed on purpose (M17).
--
--        0087 refused every handsfreeos.com name outright — in Zod, and again
--        in a check constraint — and it was right to. A business pointing
--        `app.handsfreeos.com` at its own booking page is a phishing page built
--        out of a feature, and it would be built by us.
--
--        **But it wrote a wider rule than it meant.** "No tenant may claim one
--        of our names" and "no name of ours may ever be claimed" are different
--        sentences, and 0087 wrote the second. We run our own business on this
--        platform the same way everybody else does, and `link.handsfreeos.com`
--        is a name we hold, pointed at a site we own. Under the old rule the
--        only way to have it was to take the guard off for everybody.
--
--        **So the rule gets a subject.** A name of ours is claimable when it is
--        written down here, against the one workspace that may claim it, and
--        not otherwise. The list is ours alone: no tenant can read it, never
--        mind add to it, so `login.handsfreeos.com` becomes claimable only if
--        somebody with the keys to this database decides it should be, one name
--        at a time.
--
--        **Where it is enforced.** A check constraint cannot consult another
--        table, so the domain check gives up its handsfreeos clause and a
--        trigger takes that half of the rule over — which is the half that
--        needed to know who was asking. The shape rules stay in the check,
--        where they were. Zod stops guessing at this question entirely: it has
--        one answer, it depends on the workspace, and it lives here.
-- =============================================================================

-- ---------- the list ----------
-- A name of ours, and the single workspace that may put its pages on it. Primary key on the host because
-- the question this answers is "may somebody claim this name?", which has one answer per name.
create table platform.claimable_hosts (
  host text primary key
    check (host = lower(host) and length(host) <= 253
      and host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
      -- Only our own names belong on this list. Anybody else's is already claimable without asking us,
      -- and a row here for a name we do not hold would be a way to hand one business another's domain.
      and host ~ '(^|\.)handsfreeos\.com$'),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- What this one is for, for whoever reads the list in a year and has to decide whether it still earns
  -- its place. Deliberately not optional to think about, even though it may be left empty.
  why text not null default '' check (length(why) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index claimable_hosts_workspace_idx on platform.claimable_hosts (workspace_id);
create trigger claimable_hosts_updated_at before update on platform.claimable_hosts
  for each row execute function private.set_updated_at();

comment on table platform.claimable_hosts is
  'Names of ours that a named workspace may claim as its branded domain. Not tenant data, and not tenant '
  'readable: the only way in is a migration or somebody with direct access to this database.';

-- Nobody is granted anything, so a tenant is refused before row level security is even consulted — it does
-- not read as an empty list, it reads as "permission denied", and a business cannot so much as learn which
-- of our names exist. Row level security is switched on behind that anyway, so a grant added here in a
-- hurry one day still lands on a table that refuses by default. The trigger and the look-up below are
-- `security definer`, so they read it without anybody else being able to.
alter table platform.claimable_hosts enable row level security;
revoke all on platform.claimable_hosts from public;

-- ---------- the shape rule stays a check; the ownership rule becomes a trigger ----------
alter table app.branded_domains drop constraint branded_domains_domain_check;
alter table app.branded_domains add constraint branded_domains_domain_check
  check (domain = lower(domain) and length(domain) <= 253
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$');

-- The half of 0087's rule that needed to know whose request this is. Runs on insert and on update: the
-- domain is already immutable on update (`branded_domains_immutable`), so the update arm is a belt on top
-- of braces, and cheap enough to keep for the day somebody relaxes that.
create or replace function private.guard_branded_domain_host()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.domain !~ '(^|\.)handsfreeos\.com$' then
    return new;
  end if;
  if exists (
    select 1 from platform.claimable_hosts c
    where c.host = new.domain and c.workspace_id = new.workspace_id
  ) then
    return new;
  end if;
  raise exception 'That is one of our own addresses'
    using errcode = '42501', detail = 'branded_domain_is_ours';
end $$;

create trigger branded_domains_host_guard before insert or update on app.branded_domains
  for each row execute function private.guard_branded_domain_host();

revoke all on function private.guard_branded_domain_host() from public;

-- ---------- what the handler asks, so a person gets a sentence instead of a 42501 ----------
-- The trigger is the rule; this is only so `branded_domain.add` can say "that one is not yours" before it
-- writes, in the same words the form uses for every other refusal.
create or replace function private.claimable_host_workspace(p_host text)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.workspace_id from platform.claimable_hosts c where c.host = lower(btrim(p_host))
$$;

comment on function private.claimable_host_workspace(text) is
  'The one workspace that may claim this name of ours, or null. Null for every name that is not ours.';

revoke all on function private.claimable_host_workspace(text) from public;
grant execute on function private.claimable_host_workspace(text) to authenticated, service_actor;
