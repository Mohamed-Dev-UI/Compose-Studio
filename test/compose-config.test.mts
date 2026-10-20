import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyComposeConfigToDescription,
  buildComposeConfigBlock,
  BUILTIN_COMPONENT_PRESETS,
  COMPOSE_CONFIG_TEMPLATE,
  normalizeComponentConfig,
  parseComposeConfig,
  parseMappingArgs,
  ROLE_PARAMETERS,
  stripComposeConfig,
  composeConfigSignature,
  describeComposeConfig,
  suggestMappingName,
  type ParsedComponentConfig,
} from '../src/shared/compose-config.ts';

/** A minimal valid config, used as the round-trip baseline. */
const baseConfig: ParsedComponentConfig = {
  tag: 'compose-studio',
  version: 1,
  role: 'card',
  kind: null,
  assets: 'auto',
  implementation: 'auto',
  mapping: null,
  mappingArgs: [],
  note: null,
};

test('parseComposeConfig ignores descriptions without the marker', () => {
  const r = parseComposeConfig('A designer note about the button.');
  assert.equal(r.config, null);
  assert.equal(r.prose, 'A designer note about the button.');
  assert.equal(r.issues.length, 0);

  // A stray marker glued to content is not a block; reported, not consumed.
  const stray = parseComposeConfig('Note\ncompose-studio: role: card');
  assert.equal(stray.config, null);
  assert.equal(stray.issues.some((i) => i.includes('alone on its line')), true);
});

test('parseComposeConfig reads the flat keys and preserves the prose', () => {
  const r = parseComposeConfig(
    [
      'Primary action card.',
      'Used on the dashboard only.',
      '',
      'compose-studio:',
      'role: card',
      'kind: icon',
      'assets: export',
      'implementation: custom',
      'mapping: MyAppCard',
      'mappingArgs: title="Sign In", count=2, icon=@icon',
      'note: keep 12dp radius',
    ].join('\n'),
  );
  assert.equal(r.prose, 'Primary action card.\nUsed on the dashboard only.');
  assert.equal(r.issues.length, 0);
  const cfg = r.config!;
  assert.equal(cfg.role, 'card');
  assert.equal(cfg.kind, 'icon');
  assert.equal(cfg.assets, 'export');
  assert.equal(cfg.implementation, 'custom');
  assert.equal(cfg.mapping, 'MyAppCard');
  assert.deepEqual(
    cfg.mappingArgs,
    [
      { argument: 'title', source: { kind: 'constant', value: 'Sign In' } },
      { argument: 'count', source: { kind: 'constant', value: '2' } },
      { argument: 'icon', source: { kind: 'icon' } },
    ],
  );
  assert.equal(cfg.note, 'keep 12dp radius');
});

test('parseComposeConfig is tolerant: unknown keys and values report and skip', () => {
  const r = parseComposeConfig(
    ['compose-studio:', 'role: spaceship', 'kind: sticker', 'assets: yes-please', 'unknownKey: 1', 'role: card', '# a comment', ''].join('\n'),
  );
  assert.equal(r.issues.length, 4);
  assert.match(r.issues.join(' '), /unknown role 'spaceship'/);
  assert.match(r.issues.join(' '), /unknown kind 'sticker'/);
  assert.match(r.issues.join(' '), /unknown assets policy 'yes-please'/);
  assert.match(r.issues.join(' '), /unknown key 'unknownKey'/);
  assert.equal(r.config!.role, 'card');
  assert.equal(r.config!.kind, null);
  assert.equal(r.config!.assets, 'auto');
});

test('parseComposeConfig reports a newer version but still parses', () => {
  const r = parseComposeConfig('compose-studio:\nversion: 2\nrole: fab');
  assert.equal(r.config!.role, 'fab');
  assert.equal(r.issues.some((i) => i.includes('newer than this plugin')), true);
});

test('parseComposeConfig keeps a comment-only block unconfigured with a note', () => {
  const r = parseComposeConfig('compose-studio:\n# nothing configured yet\n');
  assert.equal(r.config, null);
  assert.equal(r.issues.some((i) => i.includes('carries no keys')), true);
});

test('the shipped template parses clean and selects role card', () => {
  const r = parseComposeConfig(COMPOSE_CONFIG_TEMPLATE);
  assert.equal(r.config!.role, 'card');
  assert.equal(r.prose, '');
  assert.equal(r.issues.length, 0);
});

