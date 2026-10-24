-- Social Outreach: where people live, Lives in first and their friends as evidence (docs/outreach.md, decision 86;
-- HANDSFREEOS_OUTREACH_COUNTRY_CHECK_IMPLEMENTATION_PLAN.md).
--
-- A person's country is now known, the strongest first, as `seen` (a "Lives in" on their profile), `friends` (what a
-- look at their profile and mutual friends came to), `from` (only a "From" line) or `guessed` (the AI's guess). A From
-- or a guess never skips anyone: they wait for a look, a check that also reads their mutual friends. A look keeps the
-- country they're from, a second country when the facts split, whether it couldn't tell, the AI's line, and where
-- their mutual friends live. A person's Skip, from the Not sure list, sits beside Unskip. Every country seen until now
-- counts as From in the next migration, applied once the code that reads `from` is running.
alter table addon_outreach.profiles
  drop constraint profiles_country_known_check,
  drop constraint profiles_country_how_check,
  add constraint profiles_country_how_check
    check (country_how in ('seen', 'friends', 'from', 'guessed', 'unknown')),
  add column country_from text check (country_from ~ '^[A-Z]{2}$'),
  add column country_alt text check (country_alt ~ '^[A-Z]{2}$'),
  add column country_why text check (char_length(country_why) <= 200),
  add column country_unsure boolean not null default false,
  add column country_looked_at timestamptz,
  add column country_mutual jsonb check (country_mutual is null or jsonb_typeof(country_mutual) = 'object'),
  add column country_skip boolean not null default false,
  add column country_skip_by uuid references app.users (id) on delete set null,
  add column country_skip_at timestamptz,
  add column friends_count integer check (friends_count is null or friends_count between 0 and 1000000),
  add constraint profiles_country_known_check
    check ((country_how is null) = (country_at is null)
      and (country is null or country_how in ('seen', 'friends', 'from', 'guessed')));

create index profiles_country_skip_by_idx on addon_outreach.profiles (country_skip_by)
  where country_skip_by is not null;

-- A look's mutual friends, matched to the people the business keeps, wait with its lines for the AI and go with them.
alter table addon_outreach.checks
  add column mutual_ids uuid[] not null default '{}',
  add column mutual_read integer check (mutual_read is null or mutual_read between 0 and 100000);
