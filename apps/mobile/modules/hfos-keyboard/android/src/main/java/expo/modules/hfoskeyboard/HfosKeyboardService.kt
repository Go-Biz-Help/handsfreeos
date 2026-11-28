package expo.modules.hfoskeyboard

import android.inputmethodservice.InputMethodService
import android.os.Build
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager

/**
 * The HandsFreeOS keyboard on Android (docs/phone-keyboard.md): letters, numbers and symbols, plus a row on top that
 * types the business's templates and links. It reads the copy the app keeps (KeyboardStore) each time it opens, never
 * goes online, and never keeps or sends anything typed with it.
 */
class HfosKeyboardService : InputMethodService(), BoardHost {
  private var board: KeyboardBoard? = null

  override fun onCreateInputView(): View {
    val created = KeyboardBoard(this, this)
    board = created
    return created.root
  }

  override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
    super.onStartInputView(info, restarting)
    val data = KeyboardStore.load(this)
    val business = if (data is KbLoad.Ready) KeyboardStore.businessToShow(this, data) else null
    board?.open(data, business)
  }

  override fun onFinishInputView(finishingInput: Boolean) {
    board?.close()
    super.onFinishInputView(finishingInput)
  }

  /** Never the full-screen editor in landscape: the row on top needs the field beside it. */
  override fun onEvaluateFullscreenMode(): Boolean = false

  // ---------- what the board asks for ----------

  override fun type(text: String) {
    currentInputConnection?.commitText(text, 1)
  }

  override fun deleteBackward() {
    val connection = currentInputConnection ?: return
    val selected = connection.getSelectedText(0)
    if (!selected.isNullOrEmpty()) connection.commitText("", 1)
    else sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
  }

  /** Return: the field's own action (Send, Search, Go) where it has one, else a new line. */
  override fun enter() {
    sendKeyChar('\n')
  }

  override fun before(count: Int): String =
    currentInputConnection?.getTextBeforeCursor(count, 0)?.toString() ?: ""

  override fun wantsCapital(): Boolean {
    val info = currentInputEditorInfo ?: return false
    val connection = currentInputConnection ?: return false
    if (info.inputType and InputType.TYPE_MASK_CLASS != InputType.TYPE_CLASS_TEXT) return false
    return connection.getCursorCapsMode(info.inputType) != 0
  }

  /** Back to the keyboard used before this one, or the phone's picker when there isn't one. */
  override fun nextKeyboard() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && switchToPreviousInputMethod()) return
    pickKeyboard()
  }

  override fun pickKeyboard() {
    (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.showInputMethodPicker()
  }

  override fun enterLabel(): String {
    val info = currentInputEditorInfo ?: return "↵"
    if (info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0) return "↵"
    if (info.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0) return "↵"
    return when (info.imeOptions and EditorInfo.IME_MASK_ACTION) {
      EditorInfo.IME_ACTION_GO -> "Go"
      EditorInfo.IME_ACTION_SEARCH -> "Search"
      EditorInfo.IME_ACTION_SEND -> "Send"
      EditorInfo.IME_ACTION_NEXT -> "Next"
      EditorInfo.IME_ACTION_DONE -> "Done"
      else -> "↵"
    }
  }
}
