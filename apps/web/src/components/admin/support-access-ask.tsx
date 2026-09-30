'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Asking a business to see its private records (Real Estate step 4), from support's look at it. Its owners and
 * admins, and the main person on each private record, are emailed; nothing is shown until one of them says yes.
 */
export function SupportAccessAsk({ workspaceId }: { workspaceId: string }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  async function ask() {
    setBusy(true);
    setSaid(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/support_access.request', {
          body: { workspaceId, note },
        }),
      );
      setSaid(
        'Asked. Its owners, admins and deal agents were emailed; you’ll see the records once one says yes.',
      );
      setNote('');
    } catch (e) {
      setSaid(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-support-access"
    >
      <h2 className="text-sm font-semibold">Private records</h2>
      <p className="mt-1 text-[13px] text-text-3">
        A look shows none of their private records, like deals. Open a look first, then ask; say
        what you need to check.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="The closing date on one deal looks wrong"
          aria-label="What you need to check"
        />
        <Button disabled={busy || !note.trim()} onClick={() => void ask()}>
          Ask to see them
        </Button>
      </div>
      {said ? <p className="mt-2 text-[13px]">{said}</p> : null}
    </section>
  );
}
