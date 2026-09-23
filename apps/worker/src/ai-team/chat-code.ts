/**
 * Sends the code a website chat visitor types back to prove they're the customer (M18). Core picks where it goes
 * (the phone on file, else the email on file) and keeps only its hash; the worker only delivers it. A text needs
 * the business's number and balance, so the worker says up front whether it can text, and core sends it by email
 * when it can't.
 */
import { CODE_MINUTES, defaultNumber, walletRoom } from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import { chatCodeEmail, chatCodeText } from '../emails/templates';
import type { WorkerServices } from '../services';
import { loadAccount, webhookUrls } from '../telephony/accounts';

export interface ChatCode {
  readonly channel: 'sms' | 'email';
  readonly to: string;
  readonly code: string;
  readonly business: string;
}

export interface ChatCodeSender {
  /** Whether a code can go out by text right now: an active number, a texting account and balance. */
  canText(tx: Tx, workspaceId: string): Promise<boolean>;
  send(tx: Tx, workspaceId: string, c: ChatCode): Promise<void>;
}

type Services = Pick<WorkerServices, 'mailer' | 'telephony' | 'sealer' | 'publicUrl' | 'log'>;

async function texting(s: Services, tx: Tx, workspaceId: string) {
  const number = await defaultNumber(tx, workspaceId);
  const account = await loadAccount(tx, workspaceId, s.sealer);
  const room = await walletRoom(tx, workspaceId, 'text', (msg, e) => s.log.error({ err: e }, msg));
  return number?.status === 'active' && account && room.allowed ? { number, account } : null;
}

export function chatCodeSender(s: Services): ChatCodeSender {
  return {
    async canText(tx, workspaceId) {
      return !!(await texting(s, tx, workspaceId));
    },
    async send(tx, workspaceId, c) {
      if (c.channel === 'email') {
        await s.mailer.send({
          to: c.to,
          ...chatCodeEmail({ business: c.business, code: c.code, minutes: CODE_MINUTES }),
        });
        return;
      }
      const ready = await texting(s, tx, workspaceId);
      if (!ready) throw new Error('texting is not ready for this business');
      await s.telephony.sendMessage(ready.account, {
        from: ready.number.e164,
        messagingServiceSid: ready.account.messagingServiceSid,
        to: c.to,
        body: chatCodeText(c.business, c.code, CODE_MINUTES),
        mediaUrls: [],
        statusCallbackUrl: webhookUrls(s.publicUrl).smsStatusUrl,
      });
    },
  };
}
