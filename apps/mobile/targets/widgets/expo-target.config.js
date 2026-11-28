/**
 * The home-screen and lock-screen widgets on iPhone (docs/phone-widgets.md), built by @bacons/apple-targets at
 * prebuild: a WidgetKit extension with its own bundle id (com.gobizhelp.handsfreeos.widgets) in the app's App Group,
 * where the app keeps what the widgets show (modules/hfos-shared, the `widgets` key). Everything a widget says is
 * worked out by core (`buildWidgetsData`); the Swift here only picks the moment it's in and lays the words out.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'HandsFreeOSWidgets',
  displayName: 'HandsFreeOS',
  bundleIdentifier: '.widgets',
  // The app's own floor, as the keyboard's: lock-screen widgets need iOS 16, and every phone that runs the app has it.
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI', 'WidgetKit'],
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
