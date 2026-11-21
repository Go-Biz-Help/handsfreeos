import {
  BUSINESS_CARD_SOURCE,
  BUSINESS_CARD_WORDS,
  companyKey,
  type CardFormCheck,
  type CardSide,
} from '@hfos/core';

import { change, changes, newId } from '@/changes';

import { addCustomer, customerAlreadyHere } from './add-customer';
import { keepCardPicture } from './card-scan';

/** A side of the card, straightened, to go on the new contact's Files. */
export interface CardPicture {
  readonly side: CardSide;
  /** JPEG, base64. */
  readonly base64: string;
}

export type AddedContact =
  | { readonly kind: 'added'; readonly id: string; readonly name: string }
  | { readonly kind: 'already'; readonly id: string; readonly name: string };

const COMPANIES_SQL = `SELECT id, name FROM companies WHERE workspace_id = ? AND archived_at IS NULL`;

const INSERT_COMPANY = `
  INSERT INTO companies (id, workspace_id, name, website, other_emails, other_phones, other_addresses, source,
    created_at, updated_at)
  VALUES (?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?)`;

/**
 * The company a new contact works at: one of the business's companies with the same name (case, spacing, punctuation
 * and "Inc." or "LLC" don't count), or a new one, added first so the contact can point at it. Works with no signal.
 */
async function companyFor(
  workspaceId: string,
  company: { readonly name: string; readonly website: string | null },
  source: string | null,
): Promise<{ readonly id: string; readonly changeId: string | null }> {
  const rows =
    (await changes.open?.db.getAll<{ id: string; name: string | null }>(COMPANIES_SQL, [
      workspaceId,
    ])) ?? [];
  const key = companyKey(company.name);
  const found = key ? rows.find((row) => companyKey(row.name ?? '') === key) : undefined;
  if (found) return { id: found.id, changeId: null };
  const id = newId();
  const now = new Date().toISOString();
  const made = await change(
    'company.create',
    {
      workspaceId,
      id,
      name: company.name,
      ...(company.website ? { website: company.website } : {}),
      ...(source ? { source } : {}),
    },
    {
      optimistic: (tx) =>
        tx.execute(INSERT_COMPANY, [
          id,
          workspaceId,
          company.name,
          company.website,
          source,
          now,
          now,
        ]),
    },
  );
  return { id, changeId: made.id };
}

/**
 * Adds the contact from the New contact form (typed in, or filled from a business card): linked to their company,
 * found or added, with the card's straightened pictures on their Files. Someone already here with one of the numbers
 * or emails is found instead, unless `anyway`. Works with no signal: all of it is on this phone at once, the pictures
 * kept in the person's kept files, and it reaches HandsFreeOS with the next signal, in order.
 */
export async function addContact(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly check: Extract<CardFormCheck, { ok: true }>;
  readonly pictures: readonly CardPicture[];
  readonly anyway?: boolean;
}): Promise<AddedContact> {
  const { workspaceId, check } = input;
  if (!input.anyway) {
    const found = await customerAlreadyHere(workspaceId, check.person);
    if (found) return { kind: 'already', ...found };
  }
  const scanned = check.person.source === BUSINESS_CARD_SOURCE;
  const company = check.company
    ? await companyFor(workspaceId, check.company, scanned ? BUSINESS_CARD_SOURCE : null)
    : null;
  const added = await addCustomer(
    workspaceId,
    { ...check.person, companyId: company?.id ?? null },
    check.name,
    { checked: true, anyway: input.anyway, dependsOn: company?.changeId ? [company.changeId] : [] },
  );
  if (added.kind === 'already') return added;
  for (const picture of input.pictures) {
    const fileId = newId();
    const kept = keepCardPicture(input.userId, fileId, picture.base64);
    await changes.addPhoto({ workspaceId, recordType: 'person', recordId: added.id }, kept, {
      fileId,
      dependsOn: [added.changeId],
      name: BUSINESS_CARD_WORDS.photoName(picture.side),
    });
  }
  return { kind: 'added', id: added.id, name: added.name };
}
