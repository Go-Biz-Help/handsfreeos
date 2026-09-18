import { router, type Href } from 'expo-router';

import { fixerFor, setFixer } from '@/changes/fixers';

import { inputOf } from './outbox';

/**
 * Fix and try again, on Changes on this phone, reopens the change where it was made: a customer's edit on their own
 * page, a note or a tag on the record it was about, a task in Tasks, a stage move on the lead. The screen opens with
 * the change's id in `?fix=`, so it can put the words back in the box.
 *
 * **A refused `person.create` is not here.** The customer was never saved, so there is no record to open; whoever
 * registered a fixer for it keeps it (the test builds' own fix screen, and a new-customer screen when the phone
 * gains one). Each fixer below falls back to whatever was registered before it for the same reason.
 *
 * Registered once at start-up, like the inbox's (`app-start.ts`).
 */
export function registerCustomerFixers(): () => void {
  const removers = [
    to('person.update', (input) => path(input.personId, (id) => `customers/people/${id}`)),
    to('company.update', (input) => path(input.companyId, (id) => `customers/companies/${id}`)),
    to(
      'activity.log',
      (input) =>
        path(input.personId, (id) => `customers/people/${id}`) ??
        path(input.companyId, (id) => `customers/companies/${id}`) ??
        path(input.leadId, (id) => `leads/${id}`),
    ),
    to('record.add_tag', (input) => tagPath(input)),
    to('record.remove_tag', (input) => tagPath(input)),
    to('lead.move_stage', (input) => path(input.leadId, (id) => `leads/${id}`)),
    to('lead.set_next_action', (input) => path(input.leadId, (id) => `leads/${id}`)),
    to('task.create', () => 'tasks'),
    to('task.update', () => 'tasks'),
    to('task.complete', () => 'tasks'),
    to('task.reopen', () => 'tasks'),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}

type Input = Readonly<Record<string, unknown>>;

const path = (id: unknown, make: (id: string) => string): string | null =>
  typeof id === 'string' && id ? make(id) : null;

const tagPath = (input: Input): string | null => {
  const id = typeof input.recordId === 'string' ? input.recordId : null;
  if (!id) return null;
  if (input.recordType === 'company') return `customers/companies/${id}`;
  if (input.recordType === 'lead') return `leads/${id}`;
  return `customers/people/${id}`;
};

function to(
  command: Parameters<typeof setFixer>[0],
  where: (input: Input) => string | null,
): () => void {
  const before = fixerFor(command);
  return setFixer(command, (row) => {
    const screen = where(inputOf(row));
    if (screen && row.workspace_id) {
      router.push(`/app/w/${row.workspace_id}/${screen}?fix=${encodeURIComponent(row.id)}` as Href);
      return;
    }
    before?.(row);
  });
}
