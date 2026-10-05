-- =============================================================================
-- Facebook Messenger and Instagram direct messages, answered from the inbox,
-- and every ad that brought somebody to them kept as its own touch.
--
--        **The sign-in.** A person with the business's Facebook Page signs in
--        once (meta_connections) and picks the Pages, and the Instagram
--        accounts linked to them, that HandsFreeOS answers
--        (meta_accounts). Facebook gives each a token of its own; both are
--        sealed by the worker and no browser ever reads them. A Page or an
--        Instagram account is answered by one business at a time, because
--        Meta sends its messages to one place.
--
--        **The people on the other side.** Meta names a customer by an id
--        that only means something to that Page or account (a page-scoped
--        id). meta_contacts keeps it with the name Facebook gave and the
--        conversation it is, so a thread is always the same thread. A
--        conversation's counterpart says the same thing in the form every
--        channel shares: messenger:<page>:<id> or instagram:<account>:<id>.
--
--        **Ads.** A message that starts or picks up a conversation from an
--        ad (or a link with a ref) arrives with Meta's referral. Every one is
--        an attribution touch of its own and nothing overwrites the
--        customer's source, so the first ad, the last one and every one in
--        between stay answerable later. What Meta's Marketing API says about
--        the ad (its campaign, ad set and creative) is looked up once per ad
--        and kept in app.ads, shared by every touch from that ad.
-- =============================================================================

-- ---------- the sign-in ----------
create table app.meta_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'needs_attention', 'disconnected')),
  -- Who signed in, as Facebook calls them: a business with three admins knows whose sign-in it is.
  facebook_user_id text check (facebook_user_id is null or facebook_user_id ~ '^[0-9]{1,40}$'),
  facebook_user_name text
    check (facebook_user_name is null or length(btrim(facebook_user_name)) between 1 and 200),
  -- What the person granted, as Facebook reported it after the sign-in.
  scopes text[] not null default '{}',
  -- The sign-in: a one-time state (hashed), gone once it finishes.
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  -- The person's own token, sealed: what lists their Pages and reads the business's ads.
  token_enc text,
  token_key_id text,
  -- When it stops working. Null for a token Facebook says never expires.
  token_expires_at timestamptz,
  last_checked_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  disconnected_reason text check (disconnected_reason is null
    or disconnected_reason in ('person', 'revoked', 'failed', 'replaced')),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (disconnected_at is not null)),
  check (disconnected_at is not null or disconnected_reason is null)
);
create index meta_connections_workspace_idx on app.meta_connections (workspace_id, status);
create index meta_connections_user_idx on app.meta_connections (facebook_user_id)
  where facebook_user_id is not null and status <> 'disconnected';
create index meta_connections_created_by_idx on app.meta_connections (created_by);
create trigger meta_connections_updated_at before update on app.meta_connections
  for each row execute function private.set_updated_at();
create trigger meta_connections_immutable before update on app.meta_connections
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- the Pages and Instagram accounts a business answers ----------
create table app.meta_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The sign-in it came through, which is what reads its ads. Kept when the sign-in goes.
  connection_id uuid references app.meta_connections (id) on delete set null,
  platform text not null check (platform in ('facebook', 'instagram')),
  -- The Page's id, or the Instagram professional account's: what Meta's webhooks name.
  external_id text not null check (external_id ~ '^[0-9]{1,40}$'),
  -- The Page itself, or the one the Instagram account is linked to: replies go out through it.
  page_id text not null check (page_id ~ '^[0-9]{1,40}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- An Instagram account's @handle.
  username text check (username is null or length(btrim(username)) between 1 and 100),
  status text not null default 'active' check (status in ('active', 'needs_attention', 'disconnected')),
  -- The Page's token, sealed. An Instagram account answers through its Page's.
  token_enc text,
  token_key_id text,
  -- Meta approved the Human Agent tag for this app: a person may answer for seven days after the customer last
  -- wrote, rather than one. Stamped by the worker from its own settings, so the inbox says the right thing.
  human_agent boolean not null default false,
  -- When Meta was last asked to send this Page's messages here.
  subscribed_at timestamptz,
  failures integer not null default 0 check (failures between 0 and 1000000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  -- Why it needs somebody: its sign-in expired or was changed (reauth), the app was removed (revoked), or
  -- Meta kept refusing it (failed).
  problem text check (problem is null or problem in ('reauth', 'revoked', 'failed')),
  disconnected_reason text check (disconnected_reason is null
    or disconnected_reason in ('person', 'revoked', 'failed', 'moved')),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  connected_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (disconnected_at is not null)),
  check (disconnected_at is not null or disconnected_reason is null),
  check ((status = 'needs_attention') = (problem is not null)),
  -- A Page is its own Page.
  check (platform <> 'facebook' or page_id = external_id)
);
-- A business has one row per Page or account, connected again in place, so its threads keep their line.
create unique index meta_accounts_one_per_business on app.meta_accounts (workspace_id, platform, external_id);
-- And one business answers it at a time: Meta sends its messages to one place.
create unique index meta_accounts_live on app.meta_accounts (platform, external_id)
  where status <> 'disconnected';
