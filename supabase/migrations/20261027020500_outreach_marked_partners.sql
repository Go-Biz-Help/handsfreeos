-- =============================================================================
-- Social Outreach: marking someone as a potential partner
-- (docs/outreach.md, decision 130).
--
-- The owner's decision (settled, 30 Oct 2026, "1a 2a 3a 4a 5b 6a 7a 8a"):
--
--        Potential partner in the person menu puts anyone on the person's
--        Partners list, with partner messages instead of customer ones: a
--        like first, the ask a day later, before the ones the AI found. The
--        AI reads their profile for what kind of partner they are, and the
--        mark wins whatever it says. They can still be offered a demo, which
--        counts as Call booked and as Demo booked. Not a partner after all
--        puts them back on customer messages. When the customer check thinks
--        someone looks more like a partner, their card says so.
--
-- `partners.marked_at` is when the person marked them: null for anyone the AI
-- found. `checks.partner_hint` is the customer check's line on why someone
-- looks more like a partner, null when they don't.
--
-- Only adds: two columns nobody has to fill.
-- =============================================================================

alter table addon_outreach.partners add column marked_at timestamptz;

comment on column addon_outreach.partners.marked_at is
  'When the person marked them as a potential partner (decision 130): null for anyone the AI found.';

alter table addon_outreach.checks add column partner_hint text;

comment on column addon_outreach.checks.partner_hint is
  'Why the customer check thinks they look more like a partner (decision 130), in one line: null when they don''t.';
