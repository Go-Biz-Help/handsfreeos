import type { CmaPage } from '@hfos/core/addons/realestate/cma';
import type { OffersCompareView, OffersView } from '@hfos/core/addons/realestate/views/offers';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { change } from '@/changes';
import { toast } from '@/components/ui/toast';

import type { BuyerDeal } from '../buyer-kit';
import { CmaBody } from '../cma';
import { OfferBody, OffersBody, OfferSummaryBody } from '../offers';
import { DEAL, id, NOW, TODAY, TZ, WS } from './buyer-fixtures';

/**
 * Offers and the CMA (board 84): offers with the clock on each answer and the seller's net, one offer's versions,
 * its one-page summary with what the seller answered, and a CMA that reads with no signal. Writing a counter, sharing
 * the summary, finding comps and the AI's summary need signal.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return {
    change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
    changes: { addPhoto: jest.fn() },
    newId: jest.fn(() => '99999999-9999-4999-8999-999999999999'),
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));

const MARIA = '33333333-3333-4333-8333-333333333333';
const LISTING: BuyerDeal = {
  id: DEAL,
  name: 'Alvarez listing',
  side: 'listing',
  full: true,
  clients: [{ personId: MARIA, name: 'Maria Alvarez' }],
  who: 'Maria',
};
const CTX = { now: NOW, today: TODAY, timeZone: TZ };
const SIX_PM = '2026-10-03T23:00:00.000Z';

type Offer = OffersView['offers'][number];
type Version = Offer['versions'][number];

function version(over: Partial<Version>): Version {
  return {
    id: id(100),
    number: 1,
    side: 'them',
    at: '2026-10-01T00:15:00.000Z',
    priceCents: 48_500_000,
    emdCents: 500_000,
    emdDays: null,
    sellerCreditCents: 300_000,
    inspectionDays: 5,
    loanType: 'conventional',
    financingDays: null,
    appraisalContingency: null,
    closingDate: '2026-11-06',
    otherTerms: null,
    downPaymentPct: 20,
    homeSaleContingency: null,
    escalationCapCents: null,
    escalationStepCents: null,
    possession: null,
    buyerAgentFeeBp: null,
    buyerAgentFeeCents: null,
    respondBy: SIX_PM,
    note: null,
    document: null,
    ...over,
  };
}
function offer(over: Partial<Offer>): Offer {
  return {
    id: id(200),
    number: 1,
    homeId: null,
    buyerNames: 'Ada Okafor',
    address: '2207 Juniper Trail, Austin, TX',
    status: 'waiting_us',
    theirAgentName: 'Tess Brown',
    theirBrokerage: null,
    theirEmail: null,
    theirPhone: null,
    versions: [
      version({}),
      version({ id: id(101), number: 2, at: '2026-10-01T15:02:00.000Z', priceCents: 49_500_000 }),
    ],
    acceptedVersionId: null,
    endedAt: null,
    endedReason: null,
    clock: {
      waitingOn: 'us',
      respondBy: SIX_PM,
      words: 'Due Sat, Oct 3 at 6:00 PM · 7 h 18 min left',
    },
    shared: { versionId: id(101), at: '2026-10-03T15:10:00.000Z', current: true },
    summary: { title: 'The offer', note: 'A summary.', lines: [], next: 'Next.' },
    ...over,
  };
}
const OKAFOR = offer({});
const BROOKS = offer({
  id: id(201),
  number: 2,
  buyerNames: 'Jo Brooks',
  versions: [
    version({
      id: id(110),
      priceCents: 48_900_000,
      loanType: 'cash',
      downPaymentPct: null,
      inspectionDays: 0,
      closingDate: '2026-10-22',
      sellerCreditCents: 0,
    }),
  ],
  shared: null,
});
const SMITH = offer({
  id: id(202),
  number: 3,
  buyerNames: 'Pat Smith',
  status: 'accepted',
  versions: [
    version({ id: id(120) }),
    version({ id: id(121), number: 2 }),
    version({ id: id(122), number: 3, priceCents: 41_200_000 }),
  ],
  acceptedVersionId: id(122),
  endedAt: '2026-09-24T18:00:00.000Z',
  clock: null,
});
const row = (o: Offer, net: number, closingDate: string): OffersCompareView['rows'][number] => ({
  offerId: o.id,
  number: o.number,
  buyers: o.buyerNames,
  agent: null,
  brokerage: null,
  status: o.status,
  versionId: o.versions.at(-1)!.id,
  versionNumber: o.versions.length,
  priceCents: o.versions.at(-1)!.priceCents,
  paying: 'Conventional · 20% down',
  emdCents: null,
  sellerCreditCents: 0,
  buyerAgentFee: null,
  inspection: null,
  financing: null,
  homeSale: null,
  escalation: null,
  closingDate,
  possession: null,
  respondBy: SIX_PM,
  net: { lines: [], netCents: net },
  best: false,
});
const COMPARE: OffersCompareView = {
  dealId: DEAL,
  figures: null,
  figureHistory: [],
  rows: [row(OKAFOR, 46_124_000, '2026-11-06'), row(BROOKS, 45_898_000, '2026-10-22')],
  shared: null,
  choices: [
    {
      offerId: OKAFOR.id,
      name: 'Maria',
      choice: 'talk',
      words: null,
      at: '2026-10-03T15:31:00.000Z',
    },
  ],
};

beforeEach(() => {
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  jest.mocked(change).mockClear();
  mockOnline = true;
});

describe('offers', () => {
  it('gives each the clock on its answer and the seller’s net, as the board does', async () => {
    await render(
      <OffersBody
        workspaceId={WS}
        deal={LISTING}
        offers={[OKAFOR, BROOKS, SMITH]}
        compare={COMPARE}
        ctx={CTX}
      />,
    );
    expect(screen.getByText('Alvarez listing · 2 offers in')).toBeTruthy();
    expect(screen.getByText('Okafor · $495,000')).toBeTruthy();
    expect(screen.getAllByText('Answer by 6:00 PM')).toHaveLength(2);
    expect(screen.getByText('Conventional, 20% down · closes Nov 6 · option 5 days')).toBeTruthy();
    expect(screen.getByTestId(`re-offer-net-${OKAFOR.id}`)).toHaveTextContent(
      'Net to Maria: $461,240',
    );
    expect(screen.getByText('Brooks · $489,000')).toBeTruthy();
    expect(screen.getByText('Cash · closes Oct 22 · no option period')).toBeTruthy();
    expect(screen.getByTestId(`re-offer-net-${BROOKS.id}`)).toHaveTextContent(
      'Net to Maria: $458,980',
    );
    expect(screen.getByText('Side by side')).toBeTruthy();
    expect(screen.getByText('Smith · v3 accepted')).toBeTruthy();
    expect(screen.getByText('$412,000 · Sep 24')).toBeTruthy();
  });
});

describe('an offer', () => {
  it('shows its terms, what changed, and every version', async () => {
    await render(<OfferBody workspaceId={WS} deal={LISTING} offer={OKAFOR} ctx={CTX} />);
    expect(screen.getByText('Okafor · v2')).toBeTruthy();
    expect(screen.getByTestId('re-offer-badge')).toHaveTextContent('Countered');
    expect(screen.getByText('$495,000 (v1 $485,000)')).toBeTruthy();
    expect(screen.getByText('$5,000')).toBeTruthy();
    expect(screen.getByText('Conventional · 20% down')).toBeTruthy();
    expect(screen.getByText('5 days')).toBeTruthy();
    expect(screen.getByText('Nov 6')).toBeTruthy();
    expect(screen.getByText('$3,000 toward closing costs')).toBeTruthy();
    expect(screen.getByText('v2 · their counter')).toBeTruthy();
    expect(screen.getByText('Oct 1, 10:02 AM')).toBeTruthy();
    expect(screen.getByText('v1 · first offer')).toBeTruthy();
    expect(screen.getByText('Sep 30, 7:15 PM')).toBeTruthy();
    expect(
      screen.getByText(
        'Writing a counter needs signal; it goes to the other agent and the seller’s portal.',
      ),
    ).toBeTruthy();
  });

  it('writes a counter only with signal', async () => {
    mockOnline = false;
    const drawn = await render(
      <OfferBody workspaceId={WS} deal={LISTING} offer={OKAFOR} ctx={CTX} />,
    );
    expect(screen.getByTestId('re-offer-counter')).toHaveTextContent('Needs signal');
    mockOnline = true;
    await drawn.rerender(<OfferBody workspaceId={WS} deal={LISTING} offer={OKAFOR} ctx={CTX} />);
    await fireEvent.press(screen.getByTestId('re-offer-counter'));
    await fireEvent.changeText(screen.getByTestId('re-counter-price'), '490,000');
    await fireEvent.press(screen.getByTestId('re-counter-send'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    const [name, input] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.offer.add_version');
    expect(input).toMatchObject({
      workspaceId: WS,
      offerId: OKAFOR.id,
      side: 'us',
      terms: {
        priceCents: 49_000_000,
        emdCents: 500_000,
        sellerCreditCents: 300_000,
        inspectionDays: 5,
        loanType: 'conventional',
        closingDate: '2026-11-06',
        downPaymentPct: 20,
      },
      respondBy: expect.any(String),
    });
  });
});

describe('its summary', () => {
  it('reads as the seller sees it, with what they answered, and calls them', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(
      <OfferSummaryBody
        workspaceId={WS}
        deal={LISTING}
        offer={OKAFOR}
        offers={[OKAFOR, BROOKS]}
        compare={COMPARE}
        phone="(512) 555-0100"
        ctx={CTX}
        editable
      />,
    );
    expect(screen.getByText('Okafor offer, in one page')).toBeTruthy();
    expect(screen.getByTestId('re-summary-for')).toHaveTextContent(
      'For Maria Alvarez · in Maria’s portal since 10:10 AM',
    );
    expect(screen.getByText('You’d net')).toBeTruthy();
    expect(screen.getByText('$461,240')).toBeTruthy();
    expect(screen.getByText('Nov 6 · 34 days')).toBeTruthy();
    expect(screen.getByText('Financing and a 5-day option')).toBeTruthy();
    expect(screen.getByText('Versus Brooks')).toBeTruthy();
    expect(screen.getByText('+$2,260 net, 15 days later')).toBeTruthy();
    expect(screen.getByTestId('re-summary-choice')).toHaveTextContent(
      'Maria said: “Let’s talk” at 10:31 AM',
    );
    await fireEvent.press(screen.getByTestId('re-summary-call'));
    expect(open).toHaveBeenCalledWith('tel:5125550100');
    expect(screen.queryByTestId('re-summary-share')).toBeNull();
  });
});

describe('the CMA', () => {
  const comp = (
    n: number,
    address: string,
    soldOn: string,
    price: number,
    sqft: number,
    miles: number,
  ) => ({
    id: id(n),
    address,
    priceCents: price,
    status: 'sold' as const,
    soldOn,
    beds: 3,
    baths: 2,
    sqft,
    yearBuilt: 2001,
    distanceMiles: miles,
    adjustments: [],
    used: true,
    note: null,
    source: 'mls' as const,
    mls: {
      mlsNumber: `ACT-${n}`,
      sourceWords: 'From the MLS (Unlock MLS, through Repliers)',
      photoUrl: null,
      courtesy: null,
      notice: null,
    },
    valueCents: price,
    adjustmentCents: 0,
    weight: 1,
    counted: true,
    why: null,
    warnings: [],
  });
  const CMA: CmaPage = {
    id: id(300),
    dealId: DEAL,
    homeId: null,
    number: 1,
    status: 'draft',
    asOf: '2026-09-22',
    method: 'Adjusted price per square foot, recent sales weighted more.',
    subject: {
      address: '2207 Juniper Trail',
      beds: 3,
      baths: 2,
      sqft: 1900,
      listPriceCents: null,
      yearBuilt: 2000,
    },
    comps: [
      comp(301, '2119 Juniper Trail, Austin, TX', '2026-08-28', 48_200_000, 1880, 0.1),
      comp(302, '44 Cedar Elm, Austin, TX', '2026-07-30', 49_500_000, 2010, 0.4),
      comp(303, '8 Oak Shade, Austin, TX', '2026-09-12', 47_150_000, 1790, 0.6),
    ],
    range: {
      lowCents: 47_800_000,
      likelyCents: 48_700_000,
      highCents: 49_600_000,
      perSqftCents: 25_600,
      counted: 3,
    },
    missing: null,
    summary: { state: 'none', text: null, failure: null, byAi: false, unsupportedAmounts: [] },
    findComps: { state: 'found', words: null, asked: null, at: null },
    finalizedAt: null,
    sharedAt: null,
    createdAt: '2026-09-22T15:00:00.000Z',
  };

  it('reads with no signal; finding comps and the summary wait for it', async () => {
    mockOnline = false;
    const drawn = await render(<CmaBody workspaceId={WS} cma={CMA} today={TODAY} editable />);
    expect(screen.getByText('Suggested range')).toBeTruthy();
    expect(screen.getByTestId('re-cma-from')).toHaveTextContent('From 3 MLS comps');
    expect(screen.getByTestId('re-cma-range')).toHaveTextContent('$478,000 – $496,000');
    expect(screen.getByText('2119 Juniper Trail')).toBeTruthy();
    expect(screen.getByText('Sold Aug 28 · $482,000 · 1,880 sq ft')).toBeTruthy();
    expect(screen.getByText('0.1 mi')).toBeTruthy();
    expect(screen.getByTestId('re-cma-source')).toHaveTextContent(
      'Sold data from the MLS (Unlock MLS, through Repliers) · verify it.',
    );
    expect(
      screen.getByText(
        'Finding comps and writing the summary need signal; the CMA you made reads anywhere.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('re-cma-find')).toHaveTextContent('Needs signal');
    mockOnline = true;
    await drawn.rerender(<CmaBody workspaceId={WS} cma={CMA} today={TODAY} editable />);
    await fireEvent.press(screen.getByTestId('re-cma-find'));
    await fireEvent.press(screen.getByTestId('re-cma-summary'));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(jest.mocked(change).mock.calls.map(([n, i]) => [n, i])).toEqual([
      ['realestate.cma.find_comps', { workspaceId: WS, cmaId: CMA.id }],
      ['realestate.cma.request_summary', { workspaceId: WS, cmaId: CMA.id }],
    ]);
  });
});
