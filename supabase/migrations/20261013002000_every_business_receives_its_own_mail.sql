-- =============================================================================
-- Every business receives its own mail (M19, step 6).
--
--        Until now only HandsFreeOS's own business received at its domain,
--        through the support desk's Postmark server. Now any business can:
--        the worker gives each receiving domain a Postmark server of its own,
--        all posting to the one webhook. That makes a domain's claim worth
--        more than it was, so a claim has to be proved, as branded domains
--        are (20261012050100).
--
--        **A token per claim.** Every row gets a random token the business
--        publishes as a TXT record at `_hfos-verify.<domain>`. Postmark keeps
--        one domain per name for the whole account, so two businesses
--        claiming the same name share its DKIM key, and a key in DNS says
--        only that somebody set the name up. The token says which business
--        did. A domain is verified only once its token was found, except
--        handsfreeos.com, which only HandsFreeOS's own business may hold.
--        Domains already verified keep working: they are recorded as proved
--        when they were verified.
--
--        **One working claim per name.** The unique index covers verified
--        rows only, so a pending claim squats nothing. And one business at a
--        time receives a name's mail, whoever else has verified it since.
--
--        **What the worker set up.** Receiving starts off whatever a person
--        inserts, and when Postmark refuses to receive a domain, the reason is
--        kept for Settings → Email to show.
-- =============================================================================

-- ---------- the token, and when it was found ----------
alter table app.email_domains
  add column ownership_token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  add column ownership_proved_at timestamptz,
  add column receiving_error text check (receiving_error is null or length(receiving_error) <= 2000);

comment on column app.email_domains.ownership_token is
  'Published by the business as a TXT record at _hfos-verify.<domain>: which business set the name up.';
comment on column app.email_domains.ownership_proved_at is
  'When the worker found the token. A domain is verified only once it has been.';
comment on column app.email_domains.receiving_error is
  'Why Postmark would not receive this domain''s mail, the last time it was asked. Cleared once it does.';

-- Everything already working was working before this rule existed.
update app.email_domains
  set ownership_proved_at = coalesce(dkim_verified_at, created_at)
  where status = 'verified' and ownership_proved_at is null;

alter table app.email_domains add constraint email_domains_verified_is_proved
  check (status <> 'verified' or ownership_proved_at is not null);

-- ---------- one working claim per name ----------
alter table app.email_domains drop constraint email_domains_domain_key;
create unique index email_domains_live_domain_idx on app.email_domains (domain) where status = 'verified';
create unique index email_domains_receiving_domain_idx on app.email_domains (domain) where receiving <> 'off';
create unique index email_domains_workspace_domain_idx on app.email_domains (workspace_id, domain);
-- Every claim on a name, for the worker asking whether anybody still holds one it is about to give back.
create index email_domains_domain_idx on app.email_domains (domain);

-- ---------- what a person inserts is only the name ----------
-- A token copied out of somebody else's DNS is worth nothing if the inserter could have written it into their
-- own row, and receiving is the worker's to start. It reads who is writing, so it runs as them.
create or replace function private.mint_email_domain_token()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  new.ownership_token := encode(extensions.gen_random_bytes(16), 'hex');
  new.ownership_proved_at := null;
  new.receiving := 'off';
  new.mx_verified_at := null;
  new.mx_checked_at := null;
  new.inbound_server_id := null;
  new.receiving_error := null;
  return new;
end $$;

create trigger email_domains_mint_token before insert on app.email_domains
  for each row execute function private.mint_email_domain_token();

-- ---------- asked across businesses, answered without saying whose ----------
-- Whether another business has this name working (verified), or receives its mail: a claim waits, and a
-- business asking to receive is told so, rather than hitting the unique indexes.
create or replace function private.email_domain_held_elsewhere(p_domain text, p_except uuid)
returns table (verified boolean, receiving boolean)
language sql stable security definer set search_path = '' as $$
  select
    exists (select 1 from app.email_domains d
            where d.domain = lower(btrim(p_domain)) and d.id <> p_except and d.status = 'verified'),
    exists (select 1 from app.email_domains d
            where d.domain = lower(btrim(p_domain)) and d.id <> p_except and d.receiving <> 'off')
$$;

-- Whether any business still has a claim on this name, so the worker never gives a name back to Postmark that
-- another business is using: a squatter giving up its pending claim must not take the real owner's domain down.
-- `p_except` leaves out the business being deleted, whose own rows are still there when it asks.
create or replace function private.email_domain_claimed(p_domain text, p_except uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.email_domains d
    where d.domain = lower(btrim(p_domain))
      and (p_except is null or d.workspace_id <> p_except)
  )
$$;

revoke all on function
  private.mint_email_domain_token(), private.email_domain_held_elsewhere(text, uuid),
  private.email_domain_claimed(text, uuid)
  from public;
grant execute on function private.mint_email_domain_token() to authenticated, service_actor;
grant execute on function private.email_domain_held_elsewhere(text, uuid) to authenticated, service_actor;
grant execute on function private.email_domain_claimed(text, uuid) to service_actor;
