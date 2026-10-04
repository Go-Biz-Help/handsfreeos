-- =============================================================================
-- A customer signed in to their portal is an actor of their own (Real Estate
-- round two, step 3; core): their own changes are recorded as theirs. Alone in
-- its file, as every new enum value is: one can't be used in the transaction
-- that adds it.
-- =============================================================================

alter type app.actor_type add value if not exists 'customer';
