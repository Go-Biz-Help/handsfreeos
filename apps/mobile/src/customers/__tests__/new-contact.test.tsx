import {
  BUSINESS_CARD_SOURCE,
  BUSINESS_CARD_WORDS as W,
  type CardContact,
  type ReadCardOut,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import NewContact from '@/app/app/w/[workspaceId]/customers/new';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change, changes } from '@/changes';
import { keepCardPicture, readCardSide, takeCardPhoto } from '@/customers/card-scan';
import type { Me } from '@/lib/businesses';

/**
 * New contact on the phone (Contacts → + → Type it in, or Scan a business card), with the camera, the worker and the
 * queue played by stand-ins: someone typed in, linked to their company; a card scanned front and back filling the
 * boxes and its straightened pictures going on the contact's Files after them; a box that's wrong pointed at; and a
 * card read with no signal.
 */

jest.mock('@/changes', () => ({
  change: jest.fn(),
  newId: jest.fn(),
  changes: { open: null, addPhoto: jest.fn() },
}));
jest.mock('@/customers/card-scan', () => ({
  takeCardPhoto: jest.fn(),
  readCardSide: jest.fn(),
  keepCardPicture: jest.fn(),
}));
jest.mock('@/components/customers/card-edges', () => ({ CardEdges: () => null }));
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true, lastOnlineAt: 0 }) }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const screenWith = () => (
  <BusinessProvider
    value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
  >
    <NewContact />
  </BusinessProvider>
);

const getAll = jest.fn(async (sql: string): Promise<unknown[]> => {
  if (sql.includes('FROM companies')) return [{ id: 'company-acme', name: 'Acme Plumbing, LLC' }];
  return [];
});
const copy = changes as unknown as {
  open: { db: { getAll: typeof getAll } } | null;
  addPhoto: jest.Mock;
};

const blank: CardContact = {
  firstName: '',
  lastName: '',
  jobTitle: '',
  company: '',
  phones: [],
  emails: [],
  website: '',
  address: { street: '', city: '', state: '', postalCode: '', country: '' },
  extra: '',
};

const read = (contact: Partial<CardContact>, over: Partial<ReadCardOut> = {}): ReadCardOut => ({
  picture: 'U1RSQUlHSFQ=',
  width: 1400,
  height: 800,
  corners: [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.2 },
    { x: 0.9, y: 0.7 },
    { x: 0.1, y: 0.7 },
  ],
  cropped: true,
  isCard: true,
  contact: { ...blank, ...contact },
  ...over,
});

const photo = { base64: 'UEhPVE8=', width: 2048, height: 1536 };

let ids = 0;
beforeEach(() => {
  mockParams = {};
  ids = 0;
  const { newId } = jest.requireMock<{ newId: jest.Mock }>('@/changes');
  newId.mockImplementation(() => `id-${++ids}`);
  copy.open = { db: { getAll } };
  copy.addPhoto.mockReset();
  copy.addPhoto.mockResolvedValue({ id: 'photo-change' });
  jest.mocked(change).mockReset();
  jest
    .mocked(change)
    .mockImplementation(async (name) => ({ id: `${name}-change`, queued: true }) as never);
  jest.mocked(takeCardPhoto).mockReset();
  jest.mocked(readCardSide).mockReset();
  jest
    .mocked(keepCardPicture)
    .mockReset()
    .mockImplementation((_user, fileId) => ({ localName: `${fileId}.jpg`, sizeBytes: 1234 }));
  jest.mocked(router.replace).mockClear();
  jest
    .spyOn(toast, 'show')
    .mockClear()
    .mockImplementation(() => 1);
  jest
    .spyOn(toast, 'error')
    .mockClear()
    .mockImplementation(() => 1);
});

