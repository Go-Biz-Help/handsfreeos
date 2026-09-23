'use client';
import {
  CUSTOMIZABLE_PERMISSIONS,
  ROLE_PERMISSIONS,
  type PermissionInfo,
  type WorkspaceRole,
} from '@hfos/core';
import { Select } from '@/components/ui/input';

/**
 * The pieces the Permissions settings page and one person's permissions share (0105): a business's answer for
 * one permission is "go with the level above", on, or off.
 */
export type Choice = 'inherit' | 'on' | 'off';

export const choiceOf = (v: boolean | undefined): Choice =>
  v === undefined ? 'inherit' : v ? 'on' : 'off';

/** What the command takes: null goes back to the level above. */
export const allowedOf = (c: Choice): boolean | null => (c === 'inherit' ? null : c === 'on');

/** Whether a role has it before a business changes anything. */
export const byDefault = (role: WorkspaceRole, permission: string): boolean =>
  (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);

const labelOf = (permission: string): string | null =>
  CUSTOMIZABLE_PERMISSIONS.find((c) => c.permission === permission)?.label ?? null;

/**
 * Why a permission that is turned on still does nothing: the first thing it stands on that is off, in words.
 * Null when it works, or when it is off anyway.
 */
export function heldBack(
  info: PermissionInfo,
  on: boolean,
  effective: readonly string[],
): string | null {
  if (!on || effective.includes(info.permission)) return null;
  const missing = info.requires.find((r) => !effective.includes(r));
  const name = missing ? labelOf(missing) : null;
  return name ? `Off until “${name}” is on` : 'Off until what it needs is on';
}

/** The picker: the level above's answer spelled out first, then on and off. */
export function ChoiceSelect({
  value,
  inherited,
  inheritLabel,
  onChange,
  disabled,
  label,
  testId,
}: {
  value: Choice;
  /** What the level above says, for the first option. */
  inherited: boolean;
  /** "Default" for a role, "Same as Member" for a person. */
  inheritLabel: string;
  onChange: (c: Choice) => void;
  disabled?: boolean;
  /** For screen readers: which permission, for whom. */
  label: string;
  testId?: string;
}) {
  return (
    <Select
      selectSize="sm"
      className="w-full md:w-[178px]"
      value={value}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value as Choice)}
    >
      <option value="inherit">{`${inheritLabel} (${inherited ? 'on' : 'off'})`}</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </Select>
  );
}
