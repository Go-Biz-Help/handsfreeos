import { netEstimate } from '@hfos/core/addons/realestate/net';
import type {
  ListingDescriptionView,
  ListingFactLine,
  ListingMarketingView,
  ListingPricesView,
  ListingView,
} from '@hfos/core/addons/realestate/views/listing';
import type { OffersCompareView } from '@hfos/core/addons/realestate/views/offers';
import type { OpenHousesView, ShowingListView } from '@hfos/core/addons/realestate/views/showings';
import type { DutyVendorsView } from '@hfos/core/addons/realestate/views/vendors';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { change } from '@/changes';

import { DutyVendorsBody } from '../duty-vendors';
import {
  addListingPhoto,
  arrangeListingPhotos,
  decideShowing,
  proposePrice,
  saveNetSheet,
  signInVisitor,
} from '../listing-actions';
import { DescriptionBody } from '../listing-description';
import { factValue, ListingFactsBody } from '../listing-facts';
import { MarketingBody } from '../listing-marketing';
import { ListingPhotosBody, moved } from '../listing-photos';
import { PriceBody, PriceSheet } from '../listing-price';
import { netColumns, NetSheetBody } from '../net-sheet';
import { OpenHousesBody, VisitorSignIn } from '../open-houses';
import { ShowingsBody } from '../showings';

