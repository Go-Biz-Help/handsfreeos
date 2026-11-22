-- =============================================================================
-- The founder, at work in a business as its owner.
--
--        The founder opens any business as its owner (20261013002100). The
--        rules ask about the person asking through has_permission,
--        my_permissions and my_workspace_role, which answer as for an owner
--        while the session is open. Two kinds of rule asked something else,
--        "is this person one of the business's own people", and so turned
--        the founder away from work an owner does every day.
--
--        **1. Is this one of the businesses they work in**
--        (effective_workspace_role). The founder's open business is never
--        one of those, so inside it:
--
--          * Get help said the business wasn't there, and so did everything
--            else that opens a support ticket in the person's name: asking
--            for RCS, and help with a texting registration;
--          * sharing an idea, or voting for one, from the business was
--            refused the same way.
--
--        All three now ask my_workspace_role: the business's own people as
--        before, and the founder while they have it open as its owner.
--        Support's read-only look (M13) still gets nothing here: it holds no
--        role in the business, so my_workspace_role answers null for it.
--
--        **2. Is whoever did this one of its people** (workspace_has_user).
--        The guards that keep one business's rows from naming another
--        business's people also check the columns that say who did
--        something: who made an invoice, who recorded a payment, who hosts a
--        video call. The founder is in no business, so each of those said
--        "Something you picked belongs to another business": adding a
--        product or a plan, writing an invoice or an estimate, recording a
--        payment, connecting a payment account, starting a video call,
--        dismissing an Action Center item, deciding the AI teammate's draft.
--
--        Those columns now ask workspace_has_actor: one of the business's
--        people, or someone who has worked in it as its owner. "Changes made
--        while it is open are the founder's own and are recorded under their
--        name, as any owner's are" (20261013002100): this is that name.
--
--        It asks whether they have ever held such a session there, not
--        whether one is open now. These guards run again whenever a row is
--        saved, long after the founder has left, and the row must still
--        save. Whether the founder may make the change at all is not decided
--        here: has_permission decides it, and only while the session is
--        open.
--
--        **What stays.** The columns that say whose something is, or who is
--        on it, still take only the business's own people: who an invoice or
--        an Action Center item is assigned to, who owns a calendar or is on
--        its team, who is booked, who signs, who approves. The founder is
--        still on none of the business's lists and is assigned none of its
--        work. effective_workspace_role and workspace_has_user are
--        untouched.
-- =============================================================================

-- ---------- 1. asking for help, and ideas ----------

