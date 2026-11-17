-- Social Outreach: each message once in a chat's latest messages.
--
-- A chat read again kept its messages by their time as well as their words, and Instagram's messages show no time:
-- each read gave them all the time the chat's row in the list said, which moves on, so the same messages were kept
-- again with each read (the owner's screenshot, 17 Nov 2026: one first message, sent once, nine times over on Needs
-- you). Other networks' times shift as a page scrolls ("Mon" one week, a date the next), so Alignable, LinkedIn and
-- Facebook chats have some too. `mergeRecent` (packages/core/src/addons/outreach/chat-collect.ts) now knows a message
-- read again by its words; this takes out the copies already kept.
--
-- A message is who wrote it and its words, with runs of spaces as one. Each is kept as many times as one read had it
-- (the most of it with the same time: one read on Instagram, one minute elsewhere), so words really said twice stay
-- twice. Which copy stays:
--   - Instagram: the latest read's, since a later read can show older messages above the ones kept, and it has the
--     chat in order; each takes the earliest time it was read with, no later than the message after it.
--   - Elsewhere: the first, with its own time; a later copy is an older message given a later time. Only the chat's
--     last message stays even when said before, if the one before it is another message read for the first time:
--     words said again to end a chat ("Missed video call") come with a real time, and taking them out would say the
--     wrong person wrote last.
-- What's left sets how many messages a chat only read live has, and whose its last one was. When a copy had moved the
-- chat's last time on, it goes back to the latest left: on Instagram always, elsewhere only by more than a day (a copy
-- there with a real time, on the day the first gave only a date, has the better time).

with m as (
  select
    c.id,
    c.platform,
    e.ord,
    e.msg,
    (e.msg ->> 'fromMe') || ':' || btrim(regexp_replace(e.msg ->> 'text', '\s+', ' ', 'g')) as k,
    e.msg ->> 'at' as said
  from addon_outreach.file_chats c
  cross join lateral jsonb_array_elements(c.recent) with ordinality as e (msg, ord)
),
-- How many times one read had each message: the most of it with the same time.
allowed as (
  select id, k, max(n) as most, min(first_said) as first_said
  from (
    select id, k, said, count(*) as n, min(said::timestamptz) as first_said from m group by id, k, said
  ) t
  group by id, k
),
kept as (
  select
    m.*,
    a.first_said,
    row_number() over (partition by m.id, m.k order by m.ord) as nth_first,
    row_number() over (partition by m.id, m.k order by m.ord desc) as nth_last,
    a.most,
    m.ord = max(m.ord) over (partition by m.id) as last_one
  from m
  join allowed a on a.id = m.id and a.k = m.k
),
-- Whether the one before each is another message, and new: the first time its words were read.
placed as (
  select
    kept.*,
    coalesce(lag(nth_first = 1) over w and lag(k) over w <> k, false) as after_new
  from kept
  window w as (partition by id order by ord)
),
timed as (
  select
    id,
    ord,
    case
      when platform = 'instagram' then
        min(first_said) over (partition by id order by ord desc rows between unbounded preceding and current row)
      else said::timestamptz
    end as t,
    platform,
    msg
  from placed
  where
    case
      when platform = 'instagram' then nth_last <= most
      else nth_first <= most or (last_one and after_new)
    end
),
cleaned as (
  select
    id,
    jsonb_agg(
      case
        when platform = 'instagram' then
          jsonb_set(msg, '{at}', to_jsonb(to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
        else msg
      end
      order by ord
    ) as recent,
    count(*)::int as n,
    max(t) as latest,
    (array_agg((msg ->> 'fromMe')::boolean order by ord desc))[1] as last_from_me
  from timed
  group by id
),
had as (
  select id, max(said::timestamptz) as latest from m group by id
),
changed as (
  select cl.*, h.latest as had_latest
  from cleaned cl
  join had h on h.id = cl.id
  join addon_outreach.file_chats f on f.id = cl.id
  where cl.n < jsonb_array_length(f.recent)
)
update addon_outreach.file_chats f
set
  recent = ch.recent,
  messages = case when f.import_id is null then ch.n else f.messages end,
  last_at = case
    when
      f.last_at <= ch.had_latest
      and ch.latest < f.last_at
      and (f.platform = 'instagram' or f.last_at - ch.latest > interval '1 day')
      then ch.latest
    else f.last_at
  end,
  last_from_me = case when f.last_at <= ch.had_latest then ch.last_from_me else f.last_from_me end,
  updated_at = now()
from changed ch
where f.id = ch.id;
