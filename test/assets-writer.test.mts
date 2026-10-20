import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssetRegistry } from '../src/gen/assets.ts';
import { KotlinFile } from '../src/gen/kotlin-writer.ts';

test('asset names are deterministic snake_case with kind prefixes', () => {
  const registry = new AssetRegistry({});
  const ref = { fuid: 'n1', nodeName: 'Star Icon', fType: 'VECTOR' };
  assert.equal(registry.add('svg', ref), 'ic_star_icon');
  assert.equal(registry.add('svg', ref), 'ic_star_icon'); // same node -> same asset
  const ref2 = { fuid: 'n2', nodeName: 'Avatar Photo', fType: 'RECTANGLE' };
  assert.equal(registry.add('png', ref2, 'Avatar Photo'), 'img_avatar_photo');
});

test('auto-detect (no prefix) keeps the legacy naming and names without stripping', () => {
  const registry = new AssetRegistry({});
  assert.equal(registry.activePrefix('svg'), null);
  assert.equal(registry.add('svg', { fuid: 'n1', nodeName: 'Star Icon', fType: 'VECTOR' }), 'ic_star_icon');
  assert.equal(registry.size(), 1);
});

test('a configured icon prefix exports only matching vector names and strips them', () => {
  const registry = new AssetRegistry({ icon: 'icon_' });
  assert.equal(registry.activePrefix('svg'), 'icon_');
  assert.equal(registry.activePrefix('png'), null); // other kind stays auto-detect
  const match = { fuid: 'n1', nodeName: 'icon_arrow', fType: 'VECTOR' };
  assert.equal(registry.add('svg', match), 'ic_arrow');
  assert.equal(registry.add('svg', match), 'ic_arrow'); // dedupe unchanged
  // Matching is case-insensitive.
  assert.equal(registry.add('png', { fuid: 'n2', nodeName: 'ICON_Photo', fType: 'RECTANGLE' }), 'img_icon_photo');
  // (The icon prefix gates SVGs only — PNGs keep auto-detect and full names.)
  // Non-matching vector names are rejected (null) and register nothing.
  assert.equal(registry.add('svg', { fuid: 'n3', nodeName: 'Badge', fType: 'VECTOR' }), null);
  assert.equal(registry.add('svg', { fuid: 'n4', nodeName: 'asset', fType: 'VECTOR' }), null);
  assert.equal(registry.size(), 2);
});

test('typed prefixes gate only their own kind', () => {
  const registry = new AssetRegistry({ image: 'img_' });
  // PNG needs the prefix…
  assert.equal(registry.add('png', { fuid: 'p1', nodeName: 'Hero Photo', fType: 'RECTANGLE' }), null);
  assert.equal(registry.add('png', { fuid: 'p2', nodeName: 'img_hero', fType: 'RECTANGLE' }), 'img_hero');
  // …while vectors pass through unfiltered.
  assert.equal(registry.add('svg', { fuid: 'i1', nodeName: 'Star', fType: 'VECTOR' }), 'ic_star');
  assert.equal(registry.size(), 2);
});

test('name collisions get numeric suffixes deterministically', () => {
  const registry = new AssetRegistry({});
  const a = { fuid: 'a', nodeName: 'Icon', fType: 'VECTOR' };
  const b = { fuid: 'b', nodeName: 'Icon', fType: 'VECTOR' };
  const c = { fuid: 'c', nodeName: 'Icon', fType: 'VECTOR' };
  const first = registry.add('svg', a);
  assert.equal(first, 'ic_icon');
  assert.equal(registry.add('svg', b, ''), 'ic_icon_2');
  assert.equal(registry.add('svg', c), 'ic_icon_3');
});

test('list() is sorted by name then kind', () => {
  const registry = new AssetRegistry({});
  registry.add('svg', { fuid: 'b', nodeName: 'Zulu', fType: 'VECTOR' });
  registry.add('png', { fuid: 'a', nodeName: 'Alpha', fType: 'RECTANGLE' });
  const names = registry.list().map((a) => a.name);
  assert.deepEqual(names, ['ic_zulu', 'img_alpha'].sort((x, y) => x.localeCompare(y)));
});

test('KotlinFile renders package header, sorted imports and body lines', () => {
  const file = new KotlinFile('com.example.app');
  file.useImport('androidx.compose.ui.Modifier');
  file.useImport('androidx.compose.runtime.Composable');
  file.useImport('androidx.compose.ui.Modifier'); // dedupe
  file.line('@Composable');
  file.line('fun Main() {}');
  const rendered = file.render();
  const lines = rendered.split('\n');
  assert.equal(lines[0], 'package com.example.app');
  const imports = lines.filter((l) => l.startsWith('import '));
  assert.deepEqual(imports, [
    'import androidx.compose.runtime.Composable',
    'import androidx.compose.ui.Modifier',
  ]);
  assert.equal(rendered.endsWith('fun Main() {}\n'), true);
});
