import { routeFor } from '../route-map';

/**
 * A build that has an add-on's screen opens it: the deal a push names, with the duty it points at, and only the
 * query the screen reads. The phone's first add-on screens (Real Estate Agent's deals) come in a later round; this
 * stands in for that build.
 */
jest.mock('../addon-screens', () => ({
  ADDON_SCREENS: new Set(['a/realestate/deals/:dealId']),
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DUTY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('an add-on screen the build has', () => {
  it('opens there, keeping the query it reads', () => {
    expect(routeFor(`/app/w/${WS}/a/realestate/deals/${DEAL}?duty=${DUTY}&x=1`)).toEqual({
      kind: 'screen',
      href: `/app/w/${WS}/a/realestate/deals/${DEAL}?duty=${DUTY}`,
      businessId: WS,
      later: null,
      params: { dealId: DEAL, duty: DUTY, x: '1' },
    });
  });

  it('leaves the add-on’s other pages to the web until their screens come', () => {
    expect(routeFor(`/app/w/${WS}/a/realestate/deals/${DEAL}/dates`)).toMatchObject({
      kind: 'web',
      later: `/app/w/${WS}/a/realestate/deals/${DEAL}/dates`,
    });
    expect(routeFor(`/app/w/${WS}/a/realestate/settings`)).toEqual({
      kind: 'web',
      path: `/app/w/${WS}/a/realestate/settings`,
      businessId: WS,
    });
  });
});
