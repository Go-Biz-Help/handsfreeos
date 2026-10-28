-- =============================================================================
-- Affiliates, part 5 (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md): the
-- terms.
--
--        An affiliate agrees to the affiliate terms (handsfreeos.com/affiliates/terms)
--        before their link and codes show on their page, and before they make a
--        code or set up payouts. Which version they agreed to, and when, is
--        kept on their row. When the terms change, the version changes
--        (`AFFILIATE_TERMS_VERSION` in @hfos/core), and they agree again
--        before making codes or setting up payouts. Their link keeps crediting
--        businesses either way, and what they earned keeps.
--
--        A person writes their row only through a function that answers for
--        them alone, as with applying.
--
-- Only adds. PowerSync copies nothing again: no synced table changes.
-- =============================================================================

alter table platform.affiliates
  -- The terms they agreed to, by version (the date they were published, `2026-10-28`), and when.
  add column terms_version text check (terms_version ~ '^\d{4}-\d{2}-\d{2}$'),
  add column terms_accepted_at timestamptz,
  add constraint affiliates_terms_together check ((terms_version is null) = (terms_accepted_at is null));

/**
 * The signed-in person agrees to this version of the affiliate terms, on their own row. Answers whether it changed
 * anything: false when they'd already agreed to this version, or have no row.
 */
create or replace function private.affiliate_accept_terms(p_version text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update platform.affiliates
     set terms_version = p_version, terms_accepted_at = now()
   where user_id = auth.uid() and terms_version is distinct from p_version;
  return found;
end $$;

revoke all on function private.affiliate_accept_terms(text) from public;
grant execute on function private.affiliate_accept_terms(text) to authenticated;
