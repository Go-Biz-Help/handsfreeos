/**
 * Telling support when a Rime voice couldn't speak and the AI switched to Deepgram (the owner's pick, 8a): an email
 * to AI_ALERT_EMAILS, at most once an hour on each worker machine, saying how many more times it happened since
 * the last one. A Rime outage is then one email an hour, not one a call. Every time is logged as well.
 */
import { phoneVoiceInfo, type PhoneVoice } from '@hfos/core/server';
import type { Logger } from 'pino';
import { voiceTroubleEmail } from '../emails/templates';
import type { Mailer } from '../mailer';
import { errorMessage } from '../outbox';
import type { SpeechServices } from './speech';

export const VOICE_TROUBLE_EVERY_MS = 60 * 60_000;

export function voiceTroubleAlarm(deps: {
  readonly mailer: Mailer;
  readonly log: Logger;
  /** Who is told (AI_ALERT_EMAILS, else PLATFORM_OWNER_EMAILS). */
  readonly alertEmails: readonly string[];
  readonly webUrl: string;
  readonly everyMs?: number;
  readonly now?: () => number;
}): NonNullable<SpeechServices['trouble']> {
  let last: number | null = null;
  let more = 0;
  return (from: PhoneVoice, to: PhoneVoice, where: 'call' | 'clip', error: unknown) => {
    const err = errorMessage(error);
    deps.log.warn({ from, to, where, err }, 'a Rime voice couldn’t speak; the AI used Deepgram');
    const now = deps.now?.() ?? Date.now();
    if (last !== null && now - last < (deps.everyMs ?? VOICE_TROUBLE_EVERY_MS)) {
      more++;
      return;
    }
    last = now;
    const mail = voiceTroubleEmail({
      voice: phoneVoiceInfo(from).name,
      fallback: phoneVoiceInfo(to).name,
      where,
      error: err.slice(0, 300),
      more,
      link: `${deps.webUrl.replace(/\/$/, '')}/admin/health`,
    });
    more = 0;
    for (const email of deps.alertEmails)
      void deps.mailer
        .send({ to: email, ...mail })
        .catch((e: unknown) =>
          deps.log.error(
            { err: errorMessage(e), to: email },
            'couldn’t email about a Rime voice’s trouble',
          ),
        );
  };
}
