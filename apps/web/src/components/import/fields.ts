import { COMPANY_FIELDS, PERSON_FIELDS, SKIP } from '@hfos/core';

export const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  full_name: 'Full name (split into first and last)',
  name: 'Company name',
  email: 'Email',
  email_alt: 'Other email',
  phone: 'Phone',
  phone_alt: 'Other phone',
  company: 'Company',
  website: 'Website',
  address_line1: 'Address',
  address_line2: 'Address line 2',
  city: 'City',
  state: 'State',
  postal_code: 'ZIP',
  tags: 'Tags (comma separated)',
  notes: 'Notes',
  source: 'Source',
  call_consent: 'Agreed to calls (yes or no)',
  call_consent_source: 'Where they agreed to calls',
  [SKIP]: 'Skip this column',
};

export function fieldsFor(kind: 'people' | 'companies'): readonly string[] {
  return kind === 'people' ? PERSON_FIELDS : COMPANY_FIELDS;
}
