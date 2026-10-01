import * as Crypto from 'expo-crypto';
import { AppState } from 'react-native';

import { appVersion } from '@/lib/app-version';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { deviceStore } from '@/lib/device-store';
import { lock } from '@/lib/lock';
import { appFetch, isTestOffline, networkSnapshot, subscribeNetwork } from '@/lib/network';
import { copyLogger } from '@/sync/logger';
import { viewRefusal } from '@/view-as/state';

import type { CommandName, InputOf } from './commands';
import { Changes, type ChangeOptions, type ChangeResult } from './controller';
import { devicePhotoTransport, removePhoto } from './photo-device';
import { sendCommand } from './send';
import { pauseBetweenPieces, quietHoursMoment } from './test-overrides';

/**
 * The phone's queue of changes, wired to the session, signal, the lock and the phone's own store. The person's copy
 * (`src/sync`) attaches it when it opens and asks it what to upload.
 */
export const changes = new Changes({
  send: (request) =>
    sendCommand(
      {
        apiUrl: config.apiUrl,
        fetch: appFetch,
        token: () => session.accessToken(),
        appVersion,
        now: Date.now,
      },
      request,
    ),
  session,
  network: { online: () => networkSnapshot().online, subscribe: subscribeNetwork },
  lock,
  appActive: {
    subscribe: (listener) => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') listener();
      });
      return () => sub.remove();
    },
  },
  store: deviceStore,
  appVersion,
  newId: () => Crypto.randomUUID(),
  storage: { url: config.supabaseUrl, key: config.supabasePublishableKey },
  photoTransport: (userId) => devicePhotoTransport({ userId, fetch, offline: isTestOffline }),
  removePhotoFile: removePhoto,
  quietHoursMoment: (timeZone) => quietHoursMoment(timeZone),
  pauseBetweenPieces,
  log: (message, error) => copyLogger.log({ level: 50, message, error }),
  // Nothing is changed in a business the person is viewing as a teammate (20261016000200).
  refuse: viewRefusal,
});

/**
 * The one way screens make a change (see `Changes.change`):
 *
 *   const person = await change('person.create', { workspaceId, id: newId(), firstName, lastName }, {
 *     optimistic: (tx) => tx.execute('INSERT INTO people (id, workspace_id, first_name, last_name) VALUES (?, ?, ?, ?)', […]),
 *   });
 *   await change('lead.create', { workspaceId, id: newId(), personId, title }, { dependsOn: [person.id] });
 */
export function change<N extends CommandName>(
  name: N,
  input: InputOf<N>,
  options?: ChangeOptions,
): Promise<ChangeResult<N>> {
  return changes.change(name, input, options);
}

/** A new id made on the phone, for a record created here (the API keeps it). */
export function newId(): string {
  return Crypto.randomUUID();
}

export { ChangeError, NEEDS_SIGNAL, type ChangeOptions, type ChangeResult } from './controller';
export type { CommandName, InputOf, OutputOf, QueuedCommand, OnlineCommand } from './commands';
export { editedOnly, orNull, tagChanges } from './edits';
export { fixerFor, onRefused, setFixer } from './fixers';
