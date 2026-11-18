-- =============================================================================
-- A calendar on the business's own website (the owner, 2026-11-18: "yes" to an
-- embed option like forms have).
--
--        A booking page could only be linked to: every page of ours tells
--        browsers that nobody else may frame it (apps/web/src/lib/frames.ts).
--        A form's embed already works another way: it lists the sites allowed
--        to show it, and its page's frame rule names the one it's on when that
--        site is listed (20260927000300, apps/web/src/lib/forms/frame.ts).
--        A calendar now has the same list, with the same check as a form's and
--        the website chat's (private.valid_chat_origins: exact https origins).
--        Empty means it isn't embedded anywhere, which is most calendars.
--
--        Only a column: app.calendars is already updatable by the business
--        (20260915000100's table grant, behind calendars_update), and the
--        worker reads it in the tenant's scope when the booking page asks.
-- =============================================================================

alter table app.calendars
  -- The sites allowed to frame its booking page. Empty means it isn't embedded anywhere.
  add column embed_origins text[] not null default '{}'
    check (cardinality(embed_origins) = 0 or private.valid_chat_origins(embed_origins));
