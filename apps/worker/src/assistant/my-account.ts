/**
 * The person's own account, as Settings → Account shows it to them (get_settings, area my_account): their name and the
 * email they sign in with, the web app's appearance, every alert as it is set now, their side menu as it's drawn, the
 * businesses they're in with their role in each, their cell, and the phones their alerts reach.
 *
 * Only the rows their own screen shows. New support tickets is HandsFreeOS's own support people's alone: anyone else is
 * never told it exists (the owner, 2026-10-27). Daily agency digest is for an agency's owners and admins
 * (`managesAnAgency`), as the web's Account page and the phone's Notifications decide it.
 */
import {
  APPEARANCE_LABELS,
  formatPhone,
  managesAnAgency,
  menuSummary,
  MY_CELL_WORDS,
  notificationStates,
  ROLE_LABELS,
  type WorkspaceRole,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { dayLabel } from './calendar-format';
import type { ToolContext } from './runtime';
import { menuHere, menuLayout } from './tools-extra';
import { query } from './tools-read';

interface MeRead {
  user: { fullName: string; email: string; settings: Record<string, unknown> };
  organizations: { id: string; name: string; role: string }[];
  workspaces: {
    id: string;
    organizationId: string;
    organizationName: string;
    name: string;
    role: string;
  }[];
}

/** Where the phone keeps its own look, which HandsFreeOS can't see or change. */
const PHONE_APPEARANCE =
  'This is the web app’s, saved to their account for every browser they sign in on. The phone app keeps its own on each phone, under More, then Settings, then Appearance, which HandsFreeOS can’t see or change.';

/**
 * Whether they answer HandsFreeOS support: only then is New support tickets one of their rows. A refusal is "no".
 */
const answersSupport = (db: Db, ctx: ToolContext) =>
  query<{ staff: unknown }>(db, ctx, 'platform.me').then(
    (m) => !!m.staff,
    () => false,
  );

/** Their side menu as Settings → Account's Side menu card and Edit menu show it in this business. */
async function sideMenuRead(db: Db, ctx: ToolContext) {
  const { menu, open } = await menuHere(db, ctx);
  return {
    summary: menuSummary(menu),
    asDrawn: menuLayout(menu, open),
    note: 'Top to bottom, groups with what is in them, then what is hidden. arrange_my_menu changes it, for them alone, on every computer they sign in on; the phone app has no side menu.',
  };
}

/** The `me` part of my_account: account.me read for the model, with what their own screen shows and nothing more. */
export async function meRead(v: unknown, db: Db, ctx: ToolContext): Promise<unknown> {
  const me = v as MeRead | null;
  if (!me?.user) return null;
  const [staff, sideMenu] = await Promise.all([
    answersSupport(db, ctx),
    sideMenuRead(db, ctx).catch(() => null),
  ]);
  const agency = managesAnAgency({ organizations: me.organizations, businesses: me.workspaces });
  const roleOf = (role: string) => ROLE_LABELS[role as WorkspaceRole] ?? role;
  const theme = me.user.settings['theme'];
  return {
    fullName: me.user.fullName,
    email: me.user.email,
    emailNote:
      'The email they sign in with can’t be changed yet: it’s coming with the security settings.',
    appearance: {
      web: APPEARANCE_LABELS[theme === 'light' || theme === 'dark' ? theme : 'system'],
      note: PHONE_APPEARANCE,
    },
    alerts: notificationStates(me.user.settings).filter(
      (a) => (staff || !a.supportOnly) && (agency || !a.agencyOnly),
    ),
    alwaysOn: 'Safety check-in alerts always reach their phones; they can’t be turned off.',
    ...(sideMenu ? { sideMenu } : {}),
    // The businesses switcher's list: each one they're in, with their role, and the one asked from.
    businesses: me.workspaces.map((w) => ({
      name: w.name,
      organization: w.organizationName,
      role: roleOf(w.role),
      ...(w.id === ctx.workspaceId ? { current: true } : {}),
      link: `/app/w/${w.id}`,
    })),
    // Where they may add a business (Create workspace): the organizations they own or run.
    organizations: me.organizations.map((o) => ({ name: o.name, role: roleOf(o.role) })),
  };
}

/** My cell phone, as its card says it: the number, and Verified on a day, or Not verified yet. */
export function myCellRead(v: unknown, ctx: ToolContext): unknown {
  const phone = (v as { phone?: { e164: string; verifiedAt: string | null } | null } | null)?.phone;
  if (!phone)
    return {
      number: null,
      note: 'No cell yet. They add it and confirm it themselves, under My cell phone: settings_help has the steps.',
    };
  return {
    number: formatPhone(phone.e164),
    state: phone.verifiedAt
      ? `${MY_CELL_WORDS.verified} ${dayLabel(Date.parse(phone.verifiedAt), ctx.timezone)}`
      : MY_CELL_WORDS.notVerified,
  };
}

/** The phones their alerts go to, as Settings → Account counts them: none means phone alerts reach nobody. */
export function phonesRead(v: unknown): unknown {
  const devices =
    (v as { devices?: { platform: string; deviceName: string | null; lastSeenAt: string }[] })
      ?.devices ?? [];
  if (!devices.length)
    return {
      phones: [],
      note: 'No phone gets their alerts yet: they sign in on the HandsFreeOS phone app and allow notifications there (More, then Settings, then Notifications: This phone).',
    };
  return {
    phones: devices.map((d) => ({ phone: d.deviceName ?? d.platform, lastSeenAt: d.lastSeenAt })),
  };
}
