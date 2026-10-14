/**
 * Zoom's transcripts come as WebVTT captions: numbered cues with times, each "Speaker: words". What's kept is the
 * words, one line per turn, with a speaker's lines run together while they keep talking.
 */
export function vttToText(vtt: string): string {
  const lines = vtt.replace(/\r\n?/g, '\n').split('\n');
  const turns: { who: string | null; said: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line) || line.includes('-->')) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    const m = /^([^:]{1,80}):\s+(.*)$/.exec(line);
    const who = m ? m[1]!.trim() : null;
    const said = (m ? m[2]! : line).trim();
    if (!said) continue;
    const last = turns[turns.length - 1];
    if (last && last.who === who) last.said += ` ${said}`;
    else turns.push({ who, said });
  }
  return turns.map((t) => (t.who ? `${t.who}: ${t.said}` : t.said)).join('\n');
}
