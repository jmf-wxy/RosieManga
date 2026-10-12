package eu.kanade.presentation.more.settings.screen.browse.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.source.manga.js.JsAccountMode
import eu.kanade.tachiyomi.source.manga.js.JsSettingItem

/**
 * Dialogs backing the JS source configuration rows: text input, single-select, and login.
 *
 * These mirror Venera's `showInputDialog` / `Select` / `_LoginPage` behaviour, including storing the
 * option **value** (not its display text) and validating input against the source's regex.
 */

/** `type: "input"` — free-text edit, validated against the source's `validator` regex on confirm. */
@Composable
fun JsSettingInputDialog(
    item: JsSettingItem.Input,
    currentValue: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by rememberSaveable { mutableStateOf(currentValue) }
    val regex = remember(item.validator) {
        item.validator?.let { runCatching { Regex(it) }.getOrNull() }
    }
    val error = regex?.takeIf { text.isNotEmpty() && !it.matches(text) }?.let { "格式不符合要求" }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(item.title) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                isError = error != null,
                supportingText = error?.let { { Text(it) } },
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(text); onDismiss() },
                enabled = error == null,
            ) { Text("确定") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** `type: "select"` — pick one option; the option **value** is what gets persisted. */
@Composable
fun JsSettingSelectDialog(
    item: JsSettingItem.Select,
    currentValue: Any?,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val selected = currentValue?.toString() ?: item.defaultValue
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(item.title) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                item.options.forEach { option ->
                    TextButton(
                        onClick = {
                            onSelect(option.value)
                            onDismiss()
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = if (option.value == selected) "✓ ${option.text}" else option.text,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/**
 * Login dialog for the three account modes Venera supports.
 *
 * `Password` renders two fields, `Cookies` renders one field per declared cookie name, and
 * `Webview` cannot be handled here — the caller must open a browser instead.
 */
@Composable
fun JsLoginDialog(
    sourceName: String,
    mode: JsAccountMode,
    onLogin: (List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val labels: List<String> = when (mode) {
        JsAccountMode.Password -> listOf("账号", "密码")
        is JsAccountMode.Cookies -> mode.fields
        is JsAccountMode.Webview -> emptyList()
    }

    var values by remember(labels) {
        mutableStateOf(List(labels.size) { "" })
    }
    val canSubmit = values.size == labels.size && values.all { it.isNotBlank() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("登录 · $sourceName") },
        text = {
            Column {
                labels.forEachIndexed { index, label ->
                    OutlinedTextField(
                        value = values.getOrElse(index) { "" },
                        onValueChange = { input ->
                            values = values.toMutableList().also { it[index] = input }
                        },
                        label = { Text(label) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = if (label.contains("密码")) KeyboardType.Password else KeyboardType.Text,
                        ),
                        visualTransformation = if (label.contains("密码")) {
                            PasswordVisualTransformation()
                        } else {
                            VisualTransformation.None
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onLogin(values); onDismiss() },
                enabled = canSubmit,
            ) { Text("登录") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