create index meta_accounts_connection_idx on app.meta_accounts (connection_id);
create index meta_accounts_connected_by_idx on app.meta_accounts (connected_by);
create index meta_accounts_page_idx on app.meta_accounts (page_id) where status <> 'disconnected';
create trigger meta_accounts_updated_at before update on app.meta_accounts
  for each row execute function private.set_updated_at();
create trigger meta_accounts_immutable before update on app.meta_accounts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'platform', 'external_id');

-- ---------- the people on the other side ----------
create table app.meta_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  account_id uuid not null references app.meta_accounts (id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  -- Who they are to this Page or account, and to nobody else (a page-scoped or Instagram-scoped id).
  scoped_id text not null check (scoped_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  -- What Facebook calls them, and an Instagram @handle. Null until Meta says, or when it won't.
  name text check (name is null or length(btrim(name)) between 1 and 200),
  username text check (username is null or length(btrim(username)) between 1 and 100),
  -- Their thread with the business. The customer it's about is the conversation's, so linking and merging it
  -- needs nothing here.
  conversation_id uuid unique references app.conversations (id) on delete set null,
  profile_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, scoped_id)
);
create index meta_contacts_workspace_idx on app.meta_contacts (workspace_id);
create trigger meta_contacts_updated_at before update on app.meta_contacts
  for each row execute function private.set_updated_at();
create trigger meta_contacts_immutable before update on app.meta_contacts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'account_id', 'platform',
    'scoped_id');

-- ---------- conversations and messages ----------
alter table app.conversations
  -- The Page or Instagram account a thread is on: its line, the way a number is a text thread's.
  add column meta_account_id uuid references app.meta_accounts (id) on delete set null,
  add constraint conversations_messenger_counterpart_check
    check (channel <> 'messenger' or counterpart ~ '^messenger:[0-9]{1,40}:[0-9A-Za-z_-]{1,64}$'),
  add constraint conversations_instagram_counterpart_check
    check (channel <> 'instagram' or counterpart ~ '^instagram:[0-9]{1,40}:[0-9A-Za-z_-]{1,64}$'),
  add constraint conversations_meta_account_channel_check
    check (meta_account_id is null or channel in ('messenger', 'instagram'));
create index conversations_meta_account_idx on app.conversations (meta_account_id)
  where meta_account_id is not null;

-- A reply with photos goes to Messenger and Instagram as one message per part. The first part's id is the
-- message's provider id; every part's is kept here, so a read receipt or an echo of any of them finds it.
alter table app.messages
  add column provider_part_ids text[] not null default '{}',
  -- The customer changed or took back what they wrote (Instagram and Messenger let them). An edit keeps the newest
  -- words; a message taken back keeps nothing of what it said, only that there was one.
  add column edited_at timestamptz,
  add column unsent_at timestamptz,
  -- What Messenger and Instagram add to a message besides words and files: a post, reel or story they shared (Meta's
  -- links to these stop working, so the thread says what it was), the message or story it answers, the button they
  -- tapped, and whether the business wrote it in Facebook's or Instagram's own inbox rather than here.
  add column social jsonb not null default '{}'::jsonb check (jsonb_typeof(social) = 'object'),
  add constraint messages_unsent_empty check (unsent_at is null
    or (body_text is null and media = '[]'::jsonb and not social ? 'shared'));
create index messages_provider_parts_idx on app.messages using gin (provider_part_ids)
  where cardinality(provider_part_ids) > 0;
-- Messenger and Instagram say when the customer read a reply, as RCS does, so a read time is theirs to keep too. The
-- rest of what 0103 kept to texts stays a text's.
alter table app.messages
  drop constraint messages_rcs_is_a_texts,
  add constraint messages_rcs_is_a_texts
    check (channel = 'sms' or (transport is null and rich is null and button_reply is null and content_sid is null
      and (read_at is null or channel in ('messenger', 'instagram'))));

