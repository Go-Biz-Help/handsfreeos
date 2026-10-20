-- =============================================================================
-- A business at a glance, for the support desk's quick look (/admin/businesses).
--
--        Clicking a business on the directory opens it in a window instead of a
--        page. That window says more than the page did: what needs a look, the
--        plan, 30 days of activity, the money their customers paid them, what
--        is connected and how, where they came from. Support reads none of
--        these tables under the ordinary rules, so, like admin_business_counts,
--        each answer comes from a function that checks the permission itself.
--
--        admin_business_attention is the one place the "needs a look" rules
--        live: the directory filters and badges by it, and the window says why.
--        Only keys come back; @hfos/core turns them into words.
--
--        Read-only, and adds functions only, so it can go on before the code.
-- =============================================================================

-- What needs a look, most serious first. Keys, never words: core says them.
--   being_deleted       an owner asked to delete the business
--   wallet_suspended    the balance is suspended
--   card_declined       the card on the balance was declined, and still is
--   balance_out         a balance they are shown has run out
--   plan_trouble        the plan's renewal failed, or it is in grace or past due
--   texting_rejected    a texting registration was rejected or failed
--   connection_broken   a payments, calendar, mailbox or Meta connection needs signing in again
--   texting_waiting     a texting registration has waited on the carriers over 10 days
--   thin_margin         30 days of charges came to under 1.2× what they cost us (core's DESK_THIN_MARGIN)
--   gone_quiet          nobody there has done anything in 14 days
--   setup_stalled       a week or more in, Getting started isn't finished (checked for the first 60 days)
create function private.admin_business_attention(p_ws uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  with ws as (
    select w.id, w.created_at, w.deletion_requested_at
    from app.workspaces w
    where w.id = p_ws and private.staff_can('platform.businesses.read')
  ),
  wallet as (
    select uw.stage::text as stage, uw.balance_cents, uw.declines_in_row, uw.suspended_at
    from app.usage_wallets uw where uw.workspace_id = p_ws
  ),
  usage as (
    select coalesce(sum(abs(l.amount_cents)) filter (where l.amount_cents < 0), 0) as charged,
           coalesce(sum(coalesce(l.cost_cents, 0)), 0) as cost
    from app.usage_ledger l
    where l.workspace_id = p_ws and l.occurred_at > now() - interval '30 days'
  ),
  registration as (
    select distinct on (r.kind) r.kind, r.status::text as status,
           coalesce(r.carrier_submitted_at, r.submitted_at, r.created_at) as since
    from app.telephony_registrations r
    where r.workspace_id = p_ws
    order by r.kind, r.created_at desc
  )
  select array_remove(array[
    case when ws.deletion_requested_at is not null then 'being_deleted' end,
    case when exists (select 1 from wallet where suspended_at is not null) then 'wallet_suspended' end,
    case when exists (select 1 from wallet where declines_in_row > 0) then 'card_declined' end,
    case when exists (select 1 from wallet where stage in ('warn', 'enforce') and balance_cents <= 0)
      then 'balance_out' end,
    case when exists (select 1 from app.workspace_plans p where p.workspace_id = p_ws
        and (p.status in ('grace', 'past_due') or p.renewal_problem is not null))
      then 'plan_trouble' end,
    case when exists (select 1 from registration where status in ('rejected', 'failed'))
      then 'texting_rejected' end,
    case when exists (select 1 from app.payment_connections c where c.workspace_id = p_ws
          and c.status in ('reauth_required', 'error'))
        or exists (select 1 from app.calendar_connections c where c.workspace_id = p_ws
          and c.status in ('reauth_required', 'error'))
        or exists (select 1 from app.mailbox_connections c where c.workspace_id = p_ws
          and c.status in ('reauth_required', 'error'))
        or exists (select 1 from app.meta_connections c where c.workspace_id = p_ws
          and c.status = 'needs_attention')
      then 'connection_broken' end,
    case when exists (select 1 from registration where status in ('submitted', 'in_review')
        and since < now() - interval '10 days')
      then 'texting_waiting' end,
    case when exists (select 1 from usage where cost > 0 and charged < cost * 1.2) then 'thin_margin' end,
    case when ws.created_at < now() - interval '14 days'
        and coalesce((select max(e.created_at) from app.events e where e.workspace_id = p_ws), ws.created_at)
          < now() - interval '14 days'
      then 'gone_quiet' end,
    -- Nested so the events are only read for a business of the right age.
    case when ws.created_at between now() - interval '60 days' and now() - interval '7 days' then
      case when not exists (select 1 from app.events e where e.workspace_id = p_ws
          and e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business')
        and coalesce((select (e.payload ->> 'enabled')::boolean from app.events e
          where e.workspace_id = p_ws and e.event_type = 'onboarding.enabled_changed'
          order by e.created_at desc limit 1), true)
      then 'setup_stalled' end
    end
  ], null)
  from ws
$$;

-- The plan a business is on, for a row of the directory: founding_free, founding_lifetime, monthly, or null.
create function private.admin_business_plan(p_ws uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select p.plan::text from app.workspace_plans p
  where p.workspace_id = p_ws and private.staff_can('platform.businesses.read')
$$;

-- Everything else the quick look shows, as one document. Counts and states only: never a message, a
-- customer's name, a token or a card number. Money is in cents; the 30 days of activity are counted in the
-- business's own time zone, oldest first, ending today.
create function private.admin_business_glance(p_ws uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'attention', to_jsonb(private.admin_business_attention(w.id)),
    'deletionRequestedAt', w.deletion_requested_at,
    'plan', (
      select jsonb_build_object(
        'plan', p.plan, 'status', p.status, 'priceCents', p.price_cents,
        'periodEnd', p.current_period_end, 'graceEndsAt', p.grace_ends_at, 'canceledAt', p.canceled_at,
        'renewalStoppedAt', p.renewal_stopped_at, 'renewalProblem', p.renewal_problem,
        'renewalFailedAt', p.renewal_failed_at)
      from app.workspace_plans p where p.workspace_id = w.id),
    'activity', (
      select jsonb_agg(coalesce(c.n, 0) order by g.i desc)
      from generate_series(0, 29) as g(i)
      left join (
        select (e.created_at at time zone w.timezone)::date as day, count(*) as n
        from app.events e
        where e.workspace_id = w.id and e.created_at > now() - interval '31 days'
        group by 1
      ) c on c.day = (now() at time zone w.timezone)::date - g.i),
    'traffic', (
      select jsonb_build_object(
        'texts', count(*) filter (where m.channel = 'sms'),
        'emails', count(*) filter (where m.channel = 'email'),
        'aiReplies', count(*) filter (where m.sent_by_teammate_id is not null),
        'calls', (select count(*) from app.calls c
          where c.workspace_id = w.id and c.started_at > now() - interval '30 days'))
      from app.messages m
      where m.workspace_id = w.id and m.occurred_at > now() - interval '30 days'),
    'theirMoney', jsonb_build_object(
      'collected30dCents', (select coalesce(sum(p.amount_cents), 0) from app.payments p
        where p.workspace_id = w.id and p.status = 'succeeded' and p.received_at > now() - interval '30 days'),
      'refunded30dCents', (select coalesce(sum(r.amount_cents), 0) from app.refunds r
        where r.workspace_id = w.id and r.status = 'succeeded' and r.refunded_at > now() - interval '30 days'),
      'openInvoices', (select count(*) from app.invoices i
        where i.workspace_id = w.id and i.status in ('sent', 'partly_paid', 'overdue')),
      'openInvoiceCents', (select coalesce(sum(i.total_cents - i.amount_paid_cents), 0) from app.invoices i
        where i.workspace_id = w.id and i.status in ('sent', 'partly_paid', 'overdue')),
      'overdueInvoices', (select count(*) from app.invoices i
        where i.workspace_id = w.id and i.status = 'overdue'),
      'openDisputes', (select count(*) from app.payment_disputes d
        where d.workspace_id = w.id and d.status = 'open')),
    'setup', jsonb_build_object(
      'numbers', (select coalesce(jsonb_agg(n.e164 order by n.is_default desc, n.created_at), '[]'::jsonb)
        from app.phone_numbers n where n.workspace_id = w.id and n.released_at is null),
      'registration', (
        select case when count(*) = 0 then null else jsonb_build_object(
          'state', case
            when bool_or(r.status in ('rejected', 'failed')) then 'rejected'
            when bool_or(r.status in ('submitted', 'in_review')) then 'waiting'
            when bool_and(r.status = 'approved') then 'approved'
            else 'draft' end,
          'since', min(r.since) filter (where r.status in ('submitted', 'in_review')),
          'reason', max(r.rejection_reason) filter (where r.status in ('rejected', 'failed'))) end
        from (
          select distinct on (t.kind) t.status::text as status, t.rejection_reason,
                 coalesce(t.carrier_submitted_at, t.submitted_at, t.created_at) as since
          from app.telephony_registrations t where t.workspace_id = w.id
          order by t.kind, t.created_at desc
        ) r),
      'emailDomain', (
        select jsonb_build_object('domain', d.domain, 'status', d.status)
        from app.email_domains d where d.workspace_id = w.id
        order by d.status = 'verified' desc, d.created_at desc limit 1),
      'emailAddresses', (select count(*) from app.email_addresses a where a.workspace_id = w.id),
      'mailboxes', (select coalesce(jsonb_agg(jsonb_build_object('provider', c.provider, 'status', c.status)
          order by c.created_at), '[]'::jsonb)
        from app.mailbox_connections c where c.workspace_id = w.id and c.status <> 'disconnected'),
      'payments', (select coalesce(jsonb_agg(jsonb_build_object('provider', c.provider, 'status', c.status)
          order by c.is_default desc, c.created_at), '[]'::jsonb)
        from app.payment_connections c where c.workspace_id = w.id and c.status <> 'disconnected'),
      'calendarConnections', (select coalesce(jsonb_agg(jsonb_build_object('provider', c.provider, 'status', c.status)
          order by c.created_at), '[]'::jsonb)
        from app.calendar_connections c where c.workspace_id = w.id and c.status <> 'disconnected'),
      'calendars', (select count(*) from app.calendars c where c.workspace_id = w.id and c.status = 'active'),
      'bookingPage', (select jsonb_build_object('slug', b.slug::text, 'enabled', b.enabled)
        from app.booking_sites b where b.workspace_id = w.id),
      'aiTeammate', (select t.status from app.ai_teammates t
        where t.workspace_id = w.id and t.archived_at is null order by t.created_at limit 1),
      'meta', (select c.status from app.meta_connections c
        where c.workspace_id = w.id and c.status <> 'disconnected' order by c.created_at desc limit 1),
      'gettingStarted', case
        when exists (select 1 from app.events e where e.workspace_id = w.id
          and e.event_type = 'onboarding.finished' and e.payload ->> 'audience' = 'business') then 'finished'
        when (select (e.payload ->> 'enabled')::boolean from app.events e
          where e.workspace_id = w.id and e.event_type = 'onboarding.enabled_changed'
          order by e.created_at desc limit 1) is false then 'off'
        when exists (select 1 from app.events e where e.workspace_id = w.id
          and e.event_type like 'onboarding.%') then 'started'
        else 'not_started' end),
    'more', jsonb_build_object(
      'cameFrom', (
        select jsonb_build_object('source', m.source_system, 'status', m.status,
          'at', coalesce(m.finalized_at, m.imported_at, m.started_at))
        from app.migration_scopes s join app.migrations m on m.id = s.migration_id
        where s.workspace_id = w.id and m.status <> 'draft' and m.cancelled_at is null
        order by coalesce(m.started_at, m.created_at) desc limit 1),
      'addons', (select coalesce(jsonb_agg(a.addon_id order by a.addon_id), '[]'::jsonb)
        from app.addon_installations a where a.workspace_id = w.id and a.state = 'enabled'),
      'mainOffer', (select jsonb_build_object('liveVersion', o.live_version, 'revision', o.revision)
        from app.main_offers o where o.workspace_id = w.id),
      'supportAccess', (
        select jsonb_build_object('status', g.status, 'expiresAt', g.expires_at)
        from app.record_support_grants g where g.workspace_id = w.id
        order by g.created_at desc limit 1),
      'lastViewedAs', (
        select max(v.started_at) from platform.view_as_sessions v where v.workspace_id = w.id)),
    'problemReports', jsonb_build_object(
      'open', (select count(*) from app.problem_reports r
        where r.workspace_id = w.id and r.handled_at is null),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', r.id, 'area', r.area, 'note', left(r.note, 200), 'createdAt', r.created_at,
          'handled', r.handled_at is not null) order by r.created_at desc), '[]'::jsonb)
        from (select * from app.problem_reports p where p.workspace_id = w.id
              order by p.created_at desc limit 5) r))
  )
  from app.workspaces w
  where w.id = p_ws and private.staff_can('platform.businesses.read')
$$;

revoke all on function
  private.admin_business_attention(uuid), private.admin_business_plan(uuid), private.admin_business_glance(uuid)
  from public;
grant execute on function
  private.admin_business_attention(uuid), private.admin_business_plan(uuid), private.admin_business_glance(uuid)
  to authenticated;
