-- =============================================================================
-- Tool names an add-on's AI tools can use.
--
--        An add-on offers its commands and queries to the Assistant as tools
--        the Assistant derives from them (packages/core/src/addons/ai.ts), each
--        named for its add-on: `<add-on id>_<verb>_<noun>`. Those names may
--        carry digits (`pm_list_1099s`, `tax_file_w2`), and AI_TOOL_NAME in
--        core allows them. The two ledgers every AI tool call is written to —
--        the Assistant's (20260914000100) and the AI teammate's
--        (20260918000300) — took only lowercase letters and underscores, so a
--        call to such a tool could not be recorded, and the answer it belonged
--        to would fail with it (audit AI-2).
--
--        Both now take lowercase letters, digits and underscores, still
--        starting with a letter and at most 64 characters long, which is what
--        Claude accepts for a tool's name. Dots stay out: Claude refuses them.
--        The check only grows, so every row already written passes it.
-- =============================================================================

alter table app.assistant_tool_calls drop constraint assistant_tool_calls_tool_check,
  add constraint assistant_tool_calls_tool_check check (tool ~ '^[a-z][a-z0-9_]{0,63}$');

alter table app.ai_teammate_tool_calls drop constraint ai_teammate_tool_calls_tool_check,
  add constraint ai_teammate_tool_calls_tool_check check (tool ~ '^[a-z][a-z0-9_]{0,63}$');
