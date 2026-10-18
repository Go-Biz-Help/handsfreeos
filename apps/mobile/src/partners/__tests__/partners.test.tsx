import { PARTNERS_WORDS as W } from '@hfos/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Share } from 'react-native';

import { PartnerCard } from '@/components/customers/partner-card';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';

import type { PartnerGetOut, PartnerRow, PartnersSettingsOut } from '../calls';
import { parseRate, PartnerBody, PartnersBody } from '../screens';

/**
 * Partners on the phone (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d): Settings → Partners shows how
 * partners are paid to read, with the way to change it on the web, and the partners with what they earned; a
 * partner's page pauses and ends them, gives them their own share, shares their link and sends them their page; and
 * a customer's Partner card makes them a partner and says who sent them. It all needs signal, so the API stands in.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PIA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PIA_PERSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER = ['records.read', 'records.write', 'outreach.use', 'partners.manage'];

const business = (permissions: string[]): Business => ({
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: 'America/Chicago',
  permissions,
});
const me = (permissions: string[]): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(permissions)],
  organizations: [],
  fetchedAt: 0,
});

const post = api.POST as unknown as jest.Mock;
let answers: Record<string, unknown>;
const sent = (path: string) =>
  post.mock.calls.filter((c) => c[0] === path).map((c) => (c[1] as { body: unknown }).body);

function wrap(element: React.ReactElement, permissions = OWNER) {
  post.mockImplementation(async (path: string) => ({
    data: answers[path] ?? {},
    response: new Response(null, { status: 200 }),
  }));
  return render(
    <BusinessProvider
      value={{
        userId: DALE,
        me: me(permissions),
        business: business(permissions),
        openSwitcher: () => undefined,
      }}
    >
      {element}
    </BusinessProvider>,
  );
}

const SETTINGS: PartnersSettingsOut = {
  settings: {
    rateBp: 1_200,
    terms: 'Paid on the 1st.',
    termsVersion: 2,
    smallestPayoutCents: 2_500,
    calendarId: null,
  },
  inUse: true,
  linkCalendar: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Drain checks' },
};

const EARNINGS = { earnedCents: 12_000, waitingCents: 12_000, payableCents: 0, heldCents: 0 };
const PARTNER: PartnerRow = {
  partnerId: PIA,
  personId: PIA_PERSON,
  name: 'Pia Partner',
  email: 'pia@example.test',
  status: 'active',
  rateBp: 1_200,
  ownRate: false,
  code: 'PbAbCd2345',
  linkPath: '/book/c/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee?ref=pa-PbAbCd2345',
  clients: 1,
  earnings: EARNINGS,
  termsAccepted: false,
  addedAt: '2026-10-01T15:00:00.000Z',
};
const GOT: PartnerGetOut = {
  partner: PARTNER,
  clients: [
    {
      referralId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      personId: CAL,
      name: 'Cal Client',
      how: 'by_hand',
      referredAt: '2026-10-02T15:00:00.000Z',
      firstPaidAt: '2026-10-03T15:00:00.000Z',
      monthsEndAt: '2027-10-03T15:00:00.000Z',
      earnedCents: 12_000,
    },
  ],
  commissions: [
    {
      commissionId: '12121212-1212-4212-8212-121212121212',
      kind: 'earned',
      amountCents: 12_000,
      baseCents: 100_000,
      rateBp: 1_200,
      earnedAt: '2026-10-03T15:00:00.000Z',
      payableAt: '2099-11-02T15:00:00.000Z',
      test: false,
      held: false,
      clientName: 'Cal Client',
      invoiceNumber: 'INV-1001',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  answers = {};
});

describe('Settings → Partners on the phone', () => {
  it('shows how partners are paid to read, with the way to change it on the web, and the partners', async () => {
    await wrap(<PartnersBody workspaceId={LONE_STAR} settings={SETTINGS} partners={[PARTNER]} />);
    const paid = screen.getByTestId('partners-paid');
    expect(within(paid).getByText('12%')).toBeTruthy();
    expect(within(paid).getByText('$25')).toBeTruthy();
    expect(within(paid).getByText('Drain checks')).toBeTruthy();
    expect(within(paid).getByText('Version 2')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('partners-change-on-web'));
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/settings/partners`);
    const row = screen.getByTestId('partners-row');
    expect(row).toHaveTextContent(/Pia Partner/);
    expect(row).toHaveTextContent(/12% · 1 client · Earned \$120 · Hasn’t accepted your terms yet/);
    await fireEvent.press(row);
    expect(String(jest.mocked(router.push).mock.calls.at(-1)?.[0])).toContain(
      `settings/partners/${PIA}`,
    );
  });

  it('says so when there are no partners yet', async () => {
    await wrap(<PartnersBody workspaceId={LONE_STAR} settings={SETTINGS} partners={[]} />);
    expect(screen.getByTestId('partners-empty')).toHaveTextContent(W.list.empty);
  });
});

describe('a partner’s page on the phone', () => {
  const body = (got: PartnerGetOut = GOT, onChanged = jest.fn()) => (
    <PartnerBody
      workspaceId={LONE_STAR}
      got={got}
      businessRateBp={1_200}
      hasTerms
      origin="https://lonestar.example"
      onChanged={onChanged}
    />
  );

  it('shares their link, sends their page, and lists what they earned and from whom', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await wrap(body());
    const link = `https://lonestar.example${PARTNER.linkPath}`;
    expect(screen.getByTestId('partner-link-url')).toHaveTextContent(link);
    expect(screen.getByTestId('partner-terms')).toHaveTextContent(W.partner.termsWaiting);
    await fireEvent.press(screen.getByTestId('partner-share-link'));
    expect(share).toHaveBeenCalledWith({ message: link, url: link });
    await fireEvent.press(screen.getByTestId('partner-send-page'));
    await waitFor(() =>
      expect(sent('/v1/commands/portal_access.give')).toEqual([
        { workspaceId: LONE_STAR, personId: PIA_PERSON },
      ]),
    );
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith('Sent to pia@example.test.'));
    const commission = screen.getByTestId('partner-commission');
    expect(commission).toHaveTextContent(/Cal Client · Invoice INV-1001/);
    expect(commission).toHaveTextContent(/12% of \$1,000 paid/);
    expect(screen.getByTestId('partner-clients')).toHaveTextContent(
      /Earning them a share until Oct 3, 2027/,
    );
  });

  it('pauses them, and ends them only once asked', async () => {
    const onChanged = jest.fn();
    await wrap(body(GOT, onChanged));
    await fireEvent.press(screen.getByTestId('partner-pause'));
    await waitFor(() =>
      expect(sent('/v1/commands/partner.update')).toEqual([
        { workspaceId: LONE_STAR, partnerId: PIA, status: 'paused' },
      ]),
    );
    expect(onChanged).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('partner-end'));
    expect(sent('/v1/commands/partner.update')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('partner-end-confirm'));
    await waitFor(() => expect(sent('/v1/commands/partner.update')).toHaveLength(2));
    expect(sent('/v1/commands/partner.update')[1]).toMatchObject({ status: 'ended' });
  });

  it('gives them their own share, or takes them back to the business’s', async () => {
    await wrap(body({ ...GOT, partner: { ...PARTNER, ownRate: true, rateBp: 1_500 } }));
    await fireEvent.press(screen.getByTestId('partner-rate'));
    await fireEvent.changeText(screen.getByTestId('partner-rate-input'), '12.5');
    await fireEvent.press(screen.getByTestId('partner-rate-save'));
    await waitFor(() =>
      expect(sent('/v1/commands/partner.update')).toEqual([
        { workspaceId: LONE_STAR, partnerId: PIA, rateBp: 1_250 },
      ]),
    );
    await fireEvent.press(screen.getByTestId('partner-rate'));
    await fireEvent.press(screen.getByTestId('partner-rate-default'));
    await waitFor(() => expect(sent('/v1/commands/partner.update')).toHaveLength(2));
    expect(sent('/v1/commands/partner.update')[1]).toEqual({
      workspaceId: LONE_STAR,
      partnerId: PIA,
      rateBp: null,
    });
    expect(parseRate('101')).toBeNull();
    expect(parseRate('0')).toBeNull();
    expect(parseRate('8.25%')).toBe(825);
  });

  it('says why their page can’t be sent without an email', async () => {
    await wrap(body({ ...GOT, partner: { ...PARTNER, email: null } }));
    expect(screen.queryByTestId('partner-send-page')).toBeNull();
    expect(screen.getByTestId('partner-page')).toHaveTextContent(
      /Pia Partner has no email address/,
    );
  });
});

describe('a customer’s Partner card on the phone', () => {
  const card = () => (
    <PartnerCard workspaceId={LONE_STAR} personId={CAL} name="Cal Client" archived={false} />
  );

  it('makes them a partner, and marks which partner sent them', async () => {
    answers['/v1/queries/partner.of_person'] = { inUse: true, partner: null, referredBy: null };
    answers['/v1/queries/partner.list'] = { partners: [PARTNER] };
    await wrap(card());
    await waitFor(() => expect(screen.getByTestId('partner-card')).toBeTruthy());
    expect(screen.getByTestId('partner-card-sent-by')).toHaveTextContent(W.card.nobody);
    await fireEvent.press(screen.getByTestId('partner-card-make'));
    await waitFor(() =>
      expect(sent('/v1/commands/partner.add')).toEqual([{ workspaceId: LONE_STAR, personId: CAL }]),
    );
    await fireEvent.press(screen.getByTestId('partner-card-change'));
    await fireEvent.press(await screen.findByTestId(`partner-card-pick-${PIA}`));
    await waitFor(() =>
      expect(sent('/v1/commands/partner.referral_set')).toEqual([
        { workspaceId: LONE_STAR, personId: CAL, partnerId: PIA },
      ]),
    );
  });

  it('isn’t there for someone who can’t manage partners', async () => {
    answers['/v1/queries/partner.of_person'] = { inUse: true, partner: null, referredBy: null };
    await wrap(card(), ['records.read', 'outreach.use']);
    expect(screen.queryByTestId('partner-card')).toBeNull();
    expect(sent('/v1/queries/partner.of_person')).toHaveLength(0);
  });
});
