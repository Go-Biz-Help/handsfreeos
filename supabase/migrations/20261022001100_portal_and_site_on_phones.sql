-- =============================================================================
-- Two of a business's own facts reach phones that keep it (round six; core).
--
--        Real Estate's pages on the phone show a listing's page link, an open
--        house's sign-in link and a client's portal status: they need the
--        business's booking site's name in links (app.booking_sites.slug)
--        and who has the portal (app.portal_access, without its link's
--        reference). Both are readable by everyone in the business already;
--        records_v1 sends them behind the same `access` lookup as check-ins.
-- =============================================================================

grant select on app.booking_sites, app.portal_access to hfos_sync;
alter publication powersync add table app.booking_sites, app.portal_access;
