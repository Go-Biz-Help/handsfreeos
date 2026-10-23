-- =============================================================================
-- The main offer: the names the business goes by (docs/main-offer.md; docs/outreach.md, decision 84).
--        Chris, 23 Oct 2026: other businesses use HandsFreeOS for their own, so the profile check needs to know
--        the name of the business it's looking for. A business can go by more than one (its company and the brand
--        it sells, like "Go Biz Help" and "HandsFreeOS"); none set means the business's name in HandsFreeOS.
--        Not scored and not versioned, like the owner's direction: changing them moves no revision.
--
-- Only adds: the code running now reads and writes nothing here.
-- =============================================================================

alter table app.main_offers
  add column names text[] not null default '{}'
    check (cardinality(names) <= 5 and octet_length(array_to_string(names, '|')) <= 600);
