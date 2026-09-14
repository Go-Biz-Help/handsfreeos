/**
 * Knowledge base commands and queries on the local database: the profile and its price switch, item CRUD,
 * CSV import of FAQs, suggestions (grouped gaps, accept creates an item, reject adds nothing), ranked
 * search over published items, the website and its scans, documents, and use counts.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { events, knowledgeProfiles } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  knowledgeDocumentAdd,
  knowledgeItemArchive,
  knowledgeItemCreate,
  knowledgeItemGet,
  knowledgeItemImportFaqs,
  knowledgeItemList,
  knowledgeItemPublish,
  knowledgeItemRecordUse,
  knowledgeItemUpdate,
  knowledgeProfileGet,
  knowledgeProfileUpdate,
  knowledgeScanGet,
  knowledgeScanStart,
  knowledgeSearch,
  knowledgeSourceSet,
  knowledgeSuggestionAccept,
  knowledgeSuggestionList,
  knowledgeSuggestionPropose,
  knowledgeSuggestionReject,
  organizationCreate,
  personCreate,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser, member: TestUser;
let wsId: string, scope: Scope;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('kb-owner', { fullName: 'Dale Owner' }),
    createTestUser('kb-member', { fullName: 'Mike Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Knowledge Co' }, owner);
  wsId = org.workspaceId;
  scope = { workspaceId: wsId, organizationId: org.organizationId };
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

const create = (content: Record<string, unknown>, status: 'draft' | 'published' = 'draft') =>
  run(knowledgeItemCreate, { workspaceId: wsId, content, status }, owner);
const item = (itemId: string) => ask(knowledgeItemGet, { workspaceId: wsId, itemId }, member);
const eventsOf = (type: string) =>
  admin()
    .select({ payload: events.payload, entityId: events.entityId })
    .from(events)
    .where(and(eq(events.workspaceId, wsId), eq(events.eventType, type)));

describe('the profile', () => {
  it('saves the profile and keeps allow_prices in step with it', async () => {
    const saved = await run(
      knowledgeProfileUpdate,
      {
        workspaceId: wsId,
        profile: {
          description: 'Heating and cooling for Houston homes.',
          services: [{ name: 'AC tune-up', price: '$89' }],
          tone: 'Friendly and plain-spoken',
          allowPrices: true,
        },
      },
      owner,
    );
    expect(saved.updated).toEqual(
      expect.arrayContaining(['description', 'services', 'tone', 'allowPrices']),
    );
    const rowOf = async () =>
      (
        await admin()
          .select()
          .from(knowledgeProfiles)
          .where(eq(knowledgeProfiles.workspaceId, wsId))
      )[0]!;
    let row = await rowOf();
    expect(row).toMatchObject({ allowPrices: true, updatedBy: owner.id });
    expect((row.profile as { allowPrices: boolean }).allowPrices).toBe(true);

    const off = await run(
      knowledgeProfileUpdate,
      { workspaceId: wsId, profile: { ...saved.profile, allowPrices: false } },
      owner,
    );
    expect(off.updated).toEqual(['allowPrices']);
    row = await rowOf();
    expect(row.allowPrices).toBe(false);
    expect((row.profile as { allowPrices: boolean }).allowPrices).toBe(false);
    const again = await run(
      knowledgeProfileUpdate,
      { workspaceId: wsId, profile: off.profile },
      owner,
    );
    expect(again.updated).toEqual([]);
    expect(await eventsOf('knowledge.profile_updated')).toHaveLength(2);

    const read = await ask(knowledgeProfileGet, { workspaceId: wsId }, member);
    expect(read.profile).toMatchObject({ allowPrices: false, tone: 'Friendly and plain-spoken' });
    expect(read.updatedBy?.id).toBe(owner.id);
    expect(read.completeness.filled).toBe(3);
    await expectHfos(
      () => run(knowledgeProfileUpdate, { workspaceId: wsId, profile: {} }, member),
      'forbidden',
    );
  });
});

describe('items', () => {
  it('creates, edits, publishes and archives items; members only read', async () => {
    const faq = await create({
      kind: 'faq',
      question: 'Do you offer financing?',
      answer: 'Yes, 12 months same as cash.',
      tags: ['billing'],
    });
    expect(faq.status).toBe('draft');
    const edited = await run(
      knowledgeItemUpdate,
      {
        workspaceId: wsId,
        itemId: faq.itemId,
        content: {
          kind: 'faq',
          question: 'Do you offer financing?',
          answer: 'Yes, through our lending partner.',
          tags: ['billing', 'money'],
        },
      },
      owner,
    );
    expect([...edited.updated].sort()).toEqual(['body', 'tags']);
    const ref = { workspaceId: wsId, itemId: faq.itemId };
    expect((await run(knowledgeItemPublish, ref, owner)).status).toBe('published');
    expect((await item(faq.itemId)).item).toMatchObject({
      kind: 'faq',
      title: 'Do you offer financing?',
      body: 'Yes, through our lending partner.',
      tags: ['billing', 'money'],
      status: 'published',
      source: 'manual',
      createdBy: { id: owner.id },
      updatedBy: { id: owner.id },
    });
    expect((await run(knowledgeItemArchive, ref, owner)).status).toBe('archived');
    const listed = await ask(knowledgeItemList, { workspaceId: wsId }, member);
    expect(listed.items.map((i) => i.id)).not.toContain(faq.itemId);
    expect(listed.counts.archived).toBe(1);
    const archived = await ask(
      knowledgeItemList,
      { workspaceId: wsId, status: ['archived'] },
      member,
    );
    expect(archived.items.map((i) => i.id)).toEqual([faq.itemId]);

    await expectHfos(() => create({ kind: 'fact', title: 'Empty', body: '' }), 'validation', 400);
    await expectHfos(
      () =>
        run(
          knowledgeItemUpdate,
          { ...ref, content: { kind: 'document', title: 'Now a document', body: 'Text' } },
          owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          knowledgeItemCreate,
          { workspaceId: wsId, content: { kind: 'fact', title: 'Hours', body: '8 to 5' } },
          member,
        ),
      'forbidden',
    );
  });

  it('imports FAQs, skipping questions it already has, and names bad rows', async () => {
    await create({ kind: 'faq', question: 'Are you licensed?', answer: 'Yes, TACLA #12345.' });
    const out = await run(
      knowledgeItemImportFaqs,
      {
        workspaceId: wsId,
        rows: [
          {
            question: 'What areas do you serve?',
            answer: 'Houston and nearby.',
            tags: ['area', ' area '],
          },
          { question: 'ARE you   licensed?', answer: 'Yes.' },
          { question: 'What areas do you serve?', answer: 'Everywhere.' },
        ],
        status: 'published',
      },
      owner,
    );
    expect(out.created).toBe(1);
    expect(out.skipped.map((s) => s.row)).toEqual([1, 2]);
    expect((await item(out.itemIds[0]!)).item).toMatchObject({
      title: 'What areas do you serve?',
      status: 'published',
      tags: ['area'],
    });
    const bad = await expectHfos(
      () =>
        run(
          knowledgeItemImportFaqs,
          {
            workspaceId: wsId,
            rows: [
              { question: 'Fine?', answer: 'Yes.' },
              { question: '', answer: 'No question here.' },
            ],
          },
          owner,
        ),
      'validation',
      400,
    );
    expect((bad.details as { path: string }[]).map((d) => d.path)).toContain('rows.1.question');
  });
});

describe('suggestions', () => {
  it('groups similar gaps; accepting creates an item, rejecting adds nothing', async () => {
    const proposed = await runSystem(
      knowledgeSuggestionPropose,
      {
        workspaceId: wsId,
        suggestions: [
          { reason: 'gap', question: 'Do you offer weekend appointments?' },
          { reason: 'gap', question: 'do you offer appointments on the weekend' },
          {
            reason: 'pack',
            content: { kind: 'fact', title: 'Warranty', body: 'Parts are covered for 10 years.' },
            packId: randomUUID(),
            version: 1,
          },
        ],
      },
      scope,
    );
    expect(proposed).toMatchObject({ created: 2, grouped: 1 });
    await expectHfos(
      () =>
        run(
          knowledgeSuggestionPropose,
          { workspaceId: wsId, suggestions: [{ reason: 'gap', question: 'Hi?' }] },
          owner,
        ),
      'forbidden',
    );

    const pending = await ask(knowledgeSuggestionList, { workspaceId: wsId }, member);
    const gap = pending.items.find((s) => s.reason === 'gap')!;
    expect(gap).toMatchObject({
      kind: 'faq',
      similarCount: 2,
      proposed: { title: 'Do you offer weekend appointments?', body: '' },
    });
    await expectHfos(
      () => run(knowledgeSuggestionAccept, { workspaceId: wsId, suggestionId: gap.id }, owner),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          knowledgeSuggestionAccept,
          { workspaceId: wsId, suggestionId: gap.id, edits: { body: 'Yes.' } },
          member,
        ),
      'forbidden',
    );
    const accepted = await run(
      knowledgeSuggestionAccept,
      { workspaceId: wsId, suggestionId: gap.id, edits: { body: 'Yes, Saturdays 9 to 1.' } },
      owner,
    );
    expect(accepted.created).toBe(true);
    expect((await item(accepted.itemId)).item).toMatchObject({
      kind: 'faq',
      title: 'Do you offer weekend appointments?',
      body: 'Yes, Saturdays 9 to 1.',
      status: 'published',
      source: 'ai_suggestion',
    });
    await expectHfos(
      () =>
        run(
          knowledgeSuggestionAccept,
          { workspaceId: wsId, suggestionId: gap.id, edits: { body: 'Again' } },
          owner,
        ),
      'suggestion_decided',
      409,
    );
    const pack = pending.items.find((s) => s.reason === 'pack')!;
    expect(
      await run(knowledgeSuggestionReject, { workspaceId: wsId, suggestionId: pack.id }, owner),
    ).toEqual({ suggestionId: pack.id, status: 'rejected' });
    expect((await ask(knowledgeSuggestionList, { workspaceId: wsId }, member)).items).toEqual([]);
  });
});

describe('search', () => {
  it('ranks a title match above a text match and finds published items only', async () => {
    const inTitle = await create(
      {
        kind: 'faq',
        question: 'Do you install tankless water heaters?',
        answer: 'We install and service most brands.',
      },
      'published',
    );
    const inBody = await create(
      {
        kind: 'article',
        title: 'Our plumbing services',
        body: 'Besides drains and leaks, we also fit tankless water heaters in homes and small offices.',
      },
      'published',
    );
    const draft = await create(
      {
        kind: 'fact',
        title: 'Tankless water heater prices',
        body: 'Tankless water heaters start at $2,000.',
      },
      'draft',
    );
    const found = await ask(
      knowledgeSearch,
      { workspaceId: wsId, query: 'tankless water heaters' },
      member,
    );
    const ids = found.matches.map((m) => m.id);
    expect(ids).toContain(inTitle.itemId);
    expect(ids).toContain(inBody.itemId);
    expect(ids).not.toContain(draft.itemId);
    expect(ids.indexOf(inTitle.itemId)).toBeLessThan(ids.indexOf(inBody.itemId));
    expect(found.matches.find((m) => m.id === inBody.itemId)!.snippet).toContain('**tankless**');
    const withDrafts = await ask(
      knowledgeSearch,
      { workspaceId: wsId, query: 'tankless water heaters', includeDrafts: true },
      member,
    );
    expect(withDrafts.matches.map((m) => m.id)).toContain(draft.itemId);
    const onlyFaqs = await ask(
      knowledgeSearch,
      { workspaceId: wsId, query: 'tankless water heaters', kinds: ['faq'] },
      member,
    );
    expect(onlyFaqs.matches.map((m) => m.id)).toEqual([inTitle.itemId]);

    // Typos in a title still find it.
    const area = await create(
      { kind: 'fact', title: 'Service area', body: 'Harris County.' },
      'published',
    );
    const typo = await ask(knowledgeSearch, { workspaceId: wsId, query: 'servce area' }, member);
    expect(typo.matches.map((m) => m.id)).toContain(area.itemId);
    const filtered = await ask(
      knowledgeItemList,
      { workspaceId: wsId, search: 'tankless' },
      member,
    );
    expect(filtered.items.map((i) => i.id).sort()).toEqual(
      [inTitle.itemId, inBody.itemId, draft.itemId].sort(),
    );

    // AI steps record what they used.
    expect(
      await runSystem(
        knowledgeItemRecordUse,
        { workspaceId: wsId, itemIds: [inTitle.itemId] },
        scope,
      ),
    ).toEqual({ updated: 1 });
    const used = (await item(inTitle.itemId)).item;
    expect(used.useCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();
    await expectHfos(
      () => run(knowledgeItemRecordUse, { workspaceId: wsId, itemIds: [inTitle.itemId] }, owner),
      'forbidden',
    );
  });
});

describe('the website and documents', () => {
  it('stores one https website, queues one scan at a time, and shows its progress', async () => {
    await expectHfos(
      () => run(knowledgeScanStart, { workspaceId: wsId }, owner),
      'no_website',
      409,
    );
    for (const url of ['http://lonestar.example', 'https://localhost:3000', 'https://10.0.0.1'])
      await expectHfos(
        () => run(knowledgeSourceSet, { workspaceId: wsId, url }, owner),
        'website_url_invalid',
        400,
      );
    const set = await run(
      knowledgeSourceSet,
      { workspaceId: wsId, url: 'LoneStarHVAC.example/about/#team' },
      owner,
    );
    expect(set.url).toBe('https://lonestarhvac.example/about');
    const scan = await run(knowledgeScanStart, { workspaceId: wsId }, owner);
    await expectHfos(
      () => run(knowledgeScanStart, { workspaceId: wsId }, owner),
      'scan_running',
      409,
    );
    expect(await ask(knowledgeScanGet, { workspaceId: wsId }, member)).toMatchObject({
      source: { url: set.url },
      scan: { id: scan.scanId, status: 'queued', pendingSuggestions: 0 },
    });
    const [ev] = await eventsOf('knowledge_scan.requested');
    expect(ev!.payload).toMatchObject({ scanId: scan.scanId, url: set.url });
  });

  it('adds an uploaded PDF or text file for the engine to read', async () => {
    const personId = (
      await run(
        personCreate,
        { workspaceId: wsId, firstName: 'Paula', lastName: 'Customer', ignoreDuplicates: true },
        owner,
      )
    ).personId;
    const file = async (name: string, mime: string) =>
      (
        await rows<{ id: string }>(
          admin(),
          sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, status, created_by)
              values (${wsId}, 'person', ${personId}, ${`${wsId}/person/${personId}/${randomUUID()}`}, ${name}, ${mime},
                'ready', ${owner.id})
              returning id`,
        )
      )[0]!.id;
    const pdf = await file('Price list.pdf', 'application/pdf');
    expect(await run(knowledgeDocumentAdd, { workspaceId: wsId, fileId: pdf }, owner)).toEqual({
      fileId: pdf,
      requested: true,
    });
    const [ev] = await eventsOf('knowledge_document.added');
    expect(ev!.payload).toMatchObject({ fileId: pdf, title: 'Price list', kind: 'pdf' });
    const png = await file('Logo.png', 'image/png');
    await expectHfos(
      () => run(knowledgeDocumentAdd, { workspaceId: wsId, fileId: png }, owner),
      'unsupported_file_type',
      400,
    );
  });
});
