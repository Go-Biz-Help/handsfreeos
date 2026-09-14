-- =============================================================================
-- 0030 · The AI teammate and website chat, part 1: enum values and types. A
--        business's AI teammate answers customers on text, email and a new
--        website chat, so conversations and timeline entries gain the 'chat'
--        channel, and the teammate's AI calls land in ai_usage under their
--        own source. They are added in a migration of their own because
--        Postgres can't use a new enum value in the transaction that adds it;
--        the tables, checks and indexes that use them follow in 0031-0034
--        (20260918000200 … 20260918000500).
-- =============================================================================

alter type app.channel add value if not exists 'chat';
alter type app.activity_kind add value if not exists 'chat';
alter type app.ai_usage_source add value if not exists 'teammate';

-- Off: never answers. Training: every message to a customer waits for a person's OK. Automatic: it sends.
create type app.ai_teammate_status as enum ('off', 'training', 'automatic');
-- Who answers a conversation: nobody in particular yet, the AI teammate, or a person who took it over.
create type app.conversation_handler as enum ('none', 'ai', 'person');
