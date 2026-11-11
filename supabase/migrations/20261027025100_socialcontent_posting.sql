-- =============================================================================
-- AI Social Media Content Creator: posting the business's own posts through the extension
-- (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, "Making and posting the business's own content", part 9;
-- docs/socialcontent.md, "Posting").
--
--        An OK'd post goes up at its time from the business's reading
--        computer, in Chrome with the HandsFreeOS Social extension: Facebook
--        (the person's profile, the business's Page, or both) and LinkedIn
--        (the person's feed). Content keeps when the computer took it to put
--        up (`posting_at`: one going up that never says how it went is marked
--        as didn't post after a while, never tried again on its own, as it may
--        have gone up), and where it went up so far (`posted_to`: each place,
--        its link and when), so trying again never puts it up twice in the
--        same place.
-- =============================================================================

alter table addon_socialcontent.content
  add column posting_at timestamptz,
  -- [{"place": "profile" | "page" | "feed", "link": "https://..." | null, "at": "2026-11-11T15:00:00Z"}]
  add column posted_to jsonb not null default '[]'::jsonb
    check (jsonb_typeof(posted_to) = 'array' and jsonb_array_length(posted_to) <= 3);

-- The posts due to go up, and those going up now, across businesses.
create index content_due_idx on addon_socialcontent.content (workspace_id, post_at)
  where state in ('ready', 'posting');
