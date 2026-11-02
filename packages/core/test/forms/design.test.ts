import { describe, expect, it } from 'vitest';
import {
  applyFormOps,
  DEFAULT_FORM_DESIGN,
  describeFormOps,
  diffForms,
  FormDefinition,
  FormDesign,
  formFontHref,
  formLook,
  formToolCallsToOps,
  type FormDefinition as FormDefinitionT,
} from '../../src/forms/index';
import { contrastRatio } from '../../src/chat/origins';
import { def, page, result, shortText } from './fixtures';

/**
 * A form's design (forms/design.ts): what's kept, the edit that changes it, and how the public page and the editor's
 * preview work it out.
 */

const base = (): FormDefinitionT =>
  def({ pages: [page('about', [shortText('name')])], results: [result('thanks')] });

describe('what’s kept', () => {
  it('gives a form saved before the Design tab a design with nothing set', () => {
    const { design: _gone, ...old } = base();
    const parsed = FormDefinition.parse(old);
    expect(parsed.design).toEqual(DEFAULT_FORM_DESIGN);
    expect(parsed.design.colors.button).toBeNull();
    expect(parsed.design.button.fullWidth).toBe(true);
    expect(parsed.design.showTitle).toBe(true);
  });

  it('refuses a colour that isn’t one, and a font name that isn’t a name', () => {
    expect(FormDesign.safeParse({ colors: { button: 'orange' } }).success).toBe(false);
    expect(FormDesign.safeParse({ font: 'Lato; } body { display:none' }).success).toBe(false);
    expect(FormDesign.parse({ colors: { button: '#E85D04' }, font: 'Open Sans' })).toMatchObject({
      colors: { button: '#e85d04' },
      font: 'Open Sans',
    });
  });
});

describe('changing it', () => {
  it('merges a change in, and Undo puts it back', () => {
    const start = base();
    const { definition, inverse } = applyFormOps(start, [
      { op: 'set_design', patch: { colors: { button: '#e85d04' }, corners: 'round' } },
    ]);
    expect(definition.design.colors.button).toBe('#e85d04');
    expect(definition.design.colors.text).toBeNull();
    expect(definition.design.corners).toBe('round');
    expect(applyFormOps(definition, inverse).definition).toEqual(start);
  });

  it('works on a form saved before the Design tab', () => {
    const { design: _gone, ...old } = base();
    const { definition } = applyFormOps(old as FormDefinitionT, [
      { op: 'set_design', patch: { scheme: 'dark' } },
    ]);
    expect(definition.design.scheme).toBe('dark');
  });

  it('says what changed, and diffs carry it', () => {
    const start = base();
    const ops = [{ op: 'set_design' as const, patch: { width: 'wide' as const } }];
    expect(describeFormOps(ops, start)).toEqual(['Changed the design']);
    const after = applyFormOps(start, ops).definition;
    expect(diffForms(start, after)).toEqual([{ op: 'set_design', patch: after.design }]);
  });

  it('is one of the AI form builder’s tools', () => {
    const { ops } = formToolCallsToOps(
      [
        {
          id: 'c1',
          name: 'set_design',
          arguments: { json: '{"colors":{"button":"#0b6e4f"},"fields":"underline"}' },
        },
      ],
      base(),
    );
    expect(ops).toEqual([
      { op: 'set_design', patch: { colors: { button: '#0b6e4f' }, fields: 'underline' } },
    ]);
  });
});

describe('how it looks', () => {
  it('follows the business’s colour, darkened for white words, until a colour is picked', () => {
    const yellow = formLook(DEFAULT_FORM_DESIGN, { businessColor: '#ffd23f' });
    expect(contrastRatio(yellow.vars['--accent']!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(yellow.vars['--form-on-accent']).toBe('#ffffff');
    const picked = formLook(FormDesign.parse({ colors: { button: '#ffd23f' } }), {
      businessColor: '#0b6e4f',
    });
    // Kept as picked, with words that read on it.
    expect(picked.vars['--accent']).toBe('#ffd23f');
    expect(picked.vars['--form-on-accent']).toBe('#111111');
  });

  it('is see-through on a website unless it has a background of its own', () => {
    expect(formLook(DEFAULT_FORM_DESIGN, { embedded: true }).paintsBackground).toBe(false);
    expect(formLook(DEFAULT_FORM_DESIGN, { embedded: false }).paintsBackground).toBe(true);
    const own = FormDesign.parse({ colors: { background: '#f4efe6' } });
    expect(formLook(own, { embedded: true }).paintsBackground).toBe(true);
    expect(formLook(own, { embedded: true }).vars['--form-surface']).toBe('#f4efe6');
  });

  it('works out words that read on a dark background', () => {
    const dark = formLook(FormDesign.parse({ scheme: 'dark' }));
    expect(contrastRatio(dark.vars['--text']!, dark.vars['--bg']!)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(dark.vars['--accent-text']!, dark.vars['--bg']!)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(dark.vars['--danger-text']!, dark.vars['--bg']!)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('loads a Google font, and nothing for HandsFreeOS’s own', () => {
    expect(formFontHref(null)).toBeNull();
    expect(formFontHref('Hanken Grotesk')).toBeNull();
    expect(formFontHref('Lato')).toBe(
      'https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap',
    );
    // One Match my website found that isn't on the list: its weights aren't known, so none are asked for.
    expect(formFontHref('Barlow Condensed')).toBe(
      'https://fonts.googleapis.com/css2?family=Barlow+Condensed&display=swap',
    );
    const look = formLook(FormDesign.parse({ font: 'Merriweather' }));
    expect(look.vars['--form-font']).toContain("'Merriweather', Georgia");
  });

  it('turns the shape and layout into what the stylesheet reads', () => {
    const look = formLook(
      FormDesign.parse({
        corners: 'square',
        fields: 'underline',
        button: { style: 'outline', fullWidth: false },
        labels: 'inside',
        width: 'narrow',
        textSize: 'large',
      }),
    );
    expect(look.vars['--radius-control']).toBe('0px');
    expect(look.vars['--form-max-width']).toBe('480px');
    expect(look.vars['--form-zoom']).toBe('1.12');
    expect(look.data).toEqual({
      'data-fields': 'underline',
      'data-button': 'outline',
      'data-button-width': 'auto',
      'data-labels': 'inside',
    });
    expect(look.labelsInside).toBe(true);
    expect(look.showTitle).toBe(true);
    expect(formLook(FormDesign.parse({ showTitle: false })).showTitle).toBe(false);
  });
});
