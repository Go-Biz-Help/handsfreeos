import {
  EMAIL_ONLY_ROWS,
  managesAnAgency,
  NOTIFICATION_ROWS,
  pushSwitchesOf,
  type EmailSwitch,
  type EmailSwitches,
  type NotificationRow,
  type PushSwitches,
} from '@hfos/core';

/**
 * Settings → Notifications on the phone (design/m10/More.dc.html, "Notifications: push beside email"): a push switch
 * for each moment beside today's email switches, the same switches as the web's Settings → Account. They belong to the
 * person, not the phone: push goes to every phone they're signed in on. A change saves the whole group it's in, as the
 * web does: `user.update_profile` with every push switch (`settings.push`), or all seven email ones
 * (`settings.notifications`). New support tickets is a row only for people who answer HandsFreeOS support.
 */

/**
 * The moments, each with its push and email switch, are core's (`account/notification-rows.ts`): the web's Settings →
 * Account and settings search read the same rows, and decide who has the agency digest the same way.
 */
export { EMAIL_ONLY_ROWS, managesAnAgency, NOTIFICATION_ROWS };
export type { EmailSwitch, EmailSwitches, NotificationRow };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The person's settings, from the synced profile's JSON text (or an object). */
export function settingsOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

/** Every push switch, defaults filled in (payments off until turned on). */
export function pushSwitchesFrom(settings: unknown): PushSwitches {
  return pushSwitchesOf(settingsOf(settings));
}

/** The seven email switches, each on unless turned off, as the web reads them. */
export function emailSwitchesFrom(settings: unknown): EmailSwitches {
  const stored = settingsOf(settings)['notifications'];
  const n = isRecord(stored) ? stored : {};
  const on = (key: EmailSwitch) => n[key] !== false;
  return {
    unansweredEmail: on('unansweredEmail'),
    attentionDigest: on('attentionDigest'),
    eveningSummary: on('eveningSummary'),
    aiHandoff: on('aiHandoff'),
    bookingEmail: on('bookingEmail'),
    paymentEmail: on('paymentEmail'),
    agencyDigest: on('agencyDigest'),
    addonEmail: on('addonEmail'),
  };
}

/** "On 2 phones", as the web says it. */
export function phonesWords(count: number): string {
  return count === 0 ? 'No phones yet' : count === 1 ? 'On 1 phone' : `On ${count} phones`;
}

/** What a saved switch says: "Urgent items: push off". */
export function savedWords(row: NotificationRow, channel: 'push' | 'email', on: boolean): string {
  return `${row.title}: ${channel} ${on ? 'on' : 'off'}`;
}
