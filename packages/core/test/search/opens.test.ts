/**
 * What a search result opens onto (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: where a result opens"), on the
 * local database: the queries its links read.
 *
 *   - `activity.get`, for `?activity=`: one timeline line as the timeline shows it; a line on a turned-off add-on's
 *     record isn't there, and neither is another business's.
 *   - `task.list` with `taskId`, for `/tasks?task=`: that task alone, whoever's it is, open or done.
 *   - `conversation.thread` with `upTo`, for `?message=…&at=`: the thread at that message, what came after loading
 *     with `since`.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityGet, conversationThread, taskList } from '../../src/server';
import { installRealestate } from '../addons/realestate-fixture';
import {
  admin,
  ask,
  everything,
  expectHfos,
  groupOf,
  moreOfTheBoards,
  searchWorld,
  type World,
} from './helpers';

let w: World;
let other: World;
let m: Record<string, string>;
beforeAll(async () => {
  w = await searchWorld('search-opens');
  m = await moreOfTheBoards(w);
  other = await searchWorld('search-opens-other');
});
afterAll(closeTestDbs);

describe('activity.get', () => {
  it('reads the note a result opens over its record’s page', async () => {
    const note = groupOf(await everything(w, w.owner, 'gate code'), 'notes')!.items[0]!;
    expect(note.href).toContain(`?activity=${m.gateNote}`);
    const { activity } = await ask(
      activityGet,
      { workspaceId: w.wsId, activityId: m.gateNote },
      w.member,
    );
    expect(activity).toMatchObject({
      id: m.gateNote,
      entry: 'activity',
      kind: 'note',
      body: 'Gate code 4471, dog in the yard',
      personId: w.ids.dana,
      actor: { id: w.member.id, fullName: 'Mike Member' },
    });
  });

  it('isn’t there for another business, nor on a turned-off add-on’s record', async () => {
    await expectHfos(
      () => ask(activityGet, { workspaceId: other.wsId, activityId: m.gateNote }, other.owner),
      'not_found',
      404,
    );
    await installRealestate(w.wsId);
    const [property] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name)
          select ${w.wsId}, t.id, '9 Bayou Lane' from app.custom_record_types t
          where t.workspace_id = ${w.wsId} and t.key = 'realestate_property'
          returning id`,
    );
    const [note] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.activities (workspace_id, kind, body, custom_record_id, actor_type)
          values (${w.wsId}, 'note', 'Roof is new', ${property!.id}, 'human') returning id`,
    );
    const read = () => ask(activityGet, { workspaceId: w.wsId, activityId: note!.id }, w.owner);
    expect((await read()).activity.customRecordId).toBe(property!.id);
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${w.wsId} and addon_id = 'realestate'`,
    );
    try {
      await expectHfos(read, 'not_found', 404);
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${w.wsId} and addon_id = 'realestate'`,
      );
    }
  });
});

describe('task.list with a task', () => {
  it('lists that task alone, whoever’s it is, open or done', async () => {
    for (const id of [m.callBack, m.parts]) {
      const list = await ask(
        taskList,
        { workspaceId: w.wsId, scope: 'all', status: 'all', taskId: id },
        w.marco,
      );
      expect(list.items.map((t) => t.id)).toEqual([id]);
    }
    // Mine, open: Marco has none of these.
    const mine = await ask(taskList, { workspaceId: w.wsId, taskId: m.callBack }, w.marco);
    expect(mine.items).toEqual([]);
  });
});

describe('conversation.thread up to a moment', () => {
  it('opens the thread at a found message, and loads what came after with since', async () => {
    const hit = groupOf(await everything(w, w.owner, 'leaking'), 'messages')!.items[0]!;
    const at = new URL(hit.href, 'https://x.example').searchParams.get('at')!;
    const upTo = await ask(
      conversationThread,
      { workspaceId: w.wsId, conversationId: m.danaTexts, upTo: at },
      w.owner,
    );
    expect(upTo.items[0]!.id).toBe(m.leak);
    expect(upTo.items.every((i) => Date.parse(i.occurredAt) <= Date.parse(at))).toBe(true);
    const after = await ask(
      conversationThread,
      { workspaceId: w.wsId, conversationId: m.danaTexts, since: at },
      w.owner,
    );
    expect(after.items.length).toBeGreaterThan(0);
    expect(after.items.every((i) => Date.parse(i.occurredAt) > Date.parse(at))).toBe(true);
    expect(after.items.map((i) => i.id)).not.toContain(m.leak);
  });
});
