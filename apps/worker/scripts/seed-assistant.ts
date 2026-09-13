/**
 * Milestone 4 demo data: two of Dale's chats with the Assistant, asked through the real runtime with the
 * scripted stand-in model, so every tool runs as Dale through the command pipeline and the audit log says
 * "via Assistant". Yesterday's chat checked what was waiting and the week's leads; today's found Robert Chen,
 * added a note and a task on its own, and moved his lead to Contacted once Dale confirmed the card.
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  type AssistantCard,
  type AssistantEvent,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { Logger } from 'pino';
import { questionContext, type PageRecord } from '../src/assistant/context';
import { ask } from '../src/assistant/runtime';
import { scriptedAssistant } from '../src/assistant/scripted';
import * as store from '../src/assistant/store';
import { createToolExecutor } from '../src/assistant/tools-write';

export interface SeedAssistantDeps {
  /** The worker's connection: the Assistant runs its tools as the person inside it. */
  readonly worker: Db;
  readonly admin: Db;
  readonly actor: (u: TestUser) => HumanActor;
  readonly step: (msg: string) => void;
  readonly log: Logger;
}

export interface SeedAssistantWorkspace {
  readonly id: string;
  readonly dale: TestUser;
}

export async function seedAssistant(
  d: SeedAssistantDeps,
  ws: SeedAssistantWorkspace,
): Promise<void> {
  const provider = scriptedAssistant();
  const tools = createToolExecutor(d.worker);
  const dale = d.actor(ws.dale);

  /** One question from the panel, answered in full; returns its thread and the cards it showed. */
  async function question(text: string, page: PageRecord | null, threadId?: string) {
    const context = await questionContext(d.worker, dale, ws.id, page, randomUUID());
    const events: AssistantEvent[] = [];
    await ask(
      { db: d.worker, provider, tools, dailyTokens: Number.MAX_SAFE_INTEGER, log: d.log },
      {
        actor: dale,
        workspaceId: ws.id,
        organizationId: context.organizationId,
        ...(threadId ? { threadId } : {}),
        text,
        page,
        tools: context.tools,
        prompt: context.prompt,
      },
      (e) => events.push(e),
      new AbortController().signal,
    );
    const failed = events.find((e) => e.type === 'error');
    if (failed?.type === 'error')
      throw new Error(`The Assistant could not answer "${text}": ${failed.message}`);
    const run = events.find((e) => e.type === 'run');
    if (run?.type !== 'run') throw new Error(`The Assistant never started on "${text}"`);
    const cards: AssistantCard[] = events.flatMap((e) => (e.type === 'card' ? [e.card] : []));
    return { threadId: run.threadId, cards, context };
  }

  d.step('Lone Star: two of Dale’s chats with the Assistant (scripted model, real tools)');
  const yesterday = await question('What needs attention?', null);
  await question('How many leads this week?', null, yesterday.threadId);
  // It only looked things up, so it can move back to yesterday without contradicting anything it did.
  await rows(
    d.admin,
    sql`update app.assistant_threads set created_at = created_at - interval '20 hours',
          last_message_at = last_message_at - interval '20 hours' where id = ${yesterday.threadId}`,
  );
  await rows(
    d.admin,
    sql`update app.assistant_messages set created_at = created_at - interval '20 hours'
        where thread_id = ${yesterday.threadId}`,
  );
  await rows(
    d.admin,
    sql`update app.assistant_runs set started_at = started_at - interval '20 hours',
          ended_at = ended_at - interval '20 hours', created_at = created_at - interval '20 hours'
        where thread_id = ${yesterday.threadId}`,
  );
  await rows(
    d.admin,
    sql`update app.assistant_tool_calls set created_at = created_at - interval '20 hours'
        where thread_id = ${yesterday.threadId}`,
  );

  const [lead] = await rows<{ id: string; person_id: string }>(
    d.admin,
    sql`select id, person_id from app.leads
        where workspace_id = ${ws.id} and title = 'Ductwork repair' and person_id is not null limit 1`,
  );
  if (!lead) throw new Error('Robert Chen’s ductwork lead is missing from the CRM seed');
  const robert: PageRecord = { type: 'person', id: lead.person_id };
  const today = await question('Find Robert Chen', null);
  await question('Add a note: Prefers morning visits. Gate code 4471.', robert, today.threadId);
  await question(
    'Create a task to call Robert about the ductwork quote tomorrow',
    robert,
    today.threadId,
  );
  const move = await question(
    'Move it to Contacted',
    { type: 'lead', id: lead.id },
    today.threadId,
  );

  // Dale presses Confirm: the same steps as the worker's confirm route.
  const card = move.cards.find((c) => c.type === 'confirm');
  if (card?.type !== 'confirm') throw new Error('The Assistant did not draft the lead move');
  const scope = { workspaceId: ws.id, organizationId: move.context.organizationId };
  if (!(await store.claimToolCall(d.worker, scope, card.toolCallId, 'confirmed')))
    throw new Error('The lead move card was already answered');
  const call = await store.getToolCall(d.worker, scope, card.toolCallId);
  const tool = call ? assistantToolByName.get(call.tool) : undefined;
  if (!call || !tool) throw new Error('The lead move card has no tool call');
  const done = await tools.commit(
    tool,
    call.arguments,
    {
      actor: dale,
      workspaceId: ws.id,
      organizationId: scope.organizationId,
      correlationId: randomUUID(),
      timezone: move.context.timezone,
    },
    { toolCallId: call.id },
  );
  await store.updateToolCall(d.worker, scope, call.id, {
    status: 'confirmed',
    result: { outcome: done.outcome, href: done.href, command: done.command },
  });
}
