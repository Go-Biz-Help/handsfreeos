/**
 * Real Estate's closing pages on the phone (round six): a deal's financing, inspections and repairs, the client's
 * tasks, its contingencies, the readings of its contracts, its field notes and the walkthrough. The deal is built
 * through the add-on's commands; each view runs over what a phone is sent (realestate-phone-fixture.ts) and answers
 * what the server's query answers: whole for the deal's agent, and for an owner who sees every deal as its summary,
 * with what only the deal's people keep waiting for signal.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localDateOf } from '../../src/calendar/engine/zoned';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  clientTasksOfCopy,
  contingenciesOfCopy,
  contractReadsOfCopy,
  financingOfCopy,
  inspectionsOfCopy,
  type MessageLookup,
} from '../../src/addons/realestate/views/closing';
import { contractReadOfCopy } from '../../src/addons/realestate/views/contract-read';
import { fieldNotesOfCopy, walkthroughOfCopy } from '../../src/addons/realestate/views/field';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';
import { phoneCopy } from './realestate-phone-fixture';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (name: string, input: Record<string, unknown>, as: TestUser = agent): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(as),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>, as: TestUser): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(as), meta());
const system = (name: string, input: Record<string, unknown>): Promise<Any> => {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: org,
    onBehalfOf: null,
  };
  return executeCommand(
    worker(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
};
const asClient = (who: CustomerActor, name: string, input: Record<string, unknown>) =>
  executeCommand(worker(), op(name) as CommandDef, { workspaceId: ws, ...input }, who, {
    correlationId: randomUUID(),
    channel: 'portal' as const,
  }).then((r) => r.output);

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let timeZone: string;
let today: string;
let nguyen: string;
let owens: string;
let linh: string;
let tuan: string;
const day = (n: number) => addDays(today, n);

/** A file on a deal, uploaded by the agent. */
async function fileOn(dealId: string, name: string, mimeType = 'application/pdf'): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType,
      sizeBytes: 2048,
    },
    human(agent),
    meta(),
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId as string;
}

/** One of the deal's documents, of a kind. */
async function documentOn(kind: string, name: string, title?: string): Promise<string> {
  return (
    await run('realestate.document.add', {
      dealId: nguyen,
      fileId: await fileOn(nguyen, name),
      kind,
      ...(title ? { title } : {}),
    })
  ).documentId;
}

/** A client in their portal, signed in with the code they were sent. */
async function signIn(personId: string): Promise<CustomerActor> {
  const scope = { type: 'system' as const, workspaceId: ws, organizationId: org };
  const { accessId } = (
    await executeCommand(
      api(),
      portalAccessGive,
      { workspaceId: ws, personId },
      human(owner),
      meta(),
    )
  ).output;
  const sent = (
    await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, scope, meta())
  ).output;
  const hit = (
    await executeCommand(
      worker(),
      portalCheckCode,
      {
        workspaceId: ws,
        accessId,
        code: sent.code,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      },
      scope,
      meta(),
    )
  ).output;
  return {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId,
    sessionId: hit.sessionId!,
  };
}

/** The messages in a person's Inbox on their phone, as financing names a step's proof. */
async function inboxOf(u: TestUser): Promise<MessageLookup> {
  const found = await asUser(api(), u.claims, (tx) =>
    rows<{ id: string; subject: string | null; counterpart: string }>(
      tx,
      sql`select m.id, m.subject, c.counterpart from app.messages m
          join app.conversations c on c.id = m.conversation_id
          where m.workspace_id = ${ws} and m.sync_window and m.channel <> 'portal'`,
    ),
  );
  const byId = new Map(found.map((m) => [m.id, m]));
  return (id) => byId.get(id) ?? null;
}

