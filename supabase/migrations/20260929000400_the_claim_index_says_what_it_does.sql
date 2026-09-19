-- =============================================================================
-- 0082 · The index that describes the order, and a sequence that belongs to
--        its column (M11). Follows 0081, which changed what the claim sorts on
--        and left two loose ends behind it.
--
--        `migration_jobs_claim` still ended in `id`, and the claim now orders
--        by `sequence`. Worth being exact about what that costs, because it is
--        less than it looks: the claim's WHERE is an OR across two disjoint
--        states, and `explain (analyze, buffers)` on the hosted database shows
--        a BitmapOr feeding an explicit Sort. Postgres cannot walk one index in
--        order to satisfy an OR of two different conditions, so the Sort is
--        structural rather than a symptom of the wrong column, and the index's
--        third column is not read for ordering either way.
--
--        So this is not a speed fix and is not offered as one. It is an index
--        that describes the order the code actually asks for, which is what the
--        next person reading it will assume it does — and if the claim is ever
--        rewritten to read the two states apart, it is already right.
-- =============================================================================

drop index if exists app.migration_jobs_claim;
create index migration_jobs_claim on app.migration_jobs (pass, run_at, sequence)
  where state in ('pending', 'retry');
comment on index app.migration_jobs_claim is
  'What to pick up next: the earliest due batch of the lowest pass, and between batches due at the same moment, the one made first.';

-- The sequence belongs to the column it fills, so dropping the column takes it too rather than leaving it
-- behind with nothing to number.
alter sequence app.migration_jobs_sequence_seq owned by app.migration_jobs.sequence;
