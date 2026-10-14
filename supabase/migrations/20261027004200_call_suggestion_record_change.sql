-- =============================================================================
-- Video meetings, step 11: record changes from calls (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §9).
--        Beside tasks and a follow-up email, the AI can suggest updating the
--        customer's record with a name, email or phone they gave on the call.
--        Like the others it waits for a person, who approves it as is or
--        edited (call_suggestion.decide runs person.update as them).
-- =============================================================================

alter table app.call_suggestions drop constraint call_suggestions_kind_check,
  add constraint call_suggestions_kind_check check (kind in ('task', 'follow_up', 'record_change'));
