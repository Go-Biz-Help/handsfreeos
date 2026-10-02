/**
 * The AI teammate's qualifying emails (20261018000400): when a customer sends the file a question asks for (who sent
 * what, for which question, how it came, and where it is now), and when a lead qualifies (with the answers).
 */
import { describe, expect, it } from 'vitest';
import { fileReceivedEmail, leadQualifiedEmail } from '../src/emails/templates';

const LINK = 'https://app.handsfreeos.com/app/w/w1/leads/l1';
const email = (over: Partial<Parameters<typeof fileReceivedEmail>[0]> = {}) =>
  fileReceivedEmail({
    customer: 'Rosa Diaz',
    question: 'Can you send a photo of your latest electric bill?',
    files: ['bill.pdf'],
    via: 'file_link',
    link: LINK,
    onLead: true,
    ...over,
  });

describe('the file email', () => {
  it('names the customer, the file and the question, and opens the lead', () => {
    const m = email();
    expect(m.subject).toBe('Rosa Diaz sent a file');
    expect(m.text).toContain(
      'Rosa Diaz sent “bill.pdf” through the link you texted them, for “Can you send a photo of your latest electric bill?”. It’s on their lead, under Files.',
    );
    expect(m.text).toContain(`Open the lead: ${LINK}`);
    expect(m.html).toContain('<strong>Rosa Diaz</strong>');
    expect(m.html).toContain(LINK);
  });

  it('lists several files, and says when they came by message', () => {
    const m = email({ files: ['page-1.jpg', 'page-2.jpg'], via: 'message' });
    expect(m.subject).toBe('Rosa Diaz sent 2 files');
    expect(m.text).toContain('Rosa Diaz sent 2 files by message');
    expect(m.text).toContain('- page-1.jpg\n- page-2.jpg');
  });

  it('opens the customer when the lead has gone', () => {
    const m = email({ onLead: false, link: 'https://app.handsfreeos.com/app/w/w1/customers/p1' });
    expect(m.text).toContain('It’s on the customer, under Files.');
    expect(m.text).toContain(
      'Open the customer: https://app.handsfreeos.com/app/w/w1/customers/p1',
    );
  });

  it('escapes what the customer and the owner wrote', () => {
    const m = email({ customer: 'Ann <b>', files: ['<script>.pdf'] });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('Ann &lt;b&gt;');
  });
});

describe('the qualified-lead email', () => {
  const qualified = (over: Partial<Parameters<typeof leadQualifiedEmail>[0]> = {}) =>
    leadQualifiedEmail({
      customer: 'Rosa Diaz',
      lead: 'Solar panels',
      answers: [
        { question: 'Do you own the home?', answer: 'Yes' },
        {
          question: 'Can you send a photo of your latest electric bill?',
          answer: 'Sent “bill.pdf”',
        },
      ],
      teammate: 'Ava',
      link: LINK,
      ...over,
    });

  it('names the customer and the lead, with each answer under its question', () => {
    const m = qualified();
    expect(m.subject).toBe('Rosa Diaz is qualified: Solar panels');
    expect(m.text).toContain(
      'Rosa Diaz answered every qualifying question, and nothing rules them out. Ava asked the questions.',
    );
    expect(m.text).toContain('Do you own the home?\n  Yes');
    expect(m.text).toContain(`Open the lead: ${LINK}`);
    expect(m.text).toContain('open AI teammate, then Qualify');
    expect(m.html).toContain('Sent “bill.pdf”');
  });

  it('leaves out who asked when there’s no teammate to name, and escapes what customers wrote', () => {
    const m = qualified({
      teammate: null,
      answers: [{ question: 'Budget?', answer: '<b>5k</b>' }],
    });
    expect(m.text).not.toContain('asked the questions');
    expect(m.html).not.toContain('<b>5k</b>');
    expect(m.html).toContain('&lt;b&gt;5k&lt;/b&gt;');
  });
});
