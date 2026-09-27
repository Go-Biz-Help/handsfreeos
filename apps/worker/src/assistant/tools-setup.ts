/**
 * The Assistant's setup tools (packages/core/src/assistant/tools-setup.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 *
 * The parts of the setup the settings screens change and the Assistant couldn't: who may do what, the business's own
 * fields, kinds of records and relationships, templates, its numbers and who sees which conversations, its own web
 * address, blocked addresses and mail from strangers, and the RCS sender and lead forms once they are connected.
 *
 * Each card is read from what is there now, so it says what will really change, and a request that would change
 * nothing is turned back before any card is drawn. The words are the screen's own: a card about a permission names
 * it the way Settings → Permissions does, and retiring a field says what the screen's own question says.
 */
import {
  cardinalitySentences,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOMIZABLE_PERMISSIONS,
  effectivePermissions,
  endKindWords,
  hasOptions,
  HfosError,
  lowerLabel,
  manyFor,
  pluralOf,
  RECORD_ICON_LABELS,
  relationshipTypeName,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  templateVars,
  type CustomFieldType,
  type CustomizableRole,
  type RecordIcon,
  type RelationshipCardinality,
  type RelationshipEndKind,
  type WorkspaceRole,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { command, query, quoted, when } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Warning = { kind: string; text: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : undefined);
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const action = (args: Args) => String(args['action'] ?? '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Asked for something that is already so: said before a card is drawn, not after Confirm. */
const nothing = () => HfosError.validation([], 'Nothing would change.');
const need = (path: string, message: string) => HfosError.validation([{ path, message }], message);

const href = (ctx: ToolContext, path: string) => `/app/w/${ctx.workspaceId}/${path}`;

/** A settings card: title, the lines it changes, the button, and anything to know first. */
const card = (
  toolCallId: string,
  tool: string,
  title: string,
  fields: Field[],
  confirmLabel: string,
  warnings: Warning[] = [],
) => settingsCard(toolCallId, tool, { title, fields, confirmLabel, warnings });

// ---------- who may do what ----------

interface PermissionSettings {
  roles: { role: CustomizableRole; settings: Record<string, boolean> }[];
  people: {
    userId: string;
    fullName: string;
    email: string;
    role: WorkspaceRole;
    settings: Record<string, boolean>;
  }[];
}

const PLURAL: Record<CustomizableRole, string> = { admin: 'admins', member: 'members' };
const infoOf = (permission: string) =>
  CUSTOMIZABLE_PERMISSIONS.find((p) => p.permission === permission);
const labelOf = (permission: string) => infoOf(permission)?.label ?? permission;
/** Whether a role has it before a business changes anything. */
const byDefault = (role: WorkspaceRole, permission: string) =>
  (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);

/** "On", "Off", or what it follows, as the screen's picker says it: "Default (on)", "Same as Member (off)". */
const answerWords = (own: boolean | null | undefined, inherited: boolean, follows: string) =>
  own === true ? 'On' : own === false ? 'Off' : `${follows} (${inherited ? 'on' : 'off'})`;

/** Money is where handing someone more matters most, so the card says what it opens up. */
const MONEY_WORDS: Record<string, string> = {
  'money.bill': 'They’ll be able to send estimates and invoices and take payments by hand.',
  'money.manage': 'They’ll see every bill, and can give refunds and change the payment accounts.',
};

/**
 * One permission for a role or a person: the card says what it is, what it was, what goes with it — a permission
 * whose requirements are off stays off, and turning one off takes the ones that stand on it too.
 */
function permissionCard(
  toolCallId: string,
  o: {
    who: string;
    whoLine: string;
    person: boolean;
    permission: string;
    allowed: boolean | null;
    was: boolean | undefined;
    inherited: boolean;
    follows: string;
    before: readonly string[];
    after: readonly string[];
  },
) {
  const info = infoOf(o.permission)!;
  const label = info.label;
  const title =
    o.allowed === true
      ? `Let ${o.who} ${lowerFirst(label)}`
      : o.allowed === false
        ? `Don’t let ${o.who} ${lowerFirst(label)}`
        : o.person
          ? `Put “${label}” back to what ${o.who}’s role says`
          : `Put “${label}” back to the default for ${o.who}`;
  const lost = o.before.filter((p) => !o.after.includes(p) && p !== o.permission && infoOf(p));
  const gained = o.after.filter((p) => !o.before.includes(p) && p !== o.permission && infoOf(p));
  const warnings: Warning[] = [];
  const on = o.allowed ?? o.inherited;
  if (on && !o.after.includes(o.permission)) {
    const missing = info.requires.find((r) => !o.after.includes(r));
    warnings.push({
      kind: 'note',
      text: `It stays off until “${missing ? labelOf(missing) : 'what it needs'}” is on.`,
    });
  }
  const money = MONEY_WORDS[o.permission];
  if (money && o.after.includes(o.permission) && !o.before.includes(o.permission))
    warnings.push({ kind: 'caution', text: money });
  if (o.person)
    warnings.push({ kind: 'note', text: 'What you set for them wins over their role.' });
  return card(
    toolCallId,
    'manage_permissions',
    title,
    [
      { label: 'Who', value: o.whoLine },
      { label: 'Permission', value: label },
      { label: 'What it covers', value: info.description },
      { label: 'Now', value: answerWords(o.allowed, o.inherited, o.follows) },
      { label: 'Was', value: answerWords(o.was, o.inherited, o.follows) },
      { label: 'Also goes off', value: lost.map(labelOf).join(', ') },
      { label: 'Also comes on', value: gained.map(labelOf).join(', ') },
    ],
    'Save the change',
    warnings,
  );
}

const permissionArg = (args: Args) => {
  const permission = str(args['permission']);
  if (!permission || !infoOf(permission))
    throw need('permission', 'Say which permission, as the Permissions screen names it.');
  if (args['allowed'] === undefined)
    throw need('allowed', 'Say whether to turn it on, off, or back to what it follows.');
  return { permission, allowed: args['allowed'] as boolean | null };
};

const roleArg = (args: Args): CustomizableRole => {
  const role = str(args['role']);
  if (role !== 'admin' && role !== 'member') throw need('role', 'Say admins or members.');
  return role;
};

const personIn = (s: PermissionSettings, userId: unknown) => {
  const person = s.people.find((p) => p.userId === userId);
  if (!person) throw HfosError.notFound('That person isn’t in this business.');
  if (person.role === 'owner')
    throw need(
      'userId',
      'Owners can always do everything. Change their role first to set what they may do.',
    );
  return person;
};

const managePermissions: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const s = await query<PermissionSettings>(db, ctx, 'permission.settings');
    const roleSettings = (role: WorkspaceRole) =>
      s.roles.find((r) => r.role === role)?.settings ?? {};

    if (act === 'reset_role' || act === 'set_role') {
      const role = roleArg(args);
      const settings = roleSettings(role);
      const who = PLURAL[role];
      if (act === 'reset_role') {
        const set = Object.keys(settings).filter((p) => infoOf(p));
        if (!set.length) throw nothing();
        return {
          card: card(
            toolCallId,
            'manage_permissions',
            `Put ${who} back to the defaults`,
            [
              { label: 'Who', value: cap(who) },
              {
                label: 'Back to the default',
                value: set
                  .map((p) => `${labelOf(p)} (${byDefault(role, p) ? 'on' : 'off'})`)
                  .join(', '),
              },
            ],
            'Reset them',
            [{ kind: 'note', text: 'People’s own settings stay as they are.' }],
          ),
          result: { waiting: true, role, settingsCleared: set.length },
        };
      }
      const { permission, allowed } = permissionArg(args);
      const was = settings[permission];
      if ((was ?? null) === allowed) throw nothing();
      const next = { ...settings };
      if (allowed === null) delete next[permission];
      else next[permission] = allowed;
      return {
        card: permissionCard(toolCallId, {
          who,
          whoLine: cap(who),
          person: false,
          permission,
          allowed,
          was,
          inherited: byDefault(role, permission),
          follows: 'Default',
          before: effectivePermissions(role, settings),
          after: effectivePermissions(role, next),
        }),
        result: { waiting: true, role, permission, allowed },
      };
    }

    const person = personIn(s, args['userId']);
    const ofRole = roleSettings(person.role);
    const whoLine = `${person.fullName} (${ROLE_LABELS[person.role]})`;
    if (act === 'reset_person') {
      const set = Object.keys(person.settings).filter((p) => infoOf(p));
      if (!set.length) throw nothing();
      return {
        card: card(
          toolCallId,
          'manage_permissions',
          `Put ${person.fullName} back to what their role says`,
          [
            { label: 'Who', value: whoLine },
            {
              label: 'Settings of their own',
              value: set
                .map((p) => `${labelOf(p)} (${person.settings[p] ? 'on' : 'off'})`)
                .join(', '),
            },
          ],
          'Reset them',
          [
            {
              kind: 'note',
              text: `They do what the ${ROLE_LABELS[person.role]} role does, as set on Settings → Permissions.`,
            },
          ],
        ),
        result: { waiting: true, userId: person.userId, settingsCleared: set.length },
      };
    }
    const { permission, allowed } = permissionArg(args);
    const was = person.settings[permission];
    if ((was ?? null) === allowed) throw nothing();
    const next = { ...person.settings };
    if (allowed === null) delete next[permission];
    else next[permission] = allowed;
    return {
      card: permissionCard(toolCallId, {
        who: person.fullName,
        whoLine,
        person: true,
        permission,
        allowed,
        was,
        inherited: ofRole[permission] ?? byDefault(person.role, permission),
        follows: `Same as ${ROLE_LABELS[person.role]}`,
        before: effectivePermissions(person.role, ofRole, person.settings),
        after: effectivePermissions(person.role, ofRole, next),
      }),
      result: { waiting: true, userId: person.userId, permission, allowed },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const roles = href(ctx, 'settings/permissions');
    const theirs = href(ctx, `members?permissions=${String(args['userId'])}`);
    const nameOf = async () =>
      (
        await query<PermissionSettings>(db, ctx, 'permission.settings').catch(() => null)
      )?.people.find((p) => p.userId === args['userId'])?.fullName ?? 'Them';
    switch (act) {
      case 'set_role': {
        const role = roleArg(args);
        await command(db, ctx, 'permission.set_role', {
          role,
          permission: args['permission'],
          allowed: args['allowed'],
        });
        return {
          outcome: `Saved for ${PLURAL[role]}`,
          href: roles,
          command: 'permission.set_role',
        };
      }
      case 'reset_role': {
        const role = roleArg(args);
        await command(db, ctx, 'permission.reset', { role });
        return {
          outcome: `${cap(PLURAL[role])} are back to the defaults`,
          href: roles,
          command: 'permission.reset',
        };
      }
      case 'set_person':
        await command(db, ctx, 'permission.set_member', {
          userId: args['userId'],
          permission: args['permission'],
          allowed: args['allowed'],
        });
        return {
          outcome: `Saved for ${await nameOf()}`,
          href: theirs,
          command: 'permission.set_member',
        };
      default:
        await command(db, ctx, 'permission.reset', { userId: args['userId'] });
        return {
          outcome: `${await nameOf()} does what their role says again`,
          href: theirs,
          command: 'permission.reset',
        };
    }
  },
};

// ---------- fields, kinds of records and relationships ----------

interface CustomField {
  id: string;
  entity: 'person' | 'company' | 'lead' | 'custom_record';
  recordTypeId: string | null;
  label: string;
  type: CustomFieldType;
  options: { value: string; label: string }[];
  help: string;
  alwaysShow: boolean;
}
interface Kind {
  id: string;
  singular: string;
  plural: string;
  nameLabel: string;
  icon: string;
  archived: boolean;
  archivedAt: string | null;
  recordCount: number;
  fieldCount: number;
}
interface KindRef {
  id: string;
  singular: string;
  plural: string;
  archived: boolean;
}
interface RelEnd {
  end: RelationshipEndKind;
  recordType: KindRef | null;
  label: string;
}
interface RelType {
  id: string;
  a: RelEnd;
  b: RelEnd;
  cardinality: RelationshipCardinality;
  mutual: boolean;
  archivedAt: string | null;
  pairCount: number;
}

const fieldsOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ fields: CustomField[] }>(db, ctx, 'custom_field.list')).fields;
const kindsOf = async (db: Db, ctx: ToolContext, includeArchived = false) =>
  (await query<{ types: Kind[] }>(db, ctx, 'custom_record_type.list', { includeArchived })).types;
