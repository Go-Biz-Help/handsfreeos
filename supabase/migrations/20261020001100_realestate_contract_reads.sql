-- =============================================================================
-- Real Estate Agent, round four, step 2: reading contracts and amendments.
--
--        Chris decided (2026-10-02): the AI reads a deal's contracts and
--        amendments (the parties, the money, every date and contingency, each
--        with its clause), scans too, and a person confirms each value before
--        it counts. Nothing is guessed: a value the AI can't place exactly is
--        listed for a person to look at.
--
--        **contract_reads**: one reading of one document: reading, read or
--        failed; whether it was a scan (the AI read the page images, so every
--        value says so); the model; why it failed. `found` holds each value
--        the reading found, with its clause, page and the words it came from,
--        and whether a person confirmed it (and the key date entry that made)
--        or set it aside. `unclear` holds what it couldn't place. Reading a
--        document again is a new row; the older one stays.
--
--        **term_entries** gains where a confirmed value was read: the words,
--        the page, the reading, and whether it was read from a scan.
-- =============================================================================

create table addon_realestate.contract_reads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  document_id uuid not null,
  kind text not null check (kind in ('contract', 'amendment', 'addendum')),
  state text not null default 'reading' check (state in ('reading', 'read', 'failed')),
  scan boolean not null default false,
  pages integer check (pages is null or pages >= 0),
  model text check (model is null or length(model) <= 200),
  failure text check (failure is null or length(btrim(failure)) between 1 and 500),
  found jsonb not null default '[]'::jsonb check (jsonb_typeof(found) = 'array'),
  unclear jsonb not null default '[]'::jsonb check (jsonb_typeof(unclear) = 'array'),
  dropped integer not null default 0 check (dropped >= 0),
  requested_by uuid references app.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  read_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((state = 'failed') = (failure is not null)),
  check ((state = 'reading') = (read_at is null)),
  foreign key (workspace_id, document_id) references addon_realestate.documents (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
-- One reading at a time per document.
create unique index contract_reads_one_reading on addon_realestate.contract_reads (document_id)
  where state = 'reading';
create index contract_reads_deal_idx on addon_realestate.contract_reads
  (workspace_id, deal_record_id, requested_at desc);
create index contract_reads_document_idx on addon_realestate.contract_reads
  (workspace_id, document_id, requested_at desc);
create index contract_reads_requested_by_idx on addon_realestate.contract_reads (requested_by)
  where requested_by is not null;
select private.addon_table_policies('addon_realestate.contract_reads', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

alter table addon_realestate.term_entries
  add column quote text check (quote is null or length(btrim(quote)) between 1 and 600),
  add column page integer check (page is null or page >= 1),
  add column read_id uuid,
  add column scan boolean not null default false,
  add foreign key (workspace_id, read_id) references addon_realestate.contract_reads (workspace_id, id)
    on delete set null (read_id);
create index term_entries_read_idx on addon_realestate.term_entries (read_id) where read_id is not null;

comment on column addon_realestate.term_entries.quote is
  'The words a value was read from (round four): set when a person confirmed a value the AI read in a contract or amendment.';
comment on column addon_realestate.term_entries.scan is
  'The value was read from a scan''s page images, not the document''s text, so a person checks it closely.';
