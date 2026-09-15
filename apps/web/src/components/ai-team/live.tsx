'use client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';

/**
 * What the AI teammate pages show: the teammate itself, its drafts and runs, and the catalogs its settings
 * refer to. Someone else's change (or the worker's) refreshes them; the builder keeps unsaved edits and
 * raises "Load their version" instead of losing them.
 */
const LIVE = [
  'ai_teammate',
  'ai_teammate_draft',
  'ai_teammate_run',
  'calendar',
  'chat_widget',
  'knowledge_item',
  'knowledge_profile',
  'workflow',
];

export function AiTeamLive() {
  useLiveRefresh(LIVE);
  return null;
}
