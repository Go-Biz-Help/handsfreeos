-- Warming people up while they decide on a request (docs/outreach.md,
-- decision 161).
--
-- Every other day for 2 weeks after a friend request, invitation or follow,
-- the extension looks at the person's page and likes 2 or 3 of their newest
-- posts, and one of those gets a short comment. When the wait ends with no
-- answer, the request is withdrawn (the follow undone) and the tool leaves
-- them alone unless they follow back or write first.
--
--        `posts.warm_up` marks a post a warm-up visit liked, kept for its one
--        comment, written as a person would, not from the owner's field.
--
--        `friend_ends.after_warm_up` marks a request withdrawn because its
--        warm-up ended with no answer: People shows them as "Didn't follow
--        back", and nothing on Today reaches them again unless they follow
--        back, accept or write first, or the person puts them back in play.
--
--        `friends.warm_up_from` gives everyone waiting on a request now a
--        fresh wait from today, as the owner picked (6b): a request's wait
--        runs from the later of it and `since`, so a new request after a
--        withdrawn one waits from when it went.
--
--        The business's wait, "Warm up for, then unfollow or withdraw"
--        (`cancelRequestsAfterWeeks`), now starts at 2 weeks: a business that
--        kept the old start of 3 goes to 2, as the owner picked (5a).
--
-- Adds three columns (two false for every row there now, one set on the
-- requests waiting now) and changes one setting from the old default. The
-- running code reads none of the columns.

alter table addon_outreach.posts
  add column warm_up boolean not null default false;

comment on column addon_outreach.posts.warm_up is
  'A post a warm-up visit liked, kept for its one comment while they decide on the request (decision 161).';

alter table addon_outreach.friend_ends
  add column after_warm_up boolean not null default false;

comment on column addon_outreach.friend_ends.after_warm_up is
  'Withdrawn because the warm-up ended with no answer: nothing reaches them again unless they follow back, accept or write first (decision 161).';

alter table addon_outreach.friends
  add column warm_up_from timestamptz;

comment on column addon_outreach.friends.warm_up_from is
  'When warm-ups began, for a request already waiting then: its wait runs from the later of this and since (decision 161).';

update addon_outreach.friends
  set warm_up_from = now()
  where state = 'request_sent';

update app.addon_installations
  set settings = jsonb_set(settings, '{cancelRequestsAfterWeeks}', '2'::jsonb)
  where addon_id = 'outreach' and settings -> 'cancelRequestsAfterWeeks' = '3'::jsonb;
