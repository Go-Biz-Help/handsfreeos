import type { PushButton, PushData } from '@hfos/core';

import type { CommandName, InputOf } from '@/changes/commands';
import type { OutboxRow } from '@/changes/outbox';

import { pressAction, pressKey, TAP, type PressAction } from './buttons';
import { notificationIdentifierOf, type PressEvent } from './payload';

/**
 * Running a press on a notification (apps/worker/src/push/README.md, "The buttons"), wherever the phone hears of it:
 * the app open, in the background, or woken just for it (Android's background task, an iPhone launching the app out
 * of sight).
 *
 * - **A tap, Call, Review or Open** opens the push's `path` through the app's route map, once the person is signed in
 *   and the app unlocked.
 * - **A button that runs a command** makes its change through `change()` under `data.commandIds[button]`, then sends it
 *   straight away (the app may be locked, or woken without its sync connection). A second press, a replayed response or
 *   the same button on another of the person's phones gets the first answer back, so it's done once.
 * - **Unlock first:** on an iPhone the phone itself asks for Face ID or the passcode before the press reaches the app.
 *   Expo's Android code can't, so on Android a button that needs it, pressed on a locked phone, isn't run: it waits on
 *   the phone, and the notification asks to unlock. Tapping it opens the app, which asks for the phone's unlock (and
 *   the app's own Face ID lock) before it runs the press. Snooze 1 hour runs locked.
 * - **What happened** replaces the notification: gone once it went; the API's words when it was refused; for a
 *   question (quiet hours, Still send?), the conversation opens and asks.
 */

/** A notification the app shows about a press: what it's waiting for, or why it didn't go. */
export interface FollowUp {
  /**
   * Why the app shows it, and what a tap on it does. `done`: a reply typed in Android's notification shade went, and
   * Android keeps that notification until the person clears it (15 and later refuse the app's own dismiss), so it
   * says so, without buttons; a tap opens the conversation.
   */
  readonly kind: 'unlock' | 'ask' | 'refused' | 'waiting' | 'done';
  readonly data: PushData;
  readonly title: string;
  readonly body: string;
  /** The change it's about (`ask`, `refused`). */
  readonly changeId?: string;
}

export type PressOutcome =
  | { readonly kind: 'opened'; readonly path: string }
  | { readonly kind: 'sent'; readonly button: PushButton; readonly changeId: string }
  | { readonly kind: 'already'; readonly button: PushButton }
  | { readonly kind: 'unlock-first'; readonly button: PushButton }
  | { readonly kind: 'waiting'; readonly button: PushButton; readonly changeId: string }
  | {
      readonly kind: 'asked';
      readonly button: PushButton;
      readonly changeId: string;
      readonly rule: string | null;
    }
  | {
      readonly kind: 'refused';
      readonly button: PushButton;
      readonly changeId: string;
      readonly reason: string;
    }
  | { readonly kind: 'not-signed-in' }
  | { readonly kind: 'nothing'; readonly reason: string };

/** A press kept until the phone is unlocked. */
export interface PendingPress {
  readonly data: PushData;
  readonly actionId: string;
  readonly typed: string | null;
  readonly pressedAt: number;
}

export interface PressStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export interface PressDeps {
  readonly platform: 'ios' | 'android';
  readonly now: () => number;
  /**
   * The person signed in and their businesses, with their copy open so changes can be made: waits for the app to start
   * (a background task starts it), or null when nobody is signed in.
   */
  readonly ready: () => Promise<{ userId: string; businessIds: readonly string[] } | null>;
  /** Android: the phone is locked (or a test build pretends it is). */
  readonly phoneLocked: () => boolean;
  readonly change: <N extends CommandName>(
    name: N,
    input: InputOf<N>,
    options: { commandId: string; madeAt: number },
  ) => Promise<{ id: string }>;
  /** Sends a queued change now; the change as it stands afterwards. */
  readonly sendNow: (id: string) => Promise<OutboxRow | null>;
  /** Opens a web path through the route map, once the app can show it. */
  readonly openLink: (path: string) => void;
  /**
   * Call: the app opens on the conversation (or the customer) and calls them through the person's own cell, once it's
   * unlocked. Only a press asks for it this way, never a link, so no address can ring anyone's cell.
   */
  readonly startCall?: (
    target: { conversationId: string } | { personId: string },
    workspaceId: string,
  ) => void;
  /** The app is in front: a question opens the conversation and asks at once, instead of in a notification. */
  readonly appInFront: () => boolean;
  /** Opens a change's question ("Still send?", quiet hours) over the screen the link opened. */
  readonly askAbout: (changeId: string) => void;
  /** The app was opened from "Unlock your phone to…": once it lets the person in, the waiting press runs. */
  readonly unlockToRun: () => void;
  /** Shows (or replaces) a notification about the press. */
  readonly followUp: (followUp: FollowUp) => Promise<void>;
  /** Takes the push's notification away, unless a newer push about the same thing has taken its place. */
  readonly dismiss: (identifier: string, notificationId: string) => Promise<void>;
  readonly store: PressStore;
  readonly log?: (message: string, error?: unknown) => void;
}

