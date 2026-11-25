/**
 * Customers in bulk, by asking (0107): many at once with their tags; tags on or off many in one go; any detail of
 * one customer changed, added or taken off; the AI's pass over the whole list, started or stopped; and a whole list
 * of contacts sent with a question (a CSV, an Excel sheet or a .vcf) added through the import. Each change runs as
 * the person, through the same commands as the screens, only after Confirm, marked as done through the Assistant,
 * with the reason they gave on every audit row.
 */
import {
  addressKey,
  addressLine,
  ASSISTANT_DOCX_TYPE,
  ASSISTANT_VCARD_TYPE,
  ASSISTANT_XLSX_TYPE,
  COMPANY_FIELDS,
  contactLabelWords,
  formatPhone,
  guessMapping,
  HfosError,
  IMPORT_FIELD_LABELS,
  IMPORT_MAX_ROWS,
  mapCompanyRow,
  mapPersonRow,
  normalizePhone,
  otherAddressesStored,
  parseVcards,
  PERSON_FIELDS,
  REPEATABLE_FIELDS,
  SKIP,
  vcardTable,
  type OtherAddressOut,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import Papa from 'papaparse';
import { workbookRows } from '../files/office-text';
import { STAGING_BUCKET, stagedPath } from '../housekeeping/assistant-staging';
import { plainText } from './attachments';
import type { ToolContext, ToolOutcome } from './runtime';
import { command, paths, query, rehearse, when } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()))].filter(
        Boolean,
      )
    : [];
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const listWords = (xs: readonly string[], max = 3): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Tag {
  id: string;
  name: string;
}
const tagsOf = (db: Db, ctx: ToolContext) =>
  query<{ tags: Tag[] }>(db, ctx, 'tag.list').then((r) => r.tags);

/** The tags named by id (each must be the business's), and the new names that aren't a tag yet. */
async function resolveTags(db: Db, ctx: ToolContext, tagIds: string[], newNames: string[]) {
  const all = await tagsOf(db, ctx);
  const byId = new Map(all.map((t) => [t.id, t]));
  const missing = tagIds.filter((id) => !byId.has(id));
  if (missing.length)
    throw HfosError.notFound(
      'One of those tag ids isn’t a tag this business has. Read the tags again with get_settings and use the ids it gives.',
    );
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]));
  const existing = newNames.map((n) => byName.get(n.toLowerCase())).filter((t): t is Tag => !!t);
  const fresh = newNames.filter((n) => !byName.has(n.toLowerCase()));
  return { tags: tagIds.map((id) => byId.get(id)!), existing, fresh };
}

/** Makes the new tags, and hands back every id. */
async function makeTags(db: Db, ctx: ToolContext, names: string[], reason: string | undefined) {
  const made: string[] = [];
  for (const name of names) {
    const { tagId } = await command<{ tagId: string }>(db, ctx, 'tag.create', { name }, reason);
    made.push(tagId);
  }
  return made;
}

// ---------- other numbers, emails and addresses ----------

type Stored = { label?: string };
type StoredPhone = Stored & { phone: string };
type StoredEmail = Stored & { email: string };
type StoredAddress = ReturnType<typeof otherAddressesStored>[number];
const labelled = (label: unknown): Stored => (str(label) ? { label: str(label)! } : {});
const listArg = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A list after taking some off and adding some: one added that is already there takes its new label. */
function edited<T>(now: T[], add: T[], drop: (t: T) => boolean, key: (t: T) => string): T[] {
  const out = now.filter((t) => !drop(t));
  for (const a of add) {
    const i = out.findIndex((t) => key(t) === key(a));
    if (i >= 0) out[i] = a;
    else out.push(a);
  }
  return out;
}

/** Each one named to take off must be on the list, so nothing is said to be gone that wasn't there. */
function mustBeThere(asked: string[], found: (s: string) => boolean, what: string, read: string) {
  const stray = asked.filter((x) => !found(x));
  if (stray.length)
    throw HfosError.validation(
      [],
      `“${stray[0]}” isn’t one of their other ${what}, so it can’t be taken off. ${read} lists the ones they have.`,
    );
}

const phoneWords = (p: StoredPhone) =>
  `${formatPhone(p.phone) || p.phone}${p.label ? ` (${p.label})` : ''}`;
const emailWords = (e: StoredEmail) => `${e.email}${e.label ? ` (${e.label})` : ''}`;
const placeWords = (a: StoredAddress) =>
  `${addressLine({
    line1: a.line1 ?? null,
    line2: a.line2 ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    postalCode: a.postalCode ?? null,
  })} (${contactLabelWords(a.label, 'address')})`;

/** One list's change: what the command takes as the whole list, and the card's words before and after. */
export interface OtherListChange {
  readonly key: 'otherPhones' | 'otherEmails' | 'otherAddresses';
  readonly label: string;
  readonly next: object[];
  readonly before: string[];
  readonly after: string[];
}

/**
 * The other numbers, emails or addresses of a person or company after the add… and remove… arguments, as the edit
 * dialog's rows would save them: a number in E.164, an email lowercased, an address by its parts. `which` says the
 * lists to look at. A list that wouldn't change is left out.
 */
