-- Social Outreach: what each person does and where, and the person's own town, radius and local focus (decision 177).
--
-- The owner, 18 Nov 2026: "this means we should be keeping track of the area people are in and service if they are a
-- local business", and "we should have a setting to focus on groups in our local area ... this means we need to add
-- our location and a radius for local meetings". Their picks: the AI fills each person's line of work, town and
-- whether they serve local customers, nationwide or online, from their page and the chat, and the person can change
-- it on their card (1a); each teammate sets their own town and radius in Settings → You (2a); the local focus switch
-- adds their town and the towns near it to group searches, ranks local groups higher and puts people near them first
-- on Today (3).
--
-- On a profile (the business's, as `country` is): `work` ("roofing"), `area` as it reads ("Austin, TX"), `town` the
-- area as a known US town ("austin-tx", ./packages/core/src/addons/outreach/local.ts `townOfArea`), `reach`, and how
-- it's known: `page` (their page), `chat` (the chat) or `typed` (a person typed it, which the AI never writes over).
-- On the person's own settings row: their town, its radius in miles and the local focus switch.

alter table addon_outreach.profiles
  add column work text check (work is null or char_length(work) between 1 and 80),
  add column area text check (area is null or char_length(area) between 1 and 80),
  add column town text check (town is null or town ~ '^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{2}$'),
  add column reach text check (reach in ('local', 'nationwide', 'online')),
  add column area_how text check (area_how in ('page', 'chat', 'typed')),
  add column area_at timestamptz,
  add column area_by uuid references app.users (id) on delete set null,
  add constraint profiles_area_known check ((area_how is null) = (area_at is null));

alter table addon_outreach.automation
  add column home_area text check (home_area is null or char_length(home_area) between 1 and 80),
  add column home_town text check (home_town is null or home_town ~ '^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{2}$'),
  add column radius_miles smallint not null default 25 check (radius_miles between 5 and 100),
  add column local_focus boolean not null default false,
  add constraint automation_home_known check ((home_area is null) = (home_town is null));
