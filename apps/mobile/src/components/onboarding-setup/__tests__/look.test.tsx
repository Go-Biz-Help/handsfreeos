import {
  LOOK_DEFAULT_COLOR,
  LOOK_PROBLEMS,
  LOOK_WORDS as L,
  logoUrlFor,
  NO_LOOK,
  type BusinessLook,
  type OnboardingSetupState,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ImageManipulator } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

import { LookScreen } from '../look';
import type { OwnScreenProps } from '../screens';

/**
 * "Your logo and colour" on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8), with
 * HandsFreeOS and Storage played by stand-ins: a logo picked from the photos, shrunk and sent straight to Storage, then
 * made ready with its colour; a colour picked or typed; a refused upload and the website looked at again; no signal;
 * and someone whose role can't change it.
 */

jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/auth', () => ({ session: { accessToken: async () => 'token-1' } }));
jest.mock('@/lib/config', () => {
  const actual = jest.requireActual<{ config: Record<string, unknown> }>('@/lib/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      supabaseUrl: 'https://hfos.test',
      supabasePublishableKey: 'sb_publishable_test',
    },
  };
});
let mockOnline = true;
const mockAppFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: (url: string, init: RequestInit) => mockAppFetch(url, init),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOAD_PATH = `${LONE_STAR}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png`;
const LOGO_PATH = `${LONE_STAR}/logo/ffffffff-ffff-4fff-8fff-ffffffffffff.png`;
const SITE = 'https://lonestarhvac.com';
const files = jest.requireMock<{ __files: Map<string, string | Uint8Array> }>(
  'expo-file-system',
).__files;

const at = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

/** Waiting for the worker to make the upload ready. */
const making = (): BusinessLook => ({
  ...NO_LOOK,
  upload: { path: UPLOAD_PATH, name: 'logo.png', by: DALE, at: at(), sent: true },
});
/** Made ready: a wide logo, its colour with it. */
const ready = (): BusinessLook => ({
  ...NO_LOOK,
  logo: { path: LOGO_PATH, width: 240, height: 60, from: 'upload', at: at() },
  color: { hex: '#008743', from: 'logo', at: at() },
});

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((c) => c[0] === path).map((c) => c[1].body);
const refresh = jest.fn(async () => undefined);

/** The screen's props for Lone Star: it reads the business's name, its website and its look. */
function props(
  look: BusinessLook,
  given: { website?: string; can?: boolean } = {},
): OwnScreenProps {
  return {
    workspaceId: LONE_STAR,
    state: {
      businessName: 'Lone Star HVAC',
      website: given.website ?? null,
      look,
    } as unknown as OnboardingSetupState,
    answers: {} as OwnScreenProps['answers'],
    set: jest.fn(),
    setAi: jest.fn(),
    problems: {},
    calls: {} as OwnScreenProps['calls'],
    name: 'Ava',
    can: () => given.can ?? true,
    refresh,
  };
}

beforeEach(() => {
  mockOnline = true;
  answers = {};
  post.mockReset();
  post.mockImplementation(async (path, { body }) => {
    const answer = answers[path];
    const value = typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer;
    return { data: value ?? {}, response: new Response(null, { status: 200 }) };
  });
  mockAppFetch.mockReset();
  refresh.mockClear();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReset();
  (ImageManipulator.manipulate as jest.Mock).mockReset();
});

it('sends a logo picked from the photos to Storage, waits while it’s made ready, and its colour comes with it', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file:///photos/lone-star.png',
        fileName: 'lone-star.png',
        mimeType: 'image/png',
        width: 3200,
        height: 800,
      },
    ],
  });
  const resize = jest.fn();
  const saveAsync = jest.fn(async () => {
    files.set('file:///cache/made.png', bytes);
    return { uri: 'file:///cache/made.png', width: 1600, height: 400 };
  });
  (ImageManipulator.manipulate as jest.Mock).mockReturnValue({
    resize,
    renderAsync: async () => ({ saveAsync }),
  });
  answers['/v1/commands/look.begin_upload'] = { bucket: 'brand-uploads', objectPath: UPLOAD_PATH };
  answers['/v1/commands/look.use_upload'] = { look: making() };
  mockAppFetch.mockResolvedValue(new Response('{}', { status: 200 }));

  await render(<LookScreen {...props(NO_LOOK)} />);
  expect(screen.getByTestId('look-no-logo')).toHaveTextContent(L.noLogo);
  expect(screen.getByTestId('look-colour-value')).toHaveTextContent(LOOK_DEFAULT_COLOR);
  expect(screen.getByTestId(`look-colour-${LOOK_DEFAULT_COLOR.slice(1)}`)).toBeChecked();
  // The preview is hidden from screen readers: it's a picture of a page.
  const hidden = { includeHiddenElements: true };
  expect(screen.getByText('Lone Star HVAC', hidden)).toBeTruthy();

  await fireEvent.press(screen.getByTestId('look-upload'));
  expect(await screen.findByTestId('look-working')).toHaveTextContent(L.making);
  expect(screen.getByTestId('look-upload')).toBeDisabled();

  // Shrunk to 1,600 px across and kept a PNG, so its see-through background stays.
  expect(resize).toHaveBeenCalledWith({ width: 1600 });
  expect(saveAsync).toHaveBeenCalledWith({ format: 'png' });
  expect(files.has('file:///cache/made.png')).toBe(false);
  expect(sent('/v1/commands/look.begin_upload')).toEqual([
    { workspaceId: LONE_STAR, name: 'lone-star.png', mimeType: 'image/png', sizeBytes: 4 },
  ]);
  // Straight to the place reserved for it, as the person.
  const [url, init] = mockAppFetch.mock.calls[0]!;
  expect(url).toBe(`https://hfos.test/storage/v1/object/brand-uploads/${UPLOAD_PATH}`);
  expect(init).toEqual(
    expect.objectContaining({
      method: 'POST',
      headers: {
        authorization: 'Bearer token-1',
        apikey: 'sb_publishable_test',
        'content-type': 'image/png',
        'x-upsert': 'false',
      },
    }),
  );
  expect(Array.from(init.body as Uint8Array)).toEqual(Array.from(bytes));
  expect(sent('/v1/commands/look.use_upload')).toEqual([
    { workspaceId: LONE_STAR, objectPath: UPLOAD_PATH },
  ]);
  expect(refresh).toHaveBeenCalled();

  // Made ready: the logo is shown, says where it came from, and brings its colour. Wide, it stands for the name.
  await screen.rerender(<LookScreen {...props(ready())} />);
  expect(screen.getByTestId('look-logo-from')).toHaveTextContent(L.uploaded);
  expect(screen.getAllByTestId('business-logo', hidden)[0]).toHaveProp('source', {
    uri: logoUrlFor('https://hfos.test', LOGO_PATH),
  });
  expect(screen.getByTestId('look-colour-value')).toHaveTextContent('#008743');
  expect(screen.getByTestId('look-colour-from')).toHaveTextContent(L.fromLogo);
  expect(screen.getByTestId('look-colour-008743')).toBeChecked();
  expect(screen.queryByText('Lone Star HVAC', hidden)).toBeNull();
  expect(toast.show).toHaveBeenCalledWith(L.logoReady);
  expect(screen.getByTestId('look-upload')).toHaveTextContent(L.change);
});

