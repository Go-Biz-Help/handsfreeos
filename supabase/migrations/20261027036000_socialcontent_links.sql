-- =============================================================================
-- AI Social Media Content Creator: the business's link in its posts
-- (docs/socialcontent.md, "Your link"; the owner, 24 Nov 2026: posts said
-- "link in bio" with no link anywhere).
--
--        settings.link         the business's link, set on the Playbook page.
--        settings.link_places  where it goes on each network: "post" (after
--                              the post's words), "bio" (the words say it's
--                              in the bio) or "comment" (the first comment
--                              once the post is up; a reply on Threads and X).
--                              A network not in it takes its default.
--        content.link_place    where a post's link goes, when its words point
--                              people to the link; null when it carries none.
--
--        Only adds columns, with defaults, so the running code keeps working.
-- =============================================================================

alter table addon_socialcontent.settings
  add column link text,
  add column link_places jsonb not null default '{}'::jsonb;

alter table addon_socialcontent.settings
  add constraint settings_link_length check (link is null or char_length(link) <= 500);

alter table addon_socialcontent.content
  add column link_place text;

alter table addon_socialcontent.content
  add constraint content_link_place_known
    check (link_place is null or link_place in ('post', 'bio', 'comment'));
