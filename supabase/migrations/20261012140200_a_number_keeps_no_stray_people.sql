-- =============================================================================
-- Rows naming another business's number are removed.
--
--        20261012010500 checks every new `app.phone_number_members` row
--        against its number's workspace, and rows can't be updated (0079's
--        phone_number_members_immutable). A row written before that check
--        could still name a number in another business, so any such row goes
--        now. `phone_route` and the inbox lists already read only rows in the
--        number's own workspace, so nothing depended on them; deleting them
--        runs 0083's trigger, which repaints the affected threads' viewers.
-- =============================================================================

delete from app.phone_number_members m
where not exists (
  select 1 from app.phone_numbers n
  where n.id = m.phone_number_id and n.workspace_id = m.workspace_id
);
