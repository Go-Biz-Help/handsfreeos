'use client';
import { MoreHorizontal, Star, UserMinus, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

interface Person {
  readonly id: string;
  readonly fullName: string;
}

/**
 * Who a customer is assigned to (0103): the owner, marked Main, and everyone else on them — one person installing
 * a client's automations while another runs their SEO. Being on a customer shows a member its bills and threads,
 * so owners and admins add and take people off (records.assign); everyone else sees who is on it. One at a time,
 * so two people doing it at once both land.
 */
export function AssignedCard({
  workspaceId,
  recordType,
  recordId,
  owner,
  team,
  members,
  canEdit,
}: {
  workspaceId: string;
  recordType: 'person' | 'company';
  recordId: string;
  owner: Person | null;
  team: readonly Person[];
  /** Everyone who can be assigned: the business's people. */
  members: readonly Person[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const assigned = [...(owner ? [owner] : []), ...team];
  const free = members.filter((m) => !assigned.some((a) => a.id === m.id));
  const noun = recordType === 'person' ? 'customer' : 'company';

  async function change(kind: 'assign' | 'unassign', userId: string, main = false) {
    setBusy(true);
    try {
      const ref = { workspaceId, recordType, recordId, userId };
      if (kind === 'assign')
        unwrap(await apiBrowser().POST('/v1/commands/record.assign', { body: { ...ref, main } }));
      else unwrap(await apiBrowser().POST('/v1/commands/record.unassign', { body: ref }));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 md:p-5" data-testid="assigned-card">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">Assigned to</h3>
        {assigned.length > 1 ? (
          <span className="text-[13px] text-text-3">{assigned.length} people</span>
        ) : null}
      </div>
      {assigned.length === 0 ? (
        <p className="text-[13px] text-text-2">
          {canEdit ? 'Nobody yet. Anyone on the team can be added.' : 'Nobody yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="assigned-list">
          {assigned.map((p, i) => (
            <li key={p.id} className="flex items-center gap-2.5 text-[13px]">
              <Avatar name={p.fullName} seed={p.id} size="sm" />
              <span className="min-w-0 flex-1 truncate">{p.fullName}</span>
              {i === 0 && owner ? (
                <Badge variant="gray" title={`The ${noun}’s owner`}>
                  Main
                </Badge>
              ) : null}
              {canEdit ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Change ${p.fullName}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-menu text-text-3 hover:bg-card-2 hover:text-text"
                      data-testid={`assigned-menu-${p.id}`}
                    >
                      <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {i === 0 && owner ? null : (
                      <DropdownMenuItem onSelect={() => void change('assign', p.id, true)}>
                        <Star className="h-4 w-4" strokeWidth={1.5} />
                        Make main
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem danger onSelect={() => void change('unassign', p.id)}>
                      <UserMinus className="h-4 w-4" strokeWidth={1.5} />
                      Take off this {noun}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && free.length > 0 ? (
        <div className="mt-3 flex items-center gap-2">
          <UserPlus className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
          <Select
            selectSize="sm"
            aria-label={`Assign this ${noun} to`}
            value=""
            disabled={busy}
            onChange={(e) => e.target.value && void change('assign', e.target.value)}
            data-testid="assign-add"
          >
            <option value="">{assigned.length ? 'Add someone else…' : 'Assign to…'}</option>
            {free.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </Card>
  );
}
