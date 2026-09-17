import { clsx, type ClassValue } from 'clsx';
import { relativeTimeAgo } from '@hfos/core';
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

/** "just now", "12 min ago", "3 h ago", "2 d ago", then the day (core's words, so the phone says the same). */
export const relativeTime = relativeTimeAgo;
