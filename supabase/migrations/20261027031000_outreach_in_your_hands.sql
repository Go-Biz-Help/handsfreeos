-- Social Outreach: In your hands (docs/outreach.md, decision 185; core's side is 20261027030900).
--
-- The owner, 19 Nov 2026: "the social outreach needs to recognize when the user sent a manual message last and so the
-- ai should hold off, if it feels it needs to respond to something or follow up then it should ask the user if they
-- want to give ai the reigns for this contact again", with a list of contacts in the person's hands, Take over next to
-- Don't pitch and Never contact, and the same in core. Their picks, all "a": per contact everywhere; a message the
-- person typed themselves counts (on the network outside the extension too), never an AI draft they OK'd, edited or
-- copied; every AI message stops, likes and comments go on; the AI asks after an hour unanswered or when a follow-up
-- is due; they stay in the person's hands until given back; look back 30 days.
--
-- One row per profile someone on the team reached by hand, or took over: `how` 'wrote' (with the network as `place`)
-- or 'took_over'; `last_at` their latest message by hand; `kept_at` when they last pressed Keep it mine on the ask;
-- `asked_at` when their phone last heard the ask; `back_at` when someone gave them back to the AI. A row given back
-- stays, so a message read again later that was written before then never takes them back. A profile on a customer
-- in core's app.people_in_hands is in someone's hands too, whatever its own row says.
--
-- `profiles.copied_at`: when the person last copied one of the AI's drafts for them from Today to send themselves
-- (outreach.conversation.note), so that message, read in the chat later, stays the AI's.

alter table addon_outreach.profiles add column copied_at timestamptz;

create table addon_outreach.hands (
  profile_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid references app.users (id) on delete set null,
  how text not null check (how in ('wrote', 'took_over')),
  place text check (place is null or place ~ '^[a-z_]{1,40}$'),
  since timestamptz not null,
  last_at timestamptz not null,
  kept_at timestamptz,
  asked_at timestamptz,
  back_at timestamptz,
  back_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index hands_held_idx on addon_outreach.hands (workspace_id, last_at desc) where back_at is null;
select private.addon_table_policies('addon_outreach.hands', 'outreach.use', 'outreach.use', null, null);

-- ---------- the last 30 days ----------
-- Each profile's latest message from the person, from the chats the extension read and the Sends it saw them press
-- themselves. One is the AI's when a message HandsFreeOS drafted for them says the same (a long one arrives as a bubble
-- per paragraph), when the extension sent one to them within 15 minutes of it, or when the person copied a draft for
-- them then; a picture or sticker alone, and a line the reader took from the page (a group's member count, a message
-- headed with their own name) count for nobody. The person has them when the latest is theirs.
with said as (
  select fc.workspace_id, fc.user_id, fc.profile_id, fc.platform, fc.name,
         (m->>'text') as text, (m->>'at')::timestamptz as at,
         regexp_replace(lower(m->>'text'), '[^[:alnum:]]+', '', 'g') as norm
    from addon_outreach.file_chats fc
    cross join lateral jsonb_array_elements(fc.recent) m
   where fc.profile_id is not null
     and (m->>'fromMe')::boolean
     and (m->>'at')::timestamptz > now() - interval '30 days' and (m->>'at')::timestamptz <= now()
),
mine as (
  select s.* from said s
   where s.text <> '(a picture, sticker or file)'
     and length(s.norm) > 0
     and s.text !~* '·\s*[0-9][0-9,.]*k?\s+members'
     and not starts_with(s.text, s.name || E'\n')
),
by_hand as (
  select m.workspace_id, m.user_id, m.profile_id, m.platform, m.at
    from mine m
   where not exists (
       select 1 from addon_outreach.sends d
        where d.profile_id = m.profile_id
          and d.created_at > now() - interval '45 days'
          and (regexp_replace(lower(d.text), '[^[:alnum:]]+', '', 'g') = m.norm
            or exists (select 1 from regexp_split_to_table(d.text, E'\\n+') para
                        where regexp_replace(lower(para), '[^[:alnum:]]+', '', 'g') = m.norm)
            or (length(m.norm) >= 12 and strpos(regexp_replace(lower(d.text), '[^[:alnum:]]+', '', 'g'), m.norm) > 0)))
     and not exists (
       select 1 from addon_outreach.touches t
        where t.profile_id = m.profile_id and t.kind = 'message' and t.auto
          and t.at between m.at - interval '15 minutes' and m.at + interval '15 minutes')
     and not exists (
       select 1 from addon_outreach.sends d
        where d.profile_id = m.profile_id and d.state = 'sent'
          and d.done_at between m.at - interval '15 minutes' and m.at + interval '15 minutes')
  union all
  -- A Send the extension saw the person press themselves, but one it had handed them to send (a step it couldn't do).
  select t.workspace_id, t.user_id, t.profile_id, p.platform, t.at
    from addon_outreach.touches t
    join addon_outreach.profiles p on p.id = t.profile_id
   where t.kind = 'message' and not t.auto
     and t.at > now() - interval '30 days' and t.at <= now()
     and not exists (
       select 1 from addon_outreach.needs n
        where n.profile_id = t.profile_id and n.step = 'message' and n.send_id is not null
          and n.cleared_at between t.at - interval '5 minutes' and t.at + interval '5 minutes')
),
latest as (
  select distinct on (b.profile_id) b.* from by_hand b order by b.profile_id, b.at desc
)
insert into addon_outreach.hands (profile_id, workspace_id, user_id, how, place, since, last_at)
select l.profile_id, l.workspace_id, l.user_id, 'wrote', l.platform, l.at, l.at
  from latest l
  join addon_outreach.profiles p on p.id = l.profile_id and p.workspace_id = l.workspace_id
 where not p.never_contact
   -- Nothing the extension sent them since, which would be the latest.
   and not exists (
     select 1 from addon_outreach.touches t
      where t.profile_id = l.profile_id and t.kind = 'message' and t.auto and t.at > l.at + interval '15 minutes')
   and not exists (
     select 1 from addon_outreach.sends d
      where d.profile_id = l.profile_id and d.state = 'sent' and d.done_at > l.at + interval '15 minutes')
   -- Nor copied from Today to send.
   and not exists (
     select 1 from addon_outreach.follow_ups f
      where f.profile_id = l.profile_id and f.last_at between l.at - interval '2 hours' and l.at + interval '15 minutes')
on conflict (profile_id) do nothing;

-- Those on a customer are in that person's hands in core too, as a message typed today puts them (core's 030900 does
-- the rest for a customer reached in HandsFreeOS).
with held as (
  select distinct on (p.person_id) p.person_id, h.workspace_id, h.user_id, h.place, h.since, h.last_at
    from addon_outreach.hands h
    join addon_outreach.profiles p on p.id = h.profile_id
    join app.people pe on pe.id = p.person_id and pe.workspace_id = p.workspace_id
   where h.back_at is null and p.person_id is not null
     and pe.merged_into_id is null and pe.bin_item_id is null and pe.erased_at is null
   order by p.person_id, h.last_at desc
)
insert into app.people_in_hands (person_id, workspace_id, user_id, how, place, since, last_at)
select person_id, workspace_id, user_id, 'wrote', place, since, last_at from held
on conflict (person_id) do nothing;

update app.conversations c
   set handled_by = 'person', taken_over_by = h.user_id, ai_epoch = c.ai_epoch + 1
  from app.people_in_hands h
 where h.person_id = c.person_id and h.workspace_id = c.workspace_id and c.handled_by in ('none', 'ai');

update app.ai_teammate_drafts d
   set status = 'cancelled', decided_at = now(), via = 'system', reason = 'A person took the conversation over.'
  from app.conversations c join app.people_in_hands h on h.person_id = c.person_id and h.workspace_id = c.workspace_id
 where d.conversation_id = c.id and d.status = 'pending' and d.kind = 'reply';

-- And the messages the extension drafted for them, still waiting for an OK or to go, are skipped.
update addon_outreach.sends d
   set state = 'skipped', done_at = now(), updated_at = now()
  from addon_outreach.profiles p
 where p.id = d.profile_id and d.state in ('waiting', 'approved') and d.kind not in ('comment', 'group_reply')
   and (exists (select 1 from addon_outreach.hands h where h.profile_id = p.id and h.back_at is null)
     or exists (select 1 from app.people_in_hands ph where ph.person_id = p.person_id));
