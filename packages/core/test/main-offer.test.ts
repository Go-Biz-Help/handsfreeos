/**
 * The business's main offer (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Part 1): there only while an add-on that
 * uses it is on, edited as a draft by owners and admins, scored by the worker, and published as versions that never
 * change. Every part clears 7 before it goes live, unless someone says why it goes anyway.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDON_CATALOG } from '../src/addons/catalog';
import { currentCapabilityIds } from '../src/addons/capabilities';
import { manifestIssues, type AddonManifest } from '../src/addons/manifest';
import { outreachAddon } from '../src/addons/outreach/manifest';
import {
  clearsBar,
  MainOfferParts,
  missingParts,
  namesGoneBy,
  offerLineFrom,
  underBar,
  type MainOfferScore,
} from '../src/main-offer/parts';
import {
  mainOfferDiscardDraft,
  mainOfferGet,
  mainOfferPublish,
  mainOfferSaveDirection,
  mainOfferSaveDraft,
  mainOfferSaveNames,
  mainOfferScoreSave,
  mainOfferTryApply,
  mainOfferTryList,
  mainOfferTrySave,
  mainOfferVersionList,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, setupTeam, type Team } from './calendar-helpers';

const complete = MainOfferParts.parse({
  who: {
    work: 'Roofers',
    slice: 'with 2 to 3 crews',
    problem: 'Stuck on referrals, no steady jobs',
  },
  outcome: { result: '10 to 20 booked roof inspections a month' },
  timeframe: { typical: '60 days' },
  method: { steps: ['Find the homes', 'Run the ads', 'Book the calls'] },
  guarantee: { promise: 'If you don’t get 10 in 60 days, you don’t pay' },
  price: { amount: '$2,000 a month' },
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month within 60 days.',
  inAFewWords: { outcome: '10 to 20 booked inspections', guarantee: 'you only pay for results' },
});

function scoreOf(each: number, low?: { part: keyof MainOfferScore['parts']; score: number }) {
  const part = (p: keyof MainOfferScore['parts']) => ({
    score: low?.part === p ? low.score : each,
    why: 'Clear and specific.',
  });
  return {
    parts: {
      who: part('who'),
      outcome: part('outcome'),
      timeframe: part('timeframe'),
      method: part('method'),
      guarantee: part('guarantee'),
      price: part('price'),
    },
    weakest: low?.part ?? 'price',
    fix: 'Say what the guarantee needs from them.',
    flags: { vague: false, generic: false, hardToBelieve: false },
    threeSeconds: true,
  } satisfies MainOfferScore;
}

describe('the main offer’s parts', () => {
  it('say what a draft still needs, in the builder’s order', () => {
    expect(missingParts(MainOfferParts.parse({})).map((m) => m.path)).toEqual([
      'who.work',
      'who.problem',
      'outcome.result',
      'timeframe.typical',
      'method.steps',
      'guarantee.promise',
      'price.amount',
      'line',
      'inAFewWords.outcome',
      'inAFewWords.guarantee',
    ]);
    expect(missingParts(complete)).toEqual([]);
    const twoSteps = MainOfferParts.parse({ ...complete, method: { steps: ['One', 'Two'] } });
    expect(missingParts(twoSteps).map((m) => m.path)).toEqual(['method.steps']);
  });

  it('need every part at 7 or more, the lowest named first', () => {
    expect(clearsBar(scoreOf(8))).toBe(true);
    expect(clearsBar(scoreOf(8, { part: 'guarantee', score: 6 }))).toBe(false);
    const low = { ...scoreOf(8), parts: { ...scoreOf(8).parts, price: { score: 5, why: '' } } };
    low.parts.who = { score: 6, why: '' };
    expect(underBar(low)).toEqual(['price', 'who']);
  });

  it('put the one-line offer together the workbook’s way', () => {
    expect(offerLineFrom(complete)).toBe(
      'We help Roofers with 2 to 3 crews get 10 to 20 booked roof inspections a month within 60 days using Find the homes, Run the ads, Book the calls. If you don’t get 10 in 60 days, you don’t pay. $2,000 a month.',
    );
  });

  it('are shown only while an add-on that uses them runs, and an add-on names only core’s', () => {
    const ids = (running: string[]) =>
      currentCapabilityIds({
        catalog: ADDON_CATALOG,
        installations: Object.fromEntries(running.map((id) => [id, 'enabled' as const])),
        permissions: null,
      });
    expect(ids([])).not.toContain('sales.main_offer');
    expect(ids(['realestate'])).not.toContain('sales.main_offer');
    expect(ids(['outreach'])).toContain('sales.main_offer');
    const wrong = { ...outreachAddon, uses: ['main_offer', 'nope'] } as unknown as AddonManifest;
    expect(manifestIssues(wrong).map((i) => i.message)).toContain(
      'uses "nope", which isn\'t one of core\'s features',
    );
  });
});

describe('the main offer', () => {
  let t: Team;
  const ws = () => ({ workspaceId: t.wsId });

  beforeAll(async () => {
    t = await setupTeam('main-offer');
  });
  afterAll(closeTestDbs);

  it('is refused, and says where it comes from, while no add-on that uses it is on', async () => {
    const e = await expectHfos(
      () => run(mainOfferSaveDraft, { ...ws(), revision: 0, parts: complete }, t.owner),
      'main_offer_not_in_use',
      409,
    );
    expect(e.message).toContain('Social Outreach');
    expect(await ask(mainOfferGet, ws(), t.member)).toMatchObject({
      inUse: false,
      comesWith: ['Social Outreach'],
      revision: 0,
      live: null,
      draft: null,
    });
  });

  it('is drafted by owners and admins, scored by the worker and published as versions', async () => {
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    await expectHfos(
      () => run(mainOfferSaveDraft, { ...ws(), revision: 0, parts: complete }, t.member),
      'forbidden',
    );

    // A draft with gaps saves, and says what it still needs.
    const gappy = MainOfferParts.parse({ ...complete, price: {} });
    expect(await run(mainOfferSaveDraft, { ...ws(), revision: 0, parts: gappy }, t.owner)).toEqual({
      revision: 1,
    });
    await expectHfos(
      () => run(mainOfferSaveDraft, { ...ws(), revision: 0, parts: complete }, t.owner),
      'main_offer_draft_moved',
      409,
    );
    let got = await ask(mainOfferGet, ws(), t.member);
    expect(got).toMatchObject({ inUse: true, revision: 1, live: null });
    expect(got.draft?.missing.map((m) => m.path)).toEqual(['price.amount']);
    expect(got.draft?.by?.name).toBe('Dale Owner');
    await expectHfos(() => run(mainOfferPublish, { ...ws(), revision: 1 }, t.owner), 'validation');

    // Unscored, it can't go live; a score for an older draft is for nothing.
    await run(mainOfferSaveDraft, { ...ws(), revision: 1, parts: complete }, t.owner);
    await expectHfos(
      () => run(mainOfferPublish, { ...ws(), revision: 2 }, t.owner),
      'main_offer_not_scored',
    );
    expect(
      await runSystem(mainOfferScoreSave, { ...ws(), revision: 1, score: scoreOf(9) }, t.scope),
    ).toEqual({ saved: false });

    // Under the bar, it goes only with a reason, kept with the version.
    const low = scoreOf(8, { part: 'guarantee', score: 5 });
    expect(
      await runSystem(mainOfferScoreSave, { ...ws(), revision: 2, score: low }, t.scope),
    ).toEqual({ saved: true });
    expect((await ask(mainOfferGet, ws(), t.owner)).draft?.score?.parts.guarantee.score).toBe(5);
    const e = await expectHfos(
      () => run(mainOfferPublish, { ...ws(), revision: 2 }, t.owner),
      'main_offer_below_bar',
      422,
    );
    expect(e.message).toContain('Guarantee scored 5 out of 10, under the 7 every part needs.');
    expect(
      await run(
        mainOfferPublish,
        { ...ws(), revision: 2, anyway: 'Testing it with past customers first' },
        t.owner,
      ),
    ).toEqual({ version: 1 });
    got = await ask(mainOfferGet, ws(), t.member);
    expect(got).toMatchObject({ revision: 3, draft: null });
    expect(got.live).toMatchObject({
      version: 1,
      line: complete.line,
      anyway: 'Testing it with past customers first',
      publishedBy: { name: 'Dale Owner' },
    });
    await expectHfos(
      () => run(mainOfferPublish, { ...ws(), revision: 3 }, t.owner),
      'main_offer_no_draft',
    );

    // The next version clears the bar: no reason kept, and the first stays as it was.
    const better = MainOfferParts.parse({
      ...complete,
      guarantee: { ...complete.guarantee, qualifies: 'Roofers with a crew free to run the jobs' },
    });
    await run(mainOfferSaveDraft, { ...ws(), revision: 3, parts: better }, t.owner);
    await runSystem(mainOfferScoreSave, { ...ws(), revision: 4, score: scoreOf(8) }, t.scope);
    expect(
      await run(mainOfferPublish, { ...ws(), revision: 4, anyway: 'Ignored' }, t.owner),
    ).toEqual({ version: 2 });
    const list = await ask(mainOfferVersionList, ws(), t.member);
    expect(list.versions.map((v) => [v.version, v.lowest, v.anyway])).toEqual([
      [2, 8, null],
      [1, 5, 'Testing it with past customers first'],
    ]);
    const refused = await rows(
      admin(),
      sql`update app.main_offer_versions set line = 'Changed' where workspace_id = ${t.wsId}`,
    ).then(
      () => 'changed',
      (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message,
    );
    expect(refused).toMatch(/append-only/);
    const [published] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${t.wsId} and event_type = 'main_offer.published'`,
    );
    expect(published?.n).toBe(2);
  });

  it('throws a draft away and keeps the live version', async () => {
    const before = await ask(mainOfferGet, ws(), t.owner);
    expect(await run(mainOfferDiscardDraft, ws(), t.owner)).toEqual({
      discarded: false,
      revision: before.revision,
    });
    await run(
      mainOfferSaveDraft,
      { ...ws(), revision: before.revision, parts: MainOfferParts.parse({}) },
      t.owner,
    );
    const out = await run(mainOfferDiscardDraft, ws(), t.owner);
    expect(out).toEqual({ discarded: true, revision: before.revision + 2 });
    expect(await ask(mainOfferGet, ws(), t.owner)).toMatchObject({
      draft: null,
      live: { version: 2 },
    });
  });

  it('is kept while the add-on is off, and can’t be changed then', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${t.wsId} and addon_id = 'outreach'`,
    );
    const got = await ask(mainOfferGet, ws(), t.owner);
    expect(got).toMatchObject({ inUse: false, live: { version: 2 } });
    await expectHfos(() => run(mainOfferDiscardDraft, ws(), t.owner), 'main_offer_not_in_use');
  });
});

describe('the owner’s direction and the AI’s tries', () => {
  let t: Team;
  const ws = () => ({ workspaceId: t.wsId });
  // A try that rewrote the who and the outcome, with its own line and few words, and kept the method.
  const tried = MainOfferParts.parse({
    ...complete,
    who: {
      work: 'Businesses that live on leads',
      slice: 'like home services, real estate and insurance',
      problem: 'They lose work because nobody answers fast enough',
    },
    outcome: { result: 'An AI teammate that answers every lead in 30 seconds' },
    line: 'We help businesses that live on leads answer every lead in 30 seconds.',
    inAFewWords: { outcome: 'every lead answered in 30 seconds', guarantee: 'a month free if not' },
  });
  const why = {
    who: 'Kept all three, as your note asked.',
    outcome: 'Leads with the AI teammate, as your direction says.',
    timeframe: null,
    method: null,
    guarantee: null,
    price: null,
  };
  const keepTry = (revision: number) =>
    runSystem(
      mainOfferTrySave,
      {
        ...ws(),
        revision,
        parts: tried,
        why,
        score: scoreOf(8),
        notes: { who: 'Broad on purpose.' },
        keep: ['method', 'method'],
      },
      t.scope,
    );

  beforeAll(async () => {
    t = await setupTeam('main-offer-tries');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    await run(mainOfferSaveDraft, { ...ws(), revision: 0, parts: complete }, t.owner);
  });

  it('keeps the direction, and scores the draft again against it', async () => {
    const direction = 'It’s more than a CRM. It’s for any business that lives on leads.';
    await expectHfos(
      () => run(mainOfferSaveDirection, { ...ws(), revision: 1, direction }, t.member),
      'forbidden',
    );
    await expectHfos(
      () => run(mainOfferSaveDirection, { ...ws(), revision: 0, direction }, t.owner),
      'main_offer_draft_moved',
      409,
    );
    await runSystem(mainOfferScoreSave, { ...ws(), revision: 1, score: scoreOf(8) }, t.scope);
    expect(
      await run(
        mainOfferSaveDirection,
        { ...ws(), revision: 1, direction: ` ${direction} ` },
        t.owner,
      ),
    ).toEqual({ revision: 2 });
    // The same words again change nothing.
    expect(await run(mainOfferSaveDirection, { ...ws(), revision: 2, direction }, t.owner)).toEqual(
      {
        revision: 2,
      },
    );
    const got = await ask(mainOfferGet, ws(), t.member);
    expect(got).toMatchObject({ revision: 2, direction });
    expect(got.draft?.score).toBeNull();
    // Empty clears it, and putting it back moves the revision on again.
    expect(
      await run(mainOfferSaveDirection, { ...ws(), revision: 2, direction: '' }, t.owner),
    ).toEqual({ revision: 3 });
    expect((await ask(mainOfferGet, ws(), t.owner)).direction).toBeNull();
    await run(mainOfferSaveDirection, { ...ws(), revision: 3, direction }, t.owner);
  });

  it('keeps a try only for the draft it read, numbered within the round, never changed', async () => {
    expect(await keepTry(3)).toEqual({ saved: false, id: null, number: null });
    const first = await keepTry(4);
    expect(first).toMatchObject({ saved: true, number: 1 });
    expect(await keepTry(4)).toMatchObject({ saved: true, number: 2 });
    const { round, tries } = await ask(mainOfferTryList, ws(), t.member);
    expect(round).toBe(0);
    expect(tries.map((x) => x.number)).toEqual([2, 1]);
    const one = tries[1]!;
    expect(one).toMatchObject({
      id: first.id,
      fromRevision: 4,
      lowest: 8,
      direction: 'It’s more than a CRM. It’s for any business that lives on leads.',
      notes: { who: 'Broad on purpose.' },
      keep: ['method'],
      madeBy: null,
    });
    expect(one.base).toEqual(complete);
    expect(one.parts.who.work).toBe('Businesses that live on leads');
    expect(one.why.timeframe).toBeNull();
    const refused = await rows(
      admin(),
      sql`update app.main_offer_tries set number = 9 where id = ${first.id!}`,
    ).then(
      () => 'changed',
      (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message,
    );
    expect(refused).toMatch(/append-only/);
  });

  it('takes only the parts picked, and the try’s line only when it all fits', async () => {
    const [two, one] = (await ask(mainOfferTryList, ws(), t.owner)).tries;
    await expectHfos(
      () =>
        run(mainOfferTryApply, { ...ws(), revision: 4, tryId: one!.id, take: ['who'] }, t.member),
      'forbidden',
    );
    await expectHfos(
      () => run(mainOfferTryApply, { ...ws(), revision: 4, tryId: one!.id, take: [] }, t.owner),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          mainOfferTryApply,
          { ...ws(), revision: 4, tryId: '00000000-0000-4000-8000-000000000000', take: ['who'] },
          t.owner,
        ),
      'not_found',
    );

    // One part of two: the rest of the draft, its line included, stays as it was.
    await runSystem(mainOfferScoreSave, { ...ws(), revision: 4, score: scoreOf(8) }, t.scope);
    expect(
      await run(
        mainOfferTryApply,
        { ...ws(), revision: 4, tryId: one!.id, take: ['who'] },
        t.owner,
      ),
    ).toEqual({ revision: 5, lineFromTry: false });
    let draft = (await ask(mainOfferGet, ws(), t.owner)).draft!;
    expect(draft.parts.who).toEqual(tried.who);
    expect(draft.parts.outcome).toEqual(complete.outcome);
    expect(draft.parts.line).toBe(complete.line);
    expect(draft.score).toBeNull();

    // Every part it changed, into the draft it was written from: its line and few words come too.
    await run(mainOfferSaveDraft, { ...ws(), revision: 5, parts: complete }, t.owner);
    expect(
      await run(
        mainOfferTryApply,
        { ...ws(), revision: 6, tryId: two!.id, take: ['who', 'outcome', 'method'] },
        t.owner,
      ),
    ).toEqual({ revision: 7, lineFromTry: true });
    draft = (await ask(mainOfferGet, ws(), t.owner)).draft!;
    expect(draft.parts.line).toBe(tried.line);
    expect(draft.parts.inAFewWords).toEqual(tried.inAFewWords);
    expect(draft.parts.proof).toEqual(complete.proof);

    // Parts the try left as they were change nothing, so nothing moves on.
    expect(
      await run(
        mainOfferTryApply,
        { ...ws(), revision: 7, tryId: two!.id, take: ['price'] },
        t.owner,
      ),
    ).toEqual({ revision: 7, lineFromTry: false });
  });

  it('starts a new round once a version goes live, and refuses the last round’s tries', async () => {
    const [old] = (await ask(mainOfferTryList, ws(), t.owner)).tries;
    await runSystem(mainOfferScoreSave, { ...ws(), revision: 7, score: scoreOf(8) }, t.scope);
    expect(await run(mainOfferPublish, { ...ws(), revision: 7 }, t.owner)).toEqual({ version: 1 });
    expect(await ask(mainOfferTryList, ws(), t.member)).toEqual({ round: 1, tries: [] });
    await expectHfos(
      () =>
        run(mainOfferTryApply, { ...ws(), revision: 8, tryId: old!.id, take: ['who'] }, t.owner),
      'main_offer_no_draft',
    );
    await run(mainOfferSaveDraft, { ...ws(), revision: 8, parts: complete }, t.owner);
    const e = await expectHfos(
      () =>
        run(mainOfferTryApply, { ...ws(), revision: 9, tryId: old!.id, take: ['who'] }, t.owner),
      'main_offer_try_gone',
      409,
    );
    expect(e.message).toContain('from before version 1 went live');
    // The direction stays with the offer after it goes live.
    expect((await ask(mainOfferGet, ws(), t.owner)).direction).toContain('more than a CRM');
  });
});

describe('the names the business goes by (docs/outreach.md, decision 84)', () => {
  let t: Team;
  const ws = () => ({ workspaceId: t.wsId });

  beforeAll(async () => {
    t = await setupTeam('main-offer-names');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
  });

  it('are the business’s name in HandsFreeOS until some are saved, each once, by owners and admins', async () => {
    const first = await ask(mainOfferGet, ws(), t.member);
    expect(first.names).toEqual([]);
    expect(first.businessName).toBeTruthy();
    expect(namesGoneBy(first.names, first.businessName)).toEqual([first.businessName]);
    await expectHfos(
      () => run(mainOfferSaveNames, { ...ws(), names: ['Summit Roof Leads'] }, t.member),
      'forbidden',
    );
    // Each once, whatever its case, spaces tidied; no revision moves, as nothing's scored by them.
    expect(
      await run(
        mainOfferSaveNames,
        { ...ws(), names: [' Summit  Roof Leads ', 'summit roof leads', 'Roof Leads Pro'] },
        t.owner,
      ),
    ).toEqual({ names: ['Summit Roof Leads', 'Roof Leads Pro'] });
    const got = await ask(mainOfferGet, ws(), t.member);
    expect(got).toMatchObject({ names: ['Summit Roof Leads', 'Roof Leads Pro'], revision: 0 });
    expect(namesGoneBy(got.names, got.businessName)).toEqual([
      'Summit Roof Leads',
      'Roof Leads Pro',
    ]);
    // Too many is refused in words; none goes back to the business's own name.
    await expectHfos(
      () => run(mainOfferSaveNames, { ...ws(), names: ['a', 'b', 'c', 'd', 'e', 'f'] }, t.owner),
      'validation',
    );
    expect(await run(mainOfferSaveNames, { ...ws(), names: [] }, t.owner)).toEqual({ names: [] });
    expect((await ask(mainOfferGet, ws(), t.owner)).names).toEqual([]);
  });
});
