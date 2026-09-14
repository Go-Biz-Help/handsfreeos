/**
 * Knowledge files on the local database: knowledge_document.begin_upload reserves a knowledge path (owners and
 * admins, PDFs and text files up to 5 MB), file.confirm marks it ready once stored, knowledge_document.add
 * reads it into the knowledge base, and only a knowledge manager removes it.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { events } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fileConfirm,
  fileDelete,
  knowledgeDocumentAdd,
  knowledgeDocumentBeginUpload,
  organizationCreate,
} from '../src/server';
import { admin, expectHfos, run } from './calendar-helpers';

let owner: TestUser, member: TestUser;
let wsId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('kf-core-owner', { fullName: 'Dale Owner' }),
    createTestUser('kf-core-member', { fullName: 'Mike Member' }),
  ]);
  wsId = (await run(organizationCreate, { businessName: 'Knowledge Files Co' }, owner)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

/** Stands in for the browser's upload: the object as Storage records it. */
const putObject = (path: string, size: number, mimetype: string) =>
  rows(
    admin(),
    sql`insert into storage.objects (bucket_id, name, metadata)
        values ('attachments', ${path}, ${JSON.stringify({ size, mimetype })}::jsonb)`,
  );

const begin = (name: string, mimeType: string, sizeBytes: number, u: TestUser = owner) =>
  run(knowledgeDocumentBeginUpload, { workspaceId: wsId, name, mimeType, sizeBytes }, u);

describe('knowledge files', () => {
  it('an owner reserves, uploads, confirms and adds a document', async () => {
    const begun = await begin('price list.pdf', 'application/pdf', 2048);
    expect(begun.bucket).toBe('attachments');
    expect(begun.objectPath).toBe(`${wsId}/knowledge/${begun.fileId}/price-list.pdf`);
    await expectHfos(
      () => run(fileConfirm, { workspaceId: wsId, fileId: begun.fileId }, owner),
      'file_not_uploaded',
    );
    await putObject(begun.objectPath, 2048, 'application/pdf');
    expect(await run(fileConfirm, { workspaceId: wsId, fileId: begun.fileId }, owner)).toEqual({
      fileId: begun.fileId,
      sizeBytes: 2048,
      mimeType: 'application/pdf',
    });
    const [file] = await rows<{ record_type: string; record_id: string; status: string }>(
      admin(),
      sql`select record_type::text as record_type, record_id, status::text as status
          from app.files where id = ${begun.fileId}`,
    );
    expect(file).toEqual({ record_type: 'knowledge', record_id: wsId, status: 'ready' });
    // The confirmation is about the file: no customer's timeline hears of it.
    const attached = await admin()
      .select({ entityType: events.entityType, entityId: events.entityId })
      .from(events)
      .where(and(eq(events.workspaceId, wsId), eq(events.eventType, 'file.attached')));
    expect(attached).toEqual([{ entityType: 'file', entityId: begun.fileId }]);
    expect(
      await run(knowledgeDocumentAdd, { workspaceId: wsId, fileId: begun.fileId }, owner),
    ).toEqual({ fileId: begun.fileId, requested: true });
  });

  it('refuses members, other kinds of file and files over 5 MB', async () => {
    await expectHfos(() => begin('notes.txt', 'text/plain', 10, member), 'forbidden', 403);
    await expectHfos(() => begin('logo.png', 'image/png', 10), 'validation', 400);
    await expectHfos(() => begin('big.pdf', 'application/pdf', 5 * 1024 * 1024 + 1), 'validation');
  });

  it('only a knowledge manager confirms or removes a knowledge file', async () => {
    const begun = await begin('notes.txt', 'text/plain', 100);
    await putObject(begun.objectPath, 100, 'text/plain');
    await expectHfos(
      () => run(fileConfirm, { workspaceId: wsId, fileId: begun.fileId }, member),
      'forbidden',
      403,
    );
    await run(fileConfirm, { workspaceId: wsId, fileId: begun.fileId }, owner);
    await expectHfos(
      () => run(fileDelete, { workspaceId: wsId, fileId: begun.fileId }, member),
      'forbidden',
      403,
    );
    expect(await run(fileDelete, { workspaceId: wsId, fileId: begun.fileId }, owner)).toEqual({
      fileId: begun.fileId,
    });
  });
});
