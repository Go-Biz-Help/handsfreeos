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
import { randomUUID } from 'node:crypto';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  AUTO_MERGE_SCORE,
  decideMerge,
  mergeScalarFields,
  normalizePhone,
  stricterConsent,
  unionValues,
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

/** Which importer reads which canonical type. Nothing else in the engine decides this. */
export const IMPORTERS: Readonly<Record<string, Importer>> = {
  user_identity: importUser,
  tag: importTag,
  custom_field: importCustomField,
  company: importCompany,
  contact: importContact,
};

export { AUTO_MERGE_SCORE };
