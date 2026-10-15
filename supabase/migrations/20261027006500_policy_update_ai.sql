-- =============================================================================
-- Adding the texting section to a business's own privacy policy or terms.
--        The registration wizard reads a business's own policy and gives it
--        back whole with the section the carriers look for in place; the AI
--        decides where it goes. Its tokens are counted and charged as their
--        own line, so the statement says what the AI was doing.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'texting_policy';