const relTypesOf = async (db: Db, ctx: ToolContext, includeArchived = false) =>
  (await query<{ types: RelType[] }>(db, ctx, 'relationship_type.list', { includeArchived })).types;

/** Whose fields they are, in the screen's words: customers, companies, or one kind's own name. */
function targetOf(entity: string, kind: Pick<Kind, 'id' | 'singular' | 'plural'> | undefined) {
  if (entity === 'person') return { many: 'customers', one: 'customer', key: 'person' };
  if (entity === 'company') return { many: 'companies', one: 'company', key: 'company' };
  if (entity === 'lead') return { many: 'leads', one: 'lead', key: 'lead' };
  return {
    many: lowerLabel(kind?.plural ?? 'records'),
    one: lowerLabel(kind?.singular ?? 'record'),
    key: kind?.id ?? '',
  };
}

/** A list field needs choices, and only a list field has them: said here, before the card. */
function checkChoices(type: CustomFieldType, given: string[] | undefined, path = 'choices') {
  if (hasOptions(type) && !given?.length) throw need(path, 'Add at least one choice.');
  if (!hasOptions(type) && given?.length) throw need(path, 'Only a list field has choices.');
  const seen = new Set<string>();
  for (const c of given ?? []) {
    if (seen.has(c.toLowerCase())) throw need(path, 'Two choices have the same name.');
    seen.add(c.toLowerCase());
  }
}

/** The whole list as the command keeps it: a choice already there keeps its value, so records keep their answer. */
const optionsFor = (given: string[], current: CustomField['options']) =>
  given.map((label) => {
    const kept = current.find((o) => same(o.label, label));
    return kept ? { value: kept.value, label } : { label };
  });

const typeWords = (t: CustomFieldType) => CUSTOM_FIELD_TYPE_LABELS[t] ?? t;

async function liveField(db: Db, ctx: ToolContext, id: unknown) {
  const field = (await fieldsOf(db, ctx)).find((f) => f.id === id);
  if (!field) throw HfosError.notFound('That field isn’t here, or it was retired.');
  const kind = field.recordTypeId
    ? (await kindsOf(db, ctx, true)).find((k) => k.id === field.recordTypeId)
    : undefined;
  return { field, target: targetOf(field.entity, kind) };
}

const manageCustomField: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_custom_field';
    const name = str(args['name']);
    const given = list<string>(args['choices']);
    const help = typeof args['help'] === 'string' ? args['help'].trim() : undefined;
    const show = bool(args['showWhenEmpty']);

    if (act === 'create') {
      const entity = str(args['recordType']);
      if (!entity)
        throw need(
          'recordType',
          'Say whether it goes on customers, companies or a kind of record.',
        );
      let kind: Kind | undefined;
      if (entity === 'custom_record') {
        kind = (await kindsOf(db, ctx)).find((k) => k.id === args['recordTypeId']);
        if (!kind) throw HfosError.notFound('That kind of record isn’t here.');
      }
      if (!name) throw need('name', 'Name the field.');
      const type = (str(args['holds']) ?? 'text') as CustomFieldType;
      checkChoices(type, given);
      const target = targetOf(entity, kind);
      const clash = (await fieldsOf(db, ctx)).find(
        (f) =>
          f.entity === entity &&
          (f.recordTypeId ?? null) === (kind?.id ?? null) &&
          same(f.label, name),
      );
      if (clash)
        throw HfosError.conflict(
          `There’s already a field called “${clash.label}” on ${target.many}.`,
          'field_label_taken',
        );
      return {
        card: card(
          toolCallId,
          tool,
          `Add the ${name} field to ${target.many}`,
          [
            { label: 'Name', value: name },
            { label: 'On', value: cap(target.many) },
            { label: 'Holds', value: typeWords(type) },
            { label: 'Choices', value: (given ?? []).join(', ') },
            { label: 'Help', value: help ?? '' },
            {
              label: 'Shows',
              value: show ? `On every ${target.one}, even when empty` : 'Once it’s filled in',
            },
          ],
          'Add it',
          [
            {
              kind: 'note',
              text: 'What it holds can’t change later, so what’s filled in keeps its meaning.',
            },
          ],
        ),
        result: { waiting: true },
      };
    }

    const { field, target } = await liveField(db, ctx, args['customFieldId']);
    if (act === 'retire')
      return {
        card: card(
          toolCallId,
          tool,
          `Retire the ${field.label} field?`,
          [
            { label: 'Field', value: field.label },
            { label: 'On', value: cap(target.many) },
            { label: 'Holds', value: typeWords(field.type) },
          ],
          'Retire it',
          [
            {
              kind: 'caution',
              text: `It comes off every ${target.one} that has it filled in, and can’t be brought back.`,
            },
          ],
        ),
        result: { waiting: true },
      };

    const holds = str(args['holds']);
    if (holds && holds !== field.type)
      throw need(
        'holds',
        'What a field holds never changes, so what’s filled in keeps its meaning. Retire it and add a new one instead.',
      );
    const fields: Field[] = [{ label: 'Field', value: field.label }];
    const warnings: Warning[] = [];
    let changes = 0;
    if (name && name !== field.label) {
      const clash = (await fieldsOf(db, ctx)).find(
        (f) =>
          f.id !== field.id &&
          f.entity === field.entity &&
          f.recordTypeId === field.recordTypeId &&
          same(f.label, name),
      );
      if (clash)
        throw HfosError.conflict(
          `There’s already a field called “${clash.label}” on ${target.many}.`,
          'field_label_taken',
        );
      fields.push({ label: 'Name', value: name });
      changes++;
    }
    if (given) {
      checkChoices(field.type, given);
      const now = field.options.map((o) => o.label);
      if (now.join('\n') !== given.join('\n')) {
        fields.push({ label: 'Choices', value: given.join(', ') });
        const gone = now.filter((l) => !given.some((g) => same(g, l)));
        if (gone.length) {
          fields.push({ label: 'Taken off', value: gone.join(', ') });
          warnings.push({
            kind: 'note',
            text: 'A choice taken off the list stays on the records that already have it.',
          });
        }
        changes++;
      }
    }
    if (help !== undefined && help !== field.help) {
      fields.push({ label: 'Help', value: help || 'None' });
      changes++;
    }
    if (show !== undefined && show !== field.alwaysShow) {
      fields.push({
        label: 'Shows',
        value: show ? `On every ${target.one}, even when empty` : 'Once it’s filled in',
      });
      changes++;
    }
    if (!changes) throw nothing();
    return {
      card: card(
        toolCallId,
        tool,
        `Change the ${field.label} field`,
        fields,
        'Save the change',
        warnings,
      ),
      result: { waiting: true, changes: fields.slice(1).map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    if (act === 'create') {
      const entity = String(args['recordType']);
      await command(db, ctx, 'custom_field.create', {
        entity,
        ...(entity === 'custom_record' ? { recordTypeId: args['recordTypeId'] } : {}),
        label: str(args['name']),
        type: str(args['holds']) ?? 'text',
        ...defined({
          options: list<string>(args['choices'])?.map((label) => ({ label })),
          help: typeof args['help'] === 'string' ? args['help'].trim() : undefined,
          alwaysShow: bool(args['showWhenEmpty']),
        }),
      });
      const key = entity === 'custom_record' ? String(args['recordTypeId']) : entity;
      return {
        outcome: `${str(args['name'])} is added`,
        href: href(ctx, `settings/fields?for=${key}`),
        command: 'custom_field.create',
      };
    }
    const { field, target } = await liveField(db, ctx, args['customFieldId']);
    const back = href(ctx, `settings/fields?for=${target.key}`);
    if (act === 'retire') {
      await command(db, ctx, 'custom_field.archive', { customFieldId: field.id });
      return { outcome: `${field.label} is retired`, href: back, command: 'custom_field.archive' };
    }
    const given = list<string>(args['choices']);
    await command(db, ctx, 'custom_field.update', {
      customFieldId: field.id,
      ...defined({
        label: str(args['name']),
        options: given ? optionsFor(given, field.options) : undefined,
        help: typeof args['help'] === 'string' ? args['help'].trim() : undefined,
        alwaysShow: bool(args['showWhenEmpty']),
      }),
    });
    return { outcome: 'Saved', href: back, command: 'custom_field.update' };
  },
};

