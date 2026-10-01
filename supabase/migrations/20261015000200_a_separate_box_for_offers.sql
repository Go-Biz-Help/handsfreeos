-- =============================================================================
-- A separate box for offers.
--
--        A business registered for "customer care and the odd promotion"
--        (or mostly promotions) is checked by the carriers for a page where
--        a customer can agree to texts about their own job without agreeing
--        to offers. So the hosted contact form, booking page and website
--        chat show a second, optional box for offers to those businesses,
--        and this is where the answer is kept, beside the first one.
--
--        The same three states as `sms_consent`, and STOP still wins: a
--        customer whose `sms_consent` is `opted_out` gets no texts of any
--        kind, whatever this says. Nothing sends by this yet; it is the
--        record of who said yes, and when, and where.
--
--        Merging two customers (private.merge_people) keeps the kept
--        record's answer here; the duplicate's stays on its archived record.
-- =============================================================================
alter table app.people
  add column offers_consent app.sms_consent not null default 'unknown',
  add column offers_consent_at timestamptz,
  add column offers_consent_source text
    check (offers_consent_source is null or length(offers_consent_source) <= 80);
