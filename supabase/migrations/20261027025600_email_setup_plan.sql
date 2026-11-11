-- =============================================================================
-- The business email step (onboarding's "Your business email", and Home's "Set up your business email").
--
--        A business picks the address its booking emails go out from while
--        it sets up. On its own domain, the records take a while to add, so
--        the domain keeps what to do once they check out (`plan`): make the
--        team address and the default, make the person's own address, and
--        receive the domain's mail. The worker does it when the domain
--        verifies, then clears it. Until then mail goes from the free address.
--
--        The worker also notes where the domain's mail goes now (`mail_host`,
--        from its MX: none, google, microsoft…) and where its DNS is managed
--        (`dns_host`, from its name servers: godaddy, cloudflare…), so the
--        step shows that place's steps, and offers "Get email here too" only
--        to a domain nobody gets email at yet.
--
--        People write the plan (the step's own command); only the worker
--        writes where the mail and DNS are.
-- =============================================================================

alter table app.email_domains
  add column plan jsonb not null default '{}'::jsonb,
  add column mail_host text,
  add column dns_host text;

alter table app.email_domains
  add constraint email_domains_plan_object check (jsonb_typeof(plan) = 'object'),
  add constraint email_domains_mail_host_length check (mail_host is null or length(mail_host) <= 40),
  add constraint email_domains_dns_host_length check (dns_host is null or length(dns_host) <= 40);

comment on column app.email_domains.plan is
  'What happens once the domain verifies: {team: {localPart, displayName}} makes the team address and the default, {own: {localPart, userId}} the person''s own address, {receive: true} receives its mail. Cleared once done.';
comment on column app.email_domains.mail_host is
  'Where the domain''s mail goes now, from its MX, as the worker last looked: none, handsfreeos, google, microsoft, godaddy, zoho or other.';
comment on column app.email_domains.dns_host is
  'Where the domain''s DNS is managed, from its name servers, as the worker last looked: godaddy, cloudflare, namecheap… or other.';

-- The policy email_domains_update already lets those with channels.manage update; the grant says which column.
grant update (plan) on app.email_domains to authenticated;
