import { greeting } from '../greeting';
import { businessMark, initials } from '../utils';

describe('marks and greetings', () => {
  it('draws business marks as the boards do', () => {
    expect(businessMark('Lone Star HVAC & Roofing')).toBe('LS');
    expect(businessMark('Bayou Plumbing Co.')).toBe('BP');
    expect(businessMark('Summit Roofing')).toBe('SR');
    expect(businessMark('Acme')).toBe('AC');
    expect(businessMark('  ')).toBe('?');
  });

  it('draws a person’s initials as the web does', () => {
    expect(initials('Dale Ramsey')).toBe('DR');
    expect(initials('Marco de la Villanueva')).toBe('MV');
    expect(initials('Cher')).toBe('CH');
  });

  it('greets in the business’s own time zone', () => {
    // 13:30 UTC is 8:30 AM in Chicago and 7:30 AM in Denver on Tue, Sep 22, 2026.
    const at = new Date('2026-09-22T13:30:00Z');
    expect(greeting('Dale', 'America/Chicago', at)).toBe('Good morning, Dale · Tue, Sep 22');
    expect(greeting('Dale', 'Pacific/Auckland', at)).toBe('Good morning, Dale · Wed, Sep 23');
    expect(greeting('', 'America/Chicago', new Date('2026-09-22T20:00:00Z'))).toBe(
      'Good afternoon · Tue, Sep 22',
    );
    expect(greeting('Dale', 'America/Chicago', new Date('2026-09-23T01:00:00Z'))).toBe(
      'Good evening, Dale · Tue, Sep 22',
    );
  });
});
