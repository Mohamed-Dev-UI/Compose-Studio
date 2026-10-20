import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, parseMappingProfile, type MappingProfile } from '../src/mapping/profile.ts';
import {
  mappingSummary,
  resolveColorMapping,
  resolveComponentMapping,
  resolveFontMapping,
  resolveTextMapping,
  verifyComponentMapping,
} from '../src/mapping/resolve.ts';

const validProfileJson = {
  schemaVersion: 1,
  profileName: 'My DS',
  colors: [
    { source: { kind: 'hex', name: '#FF8040' }, target: 'AppTheme.colors.accent' },
    { source: { kind: 'variable', variableId: 'var:1' }, target: 'AppTheme.colors.primary' },
    { source: { kind: 'variable', name: 'Color/Primary' }, target: 'AppTheme.colors.primary' },
  ],
  fonts: [{ source: { kind: 'family', name: 'Roboto' }, target: 'FontFamily.SansSerif' }],
  textStyles: [{ source: { kind: 'fontFamily', name: 'Roboto', fontSize: 14 }, target: 'MaterialTheme.typography.bodyMedium' }],
  components: [
    {
      source: { kind: 'component', componentName: 'Button' },
      target: { symbol: 'AppButton' },
      arguments: [
        { argument: 'text', source: { kind: 'text', childIndex: 0 } },
        { argument: 'icon', source: { kind: 'icon', childIndex: 0 } },
        { argument: 'content', source: { kind: 'content' } },
      ],
    },
  ],
};

test('parseMappingProfile accepts a valid profile', () => {
  const { profile, diagnostics } = parseMappingProfile(validProfileJson);
  assert.notEqual(profile, null);
  assert.equal(diagnostics.length, 0);
  assert.equal(profile!.schemaVersion, 1);
  assert.equal(profile!.colors.length, 3);
  assert.equal(profile!.components[0]!.target.symbol, 'AppButton');
});

test('parseMappingProfile rejects wrong schema version and malformed entries', () => {
  const bad = { ...validProfileJson, schemaVersion: 2 };
  let result = parseMappingProfile(bad);
  assert.equal(result.profile, null);
  assert.equal(result.diagnostics[0]!.level, 'ERROR');

  result = parseMappingProfile({
    ...validProfileJson,
    colors: [{ source: { kind: 'hex', name: 'green' }, target: 'x' }],
  });
  assert.equal(result.diagnostics.some((d) => d.path.startsWith('colors[0]')), true);

  result = parseMappingProfile({
    ...validProfileJson,
    components: [{
      source: { kind: 'component', componentName: 'B' },
      target: { symbol: 'not valid symbol!' },
      arguments: [],
    }],
  });
  assert.equal(result.diagnostics.some((d) => d.message.includes('not a valid Kotlin identifier')), true);
});

test('parseMappingProfile flags duplicate argument names once', () => {
  const result = parseMappingProfile({
    ...validProfileJson,
    components: [{
      source: { kind: 'component', componentName: 'Button' },
      target: { symbol: 'AppButton' },
      arguments: [
        { argument: 'x', source: { kind: 'constant', value: '1' } },
        { argument: 'x', source: { kind: 'constant', value: '2' } },
      ],
    }],
  });
  assert.equal(result.diagnostics.filter((d) => d.message.includes("Duplicate argument name 'x'")).length, 1);
});

