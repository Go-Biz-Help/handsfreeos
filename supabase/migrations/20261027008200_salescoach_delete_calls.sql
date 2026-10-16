-- =============================================================================
-- AI Sales Coach: deleting a coached call for good.
--
--        Chris decided (2026-10-16) that a coached call can be deleted for
--        good, by owners: it goes at once, with what was said, the cards and
--        the write-up. What it already made stays (the timeline line and the
--        tasks for what was promised). An owner can give it to a role or a
--        person in Settings → Permissions, as with records.delete. A call the
--        coach is still hearing or writing up can't be deleted yet. The AI
--        never deletes (the command is risk 4).
-- =============================================================================

select private.register_addon_permissions('salescoach', '[
  {"key": "salescoach.delete", "label": "Delete coached calls",
   "description": "Delete a coached call for good: what was said, the cards and the write-up.",
   "defaultRoles": [], "requires": ["salescoach.review"]}
]'::jsonb);

-- Its cards go with it (their foreign key cascades).
create policy calls_delete on addon_salescoach.calls for delete to authenticated
  using (workspace_id in (select private.workspaces_with_permission('salescoach.delete'))
    and state not in ('live', 'writing'));
grant delete on addon_salescoach.calls to authenticated;

-- Owners in businesses where the coach already runs get the new permission now.
select private.refresh_workspace_access(wa.user_id, wa.workspace_id)
from app.workspace_access wa
join app.addon_installations i on i.workspace_id = wa.workspace_id
where i.addon_id = 'salescoach' and i.state = 'enabled';
