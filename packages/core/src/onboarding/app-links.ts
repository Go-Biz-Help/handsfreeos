/**
 * Where "Get the phone app" sends people. Android is on Google Play (Chris, 2026-10-21) and iPhone on the App Store
 * (live 2026-10-31), so `testing` is false. `apps/site/src/content/site.ts` has the same two store links. Set
 * `testing` back to true only if a store link ever points at a test build again. Browser-safe.
 *
 * The Google Play link's `referrer` holds UTM tags, `utm_source=onboarding` and `utm_campaign=get_the_app`, which
 * Play Console's acquisition reports group installs by; the website's link says `utm_source=website`. The App Store
 * link has no tags: Apple's campaign links need the provider token from App Store Connect.
 */
export interface PhoneAppLink {
  readonly platform: 'ios' | 'android';
  /** "iPhone" */
  readonly label: string;
  /** Where it installs from, as a person reads it: "App Store". */
  readonly from: string;
  readonly url: string;
}

export const PHONE_APP_LINKS = {
  testing: false,
  links: [
    {
      platform: 'ios',
      label: 'iPhone',
      from: 'App Store',
      url: 'https://apps.apple.com/app/handsfreeos/id6813606312',
    },
    {
      platform: 'android',
      label: 'Android',
      from: 'Google Play',
      url: 'https://play.google.com/store/apps/details?id=com.gobizhelp.handsfreeos&referrer=utm_source%3Donboarding%26utm_campaign%3Dget_the_app',
    },
  ] satisfies readonly PhoneAppLink[],
} as const;
