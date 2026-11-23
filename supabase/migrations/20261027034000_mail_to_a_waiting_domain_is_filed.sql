-- Mail that reaches us for a domain still waiting on its MX check is filed, not dropped. The owner's decision
-- (22 Nov 2026, "Yes, file it in the Inbox").
--
-- Postmark gives a domain its server only once the domain's MX record points at Postmark, and from then on hands us
-- every message sent there. Our own MX check comes after: up to 15 minutes later, and longer while the old host's
-- records sit beside ours. Until it said "on", private.email_receiving_route routed nothing for the domain, so the
-- webhook accepted that mail and filed it nowhere. A business that had just moved its mail lost what arrived in
-- between.
--
-- So a waiting (`pending`) domain that already has its Postmark server (`inbound_server_id`) routes like one that
-- receives. A waiting domain with no server yet still routes nothing: Postmark holds no mail for it.
--
-- The function is otherwise as 20261013001200 left it. One function replaced, no table or grant changed.

create or replace function private.email_receiving_route(p_address text)
returns table (email_address_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, d.workspace_id, w.organization_id
  from app.email_domains d
  join app.workspaces w on w.id = d.workspace_id
  cross join lateral (
    select x.id
    from app.email_addresses x
    where x.workspace_id = d.workspace_id
      and ((x.address = lower(p_address)
            and (x.owner_user_id is null or private.works_in(x.owner_user_id, x.workspace_id)))
        or x.is_default)
    order by x.address = lower(p_address) desc
    limit 1
  ) a
  where d.domain = split_part(lower(p_address), '@', 2)
    and (d.receiving in ('on', 'lapsed')
      or (d.receiving = 'pending' and d.inbound_server_id is not null))
    and w.deletion_requested_at is null
$$;