export function otherContactsEdit(
  now: {
    otherPhones?: { phoneE164: string; label: string | null }[];
    otherEmails?: { email: string; label: string | null }[];
    otherAddresses?: OtherAddressOut[];
  },
  args: Args,
  which: readonly ('phones' | 'emails' | 'addresses')[],
  read: string,
): OtherListChange[] {
  const out: OtherListChange[] = [];
  if (which.includes('phones')) {
    const was: StoredPhone[] = (now.otherPhones ?? []).map((p) => ({
      phone: p.phoneE164,
      ...labelled(p.label),
    }));
    const add = listArg<{ phone: string; label?: string }>(args['addOtherPhones']).map((p) => {
      const e164 = normalizePhone(p.phone);
      if (!e164)
        throw HfosError.validation(
          [],
          `“${p.phone}” isn’t a phone number. Give all 10 digits with the area code, or a + and the country code for a number outside the US.`,
        );
      return { phone: e164, ...labelled(p.label) };
    });
    const drop = listArg<string>(args['removeOtherPhones']).map((p) => normalizePhone(p) ?? p);
    mustBeThere(drop, (d) => was.some((p) => p.phone === d), 'numbers', read);
    const next = edited(
      was,
      add,
      (p) => drop.includes(p.phone),
      (p) => p.phone,
    );
    if (!same(next, was))
      out.push({
        key: 'otherPhones',
        label: 'Other numbers',
        next,
        before: was.map(phoneWords),
        after: next.map(phoneWords),
      });
  }
  if (which.includes('emails')) {
    const was: StoredEmail[] = (now.otherEmails ?? []).map((e) => ({
      email: e.email.toLowerCase(),
      ...labelled(e.label),
    }));
    const add = listArg<{ email: string; label?: string }>(args['addOtherEmails']).map((e) => ({
      email: e.email.trim().toLowerCase(),
      ...labelled(e.label),
    }));
    const drop = listArg<string>(args['removeOtherEmails']).map((e) => e.trim().toLowerCase());
    mustBeThere(drop, (d) => was.some((e) => e.email === d), 'emails', read);
    const next = edited(
      was,
      add,
      (e) => drop.includes(e.email),
      (e) => e.email,
    );
    if (!same(next, was))
      out.push({
        key: 'otherEmails',
        label: 'Other emails',
        next,
        before: was.map(emailWords),
        after: next.map(emailWords),
      });
  }
  if (which.includes('addresses')) {
    const was = otherAddressesStored(now.otherAddresses ?? []);
    const add = listArg<Args>(args['addOtherAddresses']).map((a) => {
      const [one] = otherAddressesStored([
        {
          label: str(a['label']) ?? null,
          line1: str(a['line1']) ?? null,
          line2: str(a['line2']) ?? null,
          city: str(a['city']) ?? null,
          state: str(a['state']) ?? null,
          postalCode: str(a['postalCode']) ?? null,
          country: 'US',
        },
      ]);
      if (!one)
        throw HfosError.validation(
          [],
          'Each address added needs a street, a town or a ZIP code. Give at least one of them.',
        );
      return one;
    });
    const drop = listArg<string>(args['removeOtherAddresses']).map((x) => x.trim().toLowerCase());
    const matches = (a: StoredAddress, d: string) =>
      a.line1?.toLowerCase() === d ||
      placeWords(a).toLowerCase().startsWith(d) ||
      addressLine({
        line1: a.line1 ?? null,
        line2: a.line2 ?? null,
        city: a.city ?? null,
        state: a.state ?? null,
        postalCode: a.postalCode ?? null,
      }).toLowerCase() === d;
    mustBeThere(drop, (d) => was.some((a) => matches(a, d)), 'addresses', read);
    const next = edited(was, add, (a) => drop.some((d) => matches(a, d)), addressKey);
    if (!same(next, was))
      out.push({
        key: 'otherAddresses',
        label: 'Other addresses',
        next,
        before: was.map(placeWords),
        after: next.map(placeWords),
      });
  }
  return out;
}

// ---------- looking things up ----------

interface PersonListItem {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  tags: Tag[];
  client: boolean;
  openLeads: number;
  lastActivityAt: string | null;
  company: { id: string; name: string } | null;
  address: { city: string | null } | null;
  archivedAt: string | null;
}
interface CompanyListItem {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  tags: Tag[];
  peopleCount: number;
  openLeads: number;
  client: boolean;
  archivedAt: string | null;
}

export const contactReadTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  async list_customers(db, ctx, args) {
    const { items, nextCursor } = await query<{
      items: PersonListItem[];
      nextCursor: string | null;
    }>(
      db,
      ctx,
      'person.list',
      defined({
        q: str(args['query']),
        tagId: str(args['tagId']),
        withoutTagId: str(args['withoutTagId']),
        standing: str(args['standing']),
        assignedUserId: str(args['assignedUserId']),
        companyId: str(args['companyId']),
        includeArchived: args['includeArchived'] === true,
        sort: str(args['sort']),
        limit: typeof args['limit'] === 'number' ? args['limit'] : 50,
        cursor: str(args['cursor']),
      }),
    );
    const p = paths(ctx.workspaceId);
    return {
      result: {
        customers: items.map((c) => ({
          id: c.id,
          name: c.fullName,
          phone: c.phone,
          email: c.email,
          tags: c.tags.map((t) => t.name),
          // The Client badge: someone the business works or worked for, or who has paid it; otherwise a lead.
          client: c.client,
          openLeads: c.openLeads,
          lastActivity: c.lastActivityAt ? when(c.lastActivityAt, ctx.timezone) : null,
          company: c.company ? { id: c.company.id, name: c.company.name } : null,
          town: c.address?.city ?? null,
          ...(c.archivedAt ? { archived: true } : {}),
        })),
        count: items.length,
        nextCursor,
      },
      ...(items.length > 1
        ? {
            card: {
              type: 'choices' as const,
              title: `${items.length}${nextCursor ? '+' : ''} customers`,
              items: items.slice(0, 8).map((c) => ({
                id: c.id,
                label: c.fullName,
                detail: c.tags.length ? c.tags.map((t) => t.name).join(', ') : 'No tags',
                href: p.person(c.id),
              })),
            },
          }
        : {}),
    };
  },

  async list_companies(db, ctx, args) {
    const { items, nextCursor } = await query<{
      items: CompanyListItem[];
      nextCursor: string | null;
    }>(
      db,
      ctx,
      'company.list',
      defined({
        q: str(args['query']),
        tagId: str(args['tagId']),
        standing: str(args['standing']),
        assignedUserId: str(args['assignedUserId']),
        includeArchived: args['includeArchived'] === true,
        limit: typeof args['limit'] === 'number' ? args['limit'] : 50,
        cursor: str(args['cursor']),
      }),
    );
    const p = paths(ctx.workspaceId);
    return {
      result: {
        companies: items.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: c.email,
          website: c.website,
          tags: c.tags.map((t) => t.name),
          people: c.peopleCount,
          openLeads: c.openLeads,
          client: c.client,
          ...(c.archivedAt ? { archived: true } : {}),
        })),
        count: items.length,
        nextCursor,
      },
      ...(items.length
        ? {
            card: {
              type: 'list' as const,
              title: `${count(items.length, 'company', 'companies')}${nextCursor ? '+' : ''}`,
              items: items.slice(0, 12).map((c) => ({
                title: c.name,
                detail: [
                  c.phone ?? c.email,
                  `${count(c.peopleCount, 'person', 'people')}`,
                  c.openLeads ? `${count(c.openLeads, 'open lead')}` : null,
                  c.client ? 'Client' : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
                tone: 'muted' as const,
                href: p.company(c.id),
              })),
            },
          }
        : {}),
    };
  },

  async ai_tagging_status(db, ctx, args) {
    const [status, reviews] = await Promise.all([
      query<{
        running: SweepOut | null;
        recent: SweepOut[];
        switches: { tags: boolean; details: boolean };
        lastWeek: { reviewed: number; changed: number };
      }>(db, ctx, 'contact_ai.status'),
      // As many as Settings → Tags lists under its latest changes.
      query<{ items: ReviewOut[]; nextBefore: string | null }>(
        db,
        ctx,
        'contact_ai.reviews',
        defined({
          personId: str(args['personId']),
          changedOnly: args['changedOnly'] !== false,
          limit: 15,
        }),
      ),
    ]);
    return {
      result: {
        running: status.running ? sweepWords(status.running) : null,
        recentPasses: status.recent.filter((s) => s.status !== 'running').map(sweepWords),
        onItsOwn: {
          tagsCustomers: status.switches.tags,
          keepsDetailsUpToDate: status.switches.details,
        },
        lastSevenDays: status.lastWeek,
        latestLooks: reviews.items.map((r) => ({
          customer: r.person.fullName,
          personId: r.person.id,
          when: r.createdAt,
          why: r.trigger === 'sweep' ? 'a pass over the list' : 'something happened with them',
          outcome: r.outcome,
          tagsOn: r.addedTags,
          tagsOff: r.removedTags,
          details: r.details,
          leftAlone: r.skipped,
        })),
        ...(reviews.nextBefore
          ? {
              more: true,
              olderChanges:
                'These are the latest. Every older tag change is in the audit log with its reason: read_audit_list finds them.',
            }
          : {}),
      },
    };
  },
};

