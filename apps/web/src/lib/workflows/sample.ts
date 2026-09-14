import { TEMPLATE_VARIABLES, type TemplateValues } from '@hfos/core';

/** The customer a preview is filled in for (the first customer, or one picked with the search). */
export interface SampleContact {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly city?: string | null;
}

const EXAMPLES = new Map(TEMPLATE_VARIABLES.map((v) => [v.path, v.example]));

/**
 * Values for previewing a message: the sample customer's details, the business's name, and each variable's
 * example for everything a preview can't know (the lead, the appointment, links). An AI result reads as a
 * stand-in, since the AI writes it when the step runs.
 */
export function sampleValues(opts: {
  readonly person: SampleContact | null;
  readonly businessName: string;
  readonly workflowName: string;
}): TemplateValues {
  const p = opts.person;
  const person: Record<string, string | null | undefined> = p
    ? {
        'person.first_name': p.firstName,
        'person.last_name': p.lastName,
        'person.name': p.fullName,
        'person.email': p.email,
        'person.phone': p.phone,
        'person.city': p.city ?? null,
      }
    : {};
  return (path: string) => {
    if (path in person) return person[path];
    if (path === 'business.name') return opts.businessName;
    if (path === 'workflow.name') return opts.workflowName;
    if (path.startsWith('ai.')) return path === 'ai.category' ? 'Question' : '(the AI’s reply)';
    return EXAMPLES.get(path);
  };
}
