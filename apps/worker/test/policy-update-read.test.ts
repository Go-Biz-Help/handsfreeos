/**
 * Reading a business's policy page the way the policy-update route does, and placing the section with the scripted
 * stand-in (what local development and the browser suite use): the website around the policy left out, headings
 * and lists kept, and the whole policy back with the section before the contact details. No database.
 */
import { parseStructured } from '@hfos/ai';
import {
  checkedPolicyPlan,
  MOBILE_DATA_CLAUSE,
  POLICY_PLACE_SCHEMA,
  POLICY_PLACE_SYSTEM,
  policyBlocks,
  PolicyPlaceAnswer,
  policyPlacePrompt,
  textingSection,
  updatedPolicy,
  updatedPolicyText,
} from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { pageText } from '../src/knowledge/crawl';

const PAGE = `<!doctype html><html><head><title>Privacy | Lone Star HVAC</title>
<script>window.track = 1</script></head><body>
<header><nav><a href="/">Home</a> <a href="/book">Book now</a></nav></header>
<main>
  <h1>Privacy Policy</h1>
  <p>Last updated: January 4, 2024</p>
  <p>Lone Star HVAC LLC respects your privacy. This policy explains what we collect when you use our website or
  book a repair, and how we use it.</p>
  <h2>Information we collect</h2>
  <p>We collect your name, phone number, email address and service address when you book with us.</p>
  <ul><li>Contact details you give us</li><li>The address of the work</li></ul>
  <h2>How we share it</h2>
  <p>We may share your information with our partners for marketing purposes.</p>
  <h2>Contact us</h2>
  <p>Lone Star HVAC LLC, 100 Main St, Austin, TX 78701</p>
</main>
<footer>© 2026 Lone Star HVAC. All rights reserved.</footer>
</body></html>`;

const business = {
  name: 'Lone Star HVAC',
  legalName: 'Lone Star HVAC LLC',
  phone: '(512) 555-0123',
};

describe('a business’s policy page, read and given back with the section', () => {
  const blocks = policyBlocks(pageText(PAGE));

  it('keeps the policy’s headings and lists, and leaves the menus and footer out', () => {
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Privacy Policy' });
    expect(blocks.filter((b) => b.kind === 'item').map((b) => b.text)).toEqual([
      'Contact details you give us',
      'The address of the work',
    ]);
    const words = blocks.map((b) => b.text).join(' ');
    expect(words).not.toMatch(/Book now|All rights reserved|window\.track/);
  });

  it('comes back whole, with the section before the contact details and the date and sharing fixed', async () => {
    const section = textingSection('privacy', business);
    const turn = await scriptedAi().stream({
      system: POLICY_PLACE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: policyPlacePrompt({
            kind: 'privacy',
            businessName: business.name,
            today: 'October 15, 2026',
            section,
            blocks,
          }),
        },
      ],
      responseFormat: { schema: POLICY_PLACE_SCHEMA },
    });
    const plan = checkedPolicyPlan(parseStructured(turn, PolicyPlaceAnswer), blocks)!;
    const text = updatedPolicyText(updatedPolicy(blocks, plan, section));
    expect(text.indexOf(MOBILE_DATA_CLAUSE)).toBeGreaterThan(text.indexOf('How we share it'));
    expect(text.indexOf(MOBILE_DATA_CLAUSE)).toBeLessThan(text.indexOf('Contact us'));
    expect(text).toContain('Last updated: October 15, 2026');
    expect(text).toContain('never shared for marketing');
    expect(text).toContain('• The address of the work');
  });
});