interface SweepOut {
  id: string;
  status: string;
  instructions: string;
  tags: Tag[];
  onlyTag: Tag | null;
  fixDetails: boolean;
  total: number;
  reviewed: number;
  changed: number;
  tagsAdded: number;
  tagsRemoved: number;
  detailsChanged: number;
  note: string | null;
  requestedBy: { fullName: string } | null;
  createdAt: string;
  finishedAt: string | null;
}
interface ReviewOut {
  person: { id: string; fullName: string };
  trigger: 'activity' | 'sweep';
  outcome: string;
  addedTags: { name: string; reason: string }[];
  removedTags: { name: string; reason: string }[];
  details: { field: string; from: string | null; to: string | null; reason: string }[];
  skipped: { what: string; why: string }[];
  createdAt: string;
}

const sweepWords = (s: SweepOut) => ({
  id: s.id,
  status: s.status,
  progress: `${s.reviewed} of ${s.total}`,
  changed: s.changed,
  tagsOn: s.tagsAdded,
  tagsOff: s.tagsRemoved,
  detailsChanged: s.detailsChanged,
  tags: s.tags.length ? s.tags.map((t) => t.name) : 'every tag',
  onlyCustomersWith: s.onlyTag?.name ?? null,
  instructions: s.instructions || null,
  note: s.note,
  startedBy: s.requestedBy?.fullName ?? null,
  startedAt: s.createdAt,
  finishedAt: s.finishedAt,
});

// ---------- tags on many customers ----------

const tagCustomers: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const people = ids(args['personIds']);
    const companies = ids(args['companyIds']);
    const leads = ids(args['leadIds']);
    const records = people.length + companies.length + leads.length;
    if (!records)
      throw HfosError.validation(
        [],
        'Say which customers: give personIds, companyIds or leadIds. list_customers gathers them.',
      );
    const add = ids(args['addTagIds']);
    const remove = ids(args['removeTagIds']);
    const newNames = names(args['newTagNames']);
    if (!add.length && !remove.length && !newNames.length)
      throw HfosError.validation(
        [],
        'Say which tags to put on or take off: give addTagIds, removeTagIds or newTagNames.',
      );
    const both = add.filter((id) => remove.includes(id));
    if (both.length)
      throw HfosError.validation(
        [],
        `${both.length === 1 ? 'A tag is' : `${both.length} tags are`} in both addTagIds and removeTagIds. Keep each tag in only one of them.`,
      );
    const [on, off] = await Promise.all([
      resolveTags(db, ctx, add, newNames),
      resolveTags(db, ctx, remove, []),
    ]);
    const first = await Promise.all(
      people.slice(0, 3).map((personId) =>
        query<{ person: { fullName: string } }>(db, ctx, 'person.get', { personId })
          .then((r) => r.person.fullName)
          .catch(() => 'someone'),
      ),
    );
    const who = [
      ...first,
      ...(people.length > 3 ? [`${people.length - 3} more people`] : []),
      ...(companies.length
        ? [`${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`]
        : []),
      ...(leads.length ? [`${leads.length} lead${leads.length === 1 ? '' : 's'}`] : []),
    ].join(', ');
    const putOn = [...on.tags, ...on.existing].map((t) => t.name);
    const workflows = await tagWorkflows(db, ctx);
    return {
      card: settingsCard(toolCallId, 'tag_customers', {
        title:
          records === 1
            ? 'Change this customer’s tags?'
            : `Change the tags on ${records} customers?`,
        fields: [
          { label: 'Customers', value: who },
          { label: 'Put on', value: putOn.join(', ') },
          { label: 'New tags', value: on.fresh.join(', ') },
          { label: 'Take off', value: off.tags.map((t) => t.name).join(', ') },
          { label: 'Why', value: clip(str(args['reason']) ?? '', 200) },
        ],
        confirmLabel: 'Change tags',
        warnings: [
          ...(on.fresh.length
            ? [
                {
                  kind: 'note',
                  text: `Adds ${on.fresh.length === 1 ? 'a new tag' : 'new tags'}: ${on.fresh.join(', ')}.`,
                },
              ]
            : []),
          ...(workflows.length
            ? [
                {
                  kind: 'note',
                  text: `${listWords(workflows.map((w) => w.name))} start${workflows.length === 1 ? 's' : ''} when tags change, for each customer.`,
                },
              ]
            : []),
        ],
      }),
      result: {
        waiting: true,
        customers: records,
        putOn,
        newTags: on.fresh,
        takeOff: off.tags.map((t) => t.name),
      },
    };
  },

  async commit(db, ctx, args) {
    const reason = str(args['reason']);
    const newNames = names(args['newTagNames']);
    const { existing, fresh } = await resolveTags(db, ctx, [], newNames);
    const add = [
      ...new Set([
        ...ids(args['addTagIds']),
        ...existing.map((t) => t.id),
        ...(await makeTags(db, ctx, fresh, reason)),
      ]),
    ];
    const remove = ids(args['removeTagIds']);
    const records = [
      ...ids(args['personIds']).map((id) => ['person', id] as const),
      ...ids(args['companyIds']).map((id) => ['company', id] as const),
      ...ids(args['leadIds']).map((id) => ['lead', id] as const),
    ];
    let done = 0;
    let failed = 0;
    for (const [recordType, recordId] of records) {
      try {
        for (const [mode, tagIds] of [
          ['add', add],
          ['remove', remove],
        ] as const)
          if (tagIds.length)
            await command(
              db,
              ctx,
              'record.set_tags',
              { recordType, recordId, tagIds, mode },
              reason,
            );
        done += 1;
      } catch {
        failed += 1;
      }
    }
    const people = ids(args['personIds']);
    return {
      outcome: `Tags changed on ${done} of ${records.length}${failed ? ` (${failed} couldn’t be changed)` : ''}`,
      href:
        people.length === 1 && records.length === 1
          ? paths(ctx.workspaceId).person(people[0]!)
          : `/app/w/${ctx.workspaceId}/customers`,
      command: 'record.set_tags',
    };
  },
};

