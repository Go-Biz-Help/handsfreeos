import { describe, expect, it } from 'vitest';
import { vttToText } from '../src/meetings/vtt';
import { isZoomDownload } from '../src/meetings/zoom';

describe('Zoom’s transcript captions as text', () => {
  it('keeps the words, one line per turn, a speaker’s lines run together', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:04.000',
      'Dale Rivera: Thanks for jumping on.',
      '',
      '2',
      '00:00:04.500 --> 00:00:06.000',
      'Dale Rivera: Let’s talk about the duct cleaning.',
      '',
      '3',
      '00:00:06.500 --> 00:00:09.000',
      'Mike Johnson: Sure, can you send a quote by Friday?',
      '',
    ].join('\r\n');
    expect(vttToText(vtt)).toBe(
      'Dale Rivera: Thanks for jumping on. Let’s talk about the duct cleaning.\nMike Johnson: Sure, can you send a quote by Friday?',
    );
  });

  it('keeps lines without a speaker, and nothing from an empty file', () => {
    expect(vttToText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello there\n')).toBe('hello there');
    expect(vttToText('WEBVTT\n')).toBe('');
  });
});

describe('which transcript links are fetched', () => {
  it('only https links on zoom.us', () => {
    expect(isZoomDownload('https://zoom.us/rec/download/abc')).toBe(true);
    expect(isZoomDownload('https://us02web.zoom.us/rec/download/abc')).toBe(true);
    expect(isZoomDownload('http://zoom.us/rec/download/abc')).toBe(false);
    expect(isZoomDownload('https://zoom.us.evil.example/rec')).toBe(false);
    expect(isZoomDownload('https://169.254.169.254/latest')).toBe(false);
    expect(isZoomDownload('not a url')).toBe(false);
  });
});
