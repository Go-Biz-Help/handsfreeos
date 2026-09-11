import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let ownerA: TestUser;
let adminA: TestUser;
let memberA: TestUser;
let member2A: TestUser;
let ownerB: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;
type Stage = { id: string; name: string; kind: string; pipeline_id: string };
let stagesA: Stage[];
const stage = (name: string): Stage => stagesA.find((s) => s.name === name)!;

const insertPerson = (u: TestUser, ws: string, first: string, opts: { companyId?: string } = {}) =>
  as(u)((tx) =>
    rows<{ id: string; search_text: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name, email, phone_e164, city, company_id, created_by)
          values (${ws}, ${first}, 'Tester', ${`${first.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`}, '+17135550100', 'Houston', ${opts.companyId ?? null}, ${u.id})
          returning id, search_text`,
    ).then((r) => r[0]!),
  );

const insertLead = (
  u: TestUser,
  ws: string,
  personId: string,
  stageId: string,
  pipelineId: string,
  extra: { lostReason?: string } = {},
) =>
  as(u)((tx) =>
    rows<{
      id: string;
      status: string;
      won_at: string | null;
      lost_at: string | null;
      lost_reason: string | null;
    }>(
      tx,
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, value_cents, lost_reason, created_by)
          values (${ws}, ${pipelineId}, ${stageId}, ${personId}, 'Roof replacement', 1250000, ${extra.lostReason ?? null}, ${u.id})
          returning id, status::text as status, won_at, lost_at, lost_reason`,
    ).then((r) => r[0]!),
  );

beforeAll(async () => {
  [ownerA, adminA, memberA, member2A, ownerB] = await Promise.all([
    createTestUser('crm-owner-a'),
    createTestUser('crm-admin-a'),
    createTestUser('crm-member-a'),
    createTestUser('crm-member2-a'),
    createTestUser('crm-owner-b'),
  ]);
  const a = await bootstrapOrganization(ownerA, 'CRM Org A', 'CRM Workspace A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(ownerB, 'CRM Org B', 'CRM Workspace B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: adminA.id, role: 'admin' },
    { workspaceId: wsA, userId: memberA.id, role: 'member' },
    { workspaceId: wsA, userId: member2A.id, role: 'member' },
  ]);
  stagesA = await rows<Stage>(
    dbs.admin.db,
    sql`select s.id, s.name, s.kind::text as kind, s.pipeline_id from app.pipeline_stages s
        join app.pipelines p on p.id = s.pipeline_id where p.workspace_id = ${wsA} order by s.position`,
  );
});
afterAll(closeAll);

