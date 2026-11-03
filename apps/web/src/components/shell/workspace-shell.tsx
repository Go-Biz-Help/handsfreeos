'use client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLiveRefresh } from '@/lib/realtime/live-provider';

/**
 * What every screen in a business may ask about it on the client (FE-3): which business, what this person may do
 * there, which add-ons run there (0108), and whether it has HandsFreeOS video calls. The workspace layout reads it
 * once per request (`getWorkspaceShell`) and hands it down, so a panel or a button asks here instead of fetching
 * `workspace.get` again.
 */
export interface WorkspaceShell {
  readonly workspaceId: string;
  /** The add-ons running in this business: enabled, and not switched off by HandsFreeOS. */
  readonly addons: readonly string[];
  /** What this person may do here, add-ons' permissions included while those add-ons run. */
  readonly permissions: readonly string[];
  /** HandsFreeOS video calls are on here (docs/video-calls.md), so the Online place offers them. */
  readonly videoCalls: boolean;
  /**
   * What this person may do as HandsFreeOS staff (`platform.me`), empty for everyone who doesn't work here: a staff-only
   * link on a business's screen, such as a Needs you step's problem report (decision 142).
   */
  readonly staffPermissions: readonly string[];
}

const NONE: readonly string[] = [];

const WorkspaceShellContext = createContext<WorkspaceShell>({
  workspaceId: '',
  addons: [],
  permissions: [],
  videoCalls: false,
  staffPermissions: [],
});

/**
 * Hands the business down, and draws the shell again when an add-on is installed, turned on or off, removed or
 * its settings saved (the `addon` events, 0108): turning one on or off changes this person's menu, their
 * permissions and the panels on every page, so people who didn't make the change see it without reloading.
 */
export function WorkspaceShellProvider({
  workspaceId,
  addons,
  permissions,
  // Left out where no screen offers them: the setup pages.
  videoCalls = false,
  staffPermissions = NONE,
  children,
}: Omit<WorkspaceShell, 'videoCalls' | 'staffPermissions'> & {
  videoCalls?: boolean;
  staffPermissions?: readonly string[];
  children: ReactNode;
}) {
  useLiveRefresh(['addon']);
  const value = useMemo(
    () => ({ workspaceId, addons, permissions, videoCalls, staffPermissions }),
    [workspaceId, addons, permissions, videoCalls, staffPermissions],
  );
  return <WorkspaceShellContext.Provider value={value}>{children}</WorkspaceShellContext.Provider>;
}

export const useWorkspaceShell = (): WorkspaceShell => useContext(WorkspaceShellContext);

/** Whether an add-on runs in this business now. */
export const useAddonRunning = (addonId: string): boolean =>
  useWorkspaceShell().addons.includes(addonId);

/** Whether this person holds a permission here: core's, or a running add-on's (`pm.read`). */
export const useCan = (permission: string): boolean =>
  useWorkspaceShell().permissions.includes(permission);

/** Whether this person holds a HandsFreeOS staff permission (`platform.health.read`): for staff-only links. */
export const useStaffCan = (permission: string): boolean =>
  useWorkspaceShell().staffPermissions.includes(permission);