async function tagWorkflows(db: Db, ctx: ToolContext) {
  return query<{ tagWorkflows: { id: string; name: string }[] }>(db, ctx, 'contact_ai.preview')
    .then((r) => r.tagWorkflows)
    .catch(() => []);
}

// ---------- the AI's pass over the whole list ----------

const aiTagCustomers: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    if (args['action'] === 'stop') {
      const { running } = await query<{ running: SweepOut | null }>(db, ctx, 'contact_ai.status');
      if (!running)
        throw HfosError.conflict(
          'The AI isn’t going through your customers right now, so there’s nothing to stop.',
          'contact_ai_stopped',
        );
      return {
        card: settingsCard(toolCallId, 'ai_tag_customers', {
          title: 'Stop the AI going through your customers?',
          fields: [
            { label: 'So far', value: `${running.reviewed} of ${running.total} looked at` },
            { label: 'Changed', value: `${running.changed} customers` },
          ],
          confirmLabel: 'Stop it',
          warnings: [
            { kind: 'note', text: 'What it already changed stays, each change in the audit log.' },
          ],
        }),
        result: { waiting: true, progress: `${running.reviewed} of ${running.total}` },
      };
    }
    // One pass at a time, as the screen shows Stop instead of the form while one goes.
    const { running } = await query<{ running: SweepOut | null }>(db, ctx, 'contact_ai.status');
    if (running)
      throw HfosError.conflict(
        `The AI is already going through your customers (${running.reviewed} of ${running.total} looked at). Wait for it to finish, or stop it to start another.`,
        'contact_ai_running',
      );
    const onlyTagId = str(args['onlyTagId']) ?? null;
    const tagIds = ids(args['tagIds']);
    const newNames = names(args['newTagNames']);
    const [preview, resolved] = await Promise.all([
      query<{ customers: number; tags: Tag[]; tagWorkflows: { name: string }[] }>(
        db,
        ctx,
        'contact_ai.preview',
        { onlyTagId },
      ),
      resolveTags(db, ctx, [...tagIds, ...(onlyTagId ? [onlyTagId] : [])], newNames),
    ]);
    if (!preview.tags.length && !resolved.fresh.length)
      throw HfosError.conflict(
        'This business has no tags yet, so the AI has none to put on. Ask which tags they want and pass them in newTagNames.',
        'no_tags',
      );
    const only = onlyTagId ? preview.tags.find((t) => t.id === onlyTagId) : null;
    const allowed = [
      ...tagIds.map((id) => preview.tags.find((t) => t.id === id)?.name ?? ''),
      ...resolved.existing.map((t) => t.name),
      ...resolved.fresh,
    ].filter(Boolean);
    const instructions = str(args['instructions']);
    const fixDetails = args['fixDetails'] === true;
    return {
      card: settingsCard(toolCallId, 'ai_tag_customers', {
        title: `Let the AI go through ${preview.customers} customer${preview.customers === 1 ? '' : 's'}?`,
        fields: [
          {
            label: 'Customers',
            value: only
              ? `${preview.customers} with the tag ${only.name}`
              : `Everyone (${preview.customers})`,
          },
          {
            label: 'Tags it may use',
            value: allowed.length
              ? listWords(allowed, 5)
              : `All ${preview.tags.length} of your tags`,
          },
          { label: 'New tags', value: resolved.fresh.join(', ') },
          { label: 'Looks for', value: clip(instructions ?? '', 200) },
          {
            label: 'Details',
            value: fixDetails
              ? 'Also fills in and fixes names, emails, numbers and addresses customers gave'
              : 'Tags only',
          },
        ],
        confirmLabel: 'Start',
        warnings: [
          {
            kind: 'note',
            text: 'It reads each customer with the AI, in the background. Every change is in the audit log with its reason, and you can stop it any time.',
          },
          ...(preview.tagWorkflows.length
            ? [
                {
                  kind: 'note',
                  text: `${listWords(preview.tagWorkflows.map((w) => w.name))} start${preview.tagWorkflows.length === 1 ? 's' : ''} when tags change, for each customer it tags.`,
                },
              ]
            : []),
        ],
      }),
      result: {
        waiting: true,
        customers: preview.customers,
        tags: allowed.length ? allowed : 'every tag',
        fixDetails,
      },
    };
  },

  async commit(db, ctx, args) {
    const href = `/app/w/${ctx.workspaceId}/settings/tags`;
    if (args['action'] === 'stop') {
      const { running } = await query<{ running: SweepOut | null }>(db, ctx, 'contact_ai.status');
      if (!running)
        throw HfosError.conflict(
          'The AI already stopped going through your customers, so there’s nothing to stop.',
          'contact_ai_stopped',
        );
      const out = await command<{ reviewed: number }>(db, ctx, 'contact_ai.cancel_sweep', {
        sweepId: running.id,
      });
      return {
        outcome: `Stopped after ${out.reviewed} of ${running.total}`,
        href,
        command: 'contact_ai.cancel_sweep',
      };
    }
    const instructions = str(args['instructions']);
    const newNames = names(args['newTagNames']);
    const { existing, fresh } = await resolveTags(db, ctx, [], newNames);
    const made = await makeTags(db, ctx, fresh, instructions);
    const tagIds = ids(args['tagIds']);
    // Naming only new tags keeps it to them; naming none lets it use every tag.
    const allowed =
      tagIds.length || newNames.length
        ? [...new Set([...tagIds, ...existing.map((t) => t.id), ...made])]
        : [];
    const { total } = await command<{ sweepId: string; total: number }>(
      db,
      ctx,
      'contact_ai.start_sweep',
      defined({
        instructions: instructions ?? '',
        tagIds: allowed,
        onlyTagId: str(args['onlyTagId']) ?? null,
        fixDetails: args['fixDetails'] === true,
      }),
      instructions,
    );
    return {
      outcome: `Going through ${total} customer${total === 1 ? '' : 's'}`,
      href,
      command: 'contact_ai.start_sweep',
    };
  },
};

