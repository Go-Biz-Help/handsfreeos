/**
 * The person's extension sign-ins still waiting for a number (20261027002910): what the web's prompt and the phone's
 * screen offer. Read as the person, so only their own; never the number itself.
 */
import { rows, sql } from '@hfos/db/client';
import {
  ExtensionSignInPendingInput,
  ExtensionSignInPendingOutput,
  extensionBrowserName,
} from '../account/extension-sign-in';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';

export const extensionSignInPending = defineQuery({
  name: 'extension_sign_in.pending',
  description:
    'Your sign-ins to the browser extension waiting for you to type the number it shows, newest first.',
  input: ExtensionSignInPendingInput,
  output: ExtensionSignInPendingOutput,
  permission: null,
  scope: () => ({ kind: 'account' as const }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const found = await rows<{
      id: string;
      browser: string;
      expires_at: Date | string;
    }>(
      ctx.tx,
      sql`select id, browser, expires_at from app.extension_sign_ins
          where user_id = ${me} and status = 'pending' and expires_at > now()
          order by created_at desc
          limit 3`,
    );
    return {
      requests: found.map((r) => ({
        id: r.id,
        browser: extensionBrowserName(r.browser),
        // Never the numbers: the person types the one the extension shows (see ExtensionSignInPendingOutput).
        choices: [],
        expiresAt: new Date(r.expires_at).toISOString(),
      })),
    };
  },
});
