/** A call's length as m:ss ("0:07", "4:12", "75:12"). */
export function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Mike" for Mike Johnson; a phone number stays whole ("(713) 555-0142 didn’t pick up"). */
export function firstNameOf(name: string): string {
  const t = name.trim();
  if (!t) return 'The caller';
  if (/^[+(0-9]/.test(t)) return t;
  return t.split(/\s+/)[0]!;
}