const iconOf = (v: unknown): RecordIcon | undefined =>
  typeof v === 'string' && v in RECORD_ICON_LABELS ? (v as RecordIcon) : undefined;

interface StarterField {
  name: string;
  holds: CustomFieldType;
  choices?: string[];
}

const manageRecordKind: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_record_kind';
    const kinds = await kindsOf(db, ctx, true);
    const live = kinds.filter((k) => !k.archivedAt);
    const name = str(args['name']);

    if (act === 'create') {
      if (!name) throw need('name', 'Say what one of them is called, like Pet.');
      const clash = live.find((k) => same(k.singular, name));
      if (clash)
        throw HfosError.conflict(
          `There’s already a kind of record called “${clash.singular}”.`,
          'record_type_taken',
        );
      const many = str(args['plural']) ?? pluralOf(name);
      const starters = list<StarterField>(args['fields']) ?? [];
      starters.forEach((f, i) => checkChoices(f.holds, f.choices, `fields.${i}.choices`));
      const linkTo = str(args['linkTo']) as 'person' | 'company' | undefined;
      const linkLabel = str(args['linkLabel']);
      if (linkTo && !linkLabel)
        throw need('linkLabel', 'Say what the customer is to one of these, like Owner.');
      const how = (str(args['linkCardinality']) ?? 'many_to_many') as RelationshipCardinality;
      const icon = iconOf(args['icon']) ?? 'box';
      return {
        card: card(
          toolCallId,
          tool,
          `Add ${many} as a kind of record`,
          [
            { label: 'One is called', value: name },
            { label: 'More than one', value: many },
            { label: 'Its name is called', value: str(args['nameLabel']) ?? 'Name' },
            { label: 'Picture', value: RECORD_ICON_LABELS[icon] },
            {
              label: 'First fields',
              value: starters.map((f) => `${f.name} (${typeWords(f.holds)})`).join(', '),
            },
            {
              label: 'Tied to',
              value: linkTo
                ? `${linkTo === 'person' ? 'Customers' : 'Companies'}, as “${linkLabel}”`
                : '',
            },
            {
              label: 'How many',
              value:
                linkTo && linkLabel
                  ? cardinalitySentences({
                      a: { end: linkTo, label: linkLabel },
                      b: {
                        end: 'custom_record',
                        label: name,
                        kind: { singular: name, plural: many },
                      },
                      cardinality: how,
                      mutual: false,
                    }).join(' ')
                  : '',
            },
          ],
          'Add it',
          [{ kind: 'note', text: 'More fields can go on it later, under Settings → Fields.' }],
        ),
        result: { waiting: true },
      };
    }

    const kind = kinds.find((k) => k.id === args['customRecordTypeId']);
    if (!kind) throw HfosError.notFound('That kind of record isn’t here.');

    if (act === 'restore') {
      if (!kind.archivedAt) throw need('customRecordTypeId', `${kind.plural} aren’t archived.`);
      const clash = live.find((k) => same(k.singular, kind.singular));
      if (clash)
        throw HfosError.conflict(
          `There’s already a kind of record called “${clash.singular}”. Rename that one first.`,
          'record_type_taken',
        );
      return {
        card: card(
          toolCallId,
          tool,
          `Bring back ${kind.plural}`,
          [
            { label: 'Kind', value: kind.plural },
            { label: 'Records', value: String(kind.recordCount) },
          ],
          'Bring it back',
          [{ kind: 'note', text: 'The relationships archived with it come back too.' }],
        ),
        result: { waiting: true },
      };
    }
    if (kind.archivedAt)
      throw need('customRecordTypeId', `${kind.plural} are archived. Bring them back first.`);

    if (act === 'archive') {
      const ties = (await relTypesOf(db, ctx)).filter(
        (t) => t.a.recordType?.id === kind.id || t.b.recordType?.id === kind.id,
      );
      return {
        card: card(
          toolCallId,
          tool,
          `Archive ${kind.plural}?`,
          [
            { label: 'Kind', value: kind.plural },
            { label: 'Records', value: String(kind.recordCount) },
            { label: 'Fields', value: String(kind.fieldCount) },
            { label: 'Relationships', value: ties.map((t) => relationshipTypeName(t)).join(', ') },
          ],
          'Archive it',
          [
            {
              kind: 'note',
              text: 'Its tab, its records and its relationships are hidden. Nothing is deleted, and bringing it back restores them.',
            },
          ],
        ),
        result: { waiting: true },
      };
    }

    // change
    const fields: Field[] = [{ label: 'Kind', value: kind.plural }];
    if (name && name !== kind.singular) {
      const clash = live.find((k) => k.id !== kind.id && same(k.singular, name));
      if (clash)
        throw HfosError.conflict(
          `There’s already a kind of record called “${clash.singular}”.`,
          'record_type_taken',
        );
      fields.push({ label: 'One is called', value: name }, { label: 'Was', value: kind.singular });
    }
    const many = str(args['plural']);
    if (many && many !== kind.plural) fields.push({ label: 'More than one', value: many });
    const nameLabel = str(args['nameLabel']);
    if (nameLabel && nameLabel !== kind.nameLabel)
      fields.push({ label: 'Its name is called', value: nameLabel });
    const icon = iconOf(args['icon']);
    if (icon && icon !== kind.icon)
      fields.push({ label: 'Picture', value: RECORD_ICON_LABELS[icon] });
    if (fields.length === 1) throw nothing();
    return {
      card: card(toolCallId, tool, `Change ${kind.plural}`, fields, 'Save the change'),
      result: { waiting: true, changes: fields.slice(1).map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/relationships');
    if (act === 'create') {
      const linkTo = str(args['linkTo']);
      await command(db, ctx, 'custom_record_type.create', {
        singular: str(args['name']),
        ...defined({
          plural: str(args['plural']),
          nameLabel: str(args['nameLabel']),
          icon: iconOf(args['icon']),
        }),
        fields: (list<StarterField>(args['fields']) ?? []).map((f) => ({
          label: f.name,
          type: f.holds,
          ...(f.choices?.length ? { options: f.choices } : {}),
        })),
        ...(linkTo
          ? {
              link: {
                end: linkTo,
                label: str(args['linkLabel']),
                cardinality: str(args['linkCardinality']) ?? 'many_to_many',
              },
            }
          : {}),
      });
      const many = str(args['plural']) ?? pluralOf(String(args['name']));
      return { outcome: `${many} are ready`, href: back, command: 'custom_record_type.create' };
    }
    const customRecordTypeId = args['customRecordTypeId'];
    if (act === 'archive' || act === 'restore') {
      const name = `custom_record_type.${act}`;
      await command(db, ctx, name, { customRecordTypeId });
      return {
        outcome: act === 'archive' ? 'Archived' : 'Brought back',
        href: back,
        command: name,
      };
    }
    await command(db, ctx, 'custom_record_type.update', {
      customRecordTypeId,
      ...defined({
        singular: str(args['name']),
        plural: str(args['plural']),
        nameLabel: str(args['nameLabel']),
        icon: iconOf(args['icon']),
      }),
    });
    return { outcome: 'Saved', href: back, command: 'custom_record_type.update' };
  },
};

interface EndIn {
  end: RelationshipEndKind;
  recordTypeId?: string;
  label: string;
}

