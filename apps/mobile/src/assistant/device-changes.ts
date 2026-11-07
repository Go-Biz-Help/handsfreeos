import {
  DEVICE_CHANGE_WORDS_MAX,
  DEVICE_CHANGES_LISTED,
  type AssistantDeviceChanges,
} from '@hfos/core';

import type { ChangeItem, ChangeList } from '@/changes/list';

/**
 * Changes on this phone, as that screen lists them, for a question asked here: the outbox never reached HandsFreeOS,
 * so the Assistant knows it only from what the phone says. Titles and why each one waits, never what was written.
 */

const cut = (words: string): string =>
  words.length > DEVICE_CHANGE_WORDS_MAX
    ? `${words.slice(0, DEVICE_CHANGE_WORDS_MAX - 1)}…`
    : words;

/** Why a change waits on the person, as its row's pill and box say it. */
export function whyItNeedsYou(item: ChangeItem): string {
  const { row } = item;
  if (row.state === 'refused') return `Refused: ${row.reason ?? 'HandsFreeOS couldn’t do this.'}`;
  if (item.ask === 'still-send')
    return 'Still send? It waited a while, so it asks before it goes (Send, Edit or Discard).';
  if (item.ask === 'quiet-hours')
    return 'Quiet hours: it asks whether to send it now or once they end.';
  return row.reason ? `Needs them to decide: ${row.reason}` : 'Needs them to decide.';
}

/**
 * What Changes on this phone shows now, for the Assistant, in the business the question is asked in. The screen lists
 * every business the person is signed in to, so another business's changes stay out of this one's chat.
 */
export function deviceChangesOf(list: ChangeList, workspaceId: string): AssistantDeviceChanges {
  const mine = (item: ChangeItem) => item.row.workspace_id === workspaceId;
  const needsYou = list.needsYou.filter(mine);
  return {
    waiting: list.waiting.filter(mine).length,
    needsYou: needsYou.slice(0, DEVICE_CHANGES_LISTED).map((item) => ({
      title: cut(item.words.title),
      why: cut(whyItNeedsYou(item)),
    })),
    moreNeedYou: Math.max(0, needsYou.length - DEVICE_CHANGES_LISTED),
    sentJustNow: list.sent
      .filter((group) => group.workspaceId === workspaceId)
      .slice(0, DEVICE_CHANGES_LISTED)
      .map((group) => cut(group.line ? `${group.title} · ${group.line}` : group.title)),
  };
}
