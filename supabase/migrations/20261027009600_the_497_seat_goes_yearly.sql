-- =============================================================================
-- The $497 Founding Customer seat goes yearly (the owner's call, 2026-10-19).
--
--        20261027009500 built the yearly seat; this moves the offer onto it.
--        It is its own migration because the API checks every answer against
--        its list of billings: applied before the code that knows `yearly`
--        was running, the website's counts would have been refused. Apply it
--        once that code is on `main` and deployed.
--
--        Nobody holds one of these seats yet, so nobody's price changes. A
--        seat bought from here on is $497 a year, renewed on its own.
-- =============================================================================

update platform.founding_offers
   set paid_yearly = true,
       blurb = '$497 a year, for one business, at a price that stays a founding price. Texts, calls and AI are billed for what you use.'
 where id = 'founding_lifetime';
