import { chooseBusiness, isKept, keptIds, type Business } from '../keep-rules';

const business = (id: string, name: string): Business => ({
  id,
  name,
  organizationId: 'org',
  organizationName: 'Go Biz Help',
  role: 'owner',
  timezone: 'America/Chicago',
});
const LS = business('ls', 'Lone Star HVAC & Roofing');
const BP = business('bp', 'Bayou Plumbing Co.');
const SR = business('sr', 'Summit Roofing');

describe('keeping businesses on the phone', () => {
  it('keeps the one opened last by default', () => {
    const choices = { lastOpened: 'ls', explicit: {} };
    expect(isKept(choices, 'ls')).toBe(true);
    expect(isKept(choices, 'bp')).toBe(false);
    expect(keptIds(choices, [LS, BP, SR])).toEqual(['ls']);
  });

  it('lets the person turn the last one off, and others on', () => {
    const choices = { lastOpened: 'ls', explicit: { ls: false, sr: true } };
    expect(keptIds(choices, [LS, BP, SR])).toEqual(['sr']);
  });

  it('stops keeping a business by default once another is opened', () => {
    expect(keptIds({ lastOpened: 'bp', explicit: {} }, [LS, BP, SR])).toEqual(['bp']);
    expect(keptIds({ lastOpened: 'bp', explicit: { ls: true } }, [LS, BP, SR])).toEqual([
      'ls',
      'bp',
    ]);
  });

  it('opens the last business, or the first when that one is gone', () => {
    expect(chooseBusiness([LS, BP], 'bp')).toBe(BP);
    expect(chooseBusiness([LS, BP], 'gone')).toBe(LS);
    expect(chooseBusiness([], null)).toBeNull();
  });
});
