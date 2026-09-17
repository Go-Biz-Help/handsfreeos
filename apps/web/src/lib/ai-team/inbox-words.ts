/**
 * The plain words the inbox, Approvals and Home use for the AI teammate: its labels, why it handed a
 * conversation to a person, what a draft will do, when it expires, and why a decision was refused. The words
 * live in core (shared with the phone app, M10) and are re-exported here; the teammate's settings readers stay.
 */
import { parseTeammateConfig, type TeammateConfig } from '@hfos/core';
import type { TeammateGetOut } from './inbox-types';

export {
  aiName,
  CHANNEL_WORD,
  decideRefusal,
  draftActionLine,
  draftShort,
  draftTitle,
  expiresLine,
  firstNameOf,
  handoffWhy,
  progressShort,
  teammateLabel,
} from '@hfos/core';

/** The teammate's settings, or null when they can't be read here. */
export function teammateConfigOf(raw: unknown): TeammateConfig | null {
  try {
    return parseTeammateConfig(raw);
  } catch {
    return null;
  }
}

/**
 * The teammate texts new leads itself (its Respond skill, by text), so a workflow that texts them too makes
 * two first texts. The same test as the teammate's own `double_texting` warning.
 */
export function teammateTextsNewLeads(config: TeammateConfig | null): boolean {
  if (!config) return false;
  const r = config.respond;
  return r.enabled && r.newLeads.enabled && r.newLeads.channel === 'sms' && config.channels.sms;
}

/** What the inbox, Approvals and the workflow editor need to know about the teammate. */
export interface TeammateBrief {
  readonly id: string;
  readonly name: string;
  readonly status: 'off' | 'training' | 'automatic';
  readonly progress: TeammateGetOut['progress'];
  /** Owners and admins: they decide approval drafts and change the teammate. */
  readonly canManage: boolean;
  /** Its Respond skill texts new leads (the double-texting warning). */
  readonly textsNewLeads: boolean;
}

export function teammateBriefOf(got: TeammateGetOut): TeammateBrief | null {
  if (!got.teammate) return null;
  return {
    id: got.teammate.id,
    name: got.teammate.name,
    status: got.teammate.status,
    progress: got.progress,
    canManage: got.canManage,
    textsNewLeads: teammateTextsNewLeads(teammateConfigOf(got.teammate.config)),
  };
}
