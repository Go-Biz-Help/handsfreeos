package expo.modules.hfoskeyboard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The copy of templates and links the app keeps for the keyboard: core's `KeyboardData` (packages/core/src/keyboard),
 * version 1, written by modules/hfos-shared under the key "keyboard". Everything is worked out by the app; the
 * keyboard only joins a template's parts.
 */

/** Must match core's KEYBOARD_DATA_VERSION. */
const val KEYBOARD_DATA_VERSION = 1

/** modules/hfos-shared's preferences file, and the keys in it. */
private const val SHARED_PREFERENCES = "hfos_shared"
private const val DATA_KEY = "keyboard"
/** The keyboard's own: the business picked on it, and which business the app had open when it was picked. */
private const val PICK_KEY = "keyboard-pick"

/** A part of a template: words, or a first name to ask for (with its fallback and an upper or lower filter). */
data class KbPart(val text: String?, val fallback: String, val transform: String?)

data class KbTemplate(
  val id: String,
  val name: String,
  val folder: String?,
  val channel: String,
  val parts: List<KbPart>,
  val asks: Boolean,
  val preview: String,
  val note: String?,
) {
  /** The words to type, with `name` in place of each first name (or the fallback when it's blank). */
  fun fill(name: String): String = parts.joinToString("") { part ->
    part.text ?: run {
      val value = name.trim().ifEmpty { part.fallback }
      when (part.transform) {
        "upper" -> value.uppercase()
        "lower" -> value.lowercase()
        else -> value
      }
    }
  }
}

data class KbLink(val kind: String, val name: String, val detail: String, val url: String)

data class KbBusiness(val id: String, val name: String, val templates: List<KbTemplate>, val links: List<KbLink>)

/** The words the app sent, with the keyboard's own for anything missing. */
class KbWords(private val json: JSONObject?) {
  fun get(key: String, fallback: String): String = json?.str(key) ?: fallback
  fun kind(kind: String, fallback: String): String = json?.optJSONObject("kinds")?.str(kind) ?: fallback
}

sealed class KbLoad {
  /** Nothing yet: nobody has signed in to the app on this phone, or they signed out. */
  object Missing : KbLoad()
  /** Written by a newer app than this keyboard knows (they'll match again once the app updates itself). */
  object Newer : KbLoad()
  data class Ready(val current: String?, val businesses: List<KbBusiness>, val words: KbWords) : KbLoad()
}

/** org.json reads a JSON null as the word "null"; this reads it as null, and an empty string too. */
internal fun JSONObject.str(key: String): String? =
  if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

private fun <T> JSONArray?.list(read: (JSONObject) -> T?): List<T> {
  if (this == null) return emptyList()
  val out = ArrayList<T>(length())
  for (i in 0 until length()) optJSONObject(i)?.let(read)?.let(out::add)
  return out
}

object KeyboardStore {
  private fun prefs(context: Context) = context.getSharedPreferences(SHARED_PREFERENCES, Context.MODE_PRIVATE)

  fun load(context: Context): KbLoad {
    val raw = prefs(context).getString(DATA_KEY, null) ?: return KbLoad.Missing
    return try {
      val root = JSONObject(raw)
      val version = root.optInt("v", 0)
      if (version > KEYBOARD_DATA_VERSION) return KbLoad.Newer
      if (version != KEYBOARD_DATA_VERSION) return KbLoad.Missing
      KbLoad.Ready(
        current = root.str("current"),
        businesses = root.optJSONArray("businesses").list { business(it) },
        words = KbWords(root.optJSONObject("words")),
      )
    } catch (e: Exception) {
      KbLoad.Missing
    }
  }

  private fun business(o: JSONObject): KbBusiness? {
    val id = o.str("id") ?: return null
    return KbBusiness(
      id = id,
      name = o.str("name") ?: "",
      templates = o.optJSONArray("templates").list { template(it) },
      links = o.optJSONArray("links").list { link(it) },
    )
  }

  private fun template(o: JSONObject): KbTemplate? {
    val id = o.str("id") ?: return null
    val parts = o.optJSONArray("parts").list { p ->
      if (p.has("text")) KbPart(p.optString("text"), "", null)
      else KbPart(null, p.str("fallback") ?: "there", p.str("transform"))
    }
    return KbTemplate(
      id = id,
      name = o.str("name") ?: "",
      folder = o.str("folder"),
      channel = o.str("channel") ?: "sms",
      parts = parts,
      asks = parts.any { it.text == null },
      preview = o.str("preview") ?: "",
      note = o.str("note"),
    )
  }

  private fun link(o: JSONObject): KbLink? {
    val url = o.str("url") ?: return null
    return KbLink(o.str("kind") ?: "", o.str("name") ?: url, o.str("detail") ?: "", url)
  }

  /**
   * The business to show: the one picked on the keyboard, while the app still has open the business it had when
   * that was picked; otherwise the one the app has open now.
   */
  fun businessToShow(context: Context, data: KbLoad.Ready): KbBusiness? {
    val pick = prefs(context).getString(PICK_KEY, null)?.split("|")
    val picked = if (pick != null && pick.size == 2 && pick[1] == (data.current ?: "")) pick[0] else null
    return data.businesses.firstOrNull { it.id == picked }
      ?: data.businesses.firstOrNull { it.id == data.current }
      ?: data.businesses.firstOrNull()
  }

  fun pick(context: Context, data: KbLoad.Ready, businessId: String) {
    prefs(context).edit().putString(PICK_KEY, "$businessId|${data.current ?: ""}").apply()
  }
}
