'use client';
import type { PaymentAccountUse } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow } from '@/lib/api/types';

/** Somebody in the business, and whether their role lets them bill today (owners and admins). */
export interface TeamMember {
  readonly id: string;
  readonly fullName: string;
  readonly bills: boolean;
}

/** "Everyone who bills", "Only Maria and Chris", "Only Maria, and only this account for her". */
export function usedByWords(
  c: Pick<PaymentConnectionRow, 'usedBy' | 'userIds'>,
  team: readonly TeamMember[],
): string {
  if (c.usedBy === 'everyone') return 'Everyone who bills';
  const names = c.userIds.map((id) => team.find((m) => m.id === id)?.fullName ?? 'Former member');
  const who =
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return c.usedBy === 'chosen'
    ? `Only ${who}`
    : `Only ${who}, and only this account for ${names.length === 1 ? 'them' : 'each of them'}`;
}

/**
 * Who may bill into one account (0102): everyone who bills, only the people chosen, or only them — and for them,
 * nothing that is open to everyone. The people offered are the ones who bill today: owners and admins.
 */
export function PaymentAccessDialog({
  workspaceId,
  connection,
  name,
  team,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  connection: PaymentConnectionRow;
  /** What the business calls the account. */
  name: string;
  team: readonly TeamMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [usedBy, setUsedBy] = useState<PaymentAccountUse>(connection.usedBy);
  const [chosen, setChosen] = useState<string[]>([...connection.userIds]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsedBy(connection.usedBy);
    setChosen([...connection.userIds]);
    setError(null);
  }, [open, connection]);

  // Everyone who bills, and anyone already chosen who no longer does (so taking them off is possible).
  const offered = team.filter((m) => m.bills || connection.userIds.includes(m.id));

  async function save() {
    if (usedBy !== 'everyone' && chosen.length === 0)
      return setError('Pick who uses this account.');
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/payment_connection.set_access', {
          body: {
            workspaceId,
            connectionId: connection.id,
            usedBy,
            userIds: usedBy === 'everyone' ? [] : chosen,
          },
        }),
      );
      toast.success('Saved.');
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Who can use ${name}`}
        description="Pick who can send invoices and start plans paid into this account."
        className="w-[min(520px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto"
      >
        <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Who can use it">
          <RadioCard
            selected={usedBy === 'everyone'}
            onSelect={() => setUsedBy('everyone')}
            title="Everyone who bills"
            description="The whole team can use it, unless someone is kept to their own account."
            testId="pay-access-everyone"
          />
          <RadioCard
            selected={usedBy === 'chosen'}
            onSelect={() => setUsedBy('chosen')}
            title="Only the people you pick"
            description="Nobody else can use it. They can still use accounts open to everyone."
            testId="pay-access-chosen"
          />
          <RadioCard
            selected={usedBy === 'only_theirs'}
            onSelect={() => setUsedBy('only_theirs')}
            title="Only the people you pick, and only this account for them"
            description="Nobody else can use it, and they can’t use accounts open to everyone."
            testId="pay-access-only-theirs"
          />
        </div>
        {usedBy === 'everyone' ? null : (
          <fieldset className="mt-4" data-testid="pay-access-people">
            <legend className="mb-2 text-[13px] font-medium">Who</legend>
            <div className="flex flex-col gap-2">
              {offered.map((m) => (
                <Checkbox
                  key={m.id}
                  label={m.bills ? m.fullName : `${m.fullName} (can’t bill)`}
                  checked={chosen.includes(m.id)}
                  onChange={(e) =>
                    setChosen((ids) =>
                      e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                    )
                  }
                />
              ))}
            </div>
            <p className="mt-2 text-[12.5px] text-text-3">
              Owners and admins send invoices and start plans. To let someone bill, make them an
              admin under Members.
            </p>
            {error ? (
              <p role="alert" className="mt-2 text-[12.5px] text-danger-text">
                {error}
              </p>
            ) : null}
          </fieldset>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void save()} data-testid="pay-access-save">
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
