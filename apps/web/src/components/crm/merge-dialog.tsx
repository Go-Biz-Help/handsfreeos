'use client';
import { ArrowLeftRight, Merge } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { mergedDetails, mergeSideOf } from '@hfos/core';
import { CustomerPicker, type PickedCustomer } from '@/components/calendar/customer-picker';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PersonDetail } from '@/lib/api/types';
import { Callout } from './chips';

/** Who one side of the merge is, so two records with the same name can be told apart. */
function Side({ label, person, testId }: { label: string; person: PersonDetail; testId: string }) {
  const detail = [person.email, person.phone, person.address.city].filter(Boolean).join(' · ');
  return (
    <div
      className="min-w-0 flex-1 rounded-menu border border-border px-3 py-2.5"
      data-testid={testId}
    >
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <Avatar name={person.fullName} seed={person.id} size="sm" />
        <span className="min-w-0 truncate text-[14px] font-medium">{person.fullName}</span>
      </div>
      <div className="mt-0.5 truncate text-[12.5px] text-text-3">
        {detail || 'No contact details'}
      </div>
    </div>
  );
}

/**
 * Merge two records for the same customer (person.merge): pick the other record, choose which one to keep, and
 * everything on the other one moves to it. The one merged in is archived and can't be brought back.
 */
export function MergeDialog({
  workspaceId,
  person,
  open,
  onOpenChange,
  initialOtherId = null,
}: {
  workspaceId: string;
  person: PersonDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The other record, chosen already: Compare and merge on a search's duplicate banner (`?merge=<id>`). */
  initialOtherId?: string | null;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const [other, setOther] = useState<PersonDetail | null>(null);
  // The record this page is for is kept unless the person swaps them.
  const [keepThis, setKeepThis] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !initialOtherId || initialOtherId === person.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/person.get', {
            body: { workspaceId, personId: initialOtherId },
          }),
        );
        if (cancelled) return;
        setOther(out.person);
        setPicked({
          id: out.person.id,
          fullName: out.person.fullName,
          detail: out.person.phone ?? out.person.email,
        });
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialOtherId, person.id, workspaceId]);

  useEffect(() => {
    if (!picked) {
      setOther(null);
      return;
    }
    // Chosen already, with its record read (`initialOtherId`).
    if (other?.id === picked.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/person.get', {
            body: { workspaceId, personId: picked.id },
          }),
        );
        if (!cancelled) setOther(out.person);
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [picked, other, workspaceId]);

  const reset = () => {
    setPicked(null);
    setOther(null);
    setKeepThis(true);
  };
  const keep = other ? (keepThis ? person : other) : null;
  const dup = other ? (keepThis ? other : person) : null;
  const filled = keep && dup ? mergedDetails(mergeSideOf(keep), mergeSideOf(dup)).filled : [];

  async function merge() {
    if (!keep || !dup) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/person.merge', {
          body: { workspaceId, personId: dup.id, intoPersonId: keep.id },
        }),
      );
      toast.success(`Merged ${dup.fullName} into ${keep.fullName}.`);
      onOpenChange(false);
      reset();
      if (keep.id === person.id) router.refresh();
      else router.push(`/app/w/${workspaceId}/customers/people/${keep.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent
        title="Merge customers"
        description="Two records for the same customer become one. Everything on the one you merge in moves to the one you keep."
      >
        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="merge-with" className="mb-1.5 block text-[13px] font-medium">
              The other record
            </label>
            <CustomerPicker
              id="merge-with"
              workspaceId={workspaceId}
              value={picked}
              onChange={(next) => {
                setPicked(next);
                setKeepThis(true);
              }}
              exceptId={person.id}
            />
          </div>
          {keep && dup ? (
            <>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <Side label="Keep" person={keep} testId="merge-keep" />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Swap which one is kept"
                  className="self-center"
                  onClick={() => setKeepThis((k) => !k)}
                  data-testid="merge-swap"
                >
                  <ArrowLeftRight className="h-4 w-4" strokeWidth={1.5} />
                </Button>
                <Side label="Merge in, then archive" person={dup} testId="merge-dup" />
              </div>
              <Callout tone="neutral" icon={Merge} data-testid="merge-summary">
                <span>
                  {dup.fullName}’s leads, tasks, timeline, conversations, calls, bookings, bills,
                  files and tags move to {keep.fullName}.{' '}
                  {filled.length
                    ? `Filled in on ${keep.fullName} from ${dup.fullName}: ${filled.join(', ')}.`
                    : `${keep.fullName} keeps their own details.`}{' '}
                  {dup.fullName} is archived and can’t be brought back.
                </span>
              </Callout>
            </>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!keep || !dup}
            onClick={() => void merge()}
            data-testid="merge-confirm"
          >
            Merge
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
