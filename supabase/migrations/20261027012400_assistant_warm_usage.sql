-- =============================================================================
-- The Assistant reads its instructions, tools and the business's lasting context
-- ahead of a question while the person types (its panel opening), so the first
-- answer starts sooner. Those tokens count toward the business's daily AI limit
-- like the rest, kept in app.ai_usage as their own source. Never charged: the
-- Assistant isn't billed to the business.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'assistant';
