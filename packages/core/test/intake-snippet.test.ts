import { describe, expect, it } from 'vitest';

import { intakeApiUrl, intakeFormUrl } from '../src/crm/intake-snippet';

describe('the lead intake addresses', () => {
  it('put the path after the worker’s address, however many slashes it ends with', () => {
    expect(intakeFormUrl('https://worker.example.com', 'k1')).toBe(
      'https://worker.example.com/intake/f/k1',
    );
    expect(intakeFormUrl('https://worker.example.com///', 'k1')).toBe(
      'https://worker.example.com/intake/f/k1',
    );
    expect(intakeApiUrl('https://worker.example.com/')).toBe(
      'https://worker.example.com/v1/intake',
    );
  });

  it('stays quick on an address of nothing but slashes', () => {
    const started = performance.now();
    expect(intakeApiUrl('/'.repeat(100_000) + 'x')).toBe(`${'/'.repeat(100_000)}x/v1/intake`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
