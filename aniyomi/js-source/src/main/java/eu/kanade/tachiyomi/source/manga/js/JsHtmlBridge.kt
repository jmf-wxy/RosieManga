package eu.kanade.tachiyomi.source.manga.js

import org.jsoup.Jsoup
import org.jsoup.nodes.Comment
import org.jsoup.nodes.DataNode
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode

/**
 * Kotlin side of Venera's `Html` API — a faithful port of `DocumentWrapper` in
 * `venera/lib/foundation/js_engine.dart`, reachable from JS as
 * `{ method: "html", function: "<op>", ... }` (see [handle]).
 *
 * ### Why this exists — "GoDa漫画: not a function"
 *
 * GoDa漫画 (`goda.js`) is the first source in the index that parses HTML (`new HtmlDocument(...)`)
 * instead of calling JSON APIs; jm.js never touches it. The bridge used to be a stub returning
 * `null` for every op, and `init.js`'s `HtmlDocument.querySelectorAll` read the bridge's return
 * value synchronously — with the Promise shim that value was a Promise, so the first
 * `ks.map(...)` died as QuickJS's bare `not a function` right after one perfectly healthy
 * 200-OK homepage fetch. Both halves are fixed together: this class answers with real handles,
 * and init.js's HTML classes call `__sendMessageSync` (the sync contract — Venera's flutter_qjs
 * `sendMessage` was synchronous; same precedent as the `Image` class).
 *
 * ### Handle model (mirrors Dart exactly)
 *
 * Per parsed document: an append-only `elements` list. A query returns the **index** of each
 * newly registered element (`null` = "no match"), and later ops address it with `{ doc, key }`.
 * `getNodes` fills a second list for non-element nodes (`node_text` / `node_type` /
 * `node_toElement` read from it). Parsed documents are capped at 8 with oldest-eviction —
 * the same policy as Venera — so a source that forgets `dispose()` cannot accumulate unbounded
 * DOM trees.
 *
 * ### Deliberate divergences from Dart
 *
 * - Parser: Jsoup instead of Dart's `package:html`. Both are lenient HTML5 parsers with CSS
 *   selector support. Dart's element-scoped `querySelector` matches **descendants only**; Jsoup's
 *   `Element.select` may include the root itself, so the root is filtered out to keep the
 *   contract identical.
 * - `getText` concatenates descendant text nodes **verbatim** (Jsoup's `Element.text()` would
 *   normalise whitespace, silently breaking sources that split on exact runs of spaces —
 *   goda.js's `title.trim().split("   ")[0]`). See [rawText].
 * - Unknown handles log and return `null` instead of throwing: the source then fails with its
 *   own error ("无法获取漫画ID"), which is far more actionable than a marshalled NPE.
 *
 * ### Threading & lifecycle
 *
 * Bridge ops arrive on the JS engine thread (S2), and the registry is `synchronized` anyway
 * because nothing here may be shared across engine instances: one [JsHtmlBridge] per
 * [JsMessageDispatcher], which itself is one per [JsEngine] — when the engine closes, the whole
 * registry dies with it, exactly like Dart's per-engine `_documents` map.
 */
class JsHtmlBridge {

    private val TAG = "JsHtmlBridge"

    /** Same cap as Venera's `handleHtmlCallback` (`_documents.length > 8` → evict oldest). */
    private companion object {
        const val MAX_DOCUMENTS = 8
    }

    /** One parsed document plus its handle registries, mirroring Dart's `DocumentWrapper`. */
    private class ParsedDoc(val doc: Document) {
        val elements = ArrayList<Element>()
        val nodes = ArrayList<Node>()

        fun element(key: Any?): Element? = elements.getOrNull((key as? Number)?.toInt() ?: -1)
        fun node(key: Any?): Node? = nodes.getOrNull((key as? Number)?.toInt() ?: -1)
    }

    private val lock = Any()
    private val documents = LinkedHashMap<Int, ParsedDoc>()

    // ---------------------------------------------------------------------------------------------
    // Bridge entry — `{ method: "html", function: "<op>", ... }`
    // ---------------------------------------------------------------------------------------------

    fun handle(msg: Map<*, *>): Any? {
        val function = msg["function"] as? String
        if (function == null) {
            JsDebugLog.add(TAG, "html: message without function, dropped")
            return null
        }
        synchronized(lock) {
            return try {
                dispatch(msg, function)
            } catch (e: Exception) {
                // A malformed selector or a Jsoup quirk must not kill the JS chain (S8: the source
                // reports its own errors); log the reason so the on-screen buffer can show it.
                JsDebugLog.add(TAG, "html.$function failed: ${e.javaClass.simpleName}: ${e.message?.take(200)}")
                null
            }
        }
    }

