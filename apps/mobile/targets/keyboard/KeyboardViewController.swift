import SwiftUI
import UIKit

/// The HandsFreeOS keyboard on iPhone (docs/phone-keyboard.md): letters, numbers and symbols, plus a row on top that
/// types the business's templates and links. It reads the copy the app keeps in the App Group each time it opens
/// (which needs Full Access), never goes online, and never keeps or sends anything typed with it.
///
/// App Review's rules for keyboards (4.4.1) shape it: it types without Full Access, it has a next-keyboard key, and it
/// opens no other app.
final class KeyboardViewController: UIInputViewController {
  private lazy var model = KeyboardModel(controller: self)
  private var host: UIHostingController<KeyboardView>?
  private var heightConstraint: NSLayoutConstraint?

  override func viewDidLoad() {
    super.viewDidLoad()
    let hosting = UIHostingController(rootView: KeyboardView(model: model))
    hosting.view.backgroundColor = .clear
    hosting.view.translatesAutoresizingMaskIntoConstraints = false
    if #available(iOS 16.4, *) {
      hosting.safeAreaRegions = []
    }
    addChild(hosting)
    view.addSubview(hosting.view)
    NSLayoutConstraint.activate([
      hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
      hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    hosting.didMove(toParent: self)
    host = hosting
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    model.open()
    updateHeight()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    model.close()
  }

  override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
    super.viewWillTransition(to: size, with: coordinator)
    coordinator.animate(alongsideTransition: nil) { _ in self.updateHeight() }
  }

  override func textDidChange(_ textInput: UITextInput?) {
    super.textDidChange(textInput)
    model.fieldChanged()
  }

  /// The row on top plus four rows of keys, shorter in landscape.
  private func updateHeight() {
    let screen = UIScreen.main.bounds
    let landscape = screen.width > screen.height
    model.landscape = landscape
    let height = KeyboardView.height(landscape: landscape)
    if let constraint = heightConstraint {
      constraint.constant = height
    } else {
      let constraint = view.heightAnchor.constraint(equalToConstant: height)
      constraint.priority = UILayoutPriority(999)
      constraint.isActive = true
      heightConstraint = constraint
    }
  }
}
