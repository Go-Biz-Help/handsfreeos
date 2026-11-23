import {
  chatSetupContextFrom,
  chatSetupTeammateOf,
  lookOf,
  type ChatSetupAnswers,
  type ChatSetupContext,
  type ChatSetupWidget,
} from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { logoSrc } from '@/look/calls';

/** The answers as they were left, and when. */
export interface ChatGuidedDraft {
  readonly answers: Record<string, unknown> | null;
  readonly savedAt: string | null;
}

/** What the setup needs: the context core works the answers out from, and the logo for the preview. */
export interface ChatSetupLoaded {
  readonly ctx: ChatSetupContext;
  readonly logo: { readonly url: string; readonly width: number; readonly height: number } | null;
}

/**
 * The guided website chat setup's calls from the phone (the owner, 23 Nov 2026, W4 b), as the web's page makes them:
 * the business (its website, colour and logo), its first chat, the AI teammate and which chat its Website chat answers,
 * the answers as they were left, and Turn on website chat (chat_setup.save). All of them need signal.
 */
export function chatSetupCalls(workspaceId: string) {
  const body = { body: { workspaceId } };
  return {
    load: async (): Promise<ChatSetupLoaded> => {
      const [ws, widgets, team] = await Promise.all([
        api.POST('/v1/queries/workspace.get', body).then(unwrap),
        api.POST('/v1/queries/chat_widget.list', body).then(unwrap),
        api.POST('/v1/queries/ai_teammate.get', body).then(unwrap),
      ]);
      const settings = (ws.workspace.settings ?? {}) as Record<string, unknown>;
      const look = lookOf(settings);
      const website = typeof settings['website'] === 'string' ? settings['website'] || null : null;
      const t = team.teammate;
      return {
        ctx: chatSetupContextFrom({
          // The first chat, as Settings → Website chat shows it; more chats are in Forms on the web.
          widget: (widgets.items[0] ?? null) as ChatSetupWidget | null,
          teammate: chatSetupTeammateOf(
            t ? { id: t.id, name: t.name, status: t.status, config: t.config } : null,
          ),
          website,
          brandColor: look.color?.hex ?? null,
          hasLogo: !!look.logo,
        }),
        logo: look.logo
          ? { url: logoSrc(look.logo.path), width: look.logo.width, height: look.logo.height }
          : null,
      };
    },
    /**
     * The answers as they were left (guided_setup.get_draft). Only a head start: a read that fails starts from the
     * first question.
     */
    draft: async (): Promise<ChatGuidedDraft> => {
      try {
        const got = unwrap(
          await api.POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'chat' },
          }),
        );
        return { answers: got.answers ?? null, savedAt: got.savedAt ?? null };
      } catch {
        return { answers: null, savedAt: null };
      }
    },
    save: async (widgetId: string | null, answers: ChatSetupAnswers) =>
      unwrap(
        await api.POST('/v1/commands/chat_setup.save', {
          body: { workspaceId, widgetId, answers },
        }),
      ),
  };
}

export type ChatSetupCalls = ReturnType<typeof chatSetupCalls>;
