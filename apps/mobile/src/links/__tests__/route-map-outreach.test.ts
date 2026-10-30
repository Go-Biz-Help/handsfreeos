import { routeFor } from '../route-map';

/**
 * Social Outreach's links on the phone (decision 44): its page opens the phone's screen with the tab and the settings
 * its screens read, a playbook opens its screen, and the old Activity, which it leaves to the web, opens there.
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
    // People's friends lists and Find people are the phone's too (decision 128).
    expect(routeFor(`/app/w/${WS}/a/outreach?view=friends&show=requests`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach?view=friends&show=requests`,
    });
    expect(routeFor(`/app/w/${WS}/a/outreach?view=find&net=instagram`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach?view=find&net=instagram`,
    });
  });

  it('open the code’s own screen from its notification, with the ask it’s for (decision 82)', () => {
    const ASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(routeFor(`/app/w/${WS}/a/outreach/?view=code&ask=${ASK}`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach?view=code&ask=${ASK}`,
      businessId: WS,
    });
  });

  it('open a group’s own page on the phone, with who of it (decision 103)', () => {
    const GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(
      routeFor(`/app/w/${WS}/a/outreach?view=groups&group=${GROUP}&show=not_reached`),
    ).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach?view=groups&show=not_reached&group=${GROUP}`,
    });
  });

  it('open a playbook on the phone', () => {
    expect(routeFor(`/app/w/${WS}/a/outreach/playbooks/${PB}`)).toMatchObject({
      kind: 'screen',
      href: `/app/w/${WS}/a/outreach/playbooks/${PB}`,
    });
  });

  it('leave Activity, and a new playbook, to the web', () => {
    for (const path of [
      `/app/w/${WS}/a/outreach?view=activity`,
      `/app/w/${WS}/a/outreach?view=activity&period=month`,
      `/app/w/${WS}/a/outreach/playbooks/new`,
    ])
      expect(routeFor(path)).toEqual({ kind: 'web', path, businessId: WS });
  });
});
