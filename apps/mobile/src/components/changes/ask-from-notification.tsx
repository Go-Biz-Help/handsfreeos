import * as React from 'react';

import {
  AskSheet,
  QuietHoursSheet,
  StillSendSheet,
  type Decided,
} from '@/components/changes/decide-sheets';
import { toast } from '@/components/ui/toast';
import { changes } from '@/changes';
import { describe, loadNames } from '@/changes/describe';
import { fixerFor } from '@/changes/fixers';
import { askOf } from '@/changes/list';
import { pendingLinks, usePendingAsk } from '@/links/pending';

/**
 * A notification's button whose change asks something first (quiet hours, "Still send?", another question the API
 * asked): the conversation opens, and the question is asked over it, with the same sheets as Changes on this phone.
 */
export function AskFromNotification() {
  const changeId = usePendingAsk();
  const [asking, setAsking] = React.useState<{
    kind: 'still-send' | 'quiet-hours' | 'other';
    decided: Decided;
  } | null>(null);

  React.useEffect(() => {
    if (!changeId) return;
    const open = changes.open;
    if (!open) return;
    pendingLinks.takeAsk();
    void (async () => {
      const row = await open.outbox.get(changeId);
      if (!row || row.state !== 'ask') return;
      const names = await loadNames(open.db, [row]);
      const kind = askOf(row, Date.now()) ?? 'other';
      // The link's screen opens first; the question comes up over it.
      setTimeout(() => setAsking({ kind, decided: { row, words: describe(row, names) } }), 350);
    })().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  }, [changeId]);

  const close = () => setAsking(null);
  const sheet = (kind: 'still-send' | 'quiet-hours' | 'other') =>
    asking?.kind === kind ? asking.decided : null;
  const edit = asking ? fixerFor(asking.decided.row.name) : null;
  const discard = (decided: Decided) => {
    close();
    void changes
      .discard([decided.row.id])
      .then(() => toast.show('Discarded. Nothing was sent.'))
      .catch((error: unknown) => toast.error(String(error)));
  };

  return (
    <>
      <StillSendSheet
        decided={sheet('still-send')}
        onClose={close}
        onEdit={edit}
        onDiscard={discard}
      />
      <QuietHoursSheet decided={sheet('quiet-hours')} onClose={close} onEdit={edit} />
      <AskSheet decided={sheet('other')} onClose={close} onEdit={edit} onDiscard={discard} />
    </>
  );
}
