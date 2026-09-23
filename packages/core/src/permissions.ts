/**
 * Fixed roles and permissions for Milestone 1. `app.role_permissions` in the database is the
 * enforcement copy (used by RLS); test/permissions-parity.test.ts asserts both stay identical.
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ORG_ROLES = ['owner', 'admin'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * The third axis (M13): HandsFreeOS's own support people. A staff role gives no standing in any business —
 * it opens the support desk, and lets someone look at a business read-only, with a reason, for a while.
 */
export const STAFF_ROLES = ['agent', 'lead', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_PERMISSIONS = {
  owner: [
    'workspace.read',
    'workspace.update',
    'workspace.delete',
    'members.read',
    'members.invite',
    'members.change_role',
    'members.remove',
    'invitations.read',
    'invitations.revoke',
    'audit.read',
    'records.read',
    'records.write',
    'records.archive',
    'records.assign',
    'records.import',
    'pipelines.manage',
    'tags.manage',
    'files.delete',
    'inbox.use',
    'channels.manage',
    'assistant.use',
    'calendars.manage',
    'appointments.write',
    'workflows.manage',
    'knowledge.manage',
    'ai_team.manage',
    'money.read',
    'money.bill',
    'money.manage',
    'migrations.manage',
    'forms.manage',
    'templates.manage',
    'reviews.manage',
    'fields.manage',
    'permissions.manage',
  ],
  admin: [
    'workspace.read',
    'workspace.update',
    'members.read',
    'members.invite',
    'members.change_role',
    'members.remove',
    'invitations.read',
    'invitations.revoke',
    'audit.read',
    'records.read',
    'records.write',
    'records.archive',
    'records.assign',
    'records.import',
    'pipelines.manage',
    'tags.manage',
    'files.delete',
    'inbox.use',
    'channels.manage',
    'assistant.use',
    'calendars.manage',
    'appointments.write',
    'workflows.manage',
    'knowledge.manage',
    'ai_team.manage',
    'money.read',
    'money.bill',
    'money.manage',
    'migrations.manage',
    'forms.manage',
    'templates.manage',
    'reviews.manage',
    'fields.manage',
  ],
  member: [
    'workspace.read',
    'members.read',
    'records.read',
    'records.write',
    'inbox.use',
    'assistant.use',
    'appointments.write',
    'money.read',
  ],
  org_owner: [
    'org.read',
    'org.update',
    'org.delete',
    'org.members.manage',
    'workspace.create',
    'org.audit.read',
    'org.templates.manage',
    'org.migrations.manage',
  ],
  org_admin: [
    'org.read',
    'workspace.create',
    'org.audit.read',
    'org.templates.manage',
    'org.migrations.manage',
  ],
  staff_agent: ['support.read', 'support.reply', 'platform.businesses.read', 'platform.view_as'],
  staff_lead: [
    'support.read',
    'support.reply',
    'support.assign',
    'support.manage',
    'platform.businesses.read',
    'platform.view_as',
    'platform.health.read',
  ],
  staff_admin: [
    'support.read',
    'support.reply',
    'support.assign',
    'support.manage',
    'platform.businesses.read',
    'platform.view_as',
    'platform.health.read',
    'platform.staff.manage',
    'platform.rates.manage',
    'platform.wallets.adjust',
    'platform.founding.manage',
  ],
} as const satisfies Record<string, readonly string[]>;

export type RoleKey = keyof typeof ROLE_PERMISSIONS;
export type Permission = (typeof ROLE_PERMISSIONS)[RoleKey][number];
/** Everything anyone can do inside a business: the owner has all of it. */
export type WorkspacePermission = (typeof ROLE_PERMISSIONS)['owner'][number];

// ---------- permissions a business sets (0103) ----------

/** One permission an owner can turn on or off, in plain words, with what it stands on. */
export interface PermissionInfo {
  readonly permission: WorkspacePermission;
  readonly label: string;
  readonly description: string;
  /** What it needs to mean anything, all the way down: off whenever any of these is off. */
  readonly requires: readonly WorkspacePermission[];
}

export interface PermissionGroup {
  readonly title: string;
  readonly permissions: readonly PermissionInfo[];
}

/**
 * What an owner may turn on or off for the Admin and Member roles, or for one person, grouped as the settings page
 * shows them. `app.customizable_permissions` holds the same list and requirements (permissions-parity.test.ts).
 * Everything else stays with the role: opening the business and seeing its customers and team are never taken away,
 * and deleting the business and setting permissions are never handed out.
 */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    title: 'Customers',
    permissions: [
      {
        permission: 'records.write',
        label: 'Add and edit customers',
        description: 'Customers, companies, leads, tasks and notes.',
        requires: ['records.read'],
      },
      {
        permission: 'records.assign',
        label: 'Choose who’s on a customer',
        description:
          'Who a customer is assigned to, which decides whose bills and threads members see.',
        requires: ['records.read', 'records.write'],
      },
      {
        permission: 'records.archive',
        label: 'Archive and restore',
        description: 'Customers, companies, leads and conversations.',
        requires: ['records.read', 'records.write'],
      },
      {
        permission: 'records.import',
        label: 'Import customers',
        description: 'Bring customers in from a spreadsheet.',
        requires: ['records.read', 'records.write'],
      },
      {
        permission: 'tags.manage',
        label: 'Set up tags',
        description: 'Add, rename and remove the business’s tags.',
        requires: ['records.read', 'records.write'],
      },
      {
        permission: 'pipelines.manage',
        label: 'Set up pipelines',
        description: 'The stages leads move through.',
        requires: ['records.read', 'records.write'],
      },
      {
        permission: 'fields.manage',
        label: 'Set up custom fields',
        description: 'The extra details kept on customers and other records.',
        requires: ['records.read', 'records.write'],
      },
      {
        permission: 'files.delete',
        label: 'Delete files',
        description: 'Photos and documents on any record, not only their own.',
        requires: ['records.read', 'records.write'],
      },
    ],
  },
  {
    title: 'Inbox and calls',
    permissions: [
      {
        permission: 'inbox.use',
        label: 'Use the inbox',
        description: 'Read and answer texts, email, calls and website chat.',
        requires: [],
      },
      {
        permission: 'channels.manage',
        label: 'Set up numbers and email',
        description: 'Phone numbers, email addresses and the website chat — and see every thread.',
        requires: ['inbox.use'],
      },
    ],
  },
  {
    title: 'Calendar',
    permissions: [
      {
        permission: 'appointments.write',
        label: 'Book and change visits',
        description: 'On any calendar they can see.',
        requires: [],
      },
      {
        permission: 'calendars.manage',
        label: 'Set up calendars',
        description: 'Calendars, services, hours and booking pages.',
        requires: ['appointments.write'],
      },
    ],
  },
  {
    title: 'Money',
    permissions: [
      {
        permission: 'money.read',
        label: 'See bills for their work',
        description:
          'Estimates, invoices and payments for the customers, leads and visits they’re on.',
        requires: [],
      },
      {
        permission: 'money.bill',
        label: 'Send estimates and invoices, start plans',
        description:
          'For the customers they can see bills for, paid into the accounts they may use. Take a payment by hand.',
        requires: ['money.read'],
      },
      {
        permission: 'money.manage',
        label: 'Manage all money',
        description: 'Every bill, refunds, products, money settings and payment accounts.',
        requires: ['money.bill', 'money.read'],
      },
    ],
  },
  {
    title: 'Automations and AI',
    permissions: [
      {
        permission: 'workflows.manage',
        label: 'Build automations',
        description: 'Workflows, and approving the steps that wait for a person.',
        requires: [],
      },
      {
        permission: 'forms.manage',
        label: 'Build forms',
        description: 'Forms, surveys and quizzes.',
        requires: [],
      },
      {
        permission: 'reviews.manage',
        label: 'Manage reviews',
        description: 'Review sites and asking for reviews.',
        requires: [],
      },
      {
        permission: 'templates.manage',
        label: 'Take in agency templates',
        description: 'Templates and knowledge packs the agency sends.',
        requires: [],
      },
      {
        permission: 'assistant.use',
        label: 'Use Ask HandsFreeOS',
        description: 'The assistant that answers questions and gets work done.',
        requires: [],
      },
      {
        permission: 'knowledge.manage',
        label: 'Edit the knowledge base',
        description: 'What the AI teammate and the assistant answer from.',
        requires: [],
      },
      {
        permission: 'ai_team.manage',
        label: 'Run the AI teammate',
        description: 'Its settings, and approving what it wants to send.',
        requires: [],
      },
    ],
  },
  {
    title: 'Business and team',
    permissions: [
      {
        permission: 'workspace.update',
        label: 'Change business settings',
        description: 'Name, time zone and the settings every page shares.',
        requires: [],
      },
      {
        permission: 'audit.read',
        label: 'See the audit log',
        description: 'Who changed what, and when.',
        requires: [],
      },
      {
        permission: 'migrations.manage',
        label: 'Move data in from another CRM',
        description: 'GoHighLevel and the other systems a business moves from.',
        requires: [],
      },
      {
        permission: 'members.invite',
        label: 'Invite people',
        description: 'At their own role or below.',
        requires: ['invitations.read'],
      },
      {
        permission: 'invitations.read',
        label: 'See pending invitations',
        description: 'Who has been invited and not joined yet.',
        requires: [],
      },
      {
        permission: 'invitations.revoke',
        label: 'Cancel invitations',
        description: 'Before someone joins.',
        requires: ['invitations.read'],
      },
      {
        permission: 'members.change_role',
        label: 'Change people’s roles',
        description: 'Up to their own role, never an owner’s.',
        requires: [],
      },
      {
        permission: 'members.remove',
        label: 'Remove people',
        description: 'At their own role or below.',
        requires: [],
      },
    ],
  },
];

