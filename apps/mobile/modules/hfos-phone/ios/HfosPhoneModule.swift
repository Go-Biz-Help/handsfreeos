import Contacts
import ContactsUI
import ExpoModulesCore
import QuickLook
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

    /// Lets the person pick one contact in the system's own contact picker, which runs outside the app: HandsFreeOS
    /// gets only the contact picked, so it asks for no contacts permission. The contact's names, company, numbers,
    /// emails and addresses; "cancelled"; or "unavailable" with nothing on screen to show the picker over.
    AsyncFunction("pickContact") { (promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve("unavailable")
        return
      }
      if self.picking != nil {
        promise.resolve("cancelled")
        return
      }
      let picker = CNContactPickerViewController()
      let delegate = ContactPickerDelegate { contact in
        self.picking = nil
        if let contact = contact {
          promise.resolve(pickedContact(contact))
        } else {
          promise.resolve("cancelled")
        }
      }
      self.picking = delegate
      picker.delegate = delegate
      presenter.present(picker, animated: true)
    }.runOnQueue(.main)

    /// Shows a file the app decrypted into its cache (a document kept on the phone) in Quick Look, inside the app.
    /// "closed" once the person closes it, so the app deletes the copy; "unavailable" when Quick Look can't show it.
    AsyncFunction("viewFile") { (path: String, _: String, promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve("unavailable")
        return
      }
      let parsed = URL(string: path)
      let item = parsed?.isFileURL == true ? parsed! : URL(fileURLWithPath: path)
      guard QLPreviewController.canPreview(item as NSURL) else {
        promise.resolve("unavailable")
        return
      }
      let preview = QLPreviewController()
      let source = PreviewSource(item: item) {
        promise.resolve("closed")
        self.previewing = nil
      }
      self.previewing = source
      preview.dataSource = source
      preview.delegate = source
      presenter.present(preview, animated: true)
    }.runOnQueue(.main)
  }

  /// The New Contact screen's delegate, kept while it's open.
  private var pending: NewContactDelegate?
  /// The document on screen in Quick Look, kept while it's open.
  private var previewing: PreviewSource?
  /// The contact picker's delegate, kept while it's open.
  private var picking: ContactPickerDelegate?
}

/// What the app takes from a picked contact: only what a customer's record has room for, and each part only when the
/// picker handed it over (reading a part it held back would stop the app).
private func pickedContact(_ contact: CNContact) -> [String: Any] {
  var picked: [String: Any] = [:]
  if contact.isKeyAvailable(CNContactGivenNameKey) {
    picked["firstName"] = contact.givenName
  }
  if contact.isKeyAvailable(CNContactFamilyNameKey) {
    picked["lastName"] = contact.familyName
  }
  if contact.isKeyAvailable(CNContactOrganizationNameKey) {
    picked["company"] = contact.organizationName
  }
  if contact.isKeyAvailable(CNContactPhoneNumbersKey) {
    picked["phones"] = contact.phoneNumbers.map { item -> [String: Any] in
      ["number": item.value.stringValue, "label": labelOf(item.label)]
    }
  }
  if contact.isKeyAvailable(CNContactEmailAddressesKey) {
    picked["emails"] = contact.emailAddresses.map { item -> [String: Any] in
      ["email": item.value as String, "label": labelOf(item.label)]
    }
  }
  if contact.isKeyAvailable(CNContactPostalAddressesKey) {
    picked["addresses"] = contact.postalAddresses.map { item -> [String: Any] in
      let address = item.value
      return [
        "street": address.street,
        "city": address.city,
        "state": address.state,
        "postalCode": address.postalCode,
        "country": address.isoCountryCode,
        "label": labelOf(item.label),
      ]
    }
  }
  return picked
}

/// A label as the phone shows it ("mobile", "home"), or "" when there's none.
private func labelOf(_ label: String?) -> String {
  guard let label = label else { return "" }
  return CNLabeledValue<NSString>.localizedString(forLabel: label)
}

/// One file for Quick Look, read-only, and when it's closed.
private final class PreviewSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private let item: URL
  private let done: () -> Void
  init(item: URL, done: @escaping () -> Void) {
    self.item = item
    self.done = done
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item as NSURL
  }

  /// A kept document is HandsFreeOS's copy: marking it up here would change nothing anyone else sees.
  func previewController(_ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem)
    -> QLPreviewItemEditingMode
  {
    .disabled
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    done()
  }
}

/// The contact picker's delegate: the contact picked, or nil when the person cancelled.
private final class ContactPickerDelegate: NSObject, CNContactPickerDelegate {
  private let done: (CNContact?) -> Void
  init(done: @escaping (CNContact?) -> Void) { self.done = done }

  func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
    picker.dismiss(animated: true)
    done(contact)
  }

  func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
    done(nil)
  }
}

private final class NewContactDelegate: NSObject, CNContactViewControllerDelegate {
  private let done: (Bool) -> Void
  init(done: @escaping (Bool) -> Void) { self.done = done }

  func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
    done(contact != nil)
  }
}
