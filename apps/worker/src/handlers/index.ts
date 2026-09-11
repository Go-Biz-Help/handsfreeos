import { onInvitationCreated, onInvitationResendRequested } from './invitation-email';
import type { HandlerMap } from './types';

/** Event type → handler. Events without a handler are marked done untouched. */
export const handlers: HandlerMap = {
  'invitation.created': onInvitationCreated,
  'invitation.resend_requested': onInvitationResendRequested,
};
