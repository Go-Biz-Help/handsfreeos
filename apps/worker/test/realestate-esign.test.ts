/**
 * Real Estate Agent, round five, step 7, in the worker: a deal's document sent for signing through the brokerage's
 * DocuSign or Dotloop, against the stand-in e-signature service (ADDON_CONNECTORS=fake).
 *
 * - DocuSign: made as a draft, opened on its sending page, sent, signed; the signed copy comes back as the
 *   document's newer version, signed and locked, with the certificate beside it. Its updates are read back, never
 *   trusted, and the check looks at what's still open.
 * - Dotloop: put in a loop to open; it says nothing about signing, so “It's signed” fetches the copy.
 * - Voided here, it's voided there; a decline says so; what can't be sent says why.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  ADDON_CATALOG,
  ADDON_SERVER_MODULES,
  catalogAddon,
  createTokenVerifier,
  executeCommand,
  executeQuery,
  type CommandDef,
  type HfosError,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { connectionById } from '../src/addons/connections';
import { addonScope } from '../src/addons/context';
import { addonJobs, withAddons } from '../src/addons/index';
import {
  DOCUSIGN_UPDATES,
  ESIGN_ACTIONS,
  ESIGN_CHECK,
  resetStandinEsign,
  standinAct,
  standinEnvelope,
  useEsignFetch,
} from '../src/addons/realestate/esign/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';
import { textPdf } from './pdf-maker';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('it went through');
    },
    (e: HfosError) => e,
  );

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let app: FastifyInstance;
let agent: TestUser;
let token: string;
let ws: string;
let org: string;
let deal: string;

async function drain(services: TestServices = s) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-esign-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...services,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind <> 'realestate.sweep'`,
    );
    const done = await processJobs({
      ...services,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

const scope = () =>
  addonScope(
    s,
    catalogAddon('realestate'),
    { workspaceId: ws, organizationId: org },
    1,
    workerMeta(),
  );

/** A PDF on the deal, as the files screen leaves it, made one of its documents. */
async function documentOf(title: string, kind = 'buyer_agreement', mimeType = 'application/pdf') {
  const fileId = randomUUID();
  const name = `${title}.pdf`;
  const path = `${ws}/custom_record/${deal}/${fileId}/${name.replace(/[^\w.-]+/g, '_')}`;
  const bytes = textPdf([[title, 'Buyer: Pat Buyer', 'Signature: ____________']]);
  await s.store.upload('attachments', path, bytes, mimeType);
  await rows(
    admin(),
    sql`insert into app.files (id, workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes,
          status, created_by)
        values (${fileId}, ${ws}, 'custom_record', ${deal}, ${path}, ${name}, ${mimeType}, ${bytes.length},
          'ready', ${agent.id})`,
  );
  return (await run('realestate.document.add', { dealId: deal, fileId, kind, title })).documentId;
}

const connect = (provider: 'docusign' | 'dotloop') =>
  executeCommand(
    testDbs().worker.db,
    addonConnectionCommands(ADDON_CATALOG).save,
    {
      workspaceId: ws,
      addonId: 'realestate',
      connector: 'esign',
      provider,
      auth: 'oauth',
      label: `Stand-in ${provider} account`,
      accountRef: null,
      details: {},
      secretEnc: s.sealer.seal(JSON.stringify({ accessToken: 'a', refreshToken: 'r' })),
      keyId: s.sealer.keyId,
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      connectedBy: agent.id,
    },
    { type: 'system', workspaceId: ws, organizationId: org, onBehalfOf: agent.id },
    meta(),
  );

const SIGNERS = [
  { name: 'Pat Buyer', email: 'pat@example.com' },
  { name: 'Lee Buyer', email: 'lee@example.com' },
];
const envelopeOf = async (id: string) =>
  (await ask('realestate.esign.list', { dealId: deal })).envelopes.find((e: Any) => e.id === id);
const externalOf = async (id: string) =>
  (
    await rows<{ external_id: string }>(
      admin(),
      sql`select external_id from addon_realestate.esign_envelopes where id = ${id}`,
    )
  )[0]!.external_id;
const documents = () =>
  ask('realestate.document.list', { dealId: deal }).then((r: Any) => r.documents);
const action = (name: string, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/addons/realestate/actions/${name}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, input },
  });
const path = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

