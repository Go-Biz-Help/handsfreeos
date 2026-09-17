import { router, type Href } from 'expo-router';

import { fixerFor, setFixer } from '@/changes/fixers';

import { inputOf } from './outbox';

/**
 * Edit, from "Still send?", the quiet-hours question or Fix and try again, reopens a reply in its conversation with the
 * words back in the composer (`?edit=<change>`). A text made somewhere with no conversation (the test builds' Test
 * changes) keeps the screen that was there before.
 */
export function registerInboxFixers(): void {
  const before = fixerFor('message.send');
  setFixer('message.send', (row) => {
    const conversationId = inputOf(row).conversationId;
    if (typeof conversationId === 'string' && row.workspace_id) {
      router.push(
        `/app/w/${row.workspace_id}/inbox/${conversationId}?edit=${encodeURIComponent(row.id)}` as Href,
      );
      return;
    }
    before?.(row);
  });
}
