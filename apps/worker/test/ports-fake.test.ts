/**
 * M17: the fake carrier's side of moving a number, with no database anywhere near it.
 *
 * The parts of porting that can be wrong without a business ever being involved: what the fake carrier does
 * with a submission, and what the three magic suffixes mean. It exists so `ports.test.ts` — which needs a
 * database and so cannot run everywhere — is not the only thing standing between a change here and a
 * business's number.
 *
 * The suffixes are the convention `buyNumber` already uses, said once here so a reader of a port test does
 * not have to go and find it:
 *
 *   …0000  the losing carrier says no
 *   …0001  the losing carrier sits on it forever
 *   any other  it goes through once `approvalMs` has passed
 */
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { webhookUrls } from '../src/telephony/accounts';
import { createFakeTelephony, type FakeTelephony } from '../src/telephony/fake';
import type { ProviderAccount } from '../src/telephony/provider';

const log = pino({ level: 'silent' });

const account: ProviderAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  sid: 'ACfake',
  authToken: 'token',
  messagingServiceSid: 'MGfake',
  apiKeySid: null,
  apiKeySecret: null,
  twimlAppSid: null,
};

const submission = {
  accountNumber: '8675309',
  pin: '1234',
  authorizedBy: 'Dale Cooper',
  serviceAddress: '1 Main St, Twin Peaks, WA 98170',
};

describe('the fake carrier, on a number moving to us', () => {
  let fake: FakeTelephony;
  beforeEach(() => {
    fake = createFakeTelephony({ approvalMs: 0, callbacks: false, log });
  });

  it('takes a port and waits for the paperwork', async () => {
    const state = await fake.submitPort(account, {
      e164: '+17135550123',
      kind: 'full',
      submission,
      documentPaths: ['ws/port/p/f/loa.pdf'],
    });
    expect(state.status).toBe('submitted');
    expect(state.providerSid).toMatch(/^PO/);
    // Sent, not yet moving: the carrier is waiting for the signed authorisation, which is the next call.
    expect(state.providerStatus).toBe('PENDING_LOA');
    expect(fake.ports).toHaveLength(1);
    expect(fake.ports[0]!.kind).toBe('full');
  });

  it('records each paper against the port it belongs to', async () => {
    const state = await fake.submitPort(account, {
      e164: '+17135550123',
      kind: 'hosted_messaging',
      submission,
      documentPaths: [],
    });
    await fake.uploadPortDocument(account, {
      portSid: state.providerSid,
      name: 'authorisation.pdf',
      contentType: 'application/pdf',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(fake.portDocuments).toEqual([{ portSid: state.providerSid, name: 'authorisation.pdf' }]);
  });

  it('completes a port once the carrier has had its time, and names the day', async () => {
    const state = await fake.submitPort(account, {
      e164: '+17135550123',
      kind: 'full',
      submission,
      documentPaths: [],
    });
    const after = await fake.fetchPort(account, state.providerSid);
    expect(after.status).toBe('complete');
    expect(after.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.rejectionReason).toBeNull();
  });

  it('turns down a number ending 0000, and says why in words a business can act on', async () => {
    const state = await fake.submitPort(account, {
      e164: '+17135550000',
      kind: 'full',
      submission,
      documentPaths: [],
    });
    const after = await fake.fetchPort(account, state.providerSid);
    expect(after.status).toBe('rejected');
    expect(after.rejectionReason).toMatch(/account number or PIN/i);
  });

  it('leaves a number ending 0001 with the carrier however long it waits', async () => {
    const state = await fake.submitPort(account, {
      e164: '+17135550001',
      kind: 'hosted_messaging',
      submission,
      documentPaths: [],
    });
    for (let i = 0; i < 3; i++) {
      const after = await fake.fetchPort(account, state.providerSid);
      expect(after.status).toBe('carrier_review');
      expect(after.scheduledFor).toBeNull();
    }
  });

  it('calls a port off, and forgets it', async () => {
    const state = await fake.submitPort(account, {
      e164: '+17135550123',
      kind: 'full',
      submission,
      documentPaths: [],
    });
    await fake.cancelPort(account, state.providerSid);
    expect(fake.portsCancelled).toEqual([state.providerSid]);
  });

  it('points a number that landed at our webhooks, which a bought one never needs', async () => {
    const urls = webhookUrls('https://hooks.worker.test');
    await fake.configureNumber(account, 'PN123', urls);
    expect(fake.configured).toEqual(['PN123']);
    // Buying one configures it in the same breath, so it is deliberately absent from this list.
    await fake.buyNumber(account, { e164: '+17135550123', urls });
    expect(fake.configured).toEqual(['PN123']);
  });
});
