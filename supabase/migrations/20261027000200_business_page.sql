-- =============================================================================
-- A simple page for a business with no website
--        (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "A simple page"): the booking page
--        grown into a one-page site. While it's on, /book/<slug> (and the business's own domain) shows what the
--        business does, its services, hours and area, with Book, Call, Text and Chat, and links to its privacy
--        policy and terms.
--
--        Everything on it comes from what the business already keeps (Knowledge → Business profile, the open
--        hours, the logo and colour, the booking calendars), so there's one page to keep up and nothing new to
--        write. Only booking_site.set_page turns it on or off, with calendars.manage like the rest of the
--        booking site: the table's own grants and policies already cover the new column.
-- =============================================================================

alter table app.booking_sites add column page_enabled boolean not null default false;

comment on column app.booking_sites.page_enabled is
  'The booking page shows the business''s simple page: what it does, its services, hours and area.';