test('constant profile sources accept an optional typed dataType (and reject junk)', () => {
  const withTypes = parseMappingProfile({
    ...validProfileJson,
    components: [{
      source: { kind: 'component', componentName: 'Badge' },
      target: { symbol: 'AppBadge' },
      arguments: [
        { argument: 'count', source: { kind: 'constant', value: '2', dataType: 'int' } },
        { argument: 'pad', source: { kind: 'constant', value: '16', dataType: 'dp' } },
      ],
    }],
  });
  assert.equal(withTypes.diagnostics.length, 0);
  const args = withTypes.profile!.components[0]!.arguments;
  assert.deepEqual(args[0]!.source, { kind: 'constant', value: '2', dataType: 'int' });
  assert.deepEqual(args[1]!.source, { kind: 'constant', value: '16', dataType: 'dp' });
  // A value-less datatype tag or an unknown one is an ERROR (strict JSON):
  // the argument is skipped, the rest of the profile still parses.
  const bad = parseMappingProfile({
    ...validProfileJson,
    components: [{
      source: { kind: 'component', componentName: 'Badge' },
      target: { symbol: 'AppBadge' },
      arguments: [{ argument: 'x', source: { kind: 'constant', value: '2', dataType: 'bigint' } }],
    }],
  });
  assert.notEqual(bad.profile, null, 'one bad argument does not nuke the profile');
  assert.equal(bad.diagnostics[0]!.level, 'ERROR');
  assert.equal(bad.diagnostics[0]!.path.endsWith('arguments[0].source.dataType'), true);
  assert.equal(bad.profile!.components[0]!.arguments.length, 0, 'the typed argument with a junk tag is dropped');
  // Untyped constants stay valid.
  const legacy = parseMappingProfile({
    ...validProfileJson,
    components: [{
      source: { kind: 'component', componentName: 'Badge' },
      target: { symbol: 'AppBadge' },
      arguments: [{ argument: 'x', source: { kind: 'constant', value: '2' } }],
    }],
  });
  assert.equal(legacy.diagnostics.length, 0);
  assert.deepEqual(legacy.profile!.components[0]!.arguments[0]!.source, { kind: 'constant', value: '2' });
});

/* ----------------------------- resolution ----------------------------- */

const profile: MappingProfile = (parseMappingProfile(validProfileJson).profile)!;

test('color resolution follows documented precedence (id -> name -> hex)', () => {
  assert.deepEqual(resolveColorMapping(profile, { variableId: 'var:1' }), {
    target: 'AppTheme.colors.primary',
    precedence: 'variableId',
  });
  assert.deepEqual(resolveColorMapping(profile, { variableName: 'Color/Primary' }), {
    target: 'AppTheme.colors.primary',
    precedence: 'variableName',
  });
  assert.deepEqual(resolveColorMapping(profile, { hex: '#ff8040' }), {
    target: 'AppTheme.colors.accent',
    precedence: 'hex',
  });
  assert.equal(resolveColorMapping(profile, { hex: '#123456' }), null);
});

test('font and text style resolution', () => {
  assert.deepEqual(resolveFontMapping(profile, 'Roboto'), { target: 'FontFamily.SansSerif' });
  assert.equal(resolveFontMapping(profile, 'Open Sans'), null);
  assert.deepEqual(resolveTextMapping(profile, { fontFamily: 'Roboto', fontSize: 14 }), {
    target: 'MaterialTheme.typography.bodyMedium',
  });
  // Documented precedence: family-only fallback when the exact size misses.
  assert.deepEqual(resolveTextMapping(profile, { fontFamily: 'Roboto', fontSize: 99 }), {
    target: 'MaterialTheme.typography.bodyMedium',
  });
});

test('component resolution: exact name first, then nodeType', () => {
  const byName = resolveComponentMapping(profile, { componentName: 'button' });
  assert.equal(byName!.target.symbol, 'AppButton');
  const byType = resolveComponentMapping(profile, { nodeType: 'TEXT' });
  assert.equal(byType, null);
});

test('verifyComponentMapping previews argument values and flags issues', () => {
  const mapping = profile.components[0]!;
  const report = verifyComponentMapping(mapping, { texts: ['Sign in'], iconCount: 1 });
  assert.deepEqual(report.previewArguments, [
    ['text', 'Sign in'],
    ['icon', 'R.drawable.ic_res_0'],
    ['content', 'content'],
  ]);
  const broken = verifyComponentMapping(mapping, { texts: [], iconCount: 0 });
  assert.equal(broken.problems.some((p) => p.includes("text source for 'text'")), true);
  assert.equal(broken.problems.some((p) => p.includes("icon source index 0 is out of range")), true);
});

test('mappingSummary renders source and arguments', () => {
  assert.equal(mappingSummary(profile.components[0]!), "component 'Button' -> AppButton(text:text, icon:icon, content:content)");
});

test('emptyProfile yields an inert default', () => {
  const p = emptyProfile();
  assert.equal(resolveColorMapping(p, { hex: '#000000' }), null);
  assert.equal(resolveComponentMapping(p, { nodeType: 'TEXT' }), null);
});
