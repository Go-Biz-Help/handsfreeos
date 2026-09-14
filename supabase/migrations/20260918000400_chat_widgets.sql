-- =============================================================================
-- 0033 · Website chat. A business pastes a small script that adds a chat
--        button to its site; the chat window itself is served by HandsFreeOS
--        and shows only on the sites its widget lists (the browser enforces
--        that through frame-ancestors). Each visitor gets a token kept in the
--        chat window's own storage; only its hash is stored, and the previous
--        hash still works for a few minutes after it rotates. A visitor has
--        one conversation (counterpart chat:<visitor id>); a customer they
--        say they are is linked, never edited. "Typing" signals last seconds.
--        Every worker machine asks private.chat_feed once a second for new
--        chat messages to push to the chats open on it. channels.manage
--        (owners, admins) manages widgets; people who work the inbox see who
--        a visitor said they are and may block one; the worker writes the
--        rest, and nobody else ever reads a token hash or the hashed IP.
-- =============================================================================

-- ---------- helpers ----------
-- A widget's public key: wk_ and 20 random base62 characters. It sits in the snippet on the business's site,
-- so it isn't a secret; rotating it retires every snippet pasted before.
create or replace function private.new_chat_widget_key()
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
  return 'wk_' || v_key;
end $$;

-- The sites a widget shows on: 1 to 10 different exact origins, each https://<host>[:port] in lower case with
-- no path, or a loopback http origin (http://localhost:4191) for trying the widget on your own machine. The
-- chat window's frame-ancestors lists exactly these.
create or replace function private.valid_chat_origins(p_origins text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(p_origins) between 1 and 10, false)
    and array_position(p_origins, null) is null
    and (select count(distinct x.o) from unnest(p_origins) as x (o)) = cardinality(p_origins)
    and not exists (
      select 1 from unnest(p_origins) as x (o)
      where x.o !~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{1,5})?$'
        and x.o !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$')
$$;

-- ---------- widgets ----------
create table app.chat_widgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  public_key text not null unique default private.new_chat_widget_key() check (public_key ~ '^wk_[A-Za-z0-9]{20}$'),
  allowed_origins text[] not null check (private.valid_chat_origins(allowed_origins)),
  -- The teammate that answers; none: only people do.
  teammate_id uuid references app.ai_teammates (id) on delete set null,
  greeting text check (greeting is null or length(greeting) <= 500),
  launcher_label text not null default 'Chat with us' check (length(btrim(launcher_label)) between 1 and 40),
  accent_color text not null default '#2d69d8' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  -- Which bottom corner the button sits in.
  position text not null default 'right' check (position in ('right', 'left')),
  -- Shown when nobody is answering.
  away_message text check (away_message is null or length(away_message) <= 500),
  -- Which details to ask a visitor for, and when (core's shape; name, phone and email "when needed" by default).
  ask_for jsonb not null default '{}'::jsonb check (jsonb_typeof(ask_for) = 'object' and pg_column_size(ask_for) <= 4096),
  -- Show the SMS consent box (the booking page's wording) when a visitor gives a phone number.
  sms_consent boolean not null default true,
  -- The most new chats a day this widget takes (its abuse limit).
  daily_cap integer not null default 200 check (daily_cap between 1 and 10000),
  paused_at timestamptz,
  -- The install check ("Seen on acme.com 3 min ago"), recorded by the worker.
  last_seen_origin text check (last_seen_origin is null or length(last_seen_origin) <= 300),
  last_seen_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger chat_widgets_updated_at before update on app.chat_widgets for each row execute function private.set_updated_at();
create trigger chat_widgets_immutable before update on app.chat_widgets for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- visitors: one browser on one widget ----------
create table app.chat_visitors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  widget_id uuid not null references app.chat_widgets (id) on delete cascade,
  -- A hash of the 32-byte token the chat window keeps; the token itself is never stored. It rotates weekly,
  -- and the previous hash still works until prev_token_expires_at (a short grace).
  token_hash bytea not null unique check (length(token_hash) between 16 and 64),
  token_issued_at timestamptz not null default now(),
  prev_token_hash bytea check (prev_token_hash is null or length(prev_token_hash) between 16 and 64),
  prev_token_expires_at timestamptz,
  -- Their one conversation (counterpart chat:<this id>), once they write.
  conversation_id uuid unique references app.conversations (id) on delete set null,
  -- What they typed. Anyone can type someone else's number, so a matching customer is linked, never edited,
  -- and nothing about them is read back to the visitor.
  name text check (name is null or length(btrim(name)) between 1 and 120),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (email is null or (email = lower(email) and position('@' in email) > 1 and length(email) <= 320)),
  person_id uuid references app.people (id) on delete set null,
  -- A keyed one-way hash of their IP, for limits and network blocks; never the IP itself.
  ip_hmac bytea check (ip_hmac is null or length(ip_hmac) between 16 and 64),
  -- The page they're on, and when their chat window last checked in ("On the site now").
  last_page_path text check (last_page_path is null or (length(last_page_path) <= 2000 and last_page_path ~ '^/')),
  last_seen_at timestamptz,
  -- When they last passed the invisible human check (the first message, every 50th, and after a rotation).
  turnstile_passed_at timestamptz,
  blocked_at timestamptz,
  -- Blocking can also block their network (every visitor with this ip_hmac) until then.
  network_blocked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((prev_token_hash is null) = (prev_token_expires_at is null)),
  check (network_blocked_until is null or (blocked_at is not null and ip_hmac is not null))
);
-- A token in its grace period still finds its visitor.
create unique index chat_visitors_prev_token_unique on app.chat_visitors (prev_token_hash) where prev_token_hash is not null;
-- "Is this network blocked here?"
create index chat_visitors_network_block_idx on app.chat_visitors (workspace_id, ip_hmac) where network_blocked_until is not null;
create trigger chat_visitors_updated_at before update on app.chat_visitors for each row execute function private.set_updated_at();
create trigger chat_visitors_immutable before update on app.chat_visitors for each row execute function private.forbid_tenant_column_change('workspace_id', 'widget_id');

-- ---------- signals: "typing", for a few seconds ----------
-- Upserted on (conversation_id, kind) while the teammate writes; open chats show it until expires_at. The
-- worker deletes old rows.
create table app.chat_signals (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  kind text not null default 'typing' check (kind in ('typing')),
  signaled_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '8 seconds',
  primary key (conversation_id, kind),
  check (expires_at > signaled_at and expires_at <= signaled_at + interval '1 minute')
);

-- ---------- the live feed: what each worker machine pushes to the chats open on it ----------
-- Every machine asks once a second for what arrived since its last look, across all businesses (it can't
-- know whose chats are open on it until it looks), so this runs as the definer and only the worker may call
-- it. It returns only what a chat window shows: new chat messages that didn't fail, who wrote them (the
-- visitor, the teammate by name, or a person by first name), and live "typing" signals. A commit can land a
-- moment after a later one, so callers ask again with a few seconds of overlap and skip ids they've sent;
-- the polling route catches anything else. Nothing older than 5 minutes (a stream's life) comes back.
create or replace function private.chat_feed(p_since timestamptz)
returns table (kind text, conversation_id uuid, message_id uuid, direction app.direction, body text, sender text,
  sender_name text, occurred_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.* from (
    select 'message'::text, m.conversation_id, m.id, m.direction, m.body_text,
      case when m.direction = 'inbound' then 'visitor' when m.sent_by_teammate_id is not null then 'teammate' else 'person' end,
      case when m.sent_by_teammate_id is not null then t.name
        when m.direction = 'outbound' then nullif(split_part(btrim(u.full_name), ' ', 1), '') end,
      m.created_at
    from app.messages m
    left join app.ai_teammates t on t.id = m.sent_by_teammate_id
    left join app.users u on u.id = m.sent_by
    where m.channel = 'chat' and m.created_at > greatest(p_since, now() - interval '5 minutes')
      and m.status not in ('failed', 'undelivered')
    union all
    select s.kind, s.conversation_id, null::uuid, null::app.direction, null::text, 'teammate', null::text, s.signaled_at
    from app.chat_signals s
    where s.signaled_at > greatest(p_since, now() - interval '5 minutes') and s.expires_at > now()
  ) as f (kind, conversation_id, message_id, direction, body, sender, sender_name, occurred_at)
  order by f.occurred_at
  limit 1000
$$;
-- The feed's scan: chat messages by arrival.
create index messages_chat_feed_idx on app.messages (created_at) where channel = 'chat';

-- ---------- references stay inside the workspace, whoever writes ----------
-- An update once the workspace is gone is its deletion cascading, and is let through.
create or replace function private.check_chat_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'chat_widgets' then
    v_ok := new.teammate_id is null or exists (
      select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id);
  elsif tg_table_name = 'chat_visitors' then
    v_ok := exists (select 1 from app.chat_widgets w where w.id = new.widget_id and w.workspace_id = new.workspace_id)
      and (new.person_id is null or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id));
    -- A visitor's conversation is the chat conversation named for it, and no other.
    if v_ok and new.conversation_id is not null and not exists (
        select 1 from app.conversations c
        where c.id = new.conversation_id and c.workspace_id = new.workspace_id
          and c.channel = 'chat' and c.counterpart = 'chat:' || new.id::text) then
      raise exception 'A visitor''s conversation is its own chat' using errcode = '23514', detail = 'chat_conversation_mismatch';
    end if;
  elsif tg_table_name = 'chat_signals' then
    v_ok := exists (
      select 1 from app.conversations c
      where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.channel = 'chat');
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger chat_widgets_check_refs before insert or update of teammate_id on app.chat_widgets
  for each row execute function private.check_chat_refs();
create trigger chat_visitors_check_refs before insert or update of person_id, conversation_id on app.chat_visitors
  for each row execute function private.check_chat_refs();
create trigger chat_signals_check_refs before insert on app.chat_signals for each row execute function private.check_chat_refs();

-- ---------- RLS: channels.manage manages widgets; the inbox sees and blocks visitors; the worker does the rest ----------
alter table app.chat_widgets enable row level security;
alter table app.chat_visitors enable row level security;
alter table app.chat_signals enable row level security;

-- A new widget hasn't been seen installed anywhere yet.
create policy chat_widgets_select on app.chat_widgets for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy chat_widgets_insert on app.chat_widgets for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and last_seen_at is null and last_seen_origin is null);
create policy chat_widgets_update on app.chat_widgets for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy chat_widgets_service_all on app.chat_widgets for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- People who work the inbox see who a visitor said they are and where they are (never the token hashes or
-- the hashed IP: the column grants in 0034), and block or unblock one (chat.block_visitor). The worker
-- makes and updates visitors.
create policy chat_visitors_select on app.chat_visitors for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'));
create policy chat_visitors_update on app.chat_visitors for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy chat_visitors_service_all on app.chat_visitors for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Signals are the worker's alone.
create policy chat_signals_service_all on app.chat_signals for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- function privileges ----------
revoke all on function
  private.new_chat_widget_key(), private.valid_chat_origins(text[]), private.check_chat_refs(),
  private.chat_feed(timestamptz)
  from public;
-- The key is the column's default and the origins its check, so whoever inserts a widget runs them.
grant execute on function private.new_chat_widget_key(), private.valid_chat_origins(text[]), private.check_chat_refs()
  to authenticated, service_actor;
grant execute on function private.chat_feed(timestamptz) to service_actor;
