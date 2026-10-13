-- Social Outreach: what a like or comment the extension made on its own was on, and said (docs/outreach.md,
-- "Posts liked and commented on"). For the Results tab's list: what the post said, the AI's comment, and why the AI
-- picked that post to like. Never what the person wrote themselves: steps they take are noted without these.
alter table addon_outreach.touches
  add column post_text text check (post_text is null or length(btrim(post_text)) between 1 and 300),
  add column comment_text text check (comment_text is null or length(btrim(comment_text)) between 1 and 2000),
  add column why text check (why is null or length(btrim(why)) between 1 and 160),
  add constraint touches_words_check check (
    (post_text is null and comment_text is null and why is null) or kind in ('like', 'comment')
  );

-- The list goes by person and kind, the latest first.
create index touches_posts_idx on addon_outreach.touches (workspace_id, at desc) where kind in ('like', 'comment');