const HANDLED_KEY = 'push.handledPresses';
const PENDING_KEY = 'push.pendingPress';
/** Presses remembered as done: two days, and at most 200. */
const HANDLED_KEPT_MS = 2 * 24 * 60 * 60_000;
const HANDLED_KEPT = 200;

type Words = { readonly unlock: string; readonly waiting: string; readonly refused: string };

/** What each button's follow-up says. */
export const BUTTON_WORDS: Readonly<Record<PushButton, Words>> = {
  reply: {
    unlock: 'Unlock your phone to send your reply.',
    waiting: 'Your reply is on this phone and goes as soon as HandsFreeOS can be reached.',
    refused: 'Your reply wasn’t sent.',
  },
  let_ai_handle: {
    unlock: 'Unlock your phone to let AI handle it.',
    waiting: 'It goes to AI as soon as HandsFreeOS can be reached.',
    refused: 'AI didn’t take it.',
  },
  let_handle: {
    unlock: 'Unlock your phone to let HandsFreeOS handle it.',
    waiting: 'HandsFreeOS takes it as soon as it can be reached.',
    refused: 'HandsFreeOS didn’t take it.',
  },
  snooze: {
    unlock: 'Unlock your phone to snooze it.',
    waiting: 'It’s snoozed for an hour as soon as HandsFreeOS can be reached.',
    refused: 'It wasn’t snoozed.',
  },
  approve: {
    unlock: 'Unlock your phone to approve it.',
    waiting: 'Your approval goes as soon as HandsFreeOS can be reached.',
    refused: 'It wasn’t approved.',
  },
  done: {
    unlock: 'Unlock your phone to mark it done.',
    waiting: 'It’s marked done as soon as HandsFreeOS can be reached.',
    refused: 'It wasn’t marked done.',
  },
  no_show: {
    unlock: 'Unlock your phone to say it didn’t happen.',
    waiting: 'It’s marked as didn’t happen as soon as HandsFreeOS can be reached.',
    refused: 'It wasn’t marked.',
  },
  still_there: {
    unlock: 'Unlock your phone to say you’re still there.',
    waiting: 'HandsFreeOS asks again in an hour, once it can be reached.',
    refused: 'That didn’t go through.',
  },
  call: { unlock: '', waiting: '', refused: '' },
  review: { unlock: '', waiting: '', refused: '' },
  open: { unlock: '', waiting: '', refused: '' },
};

/**
 * What a notification about a press is headed: the push's own title (an iPhone push carries its words beside its
 * data), else the business.
 */
const titleOf = (data: PushData, press: PressEvent): string =>
  data.title ?? press.title ?? data.business;

export class PressRunner {
  /** Opens heard twice in a moment (the listener and the launch response): opened once. */
  private readonly recentOpens = new Map<string, number>();
  /** Presses being run now: the same press heard twice at once (the background task and a listener) runs once. */
  private readonly running = new Map<string, Promise<PressOutcome>>();

  constructor(private readonly deps: PressDeps) {}

  /** Forgets a press waiting for the phone to be unlocked (signing out). */
  clearPending(): void {
    this.deps.store.remove(PENDING_KEY);
  }

  /** The press waiting for the phone to be unlocked, if any. */
  pending(): PendingPress | null {
    const value = this.deps.store.get<PendingPress>(PENDING_KEY);
    return value && typeof value.actionId === 'string' ? value : null;
  }

  private handled(): Record<string, number> {
    return this.deps.store.get<Record<string, number>>(HANDLED_KEY) ?? {};
  }

  private markHandled(key: string) {
    const now = this.deps.now();
    const kept = Object.entries({ ...this.handled(), [key]: now })
      .filter(([, at]) => now - at < HANDLED_KEPT_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, HANDLED_KEPT);
    this.deps.store.set(HANDLED_KEY, Object.fromEntries(kept));
  }

  /** Runs a press as the phone heard it. */
  async handle(press: PressEvent, extra: { followUp?: unknown } = {}): Promise<PressOutcome> {
    const pressedAt = this.deps.now();
    const action = pressAction({
      data: press.data,
      actionId: press.actionId,
      typed: press.typed,
      pressedAt,
    });
    if (action.kind === 'open') return this.open(press, action.path, extra.followUp);
    if (action.kind === 'nothing') {
      this.deps.log?.(`A notification press did nothing: ${action.reason}`);
      return action;
    }
    const key = pressKey(press.data, press.actionId);
    const already = this.running.get(key);
    if (already) return already;
    const run = this.run(press.data, action, press, pressedAt, false).finally(() =>
      this.running.delete(key),
    );
    this.running.set(key, run);
    return run;
  }

