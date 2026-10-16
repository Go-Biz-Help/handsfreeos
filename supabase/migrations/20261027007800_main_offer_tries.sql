-- =============================================================================
-- The main offer: the owner's direction and the AI's tries
--        (HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md, step 1).
--        The direction is the owner's own words for the whole offer: what it
--        really is, who it's for, what to lead with. Every score and try reads
--        it until someone changes or clears it.
--        A try is a whole new version of the offer the AI wrote from the
--        direction and the owner's notes, kept beside the draft, never changed
--        after. Nothing in the draft changes until someone picks parts of it
--        (main_offer.try_apply).
--
-- Only adds: the code running now reads and writes nothing here.
-- =============================================================================

alter table app.main_offers
  add column direction text check (direction is null or length(btrim(direction)) between 1 and 2000);

create table app.main_offer_tries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The live version when it was made, 0 before the first: a round's tries are the ones the builder lists.
  round integer not null check (round >= 0),
  -- Try 1, 2, 3 within the round.
  number integer not null check (number >= 1),
  -- The draft's revision it was written from, and the draft's parts as it read them (what Restore puts back).
  from_revision integer not null check (from_revision >= 0),
  base jsonb not null check (jsonb_typeof(base) = 'object' and octet_length(base::text) <= 40000),
  -- The try's whole offer (packages/core/src/main-offer/parts.ts, MainOfferParts).
  parts jsonb not null check (jsonb_typeof(parts) = 'object' and octet_length(parts::text) <= 40000),
  -- For each scored part, why it changed; null for a part it kept.
  why jsonb not null check (jsonb_typeof(why) = 'object' and octet_length(why::text) <= 10000),
  -- The AI's score of the try as a whole, with the direction.
  score jsonb not null check (jsonb_typeof(score) = 'object' and octet_length(score::text) <= 20000),
  -- What it followed: the direction as it was then, the notes on each part and the parts kept as they were.
  direction text check (direction is null or length(btrim(direction)) between 1 and 2000),
  notes jsonb not null default '{}' check (jsonb_typeof(notes) = 'object' and octet_length(notes::text) <= 10000),
  keep jsonb not null default '[]' check (jsonb_typeof(keep) = 'array'),
  made_by uuid references app.users (id) on delete set null,
  made_at timestamptz not null default now(),
  unique (workspace_id, round, number)
);
create trigger main_offer_tries_append_only before update on app.main_offer_tries
  for each row execute function private.forbid_change();

alter table app.main_offer_tries enable row level security;

-- Everyone in the business reads them, as they read the draft. Only the worker keeps one (main_offer.try_save).
create policy main_offer_tries_select on app.main_offer_tries for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy main_offer_tries_service_all on app.main_offer_tries for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.main_offer_tries to authenticated;
grant select, insert on app.main_offer_tries to service_actor;
revoke all on app.main_offer_tries from anon;
