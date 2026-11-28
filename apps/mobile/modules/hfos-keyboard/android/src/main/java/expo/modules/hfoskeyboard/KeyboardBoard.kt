package expo.modules.hfoskeyboard

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** What the board asks of the keyboard service. */
interface BoardHost {
  fun type(text: String)
  fun deleteBackward()
  fun enter()
  /** Up to `count` characters before the cursor. */
  fun before(count: Int): String
  /** Whether the field wants a capital here: the start of a sentence, a name field. */
  fun wantsCapital(): Boolean
  fun nextKeyboard()
  fun pickKeyboard()
  fun enterLabel(): String
}

/**
 * The words only the keyboard says: before the app has written its copy, or when that copy is newer than this
 * keyboard. Everything else comes from the app (core's KEYBOARD_PANEL_WORDS).
 */
private object Own {
  const val templates = "Templates"
  const val links = "Links"
  const val letters = "ABC"
  const val missing = "Open HandsFreeOS and sign in to see your templates and links here."
  const val newer = "Update HandsFreeOS from the Play Store to see your templates and links here."
  const val noTemplates = "No templates yet."
  const val noLinks = "No links yet."
  const val askName = "Their first name"
  const val add = "Add"
  const val skip = "Skip"
  const val email = "Email"
  const val space = "HandsFreeOS"
}

private enum class Layer { LETTERS, NUMBERS, SYMBOLS }
private enum class Shift { OFF, ONCE, LOCK }
private enum class Panel { KEYS, TEMPLATES, LINKS, BUSINESSES }

/** The brand's colours (apps/mobile/src/theme/tokens.ts), for a keyboard: a grey tray, keys a step off it. */
private class Palette(dark: Boolean) {
  val tray = if (dark) 0xFF15191F.toInt() else 0xFFE3E6EB.toInt()
  val key = if (dark) 0xFF2C3139.toInt() else 0xFFFFFFFF.toInt()
  val keyDown = if (dark) 0xFF3A4049.toInt() else 0xFFD2D6DD.toInt()
  val special = if (dark) 0xFF20252E.toInt() else 0xFFC4C9D1.toInt()
  val specialDown = if (dark) 0xFF2C3139.toInt() else 0xFFAEB4BE.toInt()
  val text = if (dark) 0xFFF2F4F8.toInt() else 0xFF191D25.toInt()
  val text2 = if (dark) 0xFFA0A5AE.toInt() else 0xFF5B616A.toInt()
  val accent = 0xFF2D69D8.toInt()
  val onAccent = 0xFFFFFFFF.toInt()
  val accentSoft = if (dark) 0xFF1F2D48.toInt() else 0xFFE9F0FD.toInt()
  val accentText = if (dark) 0xFF7CA4EB.toInt() else 0xFF2D69D8.toInt()
  val warning = if (dark) 0xFFF5C97A.toInt() else 0xFF6B4300.toInt()
  val warningSoft = if (dark) 0xFF2D2210.toInt() else 0xFFFFEDD8.toInt()
  val divider = if (dark) 0xFF2C3139.toInt() else 0xFFD2D6DD.toInt()
}

private val LETTER_ROWS = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
private val NUMBER_ROWS = listOf("1234567890", "-/:;()$&@\"", ".,?!'")
private val SYMBOL_ROWS = listOf("[]{}#%^*+=", "_\\|~<>€£¥•", ".,?!'")

@SuppressLint("ClickableViewAccessibility", "SetTextI18n")
class KeyboardBoard(private val context: Context, private val host: BoardHost) {
  private val handler = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density
  private var palette = Palette(isDark())

  val root = LinearLayout(context)
  private val top = FrameLayout(context)
  private val body = FrameLayout(context)

  private var data: KbLoad = KbLoad.Missing
  private var business: KbBusiness? = null
  private var layer = Layer.LETTERS
  private var shift = Shift.OFF
  private var lastShiftTap = 0L
  private var lastSpaceAt = 0L
  private var panel = Panel.KEYS

  /** A template waiting for a first name, and what's been typed for it so far. */
  private var asking: KbTemplate? = null
  private val name = StringBuilder()
  private var note: String? = null
  private val hideNote = Runnable {
    note = null
    drawTop()
  }

  private val letterKeys = ArrayList<Pair<TextView, Char>>()
  private var shiftKey: TextView? = null
  private var repeating: Runnable? = null

