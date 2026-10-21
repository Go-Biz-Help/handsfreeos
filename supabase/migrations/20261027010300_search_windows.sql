-- =============================================================================
-- Search everything, stage 1: the windows, folding and the form-answers rule
-- (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The database", Migration A).
--
--        Search reads each kind where it lives, as the person, under row
--        security. Row security keeps Postgres from using a text index for
--        a LIKE (only leakproof functions get an index, and LIKE isn't one),
--        so long text is matched in a window: a business's newest rows, read
--        through a btree on (workspace_id, time), with the words a filter
--        over that window only. These are the windows search doesn't have
--        yet: notes, threads by recency and form answers by recency.
--
--        `private.search_fold` folds accents one letter for one letter, so a
--        mark found in the folded text fits the original. The two strings
--        are core's FOLD_FROM and FOLD_TO (packages/core/src/search/fold.ts),
--        copied here; core's search/fold.test.ts runs both over the same
--        words and fails if they disagree. Built-ins only, so honestly
--        immutable, and a stored column may use it later. No `unaccent`: it
--        isn't installed, its dictionary can change under a stored column,
--        and it turns ß into ss, which would move every mark after it.
--        It runs on every name of a business, often twice a row, so it's
--        built to cost what `lower()` does (see the function).
--
--        A form response's answers hide while the response is in the Deleted
--        bin. `form_answers_select` reads by business only, and only
--        `form_responses` had a bin rule, so Forms → Results still showed a
--        binned response's answers.
--
-- Only adds: a function, three indexes and a policy. No column on a published
-- table, so PowerSync copies nothing again.
-- =============================================================================

-- Two things keep it near the cost of `lower()` over a whole business's names:
--   - Text with no letter past ASCII skips `translate`, which checks each character against all 518 letters of the
--     map, about 2.4 µs a character, and no ASCII letter is in the map. Only ASCII text in UTF-8 has as many bytes as
--     characters. Text with an accent still pays it in full: about 40 µs a 17-letter name.
--   - No `set search_path`, unlike every other function here: a function with one is never worked out inline, and the
--     call alone costs about 5 µs. Instead every name in it is written out in full, `pg_catalog.` and
--     `operator(pg_catalog.=)` included, so a caller's search_path can't change what it runs. Core's
--     search/fold.test.ts checks it stays inline.
create or replace function private.search_fold(p text) returns text
  language sql immutable parallel safe as $$
    select pg_catalog.lower(case
      when pg_catalog.octet_length(p) operator(pg_catalog.=) pg_catalog.length(p) then p
      else pg_catalog.translate(coalesce(p, ''),
      'ÀÁÂÃÄÅàáâãäåĀāĂăĄąǍǎǞǟǠǡǺǻȀȁȂȃȦȧḀḁẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặÆæǼǽǢǣḂḃḄḅḆḇÇçĆćĈĉĊċČčḈḉĎďḊḋḌḍḎḏḐḑḒḓĐđÐðÈÉÊËèéêëĒēĔĕĖėĘęĚěȄȅȆȇȨȩḔḕḖḗḘḙḚḛḜḝẸẹẺẻẼẽẾếỀềỂểỄễỆệḞḟĜĝĞğĠġĢģǦǧǴǵḠḡĤĥȞȟḢḣḤḥḦḧḨḩḪḫẖĦħÌÍÎÏìíîïĨĩĪīĬĭĮįİǏǐȈȉȊȋḬḭḮḯỈỉỊịıĴĵǰĶķǨǩḰḱḲḳḴḵĹĺĻļĽľḶḷḸḹḺḻḼḽŁłĿŀḾḿṀṁṂṃÑñŃńŅņŇňǸǹṄṅṆṇṈṉṊṋÒÓÔÕÖòóôõöŌōŎŏŐőƠơǑǒǪǫǬǭȌȍȎȏȪȫȬȭȮȯȰȱṌṍṎṏṐṑṒṓỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợØøǾǿŒœṔṕṖṗŔŕŖŗŘřȐȑȒȓṘṙṚṛṜṝṞṟŚśŜŝŞşŠšȘșṠṡṢṣṤṥṦṧṨṩßẞſŢţŤťȚțṪṫṬṭṮṯṰṱẗŦŧÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųƯưǓǔǕǖǗǘǙǚǛǜȔȕȖȗṲṳṴṵṶṷṸṹṺṻỤụỦủỨứỪừỬửỮữỰựṼṽṾṿŴŵẀẁẂẃẄẅẆẇẈẉẘẊẋẌẍÝýÿŶŷŸȲȳẎẏẙỲỳỴỵỶỷỸỹŹźŻżŽžẐẑẒẓẔẕΣς',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbccccccccccccddddddddddddddddeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeffgggggggggggggghhhhhhhhhhhhhhhhhiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiijjjkkkkkkkkkkllllllllllllllllllmmmmmmnnnnnnnnnnnnnnnnnnoooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooopppprrrrrrrrrrrrrrrrrrssssssssssssssssssssssstttttttttttttttttuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuvvvvwwwwwwwwwwwwwxxxxyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzσσ') end) $$;
comment on function private.search_fold(text) is
  'Accents folded one letter for one letter, then lower-cased: the length never changes. Core''s fold() in '
  'packages/core/src/search/fold.ts gives the same text. No search_path, so it is worked out inline; every name in '
  'it is written out in full.';
revoke all on function private.search_fold(text) from public;
grant execute on function private.search_fold(text) to authenticated, service_actor;

-- Notes, newest first. Partial, so channel copies and system lines aren't in it. The condition is written exactly
-- as core's NOTE_LINES (packages/core/src/search/server/kinds/notes.ts), so the planner proves it.
create index activities_notes_idx on app.activities (workspace_id, occurred_at desc, id desc)
  where kind = 'note' or (kind in ('call', 'visit') and subtype is null);

-- Threads by recency. Today's start (workspace_id, status, ...) or are partial (20260913000100:184-185).
create index conversations_recent_idx
  on app.conversations (workspace_id, last_message_at desc nulls last, id desc);

-- Form answers by recency. Today there is only (workspace_id) (20260927000200:110). A response's answers share their
-- time (one insert with now(), and an import gives them the response's), so response_id breaks the tie: a window cut
-- and paged on (answered_at, response_id) keeps each response in one place.
create index form_answers_recent_idx on app.form_answers (workspace_id, answered_at desc, response_id desc);

-- A response's answers are hidden while the response is in the Deleted bin. form_answers_select is workspace-only
-- (20260927000200:152-153); only form_responses has a bin rule (20261027000400:187-189). The inner read runs
-- form_responses' own rules as the person, its bin rule included, and touches only `id`, which `authenticated` may
-- read. Tied to the row, so reading one form's answers probes their responses by key instead of reading every
-- response the person can see first. The worker's policies don't change.
create policy form_answers_follow_response on app.form_answers as restrictive for select to authenticated
  using (exists (select 1 from app.form_responses r where r.id = form_answers.response_id));
