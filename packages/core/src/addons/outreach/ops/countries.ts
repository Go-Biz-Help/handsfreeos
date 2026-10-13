/**
 * Countries (../countries.ts, docs/outreach.md decision 61): the worker saves where each person lives, seen on their
 * profile or guessed by the AI; the Friends tab lists everyone the business's country setting skips, and **Unskip**
 * lets one through from then on, whatever the setting says.
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
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
  CountryUnskipInput,
  CountryUnskipOutput,
  countryName,
  countryRuleOn,
  SKIPPED_PAGE,
  type CountryHow,
} from '../countries';
import { outreachAddon } from '../manifest';
import { profiles } from '../tables';
import { countryRuleOf, inWorkspace } from './common';

export const countriesSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.countries.save',
  description:
    'Worker: where some of the people found live, as their profile showed it or the AI guessed it from their name, posts and groups, or that nothing said. A guess never replaces a country seen.',
  risk: 0,
  input: CountriesSaveInput,
  output: CountriesSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    let saved = 0;
    for (const p of input.people) {
      const how: CountryHow = p.country ? (p.how === 'unknown' ? 'guessed' : p.how) : 'unknown';
      const done = await ctx.tx
        .update(profiles)
        .set({ country: p.country, countryHow: how, countryAt: at })
        .where(
          and(
            eq(profiles.workspaceId, ws),
            eq(profiles.id, p.profileId),
            // Seen beats a guess, and a guess or "can't tell" never undoes what was seen.
            ...(how === 'seen'
              ? []
              : [or(isNull(profiles.countryHow), ne(profiles.countryHow, 'seen'))]),
          ),
        )
        .returning({ id: profiles.id });
      saved += done.length;
    }
    return { saved };
  },
});

export const countryUnskip = defineAddonCommand(outreachAddon, {
  name: 'outreach.country.unskip',
  description:
    'Let someone the business’s country setting skips be reached from now on, whatever the setting says (Unskip); or put them back under the setting.',
  risk: 1,
  input: CountryUnskipInput,
  output: CountryUnskipOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.country.unskipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .update(profiles)
      .set(
        input.through
          ? { countryThrough: true, countryThroughBy: me, countryThroughAt: at }
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

export const countriesSkipped = defineAddonQuery(outreachAddon, {
  name: 'outreach.countries.skipped',
  description:
    'Everyone the business’s country setting skips: not reached, not suggested on Today, not sent friend requests or messages, and not in the good fits; with their country and whether it was seen on their profile or guessed.',
  input: CountriesSkippedInput,
  output: CountriesSkippedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const rule = await countryRuleOf(ctx);
    const [through] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_outreach.profiles where workspace_id = ${ws} and country_through`,
    );
    const unskipped = through?.n ?? 0;
    if (!countryRuleOn(rule)) return { rule, people: [], unskipped, page: 1, pages: 1, total: 0 };
    const codes = `{${rule.codes.join(',')}}`;
    const where = sql`p.workspace_id = ${ws} and p.friendship <> 'self' and not p.country_through
      and p.country is not null
      and ${rule.mode === 'only' ? sql`not (p.country = any (${codes}::text[]))` : sql`p.country = any (${codes}::text[])`}
      and ${input.search ? sql`position(${input.search.toLowerCase()} in lower(p.name)) > 0` : sql`true`}`;
    const [counted] = await rows<{ total: number }>(
      ctx.tx,
      sql`select count(*)::int as total from addon_outreach.profiles p where ${where}`,
    );
    const total = counted?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / SKIPPED_PAGE));
    const page = Math.min(input.page, pages);
    const found = await rows<{
      id: string;
      name: string;
      url: string;
      country: string;
      country_how: CountryHow;
      country_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.url, p.country, p.country_how, p.country_at
          from addon_outreach.profiles p where ${where}
          order by p.country_at desc nulls last, lower(p.name), p.id
          limit ${SKIPPED_PAGE} offset ${(page - 1) * SKIPPED_PAGE}`,
    );
    return {
      rule,
      people: found.map((p) => ({
        profileId: p.id,
        name: p.name,
        url: p.url,
        country: p.country,
        countryName: countryName(p.country),
        how: p.country_how,
        at: p.country_at === null ? null : new Date(p.country_at).toISOString(),
      })),
      unskipped,
      page,
      pages,
      total,
    };
  },
});

export const countryCommands = [countriesSave, countryUnskip] as const;
export const countryQueries = [countriesSkipped] as const;
