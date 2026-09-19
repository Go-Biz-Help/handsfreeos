-- =============================================================================
-- 0082 · Lead intake, slice B: forms and connected apps. Slice A (0072) gave a
--        business the three channels people reach them on. This gives the ways
--        a lead arrives from somewhere else entirely: a form on their own
--        website posting straight in, and a service like Zapier or a developer
--        sending one over.
--
--        Both are rows in app.intake_sources, so they land in the same place,
--        under the same daily limit, pointed at the same pipelines, and shown
--        on the same screen as texts, calls and email.
--
--        How each is trusted apart:
--        - `website_form` carries a public key (ik_ and 20 characters). It sits
--          in the page's HTML, so it is not a secret: what makes it safe is the
--          list of sites it may be posted from, the bot check, and the limits.
--        - `api` carries a secret key, kept only as its SHA-256. It is shown
--          once, when it is made, and never again — a lost one is replaced.
--
--        Every submission is written down (app.intake_submissions), so a sender
--        that retries can't open the same lead twice and a business can see
--        what actually arrived.
-- =============================================================================

-- A form's public key: ik_ and 20 random base62 characters, the chat widget's shape (0033).
create or replace function private.new_intake_key()
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_key text := '';
  b bytea;
  v integer;
begin
  while length(v_key) < 20 loop
    b := extensions.gen_random_bytes(32);
    for i in 0..31 loop
      v := get_byte(b, i);
      -- 248 = 4 × 62: dropping the bytes above it keeps every character equally likely.
      if v < 248 and length(v_key) < 20 then
        v_key := v_key || substr(alphabet, (v % 62) + 1, 1);
      end if;
    end loop;
  end loop;
  return 'ik_' || v_key;
end $$;

-- The sites a form may be posted from: exact https origins, or a loopback one while it is being tried.
create or replace function private.valid_intake_origins(p_origins text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(p_origins) <= 10, false)
    and array_position(p_origins, null) is null
    and (select count(distinct x.o) from unnest(p_origins) as x (o)) = cardinality(p_origins)
    and not exists (
      select 1 from unnest(p_origins) as x (o)
      where x.o !~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{1,5})?$'
        and x.o !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$')
$$;

alter table app.intake_sources
  -- A form's key, in the page's HTML. Rotating it retires every copy of the form pasted before.
  add column public_key text unique check (public_key is null or public_key ~ '^ik_[A-Za-z0-9]{20}$'),
  -- A connected app's key, kept only as its SHA-256; the key itself is shown once and never stored.
  add column secret_hash bytea check (secret_hash is null or length(secret_hash) = 32),
  -- The last four characters of that key, so two of them can be told apart on screen.
  add column secret_hint text check (secret_hint is null or length(secret_hint) = 4),
  -- The sites a form may be posted from; empty accepts none, which is how a new one starts.
  add column allowed_origins text[] not null default '{}'::text[] check (private.valid_intake_origins(allowed_origins)),
  -- Where a plain HTML form's sender is taken afterwards (a thank-you page); null answers with JSON.
  add column redirect_url text check (redirect_url is null or (redirect_url ~ '^https://' and length(redirect_url) <= 2000)),
  add column last_used_at timestamptz,
  add column archived_at timestamptz,
  add column archived_by uuid references app.users (id) on delete set null,
  -- A channel is reached by its own doors and carries no key. A form posted in from somewhere else carries a
  -- public one; a form built here has none, and is the row its leads file under. An app has a secret key.
  add constraint intake_sources_keys_match_kind check (
    case kind
      when 'website_form' then secret_hash is null
      when 'api' then secret_hash is not null and secret_hint is not null and public_key is null
      else public_key is null and secret_hash is null and cardinality(allowed_origins) = 0
        and redirect_url is null
    end);

-- One keyless website_form row per business: the one the forms built here file their leads under.
create unique index intake_sources_own_forms_unique on app.intake_sources (workspace_id)
  where kind = 'website_form' and public_key is null;

-- The unique index in 0072 keeps one row per channel; archived forms and keys keep their names free.
create index intake_sources_keyed_idx on app.intake_sources (workspace_id, kind, archived_at);

