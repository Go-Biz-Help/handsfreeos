import type { KnowledgeProfileValue } from '@/lib/api/types';

/** The parts of the business profile that count toward "how complete" (core's profileCompleteness). */
export const PROFILE_PARTS = [
  {
    key: 'description',
    label: 'What you do',
    filled: (p: KnowledgeProfileValue) => !!p.description.trim(),
  },
  {
    key: 'services',
    label: 'Services',
    filled: (p: KnowledgeProfileValue) => p.services.length > 0,
  },
  {
    key: 'serviceArea',
    label: 'Service area',
    filled: (p: KnowledgeProfileValue) => !!p.serviceArea.trim(),
  },
  { key: 'hours', label: 'Hours', filled: (p: KnowledgeProfileValue) => !!p.hours.trim() },
  { key: 'policies', label: 'Policies', filled: (p: KnowledgeProfileValue) => !!p.policies.trim() },
  { key: 'tone', label: 'Tone of voice', filled: (p: KnowledgeProfileValue) => !!p.tone.trim() },
  {
    key: 'signature',
    label: 'Signature',
    filled: (p: KnowledgeProfileValue) => !!p.signature.trim(),
  },
] as const;

export type ProfilePartKey = (typeof PROFILE_PARTS)[number]['key'];

export function missingParts(p: KnowledgeProfileValue) {
  return PROFILE_PARTS.filter((part) => !part.filled(p));
}