describe('CRM tables are isolated per workspace', () => {
  it('every new workspace gets the default Sales pipeline with five stages', async () => {
    expect(stagesA.map((s) => [s.name, s.kind])).toEqual([
      ['New', 'open'],
      ['Contacted', 'open'],
      ['Estimate sent', 'open'],
      ['Won', 'won'],
      ['Lost', 'lost'],
    ]);
    const pipelines = await as(memberA)((tx) =>
      rows<{ name: string }>(tx, sql`select name from app.pipelines where workspace_id = ${wsA}`),
    );
    expect(pipelines.map((p) => p.name)).toEqual(['Sales']);
  });

  it('a member writes and reads records in their workspace; another workspace sees nothing and changes nothing', async () => {
    const person = await insertPerson(memberA, wsA, 'Isolated');
    expect(person.search_text).toContain('isolated tester');
    expect(person.search_text).toContain('houston');
    const mine = await as(memberA)((tx) =>
      rows(tx, sql`select id from app.people where id = ${person.id}`),
    );
    expect(mine).toHaveLength(1);
    const theirs = await as(ownerB)((tx) =>
      rows(tx, sql`select id from app.people where id = ${person.id}`),
    );
    expect(theirs).toHaveLength(0);
    const updated = await as(ownerB)((tx) =>
      rows(tx, sql`update app.people set notes = 'hacked' where id = ${person.id} returning id`),
    );
    expect(updated).toHaveLength(0);
    const err = await expectPgError(() => insertPerson(memberA, wsB, 'Intruder'));
    expect(err.code).toBe('42501');
  });

  it('a person cannot point at a company from another workspace, even by id', async () => {
    const [companyB] = await as(ownerB)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.companies (workspace_id, name, created_by) values (${wsB}, 'B Corp', ${ownerB.id}) returning id`,
      ),
    );
    const err = await expectPgError(() =>
      insertPerson(memberA, wsA, 'Crossed', { companyId: companyB!.id }),
    );
    expect(err.detail).toBe('company_workspace_mismatch');
  });
});

describe('who may do what', () => {
  it('members cannot archive; admins can, and the archiver is recorded', async () => {
    const person = await insertPerson(memberA, wsA, 'Archivable');
    const err = await expectPgError(() =>
      as(memberA)((tx) =>
        rows(tx, sql`update app.people set archived_at = now() where id = ${person.id}`),
      ),
    );
    expect(err.code).toBe('42501');
    expect(err.detail).toBe('archive_forbidden');
    const [row] = await as(adminA)((tx) =>
      rows<{ archived_by: string }>(
        tx,
        sql`update app.people set archived_at = now() where id = ${person.id} returning archived_by`,
      ),
    );
    expect(row!.archived_by).toBe(adminA.id);
    // Members may still edit ordinary fields.
    const edited = await as(memberA)((tx) =>
      rows(
        tx,
        sql`update app.people set notes = 'gate code 4471' where id = ${person.id} returning id`,
      ),
    );
    expect(edited).toHaveLength(1);
  });

  it('only owners and admins manage pipelines and stages', async () => {
    const pipelineId = stagesA[0]!.pipeline_id;
    const err = await expectPgError(() =>
      as(memberA)((tx) =>
        rows(
          tx,
          sql`insert into app.pipeline_stages (workspace_id, pipeline_id, name, kind, position) values (${wsA}, ${pipelineId}, 'Sneaky', 'open', 50)`,
        ),
      ),
    );
    expect(err.code).toBe('42501');
    const added = await as(adminA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.pipeline_stages (workspace_id, pipeline_id, name, kind, position) values (${wsA}, ${pipelineId}, 'Follow-up', 'open', 10) returning id`,
      ),
    );
    expect(added).toHaveLength(1);
    const renamed = await as(memberA)((tx) =>
      rows(
        tx,
        sql`update app.pipeline_stages set name = 'Nope' where id = ${added[0]!.id} returning id`,
      ),
    );
    expect(renamed).toHaveLength(0);
    await as(adminA)((tx) =>
      rows(tx, sql`delete from app.pipeline_stages where id = ${added[0]!.id}`),
    );
  });

  it('tags are shared per workspace; members apply them, only managers rename them', async () => {
    const [tag] = await as(memberA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tags (workspace_id, name, color, created_by) values (${wsA}, ${'VIP ' + randomUUID().slice(0, 4)}, '#c43335', ${memberA.id}) returning id`,
      ),
    );
    const person = await insertPerson(memberA, wsA, 'Tagged');
    const applied = await as(memberA)((tx) =>
      rows(
        tx,
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id, created_by) values (${wsA}, ${tag!.id}, 'person', ${person.id}, ${memberA.id}) returning tag_id`,
      ),
    );
    expect(applied).toHaveLength(1);
    const [tagB] = await as(ownerB)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tags (workspace_id, name, created_by) values (${wsB}, 'B only', ${ownerB.id}) returning id`,
      ),
    );
    const err = await expectPgError(() =>
      as(memberA)((tx) =>
        rows(
          tx,
          sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id, created_by) values (${wsA}, ${tagB!.id}, 'person', ${person.id}, ${memberA.id})`,
        ),
      ),
    );
    expect(err.code).toBe('42501');
    const renamedByMember = await as(member2A)((tx) =>
      rows(tx, sql`update app.tags set name = 'Renamed' where id = ${tag!.id} returning id`),
    );
    expect(renamedByMember).toHaveLength(0);
    const renamedByAdmin = await as(adminA)((tx) =>
      rows(
        tx,
        sql`update app.tags set name = ${'Renamed ' + randomUUID().slice(0, 4)} where id = ${tag!.id} returning id`,
      ),
    );
    expect(renamedByAdmin).toHaveLength(1);
  });

  it('notes belong to their author: others cannot edit, admins may delete, system entries are immutable', async () => {
    const person = await insertPerson(memberA, wsA, 'Noted');
    const [note] = await as(memberA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.activities (workspace_id, kind, person_id, body, author_user_id, actor_type) values (${wsA}, 'note', ${person.id}, 'Prefers texts', ${memberA.id}, 'human') returning id`,
      ),
    );
    const editedByOther = await as(member2A)((tx) =>
      rows(tx, sql`update app.activities set body = 'x' where id = ${note!.id} returning id`),
    );
    expect(editedByOther).toHaveLength(0);
    const deletedByOther = await as(member2A)((tx) =>
      rows(tx, sql`delete from app.activities where id = ${note!.id} returning id`),
    );
    expect(deletedByOther).toHaveLength(0);
    const deletedByAdmin = await as(adminA)((tx) =>
      rows(tx, sql`delete from app.activities where id = ${note!.id} returning id`),
    );
    expect(deletedByAdmin).toHaveLength(1);
    const [system] = await as(adminA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.activities (workspace_id, kind, subtype, person_id, author_user_id, actor_type) values (${wsA}, 'system', 'created', ${person.id}, ${adminA.id}, 'human') returning id`,
      ),
    );
    // RLS hides system entries from every human delete; the trigger stops even postgres.
    const hidden = await as(adminA)((tx) =>
      rows(tx, sql`delete from app.activities where id = ${system!.id} returning id`),
    );
    expect(hidden).toHaveLength(0);
    const err = await expectPgError(() =>
      rows(dbs.admin.db, sql`delete from app.activities where id = ${system!.id}`),
    );
    expect(err.detail).toBe('system_activity_immutable');
  });

  it('tasks: any member creates, the author or an admin deletes', async () => {
    const [task] = await as(memberA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, due_at, assignee_user_id, created_by) values (${wsA}, 'Call Mike', now(), ${member2A.id}, ${memberA.id}) returning id`,
      ),
    );
    const byOther = await as(member2A)((tx) =>
      rows(tx, sql`delete from app.tasks where id = ${task!.id} returning id`),
    );
    expect(byOther).toHaveLength(0);
    const byAdmin = await as(adminA)((tx) =>
      rows(tx, sql`delete from app.tasks where id = ${task!.id} returning id`),
    );
    expect(byAdmin).toHaveLength(1);
  });

  it('file rows: the uploader confirms, pending never goes backwards, deletion needs the uploader or files.delete', async () => {
    const person = await insertPerson(memberA, wsA, 'Filed');
    const path = `${wsA}/person/${person.id}/${randomUUID()}/photo.png`;
    const [file] = await as(memberA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, created_by) values (${wsA}, 'person', ${person.id}, ${path}, 'photo.png', 'image/png', ${memberA.id}) returning id`,
      ),
    );
    const confirmByOther = await expectPgError(() =>
      as(member2A)((tx) =>
        rows(tx, sql`update app.files set status = 'ready' where id = ${file!.id}`),
      ),
    );
    expect(confirmByOther.detail).toBe('file_confirm_forbidden');
    await as(memberA)((tx) =>
      rows(tx, sql`update app.files set status = 'ready', size_bytes = 68 where id = ${file!.id}`),
    );
    const backwards = await expectPgError(() =>
      as(memberA)((tx) =>
        rows(tx, sql`update app.files set status = 'pending' where id = ${file!.id}`),
      ),
    );
    expect(backwards.detail).toBe('file_status_transition');
    const deleteByOther = await expectPgError(() =>
      as(member2A)((tx) =>
        rows(tx, sql`update app.files set deleted_at = now() where id = ${file!.id}`),
      ),
    );
    expect(deleteByOther.detail).toBe('file_delete_forbidden');
    const [deleted] = await as(memberA)((tx) =>
      rows<{ deleted_by: string }>(
        tx,
        sql`update app.files set deleted_at = now() where id = ${file!.id} returning deleted_by`,
      ),
    );
    expect(deleted!.deleted_by).toBe(memberA.id);
  });
});

