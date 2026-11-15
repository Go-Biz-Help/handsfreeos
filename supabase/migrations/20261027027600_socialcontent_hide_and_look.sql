-- =============================================================================
-- AI Social Media Content Creator: hiding posts, and looking for one that
-- didn't post (the owner, 15 Nov 2026; docs/socialcontent.md, "Picking many
-- posts" and "Posting").
--
--        Hide takes a post off the Calendar but keeps it under the Hidden
--        filter (`hidden_at`); one that hasn't gone up is skipped too, so it
--        never goes up while hidden. Showing it again clears `hidden_at`.
--
--        A post that didn't post may have gone up all the same (Facebook was
--        still publishing two Page posts on 14 Nov when the extension gave
--        up). Check if it posted has the reading computer look on the network
--        for it by its first words: `look_due_at` is when it's next looked for
--        (10 minutes after a post that may have gone up is marked as didn't
--        post, once, on its own; now, when a person asks), put off half an
--        hour as it's handed out, so a look never answered is asked again.
--        `looked_at` is when it last looked and didn't find it everywhere, and
--        `look_failure` why it couldn't look at all (signed out, a warning).
-- =============================================================================

alter table addon_socialcontent.content
  add column hidden_at timestamptz,
  add column look_due_at timestamptz,
  add column looked_at timestamptz,
  add column look_failure text;

-- The looks due, across businesses.
create index content_look_idx on addon_socialcontent.content (workspace_id, look_due_at)
  where look_due_at is not null;
