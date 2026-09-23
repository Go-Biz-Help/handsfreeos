-- =============================================================================
-- 0094 · The customer's language (M18 step 2). The AI teammate answers in the
--        language the customer writes in, and says which: it is kept on the
--        conversation, so what HandsFreeOS itself sends there — the business's
--        hand-off line, the emergency safety steps — can go in it too.
--
--        Those fixed words are the business's and ours, not the model's, so
--        each is translated once per language and kept here, keyed by a hash
--        of the English. The emergency steps always go out in English as well,
--        after the translation, so a safety instruction never depends on one.
-- =============================================================================

alter table app.conversations
  add column language text check (language is null or language ~ '^[a-z]{2,3}$');

create table app.fixed_text_translations (
  -- sha256 of the English text, hex.
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  language text not null check (language ~ '^[a-z]{2,3}$'),
  translated text not null check (length(btrim(translated)) between 1 and 2000),
  created_at timestamptz not null default now(),
  primary key (source_hash, language)
);

-- Only the worker reads and writes them; nobody signs in to see a translation.
alter table app.fixed_text_translations enable row level security;
create policy fixed_text_translations_service_all on app.fixed_text_translations for all to service_actor
  using (true) with check (true);
grant select, insert, update on app.fixed_text_translations to service_actor;
revoke all on app.fixed_text_translations from anon, authenticated;