/** An end as the words need it: what it is, and its kind's names when it is one of the business's own. */
const endWords = (e: EndIn, kinds: Kind[]) => ({
  end: e.end,
  label: e.label,
  kind: e.end === 'custom_record' ? (kinds.find((k) => k.id === e.recordTypeId) ?? null) : null,
});
const endLine = (e: ReturnType<typeof endWords>) => `${endKindWords(e)}, called “${e.label}”`;
const relOut = (t: RelType) => ({
  a: { end: t.a.end, label: t.a.label, kind: t.a.recordType },
  b: { end: t.b.end, label: t.b.label, kind: t.b.recordType },
  cardinality: t.cardinality,
  mutual: t.mutual,
});

const manageRelationshipType: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_relationship_type';
    const types = await relTypesOf(db, ctx, true);
    const live = types.filter((t) => !t.archivedAt);

    if (act === 'create') {
      const kinds = await kindsOf(db, ctx);
      const mutual = bool(args['sameBothWays']) ?? false;
      const a = args['a'] as EndIn | undefined;
      const b = mutual ? a : (args['b'] as EndIn | undefined);
      if (!a || !b) throw need(a ? 'b' : 'a', 'Say what each end is and what it’s called.');
      for (const [path, e] of [
        ['a', a],
        ['b', b],
      ] as const)
        if (e.end === 'custom_record' && !kinds.some((k) => k.id === e.recordTypeId))
          throw HfosError.notFound(`End ${path.toUpperCase()}’s kind of record isn’t here.`);
      const how = (str(args['cardinality']) ?? 'many_to_many') as RelationshipCardinality;
      if (mutual && how !== 'one_to_one' && how !== 'many_to_many')
        throw need('cardinality', 'Each can have one, or each can have many.');
      const key = (e: EndIn) =>
        `${e.end}:${e.end === 'custom_record' ? e.recordTypeId : ''}:${e.label.trim().toLowerCase()}`;
      const liveKey = (e: RelEnd) =>
        `${e.end}:${e.recordType?.id ?? ''}:${e.label.trim().toLowerCase()}`;
      if (
        live.some(
          (t) =>
            (liveKey(t.a) === key(a) && liveKey(t.b) === key(b)) ||
            (liveKey(t.a) === key(b) && liveKey(t.b) === key(a)),
        )
      )
        throw HfosError.conflict('That relationship is already set up.', 'relationship_type_taken');
      const words = { a: endWords(a, kinds), b: endWords(b, kinds), cardinality: how, mutual };
      return {
        card: card(
          toolCallId,
          tool,
          `Set up ${relationshipTypeName(words)}`,
          mutual
            ? [
                { label: 'Between', value: endLine(words.a) },
                { label: 'How many', value: cardinalitySentences(words).join(' ') },
              ]
            : [
                { label: 'End A', value: endLine(words.a) },
                { label: 'End B', value: endLine(words.b) },
                { label: 'How many', value: cardinalitySentences(words).join(' ') },
              ],
          'Set it up',
        ),
        result: { waiting: true },
      };
    }

    const type = types.find((t) => t.id === args['relationshipTypeId']);
    if (!type) throw HfosError.notFound('That relationship type isn’t here.');
    const name = relationshipTypeName(type);

    if (act === 'restore') {
      if (!type.archivedAt) throw need('relationshipTypeId', `“${name}” isn’t archived.`);
      const gone = [type.a.recordType, type.b.recordType].find((k) => k?.archived);
      if (gone) throw need('relationshipTypeId', `Bring back ${gone.plural} first.`);
      return {
        card: card(
          toolCallId,
          tool,
          `Bring back “${name}”`,
          [
            { label: 'Relationship', value: name },
            { label: 'Pairs', value: String(type.pairCount) },
          ],
          'Bring it back',
        ),
        result: { waiting: true },
      };
    }
    if (type.archivedAt)
      throw need('relationshipTypeId', `“${name}” is archived. Bring it back first.`);

    if (act === 'archive')
      return {
        card: card(
          toolCallId,
          tool,
          `Archive “${name}”?`,
          [
            { label: 'Relationship', value: name },
            { label: 'Pairs', value: String(type.pairCount) },
          ],
          'Archive it',
          [
            {
              kind: 'note',
              text: 'Its relationships are hidden from every record. Nothing is deleted, and bringing it back restores them.',
            },
          ],
        ),
        result: { waiting: true },
      };

    // change: what each end is called, and how many each may have
    const aLabel = str(args['aLabel']) ?? (type.mutual ? str(args['bLabel']) : undefined);
    const bLabel = type.mutual ? aLabel : str(args['bLabel']);
    const how = str(args['cardinality']) as RelationshipCardinality | undefined;
    if (type.mutual && how && how !== 'one_to_one' && how !== 'many_to_many')
      throw need('cardinality', 'Each can have one, or each can have many.');
    const out = relOut(type);
    const next = {
      ...out,
      a: { ...out.a, label: aLabel ?? type.a.label },
      b: { ...out.b, label: bLabel ?? type.b.label },
      cardinality: how ?? type.cardinality,
    };
    const renamed = next.a.label !== type.a.label || next.b.label !== type.b.label;
    const counted = next.cardinality !== type.cardinality;
    if (!renamed && !counted) throw nothing();
    const narrower = (['a', 'b'] as const).some(
      (side) => manyFor(type.cardinality, side) && !manyFor(next.cardinality, side),
    );
    return {
      card: card(
        toolCallId,
        tool,
        `Change “${name}”`,
        [
          { label: 'Relationship', value: name },
          { label: 'Now', value: renamed ? relationshipTypeName(next) : '' },
          { label: 'How many', value: counted ? cardinalitySentences(next).join(' ') : '' },
        ],
        'Save the change',
        narrower && type.pairCount > 0
          ? [
              {
                kind: 'note',
                text: 'If a record already has more than one, this is refused until it has one.',
              },
            ]
          : [],
      ),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/relationships');
    if (act === 'create') {
      const mutual = bool(args['sameBothWays']) ?? false;
      const end = (e: EndIn) => ({
        end: e.end,
        ...(e.end === 'custom_record' ? { recordTypeId: e.recordTypeId } : {}),
        label: e.label,
      });
      const a = end(args['a'] as EndIn);
      await command(db, ctx, 'relationship_type.create', {
        a,
        b: mutual ? a : end(args['b'] as EndIn),
        mutual,
        cardinality: str(args['cardinality']) ?? 'many_to_many',
      });
      return { outcome: 'It’s set up', href: back, command: 'relationship_type.create' };
    }
    const relationshipTypeId = args['relationshipTypeId'];
    if (act === 'archive' || act === 'restore') {
      const name = `relationship_type.${act}`;
      await command(db, ctx, name, { relationshipTypeId });
      return {
        outcome: act === 'archive' ? 'Archived' : 'Brought back',
        href: back,
        command: name,
      };
    }
    await command(db, ctx, 'relationship_type.update', {
      relationshipTypeId,
      ...defined({
        aLabel: str(args['aLabel']),
        bLabel: str(args['bLabel']),
        cardinality: str(args['cardinality']),
      }),
    });
    return { outcome: 'Saved', href: back, command: 'relationship_type.update' };
  },
};

// ---------- saved wording ----------

interface Template {
  id: string;
  name: string;
  channel: 'sms' | 'email';
  subject: string | null;
  body: string;
  folder: string | null;
  usedCount: number;
  archivedAt: string | null;
}

const templatesOf = async (db: Db, ctx: ToolContext, includeArchived = false) =>
  (await query<{ templates: Template[] }>(db, ctx, 'template.list', { includeArchived })).templates;
const CHANNEL_WORDS = { sms: 'Text', email: 'Email' } as const;

/** What the reply box will fill in, and any {{…}} it won't: that one goes out just as typed. */
function placeholderLines(text: string): { fills: string; broken: Warning[] } {
  const vars = templateVars(text);
  const bad = vars.filter((v) => !v.valid);
  return {
    fills: [...new Set(vars.filter((v) => v.valid).map((v) => v.path))].join(', '),
    broken: bad.length
      ? [
          {
            kind: 'caution',
            text: `${bad.map((v) => `{{${v.raw}}}`).join(', ')} isn’t a placeholder HandsFreeOS knows, so it would go out just as typed.`,
          },
        ]
      : [],
  };
}

