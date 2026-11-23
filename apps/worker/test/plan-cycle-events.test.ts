/**
 * Reading a plan's cycle from each provider's event, in the shape the provider sends it today.
 *
 * - **Stripe** (the endpoint is on the version the worker pins, after `2025-03-31.basil`): the invoice names its plan
 *   under `parent.subscription_details.subscription`, no longer names its payment, and carries the period billed
 *   on its line. Only the old top-level `subscription` was read before 23 Nov 2026, so no Stripe cycle found its
 *   plan.
 * - **Square**: `invoice.payment_made` comes nested under `invoice`, naming its plan in `subscription_id`, the order
 *   it billed, and what was paid in its payment requests. It was read as if it were the plan. A refused card at a
 *   cycle is `invoice.scheduled_charge_failed`, which wasn't listened for at all.
 *
 * The payloads are Stripe's and Square's own reference examples, cut to the fields that matter.
 */
import { describe, expect, it } from 'vitest';
import { paymentKindOf, subscriptionFactsOf } from '../src/money/webhook-events';
import type { PaymentEvent } from '../src/payments/provider';

const event = (type: string, data: Record<string, unknown>): PaymentEvent => ({
  id: 'evt_1',
  type,
  accountRef: 'acct_1',
  createdAt: '2026-11-23T00:00:00.000Z',
  data,
});

describe('a Stripe cycle', () => {
  it('finds its plan, what was paid and the period billed on today’s invoice', () => {
    const facts = subscriptionFactsOf(
      event('invoice.paid', {
        id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
        object: 'invoice',
        amount_paid: 3139,
        status: 'paid',
        parent: {
          type: 'subscription_details',
          quote_details: null,
          subscription_details: { metadata: {}, subscription: 'sub_1MowQVLkdIwHu7ixeRlqHVzs' },
        },
        lines: {
          object: 'list',
          data: [
            {
              id: 'il_1',
              object: 'line_item',
              amount: 3139,
              period: { start: 1795392000, end: 1797984000 },
            },
          ],
        },
      }),
    );
    expect(facts).toMatchObject({
      providerSubscriptionId: 'sub_1MowQVLkdIwHu7ixeRlqHVzs',
      providerInvoiceId: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
      providerPaymentId: null,
      amountPaidCents: 3139,
      currentPeriodStart: new Date(1795392000 * 1000).toISOString(),
      currentPeriodEnd: new Date(1797984000 * 1000).toISOString(),
    });
  });

  it('still reads an invoice in the shape from before 2025', () => {
    const facts = subscriptionFactsOf(
      event('invoice.paid', {
        id: 'in_old',
        object: 'invoice',
        subscription: 'sub_old',
        payment_intent: 'pi_old',
        amount_paid: 2900,
      }),
    );
    expect(facts).toMatchObject({
      providerSubscriptionId: 'sub_old',
      providerPaymentId: 'pi_old',
      amountPaidCents: 2900,
    });
  });

  it('never takes an invoice’s own id for its plan', () => {
    expect(
      subscriptionFactsOf(event('invoice.paid', { id: 'in_alone', object: 'invoice' }))
        .providerSubscriptionId,
    ).toBeNull();
  });

  it('reads a plan’s period from its item, where Stripe keeps it now', () => {
    const facts = subscriptionFactsOf(
      event('customer.subscription.updated', {
        id: 'sub_1',
        object: 'subscription',
        status: 'active',
        items: {
          object: 'list',
          data: [{ id: 'si_1', current_period_start: 1795392000, current_period_end: 1797984000 }],
        },
      }),
    );
    expect(facts).toMatchObject({
      providerSubscriptionId: 'sub_1',
      currentPeriodStart: new Date(1795392000 * 1000).toISOString(),
      currentPeriodEnd: new Date(1797984000 * 1000).toISOString(),
    });
  });
});

describe('a Square cycle', () => {
  const invoice = (status: string, paidCents: number) => ({
    invoice: {
      id: 'inv:0-ChCHu2mZEabLeeHahQnXDjZQECY',
      version: 3,
      location_id: 'ES0RJRZYEC39A',
      order_id: 'CAISENgvlJ6jLWAzERDzjyHVybY',
      subscription_id: '9ba40961-995a-4a3d-8c53-048c40cafc13',
      payment_requests: [
        {
          uid: '2da7964f-f3d2-4f43-81e8-5aa220bf3355',
          request_type: 'BALANCE',
          computed_amount_money: { amount: 10000, currency: 'USD' },
          total_completed_amount_money: { amount: paidCents, currency: 'USD' },
        },
      ],
      status,
    },
  });

  it('finds its plan, the order that names its payment, and what was paid', () => {
    const facts = subscriptionFactsOf(event('invoice.payment_made', invoice('PAID', 10000)));
    expect(facts).toMatchObject({
      providerSubscriptionId: '9ba40961-995a-4a3d-8c53-048c40cafc13',
      providerInvoiceId: 'inv:0-ChCHu2mZEabLeeHahQnXDjZQECY',
      providerOrderId: 'CAISENgvlJ6jLWAzERDzjyHVybY',
      providerPaymentId: null,
      amountPaidCents: 10000,
    });
  });

  it('hears a card refused at a cycle', () => {
    expect(paymentKindOf('square', event('invoice.payment_made', {}))).toBe('invoice.paid');
    expect(paymentKindOf('square', event('invoice.scheduled_charge_failed', {}))).toBe(
      'invoice.payment_failed',
    );
    const facts = subscriptionFactsOf(
      event('invoice.scheduled_charge_failed', invoice('UNPAID', 0)),
    );
    expect(facts).toMatchObject({
      providerSubscriptionId: '9ba40961-995a-4a3d-8c53-048c40cafc13',
      amountPaidCents: null,
    });
  });
});
