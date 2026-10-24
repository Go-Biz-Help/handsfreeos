# Where people live: reading it right, and asking their friends

Social Outreach skips people outside the countries a business picks (decision 61 in `docs/outreach.md`). On
24 Oct 2026 the owner found people skipped who live in the United States:

- **DrTricia Coacht Herreira**, skipped as Trinidad and Tobago, "Seen on their profile". Her profile's Personal
  details say "Lives in Florida City, Florida", then "From Trinidad and Tobago", and the row under her name shows
  "Florida City, FL".
- **Frank Sinclair**, skipped as the United Kingdom, "Guessed by the AI". He sent a friend request. His profile says
  "Lives in Colorado Springs, Colorado", and he has 59 mutual friends with the owner.

Why it happened:

1. On Facebook's 2026 profile layout, the extension reads the row under the name and any Intro card, but not the
   Personal details card after the tabs, where "Lives in" sits (`apps/extension/src/networks/facebook/profile.ts`;
   `readers.test.ts` reads `profile-2026.html` without its "Lives in Austin").
2. The row under the name shows the place without "Lives in" ("Florida City, FL"), so `countryFromLines` misses it.
3. "From" counts as much as "Lives in". With no "Lives in" line, a "From" line makes a country seen.
4. The AI's word that a line showed the country is trusted whenever it was given any line (`guessedCountries`, and
   `outreach.check.save`), so a workplace like "Guardian Group Trinidad" can pass as seen.
5. A friend request shows only a name and a mutual friend count, so the AI guesses from the name, and a guess skips.
   Nobody looks at the profile afterwards, and mutual friends count for nothing.

This plan fixes the reading, stops a guess from skipping anyone on its own, and adds the business's own friends as
evidence: if many of the friends someone shares with you live in your countries, they likely do too.

## Decisions (Chris, 2026-10-24)

| Question                                    | Answer                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A country the AI only guessed               | **Look before skipping.** Nobody is skipped on a guess. Before the first step with them, the extension reads their profile and mutual friends; they're skipped only if that says they're outside the business's countries. |
| How to use their friends                    | **The mutual friends list.** Open the friends they share with the account that looked (one more page) and see where those friends live, from the friends the business already saved. Not their whole friends list.         |
| How many mutual friends is enough           | **Dynamic, weighed by the AI.** No fixed number. The AI weighs how many friends they have, how many are mutual, and where the mutual friends live, against how the business's own friends are spread.                      |
| Profile says one place, friends say another | **Ask the owner.** They go on a **Doubtful** list with the reason, and aren't reached until a person picks Let through or Skip.                                                                                            |
| The AI still isn't sure after a look        | **Doubtful list**, the same one.                                                                                                                                                                                           |
| The daily limit                             | **A look is a full check** (decision 46): one visit says both where they live and whether they fit. It counts toward the 40 a day. Friend requests to the person go first, then whoever Today would reach next.            |

Kept from decision 61, not re-asked:

- The setting skips, it never deletes. Someone whose country isn't known is let through.
- **Unskip** lets a person through for good, whatever the setting says.
- A reply owed is never skipped.

Taken from the answers (say if any is wrong):

- **"Lives in" beats "From"**, wherever each was read. "From" is kept and shown, but on its own it counts like a
  guess: they wait for a look.
- **A look that finds nothing but a name** (no place, no mutual friends, a hidden list) sends them to Doubtful with
  "Only their name to go on", since that's the AI not being sure.
- **Everyone skipped today goes through the new rules** once they ship (step 8 below).

## The order of evidence

Strongest first. A stronger kind always replaces a weaker one; the same kind replaces itself when read again later.

1. **A person's own call:** Unskip, or Skip on the Doubtful list.
2. **Lives in:** a "Lives in" line on the profile (Personal details or Intro), or the place in the row under their
   name.
3. **Their friends**, after a look: what the AI makes of their mutual friends with the profile's lines.
4. **From:** only a "From" line.
5. **The AI's guess** from their name, posts and groups.

## How it works