// ---------- any detail of one customer ----------

interface PersonFull {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null;
  otherEmails: { email: string; label: string | null }[];
  otherPhones: { phone: string; phoneE164: string; label: string | null }[];
  otherAddresses: OtherAddressOut[];
  notes: string | null;
  source: string | null;
  company: { id: string; name: string } | null;
  custom: Record<string, unknown>;
}

const ADDRESS_WORDS = {
  line1: 'Street',
  line2: 'Address line 2',
  city: 'City',
  state: 'State',
  postalCode: 'ZIP',
} as const;

const shown = (v: unknown): string =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
    ? 'none'
    : Array.isArray(v)
      ? v.join(', ')
      : typeof v === 'string'
        ? clip(v, 80)
        : String(v);

/** What update_customer would change: person.update's input, the fields' values, and a line for each. */
async function customerChange(db: Db, ctx: ToolContext, args: Args) {
  const personId = String(args['personId']);
  const { person } = await query<{ person: PersonFull }>(db, ctx, 'person.get', { personId });
  const patch: Args = {};
  const lines: Field[] = [];
  const line = (label: string, before: unknown, after: unknown) =>
    lines.push({ label, value: `${shown(before)} → ${shown(after)}` });

  const first = args['firstName'] === undefined ? undefined : (str(args['firstName']) ?? '');
  const last = args['lastName'] === undefined ? undefined : (str(args['lastName']) ?? '');
  if (first !== undefined && first !== person.firstName) patch['firstName'] = first;
  if (last !== undefined && last !== person.lastName) patch['lastName'] = last;
  if ('firstName' in patch || 'lastName' in patch) {
    const next = [first ?? person.firstName, last ?? person.lastName].filter(Boolean).join(' ');
    if (!next)
      throw HfosError.validation(
        [],
        'That would leave them with no name. Keep a first or a last name.',
      );
    line('Name', person.fullName, next);
  }
  if (args['phone'] !== undefined) {
    const next = args['phone'] === null ? null : normalizePhone(String(args['phone']));
    if (args['phone'] !== null && !next)
      throw HfosError.validation(
        [],
        `“${String(args['phone'])}” isn’t a phone number. Give all 10 digits with the area code, or a + and the country code for a number outside the US.`,
      );
    if (next !== person.phoneE164) {
      patch['phone'] = next;
      line('Phone', person.phone, args['phone']);
    }
  }
  if (args['email'] !== undefined) {
    const next = args['email'] === null ? null : String(args['email']).trim().toLowerCase();
    if (next !== person.email) {
      patch['email'] = next;
      line('Email', person.email, next);
    }
  }
  const address = (args['address'] ?? {}) as Record<string, unknown>;
  const addressPatch: Args = {};
  for (const k of Object.keys(ADDRESS_WORDS) as (keyof typeof ADDRESS_WORDS)[]) {
    if (address[k] === undefined) continue;
    const next = address[k] === null ? null : (str(address[k]) ?? null);
    const now = person.address?.[k] ?? null;
    if ((next ?? '') === (now ?? '')) continue;
    addressPatch[k] = next;
    line(ADDRESS_WORDS[k], now, next);
  }
  if (Object.keys(addressPatch).length) patch['address'] = addressPatch;

  const addPhones = Array.isArray(args['addOtherPhones'])
    ? (args['addOtherPhones'] as { phone: string; label?: string }[])
    : [];
  const dropPhones = new Set(
    (Array.isArray(args['removeOtherPhones']) ? (args['removeOtherPhones'] as string[]) : []).map(
      (p) => normalizePhone(p) ?? p,
    ),
  );
  if (addPhones.length || dropPhones.size) {
    const kept = person.otherPhones.filter((p) => !dropPhones.has(p.phoneE164));
    const added = addPhones.map((p) => {
      const e164 = normalizePhone(p.phone);
      if (!e164)
        throw HfosError.validation(
          [],
          `“${p.phone}” isn’t a phone number. Give all 10 digits with the area code, or a + and the country code for a number outside the US.`,
        );
      return { phone: e164, ...(str(p.label) ? { label: str(p.label) } : {}) };
    });
    const next = [
      ...kept.map((p) => ({ phone: p.phoneE164, ...(p.label ? { label: p.label } : {}) })),
      ...added.filter((a) => !kept.some((k) => k.phoneE164 === a.phone)),
    ];
    if (next.length !== person.otherPhones.length || added.length) {
      patch['otherPhones'] = next;
      line(
        'Other numbers',
        person.otherPhones.map((p) => p.phone),
        next.map((p) => p.phone),
      );
    }
  }
  const addEmails = Array.isArray(args['addOtherEmails'])
    ? (args['addOtherEmails'] as { email: string; label?: string }[])
    : [];
  const dropEmails = new Set(
    (Array.isArray(args['removeOtherEmails']) ? (args['removeOtherEmails'] as string[]) : []).map(
      (e) => e.trim().toLowerCase(),
    ),
  );
  if (addEmails.length || dropEmails.size) {
    const kept = person.otherEmails.filter((e) => !dropEmails.has(e.email));
    const next = [
      ...kept.map((e) => ({ email: e.email, ...(e.label ? { label: e.label } : {}) })),
      ...addEmails
        .map((e) => ({
          email: e.email.trim().toLowerCase(),
          ...(str(e.label) ? { label: str(e.label) } : {}),
        }))
        .filter((a) => !kept.some((k) => k.email === a.email)),
    ];
    if (next.length !== person.otherEmails.length || addEmails.length) {
      patch['otherEmails'] = next;
      line(
        'Other emails',
        person.otherEmails.map((e) => e.email),
        next.map((e) => e.email),
      );
    }
  }
  for (const c of otherContactsEdit(person, args, ['addresses'], 'get_customer')) {
    patch[c.key] = c.next;
    line(c.label, c.before, c.after);
  }
  for (const [k, label] of [
    ['notes', 'Notes'],
    ['source', 'Came from'],
  ] as const) {
    if (args[k] === undefined) continue;
    const next = args[k] === null ? null : (str(args[k]) ?? null);
    if ((next ?? '') === (person[k] ?? '')) continue;
    patch[k] = next;
    line(label, person[k], next);
  }
  if (args['companyId'] !== undefined && args['companyId'] !== (person.company?.id ?? null)) {
    const next =
      args['companyId'] === null
        ? null
        : (
            await query<{ company: { name: string } }>(db, ctx, 'company.get', {
              companyId: args['companyId'],
            })
          ).company.name;
    patch['companyId'] = args['companyId'];
    line('Company', person.company?.name ?? null, next);
  }

  const wanted = (args['fields'] ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  if (Object.keys(wanted).length) {
    const { fields } = await query<{ fields: { id: string; label: string }[] }>(
      db,
      ctx,
      'custom_field.list',
      { entity: 'person' },
    );
    for (const [id, value] of Object.entries(wanted)) {
      const field = fields.find((f) => f.id === id);
      if (!field)
        throw HfosError.validation(
          [],
          'One of those isn’t one of this business’s customer fields. It may have been deleted. Read the customer again with get_customer, which lists every field with its id, and use those.',
        );
      if (JSON.stringify(person.custom[id] ?? null) === JSON.stringify(value ?? null)) continue;
      values[id] = value;
      line(field.label, person.custom[id], value);
    }
  }
  return { person, personId, patch, values, lines };
}

const updateCustomer: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { person, patch, lines } = await customerChange(db, ctx, args);
    if (!lines.length)
      throw HfosError.validation(
        [],
        'Nothing would change. Everything given already matches their details, so pass only what’s different.',
      );
    const first = person.fullName.split(' ')[0] || person.fullName;
    const reason = str(args['reason']);
    const shownLines =
      lines.length > 9
        ? [...lines.slice(0, 8), { label: 'And', value: `${lines.length - 8} more changes` }]
        : lines;
    return {
      card: {
        ...settingsCard(toolCallId, 'update_customer', {
          title: `Change ${first}’s details?`,
          fields: [...shownLines, ...(reason ? [{ label: 'Why', value: clip(reason, 200) }] : [])],
          confirmLabel: 'Save changes',
          warnings: [
            ...('phone' in patch
              ? [{ kind: 'note', text: 'Texts and calls go to the new number from now on.' }]
              : []),
            ...('email' in patch
              ? [{ kind: 'note', text: 'Emails go to the new address from now on.' }]
              : []),
          ],
        }),
        personId: String(args['personId']),
      },
      result: { person: person.fullName, changes: lines.map((l) => l.label) },
    };
  },
  async commit(db, ctx, args) {
    const { personId, patch, values, lines } = await customerChange(db, ctx, args);
    if (!lines.length)
      throw HfosError.conflict(
        'Nothing needs changing anymore: their details already match. Someone may have made the same change first.',
        'nothing_to_change',
      );
    const reason = str(args['reason']);
    if (Object.keys(patch).length)
      await command(db, ctx, 'person.update', { personId, ...patch }, reason);
    if (Object.keys(values).length)
      await command(
        db,
        ctx,
        'record.set_fields',
        { recordType: 'person', recordId: personId, values },
        reason,
      );
    return {
      outcome: 'Saved the changes',
      href: paths(ctx.workspaceId).person(personId),
      command: 'person.update',
    };
  },
};

