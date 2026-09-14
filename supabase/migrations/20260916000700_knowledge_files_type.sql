-- =============================================================================
-- 0027 · Knowledge files, part 1: a record type for files that belong to the
--        business's knowledge base (PDFs and text files whose text becomes a
--        draft document item) rather than to a person, company or lead. It is
--        added in a migration of its own because Postgres can't use a new
--        enum value in the transaction that adds it; the check, the policies
--        and the storage rule that use it follow in
--        20260916000710_knowledge_files.sql.
-- =============================================================================

alter type app.record_type add value if not exists 'knowledge';
