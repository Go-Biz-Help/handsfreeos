-- =============================================================================
-- Scanning a business card on the phone (Contacts → + → Scan a business
-- card; the owner's ask of 17 November 2026).
--
--        - **The AI reading a side of the card** counts its tokens as
--          `business_card` (app.ai_usage), for the person scanning, against
--          the business's daily AI limit and its balance.
--        - Nothing else is kept here: the contact is added with
--          `person.create` once the person checks the form, and the card's
--          straightened pictures go on their Files like any photo.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'business_card';
