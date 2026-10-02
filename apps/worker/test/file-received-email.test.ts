/**
 * What the email says when a customer sends the file a qualifying question asks for (20261018000400): who sent what,
 * for which question, how it came, and where it is now.
 */
import { describe, expect, it } from 'vitest';
import { fileReceivedEmail } from '../src/emails/templates';

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
