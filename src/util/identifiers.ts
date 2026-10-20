/**
 * Utilities for turning Figma node names into valid, stable Kotlin identifiers.
 *
 * Design notes:
 * - Split on every character that is not a letter or a digit.
 * - Capitalize each word for PascalCase, lowercase the first word for camelCase.
 * - Prefix with `X` when the name starts with a digit; fall back when empty.
 * - Append `_` to Kotlin hard keywords.
 * - Deterministic: same input always yields same output.
 */

const KOTLIN_HARD_KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if',
  'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super',
  'this', 'throw', 'true', 'try', 'typealias', 'val', 'var', 'when', 'while',
]);

/** True when the value is already a valid, non-quoted Kotlin identifier. */
export function isKotlinIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

/** True when the value is a valid identifier AND not a Kotlin hard keyword. */
export function isKotlinSafeIdentifier(value: string): boolean {
  return isKotlinIdentifier(value) && !KOTLIN_HARD_KEYWORDS.has(value);
}

/** Guarantees a valid identifier: appends `_` to Kotlin hard keywords. */
export function safeIdentifier(name: string): string {
  return isKotlinSafeIdentifier(name) ? name : `${name}_`;
}

/** `hello world` -> `HelloWorld`; `3 dots` -> `X3Dots`. */
export function pascalCase(name: string): string {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  let out = '';
  for (const w of words) {
    out += w.charAt(0).toUpperCase() + w.slice(1);
  }
  if (out.length === 0) return 'X';
  if (/^[0-9]/.test(out)) out = 'X' + out;
  return out;
}

/** `hello world` -> `helloWorld`; `3 dots` -> `x3Dots`. */
export function camelCase(name: string): string {
  const p = pascalCase(name);
  if (p.length === 0) return p;
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** `My Asset Name` -> `my_asset_name`; leading digits are prefixed with `i`. */
export function snakeCase(name: string): string {
  const parts = String(name).replace(/[^A-Za-z0-9]+/g, '_').split('_').filter((p) => p.length > 0);
  if (parts.length === 0) return 'item';
  let out = '';
  for (const p of parts) out += (out.length > 0 ? '_' : '') + p.toLowerCase();
  if (/^[0-9]/.test(out)) out = 'i' + out;
  return out;
}

/** Sanitize a node name into a valid PascalCase Kotlin identifier, clamped to 64 chars. */
export function sanitizeKotlinIdentifier(name: string, fallback = 'X'): string {
  let out = pascalCase(name);
  if (out.length > 64) out = out.slice(0, 64);
  if (out.length === 0) return fallback;
  // pascalCase guarantees a leading capital, so only a case-sensitive match
  // can ever hit a Kotlin hard keyword; guard defensively.
  if (KOTLIN_HARD_KEYWORDS.has(out)) out = `${out}_`;
  return out;
}
