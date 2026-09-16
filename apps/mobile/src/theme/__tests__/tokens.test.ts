/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import { colors } from '../tokens';

/**
 * The phone's colours are the web's. The mixed accents are checked against what Chrome 152 computes for the web's own
 * `color-mix(in oklab, …)` expressions, and the two spike 1a measured on both phones.
 */
describe('tokens', () => {
  it('mixes the accents as a browser does', () => {
    expect(colors.light.accentHover).toBe('#2355b0');
    expect(colors.light.accentSoft).toBe('#e9f0fd');
    expect(colors.dark.accentSoft).toBe('#1f2d48');
    expect(colors.dark.accentHover).toBe('#4f83e0');
    expect(colors.light.ring).toBe('#2d69d847');
  });

  it('keeps the web’s plain colours', () => {
    expect(colors.light).toMatchObject({
      bg: '#f9fafd',
      card: '#ffffff',
      text: '#191d25',
      accent: '#2d69d8',
    });
    expect(colors.dark).toMatchObject({
      bg: '#0f131a',
      card: '#191d25',
      text: '#f2f4f8',
      accent: '#2d69d8',
    });
  });

  it('gives Uniwind the same colours as the values the app reads', () => {
    const css = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8');
    for (const theme of ['light', 'dark'] as const) {
      const block = new RegExp(`@variant ${theme} \\{([\\s\\S]*?)\\n    \\}`).exec(css)![1]!;
      const declared = Object.fromEntries(
        [...block.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((m) => [
          m[1]!.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
          m[2]!.trim(),
        ]),
      );
      for (const [name, value] of Object.entries(colors[theme])) {
        const inCss = declared[name];
        expect(inCss).toBeDefined();
        if (inCss!.startsWith('#')) expect(inCss).toBe(value);
      }
    }
  });
});
