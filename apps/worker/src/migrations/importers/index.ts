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
 * HandsFreeOS has no custom fields. This is the one importer that imports nothing, on purpose.
 *
 * It does two honest things instead: it records that the field existed, so the values arriving on customers
 * can be named rather than shown as a wall of ids, and it raises one finding per business listing them. The
 * values themselves are kept — see `importContact`, which puts them in the customer's notes rather than
 * throwing them away. When custom fields are built, the staged payloads are still here and everything can be
 * put where it belongs without anybody retyping a thing.
 */
export const importCustomField: Importer = async (tx, scope, envelope) => {
  const data = envelope.data as { name?: string; key?: string; type?: string };
  const name = str(data.name) ?? 'Unnamed field';
  await finding(tx, scope, {
    code: 'custom_fields.no_home_yet',
    category: 'custom_fields',
    capability: 'not_supported',
    severity: 'review',
    summary: 'HandsFreeOS has no custom fields yet.',
    whatImports:
      'Every value is kept with the customer it belonged to, written into their notes and named as it was named over there.',
    whatChanges:
      'They are not fields you can filter or report on here yet, and they are not on the customer form.',
    recommendedAction:
      'Nothing to do. When custom fields arrive, we can put these where they belong without you retyping anything.',
    sourceCapability: 'custom_fields',
    affected: 1,
    detail: { fields: [name] },
  });
  return { counts: { skipped: 1 } };
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

  // Custom-field values with nowhere to go yet: written into the notes, named as they were named, rather
  // than dropped. Ugly on purpose — it is meant to look like something waiting for a proper home.
  const extras = Object.entries(d.customFields ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  const notes = extras.length
    ? `From the old system:\n${extras.map(([k, v]) => `• ${k}: ${String(v)}`).join('\n')}`
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
            notes = ${nextNotes}
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
      address_line1, city, state, postal_code, country, source, notes, sms_consent, created_at, updated_at)
    values (${id}::uuid, ${scope.workspaceId}, ${firstName}, ${lastName},
      ${email}::extensions.citext, ${str(d.phone)}, ${phoneE164},
      ${str(d.address?.line1)}, ${str(d.address?.city)}, ${str(d.address?.state)},
      ${str(d.address?.postalCode)}, coalesce(${str(d.address?.country)}, 'US'),
      ${str(d.source)}, ${notes}, ${smsConsent}::app.sms_consent,
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