  private open(press: PressEvent, path: string, followUp: unknown): PressOutcome {
    const key = `${press.identifier ?? press.data.notificationId}:${press.actionId}`;
    const now = this.deps.now();
    const last = this.recentOpens.get(key);
    this.recentOpens.set(key, now);
    if (last !== undefined && now - last < 3_000) return { kind: 'opened', path };
    const about = followUpOf(followUp);
    if (about?.kind === 'refused') {
      this.deps.openLink(`/app/w/${press.data.workspaceId}/changes`);
      return { kind: 'opened', path: `/app/w/${press.data.workspaceId}/changes` };
    }
    this.deps.openLink(path);
    if (press.actionId === 'call') {
      const { conversationId, personId } = press.data.refs;
      if (conversationId) this.deps.startCall?.({ conversationId }, press.data.workspaceId);
      else if (personId) this.deps.startCall?.({ personId }, press.data.workspaceId);
    }
    if (about?.kind === 'ask' && about.changeId) this.deps.askAbout(about.changeId);
    if (about?.kind === 'unlock' && this.pending()) this.deps.unlockToRun();
    return { kind: 'opened', path };
  }

  /**
   * The press kept until the phone was unlocked, now that it is: the app was opened from its notification, and the
   * phone (and the app's own lock) let the person in.
   */
  async runPending(): Promise<PressOutcome | null> {
    const pending = this.pending();
    if (!pending) return null;
    this.deps.store.remove(PENDING_KEY);
    const action = pressAction(pending);
    if (action.kind !== 'command') return null;
    const press: PressEvent = {
      data: pending.data,
      actionId: pending.actionId,
      typed: pending.typed,
      identifier: notificationIdentifierOf(pending.data),
    };
    return this.run(pending.data, action, press, pending.pressedAt, true);
  }

  /**
   * The press did its work, so its notification goes. Not a reply typed in Android's notification shade: Android keeps
   * that one until the person clears it (15 and later refuse the app's dismiss), so it says what happened instead.
   */
  private async finished(
    data: PushData,
    press: PressEvent,
    identifier: string,
    words: string,
  ): Promise<void> {
    if (this.deps.platform === 'android' && press.typed !== null) {
      await this.deps
        .followUp({ kind: 'done', data, title: titleOf(data, press), body: words })
        .catch(() => undefined);
      return;
    }
    await this.deps.dismiss(identifier, data.notificationId).catch(() => undefined);
  }

  private async run(
    data: PushData,
    action: Extract<PressAction, { kind: 'command' }>,
    press: PressEvent,
    pressedAt: number,
    unlocked: boolean,
  ): Promise<PressOutcome> {
    const { button } = action;
    const words = BUTTON_WORDS[button];
    const identifier = press.identifier ?? notificationIdentifierOf(data);
    const key = pressKey(data, press.actionId);

    if (this.handled()[key] !== undefined) {
      await this.finished(data, press, identifier, ALREADY_WORDS);
      return { kind: 'already', button };
    }

    if (action.unlock && !unlocked && this.deps.platform === 'android' && this.deps.phoneLocked()) {
      const pending: PendingPress = {
        data,
        actionId: press.actionId,
        typed: press.typed,
        pressedAt,
      };
      this.deps.store.set(PENDING_KEY, pending);
      await this.deps.followUp({
        kind: 'unlock',
        data,
        title: titleOf(data, press),
        body: words.unlock,
      });
      return { kind: 'unlock-first', button };
    }

    const person = await this.deps.ready();
    if (!person) return { kind: 'not-signed-in' };
    if (!person.businessIds.includes(data.workspaceId))
      return { kind: 'nothing', reason: 'That notification is for a business you aren’t part of.' };

    let changeId: string;
    try {
      const made = await this.deps.change(action.command.name, action.command.input as never, {
        commandId: action.commandId,
        madeAt: pressedAt,
      });
      changeId = made.id;
    } catch (error) {
      this.deps.log?.('A notification button couldn’t make its change', error);
      return { kind: 'nothing', reason: error instanceof Error ? error.message : String(error) };
    }
    this.markHandled(key);

    const row = await this.deps.sendNow(changeId);
    if (!row || row.state === 'sent') {
      await this.finished(data, press, identifier, SENT_WORDS[button]);
      return { kind: 'sent', button, changeId };
    }
    if (row.state === 'refused') {
      // Already done, not refused. Either the API kept an earlier press of this button with other words (a second
      // reply, `command_id_reused`), or the same thing was decided somewhere else first — on Home, on the web, or on
      // another phone — and the approval commands answer `approval_decided` / `draft_decided`. Nothing was sent
      // twice either way, so the notification says so kindly instead of "It wasn't approved."
      if (row.rule !== null && ALREADY_DONE_RULES.has(row.rule)) {
        await this.finished(data, press, identifier, ALREADY_WORDS);
        return { kind: 'already', button };
      }
      const reason = row.reason ?? '';
      await this.deps.followUp({
        kind: 'refused',
        data,
        title: titleOf(data, press),
        body: reason ? `${words.refused} ${reason}` : words.refused,
        changeId,
      });
      return { kind: 'refused', button, changeId, reason };
    }
    if (row.state === 'ask') {
      if (this.deps.appInFront()) {
        await this.deps.dismiss(identifier, data.notificationId).catch(() => undefined);
        this.deps.openLink(data.path);
        this.deps.askAbout(changeId);
      } else {
        await this.deps.followUp({
          kind: 'ask',
          data,
          title: titleOf(data, press),
          body: askWords(row, data, button),
          changeId,
        });
      }
      return { kind: 'asked', button, changeId, rule: row.rule };
    }
    await this.deps.followUp({
      kind: 'waiting',
      data,
      title: titleOf(data, press),
      body: words.waiting,
      changeId,
    });
    return { kind: 'waiting', button, changeId };
  }
}

