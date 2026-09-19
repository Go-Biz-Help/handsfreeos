/**
 * Turning canonical records into HandsFreeOS records.
 *
 * These read canonical envelopes and nothing else — no importer here could tell you which CRM the business is
 * leaving, and that is the property the whole milestone is built to keep.
 *
 * The rule that shapes every one of them: **history keeps its own dates.** A customer added in 2019 is a
 * customer added in 2019, not a customer added the afternoon somebody clicked Import. So `created_at` and
 * `updated_at` are written from the source, in the same statement as the record, rather than left to their
 * defaults. The worker is the only writer allowed to do that, and it is the difference between a business
 * that moved house and a business that started again.
 *
 * The other rule: **nothing reaches a customer.** These write rows. They send no text, no email, no
 * reminder; they raise no unread badge; they start no workflow. A thousand appointments arriving from 2019
 * must not produce a thousand reminders, and the way to be sure of that is to write the rows directly rather
 * than to replay the commands a person would have used.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  AUTO_MERGE_SCORE,
  decideMerge,
  FormDefinition,
  mergeScalarFields,
  normalizePhone,
  stricterConsent,
  unionValues,
  slugify,
  type CanonicalEnvelope,
  type ExistingContact,
  type SmsConsent,
} from '@hfos/core/server';
import {
  existingMapping,
  finding,
  journal,
  putMapping,
  quarantine,
  type ImportCounts,
  type ImportScope,
} from '../engine/write';

export interface ImporterResult {
  readonly counts: Partial<ImportCounts>;
}

export type Importer = (
  tx: Tx,
  scope: ImportScope,
  envelope: CanonicalEnvelope,
) => Promise<ImporterResult>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A Postgres `text[]` from a list, empty included. */
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/** HandsFreeOS keeps tags to 40 characters. A longer one is shortened and said out loud, never dropped. */
const TAG_MAX = 40;
const tagName = (v: unknown): { name: string | null; shortened: boolean } => {
  const name = str(v);
  if (!name) return { name: null, shortened: false };
  return name.length <= TAG_MAX
    ? { name, shortened: false }
    : { name: name.slice(0, TAG_MAX).trim(), shortened: true };
};

async function tagShortened(tx: Tx, scope: ImportScope, original: string): Promise<void> {
  await finding(tx, scope, {
    code: 'tags.shortened',
    category: 'tags',
    capability: 'needs_review',
    severity: 'info',
    summary: 'Some tags were longer than HandsFreeOS allows and were shortened.',
    whatImports: 'The tag, and every customer it was on.',
    whatChanges: `Tags are kept to ${TAG_MAX} characters here, so the end of the name is cut off.`,
    recommendedAction: 'Rename them if the shorter version is confusing.',
    affected: 1,
    detail: { example: original.slice(0, 120) },
  });
}

/**
 * The business's own customer fields, by key. Read once per record rather than joined into every value: an
 * import of ten thousand customers asks for a handful of fields ten thousand times otherwise.
 */
async function personFields(
  tx: Tx,
  scope: ImportScope,
): Promise<Map<string, { id: string; type: string }>> {
  const list = await rows<{ id: string; key: string; type: string }>(
    tx,
    sql`select id::text as id, key, type::text as type from app.custom_fields
        where workspace_id = ${scope.workspaceId} and entity = 'person' and archived_at is null`,
  );
  return new Map(list.map((f) => [f.key, { id: f.id, type: f.type }]));
}

/**
 * One value in the shape its field holds here, or `undefined` when it plainly is not that kind of thing —
 * which sends it to the notes instead of writing a number field that says "ask Dave".
 */
function fieldValue(type: string, raw: unknown): unknown {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  switch (type) {
    case 'number':
    case 'money': {
      const n = typeof text === 'number' ? text : Number(String(text).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      if (typeof text === 'boolean') return text;
      const v = String(text).toLowerCase();
      if (['true', 'yes', '1', 'y'].includes(v)) return true;
      if (['false', 'no', '0', 'n'].includes(v)) return false;
      return undefined;
    }
    case 'date': {
      const d = new Date(String(text));
      // The date part only: a date field here holds a day, not a moment.
      return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;
    }
    case 'multi_choice': {
      const list = Array.isArray(raw) ? raw : String(text).split(/\s*[,;|]\s*/);
      const kept = list.map((v) => String(v).trim()).filter(Boolean);
      return kept.length ? kept : undefined;
    }
    default: {
      const v = Array.isArray(raw) ? raw.map(String).join(', ') : String(text);
      return v.trim() ? v : undefined;
    }
  }
}

/** The old system's time, or now when it never told us. A missing date is worth saying out loud. */
const sourceTimes = (e: CanonicalEnvelope) => ({
  createdAt: e.source.sourceCreatedAt ? new Date(e.source.sourceCreatedAt) : null,
  updatedAt: e.source.sourceUpdatedAt ? new Date(e.source.sourceUpdatedAt) : null,
});

// ---------- the team ----------

/**
 * People who worked in the old system.
 *
 * The honest limit, and it is worth stating plainly: a HandsFreeOS user is an account somebody signs in to,
 * so we cannot conjure one for a person who has never been here. What we can do — and do — is join them to
 * the account they already have by email, so everything they owned keeps their name on it. For everyone
 * else, the migration records who they were, leaves their customers unassigned, and raises a finding saying
 * exactly that, with their names in it. An import that quietly assigned Ana's customers to whoever ran the
 * migration would be worse than one that says nobody owns them yet.
 */
export const importUser: Importer = async (tx, scope, envelope) => {
  const data = envelope.data as {
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  const email = str(data.email)?.toLowerCase() ?? null;
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const name = [str(data.firstName), str(data.lastName)].filter(Boolean).join(' ') || 'Someone';
  if (!email) {
    await finding(tx, scope, {
      code: 'users.no_email',
      category: 'users',
      capability: 'needs_review',
      severity: 'review',
      summary: `${name} has no email in the old system, so they cannot be matched to an account here.`,
      whatImports: 'Their customers still come across; nobody owns them yet.',
      recommendedAction: 'Assign those customers once the person has an account here.',
      // One finding per person. Findings are counted up by their key, and without this every one of them
      // would land on the same row — with the last person's name and the first person's email beside it.
      sourceCapability: envelope.source.objectId,
      affected: 1,
    });
    return { counts: { skipped: 1 } };
  }
  // Somebody who is already here, in this organization.
  const [match] = await rows<{ id: string }>(
    tx,
    sql`select u.id::text as id from app.users u
        join app.workspace_memberships wm on wm.user_id = u.id
        where u.email = ${email}::extensions.citext and wm.workspace_id = ${scope.workspaceId}
          and u.deleted_at is null
        limit 1`,
  );
  if (!match) {
    await finding(tx, scope, {
      code: 'users.not_here',
      category: 'users',
      capability: 'needs_review',
      severity: 'review',
      summary: `${name} worked in the old system but has no account here.`,
      whatImports:
        'Everything they handled comes across, and the old system’s record of who did what is kept with it.',
      whatChanges:
        'Their customers arrive with nobody assigned, because an owner has to be a real account.',
      recommendedAction: `Invite ${name} (${email}), then assign their customers.`,
      // One finding per person, for the same reason as above.
      sourceCapability: envelope.source.objectId,
      affected: 1,
      detail: { email, sourceUserId: envelope.source.objectId },
    });
    return { counts: { skipped: 1 } };
  }
  // A mapping to somebody who was already here: never created by us, so rollback must never remove them.
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'user',
    targetId: match.id,
    createdHere: false,
    checksum: envelope.source.payloadChecksum,
  });
  return { counts: { merged: 1 } };
};

// ---------- tags ----------