1. **Reading the profile right** (the extension).
   - Read the Personal details, Work and Education cards on anyone's 2026 profile, as `own-profile.ts` already does
     for the person's own (`INTRO_CARDS`). The lines go in `intro` with the rest.
   - The row under the name: the item beside the place pin is where they live. Where the pin can't be told apart,
     an item that reads wholly as a place ("Florida City, FL", "Lagos, Nigeria"; `countryOfPlace` on the whole item)
     counts. It's kept as a "Lives in …" line, so core reads it the same way.
   - Read their friend count ("4.9K friends · 59 mutual") beside the mutual count it already reads.
   - Every read of a profile updates where they live: a check, the profile opened beside a friend request, or one
     the person opens as they browse. A "Lives in" read now replaces a From or a guess (today the worker reads a
     profile's lines once, and never again).
2. **Lives in beats From** (`packages/core/src/addons/outreach/countries.ts`).
   - `countryFromLines` says which kind it found: `{ code, kind: 'lives' | 'from' }`, every line's "Lives in"
     before any "From", as today.
   - The AI's word never makes a country seen. It names the line it went by (`placeLine`). Only a line that was
     really in what it was sent, and that `countryFromLines` reads, makes the country seen.
3. **Waiting for a look.** Where the setting would skip someone whose country is only From or a guess, they aren't
   skipped: they **wait for a look**. Nobody reaches them meanwhile, and they go first for the day's checks: friend
   requests to the person first, then whoever Today would reach next (a friend request, a warm lead, a comment). A
   guess or From that the setting lets through needs no look.
4. **The look: a check, plus mutual friends.**
   - The check reads the profile as decision 46 does, then opens their mutual friends with the account that looked
     (`/friends_mutual`, read with the friends-list reader), up to 200 of them. A hidden list or none is noted as
     none.
   - Each mutual friend is matched to the business's saved profiles (its friends list), with that friend's country
     and how it's known.
   - It counts toward the day's 40. When they're used up, those waiting go first tomorrow.
5. **The AI weighs it** (the check's question, `packages/core/src/addons/outreach/checks.ts`). With what it reads
   for the fit, it now gets:
   - their "Lives in" and "From" lines;
   - their friend count and mutual count;
   - their mutual friends by country, seen apart from guessed, and how many aren't known;
   - how the business's own friends are spread across countries, so it knows what "most of them" means here;
   - their name, posts and groups, as before.

   It answers with a country, another country when the evidence splits, whether it's sure, and one short line why.
   The prompt tells it how to weigh, rather than fixing numbers: mutual friends count more the larger a share of
   their friends they are; a "Lives in" is strong unless their friends clearly say otherwise; a name is weak.

   With the cases above: Frank lives in Colorado Springs and has 59 mutual friends, most of those known in the
   United States, so he's let through, sure. DrTricia lives in Florida City, so she's the United States, with
   Trinidad and Tobago kept as where she's from.

6. **Doubtful.** When the AI isn't sure, or the profile and the friends disagree, and the setting treats the two
   countries differently, the person goes on **Doubtful** and isn't reached until a person picks:
   - **Let through**: as Unskip, for good.
   - **Skip**: skipped whatever the setting says, until undone.

   A split the setting doesn't care about (the United States or Canada, with Only the United States and Canada)
   needs nobody's call.

7. **The lists say why.** The Friends tab gets **Not sure where they live** above Skipped for country. Each row
   shows the name, what the profile says, what the friends say ("31 of the 40 mutual friends we know live in
   Nigeria"), the AI's line, and the two buttons. Skipped for country shows the same reason, by kind (Lives in,
   From, Their friends, Guessed), and how many wait for a look.
8. **Everyone skipped today.** When this ships, each person the setting skips is read again: the lines kept from
   their groups are read with the new rules. Those seen by an older check (whose lines aren't kept, so Lives in
   can't be told from From) and every guess wait for a look. Nobody is reached meanwhile, and only people Today
   would reach use up checks, so the look-ups follow real need.

## Data

`addon_outreach.profiles` (a new migration, numbered above the newest; mirrored in Drizzle):

- `country_how` also takes `from` and `friends`. `seen` keeps meaning a "Lives in" line or the place under the name.
- `country_from`: the country a "From" line names, kept to show.
- `country_alt`: the other country, when the evidence splits.
- `country_why`: the AI's line, up to 200 characters.
- `country_hold`: none, `look` (waiting for a look) or `doubtful`.
- `country_skip`, `country_skip_by`, `country_skip_at`: a person's Skip, beside `country_through`.
- `friends_count`: their friend count, as last read.

`addon_outreach.mutual_friends` (new): a profile, a friend it shares with the account that looked, and when.
Replaced by each look. Policies through `private.addon_table_policies()`; nothing in `app` points into it.

Migration of what's kept today: everyone the setting skips whose country is guessed, or seen without kept lines that
say "Lives in", gets `country_hold = 'look'`.

## Operations

- `outreach.check.save` takes the mutual friends and the where-they-live answer, and sets the country, the hold,
  the other country and the line. A guess never replaces a "Lives in"; a person's call is never touched.
- `outreach.countries.save` (the worker's batch) keeps a From as `from`, and its guesses never skip.
- `outreach.country.decide` (new, risk 1): Let through or Skip someone on Doubtful, or undo it. Who and when are
  kept.
- `outreach.countries.doubtful` (new): the Not sure list. `outreach.countries.skipped` adds the reason per row and
  the number waiting for a look.
- `countryLetsSql`, the one filter every pick uses, learns the hold and the person's Skip. Every place that picks
  people stays on it.
- The check order (decision 46) puts those waiting for a look first.
- `pnpm openapi` after the operations change.

## Words

- The kinds: "Lives there, on their profile", "From there, on their profile", "Worked out from their friends",
  "Guessed by the AI".
- The Not sure list: "Their profile and their friends don’t agree, or there’s too little to go on. Nobody here is
  reached until you pick."
- Waiting: "12 people wait for a look at their profile before they’re reached or skipped."
- Clients branch on the hold and the kind, never on these words.

## Tests

- Core: "Lives in" beats "From" in any order of lines; the place under the name counts; the AI's claim of a line
  counts only when the line is there; `countryLets` with each hold, Skip and Unskip; Doubtful only when the setting
  treats the two countries differently.
- Extension: `profile-2026.html` and `friend-requests-profile-2026.html` read Personal details ("Lives in Austin",
  "Lives in Fairview") and the friend count; a new fixture of a mutual friends page.
- Core ops: a check's save sets the hold and the reason; Decide; the migration's move of today's skipped.
- Db: the new table's policies.

## Build order

1. **The reading bugs**, alone: Personal details, the place under the name, Lives in beats From, the AI can't
   claim a line. This alone fixes DrTricia's kind of case.
2. **Waiting for a look**: guesses and From no longer skip, the checks put them first, and today's skipped move
   over.
3. **Mutual friends and the AI's weighing.**
4. **The Not sure list**, Decide, and the reasons on Skipped for country.

The web gets the lists first, like Skipped for country today; the phone keeps following the setting as saved.

## Not in this plan

- Reading someone's whole friends list: many pages each, often hidden, and more chance of a Facebook limit.
- LinkedIn, Instagram and Alignable, whose profiles show a place plainly. This is Facebook's.
