'use client';
import { Check, Pencil, Plus, Star } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Status = Ok<'/v1/queries/phone.setup_status'>;
type NumberInfo = Status['numbers'][number];

/** What each status means to somebody looking at a list rather than at a wizard. */
const STATUS_WORD: Readonly<Record<NumberInfo['status'], string>> = {
  provisioning: 'Setting up',
  active: 'In use',
  releasing: 'Being given back',
  released: 'Given back',
  failed: 'Did not go through',
};

/**
 * Every number a business has (M17).
 *
 * It appears **only once there is a reason for it** — a second number, or a first one that is ready and so
 * could be joined by a second. A business part-way through setting up its only number sees the wizard and
 * nothing else, which is the screen that was there before and the one that suits what it is doing.
 *
 * The default is the point of the list. It is the number a *new* conversation goes out from; every existing
 * thread stays on the number the customer wrote to, whoever replies, so changing this never moves a
 * conversation somebody is in the middle of. The sentence under the heading says so, because the obvious
 * guess is the opposite.
 */
export function NumbersCard({
  workspaceId,
  numbers,
  canManage,
  onAdd,
}: {
  workspaceId: string;
  numbers: readonly NumberInfo[];
  canManage: boolean;
  onAdd: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [label, setLabel] = useState('');

  const call = async (what: string, path: string, body: object) => {
    setBusy(what);
    try {
      unwrap(
        await (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
          body,
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      setNaming(null);
    }
  };

  const makeDefault = (n: NumberInfo) =>
    call(n.id, '/v1/commands/phone_number.set_default', {
      workspaceId,
      phoneNumberId: n.id,
    });

  const rename = (n: NumberInfo) =>
    call(n.id, '/v1/commands/phone_number.set_label', {
      workspaceId,
      phoneNumberId: n.id,
      label: label.trim() || null,
    });

  return (
    <Card className="max-w-[820px] px-[22px] py-5" data-testid="numbers-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">Your numbers</h2>
          <p className="mt-1 max-w-[460px] text-[13px] text-text-2">
            New conversations go out from the one marked Default. A conversation already going stays
            on the number that customer wrote to, whoever replies.
          </p>
        </div>
        {canManage ? (
          <Button variant="secondary" onClick={onAdd} data-testid="numbers-add">
            <Plus className="h-4 w-4" strokeWidth={1.8} />
            Add a number
          </Button>
        ) : null}
      </div>

      <div className="mt-3">
        {numbers.map((n) => (
          <div
            key={n.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-3 text-[13px]"
            data-testid={`number-row-${n.id}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{n.display}</span>
                {n.isDefault ? (
                  <Badge variant="accent" data-testid={`number-default-${n.id}`}>
                    Default
                  </Badge>
                ) : null}
                {n.status !== 'active' ? (
                  <Badge variant={n.status === 'failed' ? 'danger' : 'member'}>
                    {STATUS_WORD[n.status]}
                  </Badge>
                ) : null}
              </div>
              {naming === n.id ? (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={label}
                    autoFocus
                    placeholder="Front desk"
                    className="w-[200px]"
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(n);
                      if (e.key === 'Escape') setNaming(null);
                    }}
                    data-testid={`number-label-input-${n.id}`}
                  />
                  <Button
                    size="sm"
                    onClick={() => void rename(n)}
                    disabled={busy === n.id}
                    data-testid={`number-label-save-${n.id}`}
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={1.8} />
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setNaming(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <span className="mt-0.5 block text-xs text-text-3">
                  {n.label ? `${n.label} · ` : ''}
                  {n.numberType === 'toll_free' ? 'Toll-free' : 'Local'}
                </span>
              )}
            </div>
            {canManage && naming !== n.id ? (
              <div className="flex flex-none items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNaming(n.id);
                    setLabel(n.label ?? '');
                  }}
                  data-testid={`number-rename-${n.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {n.label ? 'Rename' : 'Name it'}
                </Button>
                {/* Only a number that can actually send may hold the default, which is also the rule the
                    database keeps — offering it on a failed one would be a button that always errors. */}
                {!n.isDefault && n.status === 'active' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void makeDefault(n)}
                    disabled={busy === n.id}
                    data-testid={`number-make-default-${n.id}`}
                  >
                    <Star className="h-3.5 w-3.5" strokeWidth={1.8} />
                    Make default
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
