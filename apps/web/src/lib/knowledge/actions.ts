'use client';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { KnowledgeItemKind, KnowledgeProfileValue } from '@/lib/api/types';

/** The knowledge commands the screens share. Each throws an ApiError the caller shows. */

export interface SuggestionEdits {
  readonly kind?: Exclude<KnowledgeItemKind, 'document'>;
  readonly title?: string;
  readonly body?: string;
  readonly tags?: string[];
}

export async function acceptSuggestion(
  workspaceId: string,
  suggestionId: string,
  opts: { edits?: SuggestionEdits; status?: 'draft' | 'published' } = {},
) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/knowledge_suggestion.accept', {
      body: {
        workspaceId,
        suggestionId,
        ...(opts.edits ? { edits: opts.edits } : {}),
        status: opts.status ?? 'published',
      },
    }),
  );
}

export async function rejectSuggestion(workspaceId: string, suggestionId: string) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/knowledge_suggestion.reject', {
      body: { workspaceId, suggestionId },
    }),
  );
}

export async function saveProfile(workspaceId: string, profile: KnowledgeProfileValue) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/knowledge.profile_update', {
      body: { workspaceId, profile },
    }),
  );
}
