-- =============================================================================
-- Database functions that run as their owner, kept to the roles that use them.
--
--        `revoke all on all functions in schema private from public`
--        (20260911000500) covers only the functions there when it ran.
--        Postgres lets everyone (PUBLIC) run a new function unless told
--        otherwise, so 47 SECURITY DEFINER functions added since were open
--        to every role. A few of those answer across businesses: the wallet
--        drift check named other businesses and their balances, and the
--        phone-sync checks named other businesses' people and records.
--        Nobody outside could reach them (clients can't run SQL), but a
--        query the API ran could.
--
--        Each one is now PUBLIC's no more. The roles that do call one keep
--        it: most already had their own grant, and the few that leaned on
--        PUBLIC get one here. Trigger functions are left alone, because
--        Postgres never lets anybody call one directly.
--
--        packages/db/test/rls.test.ts now fails on any SECURITY DEFINER
--        function PUBLIC can run, so the next one is caught.
--
-- Only changes who may run functions. No table or column changes, so
-- PowerSync copies nothing again.
-- =============================================================================

-- The roles that leaned on PUBLIC keep their access.
--   A row security policy on app.addon_phone_rows asks this as the person.
grant execute on function private.addon_phone_permission(text) to authenticated;
--   Asked by triggers that run as whoever is writing: a person, or HandsFreeOS.
grant execute on function
  private.bin_working(uuid),
  private.merging_person(text, text),
  private.purging_addon(uuid, text),
  private.purging_workspace(uuid)
  to authenticated, service_actor;
--   platform.founding_counts uses it, and runs it as whoever reads it; so do the founding queries.
grant execute on function private.founding_seats_held(text) to authenticated, service_actor;
--   Linking records asks it, as a person or as HandsFreeOS.
grant execute on function private.record_is_private(uuid) to authenticated, service_actor;

-- And PUBLIC loses every one.
revoke execute on function
  private.addon_alert_visible(uuid),
  private.addon_connection_live(uuid, text, text),
  private.addon_holds(uuid, text),
  private.addon_phone_permission(text),
  private.admin_usage_margin(timestamptz),
  private.admin_wallet_for(uuid),
  private.admin_wallet_health(timestamptz),
  private.bin_working(uuid),
  private.can_let_support_in(uuid),
  private.custom_record_visible(uuid),
  private.disconnect_addon_connection(uuid, uuid),
  private.form_sync_active(uuid),
  private.founding_apply(text, text, text, text, text, text, text, text, text, text),
  private.founding_checkout_view(uuid),
  private.founding_claim_free(bytea, uuid),
  private.founding_credit_wallet(uuid),
  private.founding_open_checkout(bytea, uuid),
  private.founding_open_successors(text),
  private.founding_seat_by_token(bytea),
  private.founding_seats_held(text),
  private.merging_person(text, text),
  private.open_usage_wallet(uuid),
  private.permission_holders(uuid, text),
  private.private_kinds_seen_whole(),
  private.publish_usage_rates(jsonb, text),
  private.purging_addon(uuid, text),
  private.purging_workspace(uuid),
  private.record_is_private(uuid),
  private.record_on_legal_hold(uuid),
  private.record_seal(uuid),
  private.relationship_seal(uuid, uuid),
  private.relationship_type_seal(uuid, text, uuid, uuid),
  private.set_addon_platform_connection(uuid, text, text, text, text, text, boolean),
  private.set_wallet_stage(uuid, app.wallet_stage),
  private.staff_credit_wallet(uuid, bigint, text, text, uuid),
  private.support_seen_records(),
  private.support_sees_record(uuid, uuid),
  private.sync_key_mismatches(uuid),
  private.sync_keys_refresh_workspace(uuid),
  private.sync_keys_refresh(uuid, uuid),
  private.sync_keys_wanted(uuid, uuid),
  private.sync_record_seal_mismatches(uuid),
  private.sync_seal_mismatches(uuid),
  private.unseen_private_records(),
  private.unseen_sealed_appointments(),
  private.usage_wallet_drift(),
  private.user_sees_record(uuid, uuid)
  from public;
