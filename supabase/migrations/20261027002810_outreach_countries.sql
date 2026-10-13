-- Social Outreach: only engage people in certain countries, or not in them (docs/outreach.md, decision 60). Each
-- person kept as a profile has the country their profile shows (seen), or the AI's guess from their name, posts and
-- groups (guessed), or that nothing said (unknown), and when. The business's setting lives in the add-on's settings
-- (`countries`); someone it skips can be let through for good with Unskip (`country_through`, by whom and when).
alter table addon_outreach.profiles
  add column country text check (country ~ '^[A-Z]{2}$'),
  add column country_how text check (country_how in ('seen', 'guessed', 'unknown')),
  add column country_at timestamptz,
  add column country_through boolean not null default false,
  add column country_through_by uuid references app.users (id) on delete set null,
  add column country_through_at timestamptz,
  add constraint profiles_country_known_check
    check ((country_how is null) = (country_at is null) and (country is null or country_how in ('seen', 'guessed')));

-- The Skipped for country list and the queries' filter read a business's people by country.
create index profiles_country_idx on addon_outreach.profiles (workspace_id, country) where country is not null;
create index profiles_country_through_by_idx on addon_outreach.profiles (country_through_by)
  where country_through_by is not null;