// ---------- a whole list of contacts, sent with the question ----------

type ImportKind = 'people' | 'companies';

/** A list of contacts as the import reads it: a CSV's headings and rows, and where it came from. */
interface ContactList {
  readonly file: string;
  readonly from: 'csv' | 'excel' | 'vcard';
  /** The Excel tab it came from, when it has a name. */
  readonly sheet: string | null;
  readonly csv: string;
  readonly headers: string[];
  readonly rows: Record<string, string>[];
}

const notAList = (name: string, what: string) =>
  HfosError.rule(
    'contacts_not_a_list',
    400,
    `${name} is ${what}, and contacts are added from a list: a .csv, an Excel file or a contacts .vcf. Save the list as one of those and send it, or add each person on a card of their own.`,
  );

/** A CSV's headings and rows, read as the import reads them (handlers/import-run.ts), so a mapping fits both. */
function csvTable(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return { headers: (parsed.meta.fields ?? []).filter(Boolean), rows: parsed.data };
}

/** An Excel sheet's first row as headings (each once, a blank one "Column N"), and the rest as rows. */
function excelTable(grid: string[][]): { headers: string[]; rows: string[][] } {
  const [top = [], ...rest] = grid;
  const width = rest.reduce((n, r) => Math.max(n, r.length), top.length);
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const base = top[i]?.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
  return { headers, rows: rest.map((r) => headers.map((_, i) => r[i] ?? '')) };
}

/** The list sent with this question, read whole, ready to stage as the CSV the import reads. */
function contactListOf(ctx: ToolContext, args: Args): ContactList {
  const sent = ctx.files ?? [];
  const file = sent[Number(args['fromFile'] ?? 1) - 1];
  if (!file)
    throw HfosError.validation(
      [{ path: 'fromFile', message: 'No such file.' }],
      sent.length
        ? `Only ${count(sent.length, 'file')} came with this question.`
        : 'No file came with this question. Ask them to send the list (a .csv, an Excel file or a contacts .vcf) with their question.',
    );
  if (file.kind === 'pdf') throw notAList(file.name, 'a PDF');
  const bytes = Buffer.from(file.data, 'base64');
  let out: Omit<ContactList, 'csv' | 'file'> & { csv?: string };
  if (file.mediaType === ASSISTANT_VCARD_TYPE) {
    const table = vcardTable(parseVcards(plainText(bytes)));
    out = { from: 'vcard', sheet: null, headers: table.headers, rows: table.rows };
  } else if (file.mediaType === ASSISTANT_XLSX_TYPE) {
    const book = workbookRows(bytes);
    if (!book.ok)
      throw HfosError.rule(
        'file_unreadable',
        400,
        book.why === 'none'
          ? `${file.name} has nothing on any of its sheets.`
          : `${file.name} couldn’t be opened. Open it in Excel to check it, or save the list as a .csv and send that.`,
      );
    const table = excelTable(book.rows);
    const rows = table.rows.map((r) =>
      Object.fromEntries(table.headers.map((h, i) => [h, r[i] ?? ''])),
    );
    out = { from: 'excel', sheet: book.sheet, headers: table.headers, rows };
  } else if (file.mediaType === 'text/csv') {
    const csv = plainText(bytes);
    out = { from: 'csv', sheet: null, csv, ...csvTable(csv) };
  } else
    throw notAList(
      file.name,
      file.mediaType === ASSISTANT_DOCX_TYPE ? 'a Word file' : 'a text file',
    );
  if (!out.headers.length || !out.rows.length)
    throw HfosError.rule(
      'contacts_list_empty',
      400,
      `${file.name} has no rows of contacts under its headings, so there’s no one to add.`,
    );
  if (out.rows.length > IMPORT_MAX_ROWS)
    throw HfosError.rule(
      'contacts_list_too_long',
      400,
      `${file.name} has ${out.rows.length.toLocaleString('en-US')} rows, more than the ${IMPORT_MAX_ROWS.toLocaleString('en-US')} one import takes. Split it into smaller files and send each one.`,
    );
  return {
    ...out,
    file: file.name,
    csv: out.csv ?? Papa.unparse({ fields: out.headers, data: out.rows }),
  };
}

