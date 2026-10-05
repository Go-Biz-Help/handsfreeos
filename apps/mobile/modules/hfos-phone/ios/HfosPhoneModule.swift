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

private final class NewContactDelegate: NSObject, CNContactViewControllerDelegate {
  private let done: (Bool) -> Void
  init(done: @escaping (Bool) -> Void) { self.done = done }

  func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
    done(contact != nil)
  }
}
