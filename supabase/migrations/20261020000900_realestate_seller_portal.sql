-- =============================================================================
-- Real Estate Agent, round three, step 12: the seller's own listing in the
-- portal.
--
--        Chris decided (2026-10-01): sellers use the same portal as buyers,
--        showing their listing. The portal reads key dates but never the
--        deal's amounts (round two), so **portal.listing_facts()** gives a
--        seller, for each of their own listings only, what they need beyond
--        that: the home's address, its list price as it stands, and where
--        its public page is once it's up.
-- =============================================================================

create or replace function portal.listing_facts()
returns table (record_id uuid, address text, list_price_cents bigint, site_slug text, page_slug text)
language sql stable security definer set search_path = '' as $$
  select l.deal_record_id,
    (select pr.name from app.relationships rel
      join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
      join app.custom_records pr on pr.id = rel.b_custom_record_id
      where rel.workspace_id = l.workspace_id and rel.a_custom_record_id = l.deal_record_id
      order by rel.created_at desc limit 1),
    (select e.value_cents from addon_realestate.term_entries e
      where e.deal_record_id = l.deal_record_id and e.key = 'list_price'
        and e.superseded_at is null and e.rejected_at is null
      order by e.confirmed_at is null, e.entered_at desc limit 1),
    case when l.page_state = 'published' and l.mls_number is not null and l.slug is not null then
      (select s.slug::text from app.booking_sites s where s.workspace_id = l.workspace_id limit 1)
    end,
    case when l.page_state = 'published' and l.mls_number is not null then l.slug end
  from addon_realestate.listings l
  join addon_realestate.deals d on d.workspace_id = l.workspace_id and d.record_id = l.deal_record_id
  where d.side = 'listing' and l.deal_record_id in (select portal.records())
$$;
revoke all on function portal.listing_facts() from public;
grant execute on function portal.listing_facts() to portal_actor;
