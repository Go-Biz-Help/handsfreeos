-- Social Outreach: a chat's messages without what Messenger says about them.
--
-- Under the person's last message Messenger says whether it went and when: "Sent 33m ago". The extension read that
-- line as part of the message, so each read of a Facebook chat brought the same message with new words, and it was
-- kept again (the owner's screenshots, 17 Nov 2026: one check-in, sent once, six times over, each "Sent 18h ago", "Sent
-- 23h ago" and on). Migration 028600 couldn't tell them apart, as their words differed. Facebook's line at the top of
-- an encrypted chat ("New messages and calls are secured with end-to-end encryption…") was kept as theirs too.
-- `withoutStatus` (packages/core/src/addons/outreach/chat-collect.ts) leaves those lines off from now on, and extension
-- 0.147.8 reads them as no words; this takes them out of what’s kept.
--
-- Each message loses a "Sent …", "Seen …" or "Delivered …" line at its end. One of the person's that was only that line
-- was a picture, a sticker or a file they sent, and says so (`WORDLESS`); Facebook's line about encryption goes. A
-- message that had the line is the same one read again as another with the same words that didn't (with the same
-- time), or as the first with the line: those go. What's left sets how many messages a chat only read live has.

with m as (
  select
    c.id,
    e.ord,
    e.msg,
    e.msg ->> 'text' as raw
  from addon_outreach.file_chats c
  cross join lateral jsonb_array_elements(c.recent) with ordinality as e (msg, ord)
  where c.recent::text ~* '(sent|seen|delivered|end-to-end encryption)'
),
stripped as (
  select
    id,
    ord,
    msg,
    raw,
    case
      when raw ~* '^\s*(sent|seen|delivered)( by [^\n]+| just now| [0-9]+\s*[a-z]+ ago)?\s*$' then
        case when (msg ->> 'fromMe')::boolean then '(a picture, sticker or file)' else '' end
      else btrim(regexp_replace(raw, '(\s*\n\s*(sent|seen|delivered)( by [^\n]+| just now| [0-9]+\s*[a-z]+ ago)?\s*)+$', '', 'i'))
    end as said
  from m
),
said as (
  select
    s.*,
    s.said <> btrim(s.raw) as had_status,
    (s.msg ->> 'fromMe') || ':' || regexp_replace(s.said, '\s+', ' ', 'g') as k,
    s.msg ->> 'at' as at
  from stripped s
  where s.said <> '' and s.said !~* '^(new )?messages and calls are secured with end-to-end encryption'
),
ranked as (
  select
    said.*,
    row_number() over (partition by id, k, had_status order by ord) as nth,
    bool_or(not had_status) over (partition by id, k, at) as read_without
  from said
),
kept as (
  select * from ranked where not had_status or (nth = 1 and not read_without)
),
whole as (
  select
    c.id,
    jsonb_array_length(c.recent) as had_n,
    coalesce(
      (select jsonb_agg(jsonb_set(k.msg, '{text}', to_jsonb(k.said)) order by k.ord) from kept k where k.id = c.id),
      '[]'::jsonb
    ) as recent
  from addon_outreach.file_chats c
  where c.id in (select id from m)
),
changed as (
  select
    w.id,
    w.recent,
    jsonb_array_length(w.recent) as n
  from whole w
  join addon_outreach.file_chats f on f.id = w.id
  where w.recent <> f.recent
)
update addon_outreach.file_chats f
set
  recent = ch.recent,
  messages = case when f.import_id is null then ch.n else f.messages end,
  updated_at = now()
from changed ch
where f.id = ch.id;
