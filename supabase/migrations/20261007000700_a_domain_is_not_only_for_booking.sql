-- =============================================================================
-- 0107 · A business's own domain is not only for booking (M17).
--
--        0087 answered "which business is this host?" only while the booking
--        site was switched on. That was right when the domain meant "the
--        booking page on another name", and wrong once it carried the forms,
--        estimates, invoices and payment links too: a business that takes no
--        online bookings still sends all of those, and every one of them went
--        dark on its own domain the moment booking was turned off.
--
--        `branded_domain.add` now names the business the way publishing a
--        form does (`ensureBookingSite`, switched off), so a business that
--        never set up booking can have a domain at all. This lets that domain
--        actually serve. Whether a customer can book is still the booking
--        site's to say: `/` on the domain shows "online booking is off", and a
--        calendar still takes bookings only on a site that is switched on.
--
--        **Who may name the business.** Making that row was `calendars.manage`
--        alone, which was right while only Settings → Booking site made one.
--        Now `branded_domain.add` (`channels.manage`) and `form.publish`
--        (`forms.manage`) make one too, and since 0106 a business can hand
--        either of those to somebody it keeps away from its calendars — who
--        would then be refused a domain, or a published form, for want of a
--        permission the job does not need. So either of them may make the row
--        switched off: that names the business's pages and puts nothing up for
--        booking. Switching it on, and every change after, stays
--        `calendars.manage`.
-- =============================================================================

create or replace function private.site_for_domain(p_domain text)
returns table (site_slug text, workspace_id uuid)
language sql stable security definer set search_path = '' as $$
  select s.slug::text, d.workspace_id
  from app.branded_domains d
  join app.booking_sites s on s.id = d.site_id
  where d.domain = lower(p_domain) and d.status = 'verified' and d.certificate_ready
$$;
revoke all on function private.site_for_domain(text) from public;
grant execute on function private.site_for_domain(text) to authenticated, anon, service_actor;

drop policy booking_sites_insert on app.booking_sites;
create policy booking_sites_insert on app.booking_sites for insert to authenticated
  with check (created_by = (select auth.uid()) and (
    private.has_permission(workspace_id, 'calendars.manage')
    or (not enabled and (private.has_permission(workspace_id, 'channels.manage')
      or private.has_permission(workspace_id, 'forms.manage')))));