export const importTag: Importer = async (tx, scope, envelope) => {
  const raw = str((envelope.data as { name?: string }).name);
  const { name, shortened } = tagName(raw);
  if (!name) return { counts: { skipped: 1 } };
  if (shortened) await tagShortened(tx, scope, raw!);
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };
  // A tag of the same name already here is that tag: names are what a tag is, so this is not a guess.
  const [match] = await rows<{ id: string }>(
    tx,
    sql`select id::text as id from app.tags
        where workspace_id = ${scope.workspaceId} and name = ${name}::extensions.citext limit 1`,
  );
  if (match) {
    await putMapping(tx, scope, {
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      targetType: 'tag',
      targetId: match.id,
      createdHere: false,
      checksum: envelope.source.payloadChecksum,
    });
    return { counts: { merged: 1 } };
  }
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.tags (id, workspace_id, name, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${name}::extensions.citext,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))
    on conflict (workspace_id, name) do nothing`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'tag',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'tag',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- custom fields ----------

/**
 * The extra fields a business invented, brought across as fields.
 *
 * This importer used to import nothing: HandsFreeOS had no custom fields, so it raised a finding and the
 * values went into each customer's notes. M15 built them (`app.custom_fields`, and a `custom` object on the
 * customer keyed by the field's id), so they now come across as what they are — a field you can see on the
 * customer, filter by and report on.
 *
 * Two mappings are not one-to-one, and both are said out loud rather than fudged:
 *   - a **date and time** over there becomes a date here, so the time of day is lost;
 *   - a **file** over there becomes a link here, because a field cannot hold a file yet.
 * A type we have never seen becomes text, which is what the adapter already warned about on the way in.
 */
const FIELD_TYPE_HERE: Readonly<Record<string, string>> = {
  text: 'text',
  long_text: 'long_text',
  number: 'number',
  money: 'money',
  date: 'date',
  datetime: 'date',
  boolean: 'boolean',
  choice: 'choice',
  multi_choice: 'multi_choice',
  phone: 'phone',
  email: 'email',
  url: 'url',
  file: 'url',
};

/** What the field is attached to here. GoHighLevel has no equivalent of a field on an appointment. */
const FIELD_ENTITY: Readonly<Record<string, string>> = {
  contact: 'person',
  company: 'company',
  lead: 'lead',
};

/**
 * A key the database will accept: `^[a-z][a-z0-9_]{0,39}$`. A name in another alphabet, or one starting with a
 * digit, still gets a key rather than failing the import.
 */
const fieldKey = (raw: string, fallback: string): string => {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = /^[a-z]/.test(cleaned) ? cleaned : `f_${cleaned}`;
  return (key.replace(/_+$/, '') || `f_${fallback.toLowerCase().replace(/[^a-z0-9]/g, '')}`).slice(
    0,
    40,
  );
};

export const importCustomField: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    key?: string;
    type?: string;
    options?: string[];
    position?: number;
    appliesTo?: string;
  };
  const label = str(d.name) ?? 'Unnamed field';
  const entity = FIELD_ENTITY[str(d.appliesTo) ?? 'contact'];
  if (!entity) {
    // A field on an appointment: there is nowhere for it, and quietly moving it onto the customer would put
    // one appointment's answer on every appointment they ever had.
    await finding(tx, scope, {
      code: 'custom_fields.no_home_for_entity',
      category: 'custom_fields',
      capability: 'not_supported',
      severity: 'review',
      summary: `“${label}” is a field on something HandsFreeOS has no fields for.`,
      whatImports: 'Nothing for this field, and nothing is invented in its place.',
      whatChanges:
        'Custom fields here belong to a customer, a company or a lead. Its values stay in the staged records, so nothing is lost if we add more later.',
      sourceCapability: 'custom_fields',
      affected: 1,
      detail: { field: label, appliesTo: d.appliesTo ?? null },
    });
    return { counts: { skipped: 1 } };
  }

  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const sourceType = str(d.type) ?? 'text';
  const type = FIELD_TYPE_HERE[sourceType] ?? 'text';
  if (sourceType === 'datetime' || sourceType === 'file')
    await finding(tx, scope, {
      code: 'custom_fields.type_narrowed',
      category: 'custom_fields',
      capability: 'needs_review',
      severity: 'info',
      summary:
        sourceType === 'datetime'
          ? `“${label}” kept its date, but not the time of day.`
          : `“${label}” comes across as a link rather than a file.`,
      whatImports: 'The field and every value on it.',
      whatChanges:
        sourceType === 'datetime'
          ? 'HandsFreeOS has date fields, not date-and-time fields, so the time part is dropped.'
          : 'A field here holds a link, so the file stays where it is and the field points at it.',
      sourceCapability: 'custom_fields',
      affected: 1,
      detail: { field: label, sourceType },
    });

  const key = fieldKey(str(d.key) ?? label, envelope.source.objectId);
  // A field of the same name on the same thing is that field, the way a tag of the same name is that tag.
  const [match] = await rows<{ id: string }>(
    tx,
    sql`select id::text as id from app.custom_fields
        where workspace_id = ${scope.workspaceId} and entity = ${entity}::app.custom_field_entity
          and (key = ${key} or lower(label) = ${label.toLowerCase()})
        limit 1`,
  );
  if (match) {
    await putMapping(tx, scope, {
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      targetType: 'custom_field',
      targetId: match.id,
      createdHere: false,
      checksum: envelope.source.payloadChecksum,
    });
    return { counts: { merged: 1 } };
  }

  // Options belong to a choice field and to no other: the database refuses options on a text field, and
  // refuses a choice field with none. A choice field whose options never came across becomes text, which
  // keeps every value rather than losing the field.
  const choices = (d.options ?? [])
    .map((o) => str(o))
    .filter((o): o is string => !!o)
    .slice(0, 100)
    .map((o) => ({ value: o.slice(0, 60), label: o.slice(0, 60) }));
  const wantsChoices = type === 'choice' || type === 'multi_choice';
  const finalType = wantsChoices && choices.length === 0 ? 'text' : type;
  const options = finalType === 'choice' || finalType === 'multi_choice' ? choices : [];
  if (wantsChoices && choices.length === 0)
    await finding(tx, scope, {
      code: 'custom_fields.choices_missing',
      category: 'custom_fields',
      capability: 'needs_review',
      severity: 'info',
      summary: `“${label}” was a list to pick from, and came across as plain text.`,
      whatImports: 'The field and every value on it.',
      whatChanges:
        'The old system gave us no options for it, and a list with nothing in it is not a list.',
      recommendedAction: 'Add the options here if you want it back as a list.',
      sourceCapability: 'custom_fields',
      affected: 1,
      detail: { field: label },
    });
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  // A key is unique per business and thing, and two fields over there can reduce to the same key here, so a
  // clash falls back to a key nobody can collide with rather than failing the import.
  await tx.execute(sql`
    insert into app.custom_fields (id, workspace_id, entity, key, label, type, options, position,
      created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${entity}::app.custom_field_entity,
      ${key}, ${label.slice(0, 60)}, ${finalType}::app.custom_field_type,
      ${JSON.stringify(options)}::jsonb, ${Math.max(0, Math.min(1000, Number(d.position ?? 0) || 0))},
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))
    on conflict (workspace_id, entity, key) do nothing`);
  const [landed] = await rows<{ id: string }>(
    tx,
    sql`select id::text as id from app.custom_fields
        where workspace_id = ${scope.workspaceId} and entity = ${entity}::app.custom_field_entity
          and key = ${key} limit 1`,
  );
  const targetId = landed?.id ?? id;
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'custom_field',
    targetId,
    createdHere: targetId === id,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: targetId === id ? 'create' : 'link',
    targetType: 'custom_field',
    targetId,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- companies ----------

export const importCompany: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    address?: {
      line1?: string | null;
      city?: string | null;
      state?: string | null;
      postalCode?: string | null;
      country?: string | null;
    } | null;
  };
  const name = str(d.name);
  if (!name) {
    await quarantine(tx, scope, {
      category: 'companies',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'mapping',
      code: 'company_without_name',
      message: 'A company with no name cannot be brought across.',
      retryable: false,
    });
    return { counts: { failed: 1 } };
  }
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const phoneE164 = normalizePhone(str(d.phone), scope.defaultCountry as never);
  const [match] = await rows<{ id: string }>(
    tx,
    sql`select id::text as id from app.companies
        where workspace_id = ${scope.workspaceId} and archived_at is null
          and lower(name) = lower(${name}) limit 1`,
  );
  const { createdAt, updatedAt } = sourceTimes(envelope);
  if (match) {
    await putMapping(tx, scope, {
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      targetType: 'company',
      targetId: match.id,
      createdHere: false,
      checksum: envelope.source.payloadChecksum,
    });
    return { counts: { merged: 1 } };
  }
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.companies (id, workspace_id, name, email, phone, phone_e164, website,
      address_line1, city, state, postal_code, country, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${name}, ${str(d.email)}::extensions.citext,
      ${str(d.phone)}, ${phoneE164}, ${str(d.website)},
      ${str(d.address?.line1)}, ${str(d.address?.city)}, ${str(d.address?.state)},
      ${str(d.address?.postalCode)}, coalesce(${str(d.address?.country)}, 'US'),
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'company',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'company',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- customers ----------

/** Everyone here this person could be: matched on number and address, never on a name. */
async function candidatesFor(
  tx: Tx,
  scope: ImportScope,
  email: string | null,
  phoneE164: string | null,
): Promise<ExistingContact[]> {
  if (!email && !phoneE164) return [];
  const list = await rows<{
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone_e164: string | null;
    phone_alt: string | null;
    postal_code: string | null;
  }>(
    tx,
    sql`select id::text as id, first_name, last_name, email::text as email, phone_e164, phone_alt, postal_code
        from app.people
        where workspace_id = ${scope.workspaceId} and archived_at is null
          and ((${email}::text is not null and email = ${email}::extensions.citext)
            or (${phoneE164}::text is not null and (phone_e164 = ${phoneE164} or phone_alt = ${phoneE164})))
        limit 20`,
  );
  return list.map((p) => ({
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    phoneE164: p.phone_e164,
    extraPhones: p.phone_alt ? [p.phone_alt] : [],
    postalCode: p.postal_code,
  }));
}

export const importContact: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: {
      line1?: string | null;
      city?: string | null;
      state?: string | null;
      postalCode?: string | null;
      country?: string | null;
    } | null;
    source?: string | null;
    tags?: string[];
    customFields?: Record<string, unknown>;
    consent?: { channel: string; state: SmsConsent }[];
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );

  // A name, from whatever the old system gave. One space, never a guess at middle names.
  let firstName = str(d.firstName) ?? '';
  let lastName = str(d.lastName) ?? '';
  if (!firstName && !lastName && str(d.fullName)) {
    const parts = str(d.fullName)!.split(/\s+/);
    firstName = parts[0] ?? '';
    lastName = parts.slice(1).join(' ');
  }
  const email = str(d.email)?.toLowerCase() ?? null;
  const phoneE164 = normalizePhone(str(d.phone), scope.defaultCountry as never);
  const smsConsent: SmsConsent = d.consent?.find((c) => c.channel === 'sms')?.state ?? 'unknown';
  const { createdAt, updatedAt } = sourceTimes(envelope);

  // Custom-field values. Since M15 these have a real home: `people.custom`, keyed by the id of the field the
  // custom-field importer made earlier in the same import. What is left over — a value whose field never came
  // across, because its shape was not readable or it lived on something we have no fields for — still goes
  // into the notes named as it was named over there, rather than being dropped.
  const values = Object.entries(d.customFields ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  const fields = await personFields(tx, scope);
  const custom: Record<string, unknown> = {};
  const homeless: [string, unknown][] = [];
  for (const [key, value] of values) {
    // The old system's key as the field importer would have written it: `contact.unit_model` over there is
    // `contact_unit_model` here, and looking it up raw would send every value to the notes instead.
    const field = fields.get(fieldKey(key, key));
    if (!field) {
      homeless.push([key, value]);
      continue;
    }
    const held = fieldValue(field.type, value);
    if (held === undefined) homeless.push([key, value]);
    else custom[field.id] = held;
  }
  const notes = homeless.length
    ? `From the old system:\n${homeless.map(([k, v]) => `• ${k}: ${String(v)}`).join('\n')}`
    : null;

  if (already) {
    // Seen before: bring anything that has changed since, and never make a second one.
    return { counts: { skipped: 1 } };
  }

  const decision = decideMerge(
    {
      firstName,
      lastName,
      email,
      phone: phoneE164,
      postalCode: str(d.address?.postalCode),
      defaultCountry: scope.defaultCountry as never,
    },
    await candidatesFor(tx, scope, email, phoneE164),
  );

  if (decision.kind === 'review') {
    // Never guessed. The record waits for a person, and the import carries on around it.
    await tx.execute(sql`
      insert into app.migration_merge_candidates
        (migration_id, organization_id, scope_id, workspace_id, source_object_type, source_object_id,
         target_type, target_id, match_rule, score, evidence)
      values (${scope.migrationId}, ${scope.organizationId}, ${scope.scopeId}, ${scope.workspaceId},
        ${envelope.source.objectType}, ${envelope.source.objectId}, 'person',
        ${decision.targetIds[0] ?? null}::uuid, ${decision.rule}, ${decision.score},
        ${JSON.stringify(decision.evidence)}::jsonb)
      on conflict (scope_id, source_object_type, source_object_id,
                   coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing`);
    return { counts: { needsReview: 1 } };
  }

  if (decision.kind === 'merge') {
    const [here] = await rows<{
      id: string;
      first_name: string;
      last_name: string;
      email: string | null;
      phone: string | null;
      phone_e164: string | null;
      phone_alt: string | null;
      source: string | null;
      notes: string | null;
      address_line1: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      sms_consent: SmsConsent;
    }>(
      tx,
      sql`select id::text as id, first_name, last_name, email::text as email, phone, phone_e164, phone_alt,
            source, notes, address_line1, city, state, postal_code, sms_consent::text as sms_consent
          from app.people where id = ${decision.targetId}::uuid`,
    );
    if (here) {
      const merged = mergeScalarFields(
        {
          email: here.email,
          phone: here.phone,
          source: here.source,
          address_line1: here.address_line1,
          city: here.city,
          state: here.state,
          postal_code: here.postal_code,
          first_name: here.first_name,
          last_name: here.last_name,
        },
        {
          email,
          phone: str(d.phone),
          source: str(d.source),
          address_line1: str(d.address?.line1),
          city: str(d.address?.city),
          state: str(d.address?.state),
          postal_code: str(d.address?.postalCode),
          first_name: firstName,
          last_name: lastName,
        },
        [
          'email',
          'phone',
          'source',
          'address_line1',
          'city',
          'state',
          'postal_code',
          'first_name',
          'last_name',
        ],
      );
      // The stricter agreement wins, from either side. Somebody who told either system to stop has told us.
      const consent = stricterConsent(here.sms_consent, smsConsent);
      // A second number is kept rather than replacing the first.
      const altPhones = unionValues(
        [here.phone_alt].filter(Boolean) as string[],
        phoneE164 && phoneE164 !== here.phone_e164 ? [phoneE164] : [],
      );
      const changed: Record<string, { before: unknown; after: unknown }> = {};
      for (const [k, v] of Object.entries(merged.updates)) changed[k] = { before: null, after: v };
      if (consent !== here.sms_consent)
        changed['sms_consent'] = { before: here.sms_consent, after: consent };
      const alt = altPhones[0] ?? here.phone_alt;
      if (alt !== here.phone_alt) changed['phone_alt'] = { before: here.phone_alt, after: alt };
      const nextNotes = notes ? [here.notes, notes].filter(Boolean).join('\n\n') : here.notes;
      if (nextNotes !== here.notes) changed['notes'] = { before: here.notes, after: nextNotes };
      // Custom values merge the way every other field does: what is empty here is filled, what somebody has
      // already answered here is left alone. Two sub-accounts holding the same customer must not fight over
      // the gate code, and the second one in must not win by being second.
      if (Object.keys(custom).length > 0)
        changed['custom'] = { before: 'kept', after: 'filled in' };

      if (Object.keys(changed).length > 0) {
        await tx.execute(sql`
          update app.people set
            email = coalesce(${(merged.updates['email'] as string) ?? null}::extensions.citext, email),
            phone = coalesce(${(merged.updates['phone'] as string) ?? null}, phone),
            phone_e164 = coalesce(${merged.updates['phone'] ? phoneE164 : null}, phone_e164),
            phone_alt = ${alt},
            source = coalesce(${(merged.updates['source'] as string) ?? null}, source),
            address_line1 = coalesce(${(merged.updates['address_line1'] as string) ?? null}, address_line1),
            city = coalesce(${(merged.updates['city'] as string) ?? null}, city),
            state = coalesce(${(merged.updates['state'] as string) ?? null}, state),
            postal_code = coalesce(${(merged.updates['postal_code'] as string) ?? null}, postal_code),
            first_name = coalesce(nullif(${(merged.updates['first_name'] as string) ?? null}, ''), first_name),
            last_name = coalesce(nullif(${(merged.updates['last_name'] as string) ?? null}, ''), last_name),
            sms_consent = ${consent}::app.sms_consent,
            notes = ${nextNotes},
            custom = ${JSON.stringify(custom)}::jsonb || custom
          where id = ${here.id}::uuid`);
        await journal(tx, scope, {
          action: 'merge',
          targetType: 'person',
          targetId: here.id,
          sourceObjectType: envelope.source.objectType,
          sourceObjectId: envelope.source.objectId,
          changedFields: changed,
        });
      }
      // What the old system said and we did not take, kept so somebody can see the difference and choose.
      if (Object.keys(merged.kept).length > 0)
        await finding(tx, scope, {
          code: 'merge.kept_what_was_here',
          category: 'contacts',
          capability: 'needs_review',
          severity: 'info',
          summary: 'Some customers here already had a different value from the old system.',
          whatImports: 'Blank fields were filled in from the old system.',
          whatChanges:
            'Anything already filled in here was left as it was, and the old value is listed.',
          recommendedAction: 'Look at the list if you want the old system’s value instead.',
          affected: 1,
        });
      await putMapping(tx, scope, {
        sourceObjectType: envelope.source.objectType,
        sourceObjectId: envelope.source.objectId,
        targetType: 'person',
        targetId: here.id,
        createdHere: false,
        checksum: envelope.source.payloadChecksum,
      });
      await applyTags(tx, scope, 'person', here.id, d.tags ?? []);
      return { counts: { merged: 1 } };
    }
  }

  // Nobody here is this person: a new customer, with the date the old system first knew them.
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.people (id, workspace_id, first_name, last_name, email, phone, phone_e164,
      address_line1, city, state, postal_code, country, source, notes, custom, sms_consent,
      created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${firstName}, ${lastName},
      ${email}::extensions.citext, ${str(d.phone)}, ${phoneE164},
      ${str(d.address?.line1)}, ${str(d.address?.city)}, ${str(d.address?.state)},
      ${str(d.address?.postalCode)}, coalesce(${str(d.address?.country)}, 'US'),
      ${str(d.source)}, ${notes}, ${JSON.stringify(custom)}::jsonb, ${smsConsent}::app.sms_consent,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'person',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'person',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  await applyTags(tx, scope, 'person', id, d.tags ?? []);
  await linkOwner(tx, scope, id, envelope);
  await linkCompany(tx, scope, id, envelope);
  if (!createdAt)
    await finding(tx, scope, {
      code: 'history.no_created_date',
      category: 'contacts',
      capability: 'needs_review',
      severity: 'info',
      summary: 'Some customers had no "added on" date in the old system.',
      whatImports: 'The customer, with everything else they had.',
      whatChanges:
        'They show as added on the day they arrived here, because there was nothing else to use.',
      affected: 1,
    });
  return { counts: { imported: 1 } };
};

/** Tags by name, made if they are not here yet. A tag is its name, so this is not a guess. */
async function applyTags(
  tx: Tx,
  scope: ImportScope,
  recordType: 'person' | 'company',
  recordId: string,
  names: readonly string[],
): Promise<void> {
  for (const original of names) {
    const { name, shortened } = tagName(original);
    if (!name) continue;
    if (shortened) await tagShortened(tx, scope, String(original));
    // Insert or find: the worker may create a tag but not rewrite one, which is right — a tag already here
    // belongs to the business, not to the migration.
    const [made] = await rows<{ id: string }>(
      tx,
      sql`insert into app.tags (workspace_id, name) values (${scope.workspaceId}, ${name}::extensions.citext)
          on conflict (workspace_id, name) do nothing
          returning id::text as id`,
    );
    const tag =
      made ??
      (
        await rows<{ id: string }>(
          tx,
          sql`select id::text as id from app.tags
              where workspace_id = ${scope.workspaceId} and name = ${name}::extensions.citext`,
        )
      )[0];
    if (!tag) continue;
    await tx.execute(sql`
      insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
      values (${scope.workspaceId}, ${tag.id}::uuid, ${recordType}::app.record_type, ${recordId}::uuid)
      on conflict do nothing`);
  }
}

/** The owner, when the person who had them over there has an account here. */
async function linkOwner(
  tx: Tx,
  scope: ImportScope,
  personId: string,
  envelope: CanonicalEnvelope,
): Promise<void> {
  const ref = envelope.relationships.find((r) => r.role === 'owner');
  if (!ref) return;
  const owner = await existingMapping(tx, scope, ref.objectType, ref.objectId);
  if (!owner || owner.targetType !== 'user') return;
  await tx.execute(
    sql`update app.people set owner_user_id = ${owner.targetId}::uuid where id = ${personId}::uuid`,
  );
  await journal(tx, scope, {
    action: 'link',
    targetType: 'person',
    targetId: personId,
    changedFields: { owner_user_id: { before: null, after: owner.targetId } },
  });
}

async function linkCompany(
  tx: Tx,
  scope: ImportScope,
  personId: string,
  envelope: CanonicalEnvelope,
): Promise<void> {
  const ref = envelope.relationships.find((r) => r.role === 'company');
  if (!ref) return;
  const company = await existingMapping(tx, scope, ref.objectType, ref.objectId);
  if (!company || company.targetType !== 'company') return;
  await tx.execute(
    sql`update app.people set company_id = ${company.targetId}::uuid where id = ${personId}::uuid`,
  );
  await journal(tx, scope, {
    action: 'link',
    targetType: 'person',
    targetId: personId,
    changedFields: { company_id: { before: null, after: company.targetId } },
  });
}

// ---------- conversations, messages and calls ----------

/**
 * The history, in the business's own inbox.
 *
 * The promise here is the whole reason the milestone exists: a text sent on a Tuesday afternoon in 2019 sits
 * where a Tuesday afternoon in 2019 belongs, and opening the customer shows the conversation as though
 * HandsFreeOS had been carrying it all along.
 *
 * What these deliberately do **not** do, because history is not work:
 *   - **no unread count.** Five years of messages must not arrive as five years of badges.
 *   - **nothing goes out.** Rows are written directly, so no carrier, no mailbox and no AI teammate is ever
 *     asked to do anything; `handled_by` stays `none` and no run is started.
 *   - **no awaiting-reply clock.** An old thread the business never answered is not a customer waiting now.
 * Each of those is a column left alone on purpose, and each would be a customer-visible mistake if it were
 * filled in from the past.
 */
const conversationPerson = async (
  tx: Tx,
  scope: ImportScope,
  envelope: CanonicalEnvelope,
): Promise<string | null> => {
  const ref = envelope.relationships.find((r) => r.role === 'contact');
  if (!ref) return null;
  const person = await existingMapping(tx, scope, ref.objectType, ref.objectId);
  return person && person.targetType === 'person' ? person.targetId : null;
};

export const importConversation: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    channel?: string;
    channelName?: string | null;
    counterpart?: string;
    subject?: string | null;
    status?: string;
    startedAt?: string | null;
    lastMessageAt?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const channel = d.channel === 'sms' || d.channel === 'email' ? d.channel : 'chat';
  // The table decides what a counterpart may be, and it is strict for a reason: a text thread is addressed
  // by a real number and an email thread by a real address, or neither can ever be replied to from here.
  const raw = str(d.counterpart);
  const counterpart =
    channel === 'sms'
      ? normalizePhone(raw, scope.defaultCountry as never)
      : channel === 'email'
        ? raw?.toLowerCase().includes('@')
          ? raw.toLowerCase()
          : null
        : // A chat thread is addressed by a visitor id (`chat:…`), because that is what chat means here: the
          // website window. A WhatsApp or Instagram thread has no visitor id, so it gets one of its own,
          // named for where it came from — the customer is still attached by `person_id`, which is what the
          // inbox shows. Deliberately not folded onto the customer's text thread: replying there would send
          // a real text to somebody who wrote on WhatsApp, and they would never see it.
          chatAddress(scope.sourceSystem, envelope.source.objectId);
  if (!counterpart) {
    await quarantine(tx, scope, {
      category: 'conversations',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'mapping',
      code: 'conversation_without_counterpart',
      message:
        channel === 'sms'
          ? `A text thread whose number the old system gave as "${raw ?? 'nothing'}" cannot be placed: a thread here is addressed by a real number so it can be replied to.`
          : `A ${channel} thread with nobody addressable on the other end cannot be placed.`,
      retryable: false,
    });
    return { counts: { failed: 1 } };
  }

  const personId = await conversationPerson(tx, scope, envelope);
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const lastAt = d.lastMessageAt ?? updatedAt?.toISOString() ?? null;

  /**
   * One thread per customer per channel, which is what HandsFreeOS is and what the unique index says. The old
   * system can hold several threads with the same person on the same channel, so those fold into one here and
   * their messages interleave by time — which is the timeline a business actually wants. Nothing is lost and
   * nothing is guessed; the folding is said out loud in a finding the first time it happens.
   */
  const [here] = await rows<{ id: string }>(
    tx,
    sql`select id::text as id from app.conversations
        where workspace_id = ${scope.workspaceId} and channel = ${channel}::app.channel
          and counterpart = ${counterpart} limit 1`,
  );
  if (here) {
    await tx.execute(sql`
      update app.conversations set
        person_id = coalesce(person_id, ${personId}::uuid),
        created_at = least(created_at, coalesce(${createdAt?.toISOString() ?? null}::timestamptz, created_at)),
        last_message_at = greatest(coalesce(last_message_at, 'epoch'::timestamptz), coalesce(${lastAt}::timestamptz, 'epoch'::timestamptz))
      where id = ${here.id}::uuid`);
    await putMapping(tx, scope, {
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      targetType: 'conversation',
      targetId: here.id,
      createdHere: false,
      checksum: envelope.source.payloadChecksum,
    });
    await finding(tx, scope, {
      code: 'conversations.folded',
      category: 'conversations',
      capability: 'needs_review',
      severity: 'info',
      summary:
        'Some customers had more than one thread on the same channel, and those are now one.',
      whatImports: 'Every message from every one of them.',
      whatChanges:
        'HandsFreeOS keeps one thread per customer per channel, so their messages sit in one timeline in the order they happened rather than in separate threads.',
      sourceCapability: 'conversations',
      affected: 1,
      detail: { channel, counterpart: counterpart.slice(0, 60) },
    });
    return { counts: { merged: 1 } };
  }

  const id = randomUUID();
  await tx.execute(sql`
    insert into app.conversations (id, workspace_id, channel, counterpart, person_id, status,
      unread_count, last_message_at, last_preview, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${channel}::app.channel,
      ${counterpart.slice(0, 320)}, ${personId}::uuid,
      ${d.status === 'open' ? 'open' : 'closed'}::app.conversation_status,
      -- Never a badge: five years of history is not five years of unread work.
      0, ${lastAt}::timestamptz, ${str(d.subject)?.slice(0, 280) ?? null},
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  // What it really was, when the source's channel is not one of ours: said once per business, in words.
  if (str(d.channelName))
    await finding(tx, scope, {
      code: 'conversations.channel_narrowed',
      category: 'conversations',
      capability: 'needs_review',
      severity: 'info',
      summary: `${d.channelName} threads come across as chats.`,
      whatImports: 'Every message in them, in order, with who said what.',
      whatChanges: `HandsFreeOS has texts, email and chat. A ${d.channelName} thread is kept as a chat, so it is all here and readable, but replying to it from here is not connected to ${d.channelName}.`,
      recommendedAction: `Keep answering ${d.channelName} where you do now.`,
      sourceCapability: 'conversations',
      affected: 1,
      detail: { channel: d.channelName },
    });
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'conversation',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'conversation',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * A chat thread's address: `chat:` and up to 80 characters of letters, digits, dashes and underscores, which
 * is the shape the table insists on. Built from where the thread came from and its own id, so the same source
 * thread always lands on the same one.
 */
const chatAddress = (system: string, sourceId: string): string =>
  `chat:${`${system}-${sourceId}`
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 80)
    .padEnd(8, '0')}`;

/** Text inside an HTML body, so a long message keeps every character of itself and renders as it read. */
const escapeText = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function bodyKept(tx: Tx, scope: ImportScope): Promise<void> {
  await finding(tx, scope, {
    code: 'messages.long_body_kept',
    category: 'messages',
    capability: 'needs_review',
    severity: 'info',
    summary: 'Some messages were longer than a message here holds.',
    whatImports: 'All of them, every character.',
    whatChanges:
      'The timeline shows the first 10,000 characters and the rest opens with the message, rather than the end being cut off.',
    sourceCapability: 'messages',
    affected: 1,
  });
}

/** The thread a message or a call belongs to, and the customer on it. */
async function parentConversation(
  tx: Tx,
  scope: ImportScope,
  envelope: CanonicalEnvelope,
): Promise<{ id: string; personId: string | null } | null> {
  const ref = envelope.relationships.find((r) => r.role === 'conversation');
  if (!ref) return null;
  const mapped = await existingMapping(tx, scope, ref.objectType, ref.objectId);
  if (!mapped || mapped.targetType !== 'conversation') return null;
  const [row] = await rows<{ person_id: string | null }>(
    tx,
    sql`select person_id::text as person_id from app.conversations where id = ${mapped.targetId}::uuid`,
  );
  return { id: mapped.targetId, personId: row?.person_id ?? null };
}

export const importMessage: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    channel?: string;
    direction?: string;
    status?: string;
    subject?: string | null;
    body?: string | null;
    bodyHtml?: string | null;
    fromAddress?: string | null;
    toAddresses?: string[];
    occurredAt?: string;
    media?: {
      url: string;
      name?: string | null;
      mime?: string | null;
      sizeBytes?: number | null;
    }[];
    providerMessageId?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const parent = await parentConversation(tx, scope, envelope);
  if (!parent) {
    // The thread has not landed yet. Retryable on purpose: the children pass runs after the records pass, so
    // this means something genuinely went wrong with the conversation rather than that it is merely later.
    await quarantine(tx, scope, {
      category: 'messages',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'message_without_conversation',
      message: `The conversation this message belongs to is not here (${
        envelope.relationships.find((r) => r.role === 'conversation')?.objectId ?? 'no thread named'
      }).`,
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }
  const channel = d.channel === 'sms' || d.channel === 'email' ? d.channel : 'chat';
  const direction = d.direction === 'inbound' ? 'inbound' : 'outbound';
  const occurredAt = d.occurredAt ?? envelope.source.sourceCreatedAt ?? null;
  // The table's own rule, and it is the right one: a message the customer sent is `received` and a message
  // the business sent never is. Whatever the old system called it, the direction decides.
  const status =
    direction === 'inbound'
      ? 'received'
      : d.status && d.status !== 'received'
        ? d.status
        : 'delivered';
  /**
   * A body longer than the column holds keeps all of itself: the first 10,000 characters where the timeline
   * reads them, and the whole thing in the HTML body, which has no limit. A long marketing email is the
   * common case and truncating it silently would be the wrong kind of quiet.
   */
  const body = str(d.body);
  const tooLong = body !== null && body.length > 10_000;
  const bodyHtml = str(d.bodyHtml) ?? (tooLong ? `<pre>${escapeText(body!)}</pre>` : null);
  if (tooLong) await bodyKept(tx, scope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.messages (id, workspace_id, conversation_id, channel, direction, status,
      from_address, to_addresses, subject, body_text, body_html, media, provider, provider_message_id,
      dedupe_key, occurred_at, sent_at, delivered_at, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${parent.id}::uuid, ${channel}::app.channel,
      ${direction}::app.direction, ${status}::app.message_status,
      ${str(d.fromAddress)}, ${textArray(d.toAddresses ?? [])}, ${str(d.subject)?.slice(0, 998) ?? null},
      ${tooLong ? body!.slice(0, 10_000) : body}, ${bodyHtml},
      -- Empty on purpose, and filled in by the copier. What the old system hands over here is a link to
      -- its own storage: it needs its own sign-in, and it dies the day the account is cancelled. A photo
      -- in the timeline has to be a photo we hold, so the bytes are fetched and this is rewritten to point
      -- at our copy. Until then the message is its words, which is better than a broken picture.
      '[]'::jsonb,
      ${scope.sourceSystem}, ${str(d.providerMessageId)},
      -- The source's own id, so the same message cannot land twice even if an import is replayed.
      ${`${scope.sourceSystem}:${envelope.source.objectId}`},
      coalesce(${occurredAt}::timestamptz, now()),
      ${direction === 'outbound' ? occurredAt : null}::timestamptz,
      ${direction === 'outbound' && status === 'delivered' ? occurredAt : null}::timestamptz,
      coalesce(${occurredAt}::timestamptz, now()),
      coalesce(${occurredAt}::timestamptz, now()))
    on conflict (workspace_id, dedupe_key) where dedupe_key is not null do nothing`);
  // The thread's own summary follows its newest message, the way it would have if it had happened here.
  await tx.execute(sql`
    update app.conversations set
      last_message_at = greatest(coalesce(last_message_at, ${occurredAt}::timestamptz), ${occurredAt}::timestamptz),
      last_direction = case when coalesce(last_message_at, 'epoch'::timestamptz) <= ${occurredAt}::timestamptz
        then ${direction}::app.direction else last_direction end,
      last_preview = case when coalesce(last_message_at, 'epoch'::timestamptz) <= ${occurredAt}::timestamptz
        then ${str(d.body)?.slice(0, 200) ?? null} else last_preview end,
      last_inbound_at = case when ${direction} = 'inbound'
        then greatest(coalesce(last_inbound_at, ${occurredAt}::timestamptz), ${occurredAt}::timestamptz)
        else last_inbound_at end,
      last_outbound_at = case when ${direction} = 'outbound'
        then greatest(coalesce(last_outbound_at, ${occurredAt}::timestamptz), ${occurredAt}::timestamptz)
        else last_outbound_at end
    where id = ${parent.id}::uuid`);
  for (const file of (d.media ?? []).slice(0, 20))
    await queueMedia(tx, scope, {
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      locator: file.url,
      fileName: file.name,
      declaredMime: file.mime,
      sizeBytes: file.sizeBytes,
    });
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'message',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'message',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * Lists one file for the copier, while the link the old system gave us still works.
 *
 * Nothing is fetched here. An importer runs inside the transaction that writes the record, and a slow
 * download inside that transaction would hold a lock open for as long as a phone line is bad. The row is the
 * whole job: where the file was, what the old system said it is, and which record will point at it once the
 * bytes are here.
 */
async function queueMedia(
  tx: Tx,
  scope: ImportScope,
  input: {
    sourceObjectType: string;
    sourceObjectId: string;
    locator: string;
    fileName?: string | null;
    declaredMime?: string | null;
    sizeBytes?: number | null;
  },
): Promise<void> {
  const locator = input.locator.trim();
  if (!locator || locator.length > 4000) return;
  await tx.execute(sql`
    insert into app.migration_media (migration_id, organization_id, scope_id, workspace_id,
      source_object_type, source_object_id, source_locator, file_name, declared_mime, size_bytes, state)
    values (${scope.migrationId}::uuid, ${scope.organizationId}::uuid, ${scope.scopeId}::uuid,
      ${scope.workspaceId}::uuid, ${input.sourceObjectType}, ${input.sourceObjectId},
      ${locator}, ${str(input.fileName)?.slice(0, 300) ?? null},
      ${str(input.declaredMime)?.slice(0, 200) ?? null}, ${input.sizeBytes ?? null}, 'pending')
    on conflict (scope_id, source_object_type, source_object_id, md5(source_locator)) do nothing`);
}

export const importCall: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    direction?: string;
    status?: string;
    fromNumber?: string | null;
    toNumber?: string | null;
    startedAt?: string;
    answeredAt?: string | null;
    endedAt?: string | null;
    durationSeconds?: number | null;
    isVoicemail?: boolean;
    recordingUrl?: string | null;
    recordingSeconds?: number | null;
    transcript?: string | null;
    providerCallId?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const parent = await parentConversation(tx, scope, envelope);
  const startedAt = d.startedAt ?? envelope.source.sourceCreatedAt ?? null;
  const id = randomUUID();
  /**
   * No `provider_sid`, on purpose. That column is unique across the whole database because it holds a
   * carrier's own id, and an imported call has no carrier. Writing the old system's id into it looked tidy
   * and was a trap: the same GoHighLevel account brought into a second business here — a throwaway import
   * first and the real one after, which is exactly what we tell people to do — collided on it, and
   * `on conflict do nothing` meant every call was reported as imported while none of them were written.
   * What the call came from is recorded where the rest of the milestone records it: the source mapping below.
   */
  await tx.execute(sql`
    insert into app.calls (id, workspace_id, conversation_id, person_id, direction, from_e164, to_e164,
      provider_sid, status, started_at, answered_at, ended_at, duration_seconds, is_voicemail,
      recording_seconds, transcript, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${parent?.id ?? null}::uuid,
      ${parent?.personId ?? null}::uuid, ${d.direction === 'inbound' ? 'inbound' : 'outbound'}::app.direction,
      ${normalizePhone(str(d.fromNumber), scope.defaultCountry as never) ?? str(d.fromNumber)},
      ${normalizePhone(str(d.toNumber), scope.defaultCountry as never) ?? str(d.toNumber)},
      null, ${d.status ?? 'completed'}::app.call_status,
      coalesce(${startedAt}::timestamptz, now()), ${d.answeredAt ?? null}::timestamptz,
      ${d.endedAt ?? null}::timestamptz, ${d.durationSeconds ?? null},
      ${d.isVoicemail === true}, ${d.recordingSeconds ?? null}, ${str(d.transcript)?.slice(0, 10_000) ?? null},
      coalesce(${startedAt}::timestamptz, now()), coalesce(${startedAt}::timestamptz, now()))`);
  const targetId = id;
  // The recording itself is a file, and files are copied by the engine rather than by an importer: it is
  // listed here so the copier fetches it while the source link still works.
  if (str(d.recordingUrl))
    await queueMedia(tx, scope, {
      sourceObjectType: 'call',
      sourceObjectId: envelope.source.objectId,
      locator: str(d.recordingUrl)!,
      fileName: 'recording.mp3',
      declaredMime: 'audio/mpeg',
    });
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'call',
    targetId,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'call',
    targetId,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- pipelines and leads ----------

/**
 * A pipeline, its stages, and the meaning HandsFreeOS needs them to have.
 *
 * The gap worth understanding: over there a stage is only a column and the *deal* says whether it was won;
 * here the *stage* says it, so that a board column means something and "won this month" is answerable. So a
 * stage's kind is read from its name, and a pipeline that ends up without a won or a lost stage is given one.
 * Without that a business could never mark another deal won in the pipeline it just brought across, which is
 * a worse outcome than an extra column.
 */
export const importPipeline: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    position?: number;
    stages?: { name: string; kind: string; position: number; sourceId?: string | null }[];
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  let name = (str(d.name) ?? 'Pipeline').slice(0, 80);
  const { createdAt, updatedAt } = sourceTimes(envelope);
  /**
   * Every new business here starts with a pipeline called Sales and some stages nobody chose, and the old
   * system's pipeline is very often called Sales too. The old board comes across under its own name when that
   * happens, rather than being mixed into the one already here.
   *
   * Taking over the starter board instead was the first attempt, and the database was right to refuse it: its
   * stages are already pointed at by other things a business has set up (where a new enquiry lands, for one),
   * so they cannot simply be swapped out from underneath. Two boards a person can tidy up beats one board
   * whose columns are half somebody else's.
   */
  const [existing] = await rows<{ id: string }>(
    tx,
    sql`select id::text as id from app.pipelines
        where workspace_id = ${scope.workspaceId} and lower(name) = ${name.toLowerCase()}
          and archived_at is null limit 1`,
  );
  if (existing) {
    const beside = `${name.slice(0, 55)} (from the old system)`;
    await finding(tx, scope, {
      code: 'pipelines.named_beside',
      category: 'pipelines',
      capability: 'needs_review',
      severity: 'info',
      summary: `You already have a pipeline called “${name}”, so theirs came across as “${beside}”.`,
      whatImports: 'Every stage and every deal from the old system’s pipeline.',
      whatChanges:
        'The two boards stay separate: mixing their columns into yours would move work into stages you did not choose, and the stages you already have are pointed at by other settings.',
      recommendedAction:
        'If the board here was the empty one HandsFreeOS made for you, delete it and rename theirs.',
      sourceCapability: 'pipelines',
      affected: 1,
      detail: { yours: name, theirs: beside },
    });
    name = beside;
  }
  const pipelineId = randomUUID();
  await tx.execute(sql`
    insert into app.pipelines (id, workspace_id, name, position, created_at, updated_at)
    values (${pipelineId}::uuid, ${scope.workspaceId}, ${name},
      ${Math.max(0, Math.min(1000, Number(d.position ?? 0) || 0))},
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);

  // The stages, in the order they were in, with names that cannot collide.
  const wanted = (d.stages ?? []).slice(0, 100);
  const seen = new Set<string>();
  const stages: { name: string; kind: string; position: number; sourceId: string | null }[] = [];
  for (const [i, st] of wanted.entries()) {
    let stageName = (str(st.name) ?? `Stage ${i + 1}`).slice(0, 60);
    if (seen.has(stageName.toLowerCase())) stageName = `${stageName.slice(0, 56)} ${i + 1}`.trim();
    seen.add(stageName.toLowerCase());
    stages.push({
      name: stageName,
      kind: st.kind === 'won' || st.kind === 'lost' ? st.kind : 'open',
      position: Number(st.position ?? i) || i,
      sourceId: st.sourceId ?? null,
    });
  }
  // Every pipeline needs somewhere to win and somewhere to lose, or the schema will not let the business
  // change a stage's meaning later and nothing can ever be marked won.
  const added: string[] = [];
  for (const kind of ['won', 'lost'] as const)
    if (!stages.some((st) => st.kind === kind) && !seen.has(kind)) {
      stages.push({
        name: kind === 'won' ? 'Won' : 'Lost',
        kind,
        position: stages.length,
        sourceId: null,
      });
      added.push(kind === 'won' ? 'Won' : 'Lost');
    }
  if (!stages.some((st) => st.kind === 'open') && stages.length > 0)
    // Everything read as won or lost: the first one is where work starts, whatever it is called.
    stages[0] = { ...stages[0]!, kind: 'open' };

  for (const [i, st] of stages.entries()) {
    const stageId = randomUUID();
    await tx.execute(sql`
      insert into app.pipeline_stages (id, workspace_id, pipeline_id, name, kind, position,
        created_at, updated_at)
      values (${stageId}::uuid, ${scope.workspaceId}, ${pipelineId}::uuid, ${st.name},
        ${st.kind}::app.stage_kind, ${i},
        coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
        coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
    // No `on conflict` here, deliberately: a stage's position is unique *deferrably*, and Postgres refuses a
    // deferrable constraint as a conflict arbiter (55000). The pipeline is new and the positions are counted
    // from zero, so there is nothing to conflict with — and the names were made unique before the loop.
    // A deal knows the stage it was in by the old system's id, so each one is mapped on its own.
    if (st.sourceId) {
      const [landed] = await rows<{ id: string }>(
        tx,
        sql`select id::text as id from app.pipeline_stages
            where pipeline_id = ${pipelineId}::uuid and lower(name) = ${st.name.toLowerCase()} limit 1`,
      );
      await putMapping(tx, scope, {
        sourceObjectType: 'pipeline_stage',
        sourceObjectId: st.sourceId,
        targetType: 'pipeline_stage',
        targetId: landed?.id ?? stageId,
        createdHere: true,
      });
    }
  }
  if (added.length > 0)
    await finding(tx, scope, {
      code: 'pipelines.stage_added',
      category: 'pipelines',
      capability: 'needs_review',
      severity: 'info',
      summary: `“${name}” needed ${added.join(' and ')} ${added.length === 1 ? 'stage' : 'stages'}, and now has ${added.length === 1 ? 'one' : 'them'}.`,
      whatImports: 'Your stages, in the order you had them.',
      whatChanges:
        'HandsFreeOS says what winning and losing mean with the stage itself, so a board column means something and "won this month" can be answered. The old system said it on the deal instead, so anything that read as neither got an extra column here.',
      recommendedAction: 'Rename them to whatever you call winning and losing.',
      sourceCapability: 'pipelines',
      affected: added.length,
      detail: { pipeline: name, added },
    });
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'pipeline',
    targetId: pipelineId,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'pipeline',
    targetId: pipelineId,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/** A deal. Its stage is the one it was in; won and lost land where winning and losing live here. */
export const importLead: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    title?: string;
    valueCents?: number;
    status?: string;
    source?: string | null;
    sourceStageId?: string | null;
    expectedCloseOn?: string | null;
    stageEnteredAt?: string | null;
    closedAt?: string | null;
    lostReason?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const pipelineRef = envelope.relationships.find((r) => r.role === 'pipeline');
  const pipeline = pipelineRef
    ? await existingMapping(tx, scope, pipelineRef.objectType, pipelineRef.objectId)
    : null;
  if (!pipeline || pipeline.targetType !== 'pipeline') {
    await quarantine(tx, scope, {
      category: 'opportunities',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'lead_without_pipeline',
      message: `The pipeline this lead belongs to is not here (${pipelineRef?.objectId ?? 'none named'}).`,
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  // A lead has to belong to somebody: the schema says a person or a company, and it is right to.
  const contactRef = envelope.relationships.find((r) => r.role === 'contact');
  const person = contactRef
    ? await existingMapping(tx, scope, contactRef.objectType, contactRef.objectId)
    : null;
  const personId = person?.targetType === 'person' ? person.targetId : null;
  if (!personId) {
    await quarantine(tx, scope, {
      category: 'opportunities',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'lead_without_customer',
      message: 'A lead with no customer behind it cannot be placed here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  /**
   * Which stage it lands in. A deal that is still open keeps the stage it was in; one that was won or lost
   * goes where winning and losing live here, because that is where the status comes from. `abandoned` over
   * there is lost here, said in the reason rather than silently rounded to it.
   */
  const status = d.status ?? 'open';
  const wantKind = status === 'won' ? 'won' : status === 'open' ? 'open' : 'lost';
  const sourceStage =
    status === 'open' && d.sourceStageId
      ? await existingMapping(tx, scope, 'pipeline_stage', d.sourceStageId)
      : null;
  let stageId = sourceStage?.targetType === 'pipeline_stage' ? sourceStage.targetId : null;
  if (stageId) {
    // Only if it really is a stage of this pipeline; a stage id from another pipeline would be refused.
    const [ok] = await rows<{ id: string }>(
      tx,
      sql`select id::text as id from app.pipeline_stages
          where id = ${stageId}::uuid and pipeline_id = ${pipeline.targetId}::uuid limit 1`,
    );
    if (!ok) stageId = null;
  }
  if (!stageId) {
    const [byKind] = await rows<{ id: string }>(
      tx,
      sql`select id::text as id from app.pipeline_stages
          where pipeline_id = ${pipeline.targetId}::uuid and kind = ${wantKind}::app.stage_kind
          order by position limit 1`,
    );
    stageId = byKind?.id ?? null;
  }
  if (!stageId) {
    await quarantine(tx, scope, {
      category: 'opportunities',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'mapping',
      code: 'lead_without_stage',
      message: 'The pipeline this lead belongs to has no stage it could go in.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  const ownerRef = envelope.relationships.find((r) => r.role === 'owner');
  const owner = ownerRef
    ? await existingMapping(tx, scope, ownerRef.objectType, ownerRef.objectId)
    : null;
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const closedAt = d.closedAt ?? updatedAt?.toISOString() ?? null;
  const lostReason =
    wantKind === 'lost'
      ? (str(d.lostReason)?.slice(0, 300) ??
        (status === 'abandoned'
          ? 'Abandoned in the old system.'
          : 'Marked lost in the old system, with no reason recorded.'))
      : null;
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.leads (id, workspace_id, pipeline_id, stage_id, person_id, title, value_cents,
      source, assignee_user_id, expected_close_on, lost_reason, stage_entered_at, won_at, lost_at,
      created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${pipeline.targetId}::uuid, ${stageId}::uuid,
      ${personId}::uuid, ${(str(d.title) ?? 'Lead').slice(0, 160)},
      ${Math.max(0, Math.round(Number(d.valueCents ?? 0)))}, ${str(d.source)},
      ${owner?.targetType === 'user' ? owner.targetId : null}::uuid,
      ${str(d.expectedCloseOn)}::date, ${lostReason},
      -- The moments the old system recorded. 0072 lets the worker keep them; a person's own leads are still
      -- stamped by the database.
      coalesce(${d.stageEnteredAt ?? null}::timestamptz, ${createdAt?.toISOString() ?? null}::timestamptz),
      ${wantKind === 'won' ? closedAt : null}::timestamptz,
      ${wantKind === 'lost' ? closedAt : null}::timestamptz,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'lead',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'lead',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- calendars and the visits on them ----------

/**
 * A calendar, as a draft.
 *
 * What comes across is what means the same thing on both sides: its name, what it is for, how long a visit is
 * and which time zone it is in. What does not is everything that decides *when somebody can book* — hours,
 * buffers, round-robin, notice periods, how far ahead, what a customer is asked. Those are said in ways that
 * do not translate, and a guess at them is worse than a gap: it would take bookings at hours nobody works.
 *
 * So the calendar arrives with its visits on it and its public page switched off, and the business turns it on
 * once its hours are set. The finding says exactly that, because a draft calendar with no explanation looks
 * like something that failed.
 */
const calendarSlug = (name: string, fallback: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return /^[a-z0-9]/.test(slug)
    ? slug
    : `calendar-${fallback
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 20)}`;
};

export const importCalendar: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    description?: string | null;
    timezone?: string | null;
    minutes?: number;
    active?: boolean;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const name = (str(d.name) ?? 'Calendar').slice(0, 120);
  const { createdAt, updatedAt } = sourceTimes(envelope);
  // The slug is part of a public address, so a clash gets a suffix rather than failing the import.
  let slug = calendarSlug(name, envelope.source.objectId);
  for (let i = 2; i < 50; i++) {
    const [taken] = await rows<{ id: string }>(
      tx,
      sql`select id::text as id from app.calendars
          where workspace_id = ${scope.workspaceId} and slug = ${slug} limit 1`,
    );
    if (!taken) break;
    slug = `${calendarSlug(name, envelope.source.objectId).slice(0, 56)}-${i}`;
  }
  const minutes = Math.max(1, Math.min(1440, Number(d.minutes ?? 60) || 60));
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.calendars (id, workspace_id, name, description, slug, status, public, config,
      timezone, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${name}, ${str(d.description)}, ${slug},
      -- A draft, and not public: its hours are not set here yet, and a calendar that took bookings at hours
      -- nobody works would be worse than one nobody can book yet.
      'draft'::app.calendar_status, false,
      ${JSON.stringify({ visit: { minutes }, importedFrom: scope.sourceSystem })}::jsonb,
      ${str(d.timezone)},
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await finding(tx, scope, {
    code: 'calendars.hours_not_brought',
    category: 'calendars',
    capability: 'needs_review',
    severity: 'action',
    summary: `“${name}” came across with its visits, and it is switched off until you set its hours.`,
    whatImports: 'The calendar, how long a visit is, and every visit that was booked on it.',
    whatChanges:
      'When people can book — your hours, how much notice you need, how far ahead, who it goes to, what a customer is asked — is said differently in the two systems, and guessing would take bookings at hours nobody works. So nothing is guessed.',
    recommendedAction: `Open ${name} in Calendar, set your hours, and turn it on.`,
    sourceCapability: 'calendars',
    affected: 1,
    detail: { calendar: name, visitMinutes: minutes },
  });
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'calendar',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'calendar',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * A visit, where it was in the diary.
 *
 * **Nothing is reminded about.** A reminder here is armed by the act of booking, so a visit written in as a row
 * arms nothing — which is the behaviour a migration wants and worth stating because it is an absence rather
 * than a line of code. Tomorrow's visit is in the diary on the morning they move in, and the old system is
 * still the one texting about it until they switch that off. The finding on the calendar says so.
 */
export const importAppointment: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    title?: string;
    startsAt?: string;
    endsAt?: string;
    status?: string;
    notes?: string | null;
    where?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const ref = envelope.relationships.find((r) => r.role === 'calendar');
  const calendar = ref ? await existingMapping(tx, scope, ref.objectType, ref.objectId) : null;
  if (!calendar || calendar.targetType !== 'calendar') {
    await quarantine(tx, scope, {
      category: 'appointments',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'appointment_without_calendar',
      message: `The calendar this visit was on is not here (${ref?.objectId ?? 'none named'}).`,
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }
  const [cal] = await rows<{ revision: number }>(
    tx,
    sql`select revision from app.calendars where id = ${calendar.targetId}::uuid`,
  );

  const ownerRef = envelope.relationships.find((r) => r.role === 'owner');
  const owner = ownerRef
    ? await existingMapping(tx, scope, ownerRef.objectType, ownerRef.objectId)
    : null;
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.appointments (id, workspace_id, calendar_id, calendar_revision, kind, title,
      starts_at, ends_at, status, location, owner_user_id, source, notes, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${calendar.targetId}::uuid, ${cal?.revision ?? 1},
      'booking'::app.appointment_kind, ${(str(d.title) ?? 'Visit').slice(0, 200)},
      ${d.startsAt}::timestamptz, ${d.endsAt}::timestamptz,
      ${d.status ?? 'scheduled'}::app.appointment_status,
      ${JSON.stringify(str(d.where) ? { address: str(d.where) } : {})}::jsonb,
      ${owner?.targetType === 'user' ? owner.targetId : null}::uuid,
      'staff'::app.appointment_source, ${str(d.notes)},
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);

  // The customer who was coming. Their contact details are the booking's own copy, exactly as a booking made
  // here keeps them, and `sms_ok` stays false: consent to be texted about this visit was given over there,
  // to them, and is not ours to assume.
  const contactRef = envelope.relationships.find((r) => r.role === 'contact');
  const person = contactRef
    ? await existingMapping(tx, scope, contactRef.objectType, contactRef.objectId)
    : null;
  if (person?.targetType === 'person')
    await tx.execute(sql`
      insert into app.appointment_attendees (workspace_id, appointment_id, person_id, status, seats,
        source, created_at, updated_at)
      values (${scope.workspaceId}, ${id}::uuid, ${person.targetId}::uuid,
        ${d.status === 'cancelled' ? 'cancelled' : d.status === 'no_show' ? 'no_show' : d.status === 'completed' ? 'attended' : 'booked'}::app.attendee_status,
        1, 'staff'::app.appointment_source,
        coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
        coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))
      on conflict (appointment_id, person_id) do nothing`);

  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'appointment',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'appointment',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- what people wrote down, and what they still have to do ----------

/** The customer a task or a note belongs to. Both hang off one over there, and off one here. */
async function ownerAndCustomer(
  tx: Tx,
  scope: ImportScope,
  envelope: CanonicalEnvelope,
): Promise<{ personId: string | null; userId: string | null }> {
  const contactRef = envelope.relationships.find((r) => r.role === 'contact');
  const person = contactRef
    ? await existingMapping(tx, scope, contactRef.objectType, contactRef.objectId)
    : null;
  const ownerRef = envelope.relationships.find((r) => r.role === 'owner');
  const owner = ownerRef
    ? await existingMapping(tx, scope, ownerRef.objectType, ownerRef.objectId)
    : null;
  return {
    personId: person?.targetType === 'person' ? person.targetId : null,
    userId: owner?.targetType === 'user' ? owner.targetId : null,
  };
}

export const importTask: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    title?: string;
    notes?: string | null;
    dueAt?: string | null;
    doneAt?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const { personId, userId } = await ownerAndCustomer(tx, scope, envelope);
  if (!personId) {
    await quarantine(tx, scope, {
      category: 'tasks',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'task_without_customer',
      message: 'The customer this was for is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.tasks (id, workspace_id, title, notes, due_at, all_day, assignee_user_id,
      person_id, done_at, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${(str(d.title) ?? 'Task').slice(0, 200)},
      ${str(d.notes)}, ${d.dueAt ?? null}::timestamptz,
      -- The old system keeps a time of day on a due date; a task here is all-day unless it has one.
      ${d.dueAt ? false : true},
      ${userId}::uuid, ${personId}::uuid, ${d.doneAt ?? null}::timestamptz,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'task',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'task',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * A note, on the customer's own timeline.
 *
 * Written as an activity rather than into the customer's notes field, because that is where HandsFreeOS keeps
 * what somebody wrote and when they wrote it — and the when is the point: five notes across four years read as
 * four years of history, while the same five appended to one field read as a wall of text.
 *
 * `actor_type` is `integration` and never `human`: the database refuses `human` from the worker, and rightly,
 * because the person who wrote this note in the other system may have no account here at all.
 */
export const importNote: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as { body?: string; occurredAt?: string };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const { personId, userId } = await ownerAndCustomer(tx, scope, envelope);
  if (!personId) {
    await quarantine(tx, scope, {
      category: 'tasks',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'note_without_customer',
      message: 'The customer this note was about is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }
  const body = (str(d.body) ?? '').slice(0, 10_000);
  if (!body) return { counts: { skipped: 1 } };
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.activities (id, workspace_id, kind, subtype, person_id, body, occurred_at,
      author_user_id, actor_type, meta, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, 'note'::app.activity_kind, ${scope.sourceSystem},
      ${personId}::uuid, ${body},
      coalesce(${d.occurredAt ?? null}::timestamptz, ${createdAt?.toISOString() ?? null}::timestamptz, now()),
      ${userId}::uuid, 'integration'::app.actor_type,
      ${JSON.stringify({ importedFrom: scope.sourceSystem })}::jsonb,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'activity',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'activity',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- what they sell, and what they billed ----------

export const importProduct: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    description?: string | null;
    unitPriceCents?: number;
    unitLabel?: string;
    taxable?: boolean;
    active?: boolean;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const name = (str(d.name) ?? 'Product').slice(0, 160);
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.products (id, workspace_id, name, description, unit_price_cents, unit_label,
      taxable, archived_at, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${name}, ${str(d.description)},
      ${Math.max(0, Math.round(Number(d.unitPriceCents ?? 0)))},
      ${(str(d.unitLabel) ?? 'each').slice(0, 40)}, ${d.taxable !== false},
      -- Something they had stopped selling stays stopped here, rather than reappearing in the list.
      ${d.active === false ? (updatedAt?.toISOString() ?? new Date().toISOString()) : null}::timestamptz,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'product',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'product',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * A bill, as it stood, and what had been paid against it.
 *
 * Three decisions worth knowing, because each is a place where doing the obvious thing would be wrong:
 *
 * 1. **The totals are the source's, not ours.** A bill that went to a customer says what it said. Recomputing
 *    it from the lines would quietly change history wherever a rounding or tax rule differs by a cent.
 * 2. **What was paid arrives as one payment, taken off the system.** The card payment itself happened in
 *    somebody else's processor: it cannot be refunded from here and must never look as though it could. So it
 *    is recorded as a payment of method `other` with no provider — the invoice balances, the history reads
 *    true, and the refund button has nothing to reach for. The roll-up does the rest.
 * 3. **Nothing is chased.** `reminder_state` is marked quiet, which the worker's arming reads (money/jobs.ts):
 *    the invoice still turns overdue and still shows as owed, and the customer hears nothing from here while
 *    the old system is still sending its own reminders about the same bill.
 */
export const importInvoice: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    number?: string | null;
    title?: string | null;
    notes?: string | null;
    status?: string;
    currency?: string;
    subtotalCents?: number;
    discountCents?: number;
    taxCents?: number;
    totalCents?: number;
    paidCents?: number;
    paidAt?: string | null;
    issuedAt?: string | null;
    dueOn?: string | null;
    terms?: string | null;
    lines?: {
      name: string;
      description?: string | null;
      quantity: number;
      unitLabel: string;
      unitPriceCents: number;
      taxable: boolean;
    }[];
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  // HandsFreeOS holds US dollars and says so rather than storing a number with the wrong sign on it.
  if ((d.currency ?? 'USD').toUpperCase() !== 'USD') {
    await quarantine(tx, scope, {
      category: 'invoices',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'mapping',
      code: 'invoice_not_in_dollars',
      message: `This bill is in ${(d.currency ?? '').toUpperCase()}, and HandsFreeOS holds US dollars today.`,
      retryable: false,
    });
    await finding(tx, scope, {
      code: 'invoices.currency_unsupported',
      category: 'invoices',
      capability: 'not_supported',
      severity: 'action',
      summary: 'Some bills are in a currency HandsFreeOS does not hold yet.',
      whatImports: 'Nothing for those bills; every other one comes across.',
      whatChanges:
        'HandsFreeOS keeps money in US dollars today, and storing another currency as though it were dollars would be worse than not storing it.',
      recommendedAction: 'Keep those in the old system until HandsFreeOS holds your currency.',
      sourceCapability: 'invoices',
      affected: 1,
      detail: { currency: (d.currency ?? '').toUpperCase() },
    });
    return { counts: { failed: 1 } };
  }

  const contactRef = envelope.relationships.find((r) => r.role === 'contact');
  const person = contactRef
    ? await existingMapping(tx, scope, contactRef.objectType, contactRef.objectId)
    : null;
  if (person?.targetType !== 'person') {
    await quarantine(tx, scope, {
      category: 'invoices',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'invoice_without_customer',
      message: 'The customer this bill was for is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  const status = d.status ?? 'sent';
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const issuedAt = d.issuedAt ?? createdAt?.toISOString() ?? null;
  // A number and a sent date are one fact in this schema: a bill has both or neither.
  const number = status === 'draft' ? null : (str(d.number)?.slice(0, 40) ?? null);
  const sentAt = number ? (issuedAt ?? new Date().toISOString()) : null;
  const total = Math.max(0, Math.round(Number(d.totalCents ?? 0)));
  const paid = Math.min(Math.max(0, Math.round(Number(d.paidCents ?? 0))), total);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.invoices (id, workspace_id, number, status, person_id, title, notes, purpose, origin,
      subtotal_cents, discount_cents, taxable_base_cents, tax_cents, total_cents, currency, due_on, terms,
      sent_at, paid_at, reminder_state, voided_at, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${number},
      -- Paid and partly-paid are the roll-up's to decide from the payment below; this is where it starts.
      ${status === 'draft' ? 'draft' : status === 'void' ? 'void' : 'sent'}::app.invoice_status,
      ${person.targetId}::uuid, ${str(d.title)}, ${str(d.notes)},
      'standard'::app.invoice_purpose, 'staff'::app.money_origin,
      ${Math.max(0, Math.round(Number(d.subtotalCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.discountCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.subtotalCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.taxCents ?? 0)))}, ${total}, 'USD',
      ${str(d.dueOn)}::date, ${str(d.terms)}, ${sentAt}::timestamptz,
      ${status === 'paid' && paid >= total && total > 0 ? (d.paidAt ?? updatedAt?.toISOString() ?? null) : null}::timestamptz,
      ${JSON.stringify({ imported: 'quiet', from: scope.sourceSystem })}::jsonb,
      ${status === 'void' ? (updatedAt?.toISOString() ?? new Date().toISOString()) : null}::timestamptz,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);

  for (const [i, line] of (d.lines ?? []).slice(0, 200).entries()) {
    const unit = Math.max(0, Math.round(Number(line.unitPriceCents ?? 0)));
    const quantity = Math.max(0.001, Number(line.quantity ?? 1) || 1);
    await tx.execute(sql`
      insert into app.invoice_lines (workspace_id, invoice_id, position, name, description, quantity,
        unit_label, unit_price_cents, taxable, amount_cents, created_at, updated_at)
      values (${scope.workspaceId}, ${id}::uuid, ${i}, ${(str(line.name) ?? 'Item').slice(0, 200)},
        ${str(line.description)}, ${quantity}, ${(str(line.unitLabel) ?? 'each').slice(0, 40)},
        ${unit}, ${line.taxable !== false}, ${Math.round(unit * quantity)},
        coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
        coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  }

  if (paid > 0 && status !== 'draft' && status !== 'void')
    await tx.execute(sql`
      insert into app.payments (workspace_id, invoice_id, amount_cents, currency, method, status,
        received_at, created_at, updated_at)
      values (${scope.workspaceId}, ${id}::uuid, ${paid}, 'USD', 'other'::app.payment_method,
        'succeeded'::app.payment_status,
        coalesce(${d.paidAt ?? null}::timestamptz, ${updatedAt?.toISOString() ?? null}::timestamptz, now()),
        coalesce(${d.paidAt ?? null}::timestamptz, ${createdAt?.toISOString() ?? null}::timestamptz, now()),
        coalesce(${d.paidAt ?? null}::timestamptz, ${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);

  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'invoice',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'invoice',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * A quote, and what the customer did about it.
 *
 * Quiet like a bill, and for the same reason: the nudge a few days after it went out and the warning before it
 * expires are both messages to the customer, and the old system is still sending its own. The estimate still
 * expires, still shows as out, still reaches whoever is looking — only the messages stop.
 */
export const importEstimate: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    number?: string | null;
    title?: string | null;
    notes?: string | null;
    status?: string;
    currency?: string;
    subtotalCents?: number;
    discountCents?: number;
    taxCents?: number;
    totalCents?: number;
    issuedAt?: string | null;
    expiresOn?: string | null;
    answeredAt?: string | null;
    acceptedName?: string | null;
    declinedReason?: string | null;
    lines?: {
      name: string;
      description?: string | null;
      quantity: number;
      unitLabel: string;
      unitPriceCents: number;
      taxable: boolean;
    }[];
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  if ((d.currency ?? 'USD').toUpperCase() !== 'USD') {
    await quarantine(tx, scope, {
      category: 'estimates',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'mapping',
      code: 'estimate_not_in_dollars',
      message: `This quote is in ${(d.currency ?? '').toUpperCase()}, and HandsFreeOS holds US dollars today.`,
      retryable: false,
    });
    return { counts: { failed: 1 } };
  }

  const contactRef = envelope.relationships.find((r) => r.role === 'contact');
  const person = contactRef
    ? await existingMapping(tx, scope, contactRef.objectType, contactRef.objectId)
    : null;
  if (person?.targetType !== 'person') {
    await quarantine(tx, scope, {
      category: 'estimates',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'estimate_without_customer',
      message: 'The customer this quote was for is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  const status = d.status ?? 'sent';
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const issuedAt = d.issuedAt ?? createdAt?.toISOString() ?? null;
  const number = status === 'draft' ? null : (str(d.number)?.slice(0, 40) ?? null);
  const sentAt = number ? (issuedAt ?? new Date().toISOString()) : null;
  const answeredAt = d.answeredAt ?? updatedAt?.toISOString() ?? new Date().toISOString();
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.estimates (id, workspace_id, number, status, person_id, title, notes,
      subtotal_cents, discount_cents, taxable_base_cents, tax_cents, total_cents, currency, expires_on,
      sent_at, accepted_at, accepted_via, accepted_name, declined_at, declined_reason, voided_at,
      reminder_state, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${number}, ${status}::app.estimate_status,
      ${person.targetId}::uuid, ${str(d.title)}, ${str(d.notes)},
      ${Math.max(0, Math.round(Number(d.subtotalCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.discountCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.subtotalCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.taxCents ?? 0)))},
      ${Math.max(0, Math.round(Number(d.totalCents ?? 0)))}, 'USD',
      ${str(d.expiresOn)}::date, ${sentAt}::timestamptz,
      -- Accepted over there, and recorded here as a yes somebody took rather than a signature we can show:
      -- the Accept button and its typed name never happened in HandsFreeOS, so claiming they did would be a
      -- lie in the one record a business would show a customer.
      ${status === 'accepted' ? answeredAt : null}::timestamptz,
      ${status === 'accepted' ? 'staff' : null},
      ${status === 'accepted' ? (str(d.acceptedName)?.slice(0, 120) ?? 'Accepted in the old system') : null},
      ${status === 'declined' ? answeredAt : null}::timestamptz,
      ${status === 'declined' ? (str(d.declinedReason)?.slice(0, 1000) ?? 'Declined in the old system.') : null},
      ${status === 'void' ? (updatedAt?.toISOString() ?? new Date().toISOString()) : null}::timestamptz,
      ${JSON.stringify({ imported: 'quiet', from: scope.sourceSystem })}::jsonb,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);

  for (const [i, line] of (d.lines ?? []).slice(0, 200).entries()) {
    const unit = Math.max(0, Math.round(Number(line.unitPriceCents ?? 0)));
    const quantity = Math.max(0.001, Number(line.quantity ?? 1) || 1);
    await tx.execute(sql`
      insert into app.estimate_lines (workspace_id, estimate_id, position, name, description, quantity,
        unit_label, unit_price_cents, taxable, amount_cents, created_at, updated_at)
      values (${scope.workspaceId}, ${id}::uuid, ${i}, ${(str(line.name) ?? 'Item').slice(0, 200)},
        ${str(line.description)}, ${quantity}, ${(str(line.unitLabel) ?? 'each').slice(0, 40)},
        ${unit}, ${line.taxable !== false}, ${Math.round(unit * quantity)},
        coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
        coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  }

  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'estimate',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'estimate',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/**
 * A customer's recurring plan, as a record of what they are on — and never as something HandsFreeOS bills.
 *
 * `unmanaged` is already the word for this in the schema: a plan still charging at a processor we do not
 * drive. The cycle arming only ever looks at `active` and `past_due`, so an imported plan cannot raise an
 * invoice or take a payment, which is the only acceptable behaviour when the card and the mandate live in
 * somebody else's system. Moving the billing is a deliberate act, done later, by a person.
 */
export const importSubscription: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    planName?: string;
    priceCents?: number;
    interval?: string;
    intervalCount?: number;
    status?: string;
    startedOn?: string | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
    nextBillingOn?: string | null;
    cancelledAt?: string | null;
    externalId?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const contactRef = envelope.relationships.find((r) => r.role === 'contact');
  const person = contactRef
    ? await existingMapping(tx, scope, contactRef.objectType, contactRef.objectId)
    : null;
  if (person?.targetType !== 'person') {
    await quarantine(tx, scope, {
      category: 'subscriptions',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'subscription_without_customer',
      message: 'The customer on this plan is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  const { createdAt, updatedAt } = sourceTimes(envelope);
  const cancelled = d.status === 'cancelled';
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.subscriptions (id, workspace_id, plan_name, price_cents, currency, interval,
      interval_count, person_id, external_subscription_id, status, started_on, current_period_start,
      current_period_end, next_billing_on, cancelled_at, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${(str(d.planName) ?? 'Plan').slice(0, 160)},
      ${Math.max(0, Math.round(Number(d.priceCents ?? 0)))}, 'USD',
      ${d.interval ?? 'month'}::app.plan_interval,
      ${Math.max(1, Math.min(36, Number(d.intervalCount ?? 1) || 1))}, ${person.targetId}::uuid,
      ${str(d.externalId)?.slice(0, 200) ?? null},
      -- Cancelled stays cancelled; anything still running is "not managed here", which is the truth: it is
      -- billing at the old system's processor and nothing in HandsFreeOS will charge it.
      ${cancelled ? 'cancelled' : 'unmanaged'}::app.subscription_status,
      ${str(d.startedOn)}::date, ${str(d.currentPeriodStart)}::date, ${str(d.currentPeriodEnd)}::date,
      ${cancelled ? null : (str(d.nextBillingOn) ?? null)}::date,
      ${cancelled ? (d.cancelledAt ?? updatedAt?.toISOString() ?? new Date().toISOString()) : null}::timestamptz,
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  if (!cancelled)
    await finding(tx, scope, {
      code: 'subscriptions.billed_elsewhere',
      category: 'subscriptions',
      capability: 'action_required',
      severity: 'action',
      summary:
        'Your customers on recurring plans came across, and their money still moves where it does now.',
      whatImports: 'Who is on what, at what price, and where they are in the cycle.',
      whatChanges:
        'The card and the agreement behind a plan live at the old system’s payment account, and nothing here can charge them — so these are marked "not managed here" and HandsFreeOS bills nobody.',
      recommendedAction:
        'When you are ready, set each plan up here and cancel it over there, so it is charged once and by one system.',
      sourceCapability: 'subscriptions',
      affected: 1,
      detail: { plan: str(d.planName) ?? 'Plan' },
    });
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'subscription',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'subscription',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- the wording they reuse ----------

/**
 * A saved piece of wording, brought across.
 *
 * The last thing a business loses by leaving another CRM, and the one it notices last: nobody misses the
 * quote follow-up until the week they need it. It could not come across at all until there was a shelf to
 * put it on, and now there is.
 */
export const importTemplate: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    channel?: string;
    subject?: string | null;
    body?: string;
    folder?: string | null;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const body = str(d.body);
  if (!body) {
    // Named and nothing else. Recorded where the business can see it, rather than becoming an empty card
    // in the picker that somebody clicks once and never trusts again.
    await quarantine(tx, scope, {
      category: 'templates',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'mapping',
      code: 'template_has_no_words',
      message: `"${str(d.name) ?? 'A template'}" is listed over there but its words did not come with it.`,
      retryable: false,
    });
    return { counts: { failed: 1 } };
  }

  const channel = d.channel === 'sms' ? 'sms' : 'email';
  const wanted = (str(d.name) ?? 'Template').slice(0, 120);
  /**
   * Two templates cannot share a name here, and over there they can. The second one keeps its own words
   * under a name that says where it came from, rather than overwriting the first or being dropped.
   */
  let name = wanted;
  for (let attempt = 2; attempt <= 20; attempt++) {
    const [taken] = await rows<{ id: string }>(
      tx,
      sql`select id::text as id from app.message_templates
           where workspace_id = ${scope.workspaceId} and archived_at is null
             and lower(btrim(name)) = lower(btrim(${name})) limit 1`,
    );
    if (!taken) break;
    name = `${wanted.slice(0, 112)} (${attempt})`;
  }

  const { createdAt, updatedAt } = sourceTimes(envelope);
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.message_templates (id, workspace_id, name, channel, subject, body, folder,
      created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${name}, ${channel}::app.template_channel,
      ${channel === 'email' ? (str(d.subject)?.slice(0, 200) ?? null) : null},
      ${body.slice(0, 20_000)}, ${str(d.folder)?.slice(0, 60) ?? null},
      coalesce(${createdAt?.toISOString() ?? null}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'message_template',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'message_template',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

// ---------- forms, and the answers people gave them ----------

/**
 * The id a question gets here, worked out from the form and the field name over there.
 *
 * It has to be the same every time, because the answers arrive in a later pass and find their question by
 * this and nothing else. A hash gives that for free and needs nowhere to be stored.
 */
function questionIdFor(formSourceId: string, key: string): string {
  return `q_${createHash('sha256').update(`${formSourceId}|${key}`).digest('hex').slice(0, 8)}`;
}

/** A free slug for the public link, from the form's own name. */
async function freeFormSlug(tx: Tx, scope: ImportScope, name: string): Promise<string> {
  const base = slugify(name).slice(0, 48) || 'form';
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [taken] = await rows<{ id: string }>(
      tx,
      sql`select id::text as id from app.forms
           where workspace_id = ${scope.workspaceId} and slug = ${slug} limit 1`,
    );
    if (!taken) return slug;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

type FormQuestionIn = {
  key: string;
  title: string;
  type: string;
  required?: boolean;
  choices?: string[];
};

/**
 * A form as it arrives from another system.
 *
 * It lands as a **draft**, with a published version 1 behind it so the answers have something to point at.
 * That is deliberate and it is the honest thing: no system we have met hands over a form's questions, so
 * they are read back out of the answers people gave — which can only ever show the questions somebody
 * actually filled in. Publishing that as a live form, on a link a business might put on a flyer, would be
 * claiming we know what it asks. The answers are safe, the form is here, and it takes one look and one
 * Publish to be a form again.
 */
export const importForm: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    name?: string;
    mode?: string;
    intro?: string | null;
    questions?: FormQuestionIn[];
    questionsAreComplete?: boolean;
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const name = (str(d.name) ?? 'Form').slice(0, 120);
  const mode = d.mode === 'survey' || d.mode === 'quiz' ? d.mode : 'form';
  const questions = (d.questions ?? []).slice(0, 200).map((q) => {
    const choices = (q.choices ?? []).slice(0, 60).map((label, i) => ({
      id: `c_${createHash('sha256').update(`${q.key}|${label}|${i}`).digest('hex').slice(0, 8)}`,
      label: label.slice(0, 160),
    }));
    /**
     * A pick-one or pick-any question needs the things people could pick, and an answer alone cannot show
     * what nobody chose. Without at least two, it is not a choice question: it is the words somebody typed,
     * and it comes across as that rather than as a broken list.
     */
    const listed = q.type === 'choice' || q.type === 'checkboxes';
    const type =
      listed && choices.length < 2
        ? q.type === 'checkboxes'
          ? 'long_text'
          : 'short_text'
        : q.type;
    return {
      id: questionIdFor(envelope.source.objectId, q.key),
      type,
      title: q.title.slice(0, 300),
      help: '',
      required: q.required === true,
      showIf: {},
      mapTo: null,
      config: type === 'choice' || type === 'checkboxes' ? { choices } : {},
    };
  });
  const draft = {
    version: 1,
    mode,
    title: name.slice(0, 160),
    intro: str(d.intro)?.slice(0, 4000) ?? '',
    pages: [{ id: 'p_imported', title: '', showIf: {}, questions }],
    calculations: [],
    results: [
      {
        id: 'r_imported',
        name: 'Thank you',
        headline: 'Thank you',
        body: '',
        showIf: {},
        buttonLabel: '',
        buttonUrl: null,
        redirectUrl: null,
      },
    ],
    scoring: {},
    onSubmit: {},
    settings: {},
  };
  /**
   * Checked with the same schema the editor saves through, and never written unless it passes. A form the
   * app cannot open is worse than a form with plainer questions in it, so anything the checker refuses
   * falls back to every question as a line of text — the answers are what matter, and they are all kept
   * either way.
   */
  const checked = FormDefinition.safeParse(draft);
  const definition = checked.success
    ? checked.data
    : FormDefinition.parse({
        ...draft,
        pages: [
          {
            ...draft.pages[0],
            questions: questions.map((q) => ({ ...q, type: 'short_text', config: {} })),
          },
        ],
      });
  const { createdAt, updatedAt } = sourceTimes(envelope);
  const at = createdAt?.toISOString() ?? null;
  const formId = randomUUID();
  const versionId = randomUUID();
  const slug = await freeFormSlug(tx, scope, name);
  await tx.execute(sql`
    insert into app.forms (id, workspace_id, name, mode, status, slug, definition, definition_version,
      revision, created_at, updated_at)
    values (${formId}::uuid, ${scope.workspaceId}, ${name}, ${mode}::app.form_mode, 'draft', ${slug},
      ${JSON.stringify(definition)}::jsonb, 1, 1,
      coalesce(${at}::timestamptz, now()),
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now()))`);
  await tx.execute(sql`
    insert into app.form_versions (id, workspace_id, form_id, version, definition, definition_version,
      revision, source, diff_summary, created_at)
    values (${versionId}::uuid, ${scope.workspaceId}, ${formId}::uuid, 1,
      ${JSON.stringify(definition)}::jsonb, 1, 1, 'editor', '[]'::jsonb,
      coalesce(${at}::timestamptz, now()))`);
  await tx.execute(sql`
    update app.forms set active_version_id = ${versionId}::uuid where id = ${formId}::uuid`);

  /**
   * One finding for the lot, counting up as the forms arrive, rather than one per form: a business with
   * forty forms needs to be told the rule once, not forty times. `affected_count` is what says how many.
   */
  await finding(tx, scope, {
    code: 'forms.questions_read_from_answers',
    category: 'forms',
    capability: 'needs_review',
    severity: 'review',
    summary: 'Your forms came across as drafts, because nobody can hand over what a form asks.',
    whatImports:
      'Every answer anybody ever gave, on the customer who gave it, dated the day they gave it. The questions were worked out from those answers.',
    whatChanges:
      'A question nobody ever filled in cannot be seen from the answers, so it is not here. The form takes no new answers until you publish it.',
    recommendedAction:
      'Open each one, check the questions read right, add any that are missing, and publish it.',
    affected: 1,
    detail: { form: name },
  });

  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'form',
    targetId: formId,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'form',
    targetId: formId,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/** One person's answers, on the day they gave them, against the questions the form was rebuilt with. */
export const importFormResponse: Importer = async (tx, scope, envelope) => {
  const d = envelope.data as {
    submittedAt?: string;
    source?: string;
    answers?: { key: string; value: unknown }[];
  };
  const already = await existingMapping(
    tx,
    scope,
    envelope.source.objectType,
    envelope.source.objectId,
  );
  if (already) return { counts: { skipped: 1 } };

  const formRef = envelope.relationships.find((r) => r.role === 'form');
  const mappedForm = formRef
    ? await existingMapping(tx, scope, formRef.objectType, formRef.objectId)
    : null;
  if (!mappedForm || mappedForm.targetType !== 'form') {
    await quarantine(tx, scope, {
      category: 'form_submissions',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'answers_without_form',
      message: 'The form these answers were given to is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }
  const [form] = await rows<{
    version_id: string | null;
    definition: { pages?: { questions?: { id: string; title: string; type: string }[] }[] };
  }>(
    tx,
    sql`select active_version_id::text as version_id, definition from app.forms
         where id = ${mappedForm.targetId}::uuid and workspace_id = ${scope.workspaceId}`,
  );
  if (!form?.version_id) {
    await quarantine(tx, scope, {
      category: 'form_submissions',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'answers_without_version',
      message: 'The form these answers were given to has no published version here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }
  const known = new Map(
    (form.definition.pages ?? [])
      .flatMap((page) => page.questions ?? [])
      .map((q) => [q.id, { title: q.title, type: q.type }]),
  );

  const personRef = envelope.relationships.find((r) => r.role === 'person');
  const mappedPerson = personRef
    ? await existingMapping(tx, scope, personRef.objectType, personRef.objectId)
    : null;
  const personId = mappedPerson?.targetType === 'person' ? mappedPerson.targetId : null;
  /**
   * Named somebody, and that somebody is not here yet. It waits rather than landing on nobody: an answer
   * that misses its customer is not half-imported, it is lost — nothing on the customer's timeline says it
   * happened, and nothing ever goes back to join them up. An answer nobody signed is a different thing, and
   * it lands below on the form alone.
   */
  if (personRef && !personId) {
    await quarantine(tx, scope, {
      category: 'form_submissions',
      sourceObjectType: envelope.source.objectType,
      sourceObjectId: envelope.source.objectId,
      kind: 'dependency',
      code: 'answers_without_customer',
      message: 'The customer who gave these answers is not here.',
      retryable: true,
    });
    return { counts: { failed: 1 } };
  }

  const submittedAt = d.submittedAt ?? envelope.source.sourceCreatedAt ?? null;
  const source = ['link', 'embed', 'chat', 'qr', 'app', 'api'].includes(d.source ?? '')
    ? d.source!
    : 'link';
  const answers = (d.answers ?? []).slice(0, 200).map((a) => ({
    questionId: questionIdFor(formRef!.objectId, a.key),
    key: a.key,
    value: a.value,
  }));
  const id = randomUUID();
  await tx.execute(sql`
    insert into app.form_responses (id, workspace_id, form_id, version_id, status, source, person_id,
      answers, calculations, one_per_person, started_at, completed_at, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${mappedForm.targetId}::uuid, ${form.version_id}::uuid,
      'completed', ${source}::app.form_source, ${personId}::uuid,
      ${JSON.stringify(Object.fromEntries(answers.map((a) => [a.questionId, a.value])))}::jsonb,
      '{}'::jsonb,
      -- Never: an imported answer must not be the one that stops somebody answering again.
      false,
      coalesce(${submittedAt}::timestamptz, now()),
      coalesce(${submittedAt}::timestamptz, now()),
      coalesce(${submittedAt}::timestamptz, now()),
      coalesce(${submittedAt}::timestamptz, now()))`);
  for (const answer of answers) {
    const question = known.get(answer.questionId);
    // A field somebody filled in that the rebuilt form has no question for still keeps its answer, under
    // the name the old system used.
    const title = (question?.title ?? answer.key).slice(0, 300);
    const type = question?.type ?? 'short_text';
    const text =
      typeof answer.value === 'string'
        ? answer.value
        : Array.isArray(answer.value)
          ? answer.value.join(', ')
          : answer.value === null || answer.value === undefined
            ? null
            : String(answer.value);
    const number = typeof answer.value === 'number' ? answer.value : null;
    await tx.execute(sql`
      insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title,
        question_type, value, number_value, text_value, answered_at)
      values (${scope.workspaceId}, ${id}::uuid, ${mappedForm.targetId}::uuid, ${answer.questionId},
        ${title}, ${type}, ${JSON.stringify(answer.value ?? null)}::jsonb, ${number},
        ${text?.slice(0, 5000) ?? null},
        coalesce(${submittedAt}::timestamptz, now()))
      on conflict (response_id, question_id) do nothing`);
  }
  await putMapping(tx, scope, {
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
    targetType: 'form_response',
    targetId: id,
    createdHere: true,
    checksum: envelope.source.payloadChecksum,
  });
  await journal(tx, scope, {
    action: 'create',
    targetType: 'form_response',
    targetId: id,
    sourceObjectType: envelope.source.objectType,
    sourceObjectId: envelope.source.objectId,
  });
  return { counts: { imported: 1 } };
};

/** Which importer reads which canonical type. Nothing else in the engine decides this. */
export const IMPORTERS: Readonly<Record<string, Importer>> = {
  user_identity: importUser,
  tag: importTag,
  custom_field: importCustomField,
  company: importCompany,
  contact: importContact,
  conversation: importConversation,
  message: importMessage,
  call: importCall,
  pipeline: importPipeline,
  lead: importLead,
  calendar: importCalendar,
  appointment: importAppointment,
  task: importTask,
  note: importNote,
  product: importProduct,
  invoice: importInvoice,
  estimate: importEstimate,
  subscription: importSubscription,
  form: importForm,
  form_response: importFormResponse,
  template: importTemplate,
};

export { AUTO_MERGE_SCORE };
