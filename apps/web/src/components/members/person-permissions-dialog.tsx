'use client';
import {
  effectivePermissions,
  PERMISSION_GROUPS,
  ROLE_LABELS,
  type CustomizableRole,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { SettablePermission } from '@/lib/api/types';
import {
  allowedOf,
  byDefault,
  ChoiceSelect,
  choiceOf,
  heldBack,
  type Choice,
} from '@/components/settings/permission-bits';

type Settings = Record<string, boolean>;

/**
 * What one person may do here (0103), permission by permission: as their role says, or on or off just for them.
 * Their own answer wins over their role's. Each choice saves as it is made. Never for an owner: owners always do
 * everything.
 */
export function PersonPermissionsDialog({
  workspaceId,
  person,
  role,
  roleSettings,
  initial,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  person: { userId: string; name: string };
  role: CustomizableRole;
  /** What the business has set for their role. */
  roleSettings: Settings;
  /** Their own settings, as saved. */
  initial: Settings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [own, setOwn] = useState<Settings>({ ...initial });
  const [busy, setBusy] = useState<string | null>(null);
  const effective = effectivePermissions(role, roleSettings, own);
  const roleSays = (permission: string) => roleSettings[permission] ?? byDefault(role, permission);

  async function choose(permission: SettablePermission, c: Choice) {
    const before = own;
    const next = { ...before };
    if (c === 'inherit') delete next[permission];
    else next[permission] = c === 'on';
    setOwn(next);
    setBusy(permission);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/permission.set_member', {
          body: { workspaceId, userId: person.userId, permission, allowed: allowedOf(c) },
        }),
      );
      toast.success(`Saved for ${person.name}.`);
      router.refresh();
    } catch (e) {
      setOwn(before);
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy('reset');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/permission.reset', {
          body: { workspaceId, userId: person.userId },
        }),
      );
      setOwn({});
      toast.success(`${person.name} does what their role says again.`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const sameAs = `Same as ${ROLE_LABELS[role]}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`What ${person.name} can do`}
        description={`${person.name} is ${role === 'admin' ? 'an Admin' : 'a Member'}. What you choose here is just for them and wins over what the role says.`}
        className="max-h-[88vh] w-[680px] overflow-y-auto"
      >
        <div className="mt-4 flex flex-col gap-5" data-testid="person-permissions">
          {PERMISSION_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="text-[13px] font-semibold tracking-tight text-text-2">
                {group.title}
              </h3>
              {group.permissions.map((info) => {
                const mine = own[info.permission];
                const note = heldBack(info, mine ?? roleSays(info.permission), effective);
                return (
                  <div
                    key={info.permission}
                    className="flex flex-col gap-2 border-t border-border py-3 first-of-type:border-t-0 sm:flex-row sm:items-start sm:justify-between sm:gap-5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="text-[13px] font-medium">{info.label}</div>
                      <div className="text-xs text-text-3">{info.description}</div>
                    </div>
                    <div className="flex flex-none flex-col gap-1">
                      <ChoiceSelect
                        value={choiceOf(mine)}
                        inherited={roleSays(info.permission)}
                        inheritLabel={sameAs}
                        disabled={busy !== null}
                        label={`${info.label}, for ${person.name}`}
                        testId={`person-permission-${info.permission}`}
                        onChange={(c) => void choose(info.permission as SettablePermission, c)}
                      />
                      {note ? (
                        <span className="text-[11.5px] text-warning-text sm:w-[178px]">{note}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            disabled={Object.keys(own).length === 0 || busy !== null}
            loading={busy === 'reset'}
            onClick={() => void reset()}
            data-testid="person-permissions-reset"
          >
            Same as their role for everything
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
