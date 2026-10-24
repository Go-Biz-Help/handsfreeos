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

| Question                          | Answer                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A country the AI only guessed     | **Look before skipping.** Nobody is skipped on a guess. Before the first step with them, the extension reads their profile and mutual friends; they're skipped only if that says they're outside the business's countries. |
| A profile that only says "From"   | **Look first, the same way.** People grow up in one country and live in another, so "From Nigeria" alone never skips anyone.                                                                                               |
| How to use their friends          | **The mutual friends list.** Open the friends they share with the account that looked (one more page) and see where those friends live, from the friends the business already saved. Not their whole friends list.         |
| How many mutual friends is enough | **Dynamic, weighed by the AI.** No fixed number. The AI weighs how many friends they have, how many are mutual, and where the mutual friends live, against how the business's own friends are spread.                      |
| When it still can't tell          | **The business picks, in a setting**: Let them through, Ask me, or Skip them. It covers a look that finds nothing but a name, the AI not being sure, and the profile and friends disagreeing.                              |
| The daily limit                   | **A look is a full check** (decision 46): one visit says both where they live and whether they fit. It counts toward the 40 a day. Friend requests to the person go first, then whoever Today would reach next.            |
| How it ships                      | **All at once**, in one release.                                                                                                                                                                                           |

Kept from decision 61, not re-asked:

- The setting skips, it never deletes.
- **Unskip** lets a person through for good, whatever the setting says.
- A reply owed is never skipped.

Changed from decision 61: someone whose country isn't known was always let through. Now the new setting decides, and
with Let them through it stays as it was.

Everyone skipped today goes through the new rules when they ship (step 8 below).

## The order of evidence

Strongest first. A stronger kind always replaces a weaker one; the same kind replaces itself when read again later.

1. **A person's own call:** Unskip, or Let through or Skip on the Not sure list.
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
   guess or From that the setting lets through needs no look. Someone whose country isn't known at all waits for a
   look too, unless When we can't tell is Let them through.
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

6. **When we can't tell** (a new setting, in Social Outreach → Settings → General under Which countries to reach,
   shown while that setting skips anyone). After a look, the business's choice applies to anyone who is:
   - only a name: no place on their profile, and no mutual friends or a hidden list;
   - someone the AI isn't sure about;
   - someone whose profile and friends point to two countries the setting treats differently ("Lives in Texas", but
     most of their mutual friends in Nigeria, with Only the United States). A split the setting doesn't care about
     (the United States or Canada, with Only the United States and Canada) isn't a "can't tell".

   The choices:
   - **Let them through**: reached like anyone else.
   - **Ask me** (to start, as the owner chose for these cases): they go on the **Not sure where they live** list and
     aren't reached until a person picks **Let through** (as Unskip, for good) or **Skip** (skipped whatever the
     setting says, until undone).
   - **Skip them**: skipped, and on Skipped for country with the reason "Couldn’t tell", where Unskip works as
     always.

   The choice is read whenever people are picked, never copied onto them, so changing it moves everyone at once.

7. **The lists say why.** With Ask me, the Friends tab shows **Not sure where they live** above Skipped for
   country. Each row shows the name, what the profile says, what the friends say ("31 of the 40 mutual friends we
   know live in Nigeria"), the AI's line, and the two buttons. Skipped for country shows the same reason, by kind (Lives in,
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
- `country_unsure`: true when a look couldn't tell (only a name, or the AI not sure). A split is known from
  `country` and `country_alt` against the setting, so it isn't stored.
- `country_hold`: none or `look` (waiting for a look). The Not sure list isn't a hold: the filter works it out from
  `country_unsure`, the split and the setting.
- `country_skip`, `country_skip_by`, `country_skip_at`: a person's Skip, beside `country_through`.
- `friends_count`: their friend count, as last read.

The add-on's settings: `countries.unsure` takes `through`, `ask` (to start) or `skip`, beside `mode` and `codes`
(`CountryRule`).

`addon_outreach.mutual_friends` (new): a profile, a friend it shares with the account that looked, and when.
Replaced by each look. Policies through `private.addon_table_policies()`; nothing in `app` points into it.

Migration of what's kept today: everyone the setting skips whose country is guessed, or seen without kept lines that
say "Lives in", gets `country_hold = 'look'`.

## Operations

- `outreach.check.save` takes the mutual friends and the where-they-live answer, and sets the country, the hold,
  the other country and the line. A guess never replaces a "Lives in"; a person's call is never touched.
- `outreach.countries.save` (the worker's batch) keeps a From as `from`, and its guesses never skip.
- `outreach.country.decide` (new, risk 1): Let through or Skip someone on the Not sure list, or undo it. Who and when are
  kept.
- `outreach.countries.unsure` (new): the Not sure list. `outreach.countries.skipped` adds the reason per row and
  the number waiting for a look.
- `countryLetsSql`, the one filter every pick uses, learns the hold, the person's Skip and When we can't tell. Every place that picks
  people stays on it.
- The check order (decision 46) puts those waiting for a look first.
- `pnpm openapi` after the operations change.

## Words

- The kinds: "Lives there, on their profile", "From there, on their profile", "Worked out from their friends",
  "Guessed by the AI".
- The setting: **When we can’t tell where someone lives**: "Let them through", "Ask me", "Skip them". Under it: "After
  a look at their profile and mutual friends, when there’s nothing to go on but a name, or their profile and their
  friends don’t agree."
- The Not sure list: "Their profile and their friends don’t agree, or there’s too little to go on. Nobody here is
  reached until you pick."
- Waiting: "12 people wait for a look at their profile before they’re reached or skipped."
- Clients branch on the hold and the kind, never on these words.

## Tests

- Core: "Lives in" beats "From" in any order of lines; the place under the name counts; the AI's claim of a line
  counts only when the line is there; `countryLets` with each hold, Skip, Unskip and each When we can't tell choice; a
  split counts as can't tell only when the setting treats the two countries differently.
- Extension: `profile-2026.html` and `friend-requests-profile-2026.html` read Personal details ("Lives in Austin",
  "Lives in Fairview") and the friend count; a new fixture of a mutual friends page.
- Core ops: a check's save sets the hold and the reason; Decide; the migration's move of today's skipped.
- Db: the new table's policies.

## Build order

One release: nothing ships until all of it is done. Built in this order on one branch:

1. **The reading**: Personal details, the place under the name, Lives in beats From, the AI can't claim a line.
2. **Waiting for a look**: guesses and From no longer skip, the checks put them first, and today's skipped move
   over.
3. **Mutual friends and the AI's weighing.**
4. **When we can't tell**, the Not sure list, Decide, and the reasons on Skipped for country.

The web gets the setting and the lists, like Skipped for country today; the phone keeps following the setting as
saved.

## Not in this plan

- Reading someone's whole friends list: many pages each, often hidden, and more chance of a Facebook limit.
- LinkedIn, Instagram and Alignable, whose profiles show a place plainly. This is Facebook's.
