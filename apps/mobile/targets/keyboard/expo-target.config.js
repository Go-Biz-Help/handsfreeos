/**
 * The HandsFreeOS keyboard on iPhone (docs/phone-keyboard.md), built by @bacons/apple-targets at prebuild: a keyboard
 * extension with its own bundle id (com.gobizhelp.handsfreeos.keyboard) in the app's App Group, where the app keeps
 * the templates and links it shows (modules/hfos-shared). Info.plist is ours, not generated: it asks for Full Access
 * (RequestsOpenAccess), which is what lets the keyboard read the App Group.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'keyboard',
  name: 'HandsFreeOSKeyboard',
  displayName: 'HandsFreeOS',
  bundleIdentifier: '.keyboard',
  // The app's own floor (the local modules' podspecs say the same), so every phone that runs the app gets the keyboard.
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI'],
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
