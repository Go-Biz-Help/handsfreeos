/**
 * A link that asks for a file, end to end through the worker and the real local Storage (20261018000400): the page
 * says what was asked and takes a PDF, the PDF lands in the conversation as the customer's reply and answers the
 * question on their lead, and then the worker copies it onto the lead's Files and emails whoever the question names;
 * the lead qualifies, and whoever "When a lead qualifies → Tell" names hears that too.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  aiTeammateCreate,
  aiTeammateGet,
  aiTeammateSaveConfig,
  applyTeammatePatch,
  executeCommand,
  LeadQualification,
  leadCreate,
  messageReceive,
  parseTeammateConfig,
  personCreate,
  videoLinkTokenHash,
  type SystemActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { files, leads } from '@hfos/db/schema';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  drain,
  errorOf,
  get,
  makeWorld,
  post,
  query,
  readyTexting,
  run,
  waitForMail,
  type World,
} from './booking-world';

let w: World;
let token: string;
let leadId: string;
const ROSA = '+17135550183';
const BILL = 'Can you send a photo of your latest electric bill?';

const system = (): SystemActor => ({
  type: 'system',
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  onBehalfOf: null,
});

beforeAll(async () => {
  w = await makeWorld('filelink');
  const number = await readyTexting(w);
  const { personId } = await run(w, personCreate, {
    workspaceId: w.workspaceId,
    firstName: 'Rosa',
    lastName: 'Diaz',
    phone: ROSA,
    ignoreDuplicates: true,
  });
  const { output } = await executeCommand(
    testDbs().worker.db,
    messageReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: `SMfile${randomUUID().slice(0, 8)}`,
      from: ROSA,
      to: number,
      body: 'Would solar panels pay off for us?',
    },
    system(),
    { correlationId: randomUUID(), channel: 'test' },
  );
  const { teammateId } = await run(w, aiTeammateCreate, {
    workspaceId: w.workspaceId,
    preset: 'lead_responder',
    name: 'Ava',
    disclosure: 'when_asked',
  });
  const got = await query(w, aiTeammateGet, { workspaceId: w.workspaceId });
  await run(w, aiTeammateSaveConfig, {
    workspaceId: w.workspaceId,
    teammateId,
    baseRevision: got.teammate!.revision,
    config: applyTeammatePatch(parseTeammateConfig(got.teammate!.config), {
      qualify: {
        enabled: true,
        questions: [{ id: 'bill', question: BILL, kind: 'file', notify: { kind: 'admins' } }],
        // "When a lead qualifies → Tell" (20261018000400), which told nobody before.
        whenQualified: { notify: { kind: 'admins' } },
      },
    }),
  });
  leadId = (await run(w, leadCreate, { workspaceId: w.workspaceId, title: 'Solar', personId }))
    .leadId;
  // The link the teammate's reply would carry (its own making is core's test, and the replies').
  token = randomBytes(24).toString('base64url');
  await rows(
    admin(),
    sql`insert into app.video_links (workspace_id, conversation_id, token_hash, created_by_teammate_id, expires_at,
          max_uploads, asks_for, lead_id, question_id, ask)
        values (${w.workspaceId}, ${output.conversationId}, ${videoLinkTokenHash(token)}, ${teammateId},
          now() + interval '7 days', 5, 'file', ${leadId}, 'bill', ${BILL})`,
  );
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

describe('a link that asks for a file', () => {
  it('says what was asked, and takes five files', async () => {
    const res = await get(w, `/public/video/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      asksFor: 'file',
      ask: BILL,
      maxUploads: 5,
      received: 0,
      problem: null,
    });
  });

  it('turns away a video', async () => {
    const res = await post(w, `/public/video/${token}/start`, {
      name: 'clip.mov',
      contentType: 'video/quicktime',
      sizeBytes: 2000,
    });
    expect(res.statusCode).toBe(415);
    expect(errorOf(res).rule).toBe('not_a_file');
  });

  it('puts the PDF on the lead as the answer, copies it to Files, and tells the owners', async () => {
    const bytes = Buffer.from('%PDF-1.7 the electric bill, page 1');
    const started = await post(w, `/public/video/${token}/start`, {
      name: 'bill.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
    });
    expect(started.statusCode).toBe(200);
    const up = started.json() as { uploadId: string; objectPath: string; uploadUrl: string };
    expect(up.objectPath).toBe(`${w.workspaceId}/messages/${up.uploadId}/file.pdf`);
    const put = await fetch(up.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    const done = await post(w, `/public/video/${token}/done`, {
      uploadId: up.uploadId,
      objectPath: up.objectPath,
      name: 'bill.pdf',
    });
    expect(done.statusCode).toBe(200);

    const [lead] = await admin().select().from(leads).where(eq(leads.id, leadId));
    const q = LeadQualification.parse(lead!.qualification);
    expect(q.status).toBe('qualified');
    expect(q.answers['bill']!.answer).toBe('Sent “bill.pdf”');

    await drain(w);
    const [f] = await admin()
      .select()
      .from(files)
      .where(and(eq(files.recordType, 'lead'), eq(files.recordId, leadId)));
    expect(f).toMatchObject({ name: 'bill.pdf', status: 'ready', sizeBytes: bytes.length });
    expect(await w.s.store.download('attachments', f!.objectPath)).toEqual(bytes);
    // The customer's message keeps its own.
    expect(await w.s.store.download('telephony', up.objectPath)).toEqual(bytes);

    const mail = await waitForMail(w.owner.email, 'Rosa Diaz sent a file');
    expect(mail.text).toContain(
      `Rosa Diaz sent “bill.pdf” through the link you texted them, for “${BILL}”`,
    );
    expect(mail.text).toContain(`/app/w/${w.workspaceId}/leads/${leadId}`);

    // The bill was the last thing missing, so the lead qualified, and "Tell" hears that too.
    const qualified = await waitForMail(w.owner.email, 'Rosa Diaz is qualified: Solar');
    expect(qualified.text).toContain(BILL);
    expect(qualified.text).toContain('Sent “bill.pdf”');
    const told = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events
          where workspace_id = ${w.workspaceId}
            and event_type in ('file.received_told', 'lead.qualified_told')
          order by event_type`,
    );
    expect(told.map((e) => e.event_type)).toEqual(['file.received_told', 'lead.qualified_told']);
  });
});
