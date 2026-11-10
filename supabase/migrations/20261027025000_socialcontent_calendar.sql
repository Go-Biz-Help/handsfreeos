-- =============================================================================
-- AI Social Media Content Creator: the business's own posts and its calendar
-- (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, "Making and posting the business's own content", part 8;
-- docs/socialcontent.md, "Making posts").
--
--        **Content** is one row per Social post, a record of the kind this
--        add-on manages (`socialcontent_post`, made by the worker as the
--        add-on arrives or turns on): the network it's for, its format, its
--        words, hook and hashtags, a carousel's slides or a video's script,
--        what its picture shows and how it's made (designed by Claude, a
--        photo-style picture from OpenAI, or the person's own), its pictures
--        (core files on the record, in order), where on Facebook it goes,
--        when it goes, and whether it's OK'd (decision 15). Nothing goes up
--        without an OK; changing an OK'd post takes the OK back.
--
--        Where the add-on was already on, the Social post kind is made here.
--
--        **Settings** gain the calendar's plan (how many posts a week on each
--        network, and the time: decision 18), the business's Facebook Page and
--        where Facebook posts go (decision 17), and when the calendar was
--        last filled.
--
--        **ai.image** joins the card: a photo-style picture OpenAI makes, per
--        picture, at 1.5x what it costs us. A designed picture is drawn by the
--        worker from Claude's design and costs only the AI's words.
-- =============================================================================

-- ---------- the Social post kind ----------
-- The worker makes an add-on's kinds of records as it arrives (apps/worker/src/addons/reconcile.ts). Where this
-- add-on was already on, the kind is made here, the way the worker makes it: shown where the add-on is on, hidden
-- where it's off (private.addon_show_records brings it back with the add-on).
insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position, addon_id,
  write_permission, kept_to_team, see_all_permission, archived_at)
select i.workspace_id, 'socialcontent_post', 'Social post', 'Social posts', 'Title', 'file', 900, 'socialcontent',
  'socialcontent.use', false, null, case when i.state in ('installing', 'enabled') then null else now() end
from app.addon_installations i
where i.addon_id = 'socialcontent' and i.state <> 'purged'
on conflict (workspace_id, addon_id, key) where addon_id is not null do nothing;

-- ---------- content ----------
create table addon_socialcontent.content (
  record_id uuid primary key references app.custom_records (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The idea it was written from; a deleted idea just stops showing.
  idea_id uuid references addon_socialcontent.ideas (id) on delete set null,
  network text not null check (network in ('instagram', 'facebook', 'linkedin', 'tiktok', 'youtube')),
  format text not null default 'photo' check (format in ('photo', 'carousel', 'video', 'text')),
  words text not null default '' check (length(words) <= 3000),
  hook text check (hook is null or length(hook) <= 300),
  hashtags text[] not null default '{}' check (cardinality(hashtags) <= 30),
  -- A carousel's slides: [{heading, body}], up to 10.
  slides jsonb not null default '[]'::jsonb check (jsonb_typeof(slides) = 'array' and jsonb_array_length(slides) <= 10),
  -- A video's script: {lines: [...], shots: [...]}.
  script jsonb check (script is null or jsonb_typeof(script) = 'object'),
  -- What its picture shows, or what to shoot.
  picture text check (picture is null or length(picture) <= 600),
  picture_way text not null default 'design' check (picture_way in ('design', 'photo', 'own')),
  picture_state text not null default 'none'
    check (picture_state in ('none', 'waiting', 'making', 'made', 'failed')),
  picture_failure text check (picture_failure is null or length(picture_failure) <= 300),
  -- Claude's design, kept to draw it again.
  design jsonb check (design is null or jsonb_typeof(design) = 'object'),
  -- Its pictures, core files on the record, in the order they go up.
  file_ids uuid[] not null default '{}' check (cardinality(file_ids) <= 10),
  -- Where a Facebook post goes: the person's profile, the business's Page, or both.
  facebook_where text[] not null default '{}'
    check (facebook_where <@ array['profile', 'page']::text[] and (network = 'facebook' or cardinality(facebook_where) = 0)),
  state text not null default 'draft' check (state in ('draft', 'ready', 'posting', 'posted', 'failed', 'skipped')),
  post_at timestamptz,
  approved_by uuid references app.users (id) on delete set null,
  approved_at timestamptz,
  posted_at timestamptz,
  post_link text check (post_link is null or length(post_link) <= 500),
  failure text check (failure is null or length(failure) <= 300),
  made_by text not null default 'ai' check (made_by in ('ai', 'person')),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, record_id),
  check ((state in ('ready', 'posting', 'posted')) = (approved_at is not null) or state = 'failed')
);
create index content_calendar_idx on addon_socialcontent.content (workspace_id, post_at);
create index content_state_idx on addon_socialcontent.content (workspace_id, state, post_at);
create index content_idea_idx on addon_socialcontent.content (idea_id) where idea_id is not null;
create index content_approved_by_idx on addon_socialcontent.content (approved_by) where approved_by is not null;
create index content_created_by_idx on addon_socialcontent.content (created_by) where created_by is not null;

-- A content row is about one of the add-on's Social post records in the same business.
create or replace function addon_socialcontent.check_content()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
      select 1 from app.custom_records r
      join app.custom_record_types t on t.id = r.type_id
      where r.id = new.record_id and r.workspace_id = new.workspace_id
        and t.addon_id = 'socialcontent' and t.key = 'socialcontent_post') then
    raise exception 'A post is one of AI Social Media Content Creator''s Social post records in this business'
      using errcode = '23514', detail = 'socialcontent_not_a_post';
  end if;
  return new;
end $$;
create trigger content_check before insert or update of record_id, workspace_id on addon_socialcontent.content
  for each row execute function addon_socialcontent.check_content();

select private.addon_table_policies('addon_socialcontent.content', 'socialcontent.use', 'socialcontent.use');

-- ---------- settings ----------
alter table addon_socialcontent.settings
  -- How many posts a week on each network, and when: {"instagram": {"perWeek": 3, "time": "09:00"}, ...}.
  add column plan jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object'),
  add column facebook_page text check (facebook_page is null or length(facebook_page) <= 500),
  add column facebook_where text[] not null default '{profile}'
    check (facebook_where <@ array['profile', 'page']::text[] and cardinality(facebook_where) >= 1),
  add column filled_at timestamptz;

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
    raise exception 'platform.usage_rates has no usage_rates_key_check to add ai.image to';
  end if;
  allowed := allowed || array(select k from unnest(array['ai.image']) as k where k <> all (allowed));
  alter table platform.usage_rates drop constraint usage_rates_key_check;
  execute format(
    'alter table platform.usage_rates add constraint usage_rates_key_check check (key in (%s))',
    (select string_agg(quote_literal(k), ', ' order by i) from unnest(allowed) with ordinality as u(k, i))
  );
end $$;

-- Kept in step with core's SEED_RATES: about what OpenAI charges for one portrait picture at medium quality, at 1.5x.
insert into platform.usage_rates (version, key, unit, cost_micros, markup_bp, min_charge_cents, round_up_to, notes)
select live.version, 'ai.image', 'fee'::platform.usage_unit, 60000, 15000, 9, 'none',
  'One photo-style picture from OpenAI''s image model (portrait, medium quality), about $0.06. Charged 9c.'
from (select coalesce(max(version), 1) as version from platform.usage_rates where effective_to is null) live
where not exists (select 1 from platform.usage_rates r where r.key = 'ai.image' and r.effective_to is null);