    private fun dispatch(msg: Map<*, *>, function: String): Any? {
        val query = msg["query"] as? String ?: ""

        return when (function) {
            "parse" -> {
                val key = (msg["key"] as? Number)?.toInt() ?: return null
                val html = msg["data"] as? String ?: return null
                if (documents.size >= MAX_DOCUMENTS) {
                    val oldest = documents.keys.iterator().next()
                    documents.remove(oldest)
                    JsDebugLog.add(TAG, "html.parse: over $MAX_DOCUMENTS documents, evicted oldest key=$oldest")
                }
                documents[key] = ParsedDoc(Jsoup.parse(html))
                null
            }

            "dispose" -> {
                documents.remove((msg["key"] as? Number)?.toInt())
                null
            }

            // Document-level ops: the document handle rides in `key`.
            "querySelector" -> withDoc(msg, docInKey = true) { d ->
                d.doc.select(query).firstOrNull()?.let { registerElement(d, it) }
            }
            "querySelectorAll" -> withDoc(msg, docInKey = true) { d ->
                d.doc.select(query).map { registerElement(d, it) }
            }
            "getElementById" -> withDoc(msg, docInKey = true) { d ->
                val res = d.doc.getElementById(msg["id"] as? String ?: "")
                if (res != null) registerElement(d, res) else null
            }

            // Element-level ops: element handle in `key`, document handle in `doc`.
            "getText" -> withDoc(msg) { d -> d.element(msg["key"])?.let { rawText(it) } }
            "getInnerHTML" -> withDoc(msg) { it.element(msg["key"])?.html() }
            "getAttributes" -> withDoc(msg) { d ->
                val el = d.element(msg["key"]) ?: return@withDoc null
                val out = LinkedHashMap<String, String>()
                for (attr in el.attributes()) out[attr.key] = attr.value
                out
            }
            "getParent" -> withDoc(msg) { d ->
                val el = d.element(msg["key"])
                val parent = if (el != null) el.parentElement() else null
                if (parent != null) registerElement(d, parent) else null
            }
            "dom_querySelector" -> withDoc(msg) { d ->
                val root = d.element(msg["key"]) ?: return@withDoc null
                // Dart matches descendants only; Jsoup may include the root itself → filter it.
                root.select(query).firstOrNull { it !== root }
                    ?.let { registerElement(d, it) }
            }
            "dom_querySelectorAll" -> withDoc(msg) { d ->
                val root = d.element(msg["key"]) ?: return@withDoc emptyList<Int>()
                root.select(query).filter { it !== root }.map { registerElement(d, it) }
            }
            "getChildren" -> withDoc(msg) { d ->
                d.element(msg["key"])?.children()?.map { registerElement(d, it) }
            }
            "getNodes" -> withDoc(msg) { d ->
                d.element(msg["key"])?.childNodes()?.map { registerNode(d, it) }
            }
            "getClassNames" -> withDoc(msg) { d -> d.element(msg["key"])?.classNames()?.toList() }
            "getId" -> withDoc(msg) { d -> d.element(msg["key"])?.id() }
            "getLocalName" -> withDoc(msg) { d -> d.element(msg["key"])?.tagName() }
            "getPreviousSibling" -> withDoc(msg) { d ->
                val el = d.element(msg["key"])
                val sib = if (el != null) el.previousElementSibling() else null
                if (sib != null) registerElement(d, sib) else null
            }
            "getNextSibling" -> withDoc(msg) { d ->
                val el = d.element(msg["key"])
                val sib = if (el != null) el.nextElementSibling() else null
                if (sib != null) registerElement(d, sib) else null
            }

            // Node-level ops: node handle in `key`, document handle in `doc`.
            "node_text" -> withDoc(msg) { nodeText(it.node(msg["key"])) }
            "node_type" -> withDoc(msg) { nodeType(it.node(msg["key"])) }
            // init.js sends `node_toElement`; Venera's Dart switch spells it `node_to_element`.
            "node_toElement", "node_to_element" -> withDoc(msg) { d ->
                (d.node(msg["key"]) as? Element)?.let { registerElement(d, it) }
            }

            else -> {
                JsDebugLog.add(TAG, "html: unsupported function '$function'")
                null
            }
        }
    }

    // ---------------------------------------------------------------------------------------------

    /** Resolves the target document. Document-level ops carry it in `key`, element ops in `doc`. */
    private inline fun withDoc(msg: Map<*, *>, docInKey: Boolean = false, block: (ParsedDoc) -> Any?): Any? {
        val docKey = (if (docInKey) msg["key"] else msg["doc"]) ?: return null
        val d = documents[(docKey as? Number)?.toInt() ?: -1]
        if (d == null) {
            JsDebugLog.add(TAG, "html: unknown document handle (key=${msg["key"]}, doc=${msg["doc"]})")
            return null
        }
        return block(d)
    }

    private fun registerElement(d: ParsedDoc, el: Element): Int {
        d.elements.add(el)
        return d.elements.size - 1
    }

    private fun registerNode(d: ParsedDoc, node: Node): Int {
        d.nodes.add(node)
        return d.nodes.size - 1
    }

    /**
     * Dart `package:html` `Element.text` semantics: the descendant text nodes concatenated
     * **verbatim** — no whitespace collapsing. Jsoup's `Element.text()` normalises, which would
     * silently break sources that split on exact runs of spaces (goda.js's
     * `title.trim().split("   ")[0]`), so the walk is done by hand.
     */
    private fun rawText(el: Element): String {
        val sb = StringBuilder()
        fun walk(node: Node) {
            when (node) {
                is TextNode -> sb.append(node.wholeText)
                // package:html models <script>/<style> contents as TextNode; Jsoup splits them
                // into DataNode, so fold it back in to keep `text` meaningful for both runtimes.
                is DataNode -> sb.append(node.wholeData)
                is Element -> node.childNodes().forEach { walk(it) }
                else -> {}
            }
        }
        walk(el)
        return sb.toString()
    }

    private fun nodeText(node: Node?): String? = when (node) {
        null -> null
        is TextNode -> node.wholeText
        is Element -> rawText(node)
        is DataNode -> node.wholeData
        is Comment -> node.data
        else -> ""
    }

    private fun nodeType(node: Node?): String = when (node) {
        is Element -> "element"
        is TextNode -> "text"
        is DataNode -> "text"
        is Comment -> "comment"
        is Document -> "document"
        else -> "unknown"
    }
}
