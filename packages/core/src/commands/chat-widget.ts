/**
 * Website chat widgets (channels.manage: owners and admins): the sites a widget shows on, how it looks,
 * who answers, what it asks visitors for, pausing it, and a new public key that retires older snippets. The
 * worker records where the widget was last seen installed.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { chatWidgets, workspaces } from '@hfos/db/schema';
import { loadTeammate } from '../ai-team/load';
import { chatWidgetName, normalizeChatOrigins } from '../chat/origins';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { lookOf } from '../look/look';
import {
  ChatAskFor,
  chatAskForOf,
  ChatWidgetCreateInput,
  ChatWidgetCreateOutput,
  ChatWidgetPauseOutput,
  ChatWidgetRecordSeenInput,
  ChatWidgetRecordSeenOutput,
  ChatWidgetRefInput,
  ChatWidgetRotateKeyOutput,
  ChatWidgetUpdateInput,
  ChatWidgetUpdateOutput,
} from '../schemas/chat';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The typed sites as exact origins with their www twins, or a validation error on each refused entry. */
function originsOrThrow(typed: readonly string[]): string[] {
  const { origins, issues } = normalizeChatOrigins(typed);
  if (issues.length)
    throw HfosError.validation(
      issues.map((i) => ({
        path: i.index === null ? 'allowedOrigins' : `allowedOrigins.${i.index}`,
        message: i.message,
      })),
    );
  return origins;
}

/** A named teammate must be this business's live one. */
async function assertOwnTeammate(ctx: CommandContext, teammateId: string | null | undefined) {
  if (!teammateId) return;
  if (!(await loadTeammate(ctx.tx, ctx.scope.workspaceId!, { teammateId })))
    throw HfosError.validation([
      {
        path: 'teammateId',
        message: 'That AI teammate isn’t in this business anymore. Pick another one.',
      },
    ]);
}

async function loadWidget(ctx: CommandContext, widgetId: string) {
  const [w] = await ctx.tx
    .select()
    .from(chatWidgets)
    .where(and(eq(chatWidgets.id, widgetId), eq(chatWidgets.workspaceId, ctx.scope.workspaceId!)));
  if (!w)
    throw HfosError.notFound(
      'That chat widget isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return w;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const chatWidgetCreate = defineCommand({
  name: 'chat_widget.create',
  description:
    'Add a website chat widget: the sites it shows on (the www version is added for you), how it looks, who answers, and what it asks visitors for. Returns the public key for the snippet.',
  risk: 2,
  input: ChatWidgetCreateInput,
  output: ChatWidgetCreateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['chat_widget.created'],
  async handler(ctx, input) {
    const allowedOrigins = originsOrThrow(input.allowedOrigins);
    await assertOwnTeammate(ctx, input.teammateId);
    // A new widget starts in the business's colour (look/look.ts) unless it's given one.
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.scope.workspaceId!));
    const accentColor = input.accentColor?.toLowerCase() ?? lookOf(w?.settings).color?.hex;
    const [row] = await ctx.tx
      .insert(chatWidgets)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        allowedOrigins,
        teammateId: input.teammateId ?? null,
        greeting: input.greeting ?? null,
        launcherLabel: input.launcherLabel,
        accentColor,
        position: input.position,
        awayMessage: input.awayMessage ?? null,
        askFor: input.askFor ?? ChatAskFor.parse({}),
        smsConsent: input.smsConsent,
        dailyCap: input.dailyCap,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: chatWidgets.id, publicKey: chatWidgets.publicKey });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'chat_widget.created',
      entityType: 'chat_widget',
      entityId: row.id,
      payload: { widgetId: row.id, teammateId: input.teammateId ?? null },
      after: { name: chatWidgetName(allowedOrigins), allowedOrigins },
    });
    return { widgetId: row.id, publicKey: row.publicKey, allowedOrigins };
  },
});