-- ---------- what arrived, and once ----------
create table app.intake_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  source_id uuid not null references app.intake_sources (id) on delete cascade,
  -- The sender's own id for this submission, or one we make from what it sent. A retry finds this row.
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  person_id uuid references app.people (id) on delete set null,
  lead_id uuid references app.leads (id) on delete set null,
  outcome text not null check (outcome in ('opened', 'matched', 'refused')),
  -- Why it opened nothing: over the day's limit, no way to reach them, the source turned off.
  refused_reason text check (refused_reason is null or length(refused_reason) <= 80),
  -- What the sender actually sent, so a business can see it and a developer can fix their end.
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  received_at timestamptz not null default now(),
  unique (source_id, dedupe_key)
);
create index intake_submissions_recent_idx on app.intake_submissions (workspace_id, received_at desc);
create index intake_submissions_person_idx on app.intake_submissions (person_id) where person_id is not null;

-- References stay inside the business, whoever writes.
create or replace function private.check_intake_submission_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.intake_sources s
      where s.id = new.source_id and s.workspace_id = new.workspace_id)
    or (new.person_id is not null and not exists (
      select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
    or (new.lead_id is not null and not exists (
      select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger intake_submissions_check_refs before insert or update on app.intake_submissions
  for each row execute function private.check_intake_submission_refs();

-- ---------- the doors: a key, and what it opens ----------
-- Both run as the definer because the caller is signed out: the worker holds the key it was given and
-- nothing else. Neither ever returns the secret hash.
create or replace function private.intake_form_lookup(p_public_key text)
returns table (source_id uuid, workspace_id uuid, organization_id uuid, active boolean,
  allowed_origins text[], redirect_url text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.workspace_id, w.organization_id, s.active and s.archived_at is null,
    s.allowed_origins, s.redirect_url
  from app.intake_sources s
  join app.workspaces w on w.id = s.workspace_id
  where p_public_key ~ '^ik_[A-Za-z0-9]{20}$' and s.public_key = p_public_key and s.kind = 'website_form'
$$;

create or replace function private.intake_key_lookup(p_secret_hash bytea)
returns table (source_id uuid, workspace_id uuid, organization_id uuid, active boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.workspace_id, w.organization_id, s.active and s.archived_at is null
  from app.intake_sources s
  join app.workspaces w on w.id = s.workspace_id
  where length(p_secret_hash) = 32 and s.secret_hash = p_secret_hash and s.kind = 'api'
$$;

-- ---------- RLS ----------
alter table app.intake_submissions enable row level security;

create policy intake_submissions_select on app.intake_submissions for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy intake_submissions_service_all on app.intake_submissions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- The secret hash is nobody's to read: people see every other column, and the worker writes them all.
revoke select on app.intake_sources from authenticated;
grant select (id, workspace_id, kind, name, active, create_lead, pipeline_id, stage_id, daily_cap,
  day_count, day_on, last_intake_at, created_by, created_at, updated_at, public_key, secret_hint,
  allowed_origins, redirect_url, last_used_at, archived_at, archived_by)
  on app.intake_sources to authenticated;
-- Keys are write-only for people: intake_source.create and rotate_key set them (channels.manage gates both
-- through RLS), and nobody reads a secret hash back.
grant update (name, active, create_lead, pipeline_id, stage_id, daily_cap, allowed_origins, redirect_url,
  archived_at, archived_by, public_key, secret_hash, secret_hint) on app.intake_sources to authenticated;
grant select on app.intake_submissions to authenticated;
grant select, insert, update on app.intake_submissions to service_actor;

revoke all on function private.new_intake_key(), private.valid_intake_origins(text[]),
  private.check_intake_submission_refs(), private.intake_form_lookup(text), private.intake_key_lookup(bytea)
  from public;
-- The key is made when a form is added and the origins are a column check, so whoever inserts runs them.
grant execute on function private.new_intake_key(), private.valid_intake_origins(text[]),
  private.check_intake_submission_refs() to authenticated, service_actor;
grant execute on function private.intake_form_lookup(text), private.intake_key_lookup(bytea) to service_actor;
