/**
 * What a connected Zoom account's settings mean for transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §7),
 * and how to fix each one. The worker reads the settings and stores the codes; Settings → My calendar shows the
 * words. Clients branch on the code, never on the words.
 */

export const MEETING_SETTINGS_PROBLEMS = [
  'zoom_basic_plan',
  'zoom_cloud_recording_off',
  'zoom_transcript_off',
] as const;
export type MeetingSettingsProblem = (typeof MEETING_SETTINGS_PROBLEMS)[number];

/** The parts of Zoom's answers the check needs: the user's plan type, and two recording switches. */
export interface ZoomRecordingSettings {
  /** Zoom's user type: 1 is Basic (free); 2 and up are paid. */
  readonly planType: number | null;
  readonly cloudRecording: boolean | null;
  readonly audioTranscript: boolean | null;
}

/**
 * The problems, in the order to fix them. A free plan can't record to the cloud at all, so it's the only one
 * named then; a switch Zoom didn't report is not counted as off.
 */
export function zoomSettingsProblems(s: ZoomRecordingSettings): MeetingSettingsProblem[] {
  if (s.planType === 1) return ['zoom_basic_plan'];
  const out: MeetingSettingsProblem[] = [];
  if (s.cloudRecording === false) out.push('zoom_cloud_recording_off');
  if (s.audioTranscript === false) out.push('zoom_transcript_off');
  return out;
}

/** Each problem as a person reads it: what's wrong, then what to do and where. */
export const MEETING_SETTINGS_WORDS: Record<
  MeetingSettingsProblem,
  { title: string; fix: string }
> = {
  zoom_basic_plan: {
    title: 'Zoom’s free plan can’t save recordings or transcripts.',
    fix: 'Upgrade to a paid Zoom plan to get transcripts after your calls. Zoom links still work without one.',
  },
  zoom_cloud_recording_off: {
    title: 'Cloud recording is off in your Zoom account.',
    fix: 'Turn on Cloud recording in Zoom: Settings → Recording. If you can’t switch it on, your Zoom admin has locked it; ask them to turn it on.',
  },
  zoom_transcript_off: {
    title: 'Audio transcripts are off in your Zoom account.',
    fix: 'Turn on Create audio transcript in Zoom: Settings → Recording → Cloud recording. If you can’t switch it on, your Zoom admin has locked it; ask them to turn it on.',
  },
};

/** The words for stored codes, skipping any this version doesn't know. */
export function meetingSettingsWords(
  codes: readonly string[],
): { code: MeetingSettingsProblem; title: string; fix: string }[] {
  return codes
    .filter((c): c is MeetingSettingsProblem =>
      (MEETING_SETTINGS_PROBLEMS as readonly string[]).includes(c),
    )
    .map((code) => ({ code, ...MEETING_SETTINGS_WORDS[code] }));
}
