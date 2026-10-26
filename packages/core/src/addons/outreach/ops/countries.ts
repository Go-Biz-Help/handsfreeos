/**
 * Countries (../countries.ts, docs/outreach.md decisions 61 and 86): the worker saves where each person lives from the
 * lines under their name or the AI's guess (a check saves what a look comes to, ./checks.ts); the Friends tab lists
 * everyone the business's country setting skips, and everyone a look couldn't place when the business asked to
 * decide (the Not sure list). **Unskip** lets one through from then on, whatever the setting says; on the Not sure
 * list, **Let through** and **Skip** are a person's call.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  COUNTRY_WORDS,
  CountriesSaveInput,
  CountriesSaveOutput,
  CountriesSkippedInput,
  CountriesSkippedOutput,
  CountryDecideInput,
  CountryDecideOutput,
  CountryUnskipInput,
  CountryUnskipOutput,
  countryName,
  countryReason,
  countryRuleOn,
  SKIPPED_PAGE,
  type CountryHow,
  type MutualCountries,
} from '../countries';
import { outreachAddon } from '../manifest';
import { profiles } from '../tables';
import { countryFateSql, countryRuleOf, inWorkspace, keepCountry, waitsForLook } from './common';

export const countriesSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.countries.save',
  description:
    'Worker: where some of the people found live, as the lines under their name showed it (Lives in, or only From) or the AI guessed it from their name, posts and groups, or that nothing said. Never undoes a Lives in or what a look found.',
  risk: 0,
  input: CountriesSaveInput,
  output: CountriesSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    let saved = 0;
    for (const p of input.people)
      if (await keepCountry(ctx, p.profileId, { country: p.country, how: p.how })) saved++;
    return { saved };
  },
});

export const countryUnskip = defineAddonCommand(outreachAddon, {
  name: 'outreach.country.unskip',
  description:
    'Let someone the business’s country setting skips be reached from now on, whatever the setting says (Unskip), undoing a Skip; or put them back under the setting.',
  risk: 1,
  input: CountryUnskipInput,
  output: CountryUnskipOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_unskip_country',
    autonomy: 'confirm',
    keywords: ['unskip', 'let them through'],
  },
  scope: inWorkspace,
  emits: ['outreach.country.unskipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .update(profiles)
      .set(
        input.through
          ? {
              countryThrough: true,
              countryThroughBy: me,
              countryThroughAt: at,
              countrySkip: false,
              countrySkipBy: null,
              countrySkipAt: null,
            }
          : { countryThrough: false, countryThroughBy: null, countryThroughAt: null },
      )
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      )
      .returning({ id: profiles.id });
    if (!row) throw HfosError.rule('outreach_profile_gone', 404, COUNTRY_WORDS.notFound);
    await ctx.emit({
      type: 'outreach.country.unskipped',
      entityType: 'outreach_profile',
      entityId: row.id,
      payload: { through: input.through },
    });
    return { profileId: row.id, through: input.through };
  },
});

export const countryDecide = defineAddonCommand(outreachAddon, {
  name: 'outreach.country.decide',
  description:
    'A person’s call on someone the country setting couldn’t place (the Not sure list): let them through from now on, skip them from now on, or put them back under the setting. Kept with who and when.',
  risk: 1,
  input: CountryDecideInput,
  output: CountryDecideOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_decide_country',
    autonomy: 'confirm',
    keywords: ['not sure list', 'where they live'],
  },
  scope: inWorkspace,
  emits: ['outreach.country.decided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const through = input.choice === 'through';
    const skip = input.choice === 'skip';
    const [row] = await ctx.tx
      .update(profiles)
      .set({
        countryThrough: through,
        countryThroughBy: through ? me : null,
        countryThroughAt: through ? at : null,
        countrySkip: skip,
        countrySkipBy: skip ? me : null,
        countrySkipAt: skip ? at : null,
      })
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      )
      .returning({ id: profiles.id });
    if (!row) throw HfosError.rule('outreach_profile_gone', 404, COUNTRY_WORDS.notFound);
    await ctx.emit({
      type: 'outreach.country.decided',
      entityType: 'outreach_profile',
      entityId: row.id,
      payload: { choice: input.choice },
    });
    return { profileId: row.id, choice: input.choice };
  },
});

export const countriesSkipped = defineAddonQuery(outreachAddon, {
  name: 'outreach.countries.skipped',
  description:
    'Everyone the business’s country setting skips (not reached, not suggested on Today, not sent friend requests or messages, and not in the good fits), or everyone a look couldn’t place who waits for a person’s call (the Not sure list); with their country, how it’s known and why, and how many wait for a look.',
  input: CountriesSkippedInput,
  output: CountriesSkippedOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_country_skipped',
    keywords: ['country setting', 'skipped people', 'not sure where they live'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const rule = await countryRuleOf(ctx);
    const fate = countryFateSql(rule, 'p');
    const [counted] = await rows<{ through: number; waiting: number; unsure: number }>(
      ctx.tx,
      sql`select count(*) filter (where p.country_through)::int as through,
            count(*) filter (where ${waitsForLook(rule, 'p')})::int as waiting,
            count(*) filter (where ${fate} = 'ask')::int as unsure
          from addon_outreach.profiles p where p.workspace_id = ${ws} and p.friendship <> 'self'`,
    );
    const unskipped = counted?.through ?? 0;
    const waiting = counted?.waiting ?? 0;
    const unsure = counted?.unsure ?? 0;
    const shownRule = { mode: rule.mode, codes: rule.codes, unsure: rule.unsure };
    const none = { rule: shownRule, people: [], unskipped, waiting, unsure, page: 1, pages: 1 };
    if (!countryRuleOn(rule)) return { ...none, total: 0 };
    const where = sql`p.workspace_id = ${ws} and p.friendship <> 'self'
      and ${fate} = ${input.list === 'unsure' ? 'ask' : 'skip'}
      and ${input.search ? sql`position(${input.search.toLowerCase()} in lower(p.name)) > 0` : sql`true`}`;
    const [all] = await rows<{ total: number }>(
      ctx.tx,
      sql`select count(*)::int as total from addon_outreach.profiles p where ${where}`,
    );
    const total = all?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / SKIPPED_PAGE));
    const page = Math.min(input.page, pages);
    const found = await rows<{
      id: string;
      name: string;
      url: string;
      country: string | null;
      country_how: CountryHow | null;
      country_from: string | null;
      country_alt: string | null;
      country_why: string | null;
      country_mutual: MutualCountries | null;
      country_skip: boolean;
      country_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.url, p.country, p.country_how, p.country_from, p.country_alt, p.country_why,
            p.country_mutual, p.country_skip, greatest(p.country_at, p.country_looked_at) as country_at
          from addon_outreach.profiles p where ${where}
          order by greatest(p.country_at, p.country_looked_at) desc nulls last, lower(p.name), p.id
          limit ${SKIPPED_PAGE} offset ${(page - 1) * SKIPPED_PAGE}`,
    );
    return {
      ...none,
      people: found.map((p) => ({
        profileId: p.id,
        name: p.name,
        url: p.url,
        country: p.country,
        countryName: p.country ? countryName(p.country) : null,
        how: p.country_how,
        reason: p.country_how
          ? countryReason({
              how: p.country_how,
              country: p.country,
              from: p.country_from,
              alt: p.country_alt,
              mutual: p.country_mutual,
            })
          : [],
        why: p.country_why,
        skippedByYou: p.country_skip,
        at: p.country_at === null ? null : new Date(p.country_at).toISOString(),
      })),
      page,
      pages,
      total,
    };
  },
});

export const countryCommands = [countriesSave, countryUnskip, countryDecide] as const;
export const countryQueries = [countriesSkipped] as const;
