const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * When a chat or an answer happened: "Today, 2:16 PM", then "Yesterday" and "Sep 10" (with the time too
 * when `time` is set).
 */
export function chatWhen(iso: string, opts: { time?: boolean } = {}, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return `Today, ${clock(d)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day =
    d.toDateString() === yesterday.toDateString()
      ? 'Yesterday'
      : d.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
        });
  return opts.time ? `${day}, ${clock(d)}` : day;
}