const manageTemplate: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_template';
    const all = await templatesOf(db, ctx, true);
    const live = all.filter((t) => !t.archivedAt);
    const name = str(args['name']);
    const body = str(args['body']);
    const taken = (n: string, except?: string) => {
      const clash = live.find((t) => t.id !== except && same(t.name, n));
      if (clash)
        throw HfosError.conflict(
          `You already have a template called "${clash.name}".`,
          'duplicate',
        );
    };

    if (act === 'create') {
      if (!name) throw need('name', 'Name it, so it can be found again.');
      if (!body) throw need('body', 'Write the message.');
      const channel = (str(args['channel']) ?? 'sms') as Template['channel'];
      const subject = str(args['subject']);
      if (channel === 'sms' && subject)
        throw need('subject', 'A text message has no subject line.');
      taken(name);
      const { fills, broken } = placeholderLines(`${subject ?? ''}\n${body}`);
      return {
        card: {
          ...card(
            toolCallId,
            tool,
            `Save the ${name} template`,
            [
              { label: 'Name', value: name },
              { label: 'Send as', value: CHANNEL_WORDS[channel] },
              { label: 'Subject', value: subject ?? '' },
              { label: 'Folder', value: str(args['folder']) ?? '' },
              { label: 'Fills in', value: fills },
            ],
            'Save it',
            [
              ...broken,
              {
                kind: 'note',
                text: 'Nothing is sent. It waits under Insert a template in the inbox’s reply box.',
              },
            ],
          ),
          body: clip(body, 1000),
        },
        result: { waiting: true },
      };
    }

    const template = all.find((t) => t.id === args['templateId']);
    if (!template) throw HfosError.notFound('That template isn’t here.');

    if (act === 'restore') {
      if (!template.archivedAt) throw need('templateId', `${template.name} isn’t archived.`);
      taken(template.name);
      return {
        card: card(
          toolCallId,
          tool,
          `Bring back the ${template.name} template`,
          [
            { label: 'Template', value: template.name },
            { label: 'Send as', value: CHANNEL_WORDS[template.channel] },
          ],
          'Bring it back',
        ),
        result: { waiting: true },
      };
    }
    if (template.archivedAt)
      throw need('templateId', `${template.name} is archived. Bring it back first.`);

    if (act === 'archive')
      return {
        card: card(
          toolCallId,
          tool,
          `Archive the ${template.name} template?`,
          [
            { label: 'Template', value: template.name },
            { label: 'Send as', value: CHANNEL_WORDS[template.channel] },
            { label: 'Used', value: plural(template.usedCount, 'time') },
          ],
          'Archive it',
          [
            {
              kind: 'note',
              text: 'It leaves the reply box’s list. Nothing is deleted, and it can be brought back.',
            },
          ],
        ),
        result: { waiting: true },
      };

    // change
    const fields: Field[] = [{ label: 'Template', value: template.name }];
    const warnings: Warning[] = [];
    if (name && name !== template.name) {
      if (!same(name, template.name)) taken(name, template.id);
      fields.push({ label: 'Name', value: name });
    }
    const channel = str(args['channel']) as Template['channel'] | undefined;
    const to = channel ?? template.channel;
    const subject = args['subject'] === undefined ? undefined : (str(args['subject']) ?? null);
    if (to === 'sms' && subject) throw need('subject', 'A text message has no subject line.');
    if (channel && channel !== template.channel) {
      fields.push({ label: 'Send as', value: CHANNEL_WORDS[channel] });
      if (channel === 'sms' && template.subject)
        warnings.push({ kind: 'note', text: 'A text has no subject, so the subject line goes.' });
    }
    if (subject !== undefined && subject !== template.subject)
      fields.push({ label: 'Subject', value: subject ?? 'None' });
    const folder = args['folder'] === undefined ? undefined : (str(args['folder']) ?? null);
    if (folder !== undefined && folder !== template.folder)
      fields.push({ label: 'Folder', value: folder ?? 'None' });
    const wording = body && body !== template.body ? body : undefined;
    if (wording) fields.push({ label: 'Message', value: 'New wording, below' });
    if (fields.length === 1) throw nothing();
    const { fills, broken } = placeholderLines(
      `${(subject === undefined ? template.subject : subject) ?? ''}\n${wording ?? template.body}`,
    );
    if (wording) fields.push({ label: 'Fills in', value: fills });
    return {
      card: {
        ...card(
          toolCallId,
          tool,
          `Change the ${template.name} template`,
          fields,
          'Save the change',
          [...broken, ...warnings],
        ),
        body: wording ? clip(wording, 1000) : null,
      },
      result: { waiting: true, changes: fields.slice(1).map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/templates');
    if (act === 'create') {
      const channel = str(args['channel']) ?? 'sms';
      await command(db, ctx, 'template.create', {
        name: str(args['name']),
        channel,
        subject: channel === 'email' ? (str(args['subject']) ?? null) : null,
        body: str(args['body']),
        folder: str(args['folder']) ?? null,
      });
      return { outcome: `${str(args['name'])} is saved`, href: back, command: 'template.create' };
    }
    const templateId = args['templateId'];
    if (act === 'archive' || act === 'restore') {
      await command(db, ctx, 'template.archive', { templateId, restore: act === 'restore' });
      return {
        outcome: act === 'archive' ? 'Archived' : 'Brought back',
        href: back,
        command: 'template.archive',
      };
    }
    await command(db, ctx, 'template.update', {
      templateId,
      ...defined({
        name: str(args['name']),
        channel: str(args['channel']),
        subject: args['subject'] === undefined ? undefined : (str(args['subject']) ?? null),
        body: str(args['body']),
        folder: args['folder'] === undefined ? undefined : (str(args['folder']) ?? null),
      }),
    });
    return { outcome: 'Saved', href: back, command: 'template.update' };
  },
};

// ---------- numbers, and who sees which conversations ----------

interface PhoneNumber {
  id: string;
  display: string;
  status: string;
  label: string | null;
  isDefault: boolean;
  memberUserIds: string[];
}
interface RcsSender {
  senderId: string;
  status: string;
  enabled: boolean;
  phoneNumberId: string | null;
  sending: boolean;
}
interface PhoneStatus {
  numbers: PhoneNumber[];
  rcsSender: RcsSender | null;
}
interface Team {
  members: { userId: string; fullName: string; email: string; permissions?: string[] }[];
  organizationAdmins: { userId: string; fullName: string; email: string }[];
}

const phoneOf = (db: Db, ctx: ToolContext) => query<PhoneStatus>(db, ctx, 'phone.setup_status');
const teamOf = (db: Db, ctx: ToolContext) =>
  query<Team>(db, ctx, 'workspace.members').catch((): Team => ({
    members: [],
    organizationAdmins: [],
  }));
const lineName = (n: PhoneNumber) => (n.label ? `${n.label} · ${n.display}` : n.display);
const numberIn = (status: PhoneStatus, id: unknown) => {
  const n = status.numbers.find((x) => x.id === id);
  if (!n) throw HfosError.notFound('That number isn’t one of the business’s.');
  return n;
};

/** "Rings Dale and Mike", or everyone: nobody chosen is everyone with the inbox, never nobody. */
function ringsWords(ids: readonly string[], team: Team): string {
  if (!ids.length) return 'Everyone with the inbox';
  const people = [...team.members, ...team.organizationAdmins];
  return ids
    .map((id) => {
      const p = people.find((x) => x.userId === id);
      return p ? p.fullName || p.email : 'someone';
    })
    .join(', ');
}

const manageNumbers: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_numbers';
    const status = await phoneOf(db, ctx);
    const n = numberIn(status, args['phoneNumberId']);

    if (act === 'rename') {
      if (args['label'] === undefined) throw need('label', 'Say what to call it.');
      const label = str(args['label']) ?? null;
      if (label === (n.label ?? null)) throw nothing();
      return {
        card: card(
          toolCallId,
          tool,
          label ? `Call ${n.display} “${label}”` : `Take the name off ${n.display}`,
          [
            { label: 'Number', value: n.display },
            { label: 'Name', value: label ?? 'Just the number' },
            { label: 'Was', value: n.label ?? '' },
          ],
          'Save the change',
        ),
        result: { waiting: true },
      };
    }

    if (act === 'make_default') {
      if (n.isDefault) throw nothing();
      // The screen offers it only for a number in use, which is the one thing a default must be.
      if (n.status !== 'active')
        throw need('phoneNumberId', 'That number isn’t in use yet, so nothing can go out from it.');
      const was = status.numbers.find((x) => x.isDefault);
      return {
        card: card(
          toolCallId,
          tool,
          `Start new conversations from ${lineName(n)}`,
          [
            { label: 'Number', value: lineName(n) },
            { label: 'Was', value: was ? lineName(was) : '' },
          ],
          'Make it the default',
          [
            {
              kind: 'note',
              text: 'A conversation already going stays on the number that customer wrote to, whoever replies.',
            },
          ],
        ),
        result: { waiting: true },
      };
    }

    const ids = list<string>(args['userIds']);
    if (!ids)
      throw need('userIds', 'Say who it should ring; nobody means everyone with the inbox.');
    const wanted = [...new Set(ids)];
    const team = await teamOf(db, ctx);
    for (const id of wanted) {
      const member = team.members.find((m) => m.userId === id);
      if (!member && !team.organizationAdmins.some((a) => a.userId === id))
        throw HfosError.notFound('Someone on that list isn’t in this business.');
      if (member?.permissions && !member.permissions.includes('inbox.use'))
        throw need(
          'userIds',
          `${member.fullName || member.email} doesn’t work the inbox, so a number can’t ring them.`,
        );
    }
    if ([...wanted].sort().join() === [...n.memberUserIds].sort().join()) throw nothing();
    const { workspace } = await query<{ workspace: { inboxPerPerson: boolean } }>(
      db,
      ctx,
      'workspace.get',
    );
    const warnings: Warning[] = [];
    if (!wanted.length)
      warnings.push({
        kind: 'note',
        text: 'Nobody chosen means it rings everyone with the inbox.',
      });
    if (workspace.inboxPerPerson)
      warnings.push({
        kind: 'note',
        text: 'Each person sees only their own conversations, so these are also the people who see its conversations.',
      });
    return {
      card: card(
        toolCallId,
        tool,
        `Choose who ${lineName(n)} rings`,
        [
          { label: 'Number', value: lineName(n) },
          { label: 'Rings', value: ringsWords(wanted, team) },
          { label: 'Was', value: ringsWords(n.memberUserIds, team) },
        ],
        'Save the change',
        warnings,
      ),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/texting');
    const phoneNumberId = args['phoneNumberId'];
    if (act === 'rename') {
      await command(db, ctx, 'phone_number.set_label', {
        phoneNumberId,
        label: str(args['label']) ?? null,
      });
      return { outcome: 'Renamed', href: back, command: 'phone_number.set_label' };
    }
    if (act === 'make_default') {
      await command(db, ctx, 'phone_number.set_default', { phoneNumberId });
      return {
        outcome: 'New conversations go out from it now',
        href: back,
        command: 'phone_number.set_default',
      };
    }
    const out = await command<{ ringsEveryone: boolean }>(db, ctx, 'phone_number.set_members', {
      phoneNumberId,
      userIds: [...new Set(list<string>(args['userIds']) ?? [])],
    });
    return {
      outcome: out.ringsEveryone ? 'It rings everyone with the inbox' : 'Saved',
      href: back,
      command: 'phone_number.set_members',
    };
  },
};