/** What each button says once it's done. */
export const SENT_WORDS: Readonly<Record<PushButton, string>> = {
  reply: 'Your reply was sent.',
  let_ai_handle: 'AI has it now.',
  let_handle: 'HandsFreeOS is handling it.',
  snooze: 'Snoozed for an hour.',
  approve: 'Approved.',
  done: 'Marked done.',
  no_show: 'Marked as didn’t happen.',
  still_there: 'HandsFreeOS will ask again in an hour.',
  call: '',
  review: '',
  open: '',
};

/** A press that was already done, on this phone or another. */
const ALREADY_WORDS = 'That was already done.';

/**
 * Refusals that mean "this was already done", not "this didn't work":
 * - `command_id_reused` — the API already kept a change under this button's id;
 * - `approval_decided` — a workflow approval someone decided first (Home, the web, another phone);
 * - `draft_decided` — the AI teammate's draft, likewise.
 *
 * Each is a conflict, so nothing ran twice; the press just arrived second.
 */
const ALREADY_DONE_RULES: ReadonlySet<string> = new Set([
  'command_id_reused',
  'approval_decided',
  'draft_decided',
]);

/** A press's outcome in words, for a toast or the test tools. */
export function outcomeWords(outcome: PressOutcome): string {
  switch (outcome.kind) {
    case 'opened':
      return 'Opened.';
    case 'sent':
      return SENT_WORDS[outcome.button];
    case 'already':
      return ALREADY_WORDS;
    case 'unlock-first':
      return BUTTON_WORDS[outcome.button].unlock;
    case 'waiting':
      return BUTTON_WORDS[outcome.button].waiting;
    case 'asked':
      return outcome.rule === 'quiet_hours'
        ? 'It’s quiet hours, so HandsFreeOS asks first.'
        : 'HandsFreeOS asks something first.';
    case 'refused':
      return `${BUTTON_WORDS[outcome.button].refused} ${outcome.reason}`.trim();
    case 'not-signed-in':
      return 'Sign in to HandsFreeOS first.';
    case 'nothing':
      return outcome.reason;
  }
}

/** What a question's notification says: quiet hours, or HandsFreeOS asking something else first. */
export function askWords(
  row: Pick<OutboxRow, 'rule' | 'reason'>,
  data: PushData,
  button: PushButton,
): string {
  if (row.rule === 'quiet_hours')
    return button === 'reply'
      ? `It’s quiet hours at ${data.business}. Open to send your reply now, or when quiet hours end.`
      : `It’s quiet hours at ${data.business}. Open to decide.`;
  const reason = row.reason?.trim();
  return reason ? `${reason} Open to decide.` : 'HandsFreeOS asks something first. Open to decide.';
}

/** A follow-up notification's own marker, from its data. */
export function followUpOf(value: unknown): { kind: FollowUp['kind']; changeId?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const kind = (value as { kind?: unknown }).kind;
  const changeId = (value as { changeId?: unknown }).changeId;
  if (kind !== 'unlock' && kind !== 'ask' && kind !== 'refused' && kind !== 'waiting') return null;
  return { kind, ...(typeof changeId === 'string' ? { changeId } : {}) };
}

export { TAP };
