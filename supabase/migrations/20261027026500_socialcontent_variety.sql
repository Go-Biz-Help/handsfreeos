-- =============================================================================
-- AI Social Media Content Creator: variety on the calendar
-- (docs/socialcontent.md, "Variety"; decisions 34 to 38, the owner, 12 Nov).
--
--        Each post and idea is one kind in the weekly mix (`angle`: a tip, a
--        customer's problem, a story, or the offer), about one line from the
--        main offer's lists for content (`topic_list`, `topic`), so the lists
--        take turns and a line comes round again only after the others. An idea
--        found by looking things up online keeps where it came from
--        (`source_url`, `source_name`).
--
--        The AI's drafts from before have no kind, and that's how the worker
--        knows to write them again with the new variety (decision 37).
--
--        **ai.web_search** joins the card: one web search the AI makes to look
--        up news and facts for the business's posts, at 1.5x what it costs us.
--
--        Only adds columns that may be empty, so the running code keeps working.
-- =============================================================================

alter table addon_socialcontent.content
  add column angle text check (angle in ('tip', 'problem', 'story', 'offer')),
  add column topic_list text,
  add column topic text;

alter table addon_socialcontent.ideas
  add column angle text check (angle in ('tip', 'problem', 'story', 'offer')),
  add column topic_list text,
  add column topic text,
  add column source_url text,
  add column source_name text;

-- ---------- the card ----------
-- Mirrors core's USAGE_KEYS; packages/db/test/parity.test.ts asserts the two lists are identical. The key joins
-- whatever the check allows now, so a migration from another branch that adds keys of its own keeps them.
do $$
declare
  allowed text[];
begin
  select array_agg(t.m[1] order by t.n) into allowed
  from pg_constraint c
  cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') with ordinality as t(m, n)
  where c.conrelid = 'platform.usage_rates'::regclass and c.conname = 'usage_rates_key_check';
  if allowed is null then
    raise exception 'platform.usage_rates has no usage_rates_key_check to add ai.web_search to';
  end if;
  allowed := allowed || array(select k from unnest(array['ai.web_search']) as k where k <> all (allowed));
  alter table platform.usage_rates drop constraint usage_rates_key_check;
  execute format(
    'alter table platform.usage_rates add constraint usage_rates_key_check check (key in (%s))',
    (select string_agg(quote_literal(k), ', ' order by i) from unnest(allowed) with ordinality as u(k, i))
  );
end $$;

-- Kept in step with core's SEED_RATES: what Anthropic charges for one web search ($10 for 1,000), at 1.5x.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, 'ai.web_search', 'fee'::platform.usage_unit, 10000, 15000, 1, 'none',
  'One web search the AI makes to look up news and facts for a business''s own posts, $0.01. Charged 2c.'
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
where not exists (select 1 from platform.usage_rates r where r.key = 'ai.web_search' and r.effective_to is null);

-- The calendar's next run comes in half an hour, not next week, so the drafts are
-- written again soon after this goes live (pick 4a). Half an hour leaves room for
-- the deploy: this runs just before the code that knows what to do reaches the worker.
update app.scheduled_jobs
  set run_at = least(run_at, now() + interval '30 minutes')
  where kind = 'socialcontent.calendar' and status = 'pending' and locked_at is null;