describe('typing in a new contact', () => {
  it('adds them, linked to the company of that name already here', async () => {
    await render(screenWith());
    await fireEvent.changeText(screen.getByTestId('new-contact-name'), 'Mike Alvarez');
    await fireEvent.changeText(screen.getByTestId('new-contact-company'), 'acme plumbing');
    await fireEvent.changeText(screen.getByTestId('new-contact-phone'), '(512) 555-0177');
    await fireEvent.press(screen.getByTestId('new-contact-save'));

    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith(
      'person.create',
      expect.objectContaining({
        workspaceId: LONE_STAR,
        firstName: 'Mike',
        lastName: 'Alvarez',
        phone: '+15125550177',
        companyId: 'company-acme',
        source: null,
      }),
      expect.anything(),
    );
    expect(toast.show).toHaveBeenCalledWith(W.added('Mike Alvarez'));
    expect(router.replace).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/customers/people/id-1`);
    expect(copy.addPhoto).not.toHaveBeenCalled();
  });

  it('points at the box that’s wrong', async () => {
    await render(screenWith());
    await fireEvent.changeText(screen.getByTestId('new-contact-name'), 'Mike');
    await fireEvent.changeText(screen.getByTestId('new-contact-email'), 'mike@');
    await fireEvent.press(screen.getByTestId('new-contact-save'));
    expect(screen.getByTestId('new-contact-problem')).toHaveTextContent(W.badEmail);
    expect(change).not.toHaveBeenCalled();
  });
});

describe('scanning a business card', () => {
  it('reads the front and back into the form, then adds the contact, their new company and the card', async () => {
    mockParams = { scan: '1' };
    jest.mocked(takeCardPhoto).mockResolvedValue({ kind: 'taken', photo });
    jest.mocked(readCardSide).mockResolvedValueOnce(
      read({
        firstName: 'Maria',
        lastName: 'Lopez',
        jobTitle: 'Owner',
        company: 'Lopez Roofing',
        phones: [{ number: '(713) 555-0142', label: 'Mobile' }],
        emails: [{ email: 'maria@lopezroofing.com', label: '' }],
      }),
    );
    await render(screenWith());

    // The camera opens on its own, and the front is read.
    await waitFor(() => expect(readCardSide).toHaveBeenCalledWith(LONE_STAR, 'front', photo));
    await waitFor(() =>
      expect(screen.getByTestId('new-contact-name').props.value).toBe('Maria Lopez'),
    );
    expect(screen.getByTestId('new-contact-notice')).toHaveTextContent(W.filled(5));

    // The back adds an office number.
    jest
      .mocked(readCardSide)
      .mockResolvedValueOnce(read({ phones: [{ number: '(713) 555-0100', label: 'Office' }] }));
    await fireEvent.press(screen.getByTestId('card-back-scan'));
    await fireEvent.press(screen.getByTestId('photo-camera'));
    await waitFor(() =>
      expect(screen.getByTestId('new-contact-other-phone-0').props.value).toBe('(713) 555-0100'),
    );

    await fireEvent.press(screen.getByTestId('new-contact-save'));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());

    // The company first, then the contact waiting for it, then the two sides waiting for the contact.
    expect(jest.mocked(change).mock.calls.map((c) => c[0])).toEqual([
      'company.create',
      'person.create',
    ]);
    expect(change).toHaveBeenCalledWith(
      'company.create',
      expect.objectContaining({ name: 'Lopez Roofing', source: BUSINESS_CARD_SOURCE }),
      expect.anything(),
    );
    const [, person, options] = jest.mocked(change).mock.calls[1]!;
    expect(person).toMatchObject({
      firstName: 'Maria',
      phone: '+17135550142',
      otherPhones: [{ phone: '+17135550100', label: 'Office' }],
      notes: 'Job title: Owner',
      source: BUSINESS_CARD_SOURCE,
    });
    expect(options).toMatchObject({ dependsOn: ['company.create-change'] });
    const personId = (person as { id: string }).id;
    expect(copy.addPhoto.mock.calls.map((c) => [c[0].recordId, c[2].name, c[2].dependsOn])).toEqual(
      [
        [personId, W.photoName('front'), ['person.create-change']],
        [personId, W.photoName('back'), ['person.create-change']],
      ],
    );
    expect(toast.show).toHaveBeenCalledWith(W.addedWithCard('Maria Lopez'));
  });

  it('says when reading a card needs signal, and lets the person try again', async () => {
    jest.mocked(takeCardPhoto).mockResolvedValue({ kind: 'taken', photo });
    jest.mocked(readCardSide).mockRejectedValueOnce(new TypeError('Network request failed'));
    await render(screenWith());
    await fireEvent.press(screen.getByTestId('card-front-scan'));
    await fireEvent.press(screen.getByTestId('photo-camera'));
    await waitFor(() =>
      expect(screen.getByTestId('card-front-failed')).toHaveTextContent(W.needsSignal),
    );

    jest
      .mocked(readCardSide)
      .mockResolvedValueOnce(read({ firstName: 'Maria' }, { cropped: false }));
    await fireEvent.press(screen.getByTestId('card-front-retry'));
    await waitFor(() =>
      expect(screen.getByTestId('new-contact-notice')).toHaveTextContent(W.noEdges),
    );
    expect(screen.getByTestId('new-contact-name').props.value).toBe('Maria');
  });
});