/** Every permission an owner can set, in the order the settings page lists them. */
export const CUSTOMIZABLE_PERMISSIONS: readonly PermissionInfo[] = PERMISSION_GROUPS.flatMap(
  (g) => g.permissions,
);

export const isCustomizablePermission = (p: string): p is WorkspacePermission =>
  CUSTOMIZABLE_PERMISSIONS.some((c) => c.permission === p);

/** The roles whose permissions a business may change. Owners always keep everything. */
export const CUSTOMIZABLE_ROLES = ['admin', 'member'] as const;
export type CustomizableRole = (typeof CUSTOMIZABLE_ROLES)[number];

/** A business's own answer for one permission: on, off, or (absent) the level above it. */
export type PermissionSettings = Readonly<Partial<Record<string, boolean>>>;

/**
 * What someone with this role may do here, given the business's setting for the role and (for one person) their
 * own: their setting wins, then the role's, then the default; a permission whose requirements are off is off; an
 * owner has everything. private.user_permissions() in the database says the same, and is the one that decides —
 * this is for showing what a setting will do before it is saved.
 */
export function effectivePermissions(
  role: WorkspaceRole,
  roleSettings: PermissionSettings = {},
  personSettings: PermissionSettings = {},
): WorkspacePermission[] {
  const defaults = ROLE_PERMISSIONS[role] as readonly string[];
  if (role === 'owner') return [...(defaults as readonly WorkspacePermission[])].sort();
  const candidates = new Set<string>([
    ...defaults,
    ...CUSTOMIZABLE_PERMISSIONS.map((c) => c.permission),
  ]);
  const settable = new Set<string>(CUSTOMIZABLE_PERMISSIONS.map((c) => c.permission));
  const base = new Map<string, boolean>();
  for (const p of candidates)
    base.set(
      p,
      settable.has(p)
        ? (personSettings[p] ?? roleSettings[p] ?? defaults.includes(p))
        : defaults.includes(p),
    );
  const requirements = new Map(CUSTOMIZABLE_PERMISSIONS.map((c) => [c.permission, c.requires]));
  return [...candidates]
    .filter(
      (p) =>
        base.get(p) && (requirements.get(p as WorkspacePermission) ?? []).every((q) => base.get(q)),
    )
    .sort() as WorkspacePermission[];
}

