import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A person's initials, as the web draws them: first and last name ("Dale Ramsey" → "DR"). */
export function initials(name: string, fallback = '?'): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return (
    parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[parts.length - 1]![0]!
  ).toUpperCase();
}

/**
 * A business's mark: the first letters of its first two words, as the phone boards draw it ("Lone Star HVAC &
 * Roofing" → "LS", "Bayou Plumbing Co." → "BP"). Words that don't start with a letter or digit ("&") are skipped.
 */
export function businessMark(name: string, fallback = '?'): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return fallback;
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}
