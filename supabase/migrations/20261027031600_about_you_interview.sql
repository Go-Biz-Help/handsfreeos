-- =============================================================================
-- About you's interview (docs/outreach.md, decision 186; the owner's pick 4a
-- of 20 Nov 2026): a button beside the box asks a few questions, one at a
-- time, typed or out loud, and the AI writes the box from the answers.
--
--        The AI writing it counts as 'about_you' usage on the business the
--        person was in when they asked. Nothing else is kept: the box fills
--        in on their screen, and only Save keeps it (app.user_about).
--
-- Only adds an enum value.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'about_you';