export const chatWidgetUpdate = defineCommand({
  name: 'chat_widget.update',
  description:
    'Change a website chat widget: its sites, look, greeting and away message, who answers, what it asks visitors for, SMS consent and daily limit. Only the fields sent change.',
  risk: 2,
  input: ChatWidgetUpdateInput,
  output: ChatWidgetUpdateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['chat_widget.updated'],
  // The system adds the business's own domain to a chat on its pages here once the domain is serving
  // (the worker's chat/own-domain.ts).
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const w = await loadWidget(ctx, input.widgetId);
    const patch: Record<string, unknown> = {};
    const put = (key: keyof typeof w, value: unknown) => {
      if (value !== undefined && !same(value, w[key])) patch[key] = value;
    };
    if (input.allowedOrigins !== undefined)
      put('allowedOrigins', originsOrThrow(input.allowedOrigins));
    if (input.teammateId !== undefined) {
      await assertOwnTeammate(ctx, input.teammateId);
      put('teammateId', input.teammateId);
    }
    put('greeting', input.greeting);
    put('launcherLabel', input.launcherLabel);
    put('accentColor', input.accentColor?.toLowerCase());
    put('position', input.position);
    put('awayMessage', input.awayMessage);
    if (input.askFor) {
      // Compared in one key order: the database keeps jsonb keys in its own.
      const current = chatAskForOf(w.askFor);
      const next = { ...current, ...stripUndefined(input.askFor) };
      if (!same(next, current)) patch.askFor = next;
    }
    put('smsConsent', input.smsConsent);
    put('dailyCap', input.dailyCap);
    const updated = Object.keys(patch);
    if (updated.length === 0)
      return { widgetId: w.id, updated: [], allowedOrigins: w.allowedOrigins };
    await ctx.tx.update(chatWidgets).set(patch).where(eq(chatWidgets.id, w.id));
    const allowedOrigins = (patch.allowedOrigins as string[] | undefined) ?? w.allowedOrigins;
    const before: Record<string, unknown> = {};
    for (const k of updated) before[k] = w[k as keyof typeof w];
    await ctx.emit({
      type: 'chat_widget.updated',
      entityType: 'chat_widget',
      entityId: w.id,
      payload: { widgetId: w.id, fields: updated },
      before,
      after: { name: chatWidgetName(allowedOrigins), ...patch },
    });
    return { widgetId: w.id, updated, allowedOrigins };
  },
});

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const chatWidgetPause = defineCommand({
  name: 'chat_widget.pause',
  description:
    'Pause a website chat widget: visitors can’t start or send chats until it’s resumed. The snippet can stay on the site.',
  risk: 1,
  input: ChatWidgetRefInput,
  output: ChatWidgetPauseOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['chat_widget.paused'],
  async handler(ctx, input) {
    const w = await loadWidget(ctx, input.widgetId);
    if (w.pausedAt) return { widgetId: w.id, paused: true };
    await ctx.tx.update(chatWidgets).set({ pausedAt: new Date() }).where(eq(chatWidgets.id, w.id));
    await ctx.emit({
      type: 'chat_widget.paused',
      entityType: 'chat_widget',
      entityId: w.id,
      payload: { widgetId: w.id },
      before: { paused: false },
      after: { name: chatWidgetName(w.allowedOrigins), paused: true },
    });
    return { widgetId: w.id, paused: true };
  },
});

export const chatWidgetResume = defineCommand({
  name: 'chat_widget.resume',
  description: 'Turn a paused website chat widget back on.',
  risk: 1,
  input: ChatWidgetRefInput,
  output: ChatWidgetPauseOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['chat_widget.resumed'],
  async handler(ctx, input) {
    const w = await loadWidget(ctx, input.widgetId);
    if (!w.pausedAt) return { widgetId: w.id, paused: false };
    await ctx.tx.update(chatWidgets).set({ pausedAt: null }).where(eq(chatWidgets.id, w.id));
    await ctx.emit({
      type: 'chat_widget.resumed',
      entityType: 'chat_widget',
      entityId: w.id,
      payload: { widgetId: w.id },
      before: { paused: true },
      after: { name: chatWidgetName(w.allowedOrigins), paused: false },
    });
    return { widgetId: w.id, paused: false };
  },
});

export const chatWidgetRotateKey = defineCommand({
  name: 'chat_widget.rotate_key',
  description:
    'Give a website chat widget a new public key. Every snippet pasted before stops working, so paste the new one.',
  risk: 2,
  input: ChatWidgetRefInput,
  output: ChatWidgetRotateKeyOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['chat_widget.key_rotated'],
  async handler(ctx, input) {
    const w = await loadWidget(ctx, input.widgetId);
    const [row] = await rows<{ public_key: string }>(
      ctx.tx,
      sql`update app.chat_widgets set public_key = private.new_chat_widget_key()
          where id = ${w.id} and workspace_id = ${w.workspaceId} returning public_key`,
    );
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'chat_widget.key_rotated',
      entityType: 'chat_widget',
      entityId: w.id,
      payload: { widgetId: w.id },
      after: { name: chatWidgetName(w.allowedOrigins) },
    });
    return { widgetId: w.id, publicKey: row.public_key };
  },
});

export const chatWidgetRecordSeen = defineCommand({
  name: 'chat_widget.record_seen',
  description:
    'Worker: the chat window loaded on one of the widget’s sites (the install check, "Seen on acme.com 3 min ago"). At most once a minute per site.',
  risk: 0,
  input: ChatWidgetRecordSeenInput,
  output: ChatWidgetRecordSeenOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const w = await loadWidget(ctx, input.widgetId);
    if (!w.allowedOrigins.includes(input.origin)) return { widgetId: w.id, recorded: false };
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.chat_widgets set last_seen_origin = ${input.origin}, last_seen_at = now()
          where id = ${w.id} and (last_seen_at is null or last_seen_at < now() - interval '1 minute'
            or last_seen_origin is distinct from ${input.origin})
          returning id`,
    );
    return { widgetId: w.id, recorded: !!row };
  },
});