describe('leads follow their stage', () => {
  it('status, won_at, lost_at and the lost reason are derived from the stage kind', async () => {
    const person = await insertPerson(memberA, wsA, 'Leady');
    const lead = await insertLead(
      memberA,
      wsA,
      person.id,
      stage('New').id,
      stage('New').pipeline_id,
    );
    expect(lead.status).toBe('open');
    const move = (stageId: string, lostReason: string | null = null) =>
      as(memberA)((tx) =>
        rows<{
          status: string;
          won_at: string | null;
          lost_at: string | null;
          lost_reason: string | null;
        }>(
          tx,
          sql`update app.leads set stage_id = ${stageId}, lost_reason = ${lostReason} where id = ${lead.id} returning status::text as status, won_at, lost_at, lost_reason`,
        ).then((r) => r[0]!),
      );
    const won = await move(stage('Won').id);
    expect(won.status).toBe('won');
    expect(won.won_at).not.toBeNull();
    const noReason = await expectPgError(() => move(stage('Lost').id));
    expect(noReason.detail).toBe('lost_reason_required');
    const lost = await move(stage('Lost').id, 'Went with another bidder');
    expect(lost.status).toBe('lost');
    expect(lost.lost_at).not.toBeNull();
    expect(lost.won_at).toBeNull();
    const reopened = await move(stage('Contacted').id);
    expect(reopened.status).toBe('open');
    expect(reopened.lost_at).toBeNull();
    expect(reopened.lost_reason).toBeNull();
  });

  it('a stage from another pipeline or workspace is rejected, even when the caller cannot see it', async () => {
    const person = await insertPerson(memberA, wsA, 'Stagey');
    const [stageB] = await rows<{ id: string; pipeline_id: string }>(
      dbs.admin.db,
      sql`select s.id, s.pipeline_id from app.pipeline_stages s join app.pipelines p on p.id = s.pipeline_id where p.workspace_id = ${wsB} limit 1`,
    );
    const err = await expectPgError(() =>
      insertLead(memberA, wsA, person.id, stageB!.id, stage('New').pipeline_id),
    );
    expect(['stage_pipeline_mismatch', 'stage_not_found']).toContain(err.detail);
  });

  it('a stage with leads keeps its kind and cannot be deleted; every pipeline keeps one stage of each kind', async () => {
    const person = await insertPerson(memberA, wsA, 'Guardy');
    const pipelineId = stage('New').pipeline_id;
    const [extra] = await as(adminA)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.pipeline_stages (workspace_id, pipeline_id, name, kind, position) values (${wsA}, ${pipelineId}, 'Guarded', 'open', 20) returning id`,
      ),
    );
    await insertLead(memberA, wsA, person.id, extra!.id, pipelineId);
    const kindChange = await expectPgError(() =>
      as(adminA)((tx) =>
        rows(tx, sql`update app.pipeline_stages set kind = 'won' where id = ${extra!.id}`),
      ),
    );
    expect(kindChange.detail).toBe('stage_has_leads');
    const deleteWithLeads = await expectPgError(() =>
      as(adminA)((tx) => rows(tx, sql`delete from app.pipeline_stages where id = ${extra!.id}`)),
    );
    expect(deleteWithLeads.code).toBe('23503');
    const lastWon = await expectPgError(() =>
      as(adminA)((tx) =>
        rows(tx, sql`delete from app.pipeline_stages where id = ${stage('Won').id}`),
      ),
    );
    expect(lastWon.detail).toBe('last_stage_of_kind');
  });
});

describe('the worker in scope', () => {
  it('may create people and system activities only inside its scope, never as a human', async () => {
    const scoped = asService({ workspaceId: wsA, organizationId: orgA });
    const [person] = await scoped((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name, email, created_by) values (${wsA}, 'Imported', 'Person', ${`imported-${randomUUID().slice(0, 6)}@example.com`}, ${ownerA.id}) returning id`,
      ),
    );
    expect(person).toBeDefined();
    const activity = await scoped((tx) =>
      rows(
        tx,
        sql`insert into app.activities (workspace_id, kind, subtype, person_id, actor_type) values (${wsA}, 'system', 'created', ${person!.id}, 'system') returning id`,
      ),
    );
    expect(activity).toHaveLength(1);
    const asHuman = await expectPgError(() =>
      scoped((tx) =>
        rows(
          tx,
          sql`insert into app.activities (workspace_id, kind, person_id, body, actor_type, author_user_id) values (${wsA}, 'note', ${person!.id}, 'forged', 'human', ${ownerA.id})`,
        ),
      ),
    );
    expect(asHuman.code).toBe('42501');
    const elsewhere = await asService({ workspaceId: wsB, organizationId: orgB })((tx) =>
      rows(tx, sql`select id from app.people where id = ${person!.id}`),
    );
    expect(elsewhere).toHaveLength(0);
    const unscoped = await asService({})((tx) =>
      rows(tx, sql`select id from app.people where workspace_id = ${wsA}`),
    );
    expect(unscoped).toHaveLength(0);
  });
});
