'use client';
import { ARCHIVE_WORDS } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { Callout } from './chips';

/**
 * Archive (or restore) a person or company. Open leads or tasks block the first attempt; the second
 * confirms archiving the leads too. Everything is recorded in the audit log.
 */
export function ArchiveDialog({
  workspaceId,
  kind,
  recordId,
  name,
  archived,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  kind: 'person' | 'company';
  recordId: string;
  name: string;
  archived: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{ openLeads: number; openTasks: number } | null>(null);
  const ids = kind === 'person' ? { personId: recordId } : { companyId: recordId };

  async function run(force: boolean) {
    setBusy(true);
    try {
      if (archived) {
        if (kind === 'person')
          unwrap(
            await apiBrowser().POST('/v1/commands/person.restore', {
              body: { workspaceId, personId: recordId },
            }),
          );
        else
          unwrap(
            await apiBrowser().POST('/v1/commands/company.restore', {
              body: { workspaceId, companyId: recordId },
            }),
          );
        toast.success(`${name} restored.`);
      } else {
        if (kind === 'person')
          unwrap(
            await apiBrowser().POST('/v1/commands/person.archive', {
              body: { workspaceId, personId: recordId, force },
            }),
          );
        else
          unwrap(
            await apiBrowser().POST('/v1/commands/company.archive', {
              body: { workspaceId, companyId: recordId, force },
            }),
          );
        toast.success(`${name} archived.`);
      }
      onOpenChange(false);
      setBlocked(null);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'has_open_work') {
        const d = (e.details ?? {}) as { openLeads?: number; openTasks?: number };
        setBlocked({ openLeads: d.openLeads ?? 0, openTasks: d.openTasks ?? 0 });
      } else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  void ids;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setBlocked(null);
      }}
    >
      <DialogContent
        title={archived ? `Restore ${name}?` : `Archive ${name}?`}
        description={archived ? ARCHIVE_WORDS.restoreCustomer : ARCHIVE_WORDS.archiveCustomer}
      >
        {blocked ? (
          <Callout className="mt-4" data-testid="archive-blocked">
            <strong>{name} still has open work:</strong>{' '}
            {[
              blocked.openLeads
                ? `${blocked.openLeads} open lead${blocked.openLeads === 1 ? '' : 's'}`
                : null,
              blocked.openTasks
                ? `${blocked.openTasks} open task${blocked.openTasks === 1 ? '' : 's'}`
                : null,
            ]
              .filter(Boolean)
              .join(' and ')}
            . Archiving anyway also archives the open leads.
          </Callout>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {archived ? (
            <Button loading={busy} onClick={() => void run(false)} data-testid="restore-confirm">
              Restore
            </Button>
          ) : blocked ? (
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void run(true)}
              data-testid="archive-force"
            >
              Archive anyway
            </Button>
          ) : (
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void run(false)}
              data-testid="archive-confirm"
            >
              Archive
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
