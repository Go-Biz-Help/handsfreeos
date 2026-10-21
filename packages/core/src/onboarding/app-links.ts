/**
 * Where "Get the phone app" sends people. Android is on Google Play (Chris, 2026-10-21); iPhone is still the
 * TestFlight test (Chris, 2026-09-29), so `testing` stays true. When Chris says the App Store version is out, the
 * iPhone link changes to it, `testing` goes false, and `apps/site/src/content/site.ts` gets it too. Browser-safe.
 *
 * The Google Play link's `referrer` holds UTM tags, `utm_source=onboarding` and `utm_campaign=get_the_app`, which
 * Play Console's acquisition reports group installs by; the website's link says `utm_source=website`.
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
      from: 'Google Play',
      url: 'https://play.google.com/store/apps/details?id=com.gobizhelp.handsfreeos&referrer=utm_source%3Donboarding%26utm_campaign%3Dget_the_app',
    },
  ] satisfies readonly PhoneAppLink[],
} as const;
