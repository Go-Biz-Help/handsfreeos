-- =============================================================================
-- In your hands: the AI holds off someone a person on the team is talking to
-- (docs/operations.md, "In your hands"; the owner, 19 Nov 2026, "all your
-- picks": 1a 2a 3a 4a 5a 6a).
--        - app.people_in_hands: one row for each customer a person has taken
--          on. A message someone on the team sends them themselves (a text, an
--          email, a website chat or portal reply, an email from their own
--          mailbox that HandsFreeOS reads, a reply typed in Facebook's or
--          Instagram's own inbox), a call they make, or Take over puts them
--          here, in that person's hands. An AI draft someone OK'd or edited is
--          still the AI's, and the business's automations count either way.
--        - It is the whole customer, everywhere: each of their conversations
--          is a person's (handled_by 'person') while they're here, and the AI
--          teammate, its follow-ups, funnels and AI calls leave them alone.
--          Social Outreach reads the same row (an add-on reads core, never the
--          other way round).
--        - They stay until someone gives them back: Give back to the AI on the
--          list, their contact or the Inbox, or Let the AI take it when they
--          wrote back and nobody answered for an hour.
--        - A conversation that starts or is tied to them while they're here is
--          a person's from the start (conversation_in_hands below).
--        - A merge carries the row to the customer kept, unless they have one.
--        - The last 30 days count from the start: anyone whose latest message
--          from the business, the AI's or a person's, was a person's (or a call
--          a person made) is in that person's hands from now. Their
--          conversations are a person's, and the AI's waiting replies to them
--          are let go, as a reply typed today would.
-- =============================================================================

create table app.people_in_hands (
  person_id uuid primary key references app.people (id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Whose hands: who wrote, called or pressed Take over. Null for someone outside HandsFreeOS (a reply typed in
  -- Facebook's own inbox), and once they leave the business.
  user_id uuid references app.users (id) on delete set null,
  how text not null check (how in ('wrote', 'called', 'took_over')),
  -- Where they last reached them by hand: a channel ('sms', 'email', 'chat', 'portal', 'messenger', 'instagram'),
  -- 'call', or a network an add-on names ('facebook', 'linkedin'). Null for Take over.
  place text check (place is null or place ~ '^[a-z_]{1,40}$'),
  -- When they first came into someone's hands, and the latest message or call by hand since.
  since timestamptz not null default now(),
  last_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table app.people_in_hands is
  'Customers a person on the team has taken on: the AI holds off them everywhere until someone gives them back.';
create index people_in_hands_workspace_idx on app.people_in_hands (workspace_id, since desc);
create index people_in_hands_user_idx on app.people_in_hands (user_id) where user_id is not null;
create trigger people_in_hands_updated_at before update on app.people_in_hands
  for each row execute function private.set_updated_at();
create trigger people_in_hands_immutable before update on app.people_in_hands
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.people_in_hands enable row level security;
create policy people_in_hands_select on app.people_in_hands for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy people_in_hands_insert on app.people_in_hands for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use')
    and exists (select 1 from app.people p where p.id = person_id and p.workspace_id = people_in_hands.workspace_id));
create policy people_in_hands_update on app.people_in_hands for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy people_in_hands_delete on app.people_in_hands for delete to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'));
create policy people_in_hands_service_all on app.people_in_hands for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace()
    and exists (select 1 from app.people p where p.id = person_id and p.workspace_id = people_in_hands.workspace_id));

grant select, insert, delete on app.people_in_hands to authenticated, service_actor;
grant update (user_id, how, place, last_at) on app.people_in_hands to authenticated, service_actor;
revoke all on app.people_in_hands from anon;

-- ---------- a conversation with someone in a person's hands is a person's from the start ----------
create or replace function private.conversation_in_hands()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if new.person_id is null or new.handled_by = 'person' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.person_id is not distinct from old.person_id then
    return new;
  end if;
  select h.user_id into v_user from app.people_in_hands h
   where h.person_id = new.person_id and h.workspace_id = new.workspace_id;
  if not found then
    return new;
  end if;
  new.handled_by := 'person';
  new.taken_over_by := v_user;
  new.ai_epoch := new.ai_epoch + 1;
  return new;
end $$;
create trigger conversations_in_hands before insert or update of person_id on app.conversations
  for each row execute function private.conversation_in_hands();

-- ---------- a merge carries the row to the customer kept ----------
create or replace function private.merge_in_hands()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.people_in_hands h set person_id = new.into_person_id
   where h.person_id = new.from_person_id
     and not exists (select 1 from app.people_in_hands o where o.person_id = new.into_person_id);
  return new;
end $$;
create trigger person_merges_in_hands after insert on private.person_merges
  for each row execute function private.merge_in_hands();

-- ---------- the last 30 days ----------
-- Each customer's latest message from the business, the AI's or a person's (the business's automations count either
-- way), and each call a person made; whoever sent the latest, if a person, has them.
with reached as (
  select c.workspace_id, c.person_id, m.sent_by as user_id, m.sent_by_teammate_id as teammate_id,
         m.channel::text as place, 'wrote' as how, m.occurred_at as at
    from app.messages m join app.conversations c on c.id = m.conversation_id
   where m.direction = 'outbound' and c.person_id is not null
     and m.occurred_at > now() - interval '30 days' and m.occurred_at <= now()
     and m.status not in ('failed', 'undelivered', 'bounced')
     and (m.sent_by is not null or m.sent_by_teammate_id is not null)
  union all
  select k.workspace_id, k.person_id, k.placed_by, null, 'call', 'called', k.created_at
    from app.calls k
   where k.direction = 'outbound' and k.person_id is not null and k.placed_by is not null
     and k.created_at > now() - interval '30 days'
),
latest as (
  select distinct on (r.person_id) r.* from reached r order by r.person_id, r.at desc
)
insert into app.people_in_hands (person_id, workspace_id, user_id, how, place, since, last_at)
select l.person_id, l.workspace_id, l.user_id, l.how, l.place, l.at, l.at
  from latest l join app.people p on p.id = l.person_id and p.workspace_id = l.workspace_id
 where l.user_id is not null and l.teammate_id is null
   and p.merged_into_id is null and p.bin_item_id is null and p.erased_at is null
on conflict (person_id) do nothing;

-- Their conversations are a person's, as a reply typed today makes them (every row here came from the look back).
update app.conversations c
   set handled_by = 'person', taken_over_by = h.user_id, ai_epoch = c.ai_epoch + 1
  from app.people_in_hands h
 where h.person_id = c.person_id and h.workspace_id = c.workspace_id and c.handled_by in ('none', 'ai');

-- And the AI's replies waiting for an OK in them are let go.
update app.ai_teammate_drafts d
   set status = 'cancelled', decided_at = now(), via = 'system', reason = 'A person took the conversation over.'
  from app.conversations c join app.people_in_hands h on h.person_id = c.person_id and h.workspace_id = c.workspace_id
 where d.conversation_id = c.id and d.status = 'pending' and d.kind = 'reply';
