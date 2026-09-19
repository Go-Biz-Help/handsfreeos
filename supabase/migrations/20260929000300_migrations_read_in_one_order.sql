-- =============================================================================
-- 0081 · Two runs of one migration should do the same thing (M11).
--
--        `migration.start` spaces each sub-account's batches a millisecond
--        apart, on purpose, and says why: "when two sub-accounts hold the same
--        customer, which one is read first decides which record the other
--        joins". The claim did not keep that promise. It ordered by
--        `pass, run_at, id`, and `id` is a random uuid — so every batch that
--        shared a `run_at` was claimed in an order nobody chose.
--
--        That is not only untidy. A contact whose email matches one customer
--        and whose phone matches another is a question for a person, and the
--        engine can only see the question once both of those customers have
--        landed. Read in one order it is a question; read in another it is a
--        silent merge. Same data, different answer, decided by a uuid.
--
--        So a batch now carries the order it was made in, and that is what
--        breaks the tie. A requeued page keeps its place, which is what makes
--        page two of the first sub-account still come before page one of the
--        second.
-- =============================================================================

create sequence if not exists app.migration_jobs_sequence_seq;
alter table app.migration_jobs add column sequence bigint;

-- What is already queued keeps the order it was made in, as closely as that can now be known.
-- The guard on this table exists to stop a person rewriting what a batch did; it has no opinion worth
-- hearing about a column being backfilled, and a finished batch would trip it, so it stands down for one
-- statement.
alter table app.migration_jobs disable trigger migration_jobs_update_guard;
update app.migration_jobs j
   set sequence = ordered.n
  from (select id, row_number() over (order by created_at, id) as n from app.migration_jobs) ordered
 where ordered.id = j.id;
alter table app.migration_jobs enable trigger migration_jobs_update_guard;
select setval('app.migration_jobs_sequence_seq',
  greatest((select coalesce(max(sequence), 0) from app.migration_jobs), 1));

alter table app.migration_jobs alter column sequence set default nextval('app.migration_jobs_sequence_seq');
alter table app.migration_jobs alter column sequence set not null;

comment on column app.migration_jobs.sequence is
  'The order this batch was made in. Breaks the tie between batches due at the same moment, so two runs of one migration read in the same order.';

-- The claim, reading in that order.
create or replace function private.claim_migration_jobs(p_worker text, p_limit integer, p_lease_seconds integer)
returns setof app.migration_jobs
language sql volatile security definer set search_path = '' as $$
  with due as (
    select j.id from app.migration_jobs j
    join app.migrations m on m.id = j.migration_id
    where (j.state in ('pending', 'retry') and j.run_at <= now()
           or (j.state = 'leased' and j.leased_until < now()))
      and m.status in ('scanning', 'importing', 'verifying', 'transition', 'finalizing', 'rolling_back')
    -- `sequence`, not `id`: a uuid is not an order, and this one decided answers.
    order by j.pass, j.run_at, j.sequence
    limit greatest(p_limit, 0)
    for update of j skip locked
  )
  update app.migration_jobs j
     set state = 'leased',
         leased_by = p_worker,
         leased_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         attempts = j.attempts + 1
    from due where j.id = due.id
  returning j.*
$$;

-- The default is read when a batch is inserted, so whoever may insert one needs the sequence.
grant usage, select on sequence app.migration_jobs_sequence_seq to authenticated, service_actor;
