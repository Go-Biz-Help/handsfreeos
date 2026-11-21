-- =============================================================================
-- Product options (product sellers, pick 3a): a product can come in sizes,
-- colors or any other choice the business names, each choice with its own
-- price bump. "T-shirt, $12" with Size (Youth S … Adult 2XL +$2) and Color
-- (Black, White) is one product, not twenty.
--
-- The options live on the product as JSON, checked by core
-- (packages/core/src/money/options.ts) before every write: up to 3 options,
-- each with up to 40 choices, a choice's bump in cents (it may be below zero,
-- never so far that a choice costs less than nothing). A line on an estimate
-- or an invoice keeps its own copy of the name and price it was added with
-- ("T-shirt (Adult 2XL, Black)", $14), so changing a choice never reprices a
-- document that has gone out.
--
-- Adding a column with a constant default is a catalogue change only: no row
-- is rewritten. The table's grants are table-wide, so the new column is
-- covered by them. The phone's sync stream names its columns, so it doesn't
-- send this one (the phone has no product screens).
-- =============================================================================

alter table app.products
  add column options jsonb not null default '[]'::jsonb
    check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 3
      and pg_column_size(options) <= 16384);

comment on column app.products.options is
  'Sizes, colors and other choices: [{id, name, choices: [{id, label, priceCents}]}], checked by core.';
