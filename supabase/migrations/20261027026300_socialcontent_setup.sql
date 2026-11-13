-- AI Social Media Content Creator setting itself up (docs/socialcontent.md, "Setting up on its own"; the owner's
-- decisions 28 to 33, 12 Nov 2026): once the add-on is on and a reading computer is picked, it ticks the business's
-- own niche and the 2 closest, finds creators, picks the best 10 on each network, studies them, and fills the
-- calendar once the Playbook is written (or after 3 days) and the main offer and its lists for content are ready.
--
-- Adds columns only, so the running code keeps working.

-- Whether it picks niches and creators on its own (on until an owner or admin turns it off), and the steps of its
-- setup it has taken: { startedAt, nichesAt, findAt, writeAt }, each an ISO time.
alter table addon_socialcontent.settings
  add column auto_pick boolean not null default true,
  add column setup jsonb not null default '{}'::jsonb
    check (jsonb_typeof(setup) = 'object' and octet_length(setup::text) <= 2000);

-- Who picked a creator to study or skipped them: the AI or a person. The AI never drops one a person ticked or
-- added, and never picks one a person skipped (decision 31). How close the AI found them to what the business does
-- (0 to 10, decision 30) and why; and their likes and comments for their followers, from their latest posts.
alter table addon_socialcontent.creators
  add column picked_by text check (picked_by in ('ai', 'person')),
  add column match smallint check (match between 0 and 10),
  add column match_why text check (match_why is null or length(match_why) <= 300),
  add column matched_at timestamptz,
  add column engagement numeric(9, 6) check (engagement is null or engagement >= 0),
  add column recent jsonb
    check (recent is null or (jsonb_typeof(recent) = 'array' and octet_length(recent::text) <= 4000));

-- Everyone ticked, skipped or added so far was a person's doing.
update addon_socialcontent.creators set picked_by = 'person'
  where found_by = 'person' or (state in ('studying', 'skipped') and decided_by is not null);

-- A business already under way has taken the steps a setup would: it isn't set up again. One that filled its
-- calendar has written.
update addon_socialcontent.settings s
  set setup = jsonb_strip_nulls(jsonb_build_object(
    'startedAt', to_jsonb(now()),
    'nichesAt', to_jsonb(now()),
    'findAt', to_jsonb(now()),
    'writeAt', case when s.filled_at is not null then to_jsonb(s.filled_at) end))
  where s.filled_at is not null
     or exists (select 1 from addon_socialcontent.niches n where n.workspace_id = s.workspace_id);
