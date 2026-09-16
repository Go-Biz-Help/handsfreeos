/** "Good morning, Dale · Tue, Sep 22", in the business's own time zone, as the web's Home says it. */
export function greeting(firstName: string, timezone: string, now = new Date()): string {
  const hour = Number(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }),
  );
  // Midnight comes back as "24" from some engines.
  const h = hour % 24;
  const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const date = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });
  return `${firstName ? `${hello}, ${firstName}` : hello} · ${date}`;
}
