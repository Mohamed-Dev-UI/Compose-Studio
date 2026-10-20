import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  argbLiteral,
  argbLiteralToHexString,
  dpLiteral,
  escapeKotlinString,
  floatByte,
  formatNumber,
  spLiteral,
} from '../src/util/format.ts';

test('formatNumber trims trailing zeros', () => {
  assert.equal(formatNumber(12.000), '12');
  assert.equal(formatNumber(1.5000), '1.5');
  assert.equal(formatNumber(-0.00001), '0');
  assert.equal(formatNumber(Number.NaN), '0');
});

test('dp and sp literals', () => {
  assert.equal(dpLiteral(16), '16.dp');
  assert.equal(dpLiteral(0.5), '0.5.dp');
  assert.equal(spLiteral(14), '14.sp');
});

test('floatByte clamps and rounds', () => {
  assert.equal(floatByte(1), 'FF');
  assert.equal(floatByte(0), '00');
  assert.equal(floatByte(0.5), '80');
  assert.equal(floatByte(-5), '00');
  assert.equal(floatByte(2), 'FF');
});

test('argbLiteral packs RGBA with alpha first and applies multiplier', () => {
  assert.equal(argbLiteral({ r: 0, g: 0, b: 0, a: 1 }), '0xFF000000');
  assert.equal(argbLiteral({ r: 1, g: 0.5, b: 0.25, a: 1 }), '0xFFFF8040');
  assert.equal(argbLiteral({ r: 1, g: 0, b: 0, a: 1 }, 0.5), '0x80FF0000');
});

test('argbLiteralToHexString strips full alpha', () => {
  assert.equal(argbLiteralToHexString('0xFFFF8040'), '#FF8040');
  assert.equal(argbLiteralToHexString('0x80FF0000'), '#80FF0000');
});

test('escapeKotlinString escapes quotes, backslashes and dollar', () => {
  assert.equal(escapeKotlinString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeKotlinString('a\\b'), 'a\\\\b');
  assert.equal(escapeKotlinString('$price'), '${\'$\'}price');
  assert.equal(escapeKotlinString('line\nbreak'), 'line\\nbreak');
});
