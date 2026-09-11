'use client';
import { LogOut, MoreHorizontal, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Member, Role } from '@/lib/api/types';
import { ROLE_OPTIONS, roleRank } from './roles';

export function MembersTable({
  workspaceId,
  members,
  myRole,
  myUserId,
}: {
  workspaceId: string;
  members: Member[];
  myRole: Role;
  myUserId: string;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Member | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canManage = myRole === 'owner' || myRole === 'admin';

  async function changeRole(m: Member, role: Role) {
    setBusy(m.userId);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/membership.change_role', {
          body: { workspaceId, userId: m.userId, role },
        }),
      );
      toast.success(
        `${m.fullName || m.email} is now ${ROLE_OPTIONS.find((o) => o.value === role)?.label}. Recorded in the audit log.`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function remove(m: Member) {
    const leaving = m.userId === myUserId;
    setBusy(m.userId);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/membership.remove', {
          body: { workspaceId, userId: m.userId },
        }),
      );
      setConfirm(null);
      if (leaving) {
        toast.success('You left the workspace.');
        router.replace('/app');
      } else {
        toast.success(`${m.fullName || m.email} removed.`);
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card className="overflow-x-auto p-0">
        <table
          className="w-full min-w-[640px] border-separate border-spacing-0"
          data-testid="members-table"
        >
          <thead>
            <tr className="whitespace-nowrap text-left text-xs font-medium tracking-wide text-text-3">
              <th className="rounded-tl-card border-b border-border bg-card-2 px-4 py-2.5">
                Person
              </th>
              <th className="border-b border-border bg-card-2 px-4 py-2.5">Role</th>
              <th className="border-b border-border bg-card-2 px-4 py-2.5">Joined</th>
              <th className="w-14 rounded-tr-card border-b border-border bg-card-2 px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.userId === myUserId;
              const editable = canManage && !isSelf && roleRank(m.role) <= roleRank(myRole);
              return (
                <tr key={m.userId} data-testid={`member-row-${m.email}`}>
                  <td className="border-b border-border px-4 py-3 last:border-b-0">
                    <div className="flex items-center gap-3">
                      <Avatar name={m.fullName || m.email} seed={m.userId} />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2 font-medium">
                          {m.fullName || m.email}
                          {isSelf ? <Badge variant="gray">You</Badge> : null}
                        </span>
                        <span className="text-[13px] text-text-3">{m.email}</span>
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-border px-4 py-3">
                    <Select
                      selectSize="sm"
                      className="w-[132px]"
                      value={m.role}
                      disabled={!editable || busy === m.userId}
                      title={
                        isSelf
                          ? 'You cannot change your own role'
                          : editable
                            ? 'Change role'
                            : 'Only owners can change this role'
                      }
                      aria-label={`Role for ${m.fullName || m.email}`}
                      onChange={(e) => void changeRole(m, e.target.value as Role)}
                    >
                      {ROLE_OPTIONS.map((o) => (
                        <option
                          key={o.value}
                          value={o.value}
                          disabled={roleRank(o.value) > roleRank(myRole)}
                        >
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="border-b border-border px-4 py-3 text-[13px] text-text-2">
                    {new Date(m.joinedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="border-b border-border px-4 py-3">
                    {isSelf || editable ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`More for ${m.fullName || m.email}`}
                          >
                            <MoreHorizontal className="h-[18px] w-[18px]" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {isSelf ? (
                            <DropdownMenuItem onSelect={() => setConfirm(m)}>
                              <LogOut className="h-[18px] w-[18px]" strokeWidth={1.5} />
                              Leave workspace
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem danger onSelect={() => setConfirm(m)}>
                              <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.5} />
                              Remove from workspace
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Dialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(null);
        }}
      >
        {confirm ? (
          <DialogContent
            title={
              confirm.userId === myUserId
                ? 'Leave this workspace?'
                : `Remove ${confirm.fullName || confirm.email}?`
            }
            description={
              confirm.userId === myUserId
                ? 'You lose access immediately. An Owner can invite you back later.'
                : 'They lose access immediately. Their past activity stays in the audit log.'
            }
            className="w-[440px]"
          >
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={busy === confirm.userId}
                onClick={() => void remove(confirm)}
                data-testid="confirm-remove"
              >
                {confirm.userId === myUserId ? 'Leave' : 'Remove'}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
