import { ExtensionStorage } from '@bacons/apple-targets';
import { buildWidgetsData, WIDGETS_DATA_KEY } from '@hfos/core';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { deviceStore } from '@/lib/device-store';

import HfosShared from '../../../modules/hfos-shared';
import {
  forgetWidgets,
  readStoredWidgets,
  refreshWidgets,
  onWidgetsRefresh,
  setWidgetsHideNames,
  storeWidgets,
  watchWidgetsOwner,
  widgetsHideNames,
  WIDGETS_RESAVE_MS,
} from '../store';
import { DATA, INPUT, NOW } from './fixture';

/**
 * Saving the widgets' copy (docs/phone-widgets.md): saved and redrawn only when it says something new, forgotten on
 * signing out, and each person's Hide names switch kept on the phone.
 */

const shared = HfosShared as unknown as { write: jest.Mock; __values: Map<string, string> };
const reload = ExtensionStorage.reloadWidget as jest.Mock;

beforeEach(() => {
  forgetWidgets();
  shared.write.mockClear();
  reload.mockClear();
  (requestWidgetUpdate as jest.Mock).mockClear();
});

describe('the widgets’ copy', () => {
  it('saves it where the widgets read it, and asks them to draw again', () => {
    expect(storeWidgets(DATA, NOW)).toBe(true);
    expect(shared.__values.get(WIDGETS_DATA_KEY)).toBe(JSON.stringify(DATA));
    expect(readStoredWidgets()?.business.name).toBe('Lone Star HVAC');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves the widgets alone when a later copy says the same, until it’s been a while', () => {
    storeWidgets(DATA, NOW);
    const later = buildWidgetsData({ ...INPUT, now: NOW + 60_000 });
    storeWidgets(later, NOW + 60_000);
    expect(shared.write).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // Something they show changed: saved at once.
    storeWidgets(buildWidgetsData({ ...INPUT, hideNames: true }), NOW + 120_000);
    expect(shared.write).toHaveBeenCalledTimes(2);

    // The same again, but long enough later that "Updated" would be stale.
    storeWidgets(
      buildWidgetsData({ ...INPUT, hideNames: true }),
      NOW + 120_000 + WIDGETS_RESAVE_MS,
    );
    expect(shared.write).toHaveBeenCalledTimes(3);
  });

  it('forgets it, and the widgets with it', () => {
    storeWidgets(DATA, NOW);
    reload.mockClear();
    forgetWidgets();
    expect(readStoredWidgets()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('saves again on Update now even when nothing changed', async () => {
    storeWidgets(DATA, NOW);
    const off = onWidgetsRefresh(async () => {
      storeWidgets(DATA, NOW + 1000);
    });
    await refreshWidgets();
    off();
    expect(shared.write).toHaveBeenCalledTimes(2);
  });

  it('forgets it when the person signs out', () => {
    let state: { status: string } = { status: 'signedIn' };
    const listeners = new Set<() => void>();
    watchWidgetsOwner({
      getState: () => state,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    storeWidgets(DATA, NOW);
    state = { status: 'signedOut' };
    for (const l of listeners) l();
    expect(readStoredWidgets()).toBeNull();
  });
});

describe('Hide names on widgets', () => {
  it('is each person’s own, off until they turn it on', () => {
    expect(widgetsHideNames('u1')).toBe(false);
    setWidgetsHideNames('u1', true);
    expect(widgetsHideNames('u1')).toBe(true);
    expect(widgetsHideNames('u2')).toBe(false);
    setWidgetsHideNames('u1', false);
    expect(widgetsHideNames('u1')).toBe(false);
    expect(deviceStore.get('person.u1.widgetsHideNames')).toBeUndefined();
  });
});
