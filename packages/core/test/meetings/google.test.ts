import { describe, expect, it } from 'vitest';
import {
  GOOGLE_MEET_TRANSCRIPT_SCOPE,
  hasMeetTranscripts,
  meetCodeOf,
} from '../../src/meetings/google';

describe('Google Meet', () => {
  it('reads the meeting code out of a Meet link, and nothing else', () => {
    expect(meetCodeOf('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij');
    expect(meetCodeOf('https://meet.google.com/ABC-DEFG-HIJ?authuser=0')).toBe('abc-defg-hij');
    expect(meetCodeOf('https://zoom.us/j/123')).toBeNull();
    expect(meetCodeOf('https://meet.google.com.evil.example/abc-defg-hij')).toBeNull();
    expect(meetCodeOf(null)).toBeNull();
  });

  it('knows a connection can read transcripts only with the Meet permission', () => {
    expect(hasMeetTranscripts(['https://www.googleapis.com/auth/calendar.freebusy'])).toBe(false);
    expect(hasMeetTranscripts([GOOGLE_MEET_TRANSCRIPT_SCOPE])).toBe(true);
  });
});