beforeAll(async () => {
  resetStandinEsign();
  s = testServices();
  agent = await createTestUser('esign-agent', { fullName: 'Robin Park' });
  ws = await realestateBusiness(agent, 'Signing Realty');
  [{ organization_id: org }] = (await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  )) as [{ organization_id: string }];
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Buyer Park purchase',
    })
  ).dealId;
  const env = testEnv();
  app = await buildHttpServer({
    ...s,
    addonConnect: { fake: true, platformKeys: {} },
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    testRoutes: { jobs },
  });
  token = await signInTestUser(agent);
}, 120_000);
afterAll(async () => {
  resetStandinEsign();
  await app?.close();
  await closeTestDbs();
});

describe('sending a document for signing', () => {
  it('says what to do when nothing is connected, or it can’t go', async () => {
    const doc = await documentOf('Buyer agreement');
    const none = await refusal(
      run('realestate.esign.prepare', { documentId: doc, signers: SIGNERS }),
    );
    expect(none).toMatchObject({ rule: 'realestate_no_esign' });
    expect(none.message).toMatch(/Real Estate → Settings → Connections/);
    await connect('docusign');
    const twice = await refusal(
      run('realestate.esign.prepare', {
        documentId: doc,
        signers: [SIGNERS[0], { name: 'Pat again', email: 'PAT@example.com' }],
      }),
    );
    expect(JSON.stringify(twice.details)).toMatch(/PAT@example.com is on the list twice/);
    const word = await documentOf('Inspection notes', 'other', 'text/plain');
    expect(
      await refusal(run('realestate.esign.prepare', { documentId: word, signers: SIGNERS })),
    ).toMatchObject({ rule: 'realestate_esign_pdf' });
  });

  it('DocuSign: made as a draft, opened, sent and signed; the signed copy and certificate come back locked', async () => {
    const [doc] = (await documents()).filter((d: Any) => d.title === 'Buyer agreement');
    const made = await run('realestate.esign.prepare', {
      documentId: doc.documentId,
      signers: SIGNERS,
      message: 'Here’s the buyer agreement we talked about.',
    });
    expect(made).toMatchObject({ provider: 'docusign', state: 'preparing' });
    expect((await envelopeOf(made.envelopeId)).words).toBe('Getting it ready in DocuSign…');
    // Only one at a time for a document.
    expect(
      await refusal(
        run('realestate.esign.prepare', { documentId: made.documentId, signers: SIGNERS }),
      ),
    ).toMatchObject({ rule: 'realestate_esign_open' });

    await drain();
    let e = await envelopeOf(made.envelopeId);
    expect(e).toMatchObject({
      state: 'draft',
      subject: 'Please sign: Buyer agreement',
      words: 'It’s ready in DocuSign. Open it, place the fields and send it there.',
      can: { open: true, markSigned: false, void: true },
      signersWords: 'Signed by 0 of 2',
    });
    const external = await externalOf(made.envelopeId);
    expect(standinEnvelope(external)).toMatchObject({ state: 'draft', subject: e.subject });

    // Opened from HandsFreeOS: the sending page, coming back to the deal's documents.
    const opened = await action('realestate.esign.open', { envelopeId: made.envelopeId });
    expect(opened.statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: path(opened.json().url) });
    expect(page.body).toContain('Send it');
    const back = new URL(opened.json().url).searchParams.get('return')!;
    expect(back).toBe(
      `http://localhost:3000/app/w/${ws}/a/realestate/deals/${deal}/documents?esign=${made.envelopeId}`,
    );
    const sent = await app.inject({
      method: 'POST',
      url: `/test/realestate/esign/${encodeURIComponent(external)}/send?return=${encodeURIComponent(back)}`,
    });
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(back);
    e = await envelopeOf(made.envelopeId);
    expect(e).toMatchObject({ state: 'sent', stateLabel: 'Out for signing' });
    expect(e.signers.map((x: Any) => x.state)).toEqual(['sent', 'sent']);
    expect((await documents()).find((d: Any) => d.title === 'Buyer agreement').status).toBe('sent');

    // Everyone signs: the copies come back as documents, signed and locked.
    await app.inject({
      method: 'POST',
      url: `/test/realestate/esign/${encodeURIComponent(external)}/sign`,
    });
    e = await envelopeOf(made.envelopeId);
    expect(e).toMatchObject({
      state: 'completed',
      words: 'Signed. The signed copy and its certificate are in Documents, locked.',
      signersWords: 'Signed by 2 of 2',
      can: { open: false, markSigned: false, void: false },
    });
    const list = await documents();
    const signed = list.find((d: Any) => d.title === 'Buyer agreement (signed)');
    const cert = list.find((d: Any) => d.title === 'DocuSign certificate: Buyer agreement');
    expect(signed).toMatchObject({ status: 'signed', version: 2, controlling: true });
    expect(cert).toMatchObject({ status: 'signed', kind: 'other' });
    expect(list.find((d: Any) => d.title === 'Buyer agreement').status).toBe('superseded');
    const files = await rows<{ name: string; locked: boolean; status: string }>(
      admin(),
      sql`select f.name, f.locked_at is not null as locked, f.status::text as status
          from app.files f where f.id in (
            select file_id from addon_realestate.documents where id in (${signed.documentId}, ${cert.documentId}))
          order by f.name`,
    );
    expect(files).toEqual([
      { name: 'Buyer agreement (signed).pdf', locked: true, status: 'ready' },
      { name: 'Buyer agreement certificate.pdf', locked: true, status: 'ready' },
    ]);
    // Its line on the deal.
    const lines = await rows<{ words: string }>(
      admin(),
      sql`select meta->>'words' as words from app.activities
          where custom_record_id = ${deal} and subtype = 'addon_line'
            and meta->>'words' like '%Buyer agreement%'
          order by occurred_at`,
    );
    expect(lines.map((l) => l.words)).toEqual(
      expect.arrayContaining([
        'is getting “Buyer agreement” ready for signing in DocuSign',
        'got “Buyer agreement” ready in DocuSign: open it there to place the fields and send it',
        '“Buyer agreement” went out for signing in DocuSign',
        '“Buyer agreement” was signed in DocuSign',
      ]),
    );
  });

  it('reads a DocuSign update back from DocuSign, never trusting it', async () => {
    const doc = await documentOf('Agency disclosure', 'agency_disclosure');
    const made = await run('realestate.esign.prepare', { documentId: doc, signers: [SIGNERS[0]] });
    await drain();
    const external = await externalOf(made.envelopeId);
    // Sent at DocuSign, unknown here until someone looks.
    expect(standinAct(external, 'send')).toBe(true);
    expect((await envelopeOf(made.envelopeId)).state).toBe('draft');
    const [hooked] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.addon_connections where workspace_id = ${ws} and provider = 'docusign'`,
    );
    const ctx = scope();
    const connection = (await connectionById(ctx, hooked!.id))!;
    const [update] = DOCUSIGN_UPDATES.parse({
      rawBody: JSON.stringify({
        event: 'envelope-sent',
        generatedDateTime: '2026-10-02T15:00:00Z',
        data: { envelopeId: external, envelopeSummary: { status: 'completed' } },
      }),
      headers: {},
      url: 'https://worker.test/webhooks/addon/x',
    });
    expect(update).toEqual({
      id: `${external}:envelope-sent::2026-10-02T15:00:00Z`,
      kind: 'envelope-sent',
      data: { envelopeId: external },
    });
    const wctx = {
      ...ctx,
      connection,
      update: { ...update!, signed: false, receivedAt: new Date() },
      attempt: 1,
    };
    // The update said "completed"; DocuSign itself says it's out.
    await DOCUSIGN_UPDATES.handle(wctx);
    expect((await envelopeOf(made.envelopeId)).state).toBe('sent');
    expect(
      await DOCUSIGN_UPDATES.handle({
        ...wctx,
        update: { ...wctx.update, data: { envelopeId: 'someone-else' } },
      }),
    ).toBe('ignored');

    // A decline, seen by the check.
    expect(standinAct(external, 'decline')).toBe(true);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where status = 'pending' and workspace_id = ${ws} and kind = ${ESIGN_CHECK}`,
    );
    await drain();
    expect(await envelopeOf(made.envelopeId)).toMatchObject({
      state: 'declined',
      words: 'A signer declined in DocuSign. Open it there to see why, then send a new one.',
      can: { void: false },
    });
    // Nothing open: the check stops.
    const [pending] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${ESIGN_CHECK} and status = 'pending'`,
    );
    expect(pending!.n).toBe(0);
  });

  it('voids it at DocuSign when it’s voided here, and DocuSign says when it’s signed itself', async () => {
    const doc = await documentOf('Seller disclosure', 'seller_disclosure');
    const made = await run('realestate.esign.prepare', { documentId: doc, signers: SIGNERS });
    await drain();
    const external = await externalOf(made.envelopeId);
    standinAct(external, 'send');
    expect(
      await refusal(run('realestate.esign.mark_signed', { envelopeId: made.envelopeId })),
    ).toMatchObject({ rule: 'realestate_esign_says_itself' });
    const voided = await run('realestate.esign.void', {
      envelopeId: made.envelopeId,
      reason: 'Wrong version of the disclosure.',
    });
    expect(voided.state).toBe('voided');
    await drain();
    expect(standinEnvelope(external)).toMatchObject({
      state: 'voided',
      voidReason: 'Wrong version of the disclosure.',
    });
    // Voided, a new one can go.
    const again = await run('realestate.esign.prepare', { documentId: doc, signers: SIGNERS });
    expect(again.state).toBe('preparing');
    await drain();
  });

  it('Dotloop: put in a loop to open, and “It’s signed” fetches the signed copy', async () => {
    await connect('dotloop');
    const doc = await documentOf('Repair request', 'repair_request');
    // Both connected: which one.
    const which = await refusal(
      run('realestate.esign.prepare', { documentId: doc, signers: SIGNERS }),
    );
    expect(JSON.stringify(which.details)).toMatch(/Pick DocuSign or Dotloop/);
    const made = await run('realestate.esign.prepare', {
      documentId: doc,
      provider: 'dotloop',
      signers: SIGNERS,
    });
    await drain();
    let e = await envelopeOf(made.envelopeId);
    expect(e).toMatchObject({
      provider: 'dotloop',
      state: 'draft',
      can: { open: true, markSigned: true },
      words: expect.stringMatching(/press “It’s signed” here/),
    });
    // The loop's page is always the same one.
    const opened = await action('realestate.esign.open', { envelopeId: made.envelopeId });
    expect(opened.json().url).toMatch(/\/test\/realestate\/esign\/standin-dotloop-/);
    // Dotloop says nothing: signed there, nothing changes here until the agent says so.
    const external = await externalOf(made.envelopeId);
    standinAct(external, 'send');
    standinAct(external, 'sign');
    await action('realestate.esign.check', { envelopeId: made.envelopeId });
    expect((await envelopeOf(made.envelopeId)).state).toBe('draft');
    await run('realestate.esign.mark_signed', { envelopeId: made.envelopeId });
    await drain();
    e = await envelopeOf(made.envelopeId);
    expect(e).toMatchObject({
      state: 'completed',
      words: 'Signed. The signed copy is in Documents, locked.',
      certificateDocumentId: null,
    });
    const list = await documents();
    expect(list.find((d: Any) => d.title === 'Repair request (signed)')).toMatchObject({
      status: 'signed',
    });
    expect(list.some((d: Any) => d.title.startsWith('Dotloop certificate'))).toBe(false);
  });

  it('opens only for someone on the deal', async () => {
    const outsider = await createTestUser('esign-outsider');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${outsider.id}, 'member')`,
    );
    const [open] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.esign_envelopes where deal_record_id = ${deal}
          and state = 'draft' limit 1`,
    );
    const theirs = await app.inject({
      method: 'POST',
      url: '/v1/addons/realestate/actions/realestate.esign.open',
      headers: { authorization: `Bearer ${await signInTestUser(outsider)}` },
      payload: { workspaceId: ws, input: { envelopeId: open!.id } },
    });
    // A deal is kept to its people: someone who works here but isn’t on it can’t open its signing.
    expect(theirs.statusCode).toBe(404);
  });
});

describe('with DocuSign itself (scripted)', () => {
  it('makes a draft with its signers in order and updates to the connection’s address, then files the copies', async () => {
    const real: TestServices = {
      ...s,
      addonConnect: {
        fake: false,
        platformKeys: {
          'realestate.docusign': { clientId: 'c', clientSecret: 'x', environment: 'demo' },
        },
      },
    };
    await rows(
      admin(),
      sql`update app.addon_connections
          set details = '{"accountId":"acc-1","baseUri":"https://demo.docusign.net"}'::jsonb
          where workspace_id = ${ws} and provider = 'docusign'`,
    );
    const api = 'https://demo.docusign.net/restapi/v2.1/accounts/acc-1';
    const asked: { method: string; url: string; body: Any }[] = [];
    const pdf = textPdf([['Signed copy']]);
    // DocuSign's envelope ids are its own GUIDs, unique everywhere.
    const env = randomUUID();
    useEsignFetch(async (url, init) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      asked.push({ method, url, body });
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      if (method === 'POST' && url === `${api}/envelopes`)
        return json({ envelopeId: env, status: 'created' });
      if (method === 'POST' && url === `${api}/envelopes/${env}/views/sender`)
        return json({ url: 'https://demo.docusign.net/Member/StartInSession.aspx?t=1' });
      if (url === `${api}/envelopes/${env}?include=recipients`)
        return json({
          status: 'completed',
          sentDateTime: '2026-10-02T15:00:00.0000000Z',
          completedDateTime: '2026-10-02T16:00:00.0000000Z',
          recipients: {
            signers: [
              {
                name: 'Pat Buyer',
                email: 'pat@example.com',
                routingOrder: '1',
                status: 'completed',
                signedDateTime: '2026-10-02T15:30:00Z',
              },
            ],
          },
        });
      if (url.startsWith(`${api}/envelopes/${env}/documents/`)) return new Response(pdf);
      return new Response('{"message":"not scripted"}', { status: 404 });
    });
    try {
      const doc = await documentOf('Listing agreement', 'listing_agreement');
      const made = await run('realestate.esign.prepare', {
        documentId: doc,
        provider: 'docusign',
        subject: 'Your listing agreement',
        signers: [
          { name: 'Pat Buyer', email: 'pat@example.com', order: 1 },
          { name: 'Lee Buyer', email: 'lee@example.com', order: 2 },
        ],
      });
      await drain(real);
      const created = asked.find((a) => a.url === `${api}/envelopes`)!.body;
      expect(created).toMatchObject({
        emailSubject: 'Your listing agreement',
        status: 'created',
        documents: [{ documentId: '1', fileExtension: 'pdf' }],
        recipients: {
          signers: [
            { recipientId: '1', name: 'Pat Buyer', routingOrder: '1' },
            { recipientId: '2', name: 'Lee Buyer', routingOrder: '2' },
          ],
        },
        eventNotification: {
          url: expect.stringMatching(/\/webhooks\/addon\/[A-Za-z0-9_-]{43}$/),
          events: expect.arrayContaining(['envelope-completed', 'envelope-declined']),
        },
      });
      expect(
        Buffer.from(created.documents[0].documentBase64, 'base64').subarray(0, 5).toString(),
      ).toBe('%PDF-');
      // The address is the connection's own, kept sealed with its tokens.
      const [kept] = await rows<{ secret_enc: string; hooked: boolean }>(
        admin(),
        sql`select secret_enc, webhook_token_hash is not null as hooked from app.addon_connections
            where workspace_id = ${ws} and provider = 'docusign'`,
      );
      expect(kept!.hooked).toBe(true);
      expect(JSON.parse(s.sealer.open(kept!.secret_enc))).toMatchObject({
        accessToken: 'a',
        webhookUrl: created.eventNotification.url,
      });
      const drafted = await envelopeOf(made.envelopeId);
      expect(drafted, JSON.stringify(drafted)).toMatchObject({ state: 'draft' });

      // Opened: DocuSign's sending page, made for the person, coming back to the deal.
      const opened = (await ESIGN_ACTIONS['realestate.esign.open']!.run(
        {
          ...addonScope(
            real,
            catalogAddon('realestate'),
            { workspaceId: ws, organizationId: org },
            1,
            workerMeta(),
          ),
          userId: agent.id,
        },
        { envelopeId: made.envelopeId },
      )) as { url: string };
      expect(opened.url).toBe('https://demo.docusign.net/Member/StartInSession.aspx?t=1');
      expect(asked.find((a) => a.url.endsWith('/views/sender'))!.body).toEqual({
        returnUrl: `http://localhost:3000/app/w/${ws}/a/realestate/deals/${deal}/documents?esign=${made.envelopeId}`,
      });

      // The check: DocuSign says it's done, so the copies come back.
      await rows(
        admin(),
        sql`update app.scheduled_jobs set run_at = now()
            where status = 'pending' and workspace_id = ${ws} and kind = ${ESIGN_CHECK}`,
      );
      await drain(real);
      expect(await envelopeOf(made.envelopeId)).toMatchObject({
        state: 'completed',
        completedAt: '2026-10-02T16:00:00.000Z',
      });
      expect(asked.map((a) => a.url)).toEqual(
        expect.arrayContaining([
          `${api}/envelopes/${env}/documents/combined?certificate=false`,
          `${api}/envelopes/${env}/documents/certificate`,
        ]),
      );
      const titles = (await documents()).map((d: Any) => d.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          'Listing agreement (signed)',
          'DocuSign certificate: Listing agreement',
        ]),
      );
    } finally {
      useEsignFetch(null);
    }
  });
});
