/**
 * The sealed handoff a sign-in's callback gives the app (SEC-M1, SEC-M7): only the worker can make one, it opens
 * only at the door it was made for, and only within the state's own ten minutes.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSealer } from '../src/crypto';
import { finishUrl, openHandoff, sealHandoff, type Handoff } from '../src/http/handoff';

const sealer = createSealer(randomBytes(32).toString('base64'));
const h: Handoff = {
  door: 'oauth',
  provider: 'stripe',
  stateHash: 'a'.repeat(64),
  code: 'ac_123',
  error: null,
  errorDescription: null,
};

describe('a sign-in handoff', () => {
  it('opens to what was sealed', () => {
    expect(openHandoff(sealer, sealHandoff(sealer, h), 'oauth')).toEqual(h);
  });

  it('never shows the provider’s code in the address it travels in', () => {
    const url = finishUrl('https://app.example', 'oauth', sealHandoff(sealer, h));
    expect(url).toMatch(/^https:\/\/app\.example\/app\/oauth\/finish\?door=oauth#/);
    expect(url).not.toContain('ac_123');
  });

  it('opens only at the door it was made for', () => {
    expect(openHandoff(sealer, sealHandoff(sealer, h), 'migration')).toBeNull();
  });

  it('lasts the state’s ten minutes and no longer', () => {
    const now = Date.now();
    const sealed = sealHandoff(sealer, h, now);
    expect(openHandoff(sealer, sealed, 'oauth', now + 9 * 60_000)).not.toBeNull();
    expect(openHandoff(sealer, sealed, 'oauth', now + 11 * 60_000)).toBeNull();
  });

  it('is refused when somebody else made it, or changed it', () => {
    const other = createSealer(randomBytes(32).toString('base64'));
    expect(openHandoff(sealer, sealHandoff(other, h), 'oauth')).toBeNull();
    const sealed = sealHandoff(sealer, h);
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(openHandoff(sealer, tampered, 'oauth')).toBeNull();
    expect(openHandoff(sealer, 'not a seal', 'oauth')).toBeNull();
  });

  it('is refused when it is some other sealed value of ours', () => {
    expect(
      openHandoff(sealer, sealer.seal(JSON.stringify({ accessToken: 'x' })), 'oauth'),
    ).toBeNull();
  });
});