const setInboxVisibility: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const want = args['eachPersonSeesTheirOwn'] === true;
    const { workspace } = await query<{ workspace: { inboxPerPerson: boolean } }>(
      db,
      ctx,
      'workspace.get',
    );
    if (workspace.inboxPerPerson === want) throw nothing();
    return {
      card: want
        ? card(
            toolCallId,
            'set_inbox_visibility',
            'Let each person see only their own conversations',
            [
              {
                label: 'Your team sees',
                value:
                  'The conversations assigned to them, and the ones on the numbers they answer. A new customer nobody has picked up yet is still seen by everybody.',
              },
              { label: 'You and your admins', value: 'Still see everything' },
            ],
            'Yes, narrow it',
            [
              {
                kind: 'caution',
                text: 'On their phones the others disappear from the inbox. Nothing is deleted, and they come back the moment this is switched off.',
              },
            ],
          )
        : card(
            toolCallId,
            'set_inbox_visibility',
            'Let everyone see every conversation',
            [
              {
                label: 'Your team sees',
                value: 'Every conversation, on the web and on their phones',
              },
            ],
            'Yes, open it up',
          ),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const perPerson = args['eachPersonSeesTheirOwn'] === true;
    const out = await command<{ conversationsChanged: number }>(db, ctx, 'inbox.set_visibility', {
      perPerson,
    });
    return {
      outcome: perPerson
        ? `Saved. ${plural(out.conversationsChanged, 'conversation')} moved to the people who own them`
        : 'Saved. Everyone can see every conversation again',
      href: href(ctx, 'settings/texting'),
      command: 'inbox.set_visibility',
    };
  },
};

// ---------- the business's own web address ----------

interface Domain {
  id: string;
  domain: string;
  status: 'pending' | 'verifying' | 'verified' | 'failed';
  records: { kind: 'TXT' | 'CNAME'; host: string; value: string }[];
  certificateReady: boolean;
  lastError: string | null;
}

const domainOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ domain: Domain | null }>(db, ctx, 'branded_domain.get')).domain;
const serving = (d: Domain) => d.status === 'verified' && d.certificateReady;
const DOMAIN_WORDS: Record<Domain['status'], string> = {
  pending: 'Just added',
  verifying: 'Waiting for your DNS',
  verified: 'Working',
  failed: 'Something is wrong',
};
/** The part that stays theirs, said the same way on the card, in the result and after Confirm. */
const DNS_IS_YOURS =
  'Putting the DNS records in is yours to do, where you bought the domain (GoDaddy, Namecheap, wherever it is). DNS often takes a few hours.';
const recordLines = (d: Domain) => d.records.map((r) => `${r.kind} ${r.host} → ${r.value}`);

/** The domain on the card is the one acted on: if it has changed since, nothing happens. */
async function theDomain(db: Db, ctx: ToolContext, typed: unknown): Promise<Domain> {
  const d = await domainOf(db, ctx);
  if (!d) throw HfosError.notFound('There’s no web address of the business’s own set up.');
  if (d.domain !== String(typed).trim().toLowerCase())
    throw need('domain', `The business is on ${d.domain}, not ${String(typed)}.`);
  return d;
}

const manageWebAddress: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_web_address';
    const domain = String(args['domain']);

    if (act === 'add') {
      const d = await domainOf(db, ctx);
      if (d?.domain === domain)
        throw need(
          'domain',
          `${domain} is already added (${DOMAIN_WORDS[d.status].toLowerCase()}).`,
        );
      if (d)
        throw need('domain', `The business is already on ${d.domain}. Stop using that one first.`);
      return {
        card: card(
          toolCallId,
          tool,
          `Put your links on ${domain}`,
          [
            { label: 'Domain', value: domain },
            {
              label: 'What moves',
              value:
                'Your forms, payment links, estimates, invoices, website chat and booking page',
            },
            {
              label: 'Yours to do',
              value: 'Put in the DNS records it asks for, where you bought the domain',
            },
          ],
          'Use this domain',
          [
            {
              kind: 'note',
              text: 'The records to put in show up in a moment. Until they are in, everything stays on handsfreeos.com, so nothing stops working.',
            },
          ],
        ),
        result: { waiting: true, yoursToDo: DNS_IS_YOURS },
      };
    }

    const d = await theDomain(db, ctx, domain);
    if (act === 'check') {
      if (serving(d)) throw need('domain', `${d.domain} is already working.`);
      return {
        card: card(
          toolCallId,
          tool,
          `Check ${d.domain} now`,
          [
            { label: 'Domain', value: d.domain },
            { label: 'Where it stands', value: DOMAIN_WORDS[d.status] },
            ...d.records.slice(0, 4).map((r) => ({ label: `${r.kind} ${r.host}`, value: r.value })),
          ],
          'Check now',
          [
            ...(d.lastError ? [{ kind: 'caution', text: clip(d.lastError, 200) }] : []),
            { kind: 'note', text: DNS_IS_YOURS },
          ],
        ),
        result: {
          waiting: true,
          status: DOMAIN_WORDS[d.status],
          records: d.records,
          yoursToDo: DNS_IS_YOURS,
        },
      };
    }
    return {
      card: card(
        toolCallId,
        tool,
        `Stop using ${d.domain}?`,
        [
          { label: 'Domain', value: d.domain },
          {
            label: 'Goes back to',
            value:
              'handsfreeos.com, for your forms, payment links, estimates, invoices and booking page',
          },
        ],
        'Stop using it',
        [
          {
            kind: 'caution',
            text: `Every link, QR code and flyer already carrying ${d.domain} stops working straight away, and the printed ones can’t be undone.`,
          },
        ],
      ),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/workspace');
    const domain = String(args['domain']);
    if (act === 'add') {
      await command(db, ctx, 'branded_domain.add', { domain });
      const d = await domainOf(db, ctx).catch(() => null);
      const records = d ? recordLines(d) : [];
      return {
        outcome: records.length
          ? `${domain} is added. ${DNS_IS_YOURS} The records: ${records.join('; ')}`
          : `${domain} is added. The DNS records to put in show on Settings → Workspace in a moment; putting them in where you bought the domain is yours to do. Ask me to check it and I’ll read them out.`,
        href: back,
        command: 'branded_domain.add',
      };
    }
    const d = await theDomain(db, ctx, domain);
    if (act === 'check') {
      await command(db, ctx, 'branded_domain.verify', { domainId: d.id });
      const records = recordLines(d);
      return {
        outcome: records.length
          ? `Checking now. Until these are in where you bought the domain, it waits: ${records.join('; ')}`
          : 'Checking now. The records show on Settings → Workspace once they’re worked out.',
        href: back,
        command: 'branded_domain.verify',
      };
    }
    await command(db, ctx, 'branded_domain.remove', { domainId: d.id });
    return {
      outcome: `Removed. Your forms, payment links and booking page are back on handsfreeos.com. The DNS records for ${d.domain} can come out whenever you like.`,
      href: back,
      command: 'branded_domain.remove',
    };
  },
};

// ---------- email: mail from strangers, and addresses nothing goes to ----------

interface Unmatched {
  id: string;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  toAddress: string | null;
}
interface Suppression {
  id: string;
  address: string;
  reason: 'hard_bounce' | 'spam_complaint' | 'manual';
  createdAt: string;
}

