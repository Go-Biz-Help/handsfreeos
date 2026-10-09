/**
 * Facebook's zips among Chrome's downloads (src/hfos/files.ts): which downloads are Facebook's, and the address a
 * downloaded file is opened at on a Mac and on Windows.
 */
import { describe, expect, it } from 'vitest';
import { fileNameOf, fileUrlOf, isFacebookZip } from '../src/hfos/files';

describe('Facebook’s zips', () => {
  it('is a zip from Facebook, its file servers, or made on one of its pages', () => {
    const zip = '/Users/pat/Downloads/facebook-patexample-2026-10-09.zip';
    expect(
      isFacebookZip({
        url: 'https://bigzipfiles.facebook.com/p/dl/download/file.php?r=1',
        filename: zip,
      }),
    ).toBe(true);
    expect(isFacebookZip({ url: 'https://scontent.xx.fbcdn.net/x.zip', filename: zip })).toBe(true);
    expect(
      isFacebookZip({
        url: 'blob:https://www.facebook.com/4f9c-11aa',
        filename: '/Users/pat/Downloads/messages.zip',
      }),
    ).toBe(true);
    expect(
      isFacebookZip({
        url: 'https://cdn.example.com/f',
        referrer: 'https://accountscenter.facebook.com/info_and_permissions/dyi/',
        filename: zip,
      }),
    ).toBe(true);
  });

  it('isn’t anything else', () => {
    expect(
      isFacebookZip({ url: 'https://example.com/facebook.zip', filename: '/tmp/facebook.zip' }),
    ).toBe(false);
    expect(
      isFacebookZip({ url: 'https://www.facebook.com/photo.jpg', filename: '/tmp/photo.jpg' }),
    ).toBe(false);
    expect(
      isFacebookZip({ url: 'https://facebook.com.example.net/x.zip', filename: '/tmp/x.zip' }),
    ).toBe(false);
  });
});

describe('opening a downloaded file', () => {
  it('spells a Mac path as a file address', () => {
    expect(fileUrlOf('/Users/pat/Downloads/facebook pat #2.zip')).toBe(
      'file:///Users/pat/Downloads/facebook%20pat%20%232.zip',
    );
  });

  it('spells a Windows path as a file address', () => {
    expect(fileUrlOf('C:\\Users\\Pat\\Downloads\\facebook-pat.zip')).toBe(
      'file:///C:/Users/Pat/Downloads/facebook-pat.zip',
    );
  });

  it('names the file without its folders', () => {
    expect(fileNameOf('C:\\Users\\Pat\\Downloads\\facebook-pat.zip')).toBe('facebook-pat.zip');
    expect(fileNameOf('/Users/pat/Downloads/messages.zip')).toBe('messages.zip');
  });
});