it('keeps a colour picked or typed, and says how to type one that isn’t a colour', async () => {
  answers['/v1/commands/look.set'] = (body: { color: string }) => ({
    look: { ...ready(), color: { hex: body.color, from: 'person', at: at() } },
    changed: true,
  });
  await render(<LookScreen {...props(ready())} />);

  await fireEvent.press(screen.getByTestId('look-colour-7c3aed'));
  await waitFor(() => expect(toast.show).toHaveBeenCalledWith(L.saved));
  expect(sent('/v1/commands/look.set')).toEqual([{ workspaceId: LONE_STAR, color: '#7c3aed' }]);
  expect(screen.getByTestId('look-colour-7c3aed')).toBeChecked();
  expect(screen.queryByTestId('look-colour-from')).toBeNull();
  // Picked already: nothing to send.
  await fireEvent.press(screen.getByTestId('look-colour-7c3aed'));
  expect(sent('/v1/commands/look.set')).toHaveLength(1);

  await fireEvent.changeText(screen.getByTestId('look-colour-any'), 'teal');
  await fireEvent.press(screen.getByTestId('look-colour-use'));
  expect(screen.getByTestId('look-error')).toHaveTextContent(L.typeColor);
  expect(sent('/v1/commands/look.set')).toHaveLength(1);

  await fireEvent.changeText(screen.getByTestId('look-colour-any'), '0E7490');
  expect(screen.getByTestId('look-colour-use')).toHaveTextContent(L.pickColor('0E7490'));
  await fireEvent.press(screen.getByTestId('look-colour-use'));
  await waitFor(() =>
    expect(sent('/v1/commands/look.set')).toEqual([
      { workspaceId: LONE_STAR, color: '#7c3aed' },
      { workspaceId: LONE_STAR, color: '#0e7490' },
    ]),
  );
  expect(await screen.findByTestId('look-colour-0e7490')).toBeChecked();
  expect(screen.queryByTestId('look-error')).toBeNull();
});

it('says why an upload was refused, and looks on the website again', async () => {
  const refused: BusinessLook = {
    ...NO_LOOK,
    problem: { message: LOOK_PROBLEMS.tooLight, at: at(60_000) },
    searched: { url: SITE, at: at(5 * 60_000), found: false },
    asked: { url: SITE, at: at(6 * 60_000) },
  };
  answers['/v1/commands/look.find'] = {
    look: { ...refused, asked: { url: SITE, at: at() } },
    url: SITE,
  };
  await render(<LookScreen {...props(refused, { website: SITE })} />);
  expect(screen.getByTestId('look-problem')).toHaveTextContent(LOOK_PROBLEMS.tooLight);
  expect(screen.getByTestId('look-no-logo')).toHaveTextContent(L.notFound(SITE));

  expect(screen.getByTestId('look-find')).toHaveTextContent(L.findAgain(SITE));
  await fireEvent.press(screen.getByTestId('look-find'));
  expect(await screen.findByTestId('look-working')).toHaveTextContent(L.searching(SITE));
  expect(sent('/v1/commands/look.find')).toEqual([{ workspaceId: LONE_STAR }]);
  expect(screen.queryByTestId('look-find')).toBeNull();
});

it('sends nothing without signal, and says so', async () => {
  mockOnline = false;
  await render(<LookScreen {...props(NO_LOOK)} />);
  await fireEvent.press(screen.getByTestId('look-colour-7c3aed'));
  expect(screen.getByTestId('look-error')).toHaveTextContent(P.needsSignal);
  await fireEvent.press(screen.getByTestId('look-upload'));
  expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it('shows someone whose role can’t change them the logo and colour, and who can', async () => {
  await render(<LookScreen {...props(ready(), { can: false })} />);
  expect(screen.getByTestId('look-cant-change')).toHaveTextContent(L.cantChange);
  expect(screen.queryByTestId('look-upload')).toBeNull();
  expect(screen.queryByTestId('look-remove')).toBeNull();
  expect(screen.queryByTestId('look-colour-any')).toBeNull();
  expect(screen.getByTestId('look-colour-7c3aed')).toBeDisabled();
});
