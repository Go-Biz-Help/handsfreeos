/**
 * Where "Get the phone app" sends people. The app isn't in the stores yet, so these are the test links: TestFlight
 * for iPhone and Google Play's internal test for Android (Chris, 2026-09-29). When Chris says the store versions are
 * out, this file changes to the store addresses, `testing` goes false, and `apps/site/src/content/site.ts` gets them
 * too. Browser-safe.
 *
 * Google Play's internal test installs only for Google accounts on its tester list in Play Console; anyone else is
 * told the app isn't available.
 */
export interface PhoneAppLink {
  readonly platform: 'ios' | 'android';
  /** "iPhone" */
  readonly label: string;
  /** Where it installs from, as a person reads it: "TestFlight". */
  readonly from: string;
  readonly url: string;
}

export const PHONE_APP_LINKS = {
  testing: true,
  links: [
    {
      platform: 'ios',
      label: 'iPhone',
      from: 'TestFlight',
      url: 'https://testflight.apple.com/join/GBEM8rJU',
    },
    {
      platform: 'android',
      label: 'Android',
      from: 'Google Play testing',
      url: 'https://play.google.com/apps/internaltest/4701652122344223804',
    },
  ] satisfies readonly PhoneAppLink[],
} as const;
