/**
 * call_for_me (core's tools-web.ts): the AI teammate phones someone in Contacts for the person, with their questions
 * (the owner, 25 Nov 2026: "would calling suppliers be the AI teammate?" yes). The card shows who it calls, what it
 * says and asks, and what it may tell them. Confirm writes the call down as the system on their behalf
 * (`ai_call.ask_errand`; only the worker writes calls), after checking they may use the inbox. The place job
 * (ai-calls/index.ts) checks the number is a business landline or that they agreed in writing to calls, and the answer
 * comes back to this chat and their phone (ai-calls/errand.ts).
 */
import {
  aiCallAskErrand,
  errandGoal,
  executeCommand,
  formatPhone,
  HfosError,
  money,
  type TeammateConfig,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { runtimeConfigOf } from '../ai-team/config';
import { hasPermission } from '../http/common';
import { systemActor } from '../services';
import { outboundGreetingOf } from '../voice-agent/prompt';
import type { ToolContext } from './runtime';
import { query } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

interface PersonGet {
  person: {
    id: string;
    fullName: string;
    phoneE164: string | null;
    company: { name: string } | null;
    archivedAt: string | null;
    callConsent: { consent: 'unknown' | 'opted_in' | 'opted_out' };
  };
}

interface TeammateGet {
  teammate: { status: 'off' | 'training' | 'automatic'; config: unknown } | null;
}

/** Who they are, as the card and the answer name them: their name, else their company's. */
const nameOf = (p: PersonGet['person']) => p.fullName.trim() || p.company?.name.trim() || 'them';

const mayCall = async (db: Db, ctx: ToolContext) => {
  if (!(await hasPermission({ httpDb: db }, ctx.actor.userId, ctx.workspaceId, 'inbox.use')))
    throw HfosError.forbidden(
      'Only people who use the inbox here can have the AI teammate call someone. Ask an owner of this business.',
    );
};

const personOf = async (db: Db, ctx: ToolContext, args: Args) => {
  const personId = str(args['personId']);
  if (!personId)
    throw HfosError.validation(
      [{ path: 'personId', message: 'Who to call.' }],
      'Say who to call: find them in Contacts first, or add them.',
    );
  const { person } = await query<PersonGet>(db, ctx, 'person.get', { personId });
  return person;
};

/** Why it can't call them, in words for the card (empty when it can), and the teammate it would be. */
async function blockedWhy(
  db: Db,
  ctx: ToolContext,
  p: PersonGet['person'],
): Promise<{ why: string; config: TeammateConfig }> {
  const name = nameOf(p);
  const team = await query<TeammateGet>(db, ctx, 'ai_teammate.get').catch(() => null);
  const config = team?.teammate ? runtimeConfigOf(team.teammate.config) : null;
  const why = p.archivedAt
    ? `${name} is archived. Bring them back in Contacts first, then ask again.`
    : !p.phoneE164
      ? `${name} has no phone number in Contacts. Add one on their page, then ask again.`
      : p.callConsent.consent === 'opted_out'
        ? `${name} asked not to be called, so the AI teammate won’t call them. Call them yourself if you need to.`
        : // Not knowing (they can't see the AI teammate page) leaves it to the call, which says why if it can't go.
          team && (!team.teammate || team.teammate.status === 'off')
          ? 'Your AI teammate is off, so it can’t make calls. Turn it on in AI teammate, then ask again.'
          : config && !config.phone.enabled
            ? 'Your AI teammate isn’t set up to talk on the phone. Turn on Phone calls in AI teammate → Phone, then ask again.'
            : '';
  return { why, config: config ?? runtimeConfigOf(null) };
}

const callForMe: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    await mayCall(db, ctx);
    const p = await personOf(db, ctx, args);
    const name = nameOf(p);
    const goal = errandGoal(str(args['goal']) ?? 'to ask a quick question');
    const ask = str(args['ask']) ?? '';
    const say = str(args['say']);
    const [{ workspace }, prices, blocked] = await Promise.all([
      query<{ workspace: { name: string } }>(db, ctx, 'workspace.get'),
      query<{ items: { key: string | null; cents: number }[] }>(db, ctx, 'usage.prices').catch(
        () => null,
      ),
      blockedWhy(db, ctx, p),
    ]);
    const written = p.callConsent.consent === 'opted_in';
    const check = prices?.items.find((i) => i.key === 'lookup.line_type')?.cents;
    const greeting = outboundGreetingOf(blocked.config, workspace.name, null, goal, 'errand');
    return {
      card: settingsCard(toolCallId, 'call_for_me', {
        title: `Have your AI teammate call ${name}?`,
        fields: [
          { label: 'Calling', value: p.phoneE164 ? `${name}, ${formatPhone(p.phoneE164)}` : name },
          { label: 'It starts', value: greeting },
          { label: 'It asks', value: ask },
          { label: 'It may tell them', value: say ?? 'Nothing beyond who it’s calling for' },
          { label: 'When', value: 'Now if you’re open, or when you next open' },
          {
            label: 'Cost',
            value: `The call’s minutes and the AI’s words come from your balance${
              written
                ? ''
                : check !== undefined
                  ? `, plus ${money(check)} to check the number first`
                  : ''
            }`,
          },
        ],
        confirmLabel: blocked.why ? '' : 'Call them',
        warnings: [
          blocked.why
            ? { kind: 'blocked', text: blocked.why }
            : {
                kind: 'note',
                text: written
                  ? `${name} agreed in writing to calls. It never orders, pays or agrees to anything. What they say comes back here and on your phone.`
                  : 'It calls only if the phone company says this is a business landline; if not, I’ll tell you here. It never orders, pays or agrees to anything.',
              },
        ],
      }),
      result: blocked.why ? { blocked: true, why: blocked.why } : { waiting: true, calling: name },
    };
  },

  async commit(db, ctx, args, extra) {
    await mayCall(db, ctx);
    const p = await personOf(db, ctx, args);
    const name = nameOf(p);
    const scope = { workspaceId: ctx.workspaceId, organizationId: ctx.organizationId };
    // The chat it was asked in, where the answer goes, and the asker's first name ("calling for Dale at …").
    const [row] = await asWorker(db, scope, (tx) =>
      rows<{ thread_id: string | null; first_name: string | null }>(
        tx,
        sql`select (select c.thread_id from app.assistant_tool_calls c
                    where c.id = ${/^[0-9a-f-]{36}$/i.test(extra.toolCallId) ? extra.toolCallId : null}::uuid
                      and c.workspace_id = ${ctx.workspaceId} and c.user_id = ${ctx.actor.userId}) as thread_id,
                   (select nullif(split_part(trim(full_name), ' ', 1), '') from app.users
                    where id = ${ctx.actor.userId}) as first_name`,
      ),
    );
    const say = str(args['say']);
    const { output } = await executeCommand(
      db,
      aiCallAskErrand,
      {
        workspaceId: ctx.workspaceId,
        personId: p.id,
        goal: str(args['goal']) ?? 'to ask a quick question',
        ask: str(args['ask']) ?? '',
        ...(say ? { say } : {}),
        askedBy: ctx.actor.userId,
        ...(row?.first_name ? { askerName: row.first_name } : {}),
        threadId: row?.thread_id ?? null,
      },
      systemActor(scope, ctx.actor.userId),
      { correlationId: ctx.correlationId, channel: 'assistant' },
    );
    return {
      outcome: `Calling ${name} now, or when you next open. I’ll tell you here what they said.`,
      href: null,
      command: aiCallAskErrand.name,
      answer: { aiCallId: output.aiCallId, calling: name },
    };
  },
};

export const errandConfirmTools: Record<string, SettingsConfirmTool> = {
  call_for_me: callForMe,
};

/** What the panel says while it runs. */
export const errandStepLabels = { call_for_me: 'Getting the call ready' } as const;
