'use client';
import { useState } from 'react';

/**
 * `value` as it was when `open` last became true, kept for as long as `open` stays true; `value` itself while closed.
 *
 * A dialog opens on what the page shows, and the page goes on refreshing underneath it: a teammate's change, or
 * one the worker makes, reaches the live channel and hands the dialog a new record. A dialog started from this
 * instead keeps what the person has typed, and compares what they changed with what it opened with, so it never
 * sends back the old value of a detail a teammate changed meanwhile (M10: newest wins, one detail at a time).
 */
export function useOpenedWith<T>(open: boolean, value: T): T {
  const [kept, setKept] = useState({ open, value });
  if (open && !kept.open) {
    // Just opened: this render's value is what it opened with.
    setKept({ open, value });
    return value;
  }
  if (!open && kept.open) setKept({ open, value });
  return open ? kept.value : value;
}