/**
 * Who is asking, as far as permissions go: their role, and what the business lets them do when that is known (0103)
 * — the API gives it, the phone's access row holds it. Code that only has a role still works, with the defaults.
 */
export interface Grants {
  readonly role: WorkspaceRole | null;
  readonly permissions?: readonly string[] | null;
}

/** Whether they may: by what the business lets them do when known, else by their role's defaults. */
export function holds(who: Grants, permission: Permission): boolean {
  if (who.permissions) return who.permissions.includes(permission);
  return hasWorkspacePermission(who.role, permission);
}

/** Whether a list of permissions — someone's, as the API or the phone's copy gives it — includes one. */
export const can = (
  permissions: readonly string[] | null | undefined,
  permission: WorkspacePermission,
): boolean => !!permissions?.includes(permission);

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  agent: 'Support agent',
  lead: 'Support lead',
  admin: 'Support admin',
};
export const STAFF_ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  agent: 'Answers tickets and can look at a business read-only to see what the customer sees.',
  lead: 'Everything an agent does, plus assigning tickets, saved replies and the health page.',
  admin: 'Everything a lead does, plus inviting and removing support people.',
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: 'Full control, including deleting the workspace and managing other Owners.',
  admin: 'Manages people and settings. Cannot change or remove Owners.',
  member: 'Works in the workspace. Cannot invite or manage people.',
};

/** member 1 < admin 2 < owner 3; anything else 0. */
export function roleRank(role: string | null | undefined): number {
  switch (role) {
    case 'owner':
      return 3;
    case 'admin':
      return 2;
    case 'member':
      return 1;
    default:
      return 0;
  }
}

/** You may grant, change to, or act on a role only at or below your own rank. */
export function canActOnRole(actorRole: WorkspaceRole | null, targetRole: WorkspaceRole): boolean {
  return roleRank(actorRole) > 0 && roleRank(targetRole) <= roleRank(actorRole);
}

export function isOrgPermission(permission: Permission): boolean {
  return permission.startsWith('org.') || permission === 'workspace.create';
}

/** Answering support and running the platform: checked against a staff role, never against a business role. */
export function isStaffPermission(permission: Permission): boolean {
  return permission.startsWith('support.') || permission.startsWith('platform.');
}

export function hasStaffPermission(role: StaffRole | null, permission: Permission): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[`staff_${role}`] as readonly string[]).includes(permission);
}

export function hasWorkspacePermission(
  role: WorkspaceRole | null,
  permission: Permission,
): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

export function hasOrgPermission(role: OrgRole | null, permission: Permission): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[`org_${role}`] as readonly string[]).includes(permission);
}

/** Highest of a direct workspace role and the org role's implied workspace role. */
export function effectiveWorkspaceRole(
  direct: WorkspaceRole | null,
  orgRole: OrgRole | null,
): WorkspaceRole | null {
  const candidates: WorkspaceRole[] = [];
  if (direct) candidates.push(direct);
  if (orgRole) candidates.push(orgRole);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => roleRank(b) - roleRank(a))[0] ?? null;
}
