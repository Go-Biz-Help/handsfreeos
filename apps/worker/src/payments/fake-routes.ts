/**
 * The stand-in provider's own payment page, served by the worker — the place a real provider's hosted page or
 * browser SDK would be. Development and tests only: it exists only when the stand-in does, so production never
 * has it.
 *
 * Both flows are here, because both are real:
 * - **Confirm in the browser** (the Stripe stand-in): the page is opened for an intent, and paying confirms it.
 *   Our own route then reads the intent back, so the answer is the provider's.
 * - **Tokenise, then charge** (the Square stand-in): the page turns what was typed into a one-time token and
 *   hands it back; our route charges with it.
 *
 * The page never writes anything of ours, exactly like the real thing.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { escapeHtml } from '../emails/templates';
import type { HttpDeps } from '../http/common';
import { FAKE_BANK, FAKE_CARDS, type FakePayments } from './fake';
import { isPaymentProvider, type PaymentMethodKind, type PaymentProviderName } from './provider';

const shell = (title: string, inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
  `<body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #f7f8fa; margin: 0;">` +
  `<main style="max-width: 440px; margin: 10vh auto; background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 28px 30px;">${inner}</main></body></html>`;

const problem = (reply: FastifyReply, body: string) =>
  reply
    .code(400)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      shell(
        'That payment link doesn’t work',
        `<h1 style="font-size: 18px; margin: 0 0 8px;">That payment link doesn’t work</h1>` +
          `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0;">${escapeHtml(body)}</p>`,
      ),
    );

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface PayQuery {
  provider?: string;
  account?: string;
  amount?: string;
  intent?: string;
  return?: string;
  methods?: string;
  instrument?: string;
  method?: string;
  decision?: string;
}

interface CardQuery {
  session?: string;
  return?: string;
  instrument?: string;
  decision?: string;
}

const methodOf = (value: string | undefined): PaymentMethodKind =>
  value === 'ach' ? 'ach' : 'card';

export function registerFakePaymentRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const fake: FakePayments | null = deps.payments.fake;
  if (!fake) return;

  /** Only back to this server or the app: a stand-in is still not an open redirect. */
  const safeReturn = (value: string | undefined): string | null => {
    if (!value) return null;
    const allowed = [deps.webUrl, deps.publicUrl];
    return allowed.some((base) => value.startsWith(`${base}/`) || value === base) ? value : null;
  };

  const back = (reply: FastifyReply, url: string, params: Record<string, string>) => {
    const target = new URL(url);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return reply
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .redirect(target.toString(), 302);
  };

  const hidden = (k: string, v: string) =>
    `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`;

  app.get('/payments/fake/pay', async (req, reply) => {
    const q = req.query as PayQuery;
    if (!q.provider || !isPaymentProvider(q.provider) || !q.account)
      return problem(reply, 'Go back and start the payment again.');
    const provider = q.provider as PaymentProviderName;
    const intent = q.intent ? fake.page.intent(q.intent) : null;
    const amount = intent?.amountCents ?? Number(q.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 1) return problem(reply, 'There is no amount to pay.');
    if (q.intent && !intent) return problem(reply, 'That payment has already been taken.');
    const methods = (q.methods ?? 'card')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m === 'card' || m === 'ach');
    const name = provider === 'stripe' ? 'Stripe' : 'Square';
    const choice =
      methods.includes('ach') && methods.includes('card')
        ? `<fieldset style="border: 0; padding: 0; margin: 0 0 14px;">` +
          `<legend style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">How to pay</legend>` +
          `<label style="display: block; font-size: 14px; margin-bottom: 4px;"><input type="radio" name="method" value="ach" checked> Bank transfer</label>` +
          `<label style="display: block; font-size: 14px;"><input type="radio" name="method" value="card"> Card</label>` +
          `</fieldset>`
        : hidden('method', methods[0] ?? 'card');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        shell(
          `Pay ${money(amount)}`,
          `<h1 style="font-size: 18px; margin: 0 0 6px;">Pay ${escapeHtml(money(amount))}</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">` +
            `A stand-in for ${escapeHtml(name)}’s payment page on this development server. No real money moves.</p>` +
            `<form method="post" action="/payments/fake/pay">` +
            hidden('provider', provider) +
            hidden('account', q.account) +
            hidden('amount', String(amount)) +
            (q.intent ? hidden('intent', q.intent) : '') +
            (q.return ? hidden('return', q.return) : '') +
            choice +
            `<label for="instrument" style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">Card or account number</label>` +
            `<input id="instrument" name="instrument" inputmode="numeric" autocomplete="off" required value="${escapeHtml(FAKE_CARDS.succeeds)}" ` +
            `style="width: 100%; box-sizing: border-box; height: 38px; padding: 0 10px; border: 1px solid #c9ced6; border-radius: 8px; font-size: 15px;">` +
            `<p style="font-size: 12px; line-height: 1.6; color: #5b616a; margin: 10px 0 0;">` +
            `Goes through: ${escapeHtml(FAKE_CARDS.succeeds)}<br>` +
            `Declined: ${escapeHtml(FAKE_CARDS.declines)}<br>` +
            `Fails when a plan bills it: ${escapeHtml(FAKE_CARDS.failsOffSession)}<br>` +
            `Can be disputed: ${escapeHtml(FAKE_CARDS.disputes)}<br>` +
            `Bank account that settles later: ${escapeHtml(FAKE_BANK.settles)}</p>` +
            `<div style="display: flex; gap: 8px; margin-top: 18px;">` +
            `<button type="submit" name="decision" value="pay" data-testid="fake-pay" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Pay ${escapeHtml(money(amount))}</button>` +
            `<button type="submit" name="decision" value="cancel" formnovalidate data-testid="fake-cancel" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
            `</div></form>`,
        ),
      );
  });

  /**
   * Putting a card on HandsFreeOS's own balance, in place of Stripe's hosted page. The same two ends as the
   * real one: a session it was opened for, and a return address it sends them back to with `?card=` saying
   * which session — or that nobody finished it.
   */
  app.get('/payments/fake/card', async (req, reply) => {
    const q = req.query as CardQuery;
    const sessionRef = q.session ?? '';
    if (!sessionRef || !fake.page.cardSession(sessionRef))
      return problem(reply, 'Go back and start adding the card again.');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        shell(
          'Add a card',
          `<h1 style="font-size: 18px; margin: 0 0 6px;">Add a card</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">` +
            `A stand-in for Stripe’s page on this development server. The card is kept on HandsFreeOS’s own ` +
            `account for this business: its balance, or its partner payouts. No real money moves.</p>` +
            `<form method="post" action="/payments/fake/card">` +
            hidden('session', sessionRef) +
            (q.return ? hidden('return', q.return) : '') +
            `<label for="instrument" style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">Card number</label>` +
            `<input id="instrument" name="instrument" inputmode="numeric" autocomplete="off" required value="${escapeHtml(FAKE_CARDS.succeeds)}" ` +
            `style="width: 100%; box-sizing: border-box; height: 38px; padding: 0 10px; border: 1px solid #c9ced6; border-radius: 8px; font-size: 15px;">` +
            `<p style="font-size: 12px; line-height: 1.6; color: #5b616a; margin: 10px 0 0;">` +
            `Goes through: ${escapeHtml(FAKE_CARDS.succeeds)}<br>` +
            `Declined: ${escapeHtml(FAKE_CARDS.declines)}<br>` +
            `Fails when the balance tops itself up: ${escapeHtml(FAKE_CARDS.failsOffSession)}</p>` +
            `<div style="display: flex; gap: 8px; margin-top: 18px;">` +
            `<button type="submit" name="decision" value="save" data-testid="fake-save-card" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Save the card</button>` +
            `<button type="submit" name="decision" value="cancel" formnovalidate data-testid="fake-cancel-card" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
            `</div></form>`,
        ),
      );
  });

  app.post('/payments/fake/card', async (req, reply) => {
    const b = (req.body ?? {}) as CardQuery;
    const sessionRef = b.session ?? '';
    if (!sessionRef || !fake.page.cardSession(sessionRef))
      return problem(reply, 'Go back and start adding the card again.');
    const returnUrl = safeReturn(b.return);
    // Nothing typed: the session stays empty, and the route that reads it back says so in words.
    if (b.decision === 'cancel')
      return returnUrl
        ? back(reply, returnUrl, { card: 'cancelled' })
        : problem(reply, 'Nothing was saved.');
    if (!b.instrument) return problem(reply, 'There was no card number.');
    fake.page.saveCard({ sessionRef, instrument: b.instrument });
    return returnUrl
      ? back(reply, returnUrl, { card: sessionRef })
      : problem(reply, 'The card was saved, but there is nowhere to go back to.');
  });

  /**
   * A partner setting up payouts, in place of Stripe's Express form (the partners plan's stage 3): finishing it
   * makes their account ready, or not, and Stripe's `account.updated` goes to our Connect endpoint as it would.
   */
  app.get('/payments/fake/express', async (req, reply) => {
    const q = req.query as { account?: string; return?: string; dashboard?: string };
    const account = fake.page.payoutAccount(q.account ?? '');
    if (!account) return problem(reply, 'Go back and start setting up payouts again.');
    if (q.dashboard)
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          shell(
            'Your payouts',
            `<h1 style="font-size: 18px; margin: 0 0 6px;">Your payouts</h1>` +
              `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0;">` +
              `A stand-in for Stripe’s Express dashboard on this development server. No real money moves.</p>`,
          ),
        );
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        shell(
          'Set up payouts',
          `<h1 style="font-size: 18px; margin: 0 0 6px;">Set up payouts</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">` +
            `A stand-in for Stripe’s form on this development server. Nothing is asked for and no real money ` +
            `moves.</p>` +
            `<form method="post" action="/payments/fake/express">` +
            hidden('account', account.accountRef) +
            (q.return ? hidden('return', q.return) : '') +
            `<div style="display: flex; gap: 8px;">` +
            `<button type="submit" name="decision" value="ready" data-testid="fake-finish-payouts" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Finish</button>` +
            `<button type="submit" name="decision" value="later" data-testid="fake-later-payouts" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Finish later</button>` +
            `</div></form>`,
        ),
      );
  });

  app.post('/payments/fake/express', async (req, reply) => {
    const b = (req.body ?? {}) as { account?: string; return?: string; decision?: string };
    if (!fake.page.payoutAccount(b.account ?? ''))
      return problem(reply, 'Go back and start setting up payouts again.');
    if (b.decision === 'ready') await fake.finishPayoutAccount(b.account!);
    const returnUrl = safeReturn(b.return);
    return returnUrl
      ? back(reply, returnUrl, {})
      : problem(reply, 'Done, but there is nowhere to go back to.');
  });

  app.post('/payments/fake/pay', async (req, reply) => {
    const b = (req.body ?? {}) as PayQuery;
    if (!b.provider || !isPaymentProvider(b.provider) || !b.account)
      return problem(reply, 'Go back and start the payment again.');
    const returnUrl = safeReturn(b.return);
    if (b.decision === 'cancel')
      return returnUrl
        ? back(reply, returnUrl, { payment: 'cancelled' })
        : problem(reply, 'The payment was cancelled.');
    const instrument = String(b.instrument ?? '').trim();
    const method = methodOf(b.method);
    if (!instrument) return problem(reply, 'There was no card or account number.');

    // Confirm in the browser: the intent already exists, and paying settles it.
    if (b.intent) {
      const charge = await fake.page.confirm({
        providerPaymentId: b.intent,
        instrument,
        method,
      });
      if (!charge) return problem(reply, 'That payment has already been taken.');
      return returnUrl
        ? back(reply, returnUrl, { payment: charge.id, result: charge.status })
        : reply
            .type('text/html; charset=utf-8')
            .header('cache-control', 'no-store')
            .send(
              shell(
                'Done',
                `<h1 style="font-size: 18px; margin: 0 0 8px;">${escapeHtml(charge.status)}</h1>` +
                  `<p style="font-size: 14px; color: #5b616a; margin: 0;">${escapeHtml(charge.id)}</p>`,
              ),
            );
    }

    // Tokenise, then charge: the page only mints the token, exactly as a browser SDK does.
    const token = fake.page.tokenise({ instrument, method });
    return returnUrl
      ? back(reply, returnUrl, { token, method })
      : reply
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            shell(
              'Card ready',
              `<p style="font-size: 14px; color: #5b616a; margin: 0;">${escapeHtml(token)}</p>`,
            ),
          );
  });

  /**
   * Our own Checkout page (0093): a founding seat, paid for in HandsFreeOS's account rather than a business's.
   * Pay or give up; either way back to the app, as Stripe's hosted page does. Paying posts the signed event to
   * our own account's endpoint, which is the only thing that turns the seat on.
   */
  app.get<{ Params: { ref: string } }>('/payments/fake/checkout/:ref', async (req, reply) => {
    const page = fake.checkouts().find((p) => p.sessionRef === req.params.ref);
    if (!page || page.status !== 'open')
      return problem(reply, 'This payment page has already been used, or it ran out.');
    const action = `/payments/fake/checkout/${encodeURIComponent(page.sessionRef)}`;
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        shell(
          `Pay ${money(page.amountCents)}`,
          `<h1 style="font-size: 18px; margin: 0 0 6px;">Pay ${escapeHtml(money(page.amountCents))}</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">` +
            `${escapeHtml(page.productName)}. A stand-in for Stripe Checkout on this development server. No real money moves.</p>` +
            `<form method="post" action="${escapeHtml(action)}">` +
            `<div style="display: flex; gap: 8px;">` +
            `<button type="submit" name="decision" value="pay" data-testid="fake-checkout-pay" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Pay ${escapeHtml(money(page.amountCents))}</button>` +
            `<button type="submit" name="decision" value="cancel" data-testid="fake-checkout-cancel" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
            `</div></form>`,
        ),
      );
  });

  app.post<{ Params: { ref: string } }>('/payments/fake/checkout/:ref', async (req, reply) => {
    const page = fake.checkouts().find((p) => p.sessionRef === req.params.ref);
    if (!page) return problem(reply, 'Go back and start the payment again.');
    const decision = ((req.body ?? {}) as { decision?: string }).decision;
    if (decision === 'pay') await fake.payCheckout(page.sessionRef);
    const to = safeReturn(decision === 'pay' ? page.successUrl : page.cancelUrl) ?? deps.webUrl;
    return reply
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .redirect(to, 302);
  });
}
