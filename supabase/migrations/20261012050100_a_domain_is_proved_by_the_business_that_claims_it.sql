-- =============================================================================
-- A business's own domain is proved by that business, not by the name
-- pointing at us (M17, audit SEC-M11).
--
--        0087 made `domain` unique across every business from the moment it
--        was typed, and "verified" meant only that the name pointed at our
--        shared host. So a business could squat a name another business
--        would one day want — a pending row never expires, and the real owner
--        was refused by the unique index for good — or, worse, add a name
--        whose owner had just removed it but left the CNAME in place, and have
--        it verified and served as its own pages on the other business's
--        domain.
--
--        **A token per claim.** Every row gets a random token the business
--        must publish as a TXT record at `_hfos-verify.<domain>`. The worker
--        looks it up, and only a row whose token it found may be verified: the
--        shared CNAME says the name points here, the token says which
--        business it points at. Domains already verified keep working —
--        they are recorded as proved when they were verified.
--
--        **One working claim per name, not one claim.** The unique index now
--        covers only verified rows, so a pending row squats nothing, and
--        "which business is this host?" still has exactly one answer.
-- =============================================================================

-- ---------- the token, and when it was found ----------
alter table app.branded_domains
  add column if not exists ownership_token text not null
    default encode(extensions.gen_random_bytes(16), 'hex'),
  add column if not exists ownership_proved_at timestamptz;

-- Everything already working was working before this rule existed. Written before the guard below learns
-- about the column, so this runs as the migration and needs no worker scope.
update app.branded_domains
  set ownership_proved_at = coalesce(verified_at, now())
  where status = 'verified' and ownership_proved_at is null;

alter table app.branded_domains drop constraint if exists branded_domains_verified_is_proved;
alter table app.branded_domains add constraint branded_domains_verified_is_proved
  check (status <> 'verified' or ownership_proved_at is not null);

-- ---------- one working claim per name ----------
alter table app.branded_domains drop constraint if exists branded_domains_domain_key;
create unique index if not exists branded_domains_live_domain_idx on app.branded_domains (domain)
  where status = 'verified';
-- Every claim on a name, for the worker asking whether anybody still holds one it is about to give back.
create index if not exists branded_domains_domain_idx on app.branded_domains (domain);

-- ---------- a token is ours to mint ----------
-- Whatever a person sends, the row gets a fresh token and nothing proved. A token copied out of somebody
-- else's public DNS is worth nothing if the inserter could have written it into their own row.
create or replace function private.mint_branded_domain_token()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.ownership_token := encode(extensions.gen_random_bytes(16), 'hex');
  new.ownership_proved_at := null;
  return new;
end $$;

drop trigger if exists branded_domains_mint_token on app.branded_domains;
create trigger branded_domains_mint_token before insert on app.branded_domains
  for each row execute function private.mint_branded_domain_token();

revoke all on function private.mint_branded_domain_token() from public;

-- ---------- and what the worker found is the worker's ----------
-- 0087's guard, with the two new columns in it: a business cannot mark its own claim proved, nor swap its
-- token for one it can already see in DNS.
create or replace function private.guard_branded_domain_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    if old.ownership_token is distinct from new.ownership_token then
      raise exception 'A domain''s ownership token never changes'
        using errcode = '42501', detail = 'branded_domain_provider_fields';
    end if;
    return new;
  end if;
  if old.status is distinct from new.status
     or old.verification_host is distinct from new.verification_host
     or old.verification_value is distinct from new.verification_value
     or old.cname_host is distinct from new.cname_host
     or old.cname_value is distinct from new.cname_value
     or old.certificate_ready is distinct from new.certificate_ready
     or old.verified_at is distinct from new.verified_at
     or old.last_checked_at is distinct from new.last_checked_at
     or old.last_error is distinct from new.last_error
     or old.next_check_at is distinct from new.next_check_at
     or old.ownership_token is distinct from new.ownership_token
     or old.ownership_proved_at is distinct from new.ownership_proved_at then
    raise exception 'Only HandsFreeOS records what the host said about a domain'
      using errcode = '42501', detail = 'branded_domain_provider_fields';
  end if;
  return new;
end $$;
revoke all on function private.guard_branded_domain_update() from public;

-- ---------- may the host let go of this name? ----------
-- The worker gives a name back to the host when a business removes it, or is deleted, one business at a
-- time, so it cannot see whether another business still holds a claim on the same name. Removing it then
-- would take a working domain off the host because a squatter gave up its pending row. `p_except` leaves
-- out the business being deleted, whose own rows are still there when it asks.
create or replace function private.branded_domain_claimed(p_domain text, p_except uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.branded_domains d
    where d.domain = lower(btrim(p_domain))
      and (p_except is null or d.workspace_id <> p_except)
  )
$$;

comment on function private.branded_domain_claimed(text, uuid) is
  'Whether any business (but p_except) still has a claim on this name. Says nothing about whose.';

revoke all on function private.branded_domain_claimed(text, uuid) from public;
grant execute on function private.branded_domain_claimed(text, uuid) to service_actor;