/** Each person and deal looked at: the agent on theirs, the owner on the agent's (a summary) and on their own. */
const looks = () =>
  [
    { u: agent, dealId: nguyen, whole: true },
    { u: owner, dealId: nguyen, whole: false },
    { u: owner, dealId: owens, whole: true },
  ] as const;

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rpc-owner', { fullName: 'Rosa Owens' }),
    createTestUser('rpc-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Phone Closing Realty');
  const [w] = await rows<{ org: string; tz: string }>(
    admin(),
    sql`select organization_id as org, timezone as tz from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  timeZone = w!.tz;
  today = localDateOf(Date.now(), timeZone);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const person = async (firstName: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        {
          workspaceId: ws,
          firstName,
          lastName: 'Nguyen',
          email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
        },
        human(agent),
        meta(),
      )
    ).output.personId as string;
  linh = await person('Linh');
  tuan = await person('Tuan');
  nguyen = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: linh,
      stage: 'under_contract',
      newPropertyAddress: '2207 Juniper Trail',
    })
  ).dealId;
  await run('realestate.party.add', { dealId: nguyen, role: 'client', personId: tuan });
  owens = (await run('realestate.deal.open', { side: 'buyer', name: 'Owens purchase' }, owner))
    .dealId;

  // Its dates: closing in a month, the inspection period ending in five days, financing ended yesterday.
  await run('realestate.term.enter', { dealId: nguyen, key: 'closing', date: day(30) });
  await run('realestate.term.enter', {
    dealId: nguyen,
    key: 'price',
    cents: 41_500_000,
    confirm: false,
  });
  await run('realestate.term.enter', { dealId: nguyen, key: 'inspection_end', date: day(5) });
  await run('realestate.term.enter', {
    dealId: nguyen,
    key: 'financing_end',
    date: day(-1),
    source: 'contract',
  });

  // Financing: the lender, an appraisal under way, and steps proved by a document, a file and two emails.
  await run('realestate.financing.set_lender', {
    dealId: nguyen,
    lenderName: 'Hill Country Lending',
    officerName: 'Jo Park',
    officerEmail: 'jo@hillcountry.example',
    officerPhone: '512-555-0142',
    loanType: 'conventional',
    loanAmountCents: 33_200_000,
  });
  await run('realestate.financing.update_step', {
    dealId: nguyen,
    step: 'appraisal',
    startedOn: day(1),
    expectedOn: day(8),
  });
  await run('realestate.financing.mark_done', {
    dealId: nguyen,
    step: 'rate_lock',
    proof: { kind: 'document', id: await documentOn('rate_lock', 'Lock confirmation.pdf') },
    rate: 6.125,
    expiresOn: day(25),
  });
  await run('realestate.financing.mark_done', {
    dealId: nguyen,
    step: 'preapproval',
    proof: { kind: 'file', id: await fileOn(nguyen, 'Preapproval letter.pdf') },
    amountCents: 45_000_000,
    expiresOn: day(60),
  });
  const [thread] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.conversations (workspace_id, channel, counterpart)
        values (${ws}, 'email', 'jo@hillcountry.example') returning id`,
  );
  const message = async (subject: string | null) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, subject, body_text)
            values (${ws}, ${thread!.id}, 'email', 'inbound', 'received', ${subject}, 'See attached.')
            returning id`,
      )
    )[0]!.id;
  await run('realestate.financing.mark_done', {
    dealId: nguyen,
    step: 'application',
    proof: { kind: 'message', id: await message('  Your application is in  ') },
  });
  await run('realestate.financing.mark_done', {
    dealId: nguyen,
    step: 'conditional_approval',
    proof: { kind: 'message', id: await message(null) },
    note: 'Two conditions: pay stubs and a gift letter.',
  });

  // Inspections: a general one with its report and findings, and a termite one canceled.
  const general = (
    await run('realestate.inspection.add', {
      dealId: nguyen,
      kind: 'general',
      inspector: 'Lone Star Inspections',
      scheduledAt: `${day(2)}T14:00:00Z`,
      reportExpectedOn: day(3),
    })
  ).inspectionId;
  for (const f of [
    {
      title: 'Water heater past its life',
      location: 'Garage',
      severity: 'safety',
      estimateCents: 140_000,
      clientPriority: 'must_fix',
      ask: 'replace',
      // Photographed at the inspection (board 85).
      photoFileIds: [
        await fileOn(nguyen, 'water-heater.jpg', 'image/jpeg'),
        await fileOn(nguyen, 'water-heater-label.jpg', 'image/jpeg'),
      ],
    },
    {
      title: 'Roof flashing loose',
      location: 'Chimney',
      severity: 'repair',
      estimateCents: 60_000,
      clientPriority: 'would_like',
      ask: 'credit',
      note: 'Roofer can come Monday.',
    },
    { title: 'Worn weather stripping', severity: 'minor', clientPriority: 'skip' },
  ])
    await run('realestate.finding.add', { inspectionId: general, ...f });
  await run('realestate.inspection.report_in', {
    inspectionId: general,
    documentId: await documentOn('inspection_report', 'General inspection.pdf'),
    pages: 41,
  });
  const termite = (await run('realestate.inspection.add', { dealId: nguyen, kind: 'termite' }))
    .inspectionId;
  await run('realestate.finding.add', {
    inspectionId: termite,
    title: 'Old termite damage',
    severity: 'repair',
    clientPriority: 'must_fix',
    ask: 'repair',
  });
  await run('realestate.inspection.cancel', {
    inspectionId: termite,
    reason: 'The general inspector covered it',
  });
  const draft = (await ask('realestate.inspections', { dealId: nguyen }, agent)).draft;
  await run('realestate.repair.send', {
    dealId: nguyen,
    words: draft.words,
    respondBy: `${day(4)}T22:00:00Z`,
  });
  await run('realestate.repair.record_answer', {
    dealId: nguyen,
    outcome: 'agreed',
    words: 'Seller will replace the water heater and credit $600.',
    creditCents: 60_000,
  });

  // The client's tasks: Linh signs in and does hers; Tuan is invited and hasn't.
  const task = async (input: Record<string, unknown>) =>
    (await run('realestate.client_task.add', { dealId: nguyen, ...input })).taskId as string;
  const preapproval = await task({ preset: 'preapproval', forPersonId: linh });
  const signOff = await task({ preset: 'repair_sign_off' });
  const photo = await task({ preset: 'photo_id', forPersonId: tuan });
  const insurance = await task({
    kind: 'do',
    title: 'Set up homeowners insurance',
    dueOn: day(20),
  });
  await run('realestate.client_task.cancel', { taskId: photo, reason: 'Seen at the office' });
  const linhInPortal = await signIn(linh);
  await executeCommand(
    api(),
    portalAccessGive,
    { workspaceId: ws, personId: tuan },
    human(owner),
    meta(),
  );
  const words = (await ask('realestate.client_tasks', { dealId: nguyen }, agent)).tasks.find(
    (t: { id: string }) => t.id === signOff,
  ).signOffWords;
  await asClient(linhInPortal, 'realestate.portal.task.complete', {
    taskId: signOff,
    signedWords: words,
  });
  const [theirs] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, name, mime_type, size_bytes, status,
          object_path, uploaded_by_person_id)
        values (${ws}, 'custom_record', ${nguyen}, 'Linh preapproval.pdf', 'application/pdf', 2048, 'ready',
          ${`${ws}/${randomUUID()}`}, ${linh})
        returning id`,
  );
  await asClient(linhInPortal, 'realestate.portal.task.attach', {
    taskId: preapproval,
    fileId: theirs!.id,
  });
  await run('realestate.client_task.mark_done', {
    taskId: insurance,
    personId: tuan,
    note: 'Sent the policy by email',
    fileId: await fileOn(nguyen, 'Insurance binder.pdf'),
  });

  // Contingencies: inspection and financing from their dates, one the contract names; two recorded.
  await run('realestate.contingency.add', {
    dealId: nguyen,
    kind: 'other',
    label: 'Sale of the buyers’ condo',
    endsOn: day(40),
  });
  const { contingencies } = await ask('realestate.contingencies', { dealId: nguyen }, agent);
  const byKind = (k: string) => contingencies.find((c: { kind: string }) => c.kind === k).id;
  await run('realestate.contingency.resolve', {
    contingencyId: byKind('inspection'),
    how: 'waived',
    documentId: await documentOn('other', 'option-removal.pdf', 'Option removal, signed'),
    note: 'No repairs beyond the agreement.',
  });
  await run(
    'realestate.contingency.resolve',
    {
      contingencyId: byKind('financing'),
      how: 'satisfied',
      reason: 'Loan approval letter is in the lender’s portal.',
    },
    owner,
  );

  // The contract, read with one value confirmed; an amendment still being read.
  const contract = await documentOn('contract', 'nguyen-contract.pdf', 'Nguyen contract');
  const [read] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.contract_reads where document_id = ${contract}`,
  );
  const value = (key: string, more: Record<string, unknown>) => ({
    key,
    date: null,
    cents: null,
    text: null,
    worked: null,
    clause: null,
    page: 1,
    quote: `The ${key} words`,
    ...more,
  });
  await system('realestate.contract.read_done', {
    readId: read!.id,
    values: [
      value('price', { cents: 41_200_000, clause: '§3C' }),
      value('closing', { date: day(31), clause: '§9A', page: 5 }),
      value('inspection_end', { date: day(6), clause: '§5B', page: 2 }),
    ],
    unclear: [{ what: 'Survey: within a reasonable time', quote: null, page: 3, clause: '§6C' }],
    scan: true,
    pages: 9,
    model: 'scripted',
  });
  const found = await ask('realestate.contract.read', { readId: read!.id }, agent);
  await run('realestate.contract.confirm', {
    readId: read!.id,
    valueIds: [found.values.find((v: { key: string }) => v.key === 'price').id],
  });
  await documentOn('amendment', 'amendment-1.pdf', 'Amendment 1');

  // Field notes: typed, spoken (its words in) and photographed.
  await run('realestate.field_note.add', {
    dealId: nguyen,
    id: randomUUID(),
    body: 'Sellers leaving the shed; ask about the permit.',
  });
  const spoken = randomUUID();
  await run('realestate.field_note.add', {
    dealId: nguyen,
    id: spoken,
    audioFileId: await fileOn(nguyen, 'Note at the house.m4a', 'audio/mp4'),
  });
  await system('realestate.field_note.transcribed', {
    noteId: spoken,
    transcript: 'Roof looks newer than the listing says.',
  });
  await run('realestate.field_note.add', {
    dealId: nguyen,
    id: randomUUID(),
    aboutKind: 'walkthrough',
    photoFileIds: [await fileOn(nguyen, 'Back fence.jpg', 'image/jpeg')],
  });
}, 240_000);

afterAll(closeTestDbs);

describe('financing on the phone', () => {
  it('answers what the server answers: the lender, each step and its proof, and the Closing Disclosure’s day', async () => {
    for (const { u, dealId, whole } of looks()) {
      const server = await ask('realestate.financing', { dealId }, u);
      const view = financingOfCopy(await phoneCopy(u, ws), dealId, {
        userId: u.id,
        messages: await inboxOf(u),
      });
      expect(view, `${u.email} ${dealId}`).not.toBeNull();
      const { full, ...shown } = view!;
      expect(full).toBe(whole);
      if (whole) expect(shown).toEqual(server);
      else
        // Kept as a summary: its dates, not its loan.
        expect(shown).toEqual({
          ...server,
          lender: {
            lenderName: null,
            officerName: null,
            officerEmail: null,
            officerPhone: null,
            loanType: null,
            loanAmountCents: null,
          },
          steps: [],
        });
    }
  });

  it('isn’t equal by being empty, and names an email it doesn’t keep “Message”', async () => {
    const copy = await phoneCopy(agent, ws);
    const view = financingOfCopy(copy, nguyen, {
      userId: agent.id,
      messages: await inboxOf(agent),
    })!;
    const byStep = Object.fromEntries(view.steps.map((s) => [s.step, s]));
    expect(view.lender.lenderName).toBe('Hill Country Lending');
    expect(view.cdDeadline).not.toBeNull();
    expect(byStep.rate_lock).toMatchObject({
      status: 'done',
      rate: 6.125,
      warning: 'The lock ends before closing',
      proof: { kind: 'document', label: 'Lock confirmation.pdf' },
      doneBy: { fullName: 'Dana Reyes' },
    });
    expect(byStep.preapproval!.proof!.label).toBe('Preapproval letter.pdf');
    expect(byStep.application!.proof!.label).toBe('Your application is in');
    expect(byStep.conditional_approval!.proof!.label).toBe('Message from jo@hillcountry.example');
    expect(byStep.appraisal).toMatchObject({ status: 'in_progress', proof: null });
    // With no Inbox on the phone, the emails wait for signal for their names.
    const bare = financingOfCopy(copy, nguyen, { userId: agent.id })!;
    expect(bare.steps.find((s) => s.step === 'application')!.proof!.label).toBe('Message');
    // A deal the phone doesn't hold.
    expect(financingOfCopy(copy, randomUUID(), { userId: agent.id })).toBeNull();
  });
});

describe('inspections on the phone', () => {
  it('answer what the server answers: each inspection and its findings, the repairs and the draft', async () => {
    for (const { u, dealId, whole } of looks()) {
      const server = await ask('realestate.inspections', { dealId }, u);
      const { full, ...shown } = inspectionsOfCopy(await phoneCopy(u, ws), dealId, {
        userId: u.id,
      })!;
      expect(full, `${u.email} ${dealId}`).toBe(whole);
      if (whole) expect(shown).toEqual(server);
      else
        expect(shown).toEqual({
          ...server,
          inspections: [],
          repairs: [],
          draft: { words: '', creditCents: 0, items: 0 },
        });
    }
  });

  it('isn’t equal by being empty', async () => {
    const view = inspectionsOfCopy(await phoneCopy(agent, ws), nguyen, { userId: agent.id })!;
    expect(view.periodEnds).toBe(day(5));
    expect(view.inspections.map((i) => [i.label, i.status, i.findings.length])).toEqual([
      ['General inspection', 'report_in', 3],
      ['Termite', 'canceled', 1],
    ]);
    expect(view.inspections[0]!.reportDocument!.title).toBe('General inspection.pdf');
    // The water heater's two photos come with it.
    expect(view.inspections[0]!.findings.map((f) => f.photoFileIds.length)).toEqual([2, 0, 0]);
    expect(view.repairs.map((r) => [r.side, r.outcome, r.items.length])).toEqual([
      ['us', null, 2],
      ['them', 'agreed', 0],
    ]);
    // The canceled inspection's finding stays out of the draft.
    expect(view.draft).toMatchObject({ items: 2, creditCents: 60_000 });
  });
});

describe('the client’s tasks on the phone', () => {
  it('answer what the server answers, with or without the ones taken back', async () => {
    for (const { u, dealId, whole } of looks()) {
      const copy = await phoneCopy(u, ws);
      for (const includeCanceled of [false, true]) {
        const server = await ask('realestate.client_tasks', { dealId, includeCanceled }, u);
        const { full, ...shown } = clientTasksOfCopy(copy, dealId, {
          userId: u.id,
          includeCanceled,
        })!;
        expect(full, `${u.email} ${dealId}`).toBe(whole);
        // On a summary: the clients and their portal, not their tasks.
        expect(shown).toEqual(whole ? server : { ...server, tasks: [] });
      }
    }
  });

  it('isn’t equal by being empty', async () => {
    const view = clientTasksOfCopy(await phoneCopy(agent, ws), nguyen, {
      userId: agent.id,
      includeCanceled: true,
    })!;
    expect(view.clients.map((c) => [c.name, c.portal, c.portalSince !== null])).toEqual([
      ['Linh Nguyen', 'signed_in', true],
      ['Tuan Nguyen', 'invited', true],
    ]);
    expect(view.tasks.map((t) => [t.kind, t.status, t.waiting])).toEqual([
      ['upload', 'done', null],
      ['sign_off', 'open', 'Waiting on Tuan'],
      ['upload', 'canceled', null],
      ['do', 'done', null],
    ]);
    const [upload, , , insurance] = view.tasks;
    expect(upload!.completions[0]).toMatchObject({
      name: 'Linh Nguyen',
      file: { name: 'Linh preapproval.pdf' },
      recordedBy: null,
    });
    expect(insurance!.completions[0]).toMatchObject({
      name: 'Tuan Nguyen',
      file: { name: 'Insurance binder.pdf' },
      recordedBy: { fullName: 'Dana Reyes' },
      note: 'Sent the policy by email',
    });
  });
});

describe('contingencies on the phone', () => {
  it('answer what the server answers, less whether the person may skip the form', async () => {
    for (const { u, dealId, whole } of looks()) {
      const { can: _can, ...server } = await ask('realestate.contingencies', { dealId }, u);
      const { full, ...shown } = contingenciesOfCopy(await phoneCopy(u, ws), dealId, {
        userId: u.id,
        now: Date.now(),
        timeZone,
      })!;
      expect(full, `${u.email} ${dealId}`).toBe(whole);
      expect(shown).toEqual(whole ? server : { ...server, contingencies: [] });
    }
  });

  it('isn’t equal by being empty', async () => {
    const view = contingenciesOfCopy(await phoneCopy(agent, ws), nguyen, {
      userId: agent.id,
      now: Date.now(),
      timeZone,
    })!;
    expect(view.contingencies.map((c) => [c.label, c.state, c.clock])).toEqual(
      expect.arrayContaining([
        ['Inspection', 'waived', 'open'],
        ['Financing', 'satisfied', 'open'],
        ['Sale of the buyers’ condo', 'open', 'open'],
      ]),
    );
    const byLabel = Object.fromEntries(view.contingencies.map((c) => [c.label, c]));
    expect(byLabel.Inspection).toMatchObject({
      document: { title: 'Option removal, signed' },
      resolvedByName: 'Dana Reyes',
    });
    expect(byLabel.Financing).toMatchObject({
      document: null,
      resolvedByName: 'Rosa Owens',
      overrideReason: 'Loan approval letter is in the lender’s portal.',
    });
  });
});

describe('contract readings on the phone', () => {
  it('answer what the server answers, newest first', async () => {
    for (const { u, dealId, whole } of looks()) {
      const server = await ask('realestate.contract.reads', { dealId }, u);
      const { full, ...shown } = contractReadsOfCopy(await phoneCopy(u, ws), dealId, {
        userId: u.id,
      })!;
      expect(full, `${u.email} ${dealId}`).toBe(whole);
      expect(shown).toEqual(whole ? server : { reads: [] });
    }
    const { reads } = contractReadsOfCopy(await phoneCopy(agent, ws), nguyen, {
      userId: agent.id,
    })!;
    expect(reads.map((r) => [r.documentTitle, r.state, r.waiting, r.confirmed, r.unclear])).toEqual(
      [
        ['Amendment 1', 'reading', 0, 0, 0],
        ['Nguyen contract', 'read', 2, 1, 1],
      ],
    );
    expect(reads[1]!.scan).toBe(true);
  });

  it('answer one reading as the server does: each value with its page, and what a person must look at', async () => {
    const { reads } = await ask('realestate.contract.reads', { dealId: nguyen }, agent);
    for (const r of reads as { readId: string }[]) {
      const {
        values,
        moves: _m,
        problems: _p,
        newerReadId: _n,
        ...server
      } = await ask('realestate.contract.read', { readId: r.readId }, agent);
      const { fileName, version, ...phone } = contractReadOfCopy(
        await phoneCopy(agent, ws),
        nguyen,
        r.readId,
        { userId: agent.id },
      )!;
      expect(phone).toEqual({
        ...server,
        values: values.map(({ now: _now, nowFrom: _from, same: _same, ...v }: Any) => v),
      });
      expect(fileName).toMatch(/\.pdf$/);
      expect(version).toBe(1);
    }
    const read = contractReadOfCopy(await phoneCopy(agent, ws), nguyen, reads[1].readId, {
      userId: agent.id,
    })!;
    expect(read.values.map((v) => [v.label, v.state, v.page, v.clause])).toEqual([
      ['Purchase price', 'confirmed', 1, '§3C'],
      ['Closing', 'waiting', 5, '§9A'],
      ['Inspection period ends', 'waiting', 2, '§5B'],
    ]);
    expect(read.unclear.map((u) => u.what)).toEqual(['Survey: within a reasonable time']);
    // Not on the deal: the owner's phone keeps no readings of it.
    expect(
      contractReadOfCopy(await phoneCopy(owner, ws), nguyen, reads[1].readId, {
        userId: owner.id,
      }),
    ).toBeNull();
  });
});

describe('field notes on the phone', () => {
  it('answer what the server answers, newest first, for each filter', async () => {
    const filters = [{}, { aboutKind: 'deal' as const }, { aboutKind: 'walkthrough' as const }];
    for (const { u, dealId, whole } of looks()) {
      const copy = await phoneCopy(u, ws);
      for (const f of filters) {
        const server = await ask('realestate.field_notes', { dealId, ...f }, u);
        const { full, ...shown } = fieldNotesOfCopy(copy, dealId, f, { userId: u.id })!;
        expect(full, `${u.email} ${dealId} ${JSON.stringify(f)}`).toBe(whole);
        expect(shown).toEqual(whole ? server : { notes: [] });
      }
    }
    const { notes } = fieldNotesOfCopy(
      await phoneCopy(agent, ws),
      nguyen,
      {},
      { userId: agent.id },
    )!;
    expect(notes.map((n) => [n.aboutKind, n.transcriptState, n.photoFileIds.length])).toEqual([
      ['walkthrough', 'none', 1],
      ['deal', 'done', 0],
      ['deal', 'none', 0],
    ]);
    expect(notes[1]!.transcript).toBe('Roof looks newer than the listing says.');
  });
});

describe('the walkthrough on the phone', () => {
  const same = async () => {
    for (const { u, dealId, whole } of looks()) {
      const server = await ask('realestate.walkthrough', { dealId }, u);
      const { full, ...shown } = walkthroughOfCopy(await phoneCopy(u, ws), dealId, {
        userId: u.id,
      })!;
      expect(full, `${u.email} ${dealId}`).toBe(whole);
      expect(shown).toEqual(whole ? server : { walkthrough: null });
    }
    return walkthroughOfCopy(await phoneCopy(agent, ws), nguyen, { userId: agent.id })!.walkthrough;
  };

  it('answers what the server answers as it’s planned, checked, finished and planned again', async () => {
    expect(await same()).toBeNull();
    const first = randomUUID();
    await run('realestate.walkthrough.plan', { dealId: nguyen, id: first });
    const planned = (await same())!;
    expect(planned).toMatchObject({ id: first, state: 'planned' });
    expect(planned.items[0]).toMatchObject({
      source: 'repair',
      title: 'Water heater past its life',
    });

    const photo = await fileOn(nguyen, 'Water heater.jpg', 'image/jpeg');
    for (const [n, i] of planned.items.entries())
      await run('realestate.walkthrough.check_item', {
        itemId: i.id,
        state: n === 0 ? 'not_ok' : 'ok',
        ...(n === 0 ? { note: 'Old heater still in.', photoFileIds: [photo] } : {}),
      });
    await run('realestate.walkthrough.add_item', {
      walkthroughId: first,
      id: randomUUID(),
      title: 'Garage door opener remotes',
    });
    const checked = (await same())!;
    expect(checked.state).toBe('started');
    expect(checked.items.at(-1)).toMatchObject({ source: 'added', state: 'unchecked' });
    expect(checked.items[0]).toMatchObject({ state: 'not_ok', photoFileIds: [photo] });

    await run('realestate.walkthrough.finish', { walkthroughId: first, clientsAgreed: true });
    const done = (await same())!;
    expect(done.state).toBe('done');
    expect(done.items[0]!.dutyId).toBeTruthy();

    // A new one planned: the one not finished comes first.
    const second = randomUUID();
    await run('realestate.walkthrough.plan', { dealId: nguyen, id: second });
    expect(await same()).toMatchObject({ id: second, state: 'planned' });
  });
});
