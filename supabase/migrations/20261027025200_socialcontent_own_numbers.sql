-- =============================================================================
-- AI Social Media Content Creator: learning from the business's own posts
-- (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, "Making and posting the business's own content", part 11;
-- decision 19; docs/socialcontent.md, "Its own posts' numbers").
--
--        Two and seven days after a post goes up, the business's reading
--        computer reads its numbers in each place it went up (views where the
--        network shows them, likes, comments, shares). Content keeps them
--        (`numbers`: by place, the read at about 2 days and at about 7), and
--        when the next read is due (`checks_due_at`; null once both are read,
--        or when it went up nowhere with a link). At its 7-day read a post is
--        weighed against the business's own other posts in the same place, as
--        a creator's are against theirs (`done_well`: on what, how many times
--        their middle number, and when), and those that did well go into the
--        Playbook beside the creators' standouts.
-- =============================================================================

alter table addon_socialcontent.content
  -- {"page": {"d2": {"at": "…", "days": 2, "views": null, "likes": 14, "comments": 3, "shares": 1}, "d7": {…}},
  --  "feed": {"d2": {"at": "…", "days": 2, "failure": "…"}}}
  add column numbers jsonb not null default '{}'::jsonb check (jsonb_typeof(numbers) = 'object'),
  add column checks_due_at timestamptz,
  -- {"place": "feed", "on": "engagement", "times": 2.4, "at": "…"}
  add column done_well jsonb check (done_well is null or jsonb_typeof(done_well) = 'object');

-- The reads due, across businesses.
create index content_checks_idx on addon_socialcontent.content (workspace_id, checks_due_at)
  where checks_due_at is not null;
