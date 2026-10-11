-- =============================================================================
-- Social Outreach (outreach): posts asking for what the business offers,
-- fast (docs/outreach.md, decision 49).
--
--        In the person's working hours, the extension looks at the newest
--        posts in their best groups every hour or two (`found` = 'watch').
--        The AI's check of a post now also says whether it's a strong fit:
--        the writer is asking, now, for what the business offers
--        (`strong`). A strong one pushes to the person's phone at once and
--        goes to the top of their list for today.
--
--        Looking every hour or two is each person's choice
--        (`automation.watch_posts`): on to start.
--
-- Only adds: two columns, and a kind more that `found` takes.
-- =============================================================================

alter table addon_outreach.posts
  add column strong boolean not null default false;
alter table addon_outreach.posts drop constraint posts_found_check;
alter table addon_outreach.posts add constraint posts_found_check
  check (found in ('scroll', 'find', 'watch'));

alter table addon_outreach.automation
  add column watch_posts boolean not null default true;
