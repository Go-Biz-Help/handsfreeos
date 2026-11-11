-- =============================================================================
-- The main offer: lists for content (docs/main-offer.md, "For your content").
--        The owner, 11 Nov 2026: short lists the AI Social Media Content Creator writes every post and idea from,
--        filled in with the AI's help: what makes the business different, its features and benefits, its
--        customers' problems and questions, before and after, its story, topics, myths, its voice, what to ask
--        people to do, and what it never says.
--        Kept as one object of lists, each its lines ({"different": ["…", "…"], …}). Not scored and not
--        versioned, like the names: changing them moves no revision, and they never hold the offer back.
--
-- Only adds: the code running now reads and writes nothing here.
-- =============================================================================

alter table app.main_offers
  add column lists jsonb not null default '{}'::jsonb
    check (jsonb_typeof(lists) = 'object' and octet_length(lists::text) <= 200000);
