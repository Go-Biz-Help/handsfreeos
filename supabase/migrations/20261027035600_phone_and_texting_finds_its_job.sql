-- Settings → Texting & calls finds its own job by an index (speed audit, Nov 2026).
--
-- The screen, and the Assistant when it's asked whether Phone & texting is on, look for the business's latest
-- "turn it on" job: `where workspace_id = … and kind = 'telephony.account_open' order by created_at desc limit 1`.
-- No index starts with the business, so each look read the whole job table and sorted it: 260 ms on average and
-- 1.5 s at worst on the live database (104 looks, 41,000 rows), and slower with every business that joins, since
-- the table holds every finished job of the last 30 days.
--
-- Partial, on that one kind: a business has a row or two of it, so the index stays a page or two, and none of the
-- table's other writes (750,000 updates in 73 days) pays for it.

create index if not exists scheduled_jobs_account_open_idx
  on app.scheduled_jobs (workspace_id, created_at desc)
  where kind = 'telephony.account_open';
