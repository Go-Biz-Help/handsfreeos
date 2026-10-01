/**
 * Viewing the app as a teammate (20261016000200), in the words the web and the phone both use: the button that
 * starts a view, the banner while one is open, and the button that stops it.
 */
import { ROLE_LABELS, type WorkspaceRole } from '../permissions';
import type { TeammateViewBy } from '../schemas/teammate-view';

/** Someone's name as the banner says it: their name, else their email. */
const nameOf = (p: { readonly fullName: string; readonly email: string }): string =>
  p.fullName.trim() || p.email;

export const VIEW_AS_WORDS = {
  /** On a teammate's row, and on the phone's More. */
  start: (p: { readonly fullName: string; readonly email: string }) => `View as ${nameOf(p)}`,
  startShort: 'View as',
  /** The phone's More, for owners and admins. */
  pickTitle: 'View as a teammate',
  pickDetail: 'See the app the way someone below you sees it. Nothing can be changed while you do.',
  pickNobody:
    'Nobody here is below you, or everyone below you can do something you can’t. Owners can view as anyone below them.',
  pickNeedsSignal: 'You need a signal to start viewing as someone.',
  starting: 'Opening their view…',
  /** The banner while a view is open. */
  banner: (p: {
    readonly fullName: string;
    readonly email: string;
    readonly role: WorkspaceRole;
  }) => `You’re viewing as ${nameOf(p)} (${ROLE_LABELS[p.role]}).`,
  bannerDetail: (by: TeammateViewBy): string =>
    by === 'support'
      ? 'Read-only. The business can see that you looked.'
      : by === 'founder'
        ? 'Read-only. They aren’t told.'
        : 'Read-only: nothing you do here is saved. Their own mail stays private.',
  /** The phone's shorter banner. */
  bannerShort: (p: { readonly fullName: string; readonly email: string }) =>
    `Viewing as ${nameOf(p)} · Read-only`,
  stop: 'Stop viewing',
  stopping: 'Stopping…',
  /** A change tried in a view, on the phone, before anything is queued. */
  readOnly: (p: { readonly fullName: string; readonly email: string }) =>
    `You’re viewing as ${nameOf(p)}, so nothing here can be changed. Stop viewing to work as yourself.`,
  ended: 'That view has ended. You’re back to your own view.',
} as const;
