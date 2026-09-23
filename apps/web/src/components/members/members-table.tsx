'use client';
import { can, type CustomizableRole } from '@hfos/core';
import { Clock, LogOut, MoreHorizontal, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
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
import type { Member, PermissionSettingsOut, Role } from '@/lib/api/types';
import { PersonPermissionsDialog } from './person-permissions-dialog';
import { ROLE_OPTIONS, roleRank } from './roles';

export function MembersTable({
  workspaceId,
  members,
  myRole,
  myPermissions,
  myUserId,
  permissionSettings = null,
  openPermissionsFor = null,
}: {
  workspaceId: string;
  members: Member[];
  myRole: Role;
  /** What the business lets the person looking do (0103). */
  myPermissions: readonly string[];
  myUserId: string;
  /** Every role's and person's own permission settings, for an owner who sets them; null for anyone else. */
  permissionSettings?: PermissionSettingsOut | null;
  /** Open this person's permissions straight away (Settings → Permissions links here). */
  openPermissionsFor?: string | null;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Member | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [settingFor, setSettingFor] = useState<Member | null>(
    () =>
      (permissionSettings &&
        members.find((m) => m.userId === openPermissionsFor && m.role !== 'owner')) ||
      null,
  );
  const canChangeRole = can(myPermissions, 'members.change_role');
  const canRemove = can(myPermissions, 'members.remove');
  // Someone else's hours are for whoever sets up calendars, as My calendar's own page says.
  const canEditHours = can(myPermissions, 'calendars.manage');
  const ownSettings = (userId: string) =>
    permissionSettings?.people.find((p) => p.userId === userId)?.settings ?? {};
  const roleSettings = (role: CustomizableRole) =>
    permissionSettings?.roles.find((r) => r.role === role)?.settings ?? {};

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
              const outranks = !isSelf && roleRank(m.role) <= roleRank(myRole);
              const editable = canChangeRole && outranks;
              const removable = canRemove && outranks;
              // Owners always do everything, so there is nothing to set for them.
              const settable = !!permissionSettings && m.role !== 'owner';
              const hasOwn = Object.keys(ownSettings(m.userId)).length > 0;
              return (
                <tr key={m.userId} data-testid={`member-row-${m.email}`}>
                  <td className="border-b border-border px-4 py-3 last:border-b-0">
                    <div className="flex items-center gap-3">
                      <Avatar name={m.fullName || m.email} seed={m.userId} />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2 font-medium">
                          {m.fullName || m.email}
                          {isSelf ? <Badge variant="gray">You</Badge> : null}
                          {settable && hasOwn ? (
                            <Badge
                              variant="accent"
                              data-testid={`member-own-permissions-${m.email}`}
                            >
                              Own permissions
                            </Badge>
                          ) : null}
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
                            : 'You can’t change this role'
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
                    {isSelf || removable || canEditHours || settable ? (
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
                          {isSelf || canEditHours ? (
                            <DropdownMenuItem asChild>
                              <Link
                                href={`/app/w/${workspaceId}/settings/my-calendar${isSelf ? '' : `?user=${m.userId}`}`}
                                data-testid={`edit-hours-${m.email}`}
                              >
                                <Clock className="h-[18px] w-[18px]" strokeWidth={1.5} />
                                {isSelf ? 'Edit my hours' : 'Edit hours'}
                              </Link>
                            </DropdownMenuItem>
                          ) : null}
                          {settable ? (
                            <DropdownMenuItem
                              onSelect={() => setSettingFor(m)}
                              data-testid={`member-permissions-${m.email}`}
                            >
                              <ShieldCheck className="h-[18px] w-[18px]" strokeWidth={1.5} />
                              Permissions
                            </DropdownMenuItem>
                          ) : null}
                          {isSelf ? (
                            <DropdownMenuItem onSelect={() => setConfirm(m)}>
                              <LogOut className="h-[18px] w-[18px]" strokeWidth={1.5} />
                              Leave workspace
                            </DropdownMenuItem>
                          ) : removable ? (
                            <DropdownMenuItem danger onSelect={() => setConfirm(m)}>
                              <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.5} />
                              Remove from workspace
                            </DropdownMenuItem>
                          ) : null}
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
      {settingFor && settingFor.role !== 'owner' ? (
        <PersonPermissionsDialog
          key={settingFor.userId}
          workspaceId={workspaceId}
          person={{ userId: settingFor.userId, name: settingFor.fullName || settingFor.email }}
          role={settingFor.role}
          roleSettings={roleSettings(settingFor.role)}
          initial={ownSettings(settingFor.userId)}
          open
          onOpenChange={(v) => !v && setSettingFor(null)}
        />
      ) : null}
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