-- ---------- attribution: every ad or link that brought somebody, kept as it came ----------
-- What an ad was, as Meta's Marketing API describes it: looked up once per ad, shared by every touch from it.
create table app.ads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  network text not null default 'meta' check (network in ('meta')),
  -- The ad's id, as the network names it.
  external_id text not null check (external_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  name text check (name is null or length(name) <= 400),
  ad_account_id text check (ad_account_id is null or length(ad_account_id) <= 64),
  adset_id text check (adset_id is null or length(adset_id) <= 64),
  adset_name text check (adset_name is null or length(adset_name) <= 400),
  campaign_id text check (campaign_id is null or length(campaign_id) <= 64),
  campaign_name text check (campaign_name is null or length(campaign_name) <= 400),
  campaign_objective text check (campaign_objective is null or length(campaign_objective) <= 100),
  creative_id text check (creative_id is null or length(creative_id) <= 64),
  creative_name text check (creative_name is null or length(creative_name) <= 400),
  creative_title text check (creative_title is null or length(creative_title) <= 1000),
  creative_body text check (creative_body is null or length(creative_body) <= 4000),
  creative_thumbnail_url text check (creative_thumbnail_url is null or length(creative_thumbnail_url) <= 2000),
  creative_link text check (creative_link is null or length(creative_link) <= 2000),
  call_to_action text check (call_to_action is null or length(call_to_action) <= 100),
  effective_status text check (effective_status is null or length(effective_status) <= 60),
  -- Where the ad runs, as far as its creative says: facebook, instagram, or both.
  platforms text[] not null default '{}',
  -- pending: not asked yet; resolved: Meta answered; no_access: the sign-in can't read this ad (another ad
  -- account, or no ads permission); not_found: Meta has no such ad; failed: Meta kept refusing.
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'no_access', 'not_found', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  next_resolve_at timestamptz,
  resolved_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  -- What Meta answered, trimmed: kept so a later model can read a field this one doesn't.
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, network, external_id)
);
create index ads_due_idx on app.ads (next_resolve_at)
  where status in ('pending', 'no_access', 'failed') and next_resolve_at is not null;
create index ads_campaign_idx on app.ads (workspace_id, campaign_id) where campaign_id is not null;
create trigger ads_updated_at before update on app.ads
  for each row execute function private.set_updated_at();
create trigger ads_immutable before update on app.ads
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'network', 'external_id');

-- One touch: somebody reached the business from an ad or a link. Never edited, never collapsed into the customer's
-- source. First-touch, last-touch and assisted credit are orderings of these; opportunity and revenue credit join
-- them to the customer's leads, invoices and payments; a conversion sent back to Meta names the touch it answers.
create table app.attribution_touches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  network text not null default 'meta' check (network in ('meta')),
  -- Where the person saw it and where they answered.
  platform text not null check (platform in ('facebook', 'instagram')),
  channel app.channel not null,
  touched_at timestamptz not null,
  -- started: it opened the conversation; returned: somebody already talking came back through it.
  kind text not null check (kind in ('started', 'returned')),
  -- Who: the customer as they are now (follows their conversation through links and merges), the Page or account
  -- and the page-scoped person (what a conversion sent back to Meta needs), and the thread and message.
  person_id uuid references app.people (id) on delete set null,
  meta_account_id uuid references app.meta_accounts (id) on delete set null,
  meta_contact_id uuid references app.meta_contacts (id) on delete set null,
  conversation_id uuid references app.conversations (id) on delete set null,
  message_id uuid references app.messages (id) on delete set null,
  -- The lead that was open, or opened, when it came: what opportunity credit starts from.
  lead_id uuid references app.leads (id) on delete set null,
  -- What Meta said, as it said it.
  source text check (source is null or length(source) <= 60),
  referral_type text check (referral_type is null or length(referral_type) <= 60),
  ref text check (ref is null or length(ref) <= 500),
  ad_id text check (ad_id is null or ad_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  ad_title text check (ad_title is null or length(ad_title) <= 1000),
  ad_photo_url text check (ad_photo_url is null or length(ad_photo_url) <= 2000),
  ad_video_url text check (ad_video_url is null or length(ad_video_url) <= 2000),
  post_id text check (post_id is null or length(post_id) <= 200),
  product_id text check (product_id is null or length(product_id) <= 200),
  referer_uri text check (referer_uri is null or length(referer_uri) <= 2000),
  -- The ad, as Meta's Marketing API describes it. Null when there was no ad, or until it's looked up.
  ad_ref_id uuid references app.ads (id) on delete set null,
  -- The whole referral, so a field Meta adds later is already here.
  raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),
  -- One per webhook event, so Meta sending it twice records it once.
  dedupe_key text not null check (length(dedupe_key) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index attribution_touches_person_idx on app.attribution_touches (person_id, touched_at desc)
  where person_id is not null;
create index attribution_touches_conversation_idx on app.attribution_touches (conversation_id, touched_at desc)
  where conversation_id is not null;
create index attribution_touches_ad_idx on app.attribution_touches (workspace_id, ad_id, touched_at desc)
  where ad_id is not null;
create index attribution_touches_ad_ref_idx on app.attribution_touches (ad_ref_id) where ad_ref_id is not null;
create index attribution_touches_lead_idx on app.attribution_touches (lead_id) where lead_id is not null;
create index attribution_touches_contact_idx on app.attribution_touches (meta_contact_id)
  where meta_contact_id is not null;
create index attribution_touches_account_idx on app.attribution_touches (meta_account_id)
  where meta_account_id is not null;
create index attribution_touches_message_idx on app.attribution_touches (message_id) where message_id is not null;
create trigger attribution_touches_immutable before update on app.attribution_touches
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'network', 'platform',
    'channel', 'touched_at', 'kind', 'source', 'referral_type', 'ref', 'ad_id', 'dedupe_key');

