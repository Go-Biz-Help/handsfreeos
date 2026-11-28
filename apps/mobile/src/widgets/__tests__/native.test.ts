/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  WIDGET_EMPTY_WORDS,
  WIDGET_GALLERY,
  WIDGETS_DATA_VERSION,
  type WidgetKind,
} from '@hfos/core';

import { ANDROID_WIDGETS } from '../android';
import { DATA } from './fixture';

/**
 * The widgets' words that live outside core, because a widget can't ask the app for them before it has a copy: the
 * gallery's names (Swift and app.json), the empty words (Swift), the copy's version (Swift), and the gallery's
 * sample, which must have the copy's shape or the iPhone's gallery shows nothing.
 */

const MOBILE = resolve(__dirname, '../../..');
const swift = (file: string) => readFileSync(join(MOBILE, 'targets/widgets', file), 'utf8');

/** The JSON between the markers in Shared.swift, as Swift reads it once its indentation is gone. */
function sampleJson(): unknown {
  const text = swift('Shared.swift');
  const body = text.split('// SAMPLE-JSON-START')[1]!.split('// SAMPLE-JSON-END')[0]!;
  const inner = body.split('"""')[1]!;
  return JSON.parse(inner.replace(/\n {4}/g, '\n'));
}

/** Every key path in a value, arrays read through their first item. */
function shape(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.length ? shape(value[0], `${at}[]`) : [`${at}[]`];
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      // An add-on's id and a "+N more" count are keys of a map, not of the shape.
      const key = /^(addons|more)$/.test(k) ? `${k}{}` : k;
      return [`${at}.${key}`, ...(key.endsWith('{}') ? [] : shape(v, `${at}.${key}`))];
    });
  return [];
}

describe('the widgets’ words outside core', () => {
  it('names each widget in the iPhone’s gallery as core does', () => {
    const text = swift('Shared.swift');
    for (const kind of Object.keys(WIDGET_GALLERY) as WidgetKind[]) {
      const { name, description } = WIDGET_GALLERY[kind];
      expect(text).toContain(
        `static let ${kind} = GalleryEntry(name: "${name}", description: "${description}")`,
      );
    }
  });

  it('names each Android widget in app.json as core does', () => {
    const app = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')) as {
      expo: { plugins: unknown[] };
    };
    const plugin = app.expo.plugins.find(
      (p) => Array.isArray(p) && p[0] === 'react-native-android-widget',
    ) as [string, { widgets: { name: string; label: string; description: string }[] }];
    expect(plugin).toBeDefined();
    const declared = plugin[1].widgets;
    expect(declared.map((w) => w.name).sort()).toEqual(Object.keys(ANDROID_WIDGETS).sort());
    for (const w of declared) {
      const kind = ANDROID_WIDGETS[w.name as keyof typeof ANDROID_WIDGETS];
      expect({ label: w.label, description: w.description }).toEqual({
        label: WIDGET_GALLERY[kind].name,
        description: WIDGET_GALLERY[kind].description,
      });
    }
  });

  it('says what core says with no copy, and reads the version core writes', () => {
    const shared = swift('Shared.swift');
    expect(shared).toContain(`static let signedOut = "${WIDGET_EMPTY_WORDS.signedOut}"`);
    expect(shared).toContain(`static let locked = "${WIDGET_EMPTY_WORDS.locked}"`);
    expect(swift('WidgetsData.swift')).toContain(
      `let widgetsDataVersion = ${WIDGETS_DATA_VERSION}`,
    );
  });

  it('shows a gallery sample in the copy’s own shape', () => {
    const sample = sampleJson();
    expect(new Set(shape(sample))).toEqual(new Set(shape(JSON.parse(JSON.stringify(DATA)))));
  });
});
