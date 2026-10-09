-- =============================================================================
-- Social Outreach (outreach): the chats in Facebook's download, read by the AI.
--
--        The plan's part 2 (docs/outreach.md, decision 3): each one-to-one chat
--        brought in from the download keeps its latest messages (at most 20,
--        oldest first), and the AI reads them for a short summary, tags from
--        the business's playbooks, whether they look like a prospect, and a
--        next step. Who goes in Contacts then is the business's setting:
--        everyone, the tagged (the default), or only likely prospects. A chat
--        put in Contacts keeps the customer it went to (person_id).
--
--        `read_state` is where the reading is: `none` when there's nothing to
--        read, `waiting` for the AI, `read`, `skipped` when only the person
--        wrote, and `failed` when the AI's answer couldn't be used. Messages
--        newer than the last read put it back to `waiting`.
-- =============================================================================

alter table addon_outreach.file_chats
  add column recent jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recent) = 'array' and jsonb_array_length(recent) <= 20),
  add column read_state text not null default 'none'
    check (read_state in ('none', 'waiting', 'read', 'skipped', 'failed')),
  add column summary text check (summary is null or length(btrim(summary)) between 1 and 600),
  add column tags text[] not null default '{}' check (cardinality(tags) <= 10),
  add column prospect boolean,
  add column next_step text check (next_step is null or length(btrim(next_step)) between 1 and 300),
  add column read_at timestamptz,
  add column person_id uuid references app.people (id) on delete set null;

create index file_chats_waiting_idx on addon_outreach.file_chats (workspace_id, user_id, last_at desc)
  where read_state = 'waiting';
create index file_chats_person_idx on addon_outreach.file_chats (person_id) where person_id is not null;
