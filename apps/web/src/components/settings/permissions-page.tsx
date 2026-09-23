'use client';
import {
  CUSTOMIZABLE_ROLES,
  effectivePermissions,
  PERMISSION_GROUPS,
  ROLE_LABELS,
  type CustomizableRole,
} from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  PersonPermissionSettings,
  RolePermissionSettings,
  SettablePermission,
} from '@/lib/api/types';
import {
  allowedOf,
  byDefault,
  ChoiceSelect,
  choiceOf,
  heldBack,
  type Choice,
} from './permission-bits';

type Settings = Record<string, boolean>;

/** "admins", "members": who a role's column is about. */
const PLURAL: Record<CustomizableRole, string> = { admin: 'Admins', member: 'Members' };

/**
 * Settings → Permissions (0105): what the Admin and Member roles may do in this business, one permission at a time.
 * Owners always do everything. Each choice saves as it is made; one person's own settings live under Members and
 * win over their role's, and the people who have some are listed at the end.
 */
export function PermissionsSettings({
  workspaceId,
  roles,
  people,
}: {
  workspaceId: string;
  roles: readonly RolePermissionSettings[];
  people: readonly PersonPermissionSettings[];
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<Record<CustomizableRole, Settings>>(() => ({
    admin: { ...(roles.find((r) => r.role === 'admin')?.settings ?? {}) },
    member: { ...(roles.find((r) => r.role === 'member')?.settings ?? {}) },
  }));
  const [busy, setBusy] = useState<string | null>(null);
  const [resetting, setResetting] = useState<CustomizableRole | null>(null);
  const effective = {
    admin: effectivePermissions('admin', settings.admin),
    member: effectivePermissions('member', settings.member),
  };
  const withOwn = people.filter((p) => p.role !== 'owner' && Object.keys(p.settings).length > 0);

  async function choose(role: CustomizableRole, permission: SettablePermission, c: Choice) {
    const before = settings[role];
    const next = { ...before };
    if (c === 'inherit') delete next[permission];
    else next[permission] = c === 'on';
    setSettings((s) => ({ ...s, [role]: next }));
    setBusy(`${role}:${permission}`);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/permission.set_role', {
          body: { workspaceId, role, permission, allowed: allowedOf(c) },
        }),
      );
      toast.success(`Saved for ${PLURAL[role].toLowerCase()}.`);
      router.refresh();
    } catch (e) {
      setSettings((s) => ({ ...s, [role]: before }));
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function reset(role: CustomizableRole) {
    setBusy(`reset:${role}`);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/permission.reset', { body: { workspaceId, role } }),
      );
      setSettings((s) => ({ ...s, [role]: {} }));
      setResetting(null);
      toast.success(`${PLURAL[role]} are back to the defaults.`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="permissions-settings">
      <Card className="p-6">
        <h2 className="text-base font-semibold tracking-tight">Who can do what</h2>
        <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.5] text-text-2">
          Owners can always do everything. Choose what admins and members can do here. To change it
          for one person, open{' '}
          <Link
            href={`/app/w/${workspaceId}/members`}
            className="font-medium text-accent-text hover:underline"
          >
            Members
          </Link>{' '}
          and pick Permissions next to their name — what you set for them wins over their role.
        </p>
      </Card>

      {PERMISSION_GROUPS.map((group) => (
        <Card key={group.title} className="px-6 pb-2 pt-5">
          <div className="flex items-end justify-between gap-4 pb-2">
            <h3 className="text-[15px] font-semibold tracking-tight">{group.title}</h3>
            <div className="hidden gap-3 text-xs font-medium text-text-3 md:flex">
              {CUSTOMIZABLE_ROLES.map((role) => (
                <span key={role} className="w-[178px]">
                  {PLURAL[role]}
                </span>
              ))}
            </div>
          </div>
          {group.permissions.map((info) => (
            <div
              key={info.permission}
              className="flex flex-col gap-3 border-t border-border py-3.5 md:flex-row md:items-start md:justify-between md:gap-6"
              data-testid={`permission-row-${info.permission}`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="text-[13px] font-medium">{info.label}</div>
                <div className="max-w-[460px] text-xs text-text-3">{info.description}</div>
              </div>
              <div className="grid flex-none grid-cols-2 gap-3 md:flex">
                {CUSTOMIZABLE_ROLES.map((role) => {
                  const own = settings[role][info.permission];
                  const on = own ?? byDefault(role, info.permission);
                  const note = heldBack(info, on, effective[role]);
                  return (
                    <div key={role} className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs font-medium text-text-3 md:hidden">
                        {PLURAL[role]}
                      </span>
                      <ChoiceSelect
                        value={choiceOf(own)}
                        inherited={byDefault(role, info.permission)}
                        inheritLabel="Default"
                        disabled={busy !== null}
                        label={`${info.label}, for ${PLURAL[role].toLowerCase()}`}
                        testId={`permission-${role}-${info.permission}`}
                        onChange={(c) =>
                          void choose(role, info.permission as SettablePermission, c)
                        }
                      />
                      {note ? (
                        <span className="text-[11.5px] text-warning-text md:w-[178px]">{note}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </Card>
      ))}

      <Card className="p-6">
        <h3 className="text-[15px] font-semibold tracking-tight">Back to the defaults</h3>
        <p className="mt-1 text-[13px] text-text-2">
          Clears every choice above for a role. People’s own settings stay as they are.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {CUSTOMIZABLE_ROLES.map((role) => (
            <Button
              key={role}
              variant="secondary"
              size="sm"
              disabled={Object.keys(settings[role]).length === 0 || busy !== null}
              onClick={() => setResetting(role)}
              data-testid={`permission-reset-${role}`}
            >
              Reset {PLURAL[role].toLowerCase()}
            </Button>
          ))}
        </div>
      </Card>

      <Card className="p-6" data-testid="permission-people">
        <h3 className="text-[15px] font-semibold tracking-tight">People with their own settings</h3>
        {withOwn.length === 0 ? (
          <p className="mt-1 text-[13px] text-text-2">
            Nobody yet. Everyone does what their role says.
          </p>
        ) : (
          <ul className="mt-2">
            {withOwn.map((p) => {
              const count = Object.keys(p.settings).length;
              return (
                <li
                  key={p.userId}
                  className="flex flex-wrap items-center gap-2.5 border-t border-border py-2.5 text-[13.5px] first:border-t-0"
                >
                  <span className="font-medium">{p.fullName || p.email}</span>
                  <Badge variant={p.role}>{ROLE_LABELS[p.role]}</Badge>
                  <span className="text-text-3">
                    {count === 1 ? '1 setting of their own' : `${count} settings of their own`}
                  </span>
                  <span className="flex-1" />
                  <Link
                    href={`/app/w/${workspaceId}/members?permissions=${p.userId}`}
                    className="text-[13px] font-medium text-accent-text hover:underline"
                  >
                    Change
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Dialog open={resetting !== null} onOpenChange={(v) => !v && setResetting(null)}>
        {resetting ? (
          <DialogContent
            title={`Reset ${PLURAL[resetting].toLowerCase()}?`}
            description={`Everything ${PLURAL[resetting].toLowerCase()} can do goes back to the default. People’s own settings stay.`}
            className="w-[440px]"
          >
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setResetting(null)}>
                Cancel
              </Button>
              <Button
                loading={busy === `reset:${resetting}`}
                onClick={() => void reset(resetting)}
                data-testid="permission-reset-confirm"
              >
                Reset
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
