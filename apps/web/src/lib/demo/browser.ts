'use client';
import { publicEnv } from '../env';
import { demoResponse } from './respond';
import { readDemoState } from './state';

/**
 * The browser's side of the demo player: while a scene plays on this business's pages, the API's and the worker's
 * answers about its made-up records are made up here, before any request leaves the tab. Installed once, for
 * everyone, and a straight pass-through whenever no scene is playing (no cookie), so it costs one cookie read.
 */
let installed = false;

export function installDemoFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch.bind(window);
  const bases = [publicEnv.apiUrl, publicEnv.workerUrl].filter(Boolean);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const state = bases.some((b) => url.startsWith(b)) ? readDemoState() : null;
    if (!state) return original(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'POST') return original(input, init);
    const request = input instanceof Request ? input : null;
    const body =
      typeof init?.body === 'string' ? init.body : request ? await request.clone().text() : '';
    const made = await demoResponse(
      state,
      new URL(url).pathname,
      body,
      () => original(request ? request.clone() : input, init),
      init?.signal ?? request?.signal,
    );
    return made ?? original(input, init);
  };
}
