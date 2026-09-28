-- =============================================================================
-- Saving one of an add-on's switches leaves the others as they were.
--
--        private.save_addon_settings replaced the business's switches as a
--        whole, so a screen that sent only the switch someone flipped (as
--        the phone does) set every other one back to its default. The
--        switches sent are now merged into the ones kept; the business's
--        settings, checked against the add-on's schema as a whole, are
--        still replaced.
-- =============================================================================

create or replace function private.save_addon_settings(
  p_ws uuid, p_addon text, p_permission text, p_settings jsonb, p_settings_version integer, p_flags jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_permission <> 'addons.manage' and not exists (
      select 1 from app.role_permissions rp where rp.permission = p_permission and rp.addon_id = p_addon) then
    raise exception 'That isn''t a permission of this add-on' using errcode = '42501', detail = 'addon_bad_permission';
  end if;
  if not private.has_permission(p_ws, p_permission) then
    raise exception 'You can''t change this add-on''s settings' using errcode = '42501', detail = 'addon_settings_forbidden';
  end if;
  update app.addon_installations i set
    settings = coalesce(p_settings, i.settings),
    settings_version = coalesce(p_settings_version, i.settings_version),
    flags = case when p_flags is null then i.flags else i.flags || p_flags end,
    changed_by = auth.uid(), changed_at = now()
  where i.workspace_id = p_ws and i.addon_id = p_addon and i.state = 'enabled';
  if not found then
    raise exception 'That add-on isn''t on here' using errcode = '23514', detail = 'addon_inactive';
  end if;
end $$;
