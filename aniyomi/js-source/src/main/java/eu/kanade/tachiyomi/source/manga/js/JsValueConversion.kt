package eu.kanade.tachiyomi.source.manga.js

import com.whl.quickjs.wrapper.JSArray
import com.whl.quickjs.wrapper.JSObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64

/**
 * Recursive conversion of QuickJS values into plain Kotlin `Map` / `List` trees.
 *
 * **Why this exists:** the QuickJS wrapper only auto-marshals *top-level* primitives. A nested JS
 * object comes back as a [JSObject] (and arrays as [JSArray]) — **not** a `Map`/`List`. So a naive
 * `eval("...settings") as? Map<*, *>` silently yields `null`, which makes every source look like it
 * has no configurable settings at all.
 *
 * [JSObject.toMap] converts one level; it recurses into nested objects but leaves nested arrays as
 * [JSArray], so this walker normalises both levels uniformly.
 */
internal fun Any?.toKotlinValue(): Any? = when (this) {
    null -> null
    is JSArray -> toKotlinList()
    is JSObject -> toKotlinMap()
    is Map<*, *> -> entries.associate { (k, v) -> k?.toString() to v.toKotlinValue() }
    is List<*> -> map { it.toKotlinValue() }
    else -> this
}

private fun JSObject.toKotlinMap(): Map<String, Any?> =
    runCatching { toMap() }.getOrNull()
        ?.entries
        ?.associate { (k, v) -> k to v.toKotlinValue() }
        .orEmpty()

private fun JSArray.toKotlinList(): List<Any?> =
    (0 until length()).map { index ->
        runCatching { get(index) }.getOrNull().toKotlinValue()
    }

/**
 * Reads a JS object **property by property**, without [JSObject.toMap].
 *
 * ### Why this exists instead of just calling [toKotlinValue]
 *
 * `toMap()` converts *every* property it finds by recursing into it as an object. That is wrong for
 * typed values: a JS `ArrayBuffer` is an object with a `byteLength`, so it comes back as a
 * `LinkedHashMap` — the bytes are lost, and any downstream `as ByteArray` throws
 * `ClassCastException: java.util.LinkedHashMap cannot be cast to byte[]` (exactly what the
 * `convert` bridge did when `Network.fetchBytes` handed `decodeBase64`'s input back to us).
 *
 * `getProperty(name)` instead asks **native** for the value, letting it apply its own type rules —
 * the native library contains `[B` and `[I` class descriptors precisely for this, so an
 * `ArrayBuffer`/`Uint8Array` arrives as a real `byte[]`.
 *
 * Both walkers are needed: `toKotlinValue()` is right for `evaluate()` results (where deep maps are
 * the norm and no binary is present), while this one is right for **bridge arguments**, which is
 * where binary payloads travel (`convert.value`, `http.data`, `cookie` values).
 */
internal fun JSObject.readProperties(): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    val names = runCatching { getNames() }.getOrNull() ?: return out
    for (i in 0 until runCatching { names.length() }.getOrDefault(0)) {
        val key = runCatching { names.get(i) as? String }.getOrNull() ?: continue
        out[key] = runCatching { getProperty(key) }.getOrNull().toKotlinValueFromProperty()
    }
    runCatching { names.release() }
    return out
}

/**
 * Like [toKotlinValue] but for values obtained from [JSObject.getProperty], so a `byte[]` handed
 * back by native stays a `byte[]` instead of being flattened into a map.
 */
private fun Any?.toKotlinValueFromProperty(): Any? = when (this) {
    null, is ByteArray, is String, is Boolean, is Number -> this
    is JSArray -> toKotlinList()
    is JSObject -> readProperties()
    is Map<*, *> -> entries.associate { (k, v) -> k?.toString() to v.toKotlinValueFromProperty() }
    is List<*> -> map { it.toKotlinValueFromProperty() }
    else -> this
}

/**
 * Bridge-argument entry point: turns whatever the wrapper handed the `JSCallFunction` into a plain
 * `Map`, preserving `byte[]` payloads (see [readProperties] for why `toMap()` cannot be used).
 */
internal fun Any?.toBridgeArgs(): Map<String, Any?>? = when (this) {
    is JSObject -> readProperties()
    is Map<*, *> -> buildMap {
        entries.forEach { (k, v) -> k?.let { put(it.toString(), v.toKotlinValue()) } }
    }
    else -> null
}

/** Convenience for the common "eval gives me an object" case. */
internal fun Any?.toKotlinMap(): Map<String, Any?>? = toKotlinValue() as? Map<String, Any?>

/** Convenience for the common "eval gives me an array" case. */
internal fun Any?.toKotlinList(): List<Any?>? = toKotlinValue() as? List<Any?>

/**
 * The mirror image of [toKotlinValue]: turns plain Kotlin data into a [JsonElement] tree.
 *
 * Used by the bridge's *return* leg. The QuickJS wrapper's native marshaller understands only
 * `Boolean` / `Double` / `Integer` / `Long` / `String` / `byte[]` / `JSObject` / `JSArray` /
 * `JSFunction`; a `java.util.Map` makes it throw `Unsupported Java type java.util.LinkedHashMap`,
 * which surfaces in JS as a plain `undefined` with no error. So containers are serialised and
 * re-parsed with `QuickJSContext.parseJSON`, which is exactly how the library builds its own
 * objects (`createNewJSObject()` is `parseJSON("{}")`).
 *
 * Unsupported leaf types degrade to a string rather than throwing: a source reading a slightly
 * wrong value is far easier to diagnose than a bridge that silently returns `undefined`.
 */
internal fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is String -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(
        entries.mapNotNull { (k, v) -> k?.let { it.toString() to v.toJsonElement() } }.toMap(),
    )
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    is Array<*> -> JsonArray(map { it.toJsonElement() })
    is BooleanArray -> JsonArray(map { JsonPrimitive(it) })
    is IntArray -> JsonArray(map { JsonPrimitive(it) })
    is LongArray -> JsonArray(map { JsonPrimitive(it) })
    is DoubleArray -> JsonArray(map { JsonPrimitive(it) })
    // Binary cannot ride in JSON as bytes: base64 it so a round trip through the JS bridge
    // (save_data -> load_data) does not corrupt it into a `[B@1a2b3c` string.
    is ByteArray -> JsonPrimitive(Base64.getEncoder().encodeToString(this))
    else -> JsonPrimitive(this.toString())
}