const kindOf = (args: Args): ImportKind => (args['kind'] === 'companies' ? 'companies' : 'people');

/**
 * Which field each heading fills: the import's own guess from its words, then the columns the AI said, a field that
 * takes one column moving to the column it named. The same headings and the same columns give the same mapping on the
 * card and on Confirm, which reads the staged CSV again.
 */
function mappingOf(file: string, headers: readonly string[], kind: ImportKind, columns: unknown) {
  const mapping = guessMapping([...headers], kind);
  const allowed = new Set<string>([...(kind === 'people' ? PERSON_FIELDS : COMPANY_FIELDS), SKIP]);
  const said =
    columns && typeof columns === 'object' ? Object.entries(columns as Record<string, string>) : [];
  for (const [asked, field] of said) {
    const header =
      headers.find((h) => h === asked) ??
      headers.find((h) => h.trim().toLowerCase() === asked.trim().toLowerCase());
    if (!header)
      throw HfosError.rule(
        'contacts_no_such_column',
        400,
        `${file} has no column “${asked}”. Its columns are ${listWords([...headers], 12)}.`,
      );
    if (!allowed.has(field))
      throw HfosError.validation(
        [{ path: `columns.${asked}`, message: 'Not a field for this kind of list.' }],
        `“${IMPORT_FIELD_LABELS[field] ?? field}” isn’t something a list of ${kind} fills in.`,
      );
    if (field !== SKIP && !REPEATABLE_FIELDS.includes(field))
      for (const h of headers) if (mapping[h] === field) mapping[h] = SKIP;
    mapping[header] = field;
  }
  return mapping;
}

/** A field as the card says it: the import's words, with their hints left off. */
const fieldWords = (field: string) => (IMPORT_FIELD_LABELS[field] ?? field).replace(/ \(.*\)$/, '');

/** What the card checks before it's drawn, as import.start would refuse it, in words for the person. */
function checkMapping(
  file: string,
  headers: readonly string[],
  kind: ImportKind,
  mapping: Record<string, string>,
  args: Args,
) {
  const mapped = new Set(Object.values(mapping));
  if (
    kind === 'people' &&
    !mapped.has('first_name') &&
    !mapped.has('last_name') &&
    !mapped.has('full_name')
  )
    throw HfosError.rule(
      'contacts_no_name_column',
      400,
      `None of the columns in ${file} looks like their names. Its columns are ${listWords([...headers], 12)}. Say which one has the names (or the first and last names) in columns.`,
    );
  if (kind === 'companies' && !mapped.has('name'))
    throw HfosError.rule(
      'contacts_no_name_column',
      400,
      `None of the columns in ${file} looks like the companies’ names. Its columns are ${listWords([...headers], 12)}. Say which one has them in columns.`,
    );
  if (
    mapped.has('call_consent') &&
    !mapped.has('call_consent_source') &&
    !str(args['callConsentSource'])
  )
    throw HfosError.rule(
      'contacts_call_consent_where',
      400,
      `${file} has a column saying who agreed to calls. Ask them where those people agreed in writing, like “Website form, Oct 2026”, and pass it as callConsentSource, or skip that column.`,
    );
}

/** The rows as the import will see them: each one's name, and how many have nothing to add (no name, email or phone). */
function preview(
  kind: ImportKind,
  rows: readonly Record<string, string>[],
  mapping: Record<string, string>,
) {
  const names: string[] = [];
  let empty = 0;
  for (const row of rows) {
    const m = kind === 'people' ? mapPersonRow(row, mapping) : mapCompanyRow(row, mapping);
    const name = 'firstName' in m ? [m.firstName, m.lastName].filter(Boolean).join(' ') : m.name;
    if (!name && !m.email && !m.phone) {
      empty++;
      continue;
    }
    if (names.length < 3) names.push(name || m.email || m.phone || '');
  }
  return { names, adding: rows.length - empty, empty };
}

const howMany = (kind: ImportKind, n: number) =>
  kind === 'people'
    ? `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`
    : `${n.toLocaleString('en-US')} ${n === 1 ? 'company' : 'companies'}`;