/** Every page of a list, up to where anybody would look: a few hundred rows. */
async function pages<T>(db: Db, ctx: ToolContext, name: string, input: Args = {}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    type Page = { items: T[]; nextCursor: string | null };
    const page: Page = await query<Page>(db, ctx, name, {
      ...input,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const REASON_WORDS: Record<Suppression['reason'], string> = {
  hard_bounce: 'Mail to it bounced',
  spam_complaint: 'They marked mail as spam',
  manual: 'Blocked by hand',
};
const fromLine = (u: Unmatched) =>
  u.fromName ? `${u.fromName} <${u.fromAddress}>` : u.fromAddress;

const unmatchedIn = async (db: Db, ctx: ToolContext, id: unknown) => {
  const u = (await pages<Unmatched>(db, ctx, 'email.unmatched_list')).find((x) => x.id === id);
  if (!u) throw HfosError.notFound('That email isn’t waiting any more; it was filed or dismissed.');
  return u;
};

const sortUnmatchedEmail: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const tool = 'sort_unmatched_email';
    const u = await unmatchedIn(db, ctx, args['unmatchedId']);
    const about = [
      { label: 'From', value: fromLine(u) },
      { label: 'Subject', value: u.subject ?? '(no subject)' },
      { label: 'Came in', value: when(u.receivedAt, ctx.timezone) },
    ];
    if (action(args) === 'dismiss')
      return {
        card: card(toolCallId, tool, 'Dismiss this email', about, 'Dismiss it', [
          {
            kind: 'note',
            text: 'It leaves the list without being filed under anyone. Nothing is sent to them.',
          },
        ]),
        result: { waiting: true },
      };
    if (!str(args['personId'])) throw need('personId', 'Say which customer to file it under.');
    const { person } = await query<{
      person: { id: string; fullName: string; archivedAt: string | null };
    }>(db, ctx, 'person.get', { personId: args['personId'] });
    if (person.archivedAt)
      throw need('personId', `Restore ${person.fullName} before filing mail under them.`);
    return {
      card: card(
        toolCallId,
        tool,
        `File this email under ${person.fullName}`,
        [...about, { label: 'Customer', value: person.fullName }],
        'File it',
        [{ kind: 'note', text: 'It joins their email conversation and their timeline.' }],
      ),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const back = href(ctx, 'settings/email');
    if (action(args) === 'dismiss') {
      await command(db, ctx, 'email.dismiss_unmatched', { unmatchedId: args['unmatchedId'] });
      return { outcome: 'Dismissed', href: back, command: 'email.dismiss_unmatched' };
    }
    const out = await command<{ personId: string }>(db, ctx, 'email.claim_unmatched', {
      unmatchedId: args['unmatchedId'],
      personId: args['personId'],
    });
    return {
      outcome: 'Filed under them',
      href: href(ctx, `customers/people/${out.personId}`),
      command: 'email.claim_unmatched',
    };
  },
};

const blockEmailAddress: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const address = String(args['address']).trim().toLowerCase();
    const blocked = await pages<Suppression>(db, ctx, 'email_suppression.list');
    if (blocked.some((s) => same(s.address, address)))
      throw need('address', 'Email to this address is already stopped.');
    const { items } = await query<{
      items: { id: string; fullName: string; email: string | null }[];
    }>(db, ctx, 'person.list', { q: address, limit: 5 }).catch(() => ({
      items: [] as { id: string; fullName: string; email: string | null }[],
    }));
    const theirs = items.filter((p) => p.email && same(p.email, address));
    return {
      card: card(
        toolCallId,
        'block_email_address',
        `Stop emailing ${address}`,
        [
          { label: 'Address', value: address },
          { label: 'Customer', value: theirs.map((p) => p.fullName).join(', ') },
        ],
        'Block it',
        [
          {
            kind: 'caution',
            text: 'Nothing goes to it, invoices and reminders included, until it is unblocked on Settings → Email.',
          },
        ],
      ),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    await command(db, ctx, 'email_suppression.add', {
      address: String(args['address']).trim().toLowerCase(),
    });
    return {
      outcome: 'Blocked',
      href: href(ctx, 'settings/email'),
      command: 'email_suppression.add',
    };
  },
};

// ---------- RCS, once it is connected ----------

/** Where the sender stands, as the RCS card's badge says it. */
function rcsWords(s: RcsSender): string {
  switch (s.status) {
    case 'connecting':
      return 'Connecting';
    case 'in_review':
      return 'In review with the carriers';
    case 'active':
      return s.sending ? 'On' : s.enabled ? 'Finishing setup' : 'Paused';
    case 'offline':
      return 'Offline';
    case 'failed':
      return 'Not connected';
    case 'disconnecting':
      return 'Disconnecting';
    default:
      return 'Off';
  }
}

const manageRcs: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_rcs';
    const status = await phoneOf(db, ctx);
    const s = status.rcsSender;
    if (!s || s.status === 'failed')
      throw HfosError.notFound(
        'This business has no RCS sender connected. Connecting one is on Settings → Texting & calls, with the sender made in its own Twilio account.',
      );
    const about = [
      { label: 'Sender', value: s.senderId },
      { label: 'Where it stands', value: rcsWords(s) },
    ];
    // The screen only offers these once the sender has settled; a moment later is soon enough.
    if (s.status === 'connecting' || s.status === 'disconnecting') {
      if (act === 'disconnect' && s.status === 'disconnecting') throw nothing();
      throw need('action', `It’s ${rcsWords(s).toLowerCase()} right now. Try again in a moment.`);
    }
    switch (act) {
      case 'pause':
      case 'turn_on': {
        const on = act === 'turn_on';
        if (s.enabled === on) throw nothing();
        return {
          card: card(
            toolCallId,
            tool,
            on ? 'Turn RCS back on' : 'Pause RCS',
            [
              ...about,
              {
                label: 'Texts go as',
                value: on ? 'RCS where the phone can show it' : 'SMS or MMS',
              },
            ],
            on ? 'Turn it on' : 'Pause it',
            [
              {
                kind: 'note',
                text: on
                  ? s.status === 'active'
                    ? 'Phones that can’t show RCS still get an ordinary text.'
                    : 'It starts sending once the carriers approve it; texts go as SMS or MMS until then.'
                  : 'The sender stays connected; it can be turned back on any time.',
              },
            ],
          ),
          result: { waiting: true },
        };
      }
      case 'start_on_number': {
        const id = (args['phoneNumberId'] as string | null | undefined) ?? null;
        const n = id ? numberIn(status, id) : null;
        if (n && n.status !== 'active')
          throw need(
            'phoneNumberId',
            'That number isn’t in use yet, so no conversation can start on it.',
          );
        if (id === s.phoneNumberId) throw nothing();
        const was = s.phoneNumberId ? status.numbers.find((x) => x.id === s.phoneNumberId) : null;
        return {
          card: card(
            toolCallId,
            tool,
            'Choose where new RCS conversations start',
            [
              { label: 'Starts on', value: n ? lineName(n) : 'Your default number' },
              { label: 'Was', value: was ? lineName(was) : 'Your default number' },
            ],
            'Save the change',
            [
              {
                kind: 'note',
                text: 'When a customer messages your RCS sender first, their conversation goes with this number.',
              },
            ],
          ),
          result: { waiting: true },
        };
      }
      case 'check_now':
        return {
          card: card(toolCallId, tool, 'Ask Twilio where RCS stands now', about, 'Check now'),
          result: { waiting: true },
        };
      default:
        return {
          card: card(toolCallId, tool, 'Disconnect RCS?', about, 'Disconnect', [
            {
              kind: 'note',
              text: 'Texts go as SMS and MMS again. The sender stays in your Twilio account, and connecting it again is on Settings → Texting & calls.',
            },
          ]),
          result: { waiting: true },
        };
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/texting');
    if (act === 'check_now') {
      await command(db, ctx, 'rcs_sender.refresh', {});
      return { outcome: 'Checking with Twilio', href: back, command: 'rcs_sender.refresh' };
    }
    if (act === 'disconnect') {
      await command(db, ctx, 'rcs_sender.disconnect', {});
      return { outcome: 'RCS disconnected', href: back, command: 'rcs_sender.disconnect' };
    }
    await command(
      db,
      ctx,
      'rcs_sender.update',
      act === 'start_on_number'
        ? { phoneNumberId: (args['phoneNumberId'] as string | null | undefined) ?? null }
        : { enabled: act === 'turn_on' },
    );
    return {
      outcome: act === 'pause' ? 'RCS paused' : act === 'turn_on' ? 'RCS is back on' : 'Saved',
      href: back,
      command: 'rcs_sender.update',
    };
  },
};

// ---------- website forms and connected apps, once they are made ----------

interface Source {
  kind: string;
  sourceId: string | null;
  name: string;
  active: boolean;
  createLead: boolean;
  pipelineId: string | null;
  stageId: string | null;
  dailyCap: number;
  lastIntakeAt: string | null;
  publicKey: string | null;
  secretHint: string | null;
  allowedOrigins: string[];
  redirectUrl: string | null;
}
interface IntakeList {
  sources: Source[];
  pipelines: { id: string; name: string; stages: { id: string; name: string; kind: string }[] }[];
}

const sourceIn = async (db: Db, ctx: ToolContext, id: unknown) => {
  const intake = await query<IntakeList>(db, ctx, 'intake.list');
  const source = intake.sources.find(
    (s) => s.sourceId === id && (s.kind === 'website_form' || s.kind === 'api'),
  );
  if (!source)
    throw HfosError.notFound(
      'That form or connected app isn’t here. Texts, calls and emails are changed with manage_lead_intake.',
    );
  return { intake, source, form: source.kind === 'website_form' };
};

