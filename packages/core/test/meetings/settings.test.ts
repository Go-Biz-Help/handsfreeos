import { describe, expect, it } from 'vitest';
import {
  MEETING_SETTINGS_PROBLEMS,
  MEETING_SETTINGS_WORDS,
  meetingSettingsWords,
  zoomSettingsProblems,
} from '../../src/meetings/settings';

describe('what Zoom’s settings mean for transcripts', () => {
  it('a paid plan with both switches on has nothing to fix', () => {
    expect(
      zoomSettingsProblems({ planType: 2, cloudRecording: true, audioTranscript: true }),
    ).toEqual([]);
  });

  it('names each switch that’s off, in the order to fix them', () => {
    expect(
      zoomSettingsProblems({ planType: 2, cloudRecording: false, audioTranscript: false }),
    ).toEqual(['zoom_cloud_recording_off', 'zoom_transcript_off']);
    expect(
      zoomSettingsProblems({ planType: 3, cloudRecording: true, audioTranscript: false }),
    ).toEqual(['zoom_transcript_off']);
  });

  it('a free plan is the only problem named, since nothing else can help', () => {
    expect(
      zoomSettingsProblems({ planType: 1, cloudRecording: false, audioTranscript: false }),
    ).toEqual(['zoom_basic_plan']);
  });

  it('a switch Zoom didn’t report isn’t counted as off', () => {
    expect(
      zoomSettingsProblems({ planType: null, cloudRecording: null, audioTranscript: null }),
    ).toEqual([]);
  });

  it('every problem says what to do and where, and unknown codes are skipped', () => {
    for (const code of MEETING_SETTINGS_PROBLEMS) {
      expect(MEETING_SETTINGS_WORDS[code].title).toMatch(/\.$/);
      expect(MEETING_SETTINGS_WORDS[code].fix.length).toBeGreaterThan(20);
    }
    expect(MEETING_SETTINGS_WORDS.zoom_transcript_off.fix).toContain('Settings → Recording');
    expect(
      meetingSettingsWords(['zoom_transcript_off', 'something_new']).map((w) => w.code),
    ).toEqual(['zoom_transcript_off']);
  });
});