-- A touch belongs to whoever its conversation belongs to: linked to a customer later, or merged into another one,
-- its touches follow.
create or replace function private.touches_follow_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.attribution_touches t set person_id = new.person_id
   where t.conversation_id = new.id and t.person_id is distinct from new.person_id;
  return null;
end $$;
create trigger conversations_touches_follow after update of person_id on app.conversations
  for each row when (old.person_id is distinct from new.person_id)
  execute function private.touches_follow_conversation();

-- ---------- everything here belongs to the same business ----------
create or replace function private.check_meta_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'meta_accounts' then
    if new.connection_id is not null and not exists (
        select 1 from app.meta_connections c where c.id = new.connection_id and c.workspace_id = new.workspace_id) then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'meta_contacts' then
    if not exists (select 1 from app.meta_accounts a
                   where a.id = new.account_id and a.workspace_id = new.workspace_id and a.platform = new.platform)
       or (new.conversation_id is not null and not exists (
             select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id)) then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'conversations' then
    if new.meta_account_id is not null and not exists (
        select 1 from app.meta_accounts a
        where a.id = new.meta_account_id and a.workspace_id = new.workspace_id
          and a.platform = case new.channel when 'messenger' then 'facebook' else 'instagram' end) then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'attribution_touches' then
    if (new.person_id is not null and not exists (
          select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
       or (new.meta_account_id is not null and not exists (
          select 1 from app.meta_accounts a where a.id = new.meta_account_id and a.workspace_id = new.workspace_id))
       or (new.meta_contact_id is not null and not exists (
          select 1 from app.meta_contacts m where m.id = new.meta_contact_id and m.workspace_id = new.workspace_id))
       or (new.conversation_id is not null and not exists (
          select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
       or (new.message_id is not null and not exists (
          select 1 from app.messages m where m.id = new.message_id and m.workspace_id = new.workspace_id))
       or (new.lead_id is not null and not exists (
          select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
       or (new.ad_ref_id is not null and not exists (
          select 1 from app.ads d where d.id = new.ad_ref_id and d.workspace_id = new.workspace_id)) then
      raise exception 'References must belong to the same workspace'
        using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  end if;
  return new;
end $$;
create trigger meta_accounts_check_refs before insert or update of connection_id on app.meta_accounts
  for each row execute function private.check_meta_refs();
create trigger meta_contacts_check_refs before insert or update of account_id, conversation_id on app.meta_contacts
  for each row execute function private.check_meta_refs();
create trigger conversations_check_meta_refs before insert or update of meta_account_id on app.conversations
  for each row execute function private.check_meta_refs();
create trigger attribution_touches_check_refs before insert or update on app.attribution_touches
  for each row execute function private.check_meta_refs();

-- ---------- what Meta's webhooks need before they know the business ----------
-- The live Page or account a webhook's entry names, and its business.
create or replace function private.meta_account_route(p_platform text, p_external_id text)
returns table (account_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id
  from app.meta_accounts a join app.workspaces w on w.id = a.workspace_id
  where a.platform = p_platform and a.external_id = p_external_id and a.status <> 'disconnected'
  limit 1
$$;

-- Which business answers each of these Pages and accounts now, so connecting one that another business answers can
-- say so instead of failing.
create or replace function private.meta_account_holders(p_external_ids text[])
returns table (platform text, external_id text, workspace_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.platform, a.external_id, a.workspace_id
  from app.meta_accounts a
  where a.external_id = any (p_external_ids) and a.status <> 'disconnected'
$$;

-- The sign-ins a Facebook user made, in every business: when they remove the app, each of them stops.
create or replace function private.meta_connections_of(p_facebook_user_id text)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id
  from app.meta_connections c join app.workspaces w on w.id = c.workspace_id
  where c.facebook_user_id = p_facebook_user_id and c.status <> 'disconnected'
$$;

revoke all on function private.meta_account_route(text, text), private.meta_account_holders(text[]),
  private.meta_connections_of(text), private.check_meta_refs(), private.touches_follow_conversation()
  from public;
grant execute on function private.meta_account_route(text, text), private.meta_account_holders(text[]),
  private.meta_connections_of(text) to service_actor;

-- ---------- the sign-in shares one callback with the others ----------
create or replace function private.oauth_connection_by_state(p_state_hash text)
returns table (kind text, connection_id uuid, workspace_id uuid, organization_id uuid, provider text,
  status text, user_id uuid, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'mailbox', mc.id, mc.workspace_id, w.organization_id, mc.provider::text, mc.status::text, mc.user_id,
    mc.oauth_state_expires_at
  from app.mailbox_connections mc join app.workspaces w on w.id = mc.workspace_id
  where mc.oauth_state_hash = p_state_hash
  union all
  select 'calendar', cc.id, cc.workspace_id, w.organization_id, cc.provider::text, cc.status::text, cc.user_id,
    cc.oauth_state_expires_at
  from app.calendar_connections cc join app.workspaces w on w.id = cc.workspace_id
  where cc.oauth_state_hash = p_state_hash
  union all
  select 'payment', pc.id, pc.workspace_id, w.organization_id, pc.provider::text, pc.status::text, null::uuid,
    pc.oauth_state_expires_at
  from app.payment_connections pc join app.workspaces w on w.id = pc.workspace_id
  where pc.oauth_state_hash = p_state_hash
  union all
  select 'reviews', rc.id, rc.workspace_id, w.organization_id, rc.provider::text, rc.status::text, null::uuid,
    rc.oauth_state_expires_at
  from app.review_connections rc join app.workspaces w on w.id = rc.workspace_id
  where rc.oauth_state_hash = p_state_hash
  union all
  -- Facebook Pages and Instagram accounts for the inbox: the business's, not a person's, and always Facebook's
  -- sign-in, sharing its callback with the Facebook reviews.
  select 'meta', xc.id, xc.workspace_id, w.organization_id, 'facebook', xc.status, null::uuid,
    xc.oauth_state_expires_at
  from app.meta_connections xc join app.workspaces w on w.id = xc.workspace_id
  where xc.oauth_state_hash = p_state_hash
$$;

create or replace function private.oauth_state_started_by(p_state_hash text)
returns uuid language sql stable security definer set search_path = '' as $$
  select x.created_by from (
    select mc.created_by from app.mailbox_connections mc where mc.oauth_state_hash = p_state_hash
    union all
    select cc.created_by from app.calendar_connections cc where cc.oauth_state_hash = p_state_hash
    union all
    select pc.created_by from app.payment_connections pc where pc.oauth_state_hash = p_state_hash
    union all
    select rc.created_by from app.review_connections rc where rc.oauth_state_hash = p_state_hash
    union all
    select mg.created_by from app.migration_connections mg where mg.oauth_state_hash = p_state_hash
    union all
    select xc.created_by from app.meta_connections xc where xc.oauth_state_hash = p_state_hash
  ) x
  limit 1
$$;

revoke all on function private.oauth_state_started_by(text) from public;
grant execute on function private.oauth_state_started_by(text) to service_actor;

-- ---------- Meta's webhooks are stored like everybody else's ----------
alter table app.webhook_deliveries
  drop constraint webhook_deliveries_provider_check,
  add constraint webhook_deliveries_provider_check
    check (provider in ('twilio', 'postmark', 'microsoft', 'google', 'fake', 'workflow', 'stripe', 'square', 'addon',
      'meta'));

-- ---------- a Messenger or Instagram message is contact, as a text is ----------
create or replace function private.activity_contact(p_kind app.activity_kind, p_subtype text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind::text in ('sms', 'email', 'chat', 'portal', 'messenger', 'instagram')
      then case when p_subtype = 'outbound' then 'outreach' else 'contact' end
    when p_kind::text = 'call' then case
      when p_subtype in ('missed', 'outbound_missed') then null
      when p_subtype = 'voicemail' then 'contact'
      else 'outreach'
    end
    when p_kind::text = 'visit' then 'outreach'
  end
$$;

-- ---------- a stranger on Messenger or Instagram becomes a lead, as one who texts does ----------
drop index app.intake_sources_channel_unique;
create unique index intake_sources_channel_unique on app.intake_sources (workspace_id, kind)
  where kind in ('text', 'call', 'email', 'messenger', 'instagram');

-- ---------- RLS ----------
alter table app.meta_connections enable row level security;
alter table app.meta_accounts enable row level security;
alter table app.meta_contacts enable row level security;
alter table app.ads enable row level security;
alter table app.attribution_touches enable row level security;

-- The team sees what's connected; connecting and disconnecting is the business's own decision (channels.manage).
create policy meta_connections_select on app.meta_connections for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Starting a sign-in is all a browser may write, and only ever a pending one with nothing in it.
create policy meta_connections_insert on app.meta_connections for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage')
    and created_by = (select auth.uid()) and status = 'pending'
    and facebook_user_id is null and token_enc is null and token_key_id is null and token_expires_at is null
    and connected_at is null and disconnected_at is null);
create policy meta_connections_update on app.meta_connections for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy meta_connections_service_all on app.meta_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy meta_accounts_select on app.meta_accounts for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy meta_accounts_update on app.meta_accounts for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy meta_accounts_service_all on app.meta_accounts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Who wrote in: as visible as their thread, so a narrowed inbox (0083) narrows these too.
create policy meta_contacts_select on app.meta_contacts for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and (conversation_id is null or exists (select 1 from app.conversations c where c.id = conversation_id)));
create policy meta_contacts_service_all on app.meta_contacts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- Where a customer came from is part of their record, which everybody in the business reads.
create policy ads_select on app.ads for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy ads_service_all on app.ads for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy attribution_touches_select on app.attribution_touches for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy attribution_touches_service_all on app.attribution_touches for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- No token ever reaches a browser: people read what is connected and how it is doing, and nothing else.
grant select (id, workspace_id, status, facebook_user_name, scopes, token_expires_at, last_checked_at, last_error,
  disconnected_reason, connected_at, disconnected_at, created_by, created_at, updated_at)
  on app.meta_connections to authenticated;
-- The policy is what keeps a token or a result out of the one row a browser may start.
grant insert on app.meta_connections to authenticated;
-- Disconnecting, and nothing else: it forgets the token as it goes.
grant update (status, disconnected_at, disconnected_reason, token_enc, token_key_id, oauth_state_hash,
  oauth_state_expires_at, updated_at)
  on app.meta_connections to authenticated;
grant select (id, workspace_id, connection_id, platform, external_id, page_id, name, username, status, human_agent,
  subscribed_at, failures, last_error, problem, disconnected_reason, connected_at, disconnected_at, connected_by,
  created_at, updated_at)
  on app.meta_accounts to authenticated;
grant update (status, problem, disconnected_at, disconnected_reason, token_enc, token_key_id, updated_at)
  on app.meta_accounts to authenticated;
grant select on app.meta_contacts, app.ads, app.attribution_touches to authenticated;
grant select, insert, update, delete on app.meta_connections, app.meta_accounts, app.meta_contacts, app.ads,
  app.attribution_touches to service_actor;
revoke all on app.meta_connections, app.meta_accounts, app.meta_contacts, app.ads, app.attribution_touches
  from anon;

comment on table app.meta_connections is
  'A Facebook sign-in a business made to connect its Pages and Instagram accounts to the inbox.';
comment on table app.meta_accounts is
  'A Facebook Page or Instagram professional account whose direct messages this business answers.';
comment on table app.meta_contacts is
  'Somebody who wrote to a Page or Instagram account, by the id Meta gives them for it, and their thread.';
comment on table app.ads is 'An ad, as its network describes it: campaign, ad set and creative. One per ad per business.';
comment on table app.attribution_touches is
  'Each time somebody reached the business from an ad or a link, as it came. Never overwrites the customer''s source.';

-- ---------- a merge takes the touches with the customer ----------
create or replace function private.merge_people(p_workspace uuid, p_from uuid, p_into uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from app.people%rowtype;
  v_into app.people%rowtype;
  v_moved jsonb := '{}'::jsonb;
  v_n integer;
  v_ref text[];
  v_rel app.relationships%rowtype;
  v_assign boolean;
  -- Every table whose rows simply follow the customer: table, column, and the name its count goes by.
  v_simple constant text[][] := array[
    array['leads', 'person_id', 'leads'],
    array['tasks', 'person_id', 'tasks'],
    array['activities', 'person_id', 'timeline'],
    array['conversations', 'person_id', 'conversations'],
    array['calls', 'person_id', 'calls'],
    array['email_inbound_unmatched', 'resolved_person_id', 'emails'],
    array['workflow_runs', 'person_id', 'workflow_runs'],
    array['ai_teammate_runs', 'person_id', 'ai_runs'],
    array['ai_teammate_drafts', 'person_id', 'ai_drafts'],
    array['chat_visitors', 'person_id', 'chats'],
    array['chat_visitors', 'verified_person_id', 'chats_verified'],
    array['chat_verification_codes', 'person_id', 'chat_codes'],
    array['attention_items', 'person_id', 'attention'],
    array['estimates', 'person_id', 'estimates'],
    array['invoices', 'person_id', 'invoices'],
    array['subscriptions', 'person_id', 'plans'],
    array['intake_submissions', 'person_id', 'intake'],
    array['reviews', 'person_id', 'reviews'],
    array['thank_yous', 'person_id', 'thank_yous'],
    array['referrals', 'person_id', 'referrals'],
    array['referrals', 'referrer_person_id', 'referred'],
    array['jobs', 'person_id', 'jobs'],
    array['promises', 'person_id', 'promises'],
    array['ai_calls', 'person_id', 'ai_calls'],
    array['attribution_touches', 'person_id', 'ad_touches']
  ];
begin
  -- Asked here, not taken on trust: this writes past every policy.
  if not (coalesce(private.has_permission(p_workspace, 'records.archive'), false)
          or coalesce(private.system_scope_workspace() = p_workspace, false)) then
    raise exception 'Merging customers needs the records.archive permission'
      using errcode = '42501', detail = 'person_merge_forbidden';
  end if;
  if p_from = p_into then
    raise exception 'A customer can’t be merged into themselves' using errcode = '22023', detail = 'person_merge_self';
  end if;

  -- Both rows, locked in the same order whichever way round they come, so two merges of the same pair wait.
  perform 1 from app.people p where p.id in (p_from, p_into) and p.workspace_id = p_workspace
    order by p.id for update;
  select * into v_from from app.people p where p.id = p_from and p.workspace_id = p_workspace;
  if not found then
    raise exception 'Person not found' using errcode = 'P0002', detail = 'person_missing';
  end if;
  select * into v_into from app.people p where p.id = p_into and p.workspace_id = p_workspace;
  if not found then
    raise exception 'Person not found' using errcode = 'P0002', detail = 'person_missing';
  end if;
  if v_from.merged_into_id is not null then
    raise exception 'That customer was already merged into another one' using errcode = '55000', detail = 'person_already_merged';
  end if;
  if v_into.merged_into_id is not null or v_into.archived_at is not null then
    raise exception 'Bring the customer you’re keeping back before merging into them'
      using errcode = '55000', detail = 'person_merge_into_archived';
  end if;

  insert into private.person_merges (from_person_id, into_person_id, workspace_id) values (p_from, p_into, p_workspace);

  foreach v_ref slice 1 in array v_simple loop
    execute format('update app.%I set %I = $1 where workspace_id = $2 and %I = $3', v_ref[1], v_ref[2], v_ref[2])
      using p_into, p_workspace, p_from;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_moved := jsonb_set(v_moved, array[v_ref[3]], to_jsonb(coalesce((v_moved ->> v_ref[3])::int, 0) + v_n));
    end if;
  end loop;

  -- One per customer, so a row the kept record already has its own of stays with the duplicate.
  update app.appointment_attendees a set person_id = p_into
   where a.workspace_id = p_workspace and a.person_id = p_from
     and not exists (select 1 from app.appointment_attendees o where o.appointment_id = a.appointment_id and o.person_id = p_into);
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('appointments', v_n); end if;

  update app.form_responses r set person_id = p_into
   where r.workspace_id = p_workspace and r.person_id = p_from
     and not (r.one_per_person and r.status = 'completed' and exists (
       select 1 from app.form_responses o
       where o.form_id = r.form_id and o.person_id = p_into and o.one_per_person and o.status = 'completed'));
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('forms', v_n); end if;

  update app.campaign_recipients r set person_id = p_into
   where r.workspace_id = p_workspace and r.person_id = p_from
     and not exists (select 1 from app.campaign_recipients o where o.campaign_id = r.campaign_id and o.person_id = p_into);
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('campaigns', v_n); end if;

  -- A place on the waitlist for a time the kept record is already waiting for is let go; the rest move.
  update app.waitlist_entries w set status = 'removed'
   where w.workspace_id = p_workspace and w.person_id = p_from and w.appointment_id is not null
     and w.status in ('waiting', 'offered')
     and exists (select 1 from app.waitlist_entries o
                 where o.appointment_id = w.appointment_id and o.person_id = p_into and o.status in ('waiting', 'offered'));
  update app.waitlist_entries w set person_id = p_into where w.workspace_id = p_workspace and w.person_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('waitlist', v_n); end if;

  -- The same thing twice: the kept record's own schedule and reminders stand.
  delete from app.service_schedules s
   where s.workspace_id = p_workspace and s.person_id = p_from
     and exists (select 1 from app.service_schedules o where o.person_id = p_into and o.service_id = s.service_id);
  update app.service_schedules s set person_id = p_into where s.workspace_id = p_workspace and s.person_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('service_schedules', v_n); end if;

  delete from app.maintenance_reminders m
   where m.workspace_id = p_workspace and m.person_id = p_from
     and exists (select 1 from app.maintenance_reminders o
                 where o.person_id = p_into and o.service_id = m.service_id and o.due_on = m.due_on);
  update app.maintenance_reminders m set person_id = p_into where m.workspace_id = p_workspace and m.person_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('maintenance_reminders', v_n); end if;

  -- An attention item about the duplicate itself: the kept record's own item of the same kind stands.
  delete from app.attention_items i
   where i.workspace_id = p_workspace and i.subject_type = 'person' and i.subject_id = p_from
     and exists (select 1 from app.attention_items o
                 where o.workspace_id = p_workspace and o.kind = i.kind and o.subject_type = 'person' and o.subject_id = p_into);
  update app.attention_items i set subject_id = p_into
   where i.workspace_id = p_workspace and i.subject_type = 'person' and i.subject_id = p_from;

  -- Files kept on the customer's page.
  update app.files f set record_id = p_into
   where f.workspace_id = p_workspace and f.record_type = 'person' and f.record_id = p_from;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('files', v_n); end if;

  -- Tags: the kept record gets every tag either had. The duplicate keeps its own, as it was.
  insert into app.record_tags (workspace_id, tag_id, record_type, record_id, created_by, created_at)
  select t.workspace_id, t.tag_id, t.record_type, p_into, t.created_by, t.created_at
    from app.record_tags t
   where t.workspace_id = p_workspace and t.record_type = 'person' and t.record_id = p_from
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('tags', v_n); end if;

  -- Relationships: one between the two records goes; the rest are written again on the kept record, through
  -- 0101's own check (which orders a mutual pair and holds a one-to-one to one). One the kept record already has,
  -- or can't take, stays with the duplicate.
  delete from app.relationships r
   where r.workspace_id = p_workspace
     and ((r.a_person_id = p_from and r.b_person_id = p_into) or (r.a_person_id = p_into and r.b_person_id = p_from));
  v_n := 0;
  for v_rel in
    select * from app.relationships r
     where r.workspace_id = p_workspace and (r.a_person_id = p_from or r.b_person_id = p_from)
  loop
    begin
      delete from app.relationships r where r.id = v_rel.id;
      insert into app.relationships (id, workspace_id, type_id, a_person_id, a_company_id, a_custom_record_id,
                                     b_person_id, b_company_id, b_custom_record_id, note, created_by, created_at)
      values (v_rel.id, v_rel.workspace_id, v_rel.type_id,
              case when v_rel.a_person_id = p_from then p_into else v_rel.a_person_id end,
              v_rel.a_company_id, v_rel.a_custom_record_id,
              case when v_rel.b_person_id = p_from then p_into else v_rel.b_person_id end,
              v_rel.b_company_id, v_rel.b_custom_record_id, v_rel.note, v_rel.created_by, v_rel.created_at);
      v_n := v_n + 1;
    exception when unique_violation or check_violation then
      null; -- stays with the duplicate, as it was
    end;
  end loop;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('relationships', v_n); end if;

  -- Anybody flagged as maybe the duplicate is now maybe the kept record; the kept record's own flag, if it
  -- pointed at the duplicate, is settled.
  update app.people p set possible_duplicate_of = case when p.id = p_into then null else p_into end
   where p.workspace_id = p_workspace and p.possible_duplicate_of = p_from;

  -- Who the customer is assigned to (0104) is the managers' call, as on the screen: settled only for someone
  -- who may assign. The kept record's owner stands; the duplicate's owner and team join its team, those of them
  -- still in the business.
  v_assign := coalesce(private.has_permission(p_workspace, 'records.assign'), false)
    or coalesce(private.system_scope_workspace() = p_workspace, false);
  update app.people p set
    owner_user_id = case when v_assign and p.owner_user_id is null
        and private.workspace_has_user(p_workspace, v_from.owner_user_id)
      then v_from.owner_user_id else p.owner_user_id end,
    team_user_ids = case when v_assign then p.team_user_ids || array(
        select t.u from unnest(array[v_from.owner_user_id] || v_from.team_user_ids) with ordinality as t(u, n)
        where t.u is not null and private.workspace_has_user(p_workspace, t.u)
        order by t.n)
      else p.team_user_ids end,
    -- Custom fields: the kept record's answers stand; the duplicate fills in the ones it left blank, for the
    -- fields the business still has (0076's check refuses a new answer to an archived one).
    custom = coalesce((
        select jsonb_object_agg(e.key, e.value) from jsonb_each(v_from.custom) as e
        where exists (
          select 1 from app.custom_fields f
          where f.workspace_id = p_workspace and f.entity = 'person' and f.archived_at is null
            and f.record_type_id is null and f.id::text = e.key)
      ), '{}'::jsonb) || jsonb_strip_nulls(p.custom),
    -- Never text someone who said stop: a STOP on either record holds. A yes carries over only for the very
    -- number the kept record now has, when it had no answer of its own.
    sms_consent = case
      when v_from.sms_consent = 'opted_out' and p.sms_consent <> 'opted_out' then v_from.sms_consent
      when p.sms_consent = 'unknown' and v_from.sms_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.sms_consent
      else p.sms_consent end,
    sms_consent_at = case
      when v_from.sms_consent = 'opted_out' and p.sms_consent <> 'opted_out' then v_from.sms_consent_at
      when p.sms_consent = 'unknown' and v_from.sms_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.sms_consent_at
      else p.sms_consent_at end,
    sms_consent_source = case
      when v_from.sms_consent = 'opted_out' and p.sms_consent <> 'opted_out' then v_from.sms_consent_source
      when p.sms_consent = 'unknown' and v_from.sms_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.sms_consent_source
      else p.sms_consent_source end,
    call_consent = case
      when v_from.call_consent = 'opted_out' and p.call_consent <> 'opted_out' then v_from.call_consent
      when p.call_consent = 'unknown' and v_from.call_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.call_consent
      else p.call_consent end,
    call_consent_at = case
      when v_from.call_consent = 'opted_out' and p.call_consent <> 'opted_out' then v_from.call_consent_at
      when p.call_consent = 'unknown' and v_from.call_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.call_consent_at
      else p.call_consent_at end,
    call_consent_source = case
      when v_from.call_consent = 'opted_out' and p.call_consent <> 'opted_out' then v_from.call_consent_source
      when p.call_consent = 'unknown' and v_from.call_consent = 'opted_in' and v_from.phone_e164 = p.phone_e164
        then v_from.call_consent_source
      else p.call_consent_source end
  where p.id = p_into;

  -- The duplicate: archived (0006's guard asks for records.archive again and says by whom), and marked.
  update app.people p set
    archived_at = coalesce(p.archived_at, private.change_moment()),
    merged_into_id = p_into,
    merged_at = now(),
    possible_duplicate_of = null
  where p.id = p_from;

  delete from private.person_merges m where m.from_person_id = p_from;
  return v_moved;
end $$;

revoke all on function private.merge_people(uuid, uuid, uuid) from public;
grant execute on function private.merge_people(uuid, uuid, uuid) to authenticated, service_actor;
