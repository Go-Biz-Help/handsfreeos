-- =============================================================================
-- Social Outreach: staying active in your Facebook groups
-- (docs/outreach.md, decision 114).
--
-- The owner's decision (settled):
--
--        Each day it likes 3 to 5 recent posts in your groups and replies
--        to 1. The AI writes the reply, and replies wait for your OK at
--        first.
--
-- The likes are noted as any like is. The day's reply goes under a post that
-- asks something: the person's computer keeps that post (`posts.found` takes
-- `active`), marked with when it was kept for the reply (`posts.reply_at`),
-- and the AI's reply goes through `sends` like a comment (`sends.kind` takes
-- `group_reply`), waiting for the person's OK at first.
--
-- Only adds: a column, an index, two checks that let one more kind each, and
-- the check that a send goes under a post when it's a comment, which now
-- takes a reply in a group too.
-- =============================================================================

alter table addon_outreach.posts add column reply_at timestamptz;

create index posts_reply_idx on addon_outreach.posts (workspace_id, user_id, reply_at desc)
  where reply_at is not null;

alter table addon_outreach.posts drop constraint posts_found_check;
alter table addon_outreach.posts add constraint posts_found_check
  check (found in ('scroll', 'find', 'watch', 'search', 'account', 'active'));

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect', 'pitch', 'video', 'check_in',
    'partner_ask', 'partner_follow_up', 'partner_details', 'partner_reply', 'comment',
    'demo_reminder', 'rebook', 'birthday', 'new_job', 'group_reply'));

alter table addon_outreach.sends drop constraint sends_comment_post;
alter table addon_outreach.sends add constraint sends_comment_post
  check ((kind in ('comment', 'group_reply')) = (post_id is not null));
