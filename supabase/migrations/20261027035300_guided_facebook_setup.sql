-- =============================================================================
-- The guided Facebook & Instagram setup (the owner, 24 Nov 2026: every setting
-- set up one question at a time, Facebook & Instagram after Website chat):
--   - Its answers are saved as they are given, like the other guided setups',
--     in app.guided_setup_drafts under setup 'facebook'. They belong to the
--     people who may connect the business's Facebook and Instagram
--     (channels.manage), the same permission its last screen's command
--     (facebook_setup.save) asks for.
--   - Nothing else changes. Mirrors GUIDED_SETUPS in @hfos/core.
-- =============================================================================

create or replace function private.guided_setup_permission(p_setup text)
returns text language sql immutable set search_path = '' as $$
  select case p_setup
    when 'phone' then 'channels.manage'
    when 'email' then 'channels.manage'
    when 'calendar' then 'calendars.manage'
    when 'payments' then 'money.manage'
    when 'chat' then 'channels.manage'
    when 'facebook' then 'channels.manage'
  end
$$;
comment on function private.guided_setup_permission(text) is
  'The permission a guided setup''s saved answers need (null: no such setup). Mirrors GUIDED_SETUPS in @hfos/core.';
