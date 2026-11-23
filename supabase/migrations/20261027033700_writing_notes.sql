-- =============================================================================
-- Social Outreach: how people write on a network, in messages (decision 191)
--
-- The comment research (decisions 166 and 172) learns how real comments are
-- written on each network, and its guide reaches comments through
-- platform.comment_guides. This adds the same switch for the AI's other
-- writing there (first messages, replies, follow-ups, answers to comments): a
-- short note made from a research's counts (how many use an emoji, how a line
-- ends, lower case, everyday words), with no comment in it.
--
-- `platform.writing_notes` is the note every business's messages on a network
-- are written with, once staff press Use it: one in use a network, apart from
-- the comment guide, so either is on without the other. The worker reads it;
-- nobody writes it but through the definers below. It names the research it
-- came from as a label, not a key: core never points into an add-on.
--
-- Only adds: one table and three functions. Running code reads none of it.
-- =============================================================================

create table platform.writing_notes (
  id uuid primary key default gen_random_uuid(),
  platform text not null
    check (platform in ('instagram', 'facebook', 'linkedin', 'alignable', 'threads', 'x')),
  note text not null check (length(btrim(note)) between 1 and 2000),
  -- How many comments it was learned from.
  comments integer not null check (comments >= 0),
  -- The research it came from. A label, not a key.
  research_id uuid,
  used_at timestamptz not null default now(),
  used_by uuid references app.users (id) on delete set null,
  stopped_at timestamptz,
  stopped_by uuid references app.users (id) on delete set null
);
create unique index writing_notes_in_use_idx on platform.writing_notes (platform) where stopped_at is null;
create index writing_notes_used_by_idx on platform.writing_notes (used_by);
create index writing_notes_stopped_by_idx on platform.writing_notes (stopped_by);

-- The worker reads the one in use as it writes a message; staff read it through the definer below. Nobody writes but
-- through the definers.
alter table platform.writing_notes enable row level security;
create policy writing_notes_service_select on platform.writing_notes for select to service_actor using (true);
grant select on platform.writing_notes to service_actor;
revoke all on platform.writing_notes from anon, authenticated;

-- Puts a note in every business's messages on a network, in place of the one in use. Staff-only: it checks for itself.
create function private.use_writing_note(p_platform text, p_note text, p_comments integer, p_research uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'Only HandsFreeOS staff choose the note messages are written with'
      using errcode = '42501', detail = 'writing_note_is_ours';
  end if;
  update platform.writing_notes n
  set stopped_at = now(), stopped_by = (select auth.uid())
  where n.platform = p_platform and n.stopped_at is null;
  insert into platform.writing_notes (platform, note, comments, research_id, used_by)
  values (p_platform, p_note, greatest(0, coalesce(p_comments, 0)), p_research, (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

-- Takes the note in use out of every business's messages again; how many it stopped. Staff-only.
create function private.stop_writing_note(p_platform text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not private.staff_can('platform.ai.manage') then
    raise exception 'Only HandsFreeOS staff choose the note messages are written with'
      using errcode = '42501', detail = 'writing_note_is_ours';
  end if;
  update platform.writing_notes n
  set stopped_at = now(), stopped_by = (select auth.uid())
  where n.platform = p_platform and n.stopped_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The note in use on a network, for staff.
create function private.writing_note_in_use(p_platform text)
returns table (id uuid, platform text, note text, comments integer, research_id uuid, used_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select n.id, n.platform, n.note, n.comments, n.research_id, n.used_at
  from platform.writing_notes n
  where private.staff_can('platform.ai.manage') and n.platform = p_platform and n.stopped_at is null
$$;

revoke all on function
  private.use_writing_note(text, text, integer, uuid), private.stop_writing_note(text),
  private.writing_note_in_use(text)
  from public;
grant execute on function
  private.use_writing_note(text, text, integer, uuid), private.stop_writing_note(text),
  private.writing_note_in_use(text)
  to authenticated;
