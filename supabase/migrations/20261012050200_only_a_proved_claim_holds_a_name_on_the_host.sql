-- =============================================================================
-- Only a proved claim keeps a name on the host (M17, audit SEC-M11).
--
--        0501 kept a name on the host after its owner removed it whenever any
--        other business still had any claim on it — including a pending row
--        nobody ever proved. So a squatter's pending row held the real owner's
--        name on our host for good.
--
--        Now only a claim whose token was found counts. A business still
--        setting its domain up loses nothing it had: pressing Check now claims
--        the name with the host again (`add` is idempotent), and it cannot be
--        verified until its token is found anyway.
-- =============================================================================

create or replace function private.branded_domain_claimed(p_domain text, p_except uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.branded_domains d
    where d.domain = lower(btrim(p_domain))
      and d.ownership_proved_at is not null
      and (p_except is null or d.workspace_id <> p_except)
  )
$$;

comment on function private.branded_domain_claimed(text, uuid) is
  'Whether any business (but p_except) still has a proved claim on this name. Says nothing about whose.';

revoke all on function private.branded_domain_claimed(text, uuid) from public;
grant execute on function private.branded_domain_claimed(text, uuid) to service_actor;
