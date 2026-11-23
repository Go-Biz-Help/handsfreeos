-- =============================================================================
-- A plan marked "Charge sales tax on it" really charges it (the owner, 23 Nov
-- 2026: "yes it should add the tax if the business chooses to add tax").
--
--        Until now a plan was created at the provider for its bare price, so
--        the tick box collected nothing. From here a taxed plan charges its
--        price plus the business's sales tax, and that rate is kept on the
--        plan the way its price is: **the rate the business had when the plan
--        was sold**. A rate changed later never reprices a customer who is
--        already on a plan, and each cycle's invoice splits what was charged
--        back into the price and its tax with the same rate.
--
--        Every plan sold before this keeps 0: none of them was charged tax,
--        and no business had a rate set on 23 Nov 2026.
--
--        The phone's copy of plans (sync-config.yaml) names its columns, so
--        it is unchanged and nothing is copied again.
-- =============================================================================

alter table app.subscriptions
  add column tax_rate_bp integer not null default 0
    check (tax_rate_bp between 0 and 2000);

comment on column app.subscriptions.tax_rate_bp is
  'The business''s sales tax rate when the plan was sold, in basis points (825 is 8.25%). Charged on top of the price only when taxable.';
