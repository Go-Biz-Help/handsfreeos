import ExpoModulesCore
import UIKit

/// What the app asks the phone itself. On an iPhone the phone does most of it: a notification button that needs the
/// phone unlocked is registered with "authentication required", so iOS asks for Face ID or the passcode before the app
/// hears of the press, and an app opening its own app.handsfreeos.com link hands it to Safari.
public class HfosPhoneModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HfosPhone")

    /// iOS checks the lock itself before a button that needs it reaches the app (see above).
    Function("isDeviceLocked") { () -> Bool in
      return false
    }

    /// Opens the address in Safari (or the phone's default browser).
    AsyncFunction("openInBrowser") { (url: String, promise: Promise) in
      guard let address = URL(string: url) else {
        promise.resolve(false)
        return
      }
      UIApplication.shared.open(address, options: [:]) { opened in
        promise.resolve(opened)
      }
    }.runOnQueue(.main)
  }
}