const manageLeadForm: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const tool = 'manage_lead_form';
    const { intake, source, form } = await sourceIn(db, ctx, args['sourceId']);
    const what = { label: 'What', value: form ? 'A form on your website' : 'A connected app' };

    if (act === 'pause' || act === 'turn_on') {
      const on = act === 'turn_on';
      if (source.active === on) throw nothing();
      return {
        card: card(
          toolCallId,
          tool,
          on ? `Turn ${source.name} back on` : `Pause ${source.name}`,
          [
            what,
            { label: 'Leads', value: on ? 'Come in again' : 'Nothing more arrives through it' },
          ],
          on ? 'Turn it on' : 'Pause it',
          on
            ? []
            : [
                {
                  kind: 'caution',
                  text: form
                    ? 'Anyone who fills in the form on your site while it’s paused is turned away.'
                    : 'Leads the app sends while it’s paused are turned away.',
                },
              ],
        ),
        result: { waiting: true },
      };
    }

    if (act === 'retire') {
      // The screen never offers it for the row the forms built in HandsFreeOS land on: it has no key to stop.
      if (!source.publicKey && !source.secretHint)
        throw need(
          'sourceId',
          'That one is where the leads from the forms you build here land, so it can’t be retired. Pause it instead.',
        );
      return {
        card: card(
          toolCallId,
          tool,
          `Retire ${source.name}?`,
          [
            what,
            {
              label: 'Last lead',
              value: source.lastIntakeAt ? when(source.lastIntakeAt, ctx.timezone) : 'None yet',
            },
          ],
          'Retire it',
          [
            {
              kind: 'caution',
              text: `Its key stops working straight away and nothing more arrives through it. It can’t be turned back on; a new one needs a new key${form ? ' pasted into your site' : ''}.`,
            },
            { kind: 'note', text: 'The customers and leads it opened stay where they are.' },
          ],
        ),
        result: { waiting: true },
      };
    }

    // change
    const sites = list<string>(args['websites']);
    if (!form && (sites || args['thankYouPage'] !== undefined))
      throw need('websites', 'Sites and a thank-you page belong to a website form.');
    const fields: Field[] = [what];
    const name = str(args['name']);
    if (name && name !== source.name) fields.push({ label: 'Filed under', value: name });
    const createLead = bool(args['createLead']);
    if (createLead !== undefined && createLead !== source.createLead)
      fields.push({ label: 'Opens a lead', value: createLead ? 'Yes' : 'Customer only' });
    if (args['pipelineId'] !== undefined || args['stageId'] !== undefined) {
      const pipelineId =
        args['pipelineId'] === undefined
          ? source.pipelineId
          : (args['pipelineId'] as string | null);
      const pipeline = pipelineId ? intake.pipelines.find((p) => p.id === pipelineId) : null;
      if (pipelineId && !pipeline) throw need('pipelineId', 'Pick one of your pipelines.');
      const stageId = str(args['stageId']);
      const stage = stageId ? pipeline?.stages.find((s) => s.id === stageId) : null;
      if (stageId && !stage) throw need('stageId', 'Pick a stage in that pipeline.');
      if (pipelineId !== source.pipelineId || (stageId && stageId !== source.stageId))
        fields.push(
          { label: 'Lands in', value: pipeline?.name ?? 'Your first pipeline' },
          { label: 'Stage', value: stage?.name ?? 'Its first open stage' },
        );
    }
    const most = num(args['dailyCap']);
    if (most !== undefined && most !== source.dailyCap)
      fields.push({ label: 'Most a day', value: String(most) });
    const warnings: Warning[] = [];
    if (sites && sites.join('\n') !== source.allowedOrigins.join('\n')) {
      fields.push({ label: 'Sites', value: sites.join(', ') || 'None' });
      warnings.push({
        kind: 'note',
        text: 'Only these sites can send it; anywhere else is turned away.',
      });
    }
    if (args['thankYouPage'] !== undefined && args['thankYouPage'] !== source.redirectUrl)
      fields.push({
        label: 'Thank-you page',
        value: str(args['thankYouPage']) ?? 'None; the form says thank you itself',
      });
    if (fields.length === 1) throw nothing();
    return {
      card: card(toolCallId, tool, `Change ${source.name}`, fields, 'Save the change', warnings),
      result: { waiting: true, changes: fields.slice(1).map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const back = href(ctx, 'settings/lead-intake');
    const sourceId = args['sourceId'];
    if (act === 'retire') {
      await command(db, ctx, 'intake_source.archive', { sourceId });
      return { outcome: 'Retired', href: back, command: 'intake_source.archive' };
    }
    if (act === 'pause' || act === 'turn_on') {
      await command(db, ctx, 'intake_source.update', { sourceId, active: act === 'turn_on' });
      return {
        outcome: act === 'turn_on' ? 'It’s on' : 'Nothing more arrives through it',
        href: back,
        command: 'intake_source.update',
      };
    }
    await command(db, ctx, 'intake_source.update', {
      sourceId,
      ...defined({
        name: str(args['name']),
        createLead: bool(args['createLead']),
        pipelineId: args['pipelineId'] === null ? null : str(args['pipelineId']),
        stageId: args['stageId'] === null ? null : str(args['stageId']),
        dailyCap: num(args['dailyCap']),
        allowedOrigins: list<string>(args['websites']),
        redirectUrl:
          args['thankYouPage'] === undefined ? undefined : (str(args['thankYouPage']) ?? null),
      }),
    });
    return { outcome: 'Saved', href: back, command: 'intake_source.update' };
  },
};

// ---------- look-ups ----------

export const setupAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  /** What can be brought back, so a restore has an id to name. Each part the person may not see is left out. */
  async list_archived_setup(db, ctx) {
    const [kinds, types, templates] = await Promise.all([
      kindsOf(db, ctx, true).catch(() => null),
      relTypesOf(db, ctx, true).catch(() => null),
      templatesOf(db, ctx, true).catch(() => null),
    ]);
    const k = (kinds ?? []).filter((x) => x.archivedAt);
    const r = (types ?? []).filter((x) => x.archivedAt);
    const t = (templates ?? []).filter((x) => x.archivedAt);
    const rows = [
      ...k.map((x) => ({
        title: x.plural,
        detail: `Kind of record · ${plural(x.recordCount, 'record')}`,
        tone: 'muted' as const,
        href: href(ctx, 'settings/relationships'),
      })),
      ...r.map((x) => ({
        title: relationshipTypeName(x),
        detail: `Relationship · ${plural(x.pairCount, 'pair')}`,
        tone: 'muted' as const,
        href: href(ctx, 'settings/relationships'),
      })),
      ...t.map((x) => ({
        title: x.name,
        detail: `${CHANNEL_WORDS[x.channel]} template`,
        tone: 'muted' as const,
        href: href(ctx, 'settings/templates'),
      })),
    ];
    return {
      result: {
        kindsOfRecords: kinds
          ? k.map((x) => ({ id: x.id, name: x.plural, records: x.recordCount }))
          : 'not yours to see',
        relationshipTypes: types
          ? r.map((x) => ({ id: x.id, name: relationshipTypeName(x), pairs: x.pairCount }))
          : 'not yours to see',
        templates: templates
          ? t.map((x) => ({ id: x.id, name: x.name, channel: x.channel, folder: x.folder }))
          : 'not yours to see',
      },
      card: rows.length ? { type: 'list', title: 'Archived', items: rows.slice(0, 12) } : null,
    };
  },

  async list_unmatched_email(db, ctx) {
    const { items } = await query<{ items: Unmatched[]; nextCursor: string | null }>(
      db,
      ctx,
      'email.unmatched_list',
      { limit: 20 },
    );
    const back = href(ctx, 'settings/email');
    return {
      result: {
        count: items.length,
        // Everything here is a stranger's own words, so the model reads it as that and nothing more.
        emails: items.map((u) => ({
          id: u.id,
          from: u.fromAddress,
          name: quoted(u.fromName),
          subject: quoted(u.subject),
          preview: quoted(u.snippet),
          received: when(u.receivedAt, ctx.timezone),
          sentTo: u.toAddress,
        })),
      },
      card: items.length
        ? {
            type: 'list',
            title:
              items.length === 1
                ? '1 email from someone not in Customers'
                : `${items.length} emails from people not in Customers`,
            items: items.slice(0, 12).map((u) => ({
              title: fromLine(u),
              detail: clip(u.subject ?? u.snippet ?? '(no subject)', 100),
              tone: 'accent' as const,
              href: back,
            })),
          }
        : null,
    };
  },

  async list_blocked_email(db, ctx) {
    const { items } = await query<{ items: Suppression[]; nextCursor: string | null }>(
      db,
      ctx,
      'email_suppression.list',
      { limit: 50 },
    );
    return {
      result: {
        count: items.length,
        blocked: items.map((s) => ({
          id: s.id,
          address: s.address,
          why: REASON_WORDS[s.reason] ?? s.reason,
          since: when(s.createdAt, ctx.timezone),
        })),
      },
      card: items.length
        ? {
            type: 'list',
            title: items.length === 1 ? '1 blocked address' : `${items.length} blocked addresses`,
            items: items.slice(0, 12).map((s) => ({
              title: s.address,
              detail: REASON_WORDS[s.reason] ?? s.reason,
              tone: 'muted' as const,
              href: href(ctx, 'settings/email'),
            })),
          }
        : null,
    };
  },
};

export const setupConfirmTools: Record<string, SettingsConfirmTool> = {
  manage_permissions: managePermissions,
  manage_custom_field: manageCustomField,
  manage_record_kind: manageRecordKind,
  manage_relationship_type: manageRelationshipType,
  manage_template: manageTemplate,
  manage_numbers: manageNumbers,
  set_inbox_visibility: setInboxVisibility,
  manage_web_address: manageWebAddress,
  sort_unmatched_email: sortUnmatchedEmail,
  block_email_address: blockEmailAddress,
  manage_rcs: manageRcs,
  manage_lead_form: manageLeadForm,
};

/** What the panel says while each one runs. */
export const setupStepLabels: Record<string, string> = {
  manage_permissions: 'Changing who can do what',
  manage_custom_field: 'Setting up the field',
  manage_record_kind: 'Setting up the kind of record',
  manage_relationship_type: 'Setting up the relationship',
  list_archived_setup: 'Looking at what was archived',
  manage_template: 'Setting up the template',
  manage_numbers: 'Changing your number',
  set_inbox_visibility: 'Changing who sees which conversations',
  manage_web_address: 'Setting up your web address',
  list_unmatched_email: 'Looking at mail from people not in Customers',
  sort_unmatched_email: 'Sorting the email',
  list_blocked_email: 'Looking at blocked addresses',
  block_email_address: 'Blocking the address',
  manage_rcs: 'Changing RCS',
  manage_lead_form: 'Changing the lead form',
};
