/**
 * Sign-ups and checkouts told to Opinly (opinly.ts): what is sent and with which join keys, and that it never gets in
 * the way of the work it describes. The job is exercised against a stand-in database that answers one email, so
 * these need no real one.
 */
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@hfos/db/client';
import type { JobContext } from '../src/jobs';
import { createOpinly, queueOpinlyEvent, sendOpinlyEvent, type Opinly } from '../src/opinly';

const log = pino({ level: 'silent' });
const VISITOR = '6f1c0b9e-6a0e-4d57-9b5e-1f2a3b4c5d6e';

/** A queued sign-up for a real person: the database answers their email, whatever it is asked. */
const job = (opinly: Opinly | null) =>
  ({
    log,
    opinly,
    job: {
      payload: {
        event: 'sign_up',
        properties: { industry: 'plumbing' },
        externalEventId: 'sign_up:user-1',
        userId: 'user-1',
      },
    },
    scope: {},
    db: {
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: async () => [{ email: 'dana@example.com' }] }),
    },
  }) as unknown as JobContext;

describe('createOpinly', () => {
  it('is null without a key, so nothing is ever queued', () => {
    expect(createOpinly(null)).toBeNull();
    const opinly = createOpinly('sk-test');
    expect(typeof opinly?.track).toBe('function');
    // Without Supabase's admin key there is no visitor lookup: events go by email alone.
    expect(opinly?.visitorOf).toBeUndefined();
  });
});

describe('queueOpinlyEvent', () => {
  const event = {
    event: 'sign_up' as const,
    properties: {},
    externalEventId: 'sign_up:u1',
    userId: 'u1',
  };

  it('does nothing at all without Opinly', async () => {
    const tx = { transaction: vi.fn(), execute: vi.fn() } as unknown as Tx;
    await queueOpinlyEvent(
      { opinly: null, log },
      tx,
      { workspaceId: null, organizationId: null },
      event,
    );
    expect(tx.transaction).not.toHaveBeenCalled();
  });

  it('never fails the work it rides on', async () => {
    const tx = { transaction: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as Tx;
    const opinly: Opinly = { track: vi.fn() };
    await expect(
      queueOpinlyEvent({ opinly, log }, tx, { workspaceId: 'w', organizationId: 'o' }, event),
    ).resolves.toBeUndefined();
  });
});

describe('sendOpinlyEvent', () => {
  it('sends the event with the email and the visitor id the person signed up as', async () => {
    const track = vi.fn().mockResolvedValue({ recorded: true });
    const visitorOf = vi.fn().mockResolvedValue(VISITOR);
    await sendOpinlyEvent(job({ track, visitorOf }));
    expect(visitorOf).toHaveBeenCalledWith('user-1');
    expect(track).toHaveBeenCalledWith(
      'sign_up',
      { industry: 'plumbing' },
      { externalEventId: 'sign_up:user-1', email: 'dana@example.com', anonId: VISITOR },
    );
  });

  it('still sends by email when the visitor id cannot be read', async () => {
    const track = vi.fn().mockResolvedValue({ recorded: true });
    await sendOpinlyEvent(job({ track, visitorOf: vi.fn().mockRejectedValue(new Error('down')) }));
    expect(track).toHaveBeenCalledWith(
      'sign_up',
      { industry: 'plumbing' },
      { externalEventId: 'sign_up:user-1', email: 'dana@example.com' },
    );
  });

  it('throws when Opinly does not take it, so the job tries again later', async () => {
    const track = vi.fn().mockRejectedValue(new Error('status 503'));
    await expect(sendOpinlyEvent(job({ track }))).rejects.toThrow(/503/);
  });

  it('sends nothing once Opinly has been switched off', async () => {
    await expect(sendOpinlyEvent(job(null))).resolves.toBeUndefined();
  });
});
