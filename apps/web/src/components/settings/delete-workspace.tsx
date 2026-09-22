'use client';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Delete this business, on Settings → Workspace, for owners. Typing the business's name confirms it. The business
 * is hidden from everybody at once and the worker deletes it within moments: its customers, messages, calls,
 * calendars, money, workflows, files and history, with its phone numbers released.
 */
export function DeleteWorkspace({ workspaceId, name }: { workspaceId: string; name: string }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  async function remove() {
    setError(null);
    if (!matches) {
      setError('Type the business’s name exactly as it is shown.');
      return;
    }
    setDeleting(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/workspace.delete', {
          body: { workspaceId, confirmName: typed.trim() },
        }),
      );
      // A full load, not a client navigation: every cached page of this business is gone with it.
      window.location.assign('/app');
    } catch (e) {
      setDeleting(false);
      setError(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="delete-workspace">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Delete this business</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Deletes {name} and everything in it for everyone: customers, conversations, calls and
          recordings, calendars and bookings, estimates and invoices, workflows, forms, files and
          its history. Its phone numbers are released, and a connected payment account, sending
          domain and web address are disconnected. Any usage balance left is lost. This can’t be
          undone.
        </p>
      </div>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <Field label={`Type ${name} to confirm`} htmlFor="delete-confirm-workspace" error={error}>
          <Input
            id="delete-confirm-workspace"
            autoComplete="off"
            placeholder={name}
            value={typed}
            invalid={!!error}
            onChange={(e) => setTyped(e.target.value)}
            className="max-w-[360px]"
            data-testid="delete-workspace-confirm"
          />
        </Field>
        <div>
          <Button
            type="submit"
            variant="danger"
            loading={deleting}
            disabled={!matches}
            data-testid="delete-workspace-button"
          >
            {deleting ? null : <Trash2 className="h-4 w-4" strokeWidth={1.5} />}
            Delete business
          </Button>
        </div>
      </form>
    </div>
  );
}
