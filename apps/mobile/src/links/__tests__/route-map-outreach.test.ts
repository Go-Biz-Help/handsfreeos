import { routeFor } from '../route-map';

/**
 * Social Outreach's links on the phone (decision 44): its page opens the phone's screen with the tab and the settings
 * its screens read, a playbook opens its screen, and the tabs it leaves to the web (Activity, Friends) open there.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('Social Outreach’s links', () => {
  it('open Waiting for you, and every tab the phone draws, on the phone', () => {
    expect(routeFor(`/app/w/${WS}/a/outreach?view=waiting`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach?view=waiting`,
      businessId: WS,
    });
    expect(routeFor(`/app/w/${WS}/a/outreach?view=chats&show=tagged&tag=Hot&page=2`)).toMatchObject(
      { kind: 'screen', href: `/app/w/${WS}/a/outreach?view=chats&show=tagged&tag=Hot` },
    );
    expect(routeFor(`/app/w/${WS}/a/outreach`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach`,
    });
    expect(routeFor(`/app/w/${WS}/a/outreach?view=never_contact`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach?view=never_contact`,
    });
  });

  it('open a playbook on the phone', () => {
    expect(routeFor(`/app/w/${WS}/a/outreach/playbooks/${PB}`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach/playbooks/${PB}`,
    });
  });

  it('leave Activity and Friends, and a new playbook, to the web', () => {
    for (const path of [
      `/app/w/${WS}/a/outreach?view=activity`,
      `/app/w/${WS}/a/outreach?view=activity&period=month`,
      `/app/w/${WS}/a/outreach?view=friends&show=requests`,
      `/app/w/${WS}/a/outreach/playbooks/new`,
    ])
      expect(routeFor(path)).toEqual({ kind: 'web', path, businessId: WS });
  });
});
