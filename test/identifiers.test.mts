import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelCase, isKotlinIdentifier, pascalCase, sanitizeKotlinIdentifier, snakeCase } from '../src/util/identifiers.ts';

test('pascalCase splits on non-alphanumeric characters', () => {
  assert.equal(pascalCase('hello world'), 'HelloWorld');
  assert.equal(pascalCase('sign-in-flow_v2'), 'SignInFlowV2');
  assert.equal(pascalCase(' Already CamelCased '), 'AlreadyCamelCased');
});

test('pascalCase prefixes numeric-leading names', () => {
  assert.equal(pascalCase('3 dots'), 'X3Dots');
  assert.equal(pascalCase('123'), 'X123');
});

test('pascalCase falls back for empty input', () => {
  assert.equal(pascalCase(''), 'X');
  assert.equal(pascalCase('````'), 'X');
});

test('camelCase lowercases the first word', () => {
  assert.equal(camelCase('hello world'), 'helloWorld');
  assert.equal(camelCase('3 dots'), 'x3Dots');
});

test('snakeCase lowercases and underscores, prefixing digits', () => {
  assert.equal(snakeCase('My Asset Name'), 'my_asset_name');
  assert.equal(snakeCase('2x icon'), 'i2x_icon');
  assert.equal(snakeCase(''), 'item');
});

test('sanitizeKotlinIdentifier clamps and avoids hard keywords', () => {
  const out = sanitizeKotlinIdentifier('class');
  assert.equal(out, 'Class');
  assert.equal(isKotlinIdentifier(out), true);
  const long = sanitizeKotlinIdentifier('a'.repeat(100));
  assert.equal(long.length, 64);
  assert.equal(sanitizeKotlinIdentifier(''), 'X');
});

test('sanitizeKotlinIdentifier output is always a valid Kotlin identifier', () => {
  for (const input of ['', '  ', '@wrong', '1 2 3', 'ünïcode', 'Button/Primary', '-42']) {
    const out = sanitizeKotlinIdentifier(input, 'Fallback');
    assert.equal(isKotlinIdentifier(out), true, `${JSON.stringify(input)} -> ${out}`);
  }
});
