/** Asking a customer for a file (20261018000400): what kinds of file answer a file question, and the words. */
import { describe, expect, it } from 'vitest';
import { FILE_LINK_WORDS, fileAnswerWords, isFileAnswerType } from '../src/messaging/file-link';

describe('what answers a file question', () => {
  it('takes photos and PDFs, the kinds a lead’s Files hold', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/heic', 'application/pdf', 'IMAGE/JPEG'])
      expect(isFileAnswerType(t)).toBe(true);
    expect(isFileAnswerType('application/pdf; charset=binary')).toBe(true);
    for (const t of ['video/mp4', 'audio/amr', 'text/vcard', '', null, undefined])
      expect(isFileAnswerType(t)).toBe(false);
  });

  it('keeps the answer as the files’ names', () => {
    expect(fileAnswerWords(['bill.pdf'])).toBe('Sent “bill.pdf”');
    expect(fileAnswerWords(['a.jpg', 'b.jpg', 'c.pdf'])).toBe(
      'Sent 3 files: “a.jpg”, “b.jpg” and “c.pdf”',
    );
    // Never longer than an answer may be.
    expect(fileAnswerWords(Array.from({ length: 5 }, () => `${'x'.repeat(190)}.pdf`))).toBe(
      'Sent 5 files',
    );
  });

  it('tells the customer what was asked, with its full stop', () => {
    expect(FILE_LINK_WORDS.intro('Your latest electric bill')).toBe(
      'Your latest electric bill. Send a photo or a PDF.',
    );
    expect(FILE_LINK_WORDS.intro('Can you send your latest bill?')).toBe(
      'Can you send your latest bill? Send a photo or a PDF.',
    );
    expect(FILE_LINK_WORDS.intro('')).toBe('Send a photo or a PDF.');
  });
});
