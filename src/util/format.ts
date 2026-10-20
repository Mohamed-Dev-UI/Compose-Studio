/**
 * Formatting primitives shared between extraction and code generation.
 * All functions are deterministic.
 */

/** Round to `n` decimal places (default 4 significant px precision) and trim trailing zeros. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  let str = String(rounded);
  if (str === '-0') str = '0';
  if (/^(-?\d+\.\d*?)0+$/.test(str)) {
    return str.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return str;
}

/** Compose `xx.dp` literal for a design pixel value (1px == 1dp is the documented assumption). */
export function dpLiteral(value: number): string {
  return `${formatNumber(value)}.dp`;
}

/** Compose `xx.sp` literal for a text unit. */
export function spLiteral(value: number): string {
  return `${formatNumber(value)}.sp`;
}

const HEX = '0123456789ABCDEF';
/** 0..1 float -> `XX` hex byte (clamped). */
export function floatByte(value: number, multiplier = 1): string {
  const clamped = Math.min(1, Math.max(0, value));
  const byte = Math.round(clamped * multiplier * 255);
  return `${HEX[(byte >> 4) & 0xf] ?? '0'}${HEX[byte & 0xf] ?? '0'}`;
}

/** Compose `0xAARRGGBB` literal from normalized RGBA channels.
 *  The final alpha is `rgba.a * alphaMultiplier` clamped to 0..1. */
export function argbLiteral(rgba: { r: number; g: number; b: number; a: number }, multiplier = 1): string {
  return `0x${floatByte(rgba.a, multiplier)}${floatByte(rgba.r)}${floatByte(rgba.g)}${floatByte(rgba.b)}`;
}

/** `0xAARRGGBB` -> `#RRGGBB` or `#AARRGGBB`, used as a mapping key and for messages. */
export function argbLiteralToHexString(argb: string): string {
  const core = argb.startsWith('0x') ? argb.slice(2) : argb;
  const alpha = core.slice(0, 2).toUpperCase();
  const rgb = core.slice(2).toUpperCase();
  return alpha === 'FF' ? `#${rgb}` : `#${alpha}${rgb}`;
}

/** Escape a Kotlin string literal body (content between quotes). */
export function escapeKotlinString(text: string): string {
  let out = '';
  for (const ch of text) {
    switch (ch) {
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '$': out += '${\'$\'}'; break;
      default: out += ch;
    }
  }
  return out;
}
