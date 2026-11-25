import { COMPANY_FIELDS, IMPORT_FIELD_LABELS, PERSON_FIELDS } from '@hfos/core';

/** Core's words for each field, so the wizard and the Assistant's card say them the same way. */
export const FIELD_LABELS: Readonly<Record<string, string>> = IMPORT_FIELD_LABELS;

export function fieldsFor(kind: 'people' | 'companies'): readonly string[] {
  return kind === 'people' ? PERSON_FIELDS : COMPANY_FIELDS;
}
