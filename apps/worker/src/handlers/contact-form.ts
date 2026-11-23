/**
 * A business just made gets its contact form (the owner, 2026-11-22: "we should just automatically create an a2p
 * compliant contact form when someone creates an account"): the "Get in touch" form, published, with our box to agree
 * to texts, so it's there when texting approval asks how customers will agree.
 *
 * Core does it (`registration.ensure_contact_form`), as the system for whoever made the business. Texting approval
 * runs the same command when it starts, so a business this misses still gets its form: a failure here is logged and
 * never holds up the rest of what a new business sets off.
 */
import { executeCommand, registrationEnsureContactForm } from '@hfos/core/server';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta } from '../services';
import type { EventHandler } from './types';

export const onBusinessNeedsContactForm: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  try {
    await executeCommand(
      ctx.db,
      registrationEnsureContactForm,
      { workspaceId },
      systemActor({ workspaceId, organizationId }, ctx.event.actorId),
      workerMeta(ctx.event.correlationId, ctx.event.id),
    );
  } catch (err) {
    ctx.log.warn(
      { err: errorMessage(err), workspaceId },
      'a new business’s contact form could not be made; texting approval makes it when it starts',
    );
  }
};