/** What every contact in a .vcf brings, in words: "their names, phone numbers, emails and companies". */
function vcardBrings(rows: readonly Record<string, string>[]): string {
  const has = (test: (r: Record<string, string>) => boolean) => rows.some(test);
  const parts = [
    'their names',
    has((r) => !!r['Phone']) ? 'phone numbers' : '',
    has((r) => !!r['Email']) ? 'emails' : '',
    has((r) => !!r['Company']) ? 'companies' : '',
    has((r) => !!(r['Address'] || r['City'] || r['ZIP'])) ? 'addresses' : '',
    has((r) => !!r['Notes']) ? 'notes (job title, website and birthday go there too)' : '',
  ].filter(Boolean);
  return parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const importUnavailable = () =>
  HfosError.rule(
    'contacts_import_unavailable',
    503,
    'Contacts can’t be added from a file here just now. Add them under Settings → Imports instead, or try again in a minute.',
  );

const listGone = () =>
  HfosError.rule(
    'assistant_file_gone',
    410,
    'The list from that question isn’t kept anymore, so nobody was added. Send it again with your question.',
  );

const importsPath = (ws: string, importId: string) => `/app/w/${ws}/imports/${importId}`;

/**
 * The list as it waits for Confirm: the file's name on the first line (encoded, so it's one line), then the CSV.
 * Confirm has only the card's arguments, and the import is named for the file the person sent.
 */
const staging = (file: string, csv: string) =>
  Buffer.from(`${encodeURIComponent(file)}\n${csv}`, 'utf8');
function unstaged(bytes: Buffer): { file: string; csv: string } {
  const text = bytes.toString('utf8');
  const cut = text.indexOf('\n');
  let file = 'Contacts.csv';
  try {
    file = decodeURIComponent(text.slice(0, cut)).trim().slice(0, 200) || file;
  } catch {
    // A name that won't decode keeps the plain one.
  }
  return { file, csv: text.slice(cut + 1) };
}

const importContacts: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const list = contactListOf(ctx, args);
    if (list.from === 'vcard' && kindOf(args) === 'companies')
      throw HfosError.validation(
        [{ path: 'kind', message: 'A contacts file holds people.' }],
        'A contacts file holds people, so add it as people.',
      );
    const kind = kindOf(args);
    const mapping = mappingOf(list.file, list.headers, kind, args['columns']);
    checkMapping(list.file, list.headers, kind, mapping, args);
    const { names, adding, empty } = preview(kind, list.rows, mapping);
    if (!adding)
      throw HfosError.rule(
        'contacts_list_empty',
        400,
        `None of the rows in ${list.file} has a name, an email or a phone number, so there’s no one to add.`,
      );
    await rehearse(db, ctx, 'import.create', { kind, fileName: list.file });
    // What's sent is gone after this answer: the list waits for Confirm, as the CSV the import reads.
    if (!deps?.services?.store) throw importUnavailable();
    await deps.services.store.upload(
      STAGING_BUCKET,
      stagedPath(ctx.workspaceId, toolCallId, 'csv'),
      staging(list.file, list.csv),
      'text/csv',
      { upsert: true },
    );
    const used = list.headers.filter((h) => mapping[h] && mapping[h] !== SKIP);
    const leftOut = list.headers.filter((h) => !mapping[h] || mapping[h] === SKIP);
    const consentColumn = list.headers.find((h) => mapping[h] === 'call_consent');
    const where = str(args['callConsentSource']);
    const update = args['onMatch'] === 'update';
    const total = howMany(kind, adding);
    return {
      card: settingsCard(toolCallId, 'import_contacts', {
        title: `Add ${total} from ${list.file}?`,
        fields: [
          {
            label: 'File',
            value:
              list.sheet && list.from === 'excel'
                ? `${list.file}, sheet “${list.sheet}”`
                : list.file,
          },
          {
            label: kind === 'people' ? 'People' : 'Companies',
            value:
              adding > names.length
                ? `${names.join(', ')} and ${(adding - names.length).toLocaleString('en-US')} more`
                : names.join(', '),
          },
          list.from === 'vcard'
            ? { label: 'Each one brings', value: vcardBrings(list.rows) }
            : {
                label: 'Columns',
                value: listWords(
                  used.map((h) =>
                    fieldWords(mapping[h]!).toLowerCase() === h.toLowerCase()
                      ? h
                      : `${h} → ${fieldWords(mapping[h]!)}`,
                  ),
                  10,
                ),
              },
          ...(list.from !== 'vcard' && leftOut.length
            ? [{ label: 'Left out', value: listWords(leftOut, 6) }]
            : []),
          ...(empty
            ? [
                {
                  label: 'Rows with nothing to add',
                  value: `${empty.toLocaleString('en-US')}: no name, email or phone`,
                },
              ]
            : []),
          {
            label: 'Already in Contacts',
            value: update
              ? 'Updated with what the file has'
              : `Left as they are (matched by email, then phone${kind === 'companies' ? ', then name' : ''})`,
          },
          ...(consentColumn
            ? [
                {
                  label: 'Agreed to calls',
                  value: `From “${consentColumn}”: each yes is marked agreed in writing${where ? `, at ${where}` : ''}`,
                },
              ]
            : []),
        ],
        confirmLabel: `Add ${total}`,
        warnings: [
          { kind: 'note', text: 'Nobody is messaged: adding them sends nothing.' },
          {
            kind: 'note',
            text: 'It runs in the background. Settings → Imports shows how it went, and any row it couldn’t add.',
          },
        ],
      }),
      result: {
        waiting: true,
        file: list.file,
        kind,
        rows: list.rows.length,
        adding,
        columns: Object.fromEntries(used.map((h) => [h, mapping[h]])),
        ...(list.from !== 'vcard' && leftOut.length ? { leftOut } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const s = extra.services ?? null;
    if (!s) throw importUnavailable();
    const staged = stagedPath(ctx.workspaceId, extra.toolCallId, 'csv');
    const bytes = await s.store.download(STAGING_BUCKET, staged).catch(() => null);
    if (!bytes) throw listGone();
    try {
      const kind = kindOf(args);
      const { file: fileName, csv } = unstaged(bytes);
      const { headers, rows } = csvTable(csv);
      const mapping = mappingOf(fileName, headers, kind, args['columns']);
      checkMapping(fileName, headers, kind, mapping, args);
      const made = await command<{ importId: string; bucket: string; objectPath: string }>(
        db,
        ctx,
        'import.create',
        { kind, fileName },
      );
      await s.store.upload(made.bucket, made.objectPath, Buffer.from(csv, 'utf8'), 'text/csv');
      await command(db, ctx, 'import.start', {
        importId: made.importId,
        mapping,
        options: {
          onMatch: args['onMatch'] === 'update' ? 'update' : 'skip',
          ...(str(args['callConsentSource'])
            ? { callConsentSource: str(args['callConsentSource']) }
            : {}),
        },
      });
      const { adding } = preview(kind, rows, mapping);
      return {
        outcome: `Adding ${howMany(kind, adding)} from ${fileName} now, ${args['onMatch'] === 'update' ? 'and updating anyone already in Contacts' : 'leaving anyone already in Contacts as they are'}. They show in Contacts as they’re added; this import’s page shows how it went.`,
        href: importsPath(ctx.workspaceId, made.importId),
        command: 'import.start',
        answer: { importId: made.importId, rows: rows.length, adding },
      };
    } finally {
      await s.store.remove(STAGING_BUCKET, staged).catch(() => undefined);
    }
  },
};

export const contactConfirmTools: Record<string, SettingsConfirmTool> = {
  tag_customers: tagCustomers,
  ai_tag_customers: aiTagCustomers,
  update_customer: updateCustomer,
  import_contacts: importContacts,
};