test('buildComposeConfigBlock round-trips through the parser untouched', () => {
  const full: ParsedComponentConfig = {
    ...baseConfig,
    role: 'button',
    kind: 'image',
    assets: 'code',
    implementation: 'custom',
    mapping: 'my.pkg.MyButton',
    mappingArgs: [
      { argument: 'alpha', source: { kind: 'constant', value: '0.8' } },
      { argument: 'text', source: { kind: 'text' } },
      { argument: 'icon', source: { kind: 'icon' } },
      { argument: 'color', source: { kind: 'color' } },
      { argument: 'mods', source: { kind: 'modifier' } },
    ],
    note: 'note with # hash',
  };
  const block = buildComposeConfigBlock(full);
  const parsed = parseComposeConfig(`Prose.\n\ncompose-studio:\n${block}`);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.prose, 'Prose.');
  const roundTripped = parsed.config!;
  assert.equal(composeConfigSignature(roundTripped), composeConfigSignature(full));
  assert.equal(roundTripped.mappingArgs.length, 5);
});

test('buildComposeConfigBlock omits defaults and omits collisions', () => {
  const block = buildComposeConfigBlock(baseConfig);
  assert.equal(block, 'role: card');
  const empty = buildComposeConfigBlock({ ...baseConfig, role: null });
  assert.equal(empty, '');
  // withHelp adds hint comments for the untouched keys instead.
  const help = buildComposeConfigBlock({ ...baseConfig, role: null }, true);
  assert.match(help, /# role:/);
  assert.match(help, /# kind:/);
  assert.match(help, /# mappingArgs:/);
  // A help-only block carries no keys, so it parses as unconfigured.
  const parsed = parseComposeConfig(`compose-studio:\n${help}`);
  assert.equal(parsed.config, null);
  assert.equal(parsed.issues.some((i) => i.includes('carries no keys')), true);
});

test('applyComposeConfigToDescription preserves prose and replaces an old block', () => {
  const original = 'Hero card.\nUsed in feeds.\n\ncompose-studio:\nrole: card';
  const first = parseComposeConfig(original);
  assert.equal(first.prose, 'Hero card.\nUsed in feeds.');
  const block = buildComposeConfigBlock({ ...baseConfig, role: 'button' });
  const next = applyComposeConfigToDescription(first.prose, block);
  assert.equal(next, `Hero card.\nUsed in feeds.\n\ncompose-studio:\n${block}`);
  const reparsed = parseComposeConfig(next);
  assert.equal(reparsed.config!.role, 'button');
  // Re-applying with the prose alone must not stack a second block.
  const again = applyComposeConfigToDescription(reparsed.prose, block);
  assert.equal(again, next);
  assert.equal((again.match(/compose-studio:/g) ?? []).length, 1);
});

test('stripComposeConfig leaves prose descriptions untouched', () => {
  assert.equal(stripComposeConfig('Just prose.'), 'Just prose.');
  assert.equal(stripComposeConfig('Prose.\n\ncompose-studio:\nrole: card'), 'Prose.');
});

test('parseMappingArgs splits on commas outside quotes and describes sources', () => {
  const r = parseMappingArgs('title="a, b", bare=\'x\'');
  assert.equal(r.issues.length, 0);
  assert.deepEqual(r.args[0], { argument: 'title', source: { kind: 'constant', value: 'a, b' } });
  assert.deepEqual(r.args[1], { argument: 'bare', source: { kind: 'constant', value: 'x' } });

  const missing = parseMappingArgs('notPaired');
  assert.equal(missing.args.length, 0);
  assert.equal(missing.issues.length, 1);

  const weird = parseMappingArgs('title=@mystery, count=42');
  assert.equal(weird.args.length, 2);
  assert.deepEqual(weird.args[0], { argument: 'title', source: { kind: 'constant', value: '@mystery' } });
  assert.deepEqual(weird.args[1], { argument: 'count', source: { kind: 'constant', value: '42' } });
  assert.equal(weird.issues.some((i) => i.includes('unknown mapping source')), true);
});

test('role parameters carry inert defaults and cover every role', () => {
  for (const [role, params] of Object.entries(ROLE_PARAMETERS)) {
    for (const p of params) {
      assert.equal(p.type.length > 0, true, `${role}/${p.param} needs a type`);
      assert.equal(p.def.length > 0, true, `${role}/${p.param} needs a default`);
    }
  }
  assert.deepEqual(ROLE_PARAMETERS.button.map((p) => p.param), ['onClick', 'enabled']);
  assert.deepEqual(ROLE_PARAMETERS.slider.map((p) => p.param), ['value', 'onValueChange', 'enabled']);
  assert.deepEqual(ROLE_PARAMETERS.badge, []);
});

test('describeComposeConfig summarizes the applied values', () => {
  const text = describeComposeConfig({ ...baseConfig, kind: 'icon', assets: 'export' });
  assert.match(text, /role card/);
  assert.match(text, /kind icon/);
  assert.match(text, /assets: export/);
  assert.match(text, /·/);
});

test('normalizeComponentConfig validates the visual editor payload', () => {
  const clean = normalizeComponentConfig({
    role: 'button',
    kind: 'icon',
    assets: 'export',
    implementation: 'custom',
    mapping: 'com.example.ui.MyButton',
    mappingArgs: [
      { argument: 'title', source: { kind: 'constant', value: 'Sign In' } },
      { argument: 'icon', source: { kind: 'icon' } },
    ],
    note: 'from the visual editor',
  });
  assert.equal(clean.issues.length, 0);
  assert.equal(clean.config.tag, 'compose-studio');
  assert.equal(clean.config.version, 1);
  assert.equal(clean.config.role, 'button');
  assert.equal(clean.config.kind, 'icon');
  assert.equal(clean.config.assets, 'export');
  assert.equal(clean.config.implementation, 'custom');
  assert.equal(clean.config.mapping, 'com.example.ui.MyButton');
  assert.equal(clean.config.mappingArgs.length, 2);
  assert.deepEqual(clean.config.mappingArgs[0], { argument: 'title', source: { kind: 'constant', value: 'Sign In' } });
  assert.deepEqual(clean.config.mappingArgs[1], { argument: 'icon', source: { kind: 'icon' } });
  assert.equal(clean.config.note, 'from the visual editor');
});

test('normalizeComponentConfig rejects non-object payloads and salvages valid siblings', () => {
  for (const bad of [null, 7, 'x', ['a']]) {
    const r = normalizeComponentConfig(bad);
    assert.equal(r.issues.length, 1);
    assert.equal(r.config.role, null);
    assert.equal(r.config.assets, 'auto');
  }
  const mixed = normalizeComponentConfig({ role: 'sword', kind: 'image', assets: 'nope', mapping: 'not*' });
  assert.notEqual(mixed.issues.length, 0);
  assert.equal(mixed.config.role, null); // unknown role falls back
  assert.equal(mixed.config.kind, 'image'); // valid sibling still applies
  assert.equal(mixed.config.assets, 'auto'); // unknown policy falls back
  assert.equal(mixed.config.mapping, null); // malformed symbol falls back
  // The salvaged result renders to a parseable block.
  const block = buildComposeConfigBlock(mixed.config);
  assert.equal(parseComposeConfig(`compose-studio:\n${block}`).config!.kind, 'image');
});

test('normalizeComponentConfig tolerates broken mapping Args entries', () => {
  const r = normalizeComponentConfig({
    mappingArgs: [
      'notAnObject' as unknown,
      { argument: '1bad name', source: { kind: 'text' } },
      { argument: 'count', source: { kind: 'mystery' } },
      { argument: 'noSource' },
      { argument: 'icon', source: { kind: 'icon' } },
      { argument: 'icon', source: { kind: 'color' } },
      null as unknown,
    ],
  });
  assert.equal(r.issues.length, 6); // non-object, bad name, unknown source, missing source, duplicate, null entry
  assert.equal(r.config.mappingArgs.length, 3);
  assert.deepEqual(r.config.mappingArgs[0], { argument: 'count', source: { kind: 'constant', value: '' } });
  assert.deepEqual(r.config.mappingArgs[1], { argument: 'noSource', source: { kind: 'constant', value: '' } });
  assert.deepEqual(r.config.mappingArgs[2], { argument: 'icon', source: { kind: 'icon' } });
  // mappingArgs of a non-list shape is ignored wholesale.
  const weird = normalizeComponentConfig({ mappingArgs: 'title="x"' });
  assert.equal(weird.issues.length, 1);
  assert.deepEqual(weird.config.mappingArgs, []);
});

test('normalizeComponentConfig round-trips through the block builder like a parsed config', () => {
  const parsed = parseComposeConfig(
    'compose-studio:\nrole: slider\nmappingArgs: value=0.5, label="Volume"',
  ).config!;
  const rebuilt = buildComposeConfigBlock(normalizeComponentConfig(JSON.parse(JSON.stringify(parsed))).config);
  const reparsed = parseComposeConfig(`compose-studio:\n${rebuilt}`).config!;
  assert.equal(composeConfigSignature(reparsed), composeConfigSignature(parsed));
  // Empty strings normalize to nulls / defaults, matching the text parser.
  const blanks = normalizeComponentConfig({ role: '', kind: '', note: '' });
  assert.equal(blanks.issues.length, 0);
  assert.equal(blanks.config.role, null);
  assert.equal(blanks.config.kind, null);
  assert.equal(blanks.config.note, null);
});

test('parseMappingArgs reads typed constants for every datatype', () => {
  const typed = 'count=int:42, delay=long:5, opacity=float:0.5, ratio=double:0.5, on=boolean:true';
  const { args, issues } = parseMappingArgs(`${typed}, title=string:Sign In, c=char:a, pad=dp:16, size=sp:14, tint=color:8080FF, style=object:TextStyle.Default`);
  assert.deepEqual(issues, []);
  const byName = new Map(args.map((a) => [a.argument, a]));
  assert.equal(byName.size, 11, 'it counts every typed entry');
  assert.deepEqual(byName.get('count')!.source, { kind: 'constant', value: '42', dataType: 'int' });
  assert.deepEqual(byName.get('delay')!.source, { kind: 'constant', value: '5', dataType: 'long' });
  assert.deepEqual(byName.get('opacity')!.source, { kind: 'constant', value: '0.5', dataType: 'float' });
  assert.deepEqual(byName.get('ratio')!.source, { kind: 'constant', value: '0.5', dataType: 'double' });
  assert.deepEqual(byName.get('on')!.source, { kind: 'constant', value: 'true', dataType: 'boolean' });
  assert.deepEqual(byName.get('title')!.source, { kind: 'constant', value: 'Sign In', dataType: 'string' });
  assert.deepEqual(byName.get('c')!.source, { kind: 'constant', value: 'a', dataType: 'char' });
  assert.deepEqual(byName.get('pad')!.source, { kind: 'constant', value: '16', dataType: 'dp' });
  assert.deepEqual(byName.get('size')!.source, { kind: 'constant', value: '14', dataType: 'sp' });
  assert.deepEqual(byName.get('tint')!.source, { kind: 'constant', value: '8080FF', dataType: 'color' });
  assert.deepEqual(byName.get('style')!.source, { kind: 'constant', value: 'TextStyle.Default', dataType: 'object' });
});

test('parseMappingArgs tolerates bad typed payloads by downgrading to plain constants', () => {
  const { args, issues } = parseMappingArgs('a=int:12.5, b=boolean:yes, c=char:ab, d=color:#GGG, e=dp:x, s=string:, o=object:');
  assert.equal(args.length, 7);
  assert.deepEqual(
    args.map((a) => (a.source.kind === 'constant' ? a.source.value : null)),
    ['12.5', 'yes', 'ab', '#GGG', 'x', '', ''],
  );
  assert.equal(args.every((a) => a.source.kind === 'constant' && !('dataType' in a.source)), true, 'nothing keeps its datatype');
  assert.equal(issues.length, 7, 'each downgrade is noted');
  assert.match(issues[0]!, /not valid for @int/);
});

test('typed mapping arguments round-trip through the block builder (quoted payloads survive commas)', () => {
  const parsed = parseComposeConfig(
    'compose-studio:\nmapping: MyApp\nmappingArgs: title=string:"a, b", tint=color:80FF40, pad=dp:16',
  ).config!;
  const rebuilt = buildComposeConfigBlock(parsed);
  assert.match(rebuilt, /title=string:"a, b"/, 'the comma payload gets its quotes back');
  assert.match(rebuilt, /tint=color:80FF40/);
  assert.match(rebuilt, /pad=dp:16/);
  const reparsed = parseComposeConfig(`compose-studio:\n${rebuilt}`).config!;
  assert.deepEqual(reparsed.mappingArgs, parsed.mappingArgs, 'the parser reproduces the typed sources');
  assert.equal(composeConfigSignature(reparsed), composeConfigSignature(parsed));
  // Untyped constants keep the legacy text form (not typed).
  const legacy = parseComposeConfig('compose-studio:\nmappingArgs: count=2, label="a, b"').config!;
  const legacyBuilt = buildComposeConfigBlock(legacy);
  assert.match(legacyBuilt, /count=2(?![\d])/);
  assert.match(legacyBuilt, /label="a, b"/);
  assert.doesNotMatch(legacyBuilt, /int:|string:/);
});

test('normalizeComponentConfig carries typed constants and validates the datatype tag', () => {
  const ok = normalizeComponentConfig({
    mappingArgs: [{ argument: 'count', source: { kind: 'constant', value: '42', dataType: 'int' } }],
  });
  assert.deepEqual(ok.config.mappingArgs[0]!.source, { kind: 'constant', value: '42', dataType: 'int' });
  // A JS-object shorthand kind of the datatype renders too (typed without dataType field).
  const shorthand = normalizeComponentConfig({
    mappingArgs: [{ argument: 'count', source: { kind: 'int', value: '42' } }],
  });
  assert.deepEqual(shorthand.config.mappingArgs[0]!.source, { kind: 'constant', value: '42', dataType: 'int' });
  // An unknown datatype tag degrades to a plain constant with a note.
  const bad = normalizeComponentConfig({
    mappingArgs: [{ argument: 'count', source: { kind: 'constant', value: '42', dataType: 'bigint' } }],
  });
  assert.deepEqual(bad.config.mappingArgs[0]!.source, { kind: 'constant', value: '42' });
  assert.equal(bad.issues.length, 1, 'the unknown tag was reported');
  // The signature distinguishes types (int 1 vs string "1" vs raw 1).
  const sig = (args: unknown[]): string => composeConfigSignature(
    normalizeComponentConfig({ mappingArgs: args }).config,
  );
  assert.notEqual(
    sig([{ argument: 'a', source: { kind: 'constant', value: '1', dataType: 'int' } }]),
    sig([{ argument: 'a', source: { kind: 'constant', value: '1' } }]),
  );
  assert.notEqual(
    sig([{ argument: 'a', source: { kind: 'constant', value: '1', dataType: 'int' } }]),
    sig([{ argument: 'a', source: { kind: 'constant', value: '1', dataType: 'string' } }]),
  );
});

test('suggestMappingName derives a Kotlin function name from the master name', () => {
  assert.equal(suggestMappingName('Working Level'), 'WorkingLevel');
  assert.equal(suggestMappingName('Button/B'), 'ButtonB');
  assert.equal(suggestMappingName('Primary=large'), 'PrimaryLarge');
  assert.equal(suggestMappingName('3 dots'), 'X3Dots');
  assert.equal(suggestMappingName('### '), 'X', 'a symbol-only name falls back to X');
  assert.equal(suggestMappingName('when'), 'When', 'capitalized keywords are legal Kotlin function names');
  assert.equal(suggestMappingName('   '), null, 'a blank name suggests nothing');
});

test('built-in presets are clean named configs (unique, normalizable, short)', () => {
  const seen = new Set<string>();
  for (const preset of BUILTIN_COMPONENT_PRESETS) {
    assert.ok(preset.name.trim().length >= 1 && preset.name.length <= 48, `name in range: ${preset.name}`);
    assert.ok(!seen.has(preset.name), `unique: ${preset.name}`);
    seen.add(preset.name);
    const { config, issues } = normalizeComponentConfig(JSON.parse(JSON.stringify(preset.config)));
    assert.deepEqual(issues, [], `preset '${preset.name}' parses clean`);
    assert.equal(config.tag, 'compose-studio');
    assert.equal(config.version, 1);
  }
  const roles = new Set(BUILTIN_COMPONENT_PRESETS.filter((p) => p.config.role).map((p) => p.config.role));
  assert.deepEqual([...roles], ['button', 'card', 'fab'], 'the Material starting points are offered');
  const kinds = BUILTIN_COMPONENT_PRESETS.filter((p) => p.config.kind).map((p) => p.config.kind);
  assert.ok(kinds.includes('icon') && kinds.includes('image'), 'asset starting points offered for icons and images');
  const reset = BUILTIN_COMPONENT_PRESETS.find((p) => p.config.role === null && p.config.kind === null);
  assert.ok(reset, 'an all-defaults reset starter exists');
});
