-- A staff rule is asked once per statement, not once per row (speed audit, Nov 2026).
--
-- 44 policies let support staff through with a bare `private.staff_can('…')` (two say `private.is_staff()` or
-- `private.i_am_founder()`). It reads no column, yet standing bare in a policy it is called for every row a
-- statement looks at, and it stands first, ahead of the member's own rule. "Who am I" (`account.me`, asked each time
-- a page is drawn) reads the businesses and the organizations whole, so it called the check once for every business
-- and every organization on the platform: the more customers, the slower every page, for everyone.
--
-- Inside a sub-select it is asked once and its answer used for every row, the way the newer policies already write
-- it (`(select private.staff_can('platform.ideas.manage'))`, `(select auth.uid())`).
--
-- Measured on a local copy with 672 businesses and 736 organizations, the "who am I" statement for a person in one
-- business: 124 ms -> 4.9 ms. On the live database (14 businesses) it averaged 17 ms over 28,700 calls in nine days.
--
-- Nothing a policy answers changes: each is the one it had, for the same command and roles, with only the staff
-- check moved into a sub-select. The rule from here on, held by packages/db/test/policy-helpers.test.ts: a policy
-- never calls a staff check bare.

alter policy addon_charges_read on app.addon_charges
  using (
    private.has_permission(workspace_id, 'money.manage')
    or (select private.staff_can('platform.businesses.read'))
  );

alter policy addon_subscriptions_read on app.addon_subscriptions
  using (
    private.has_permission(workspace_id, 'workspace.read')
    or (select private.staff_can('platform.businesses.read'))
  );

alter policy organizations_staff_read on app.organizations
  using ((select private.staff_can('platform.businesses.read')));

alter policy plan_cards_read on app.plan_cards
  using (
    private.has_permission(workspace_id, 'money.manage')
    or (select private.staff_can('platform.founding.manage'))
  );
alter policy plan_cards_staff on app.plan_cards
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy plan_time_requests_read on app.plan_time_requests
  using (
    private.has_permission(workspace_id, 'workspace.read')
    or (select private.staff_can('platform.founding.manage'))
  );
alter policy plan_time_requests_staff on app.plan_time_requests
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy users_staff_read on app.users
  using ((select private.staff_can('platform.businesses.read')));

alter policy workspace_memberships_staff_read on app.workspace_memberships
  using ((select private.staff_can('platform.businesses.read')));

alter policy workspace_plans_read on app.workspace_plans
  using (
    private.has_permission(workspace_id, 'workspace.read')
    or (select private.staff_can('platform.founding.manage'))
  );
alter policy workspace_plans_staff on app.workspace_plans
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy workspaces_staff_read on app.workspaces
  using ((select private.staff_can('platform.businesses.read')));

alter policy addon_grants_select on platform.addon_grants
  using (
    (workspace_id in (select private.accessible_workspace_ids()))
    or (select private.staff_can('platform.businesses.read'))
  );

alter policy affiliate_clicks_staff on platform.affiliate_clicks
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliate_codes_staff on platform.affiliate_codes
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliate_commissions_staff on platform.affiliate_commissions
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliate_payout_accounts_staff on platform.affiliate_payout_accounts
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliate_payouts_staff on platform.affiliate_payouts
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliate_referrals_staff on platform.affiliate_referrals
  using ((select private.staff_can('platform.affiliates.manage')))
  with check ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliate_settings_staff on platform.affiliate_settings
  using ((select private.staff_can('platform.affiliates.manage')))
  with check ((select private.staff_can('platform.affiliates.manage')));

alter policy affiliates_staff on platform.affiliates
  using ((select private.staff_can('platform.affiliates.manage')))
  with check ((select private.staff_can('platform.affiliates.manage')));

alter policy canned_replies_read on platform.canned_replies
  using ((select private.staff_can('support.read')));
alter policy canned_replies_write on platform.canned_replies
  using ((select private.staff_can('support.manage')))
  with check ((select private.staff_can('support.manage')));

alter policy founding_applications_staff on platform.founding_applications
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy founding_checkouts_staff on platform.founding_checkouts
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy founding_grants_staff on platform.founding_grants
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy founding_offers_write on platform.founding_offers
  using ((select private.staff_can('platform.founding.manage')))
  with check ((select private.staff_can('platform.founding.manage')));

alter policy plan_payments_staff on platform.plan_payments
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy plan_refunds_staff on platform.plan_refunds
  using ((select private.staff_can('platform.affiliates.manage')));

alter policy staff_read on platform.staff
  using ((select private.is_staff()));
alter policy staff_write on platform.staff
  using ((select private.staff_can('platform.staff.manage')))
  with check ((select private.staff_can('platform.staff.manage')));

alter policy staff_invitations_read on platform.staff_invitations
  using ((select private.staff_can('platform.staff.manage')));
alter policy staff_invitations_write on platform.staff_invitations
  using ((select private.staff_can('platform.staff.manage')))
  with check ((select private.staff_can('platform.staff.manage')));

alter policy ticket_drafts_read on platform.ticket_drafts
  using ((select private.staff_can('support.read')));
alter policy ticket_drafts_write on platform.ticket_drafts
  using ((select private.staff_can('support.reply')))
  with check ((select private.staff_can('support.reply')));

alter policy ticket_events_read on platform.ticket_events
  using ((select private.staff_can('support.read')));
alter policy ticket_events_write on platform.ticket_events
  with check ((select private.staff_can('support.reply')));

alter policy ticket_messages_read on platform.ticket_messages
  using ((select private.staff_can('support.read')));
alter policy ticket_messages_write on platform.ticket_messages
  using ((select private.staff_can('support.reply')))
  with check ((select private.staff_can('support.reply')));

alter policy tickets_read on platform.tickets
  using ((select private.staff_can('support.read')));
alter policy tickets_write on platform.tickets
  using ((select private.staff_can('support.reply')))
  with check ((select private.staff_can('support.reply')));

alter policy usage_rates_write on platform.usage_rates
  using ((select private.staff_can('platform.rates.manage')))
  with check ((select private.staff_can('platform.rates.manage')));

alter policy view_as_read on platform.view_as_sessions
  using (
    (select private.staff_can('platform.view_as'))
    or (select private.staff_can('platform.staff.manage'))
  );
alter policy view_as_write on platform.view_as_sessions
  using ((select private.staff_can('platform.view_as')) and (staff_user_id = (select auth.uid())))
  with check (
    (select private.staff_can('platform.view_as'))
    and (staff_user_id = (select auth.uid()))
    and ((not acts) or (select private.i_am_founder()))
  );
