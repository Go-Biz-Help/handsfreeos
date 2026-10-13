/**
 * What account deletion does in Supabase Auth, with the worker's own SUPABASE_SECRET_KEY (M10). The sign-in itself
 * stays (deleting it would cascade through the business's records), but:
 *
 * - **Every session ends.** Supabase has no "sign this person out" for the admin key, so the worker makes a one-time
 *   sign-in link for the person (nothing is emailed), redeems it for a session of its own, and signs that session out
 *   "everywhere", which deletes all of the person's sessions and refresh tokens at once. An access token already
 *   handed out keeps working until it expires (an hour at most); by then the person has no business to reach.
 * - **Sign-in is blocked.** The person is banned for 100 years: Supabase refuses their password, emailed codes and
 *   links, and any refresh token. Their email moves to a deleted address and their name and photo leave the sign-in's
 *   details, so the email address is free for a new account later.
 */
import { createClient } from '@supabase/supabase-js';

export interface AuthAdmin {
  /** Ends every session the person has. 'none' when there was nothing to end (already blocked, or no such sign-in). */
  signOutEverywhere(userId: string): Promise<'signed_out' | 'none'>;
  /** Blocks every way of signing in, and takes the person's email and name off the sign-in. */
  blockSignIn(userId: string, deletedEmail: string): Promise<void>;
  /**
   * A one-time sign-in for this email, for the extension (20261027002900): the hashed token of a magic link that is
   * never emailed, which the extension redeems with `verifyOtp({ token_hash, type: 'email' })`. Only after the person
   * picked the right number on their phone or in HandsFreeOS (http/extension-sign-in.ts).
   */
  mintSignIn(email: string): Promise<string>;
}

/** How long a deleted account stays blocked: a hundred years. */
export const BLOCKED_FOR = '876000h';

const options = { auth: { persistSession: false, autoRefreshToken: false } } as const;

export function createAuthAdmin(url: string, secretKey: string): AuthAdmin {
  const admin = createClient(url, secretKey, options);
  return {
    async signOutEverywhere(userId) {
      const found = await admin.auth.admin.getUserById(userId);
      if (found.error) {
        if (found.error.status === 404) return 'none';
        throw new Error(`could not read the sign-in: ${found.error.message}`);
      }
      const user = found.data.user;
      if (!user.email) return 'none';
      // Already blocked: its sessions ended then, and a blocked person can't redeem a link.
      if (user.banned_until && Date.parse(user.banned_until) > Date.now()) return 'none';
      const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
      const tokenHash = link.data.properties?.hashed_token;
      if (link.error || !tokenHash)
        throw new Error(`could not end the sessions: ${link.error?.message ?? 'no link'}`);
      // A client of its own, so the redeemed session never mixes with anything else.
      const redeemed = await createClient(url, secretKey, options).auth.verifyOtp({
        token_hash: tokenHash,
        type: 'magiclink',
      });
      if (redeemed.error || !redeemed.data.session)
        throw new Error(`could not end the sessions: ${redeemed.error?.message ?? 'no session'}`);
      const out = await admin.auth.admin.signOut(redeemed.data.session.access_token, 'global');
      if (out.error) throw new Error(`could not end the sessions: ${out.error.message}`);
      return 'signed_out';
    },

    async mintSignIn(email) {
      const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      const tokenHash = link.data.properties?.hashed_token;
      if (link.error || !tokenHash)
        throw new Error(`could not make the sign-in: ${link.error?.message ?? 'no link'}`);
      return tokenHash;
    },

    async blockSignIn(userId, deletedEmail) {
      const found = await admin.auth.admin.getUserById(userId);
      if (found.error) {
        if (found.error.status === 404) return;
        throw new Error(`could not read the sign-in: ${found.error.message}`);
      }
      // Supabase removes a detail given as null: every one the sign-in holds goes.
      const cleared = Object.fromEntries(
        Object.keys(found.data.user.user_metadata ?? {}).map((key) => [key, null]),
      );
      const { error } = await admin.auth.admin.updateUserById(userId, {
        email: deletedEmail,
        email_confirm: true,
        user_metadata: cleared,
        ban_duration: BLOCKED_FOR,
      });
      if (error) throw new Error(`could not block sign-in: ${error.message}`);
    },
  };
}