-- Asking for help from inside HandsFreeOS. The person is in the business they are asking about, and that
-- is the whole check: they may open a ticket about their own business and nothing else. Their name, their
-- address and their business are taken from the database, never from what the screen sent.
create or replace function private.open_support_ticket(
  p_workspace uuid,
  p_subject text,
  p_body text,
  p_context jsonb
) returns table (ticket_id uuid, ticket_number bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_ticket uuid;
  v_number bigint;
  v_email extensions.citext;
  v_name text;
  v_org uuid;
begin
  if private.my_workspace_role(p_workspace) is null then
    raise exception 'Workspace not found' using errcode = '42501', detail = 'not_a_member';
  end if;
  select u.email, u.full_name into v_email, v_name from app.users u where u.id = auth.uid();
  if v_email is null then
    raise exception 'Sign in first' using errcode = '42501', detail = 'no_user';
  end if;
  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  insert into platform.tickets (
    subject, channel, requester_email, requester_name, requester_user_id,
    workspace_id, organization_id, last_customer_at)
  values (
    left(coalesce(nullif(btrim(p_subject), ''), 'Help please'), 500), 'in_app', v_email,
    coalesce(v_name, ''), auth.uid(), p_workspace, v_org, now())
  returning id, number into v_ticket, v_number;
  insert into platform.ticket_messages (ticket_id, author, body_text)
  values (v_ticket, 'customer', left(coalesce(p_body, ''), 100000));
  insert into platform.ticket_events (ticket_id, kind, actor_user_id, data)
  values (v_ticket, 'opened', auth.uid(), coalesce(p_context, '{}'::jsonb));
  return query select v_ticket, v_number;
end $$;

-- Shared in your own name, from a business you work in or have open as its owner (not one you are only looking at).
alter policy ideas_share on platform.ideas
  with check (author_user_id = (select auth.uid()) and (select private.takes_part_in_ideas())
    and (workspace_id is null or private.my_workspace_role(workspace_id) is not null));

-- Voting is for an idea still open, from a business the same way.
alter policy idea_votes_cast on platform.idea_votes
  with check (user_id = (select auth.uid()) and (select private.takes_part_in_ideas())
    and (workspace_id is null or private.my_workspace_role(workspace_id) is not null)
    and exists (select 1 from platform.ideas i
      where i.id = idea_id and i.hidden_at is null and i.merged_into is null
        and i.status not in ('done', 'not_planned')));

-- ---------- 2. what the founder does is kept under their name ----------

-- Someone who may be named as having done something in this business: one of its own people, or the founder,
-- who has worked in it as its owner. Only the founder writes a session that acts (view_as_write), and the platform
-- keeps every one, so the answer stays true after they leave. Only the guards below ask, and they run as their
-- owner, so no request is granted it.
create or replace function private.workspace_has_actor(p_ws uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.workspace_has_user(p_ws, p_user)
    or exists (
      select 1 from platform.view_as_sessions v
      where v.workspace_id = p_ws and v.staff_user_id = p_user and v.acts)
$$;
revoke all on function private.workspace_has_actor(uuid, uuid) from public;

-- Each guard below is as it was, with workspace_has_actor asked of the columns that say who did something.

-- Products and plans: who added one.
create or replace function private.check_money_catalog_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'products' then
    v_ok := (new.service_id is null or (tg_op = 'UPDATE' and new.service_id is not distinct from old.service_id)
      or exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id));
  end if;
  v_ok := v_ok and (new.created_by is null or (tg_op = 'UPDATE' and new.created_by is not distinct from old.created_by)
    or private.workspace_has_actor(new.workspace_id, new.created_by));
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- Invoices and estimates: who made, voided or accepted one. Who looks after it is still one of the business's people.
create or replace function private.check_money_document_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name in ('estimates', 'invoices') then
    v_ok := (tg_op = 'UPDATE' or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or (tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id)
        or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      and (new.assignee_user_id is null or (tg_op = 'UPDATE' and new.assignee_user_id is not distinct from old.assignee_user_id)
        or private.workspace_has_user(new.workspace_id, new.assignee_user_id))
      and (new.voided_by is null or (tg_op = 'UPDATE' and new.voided_by is not distinct from old.voided_by)
        or private.workspace_has_actor(new.workspace_id, new.voided_by))
      and (new.created_by is null or (tg_op = 'UPDATE' and new.created_by is not distinct from old.created_by)
        or private.workspace_has_actor(new.workspace_id, new.created_by));
  end if;
  if tg_table_name = 'estimates' then
    v_ok := v_ok and (new.accepted_by is null or (tg_op = 'UPDATE' and new.accepted_by is not distinct from old.accepted_by)
      or private.workspace_has_actor(new.workspace_id, new.accepted_by));
  elsif tg_table_name = 'invoices' then
    v_ok := v_ok
      and (new.estimate_id is null or (tg_op = 'UPDATE' and new.estimate_id is not distinct from old.estimate_id)
        or exists (select 1 from app.estimates e where e.id = new.estimate_id and e.workspace_id = new.workspace_id))
      and (new.attendee_id is null or (tg_op = 'UPDATE' and new.attendee_id is not distinct from old.attendee_id)
        or exists (select 1 from app.appointment_attendees a where a.id = new.attendee_id and a.workspace_id = new.workspace_id));
  elsif tg_table_name = 'estimate_lines' then
    v_ok := exists (select 1 from app.estimates e where e.id = new.estimate_id and e.workspace_id = new.workspace_id)
      and (new.product_id is null
        or exists (select 1 from app.products p where p.id = new.product_id and p.workspace_id = new.workspace_id));
  elsif tg_table_name = 'invoice_lines' then
    v_ok := exists (select 1 from app.invoices i where i.id = new.invoice_id and i.workspace_id = new.workspace_id)
      and (new.product_id is null
        or exists (select 1 from app.products p where p.id = new.product_id and p.workspace_id = new.workspace_id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- A payment account: who connected it.
create or replace function private.check_payment_connection_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if new.created_by is not null and not private.workspace_has_actor(new.workspace_id, new.created_by) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- Payments and refunds: who recorded one, who asked for one.
create or replace function private.check_payment_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  v_ok := (new.connection_id is null or (tg_op = 'UPDATE' and new.connection_id is not distinct from old.connection_id)
      or exists (select 1 from app.payment_connections c
        where c.id = new.connection_id and c.workspace_id = new.workspace_id));
  if tg_table_name = 'payments' then
    v_ok := v_ok
      and exists (select 1 from app.invoices i where i.id = new.invoice_id and i.workspace_id = new.workspace_id)
      and (new.recorded_by is null or (tg_op = 'UPDATE' and new.recorded_by is not distinct from old.recorded_by)
        or private.workspace_has_actor(new.workspace_id, new.recorded_by));
  else
    -- A refund belongs to its payment, and to the same invoice that payment paid.
    v_ok := v_ok
      and exists (select 1 from app.payments p
        where p.id = new.payment_id and p.workspace_id = new.workspace_id and p.invoice_id = new.invoice_id)
      and (new.requested_by is null or (tg_op = 'UPDATE' and new.requested_by is not distinct from old.requested_by)
        or private.workspace_has_actor(new.workspace_id, new.requested_by));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- A plan a customer is on: who started it.
create or replace function private.check_subscription_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  v_ok := (tg_op = 'UPDATE'
      or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
    and (new.plan_id is null or (tg_op = 'UPDATE' and new.plan_id is not distinct from old.plan_id)
      or exists (select 1 from app.plans pl where pl.id = new.plan_id and pl.workspace_id = new.workspace_id))
    and (new.lead_id is null or (tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id)
      or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
    and (new.connection_id is null or (tg_op = 'UPDATE' and new.connection_id is not distinct from old.connection_id)
      or exists (select 1 from app.payment_connections c
        where c.id = new.connection_id and c.workspace_id = new.workspace_id))
    and (new.created_by is null or (tg_op = 'UPDATE' and new.created_by is not distinct from old.created_by)
      or private.workspace_has_actor(new.workspace_id, new.created_by));
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- The Action Center: who snoozed, dismissed, handled or stopped an item. Who it is assigned to is still one of the
-- business's people.
create or replace function private.check_attention_item_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  v_ok := (new.person_id is null or (tg_op = 'UPDATE' and new.person_id is not distinct from old.person_id)
      or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
    and (new.lead_id is null or (tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id)
      or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
    and (new.conversation_id is null or (tg_op = 'UPDATE' and new.conversation_id is not distinct from old.conversation_id)
      or exists (select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
    and (new.assignee_user_id is null or (tg_op = 'UPDATE' and new.assignee_user_id is not distinct from old.assignee_user_id)
      or private.workspace_has_user(new.workspace_id, new.assignee_user_id))
    and (new.snoozed_by is null or (tg_op = 'UPDATE' and new.snoozed_by is not distinct from old.snoozed_by)
      or private.workspace_has_actor(new.workspace_id, new.snoozed_by))
    and (new.dismissed_by is null or (tg_op = 'UPDATE' and new.dismissed_by is not distinct from old.dismissed_by)
      or private.workspace_has_actor(new.workspace_id, new.dismissed_by))
    and (new.handled_by is null or (tg_op = 'UPDATE' and new.handled_by is not distinct from old.handled_by)
      or private.workspace_has_actor(new.workspace_id, new.handled_by))
    and (new.auto_cancelled_by is null or (tg_op = 'UPDATE' and new.auto_cancelled_by is not distinct from old.auto_cancelled_by)
      or private.workspace_has_actor(new.workspace_id, new.auto_cancelled_by));
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- A booking marked confirmed: who marked it.
create or replace function private.check_attendee_confirmation_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if new.confirmed_by is not null and not private.workspace_has_actor(new.workspace_id, new.confirmed_by) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- The AI teammate: who took a conversation over from it, and who approved a reply it wrote.
create or replace function private.check_ai_teammate_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'ai_teammate_revisions' then
    v_ok := exists (select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id);
  elsif tg_table_name = 'conversations' then
    v_ok := (new.ai_teammate_id is null or exists (
        select 1 from app.ai_teammates t where t.id = new.ai_teammate_id and t.workspace_id = new.workspace_id))
      and (new.taken_over_by is null or private.workspace_has_actor(new.workspace_id, new.taken_over_by));
  elsif tg_table_name = 'messages' then
    v_ok := (new.sent_by_teammate_id is null or exists (
        select 1 from app.ai_teammates t where t.id = new.sent_by_teammate_id and t.workspace_id = new.workspace_id))
      and (new.approved_by is null or private.workspace_has_actor(new.workspace_id, new.approved_by));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- The AI teammate's drafts: who decided one.
create or replace function private.check_ai_teammate_work_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'ai_teammate_runs' then
    v_ok := exists (select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id)
      and (new.conversation_id is null or exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
      and (new.person_id is null or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      -- The batch is its own conversation's messages. Checked when the list is written, not when a deleted
      -- conversation clears conversation_id.
      and ((tg_op = 'UPDATE' and new.message_ids = old.message_ids) or not exists (
        select 1 from unnest(new.message_ids) as b (id)
        where not exists (
          select 1 from app.messages m
          where m.id = b.id and m.workspace_id = new.workspace_id and m.conversation_id = new.conversation_id)));
  elsif tg_table_name = 'ai_teammate_tool_calls' then
    v_ok := exists (select 1 from app.ai_teammate_runs r where r.id = new.run_id and r.workspace_id = new.workspace_id);
  elsif tg_table_name = 'ai_teammate_drafts' then
    v_ok := exists (select 1 from app.ai_teammates t where t.id = new.teammate_id and t.workspace_id = new.workspace_id)
      and (new.run_id is null or exists (
        select 1 from app.ai_teammate_runs r
        where r.id = new.run_id and r.workspace_id = new.workspace_id and r.teammate_id = new.teammate_id))
      and (new.conversation_id is null or exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
      and (new.person_id is null or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
      and (new.lead_id is null or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
      and (new.decided_by is null or private.workspace_has_actor(new.workspace_id, new.decided_by));
  elsif tg_table_name = 'messages' then
    v_ok := (new.ai_run_id is null or exists (
        select 1 from app.ai_teammate_runs r where r.id = new.ai_run_id and r.workspace_id = new.workspace_id))
      and (new.ai_draft_id is null or exists (
        select 1 from app.ai_teammate_drafts d where d.id = new.ai_draft_id and d.workspace_id = new.workspace_id));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- A problem report: who sent it.
create or replace function private.check_problem_report_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.workspace_has_actor(new.workspace_id, new.user_id), false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- A video call: who hosts it.
create or replace function private.check_video_call_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.appointment_id is not null and not exists (
        select 1 from app.appointments a where a.id = new.appointment_id and a.workspace_id = new.workspace_id))
     or (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     or (new.conversation_id is not null and not exists (
        select 1 from app.conversations c where c.id = new.conversation_id and c.workspace_id = new.workspace_id))
     or (new.host_user_id is not null
         and not coalesce(private.workspace_has_actor(new.workspace_id, new.host_user_id), false)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;

-- The people on a video call: who is on it from the business's side, and who let someone in.
create or replace function private.check_video_call_person_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.user_id is not null and not coalesce(private.workspace_has_actor(new.workspace_id, new.user_id), false))
     or (new.attendee_id is not null and not exists (
        select 1 from app.appointment_attendees aa join app.video_calls c on c.appointment_id = aa.appointment_id
        where aa.id = new.attendee_id and aa.workspace_id = new.workspace_id and c.id = new.video_call_id))
     or (new.person_id is not null and not exists (
        select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
     -- A customer without a booking is the one the call is with.
     or (new.kind = 'customer' and new.attendee_id is null and not exists (
        select 1 from app.video_calls c where c.id = new.video_call_id and c.person_id = new.person_id))
     or (new.admitted_by is not null
         and not coalesce(private.workspace_has_actor(new.workspace_id, new.admitted_by), false)) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