  init {
    root.orientation = LinearLayout.VERTICAL
    root.addView(top, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(46)))
    root.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(KEY_AREA)))
    // Clear of the navigation bar where the system draws the keyboard behind it (Android 15's edge to edge).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      root.setOnApplyWindowInsetsListener { view, insets ->
        val bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
        view.setPadding(0, 0, 0, bottom)
        insets
      }
    }
  }

  // ---------- opening and closing ----------

  fun open(loaded: KbLoad, shown: KbBusiness?) {
    palette = Palette(isDark())
    data = loaded
    business = shown
    layer = Layer.LETTERS
    panel = Panel.KEYS
    asking = null
    name.setLength(0)
    note = null
    handler.removeCallbacks(hideNote)
    shift = if (host.wantsCapital()) Shift.ONCE else Shift.OFF
    root.setBackgroundColor(palette.tray)
    drawTop()
    drawBody()
  }

  fun close() {
    stopRepeat()
    handler.removeCallbacks(hideNote)
    asking = null
    name.setLength(0)
  }

  private val words: KbWords?
    get() = (data as? KbLoad.Ready)?.words

  private fun word(key: String, fallback: String) = words?.get(key, fallback) ?: fallback

  // ---------- the row on top ----------

  private fun drawTop() {
    top.removeAllViews()
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(6), dp(4), dp(6), dp(2))
    }
    top.addView(row, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    val waiting = asking
    val shownNote = note
    when {
      waiting != null -> {
        val box = TextView(context).apply {
          textSize = 16f
          setSingleLine()
          ellipsize = TextUtils.TruncateAt.START
          gravity = Gravity.CENTER_VERTICAL
          setPadding(dp(12), 0, dp(12), 0)
          background = rounded(palette.key, 10f, palette.accent)
          if (name.isEmpty()) {
            text = word("askName", Own.askName)
            setTextColor(palette.text2)
          } else {
            text = "$name|"
            setTextColor(palette.text)
          }
        }
        row.addView(box, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        row.addView(chip(word("skip", Own.skip), false) { finishAsking(skip = true) })
        row.addView(chip(word("add", Own.add), true) { finishAsking(skip = false) })
      }
      shownNote != null -> {
        val noteView = TextView(context).apply {
          text = shownNote
          textSize = 13.5f
          setTextColor(palette.warning)
          gravity = Gravity.CENTER_VERTICAL
          maxLines = 2
          ellipsize = TextUtils.TruncateAt.END
          setPadding(dp(12), 0, dp(12), 0)
          background = rounded(palette.warningSoft, 10f, null)
          setOnClickListener { hideNote.run() }
        }
        row.addView(noteView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
      }
      else -> {
        row.addView(chip(word("templates", Own.templates), panel == Panel.TEMPLATES) { showPanel(Panel.TEMPLATES) })
        row.addView(chip(word("links", Own.links), panel == Panel.LINKS) { showPanel(Panel.LINKS) })
        val ready = data as? KbLoad.Ready
        val current = business
        if (ready != null && ready.businesses.size > 1 && current != null) {
          row.addView(chip("${current.name} ▾", panel == Panel.BUSINESSES) { showPanel(Panel.BUSINESSES) }.apply {
            maxWidth = dp(150)
            ellipsize = TextUtils.TruncateAt.END
            setSingleLine()
          })
        }
        row.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        if (panel != Panel.KEYS) row.addView(chip(word("letters", Own.letters), false) { showPanel(Panel.KEYS) })
      }
    }
  }

  private fun chip(label: String, on: Boolean, press: () -> Unit): TextView = TextView(context).apply {
    text = label
    textSize = 14f
    typeface = Typeface.DEFAULT_BOLD
    gravity = Gravity.CENTER
    setSingleLine()
    setTextColor(if (on) palette.onAccent else palette.accentText)
    background = rounded(if (on) palette.accent else palette.accentSoft, 18f, null)
    setPadding(dp(14), 0, dp(14), 0)
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT)
      .apply { setMargins(dp(3), 0, dp(3), 0) }
    contentDescription = label
    setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      press()
    }
  }

  private fun showPanel(next: Panel) {
    panel = if (panel == next && next != Panel.KEYS) Panel.KEYS else next
    drawTop()
    drawBody()
  }

  // ---------- the keys ----------

  private fun drawBody() {
    body.removeAllViews()
    when (panel) {
      Panel.KEYS -> body.addView(keys())
      Panel.TEMPLATES -> body.addView(templateList())
      Panel.LINKS -> body.addView(linkList())
      Panel.BUSINESSES -> body.addView(businessList())
    }
  }

  private fun keys(): View {
    letterKeys.clear()
    shiftKey = null
    val column = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(3), dp(4), dp(3), dp(4))
    }
    val rows = when (layer) {
      Layer.LETTERS -> LETTER_ROWS
      Layer.NUMBERS -> NUMBER_ROWS
      Layer.SYMBOLS -> SYMBOL_ROWS
    }
    // Row 1: ten keys.
    column.addView(row().apply { rows[0].forEach { addView(charKey(it), weight(1f)) } }, rowParams())
    // Row 2: nine letters inset by half a key, or ten numbers and symbols.
    column.addView(row().apply {
      if (layer == Layer.LETTERS) addView(View(context), weight(0.5f))
      rows[1].forEach { addView(charKey(it), weight(1f)) }
      if (layer == Layer.LETTERS) addView(View(context), weight(0.5f))
    }, rowParams())
    // Row 3: shift (or the other symbols), the rest, delete.
    column.addView(row().apply {
      when (layer) {
        Layer.LETTERS -> addView(shiftKeyView(), weight(1.5f))
        Layer.NUMBERS -> addView(specialKey("#+=") { switchLayer(Layer.SYMBOLS) }, weight(1.5f))
        Layer.SYMBOLS -> addView(specialKey("123") { switchLayer(Layer.NUMBERS) }, weight(1.5f))
      }
      val wide = if (layer == Layer.LETTERS) 1f else 1.4f
      rows[2].forEach { addView(charKey(it), weight(wide)) }
      addView(specialKey("⌫", repeat = true) { deleteBackward() }.apply { contentDescription = "Delete" }, weight(1.5f))
    }, rowParams())
    // Row 4: letters or numbers, the next keyboard, space, return.
    column.addView(row().apply {
      if (layer == Layer.LETTERS) addView(specialKey("123") { switchLayer(Layer.NUMBERS) }, weight(1.5f))
      else addView(specialKey(word("letters", Own.letters)) { switchLayer(Layer.LETTERS) }, weight(1.5f))
      addView(
        specialKey("🌐", onLong = { host.pickKeyboard() }) { host.nextKeyboard() }
          .apply { contentDescription = "Next keyboard" },
        weight(1.2f),
      )
      addView(charKey(' ', label = Own.space), weight(5f))
      addView(specialKey(if (asking != null) word("add", Own.add) else host.enterLabel()) { enter() }, weight(2.3f))
    }, rowParams())
    updateCase()
    return column
  }

  private fun row() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }

  private fun rowParams() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)

  private fun weight(w: Float) = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, w)

  private fun charKey(c: Char, label: String? = null): View {
    val view = key(label ?: c.toString(), special = false, repeat = false, onLong = null) { typeChar(c) }
    if (label != null) {
      view.textSize = 14f
      view.setTextColor(palette.text2)
    }
    if (c.isLetter()) letterKeys.add(view to c)
    return wrap(view)
  }

  private fun specialKey(
    label: String,
    repeat: Boolean = false,
    onLong: (() -> Unit)? = null,
    press: () -> Unit,
  ): View = wrap(key(label, special = true, repeat = repeat, onLong = onLong, press = press))

  private fun shiftKeyView(): View {
    val view = key("⇧", special = true, repeat = false, onLong = null) { tapShift() }
    view.contentDescription = "Shift"
    shiftKey = view
    return wrap(view)
  }

  /** The key's face inside a cell that takes the touches in the gaps around it too. */
  private fun wrap(face: TextView): View = FrameLayout(context).apply {
    setPadding(dp(3), dp(4), dp(3), dp(4))
    addView(face, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setOnTouchListener { _, event -> face.dispatchTouchEvent(event) }
  }

  private fun key(
    label: String,
    special: Boolean,
    repeat: Boolean,
    onLong: (() -> Unit)?,
    press: () -> Unit,
  ): TextView {
    val up = if (special) palette.special else palette.key
    val down = if (special) palette.specialDown else palette.keyDown
    return TextView(context).apply {
      text = label
      textSize = if (label.length > 2) 15f else 21f
      gravity = Gravity.CENTER
      setTextColor(palette.text)
      setSingleLine()
      background = rounded(up, 7f, null)
      contentDescription = label
      // TalkBack's double tap clicks; fingers use the touches below.
      setOnClickListener { press() }
      var longFired = false
      val longPress = Runnable {
        longFired = true
        onLong?.invoke()
      }
      setOnTouchListener { view, event ->
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> {
            background = rounded(down, 7f, null)
            view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            longFired = false
            if (repeat) {
              press()
              startRepeat(press)
            } else if (onLong != null) {
              handler.postDelayed(longPress, 450)
            }
          }
          MotionEvent.ACTION_UP -> {
            background = rounded(up, 7f, null)
            handler.removeCallbacks(longPress)
            if (repeat) stopRepeat() else if (!longFired) press()
          }
          MotionEvent.ACTION_CANCEL -> {
            background = rounded(up, 7f, null)
            handler.removeCallbacks(longPress)
            stopRepeat()
          }
        }
        true
      }
    }
  }

  private fun startRepeat(press: () -> Unit) {
    stopRepeat()
    val again = object : Runnable {
      override fun run() {
        press()
        handler.postDelayed(this, 60)
      }
    }
    repeating = again
    handler.postDelayed(again, 400)
  }

  private fun stopRepeat() {
    repeating?.let { handler.removeCallbacks(it) }
    repeating = null
  }

  private fun switchLayer(next: Layer) {
    layer = next
    drawBody()
  }

  private fun tapShift() {
    val now = SystemClock.uptimeMillis()
    shift = when (shift) {
      Shift.OFF -> Shift.ONCE
      Shift.ONCE -> if (now - lastShiftTap < 350) Shift.LOCK else Shift.OFF
      Shift.LOCK -> Shift.OFF
    }
    lastShiftTap = now
    updateCase()
  }

  private fun updateCase() {
    val upper = shift != Shift.OFF
    for ((view, c) in letterKeys) view.text = if (upper) c.uppercaseChar().toString() else c.toString()
    shiftKey?.apply {
      text = if (shift == Shift.LOCK) "⇪" else "⇧"
      setTextColor(if (shift == Shift.OFF) palette.text else palette.accent)
    }
  }

  /** After anything but a letter: a capital where the field wants one, unless caps lock is on. */
  private fun autoCapital() {
    if (shift == Shift.LOCK || asking != null) return
    shift = if (host.wantsCapital()) Shift.ONCE else Shift.OFF
    updateCase()
  }

  // ---------- typing ----------

  private fun typeChar(c: Char) {
    if (asking != null) {
      if (name.length < 40) name.append(if (c.isLetter() && shift != Shift.OFF) c.uppercaseChar() else c)
      if (shift == Shift.ONCE) shift = Shift.OFF
      updateCase()
      drawTop()
      return
    }
    if (c == ' ') {
      val now = SystemClock.uptimeMillis()
      val before = host.before(2)
      // Two spaces after a word end the sentence, as on the phone's own keyboard.
      if (now - lastSpaceAt < 800 && before.length == 2 && before[0].isLetterOrDigit() && before[1] == ' ') {
        host.deleteBackward()
        host.type(". ")
        lastSpaceAt = 0
      } else {
        host.type(" ")
        lastSpaceAt = now
      }
      autoCapital()
      return
    }
    lastSpaceAt = 0
    if (c.isLetter()) {
      host.type(if (shift != Shift.OFF) c.uppercaseChar().toString() else c.toString())
      if (shift == Shift.ONCE) {
        shift = Shift.OFF
        updateCase()
      }
    } else {
      host.type(c.toString())
      // A sentence's end goes back to the letters, as the phone's own keyboard does.
      if (layer != Layer.LETTERS && (c == '.' || c == '?' || c == '!' || c == '\'')) switchLayer(Layer.LETTERS)
      autoCapital()
    }
  }

  private fun deleteBackward() {
    if (asking != null) {
      if (name.isNotEmpty()) name.setLength(name.length - 1)
      drawTop()
      return
    }
    host.deleteBackward()
    autoCapital()
  }

  private fun enter() {
    if (asking != null) {
      finishAsking(skip = false)
      return
    }
    host.enter()
    autoCapital()
  }

  // ---------- templates and links ----------

  private fun message(text: String): View = TextView(context).apply {
    this.text = text
    textSize = 15f
    setTextColor(palette.text2)
    gravity = Gravity.CENTER
    setPadding(dp(24), dp(16), dp(24), dp(16))
    layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  /** The panel's words when there's nothing to list: no copy yet, a newer one, or an empty list. */
  private fun unavailable(): String? = when (data) {
    is KbLoad.Missing -> Own.missing
    is KbLoad.Newer -> Own.newer
    is KbLoad.Ready -> null
  }

  private fun list(rows: List<View>): View {
    val column = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(8), dp(4), dp(8), dp(8))
    }
    rows.forEach { column.addView(it) }
    return ScrollView(context).apply {
      isVerticalScrollBarEnabled = true
      addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
  }

  private fun listRow(title: String, detail: String, press: () -> Unit): View = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(dp(12), dp(9), dp(12), dp(9))
    background = rounded(palette.key, 10f, null)
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      .apply { setMargins(0, dp(3), 0, dp(3)) }
    addView(TextView(context).apply {
      text = title
      textSize = 15f
      typeface = Typeface.DEFAULT_BOLD
      setTextColor(palette.text)
      setSingleLine()
      ellipsize = TextUtils.TruncateAt.END
    })
    if (detail.isNotEmpty()) addView(TextView(context).apply {
      text = detail
      textSize = 13f
      setTextColor(palette.text2)
      setSingleLine()
      ellipsize = TextUtils.TruncateAt.END
    })
    contentDescription = "$title. $detail"
    setOnClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      press()
    }
  }

  private fun templateList(): View {
    unavailable()?.let { return message(it) }
    val templates = business?.templates.orEmpty()
    if (templates.isEmpty()) return message(word("noTemplates", Own.noTemplates))
    return list(templates.map { t ->
      val detail = listOfNotNull(
        if (t.channel == "email") word("email", Own.email) else null,
        t.folder,
        t.preview.takeIf { it.isNotEmpty() },
      ).joinToString(" · ")
      listRow(t.name, detail) { useTemplate(t) }
    })
  }

  private fun linkList(): View {
    unavailable()?.let { return message(it) }
    val links = business?.links.orEmpty()
    if (links.isEmpty()) return message(word("noLinks", Own.noLinks))
    return list(links.map { l ->
      val kind = words?.kind(l.kind, "") ?: ""
      val detail = if (l.kind == "booking" || l.kind == "form") listOf(l.detail.ifEmpty { kind }, l.url).joinToString(" · ") else l.url
      listRow(l.name, detail) { typeLink(l.url) }
    })
  }

  private fun businessList(): View {
    val ready = data as? KbLoad.Ready ?: return message(Own.missing)
    return list(ready.businesses.map { b ->
      listRow(if (b.id == business?.id) "✓  ${b.name}" else b.name, "") {
        KeyboardStore.pick(context, ready, b.id)
        business = b
        showPanel(Panel.TEMPLATES)
      }
    })
  }

  private fun useTemplate(template: KbTemplate) {
    if (template.asks) {
      asking = template
      name.setLength(0)
      // A name starts with a capital.
      shift = Shift.ONCE
      panel = Panel.KEYS
      layer = Layer.LETTERS
      drawTop()
      drawBody()
      return
    }
    typeTemplate(template, "")
  }

  private fun finishAsking(skip: Boolean) {
    val template = asking ?: return
    val typed = if (skip) "" else name.toString()
    asking = null
    name.setLength(0)
    typeTemplate(template, typed)
  }

  private fun typeTemplate(template: KbTemplate, firstName: String) {
    host.type(template.fill(firstName))
    panel = Panel.KEYS
    layer = Layer.LETTERS
    note = template.note
    handler.removeCallbacks(hideNote)
    if (note != null) handler.postDelayed(hideNote, 6000)
    shift = if (host.wantsCapital()) Shift.ONCE else Shift.OFF
    drawTop()
    drawBody()
  }

  /** A link goes in with a space before it when it follows a word. */
  private fun typeLink(url: String) {
    val before = host.before(1)
    host.type(if (before.isNotEmpty() && !before[0].isWhitespace()) " $url" else url)
    panel = Panel.KEYS
    autoCapital()
    drawTop()
    drawBody()
  }

  // ---------- drawing helpers ----------

  private fun dp(value: Int): Int = (value * density).toInt()

  private fun isDark(): Boolean =
    context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

  private fun rounded(color: Int, radius: Float, stroke: Int?): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, radius, context.resources.displayMetrics)
    if (stroke != null) setStroke(dp(2), stroke)
  }

  private companion object {
    /** Four rows of keys, and the height a panel takes in their place. */
    const val KEY_AREA = 216
  }
}
