import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function initials(name: string, fallback = '?'): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return (
    parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[parts.length - 1]![0]!
  ).toUpperCase();
}

/** Only same-origin, path-only redirect targets are honoured (no open redirects). */
export function safeNext(value: string | null | undefined, fallback = '/app'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return fallback;
  return value;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
