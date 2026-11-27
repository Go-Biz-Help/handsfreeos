import { describe, expect, it } from 'vitest';
import {
  POPUP_NOTE,
  popupCodesFor,
  popupLookOf,
  popupSeconds,
  popupSnippet,
} from '../../src/look/popup';
import { formLook, FormDesign } from '../../src/forms/design';

/**
 * A form or booking page in a pop-up (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 3): the code a business
 * pastes, for a button, after some seconds, or when a visitor goes to leave.
 */

const base = {
  url: 'https://acme.handsfree.test/book/acme/estimate',
  appOrigin: 'https://app.handsfree.test',
  name: 'Free estimate',
};

describe('the pop-up code', () => {
  it('is a button that opens the page’s embed address, and the line that loads the script', () => {
    const code = popupSnippet({ ...base, opens: 'button', label: 'Book now' });
    expect(code).toContain(
      'data-hfos-popup="https://acme.handsfree.test/book/acme/estimate?embed=1"',
    );
    expect(code).toContain('data-hfos-title="Free estimate"');
    expect(code).toContain('>Book now</button>');
    expect(code).toContain('<script src="https://app.handsfree.test/embed/v1/popup.js" async>');
  });

  it('wears the page’s own button colour, words and corners', () => {
    const look = popupLookOf(
      formLook(FormDesign.parse({ colors: { button: '#c2410c' }, corners: 'round' })).vars,
    );
    expect(look).toEqual({ background: '#c2410c', color: expect.any(String), radius: '22px' });
    const code = popupSnippet({ ...base, opens: 'button', label: 'Book', look });
    expect(code).toContain('background:#c2410c');
    expect(code).toContain('border-radius:22px');
  });

  it('opens by itself after the seconds asked, kept between 1 and 300, or when they go to leave', () => {
    const after = popupSnippet({ ...base, opens: 'after', seconds: 8 });
    expect(after).toMatch(/^<script src="[^"]+popup\.js" data-hfos-popup="[^"]+"/);
    expect(after).toContain('data-hfos-open="after" data-hfos-seconds="8"');
    expect(after).not.toContain('<button');
    expect(popupSeconds(0)).toBe(1);
    expect(popupSeconds(9999)).toBe(300);
    expect(popupSeconds(Number.NaN)).toBe(10);
    expect(popupSnippet({ ...base, opens: 'leave' })).toContain('data-hfos-open="leave"');
  });

  it('can’t be broken out of by a name, words or a look', () => {
    const code = popupSnippet({
      ...base,
      name: 'Say "hi" <script>',
      opens: 'button',
      label: '<img src=x onerror=alert(1)>',
      look: { background: 'red;position:fixed', color: '#fff', radius: '8px;top:0' },
    });
    expect(code).toContain('data-hfos-title="Say &quot;hi&quot; &lt;script&gt;"');
    expect(code).toContain('&lt;img src=x onerror=alert(1)&gt;</button>');
    expect(code).not.toContain('position:fixed');
    expect(code).not.toContain('top:0');
  });

  it('keeps a link that already asks something, and adds embed=1 after it', () => {
    expect(popupSnippet({ ...base, url: `${base.url}?service=abc`, opens: 'leave' })).toContain(
      '/book/acme/estimate?service=abc&amp;embed=1"',
    );
  });

  it('hands the Assistant all three, with what each does', () => {
    const codes = popupCodesFor(base.url, base.appOrigin, base.name, 'Book now');
    expect(codes.button).toContain('<button');
    expect(codes.afterTenSeconds).toContain('data-hfos-seconds="10"');
    expect(codes.whenLeaving).toContain('data-hfos-open="leave"');
    expect(POPUP_NOTE).toContain('7 days');
  });
});
