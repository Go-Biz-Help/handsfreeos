-- =============================================================================
-- 0109 · A migration's to-do list points at pages that exist (M11).
--
--        `migration_reconnect_tasks.settings_path` is there "so the item is a
--        link and not a treasure hunt", and three of the paths the migration
--        engine wrote were pages HandsFreeOS never had: `/settings/phone`
--        (the numbers to move — Settings → Texting & calls is where a port
--        starts), `/settings/mailboxes` (mailboxes connect under Settings →
--        Email) and `/settings/forms` (forms live at `/forms`). The engine now
--        writes the real ones; this mends the rows it already wrote, which
--        is every number a finished migration found.
-- =============================================================================

update app.migration_reconnect_tasks
set settings_path = case settings_path
    when '/settings/phone' then '/settings/texting'
    when '/settings/mailboxes' then '/settings/email'
    when '/settings/forms' then '/forms'
  end
where settings_path in ('/settings/phone', '/settings/mailboxes', '/settings/forms');
