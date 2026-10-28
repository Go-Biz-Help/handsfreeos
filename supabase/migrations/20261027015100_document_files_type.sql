-- =============================================================================
-- Documents and e-signatures, part 1, a: a record type for the PDF a document
-- template is made from (docs/documents.md; the owner's answers of 28 October
-- 2026). The file belongs to the template, not to a customer, so its record is
-- the template. It is added in a migration of its own because Postgres can't
-- use a new enum value in the transaction that adds it; the tables, the
-- policies and the storage rule that use it follow in
-- 20261027015200_documents.sql.
-- =============================================================================

alter type app.record_type add value if not exists 'document';
