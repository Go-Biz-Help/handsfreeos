/**
 * A saved template put into a reply (the reply box's template button): the customer's and the business's
 * details go in, and what a reply can't know stays as written so nobody sends a gap.
 */
import { describe, expect, it } from 'vitest';
import { fillReplyTemplate, TEMPLATE_PICKER_WORDS } from '../src';

const mike = {
  firstName: 'Mike',
  email: 'mike@example.com',
  phone: '(713) 555-0142',
  businessName: 'Lone Star HVAC',
};

describe('a template in a reply', () => {
  it('fills in the customer and the business', () => {
    const out = fillReplyTemplate(
      'Hi {{person.first_name}}, it’s {{ business.name }}. We have {{person.email}} on file.',
      mike,
    );
    expect(out.text).toBe('Hi Mike, it’s Lone Star HVAC. We have mike@example.com on file.');
    expect(out.left).toEqual([]);
  });

  it('uses a default for a stranger', () => {
    const out = fillReplyTemplate('Hi {{person.first_name | default:"there"}}!', {
      firstName: null,
    });
    expect(out.text).toBe('Hi there!');
    expect(out.left).toEqual([]);
  });

  it('leaves what a reply can’t know, and says so', () => {
    const out = fillReplyTemplate(
      'Hi {{person.first_name}}, about {{lead.title}}: book at {{links.booking}}.',
      mike,
    );
    expect(out.text).toBe('Hi Mike, about {{lead.title}}: book at {{links.booking}}.');
    expect(out.left).toEqual(['lead.title', 'links.booking']);
    expect(TEMPLATE_PICKER_WORDS.left(out.left)).toBe(
      'Fill in {{lead.title}}, {{links.booking}} before you send it.',
    );
  });

  it('leaves words with no placeholders alone', () => {
    expect(fillReplyTemplate('Thanks — see you soon.', mike)).toEqual({
      text: 'Thanks — see you soon.',
      left: [],
    });
  });
});
