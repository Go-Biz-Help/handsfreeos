'use client';
import { Check, Pencil, Plus, Star, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Status = Ok<'/v1/queries/phone.setup_status'>;
type NumberInfo = Status['numbers'][number];

/** Somebody who could be rung: everyone in the business who works the inbox. */
export interface Ringable {
  readonly userId: string;
  readonly name: string;
}

/** "Dale and Mike", "Dale, Mike and 2 others" — a list nobody has to count. */
function ringsWords(ids: readonly string[], people: readonly Ringable[]): string {
  if (ids.length === 0) return 'Rings everyone with the inbox';
  const names = ids.map((id) => people.find((p) => p.userId === id)?.name ?? 'someone');
  if (names.length === 1) return `Rings ${names[0]}`;
  if (names.length === 2) return `Rings ${names[0]} and ${names[1]}`;
  return `Rings ${names[0]}, ${names[1]} and ${names.length - 2} other${names.length === 3 ? '' : 's'}`;
}

/** What each status means to somebody looking at a list rather than at a wizard. */
const STATUS_WORD: Readonly<Record<NumberInfo['status'], string>> = {
  provisioning: 'Setting up',
  porting: 'Moving to us',
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
  people,
  canManage,
  onAdd,
}: {
  workspaceId: string;
  numbers: readonly NumberInfo[];
  /** Everyone who works the inbox, for the "who does this ring" list. */
  people: readonly Ringable[];
  canManage: boolean;
  onAdd: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [ringing, setRinging] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);

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
      setRinging(null);
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

  const saveRings = (n: NumberInfo) =>
    call(n.id, '/v1/commands/phone_number.set_members', {
      workspaceId,
      phoneNumberId: n.id,
      userIds: chosen,
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
                  {n.status === 'active' ? ` · ${ringsWords(n.memberUserIds, people)}` : ''}
                </span>
              )}
              {/* Nobody ticked is not nobody rung — it is everyone, which is how a number works until
                  somebody changes it. Said here rather than only in a tooltip, because the empty state of
                  a checkbox list reads as "off" and this one means the opposite. */}
              {ringing === n.id ? (
                <div className="mt-3 rounded-[10px] bg-card-2 p-3">
                  <p className="text-xs text-text-2">
                    Tick the people this number should ring. Tick nobody and it rings everyone with
                    the inbox, which is how it works now.
                  </p>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {people.map((person) => (
                      <Checkbox
                        key={person.userId}
                        checked={chosen.includes(person.userId)}
                        label={person.name}
                        onChange={(e) =>
                          setChosen((was) =>
                            e.target.checked
                              ? [...new Set([...was, person.userId])]
                              : was.filter((id) => id !== person.userId),
                          )
                        }
                        data-testid={`number-rings-${n.id}-${person.userId}`}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void saveRings(n)}
                      disabled={busy === n.id}
                      data-testid={`number-rings-save-${n.id}`}
                    >
                      <Check className="h-3.5 w-3.5" strokeWidth={1.8} />
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRinging(null)}>
                      Cancel
                    </Button>
                    {chosen.length === 0 ? (
                      <span className="text-xs text-text-3">Nobody ticked · rings everyone</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
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
                {n.status === 'active' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRinging(ringing === n.id ? null : n.id);
                      setChosen([...n.memberUserIds]);
                    }}
                    data-testid={`number-rings-${n.id}`}
                  >
                    <Users className="h-3.5 w-3.5" strokeWidth={1.8} />
                    Who it rings
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