/**
 * The listing on the phone (boards 87–89): its facts and what the MLS said, photos taken on the spot, the
 * description's versions, the price and a change waiting on the seller, what's out, hosting an open house, the
 * seller's net, showings and a duty's vendor. Each part renders core's view as the board draws it, says what needs
 * signal, and sends each change with the command and input the API takes.
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
    change: jest.fn(async () => ({ id: 'change-1', queued: true })),
    changes: { addPhoto: jest.fn(async () => ({ id: 'upload-1' })) },
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
jest.mock('@/components/safety/check-in-sheet', () => ({ CheckInSheet: () => null }));
jest.mock('../deal-bits', () => ({ useReChanges: () => [] }));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ME = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '99999999-9999-4999-8999-999999999999';
const TZ = 'America/Chicago';
const TODAY = '2026-10-01';
const NOW = Date.parse('2026-10-03T18:44:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  mockOnline = true;
  jest.mocked(change).mockClear();
});

// ---------- facts and the MLS ----------

const LINES: ListingFactLine[] = [
  { key: 'beds', label: 'Bedrooms', words: '3', from: 'agent', mlsWords: '4' },
  { key: 'baths', label: 'Bathrooms', words: '2.5', from: 'mls', mlsWords: null },
  { key: 'year_built', label: 'Year built', words: '2004', from: 'mls', mlsWords: null },
  { key: 'hoa_monthly_cents', label: 'HOA a month', words: '$42', from: 'seller', mlsWords: null },
];
const FEED = {
  state: 'found',
  words: null,
  mls: {
    mlsNumber: 'ACT-6612977',
    status: 'active',
    statusWords: 'Active',
    sourceWords: 'From the MLS, through Repliers',
    listPriceCents: 48_900_000,
    soldPriceCents: null,
    soldOn: null,
    daysOnMarket: 6,
    facts: { beds: 4, baths: 2.5 },
    photos: [],
    description: null,
    differs: ['beds'],
    display: { notice: null, logoUrl: null, courtesy: null },
    checkedAt: '2026-10-03T15:42:00.000Z',
  },
  differences: [],
} as unknown as ListingView['feed'];

describe('a listing’s facts on the phone', () => {
  it('says where each came from, and when the MLS says something else', async () => {
    await render(
      <ListingFactsBody
        listing={{ feed: FEED, listPriceCents: 48_900_000 }}
        lines={LINES}
        timeZone={TZ}
        onChange={jest.fn()}
        onCheck={jest.fn(async () => undefined)}
      />,
    );
    expect(
      screen.getByText('The MLS says 4 bedrooms; you have 3. Fix it on the MLS or here.'),
    ).toBeTruthy();
    expect(screen.getByText('Typed by you · the MLS says 4')).toBeTruthy();
    expect(screen.getAllByText('From the MLS')).toHaveLength(2);
    expect(screen.getByText('From the seller’s questionnaire')).toBeTruthy();
    expect(screen.getByText('Change a fact')).toBeTruthy();
    // What the MLS has said, kept as it said it.
    expect(screen.getByText('Active · $489,000')).toBeTruthy();
    expect(screen.getByText('Differs')).toBeTruthy();
    expect(
      screen.getByText('ACT-6612977 · From the MLS, through Repliers · checked 10:42 AM'),
    ).toBeTruthy();
    expect(screen.getByText('Status: Active')).toBeTruthy();
    expect(screen.getByText('Price: $489,000')).toBeTruthy();
    expect(screen.getByText('matches')).toBeTruthy();
    expect(screen.getByText('Bedrooms: 4')).toBeTruthy();
    expect(screen.getByText('you have 3')).toBeTruthy();
  });

  it('asks the MLS again only with signal', async () => {
    mockOnline = false;
    await render(
      <ListingFactsBody
        listing={{ feed: FEED, listPriceCents: null }}
        lines={LINES}
        timeZone={TZ}
        onCheck={jest.fn()}
      />,
    );
    expect(screen.getByTestId('facts-check-again')).toHaveTextContent('Needs signal');
    expect(screen.getByText('Asking the MLS again needs signal.')).toBeTruthy();
  });

  it('reads a typed fact as the server takes it', () => {
    expect(factValue('baths', '2.4')).toBe(2.5);
    expect(factValue('hoa_monthly_cents', '$42')).toBe(4200);
    expect(factValue('sqft', '2,140')).toBe(2140);
    expect(factValue('beds', 'three')).toBeNull();
  });
});

// ---------- photos ----------

const PHOTOS = [
  { id: id(1), caption: 'Front', public: true, waiting: false },
  { id: id(2), caption: null, public: true, waiting: false },
  { id: id(3), caption: null, public: true, waiting: true },
];

describe('a listing’s photos on the phone', () => {
  it('shows them in order with the cover first, and those waiting to upload', async () => {
    await render(<ListingPhotosBody photos={PHOTOS} onTake={jest.fn()} onArrange={jest.fn()} />);
    expect(screen.getByText('3 photos')).toBeTruthy();
    expect(screen.getByTestId('photos-waiting')).toHaveTextContent('1 waiting to upload');
    expect(screen.getByText('Cover')).toBeTruthy();
    expect(screen.getByText('Take photos')).toBeTruthy();
    expect(
      screen.getByText(
        'Photos taken with no signal upload when it comes back. Order and cover save the same way.',
      ),
    ).toBeTruthy();
  });

  it('makes one the cover, in the order every photo is sent', async () => {
    const onArrange = jest.fn(async () => undefined);
    await render(<ListingPhotosBody photos={PHOTOS} onArrange={onArrange} />);
    await fireEvent.press(screen.getByTestId('listing-photo-2'));
    await fireEvent.press(screen.getByTestId('photo-cover'));
    expect(onArrange).toHaveBeenCalledWith([PHOTOS[2], PHOTOS[0], PHOTOS[1]]);
    expect(moved([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
  });

  it('adds a photo once it has uploaded, and arranges them with no signal', async () => {
    await addListingPhoto({
      workspaceId: WS,
      dealId: DEAL,
      fileId: id(9),
      upload: 'upload-1',
      position: 3,
    });
    const [name, input, options] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.listing.photo_add');
    expect(input).toEqual({
      workspaceId: WS,
      dealId: DEAL,
      id: NEW_ID,
      fileId: id(9),
      public: true,
    });
    expect(options?.dependsOn).toEqual(['upload-1']);
    await arrangeListingPhotos({
      workspaceId: WS,
      dealId: DEAL,
      photos: PHOTOS.map(({ id: photo, caption, public: shown }) => ({
        id: photo,
        caption,
        public: shown,
      })),
    });
    expect(jest.mocked(change).mock.calls[1]![0]).toBe('realestate.listing.photos_arrange');
  });
});

// ---------- the description ----------

const DESCRIPTION: ListingDescriptionView = {
  inUse: {
    id: id(13),
    version: 3,
    words: 'Light-filled two-story on a quiet cul-de-sac…',
    signedAt: '2026-10-01T15:00:00.000Z',
    how: 'portal',
    reason: null,
  },
  working: null,
  history: [
    {
      id: id(13),
      version: 3,
      source: 'person',
      state: 'signed',
      words: 'Light-filled…',
      at: '2026-10-01T15:00:00.000Z',
    },
    {
      id: id(12),
      version: 2,
      source: 'ai',
      state: 'replaced',
      words: 'Bright…',
      at: '2026-09-28T15:00:00.000Z',
    },
  ],
};

describe('a listing’s description on the phone', () => {
  it('reads the live words and every version with no signal; writing one needs signal', async () => {
    mockOnline = false;
    await render(
      <DescriptionBody
        description={DESCRIPTION}
        seller="Maria"
        timeZone={TZ}
        onWrite={jest.fn()}
      />,
    );
    expect(screen.getByText('Live · version 3')).toBeTruthy();
    expect(screen.getByText('Fair housing: checks with signal')).toBeTruthy();
    expect(screen.getByText('Light-filled two-story on a quiet cul-de-sac…')).toBeTruthy();
    expect(screen.getByText('Version 3 · live')).toBeTruthy();
    expect(screen.getByText('Oct 1 · Maria OK’d it in the portal')).toBeTruthy();
    expect(screen.getByText('Version 2')).toBeTruthy();
    expect(screen.getByText('Sep 28 · AI draft')).toBeTruthy();
    expect(screen.getByTestId('description-write')).toHaveTextContent('Needs signal');
    expect(
      screen.getByText('Writing a version needs signal (the AI and the fair-housing check).'),
    ).toBeTruthy();
  });
});

// ---------- the price ----------

type Price = ListingPricesView['history'][number];
const price = (
  p: Partial<Price> & Pick<Price, 'id' | 'toCents' | 'fromCents' | 'state'>,
): Price => ({
  words: '',
  note: null,
  how: null,
  signedBy: null,
  overrideBy: null,
  overrideReason: null,
  appliedAt: null,
  withdrawnReason: null,
  taskId: null,
  proposedAt: '2026-10-01T15:00:00.000Z',
  proposedBy: null,
  ...p,
});
const WAITING = price({
  id: id(21),
  fromCents: 48_900_000,
  toCents: 47_900_000,
  state: 'waiting',
  note: 'With the showing feedback',
});
const PRICES: ListingPricesView = {
  dealId: DEAL,
  currentCents: 48_900_000,
  waiting: WAITING,
  history: [WAITING],
  showings: {
    showings: 14,
    answered: 9,
    averageInterest: 3.5,
    priceHigh: 2,
    words: '14 showings · 9 answered',
  },
};

describe('a listing’s price on the phone', () => {
  it('shows what it’s asking, a change waiting on the seller, and when it was listed', async () => {
    await render(
      <PriceBody
        prices={PRICES}
        seller="Maria"
        listedAt="2026-09-25T15:00:00.000Z"
        today={TODAY}
        timeZone={TZ}
      />,
    );
    expect(screen.getByTestId('price-asking')).toHaveTextContent('$489,000');
    expect(screen.getByText('Since Sep 25 · 6 days · 14 showings')).toBeTruthy();
    expect(screen.getByText('A change Maria is asked about')).toBeTruthy();
    expect(screen.getByText('Lower to $479,000')).toBeTruthy();
    expect(screen.getByText('Waiting on Maria')).toBeTruthy();
    expect(
      screen.getByText('Asked Oct 1 in Maria’s portal · With the showing feedback'),
    ).toBeTruthy();
    expect(screen.getByTestId('price-listed')).toHaveTextContent('$489,000Listed Sep 25');
    expect(
      screen.getByText(
        'Asking the seller reaches the seller’s portal; with no signal it waits and asks again after 30 minutes.',
      ),
    ).toBeTruthy();
  });

  it('asks for a different price, and says why', async () => {
    const onAsk = jest.fn(async () => undefined);
    await render(
      <PriceSheet
        open
        seller="maria"
        currentCents={48_900_000}
        onClose={jest.fn()}
        onAsk={onAsk}
      />,
    );
    await fireEvent.changeText(screen.getByTestId('price-new'), '489,000');
    await fireEvent.press(screen.getByTestId('price-ask'));
    expect(screen.getByTestId('price-error')).toHaveTextContent(
      'That’s the price already. Enter a different one.',
    );
    await fireEvent.changeText(screen.getByTestId('price-new'), '479,000');
    await fireEvent.changeText(screen.getByTestId('price-why'), 'With the showing feedback');
    expect(screen.getByText('Ask Maria')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('price-ask'));
    await waitFor(() =>
      expect(onAsk).toHaveBeenCalledWith(47_900_000, 'With the showing feedback'),
    );
  });

  it('queues the change for the seller’s portal', async () => {
    await proposePrice({
      workspaceId: WS,
      dealId: DEAL,
      userId: ME,
      fromCents: 48_900_000,
      priceCents: 47_900_000,
      note: 'With the showing feedback',
    });
    expect(jest.mocked(change).mock.calls[0]!.slice(0, 2)).toEqual([
      'realestate.listing.price.propose',
      { workspaceId: WS, dealId: DEAL, priceCents: 47_900_000, note: 'With the showing feedback' },
    ]);
  });
});

// ---------- marketing ----------

const MARKETING: ListingMarketingView = {
  dealId: DEAL,
  mls: { number: '4821937', liveOn: '2026-09-25' },
  hold: null,
  page: {
    dealId: DEAL,
    state: 'published',
    site: 'hill-country',
    slug: '2207-juniper-trail',
    path: '/a/hill-country/realestate/2207-juniper-trail',
  },
  ready: { facts: true, description: true, photos: 12 },
  posts: {
    state: 'ready',
    failure: null,
    items: [{ id: id(31), position: 0, words: 'Just listed: 2207 Juniper Trail.', edited: false }],
  },
};

describe('a listing’s marketing on the phone', () => {
  it('says what’s out and what’s ready, and that writing a post needs signal', async () => {
    mockOnline = false;
    await render(<MarketingBody marketing={MARKETING} flyer={null} onWrite={jest.fn()} />);
    expect(screen.getByText('Live on the MLS')).toBeTruthy();
    expect(screen.getByText('Sep 25 · #4821937')).toBeTruthy();
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByText('Post 1')).toBeTruthy();
    expect(
      screen.getByText(
        'Just listed: 2207 Juniper Trail. · Ready · fair housing checks with signal',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('marketing-write')).toHaveTextContent('Needs signal');
    expect(screen.getByText('Writing a post needs signal; the list reads anywhere.')).toBeTruthy();
  });

  it('holds what’s public until it’s live on the MLS', async () => {
    const onMarkLive = jest.fn();
    await render(
      <MarketingBody
        marketing={{
          ...MARKETING,
          mls: null,
          hold: '2207 Juniper Trail isn’t live on the MLS yet.',
        }}
        flyer={{
          flyer: null,
          refused: { rule: 'realestate_not_on_mls', words: 'Not on the MLS yet.' },
        }}
        onMarkLive={onMarkLive}
      />,
    );
    expect(screen.getByText('Not live on the MLS yet')).toBeTruthy();
    expect(screen.getByText('Not on the MLS yet.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('marketing-mark-live'));
    expect(onMarkLive).toHaveBeenCalled();
  });
});

// ---------- open houses ----------

const OPEN_HOUSES: OpenHousesView = {
  dealId: DEAL,
  live: true,
  openHouses: [
    {
      id: id(41),
      startsAt: '2026-10-03T18:00:00.000Z',
      endsAt: '2026-10-03T20:00:00.000Z',
      state: 'planned',
      host: { id: ME, fullName: 'Dana Reyes' },
      signInPath: '/a/hill-country/realestate/2207-juniper-trail/open-house/x',
      visitors: [
        {
          id: id(42),
          firstName: 'Sam',
          lastName: 'Cole',
          email: null,
          phone: null,
          withAgent: false,
          agentName: null,
          smsConsent: false,
          signedInAt: '2026-10-03T18:20:00.000Z',
          personId: null,
          followedUpAt: null,
        },
        {
          id: id(43),
          firstName: 'Tom and Ana',
          lastName: 'Webb',
          email: null,
          phone: null,
          withAgent: true,
          agentName: 'Keller Williams',
          smsConsent: false,
          signedInAt: '2026-10-03T18:35:00.000Z',
          personId: null,
          followedUpAt: null,
        },
        {
          id: id(44),
          firstName: 'Rosa',
          lastName: 'Diaz',
          email: null,
          phone: null,
          withAgent: false,
          agentName: null,
          smsConsent: true,
          signedInAt: '2026-10-03T18:42:00.000Z',
          personId: id(45),
          followedUpAt: null,
        },
      ],
    },
  ],
};

describe('hosting an open house on the phone', () => {
  it('shows who’s hosting, those signed in newest first, the sign-in to hand over and Check in', async () => {
    const onCheckIn = jest.fn();
    await render(
      <OpenHousesBody
        view={OPEN_HOUSES}
        now={NOW}
        timeZone={TZ}
        onHand={jest.fn()}
        onCheckIn={onCheckIn}
        onPlan={jest.fn()}
      />,
    );
    expect(screen.getByText('Open house · Sat, Oct 3 · 1:00–3:00 PM')).toBeTruthy();
    expect(screen.getByText('Dana hosting · 3 signed in')).toBeTruthy();
    expect(screen.getByText('Hand the phone to a visitor')).toBeTruthy();
    expect(screen.getByText('Rosa Diaz')).toBeTruthy();
    expect(screen.getByText('Has an agent: no · texts OK')).toBeTruthy();
    expect(screen.getByText('Agent: Keller Williams')).toBeTruthy();
    expect(screen.getByText('1:42 PM')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('open-house-check-in'));
    expect(onCheckIn).toHaveBeenCalledWith(OPEN_HOUSES.openHouses[0]);
  });

  it('marks a sign-in made on this phone as waiting to send', async () => {
    await render(
      <OpenHousesBody view={OPEN_HOUSES} now={NOW} timeZone={TZ} waiting={new Set([id(44)])} />,
    );
    expect(screen.getByTestId(`open-house-visitor-${id(44)}`)).toHaveTextContent(
      'Rosa DiazWaiting to send1:42 PM',
    );
  });

  it('hands the phone to a visitor with the public page’s words, and back to the host', async () => {
    mockOnline = false;
    const onSignIn = jest.fn(async () => undefined);
    const onHandBack = jest.fn();
    await render(
      <VisitorSignIn
        openHouse={OPEN_HOUSES.openHouses[0]!}
        street="2207 Juniper Trail"
        business="Hill Country Realty"
        timeZone={TZ}
        onSignIn={onSignIn}
        onHandBack={onHandBack}
      />,
    );
    expect(screen.getByText('Welcome to 2207 Juniper Trail')).toBeTruthy();
    expect(
      screen.getByText('Open house · Sat, Oct 3 · 1:00–3:00 PM · with Dana Reyes'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('visitor-sign-in-save'));
    expect(screen.getByTestId('visitor-error')).toHaveTextContent(
      'Enter your first name, and an email or a phone number.',
    );
    await fireEvent.changeText(screen.getByTestId('visitor-first'), 'Sam');
    await fireEvent.changeText(screen.getByTestId('visitor-email'), 'sam@');
    await fireEvent.press(screen.getByTestId('visitor-sign-in-save'));
    expect(screen.getByTestId('visitor-error')).toHaveTextContent(
      'That doesn’t look like an email address.',
    );
    await fireEvent.changeText(screen.getByTestId('visitor-email'), '');
    await fireEvent.changeText(screen.getByTestId('visitor-last'), 'Cole');
    await fireEvent.changeText(screen.getByTestId('visitor-phone'), '(512) 555-0100');
    expect(screen.getByText('Text me, Hill Country Realty')).toBeTruthy();
    await fireEvent(screen.getByTestId('visitor-sms'), 'onCheckedChange', true);
    await fireEvent.press(screen.getByTestId('visitor-sign-in-save'));
    await waitFor(() => expect(screen.getByText('Thanks, Sam!')).toBeTruthy());
    expect(onSignIn).toHaveBeenCalledWith({
      firstName: 'Sam',
      lastName: 'Cole',
      email: null,
      phone: '(512) 555-0100',
      withAgent: false,
      agentName: null,
      smsConsent: true,
    });
    expect(screen.getByText('You’re signed in. Enjoy the home.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('visitor-next'));
    expect(screen.getByTestId('visitor-first').props.value).toBe('');
    await fireEvent.press(screen.getByTestId('visitor-hand-back'));
    expect(onHandBack).toHaveBeenCalled();
  });

  it('never asks someone with an agent for texts', async () => {
    const onSignIn = jest.fn(async () => undefined);
    await render(
      <VisitorSignIn
        openHouse={OPEN_HOUSES.openHouses[0]!}
        street="2207 Juniper Trail"
        business="Hill Country Realty"
        timeZone={TZ}
        onSignIn={onSignIn}
        onHandBack={jest.fn()}
      />,
    );
    await fireEvent.changeText(screen.getByTestId('visitor-first'), 'Tom');
    await fireEvent.changeText(screen.getByTestId('visitor-phone'), '(512) 555-0101');
    await fireEvent.press(screen.getByTestId('visitor-agent-yes'));
    expect(screen.queryByTestId('visitor-consent')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('visitor-agent'), 'Keller Williams');
    await fireEvent.press(screen.getByTestId('visitor-sign-in-save'));
    await waitFor(() =>
      expect(onSignIn).toHaveBeenCalledWith(
        expect.objectContaining({
          withAgent: true,
          agentName: 'Keller Williams',
          smsConsent: false,
        }),
      ),
    );
  });

  it('queues a sign-in with the phone’s id, and lists it at once', async () => {
    await signInVisitor({
      workspaceId: WS,
      dealId: DEAL,
      openHouseId: id(41),
      firstName: 'Sam',
      lastName: 'Cole',
      email: null,
      phone: '(512) 555-0100',
      withAgent: false,
      agentName: null,
      smsConsent: true,
    });
    const [name, input] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.open_house.sign_in');
    expect(input).toEqual({
      workspaceId: WS,
      openHouseId: id(41),
      id: NEW_ID,
      firstName: 'Sam',
      lastName: 'Cole',
      phone: '(512) 555-0100',
      withAgent: false,
      smsConsent: true,
    });
  });
});

// ---------- the seller's net ----------

const COMPARE = {
  dealId: DEAL,
  figures: null,
  figureHistory: [],
  rows: [
    {
      offerId: id(51),
      number: 1,
      buyers: 'Okafor',
      priceCents: 49_500_000,
      sellerCreditCents: 300_000,
      net: {
        lines: [{ key: 'buyer_agent_fee', label: 'Their agent’s fee', cents: -1_237_500 }],
        netCents: 0,
      },
    },
  ],
  shared: null,
  choices: [],
} as unknown as OffersCompareView;
const FIGURES = {
  payoffCents: 23_840_000,
  listingFeeBp: 300,
  listingFeeCents: null,
  titleEscrowCents: 412_000,
  transferTaxBp: 0,
  otherCents: 501_500,
  otherNote: 'Prorated taxes',
};

describe('the seller’s net on the phone', () => {
  it('works it out with core’s estimate and the offer’s own fee and credit, as the web does', async () => {
    const columns = netColumns(COMPARE, 48_900_000);
    expect(columns.map((c) => c.name)).toEqual(['Okafor offer · $495,000']);
    const expected = netEstimate(columns[0]!.offer, FIGURES);
    await render(
      <NetSheetBody
        columns={columns}
        picked={null}
        onPick={jest.fn()}
        figures={FIGURES}
        seller="Maria"
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('Price')).toBeTruthy();
    expect(screen.getByText('$495,000')).toBeTruthy();
    expect(screen.getByText('Listing fee · 3%')).toBeTruthy();
    expect(screen.getByText('−$14,850')).toBeTruthy();
    expect(screen.getByText('Other costs · Prorated taxes')).toBeTruthy();
    expect(screen.getByText('Maria nets')).toBeTruthy();
    expect(screen.getByTestId('net-total')).toHaveTextContent(
      `$${(expected.netCents / 100).toLocaleString('en-US')}`,
    );
    expect(
      screen.getByText(
        'Worked out on the phone with the same figures as the web; a new estimate saves with no signal.',
      ),
    ).toBeTruthy();
  });

  it('works it out at the list price before any offer', () => {
    expect(netColumns({ ...COMPARE, rows: [] }, 48_900_000).map((c) => c.name)).toEqual([
      'At the list price · $489,000',
    ]);
  });

  it('saves new figures with no signal, with the phone’s id', async () => {
    await saveNetSheet({ workspaceId: WS, dealId: DEAL, userId: ME, version: 2, figures: FIGURES });
    const [name, input] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.net_sheet.save');
    expect(input).toEqual({
      workspaceId: WS,
      dealId: DEAL,
      id: NEW_ID,
      payoffCents: 23_840_000,
      listingFeeBp: 300,
      listingFeeCents: null,
      titleEscrowCents: 412_000,
      transferTaxBp: 0,
      otherCents: 501_500,
      otherNote: 'Prorated taxes',
    });
  });
});

// ---------- showings ----------

type Showing = ShowingListView['showings'][number];
const showing = (
  s: Partial<Showing> & Pick<Showing, 'id' | 'startsAt' | 'endsAt' | 'agentName'>,
): Showing => ({
  source: 'page',
  sourceLabel: 'Our page',
  state: 'requested',
  stateWords: 'Waiting on Maria',
  when: 'Thu, Oct 8 · 5:30 PM',
  brokerage: null,
  license: null,
  agentEmail: null,
  agentPhone: null,
  checked: true,
  requestedAt: '2026-10-03T12:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
  accessSentAt: null,
  feedbackAskedAt: null,
  feedback: null,
  feedbackAt: null,
  feedbackSource: null,
  feedbackSharedAt: null,
  can: { confirm: true, decline: true, cancel: true, check: false, feedback: false, share: false },
  ...s,
});
const SHOWINGS: ShowingListView = {
  dealId: DEAL,
  street: '2207 Juniper Trail',
  requestPath: null,
  sellerFirstName: 'Maria',
  settings: {
    open: true,
    confirm: 'seller',
    days: [0, 1, 2, 3, 4, 5, 6],
    from: '10:00',
    to: '18:00',
    minutes: 30,
    accessHours: 1,
    feedbackHours: 1,
  },
  showings: [
    showing({
      id: id(61),
      startsAt: '2026-10-08T22:30:00.000Z',
      endsAt: '2026-10-08T23:00:00.000Z',
      agentName: 'Lee Wong',
      brokerage: 'Compass',
    }),
    showing({
      id: id(62),
      startsAt: '2026-10-03T21:00:00.000Z',
      endsAt: '2026-10-03T21:30:00.000Z',
      agentName: 'Kim Ortiz',
      brokerage: 'Oakwood',
      state: 'confirmed',
      stateWords: 'Confirmed',
      can: {
        confirm: false,
        decline: false,
        cancel: true,
        check: false,
        feedback: true,
        share: false,
      },
    }),
  ],
  summary: {
    showings: 3,
    answered: 3,
    averageInterest: 3.5,
    price: { low: 0, right: 2, high: 1 },
    words: '3 showings · 3 answered',
    interestWords: '3.5 of 5 on average',
  },
  themes: {
    liked: [{ theme: 'Patio and the oaks', count: 3, quotes: [] }],
    disliked: [{ theme: 'Kitchen size', count: 2, quotes: [] }],
    likedWords: 'Patio and the oaks (3)',
    dislikedWords: 'Kitchen size (2)',
    at: '2026-10-03T12:00:00.000Z',
  },
};

describe('showings on the phone', () => {
  it('shows requests to answer, what’s coming up with Check in, and what buyers said', async () => {
    const onDecide = jest.fn();
    const onAnother = jest.fn();
    const onCheckIn = jest.fn();
    await render(
      <ShowingsBody
        view={SHOWINGS}
        now={NOW}
        today="2026-10-03"
        timeZone={TZ}
        onOpen={jest.fn()}
        onDecide={onDecide}
        onAnother={onAnother}
        onCheckIn={onCheckIn}
        onAdd={jest.fn()}
      />,
    );
    expect(screen.getByText('Asked, waiting  1')).toBeTruthy();
    expect(screen.getByText('Thu, Oct 8 · 5:30 PM · Lee Wong, Compass')).toBeTruthy();
    expect(screen.getByText('Our page · Waiting on Maria')).toBeTruthy();
    expect(screen.getByText('Coming up  1')).toBeTruthy();
    expect(screen.getByText('Today 4:00 PM')).toBeTruthy();
    expect(screen.getByText('Kim Ortiz, Oakwood · Confirmed')).toBeTruthy();
    expect(screen.getByText('Liked: Patio and the oaks (3)')).toBeTruthy();
    expect(screen.getByText('Didn’t: Kitchen size (2) · 3.5 of 5 on average')).toBeTruthy();
    expect(
      screen.getByText('Answering waits on the phone and asks again after 30 minutes.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`showing-yes-${id(61)}`));
    expect(onDecide).toHaveBeenCalledWith(SHOWINGS.showings[0], 'confirm');
    await fireEvent.press(screen.getByTestId(`showing-another-${id(61)}`));
    expect(onAnother).toHaveBeenCalledWith(SHOWINGS.showings[0]);
    await fireEvent.press(screen.getByTestId(`showing-check-in-${id(62)}`));
    expect(onCheckIn).toHaveBeenCalledWith(SHOWINGS.showings[1]);
  });

  it('queues an answer that reaches the buyer’s agent: another time is a no with what to offer', async () => {
    await decideShowing({
      workspaceId: WS,
      showingId: id(61),
      decision: 'decline',
      note: 'Thursday after 6',
    });
    expect(jest.mocked(change).mock.calls[0]!.slice(0, 2)).toEqual([
      'realestate.showing.decide',
      { workspaceId: WS, showingId: id(61), decision: 'decline', note: 'Thursday after 6' },
    ]);
  });
});

// ---------- a duty's vendor ----------

type Fit = DutyVendorsView['fits'][number];
const fit = (f: Partial<Fit> & Pick<Fit, 'id' | 'name'>): Fit => ({
  companyId: id(80),
  email: null,
  phone: null,
  services: ['inspection'],
  servicesWords: 'Home inspection',
  areas: ['Austin'],
  approved: true,
  approvedAt: '2026-09-01T00:00:00.000Z',
  disclosure: null,
  disclosureWords: 'No disclosure',
  note: null,
  archived: false,
  uses: 0,
  lastUsedAt: null,
  inArea: true,
  ...f,
});
const VENDORS: DutyVendorsView = {
  dutyId: id(70),
  dealId: DEAL,
  service: 'inspection',
  serviceLabel: 'Home inspection',
  address: '18 Elm St, Austin, TX',
  fits: [
    fit({
      id: id(71),
      name: 'Lone Star Inspections',
      uses: 3,
      lastUsedAt: '2026-09-12T15:00:00.000Z',
    }),
    fit({ id: id(72), name: 'Hill Country Inspect' }),
  ],
  picks: [],
};

describe('picking a vendor on a duty', () => {
  it('lists every approved vendor that fits, and uses the one picked with its quote', async () => {
    const onPick = jest.fn(async () => undefined);
    await render(<DutyVendorsBody view={VENDORS} timeZone={TZ} onPick={onPick} />);
    expect(screen.getByText('Approved · last used Sep 12')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Not booked yet. Book it on the calendar, on the deal.')).toBeTruthy();
    expect(
      screen.getByText(
        'Give the client every vendor that fits, not only one, and say any disclosure.',
      ),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('duty-vendor-quote'), 'four hundred');
    await fireEvent.press(screen.getByTestId('duty-vendor-use'));
    expect(screen.getByTestId('duty-vendor-error')).toHaveTextContent(
      'Enter the quote as an amount, like 475.',
    );
    await fireEvent.changeText(screen.getByTestId('duty-vendor-quote'), '475');
    expect(screen.getByText('Use Lone Star Inspections')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('duty-vendor-use'));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(id(71), 47_500));
  });

  it('says when no approved vendor does what the duty needs', async () => {
    await render(
      <DutyVendorsBody view={{ ...VENDORS, fits: [] }} timeZone={TZ} onPick={jest.fn()} />,
    );
    expect(
      screen.getByText(
        'No approved vendor does home inspection yet. Add one in Vendors; an owner or admin approves them.',
      ),
    ).toBeTruthy();
  });
});
