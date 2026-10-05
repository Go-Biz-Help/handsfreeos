-- =============================================================================
-- Real Estate Agent, round three, step 9: the buyer's repair request on a
-- listing.
--
--        On a buyer deal we ask for repairs and the seller answers; on a
--        listing it's the other way round: the buyers ask, and our seller
--        answers. **repair_requests** keeps who wrote each one ('us' or
--        'them') as before, but that no longer says which is the request and
--        which the answer, so the check tying an answer to 'them' goes. An
--        answer still has its outcome, and a request none; the add-on keeps
--        that by the deal's side.
-- =============================================================================

alter table addon_realestate.repair_requests drop constraint repair_requests_check;
