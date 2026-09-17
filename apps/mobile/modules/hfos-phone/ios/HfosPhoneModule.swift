import Contacts
import ContactsUI
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

    /// Adds a business's number to Contacts through the system's own New Contact screen, which saves it itself: the
    /// app never reads the person's contacts, so it asks for no permission. "added", "cancelled" or "unavailable".
    AsyncFunction("addContact") { (name: String, phone: String, promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve("unavailable")
        return
      }
      let contact = CNMutableContact()
      contact.contactType = .organization
      contact.organizationName = name
      contact.phoneNumbers = [
        CNLabeledValue(label: CNLabelWork, value: CNPhoneNumber(stringValue: phone))
      ]
      let form = CNContactViewController(forNewContact: contact)
      let delegate = NewContactDelegate { saved in
        presenter.dismiss(animated: true)
        promise.resolve(saved ? "added" : "cancelled")
        self.pending = nil
      }
      self.pending = delegate
      form.delegate = delegate
      presenter.present(UINavigationController(rootViewController: form), animated: true)
    }.runOnQueue(.main)
  }

  /// The New Contact screen's delegate, kept while it's open.
  private var pending: NewContactDelegate?
}

private final class NewContactDelegate: NSObject, CNContactViewControllerDelegate {
  private let done: (Bool) -> Void
  init(done: @escaping (Bool) -> Void) { self.done = done }

  func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
    done(contact != nil)
  }
}
