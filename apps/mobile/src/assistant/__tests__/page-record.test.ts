import { askHref, pageRecordOf, screenPathOf } from '../page-record';

/**
 * The mark carries the screen's record to Ask HandsFreeOS on its address, so "text him that we're on our way" means
 * the customer whose screen it was pressed on. Which page holds which record is core's (and tested there); this is
 * the phone's half: the address it builds, and reading one back off it.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('the mark’s address', () => {
  it('carries the record the screen was showing, and nothing where there is none', () => {
    expect(askHref(WS, { type: 'person', id: ID })).toBe(`/app/w/${WS}/ask?type=person&id=${ID}`);
    expect(askHref(WS, null)).toBe(`/app/w/${WS}/ask`);
  });

  it('carries the screen itself too, so the Assistant knows which page or setting is open', () => {
    expect(askHref(WS, null, `/settings/calendars/${ID}`)).toBe(
      `/app/w/${WS}/ask?from=%2Fsettings%2Fcalendars%2F${ID}`,
    );
    expect(askHref(WS, { type: 'appointment', id: ID }, `/calendar?appt=${ID}`)).toBe(
      `/app/w/${WS}/ask?type=appointment&id=${ID}&from=%2Fcalendar%3Fappt%3D${ID}`,
    );
    expect(screenPathOf(`/settings/calendars/${ID}`)).toBe(`/settings/calendars/${ID}`);
    expect(screenPathOf(undefined)).toBe(null);
    expect(screenPathOf('settings')).toBe(null);
  });

  it('reads the record back, and refuses anything that isn’t one', () => {
    expect(pageRecordOf({ type: 'person', id: ID })).toEqual({ type: 'person', id: ID });
    expect(pageRecordOf({ type: 'conversation', id: ID })).toEqual({
      type: 'conversation',
      id: ID,
    });
    expect(pageRecordOf({})).toBe(null);
    expect(pageRecordOf({ type: 'person' })).toBe(null);
    expect(pageRecordOf({ type: 'nonsense', id: ID })).toBe(null);
    expect(pageRecordOf({ type: 'person', id: 'not-an-id' })).toBe(null);
  });
});
