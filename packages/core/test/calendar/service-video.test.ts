import { describe, expect, it } from 'vitest';
import { locationFor } from '../../src/calendar/booking';
import { parseConfig } from '../../src/calendar/index';

const SERVICE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const config = (overrides: Record<string, unknown>) =>
  parseConfig({
    version: 1,
    services: {
      mode: 'choice',
      items: [
        { serviceId: SERVICE, overrides },
        { serviceId: OTHER, overrides: {} },
      ],
    },
    locations: { options: [{ kind: 'virtual', video: 'google_meet', record: false }] },
  });

describe('a service’s own video link', () => {
  it('uses the Online place’s choice when the service has none', () => {
    const at = locationFor(config({}), 'virtual', undefined, OTHER);
    expect(at).toMatchObject({ video: 'google_meet', record: false });
  });

  it('makes a Zoom link and records for a service set to it', () => {
    const at = locationFor(config({ video: 'zoom', record: true }), 'virtual', undefined, SERVICE);
    expect(at).toMatchObject({ video: 'zoom', record: true });
  });

  it('makes no link for a service set to none, and doesn’t record', () => {
    const at = locationFor(config({ video: 'none', record: true }), 'virtual', undefined, SERVICE);
    expect(at).toMatchObject({ video: null, record: false });
  });

  it('records on the place’s link when the service only turns recording on', () => {
    const at = locationFor(config({ record: true }), 'virtual', undefined, SERVICE);
    expect(at).toMatchObject({ video: 'google_meet', record: true });
  });

  it('never makes a link when the booking isn’t online', () => {
    const at = locationFor(config({ video: 'zoom' }), 'phone', undefined, SERVICE);
    expect(at).toMatchObject({ video: null, record: false });
  });
});
