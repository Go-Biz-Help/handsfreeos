/**
 * The extension's own tab goes only to Facebook's pages (src/tab.ts, src/networks/facebook/urls.ts): https, on
 * www.facebook.com, web.facebook.com or accountscenter.facebook.com. A bad link kept in HandsFreeOS or read off a page
 * is refused with plain words, and Chrome is never asked to open it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workUrl } from '../src/networks/facebook/urls';
import { WorkTab } from '../src/tab';

const opened: string[] = [];

beforeAll(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    tabs: {
      create: async ({ url }: { url: string }) => (opened.push(url), { id: 3 }),
      update: async (_id: number, { url }: { url: string }) => (opened.push(url), { id: 3 }),
      get: async () => ({ id: 3, status: 'complete' }),
    },
    windows: {
      create: async ({ url }: { url: string }) => (opened.push(url), { tabs: [{ id: 4 }] }),
    },
  });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => void (opened.length = 0));

describe('where the extension’s tab may go', () => {
  it('takes Facebook’s pages and its Accounts Center, over https only', () => {
    expect(workUrl('https://www.facebook.com/dana.reyes.4')).toBe(
      'https://www.facebook.com/dana.reyes.4',
    );
    expect(workUrl('https://web.facebook.com/groups/austinmakers/')).not.toBeNull();
    expect(workUrl('https://accountscenter.facebook.com/info_and_permissions/dyi/')).not.toBeNull();
    for (const bad of [
      'http://www.facebook.com/dana.reyes.4',
      'https://m.facebook.com/dana.reyes.4',
      'https://www.facebook.com.example.com/',
      'https://example.com/?u=https://www.facebook.com/',
      'https://user:pass@www.facebook.com/',
      'https://www.facebook.com:8443/',
      'javascript:alert(1)',
      'chrome://settings',
      '/dana.reyes.4',
      '',
    ])
      expect(workUrl(bad)).toBeNull();
  });

  it('opens a Facebook page, and refuses anything else without asking Chrome', async () => {
    const tab = new WorkTab('window');
    const going = tab.open('https://www.facebook.com/friends/requests');
    await vi.runAllTimersAsync();
    await expect(going).resolves.toBe(4);
    expect(opened).toEqual(['https://www.facebook.com/friends/requests']);
    await expect(tab.open('https://example.com/not-facebook')).rejects.toThrow(
      'That link isn’t a Facebook page, so the extension didn’t open it.',
    );
    await expect(new WorkTab('view').open('javascript:alert(1)')).rejects.toThrow(
      'isn’t a Facebook page',
    );
    expect(opened).toHaveLength(1);
  });
});
