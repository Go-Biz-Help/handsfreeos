/**
 * Where "Get the phone app" sends people. Android is on Google Play (Chris, 2026-10-21); iPhone is still the
 * TestFlight test (Chris, 2026-09-29), so `testing` stays true. When Chris says the App Store version is out, the
 * iPhone link changes to it, `testing` goes false, and `apps/site/src/content/site.ts` gets it too. Browser-safe.
 *
 * The Google Play link carries `pcampaignid=onboarding`; the website's carries `pcampaignid=site`.
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
      url: 'https://play.google.com/store/apps/details?id=com.gobizhelp.handsfreeos&pcampaignid=onboarding',
    },
  ] satisfies readonly PhoneAppLink[],
} as const;
