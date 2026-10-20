/**
 * Tests for user curation: ignore rules (prefix + exact marks), asset-skip
 * marks and the curated asset library (asset-page harvest).
 *
 * Covers the shared matching module, the asset registry integration, the
 * extractor's ignore gate and the generator's library emission paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesIgnorePrefix, matchesMark, markId, type LibraryAsset, type NodeMark } from '../src/shared/marks.ts';
import { AssetRegistry, type AssetCandidateExtra } from '../src/gen/assets.ts';
import { Extractor } from '../src/extract/extract.ts';
import type { InstanceComponentInfo } from '../src/extract/figma-types.ts';
import { generateCode, type GenerationOptions } from '../src/gen/generate.ts';
import type { MappingProfile } from '../src/mapping/profile.ts';
import { parseMappingProfile } from '../src/mapping/profile.ts';
import { frameNode, instanceNode, rectNode, testContext, textNode, vectorNode } from './fixtures.ts';
import { withChildren } from './ir-narrow.ts';

/* ---------------------------------------------------------------------------
 * Harness pieces mirroring main.ts wiring
 * ------------------------------------------------------------------------- */

/** Ignore matcher exactly like the sandbox one: prefix + exact marks. */
function ignoreLookup(prefix: string, marks: NodeMark[]) {
  return (candidate: Parameters<typeof matchesIgnorePrefix>[1]) => {
    if (matchesIgnorePrefix(prefix, candidate)) return true;
    return marks.some((mark) => matchesMark(mark, candidate));
  };
}

function ignoreContext(prefix: string, marks: NodeMark[]) {
  return { ...testContext(), nodeMarkLookup: ignoreLookup(prefix, marks) };
}

function libraryLibraryEntry(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    key: 'ic_star',
    kind: 'svg',
    fuid: 'asset:1',
    pageId: 'page:icons',
    nodeName: 'icon_star',
    fType: 'COMPONENT',
    width: null,
    height: null,
    masterId: null,
    imageHash: null,
    ...overrides,
  };
}

function run(
  root: ReturnType<typeof frameNode>,
  extra: Partial<GenerationOptions> = {},
  componentRecords?: Record<string, InstanceComponentInfo | null>,
) {
  const context = {
    ...testContext(),
    instanceComponentLookup: componentRecords ? (id: string) => componentRecords[id] ?? null : undefined,
  };
  const doc = new Extractor(context).extractRoot(root);
  assert.notEqual(doc, null);
  const options: GenerationOptions = { packageName: 'com.example.app', profile: null as MappingProfile | null, ...extra };
  return generateCode([doc!], options);
}

/* ---------------------------------------------------------------------------
 * shared/marks.ts matching semantics
 * ------------------------------------------------------------------------- */

test('component marks match instances by exact master id, ignoring name collisions', () => {
  const mark: NodeMark = { id: 'm1', name: 'Status Bar', fType: 'COMPONENT', width: 360, height: 44, masterId: 'comp:status' };
  assert.equal(matchesMark(mark, { name: 'Status Bar', fType: 'INSTANCE', width: 360, height: 44, masterId: 'comp:status' }), true);
  // Same name, different component identity: never matches (name-collision guard).
  assert.equal(matchesMark(mark, { name: 'Status Bar', fType: 'INSTANCE', width: 360, height: 44, masterId: 'comp:other' }), false);
  // Plain node with the same name: component marks never cover it.
  assert.equal(matchesMark(mark, { name: 'Status Bar', fType: 'FRAME', width: 360, height: 44, masterId: null }), false);
});

test('plain marks match by name + type + size (with sub-pixel tolerance)', () => {
  const mark: NodeMark = { id: 'm2', name: 'Status Bar', fType: 'FRAME', width: 360, height: 44, masterId: null };
  assert.equal(matchesMark(mark, { name: 'status bar', fType: 'Frame', width: 360.4, height: 43.6, masterId: null }), true);
  assert.equal(matchesMark(mark, { name: 'Status Bar', fType: 'FRAME', width: 200, height: 44, masterId: null }), false);
  assert.equal(matchesMark(mark, { name: 'Status Bar', fType: 'GROUP', width: 360, height: 44, masterId: null }), false);
  // Marks without captured size are name-only (nodes without geometry).
  const sizeless: NodeMark = { id: 'm3', name: 'Divider', fType: 'LINE', width: null, height: null, masterId: null };
  assert.equal(matchesMark(sizeless, { name: 'Divider', fType: 'LINE', width: null, height: null, masterId: null }), true);
  assert.equal(matchesMark(sizeless, { name: 'Divider', fType: 'LINE', width: 10, height: null, masterId: null }), true);
});

test('markId is deterministic and encodes identity fields', () => {
  assert.equal(markId('A', 'FRAME', null, 10, 20), '|FRAME|A|10|20');
  assert.equal(markId('A', 'FRAME', 'c1', null, null), 'c1|FRAME|A||');
});

test('ignore prefix matching is case-insensitive and trims the candidate name', () => {
  assert.equal(matchesIgnorePrefix('_ignore', { name: '  _Ignore Status Bar', fType: 'FRAME', width: null, height: null, masterId: null }), true);
  assert.equal(matchesIgnorePrefix('_ignore', { name: 'Status Bar', fType: 'FRAME', width: null, height: null, masterId: null }), false);
  assert.equal(matchesIgnorePrefix('', { name: 'anything', fType: 'FRAME', width: null, height: null, masterId: null }), false);
});

/* ---------------------------------------------------------------------------
 * AssetRegistry: skip marks + curated library
 * ------------------------------------------------------------------------- */

test('asset-skip marks exclude matching nodes with a distinct reason', () => {
  const registry = new AssetRegistry({ icon: null });
  registry.seedAssetSkips([{ id: 's1', name: 'Wing', fType: 'VECTOR', width: 24, height: 24, masterId: null }]);
  const name = registry.add(
    'svg',
    { fuid: 'v1', nodeName: 'Wing', fType: 'VECTOR' },
    undefined,
    undefined,
    { size: { width: 24, height: 24 } },
  );
  assert.equal(name, null);
  assert.match(registry.exclusionReason(), /asset-skip list/);
  // Other vectors are unaffected.
  assert.equal(registry.add('svg', { fuid: 'v2', nodeName: 'Fin', fType: 'VECTOR' }), 'ic_fin');
});

test('library entries win over an unfavorable prefix and export the canonical source', () => {
  const registry = new AssetRegistry({ icon: 'ic_' });
  registry.seedLibrary([
    libraryLibraryEntry({ key: 'logo_mark', fuid: 'asset:9', pageId: 'page:brand', nodeName: 'Logo Mark', fType: 'FRAME', masterId: null }),
  ]);
  const name = registry.add('svg', { fuid: 'v1', nodeName: 'Logo Mark', fType: 'FRAME' }, undefined, undefined, {
    size: { width: 150, height: 40 },
  });
  assert.equal(name, 'logo_mark');
  const asset = registry.list().find((a) => a.name === 'logo_mark')!;
  assert.equal(asset.source.fuid, 'asset:9');
  assert.equal(asset.source.nodeName, 'Logo Mark');
  assert.equal(asset.meta?.libraryPageId, 'page:brand');
  assert.equal(asset.meta?.localFuid, 'v1');
  // A successful registration records no rejection.
  assert.equal(registry.rejectionReason, null);
});

test('library matching is strict about node type and entries with master ids only match that master', () => {
  const registry = new AssetRegistry({ icon: null });
  registry.seedLibrary([
    libraryLibraryEntry({ key: 'ic_star', fuid: 'asset:2', pageId: 'page:icons', nodeName: 'Star', fType: 'COMPONENT', masterId: 'comp:star' }),
  ]);
  // A same-named plain vector is NOT the curated component asset; it falls
  // through to the normal auto-detected path.
  const plain = registry.add('svg', { fuid: 'v1', nodeName: 'Star', fType: 'VECTOR' }, undefined, undefined, {
    size: { width: 24, height: 24 },
  });
  assert.equal(plain, 'ic_star'); // auto-detected name, different key
  const asset = registry.list().find((a) => a.name === 'ic_star')!;
  assert.equal(asset.source.fuid, 'v1'); // the local node, not the library source
});

test('library PNG entries carry the canonical image hash', () => {
  const registry = new AssetRegistry({ image: null });
  registry.seedLibrary([
    libraryLibraryEntry({
      key: 'hero_banner',
      kind: 'png',
      fuid: 'asset:5',
      pageId: 'page:photos',
      nodeName: 'Banner',
      fType: 'RECTANGLE',
      width: 800,
      height: 600,
      imageHash: 'canonical:hash',
    }),
  ]);
  const name = registry.add(
    'png',
    { fuid: 'r1', nodeName: 'Banner', fType: 'RECTANGLE' },
    undefined,
    { imageHash: 'local:hash' },
    { size: { width: 800, height: 600 } },
  );
  assert.equal(name, 'hero_banner');
  const asset = registry.list().find((a) => a.name === 'hero_banner')!;
  assert.equal(asset.meta?.imageHash, 'canonical:hash');
  assert.equal(asset.meta?.localFuid, 'r1');
});

test('libraryMatch only fires for curated entries, never auto-detects', () => {
  const registry = new AssetRegistry({ icon: null });
  registry.seedLibrary([
    libraryLibraryEntry({ key: 'ic_save', fuid: 'asset:7', pageId: 'page:icons', nodeName: 'Save', fType: 'COMPONENT', masterId: 'comp:save' }),
  ]);
  const extra: AssetCandidateExtra = { size: { width: 120, height: 48 }, masterId: 'comp:save' };
  assert.equal(registry.libraryMatch('svg', { fuid: 'i1', nodeName: 'Save', fType: 'INSTANCE' }, extra), 'ic_save');
  // An instance of an unmarked component stays unmarked (null), preserving
  // the legacy expansion path even though add() in auto-detect succeeds.
  assert.equal(
    registry.libraryMatch('svg', { fuid: 'i2', nodeName: 'Other', fType: 'INSTANCE' }, { size: { width: 120, height: 48 }, masterId: 'comp:other' }),
    null,
  );
});

/* ---------------------------------------------------------------------------
 * Extractor: ignore rules
 * ------------------------------------------------------------------------- */

test('ignore prefix skips the whole subtree and reports NODE-IGNORED', () => {
  const root = frameNode('root', 'Root', {}, [
    frameNode('status', '_ignore Status Bar', {}, [vectorNode('s1', 'Signal', { fills: [] })]),
    textNode('t1', 'Title', { characters: 'Hello' }),
  ]);
  const doc = new Extractor(ignoreContext('_ignore', [])).extractRoot(root);
  assert.notEqual(doc, null);
  assert.deepEqual(withChildren(doc!.root).children.map((c) => c.type), ['text']);
  const diag = doc!.diagnostics.find((d) => d.code === 'NODE-IGNORED')!;
  assert.notEqual(diag, undefined);
  assert.match(diag.reason, /_ignore Status Bar/);
});

test('marked nodes are skipped; unmatched same-name nodes with other sizes survive', () => {
  const mark: NodeMark = { id: 'mk', name: 'Side Panel', fType: 'FRAME', width: 200, height: 300, masterId: null };
  const root = frameNode('root', 'Root', {}, [
    frameNode('p1', 'Side Panel', { width: 200, height: 300 }, [textNode('hidden', 'Ghost', { characters: 'x' })]),
    frameNode('p2', 'Side Panel', { width: 200, height: 44 }, [textNode('kept', 'Tag', { characters: 'keep me' })]),
  ]);
  const doc = new Extractor(ignoreContext('', [mark])).extractRoot(root);
  assert.notEqual(doc, null);
  const children = withChildren(doc!.root).children;
  assert.equal(children.length, 1);
  const texts = doc!.diagnostics.filter((d) => d.code === 'NODE-IGNORED');
  assert.equal(texts.length, 1);
  // The surviving child is the size-different frame with its text intact.
  const kept = children[0]!;
  assert.deepEqual(withChildren(kept).children.map((c) => c.type), ['text']);
});

test('instances match component marks by master identity', () => {
  const mark: NodeMark = { id: 'mc', name: 'Button', fType: 'COMPONENT', width: null, height: null, masterId: 'comp:1' };
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'Button A', { mainComponent: { name: 'Button', id: 'comp:1' }, width: 200, height: 56 }, [
      textNode('b1', 'Label', { characters: 'ignored text' }),
    ]),
    instanceNode('i2', 'Button B', { mainComponent: { name: 'Button', id: 'comp:other' }, x: 0, y: 80, width: 200, height: 56 }, []),
  ]);
  const doc = new Extractor(ignoreContext('', [mark])).extractRoot(root);
  assert.notEqual(doc, null);
  const children = withChildren(doc!.root).children;
  // The master-marked instance (and its children) are gone; the other master stays.
  assert.deepEqual(children.map((c) => c.ref.nodeName), ['Button B']);
});

/* ---------------------------------------------------------------------------
 * Generator: library assets and asset-skip marks
 * ------------------------------------------------------------------------- */

test('a vector matching a curated name entry exports the canonical library asset', () => {
  const root = frameNode('root', 'Root', {}, [vectorNode('v1', 'Star', { fills: [] })]);
  const result = run(root, {
    assetLibrary: [
      libraryLibraryEntry({ key: 'ic_star', fuid: 'asset:1', pageId: 'page:icons', nodeName: 'Star', fType: 'VECTOR', width: 24, height: 24 }),
    ],
  });
  assert.deepEqual(
    result.assets.map((a) => ({ name: a.name, fuid: a.source.fuid, pageId: a.meta?.libraryPageId, localFuid: a.meta?.localFuid })),
    [{ name: 'ic_star', fuid: 'asset:1', pageId: 'page:icons', localFuid: 'v1' }],
  );
  const code = result.files[0]!.content;
  assert.match(code, /Image\(/);
  assert.match(code, /painterResource\(R\.drawable\.ic_star\)/);
});

test('a vector matching the library still renders when the configured prefix would exclude it', () => {
  const root = frameNode('root', 'Root', {}, [vectorNode('v1', 'Star', { fills: [] })]);
  const result = run(root, {
    iconAssetPrefix: 'ic_',
    assetLibrary: [
      libraryLibraryEntry({ key: 'star_badge', fuid: 'asset:1', pageId: 'page:icons', nodeName: 'Star', fType: 'VECTOR', width: 24, height: 24 }),
    ],
  });
  assert.deepEqual(result.assets.map((a) => a.name), ['star_badge']);
  assert.equal(result.diagnostics.some((d) => d.code === 'ASSET-EXCLUDED'), false);
});

test('an asset-skip-marked image fill keeps its layout and exports no asset', () => {
  const root = frameNode('root', 'Root', {}, [
    rectNode('r1', 'Hero', { fills: [{ type: 'IMAGE', imageHash: 'h1', scaleMode: 'FILL', visible: true }] }),
    rectNode('r2', 'Other Image', { x: 0, y: 100, fills: [{ type: 'IMAGE', imageHash: 'h2', scaleMode: 'FILL', visible: true }] }),
  ]);
  const result = run(root, {
    assetSkipMarks: [{ id: 's', name: 'Hero', fType: 'RECTANGLE', width: 40, height: 40, masterId: null }],
  });
  assert.deepEqual(result.assets.map((a) => a.name), ['img_other_image']);
  const diag = result.diagnostics.find((d) => d.code === 'ASSET-EXCLUDED')!;
  assert.notEqual(diag, undefined);
  assert.match(diag.message, /asset-skip list/);
});

test('instances of a curated component render as Image instead of expanded layout', () => {
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('i1', 'Save', { mainComponent: { name: 'Save', id: 'comp:save' }, width: 120, height: 48 }, [
      textNode('lbl', 'Label', { characters: 'expanded text' }),
    ]),
  ]);
  const result = run(root, {
    assetLibrary: [
      libraryLibraryEntry({ key: 'ic_save', fuid: 'asset:7', pageId: 'page:icons', nodeName: 'Save', fType: 'COMPONENT', masterId: 'comp:save' }),
    ],
  });
  const code = result.files[0]!.content;
  // Not expanded: no Text of the instance subtree, but an Image call.
  assert.match(code, /painterResource\(R\.drawable\.ic_save\)/);
  assert.doesNotMatch(code, /expanded text/);
  const asset = result.assets.find((a) => a.name === 'ic_save')!;
  assert.notEqual(asset, undefined);
  assert.equal(asset.source.fuid, 'asset:7');
  assert.equal(asset.meta?.localFuid, 'i1');
});

test('unmarked instances keep the exact legacy auto-component behavior', () => {
  // Regression guard for the instance library path: without a library the
  // instance expands as before (byte-identical behavior, no Image call).
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('i1', 'Save', { mainComponent: { name: 'Button', id: 'comp:1' }, width: 120, height: 48 }, [
      textNode('lbl', 'Label', { characters: 'Save' }),
    ]),
  ]);
  const result = run(root);
  const code = result.files[0]!.content;
  assert.doesNotMatch(code, /painterResource/);
  assert.match(code, /Text\(/);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-UNMAPPED'), true);
});

test('curated component groups skip auto-component generation (no dead files)', () => {
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('i1', 'Save Primary', { mainComponent: { name: 'Size=Large', id: 'comp:save-l' }, variantProperties: { Size: 'Large' }, width: 120, height: 48 }, []),
    instanceNode('i2', 'Save Small', { mainComponent: { name: 'Size=Small', id: 'comp:save-s' }, variantProperties: { Size: 'Small' }, x: 0, y: 60, width: 80, height: 32 }, [
      textNode('b1', 'Label', { characters: 'expanded' }),
    ]),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    i1: { name: 'Size=Large', id: 'comp:save-l', set: { id: 'set:save', name: 'Save' } },
    i2: { name: 'Size=Small', id: 'comp:save-s', set: { id: 'set:save', name: 'Save' } },
  };
  const result = run(root, {
    assetLibrary: [
      libraryLibraryEntry({ key: 'ic_save_large', fuid: 'asset:7', pageId: 'page:icons', nodeName: 'Size=Large', fType: 'COMPONENT', masterId: 'comp:save-l' }),
      libraryLibraryEntry({ key: 'ic_save_small', fuid: 'asset:8', pageId: 'page:icons', nodeName: 'Size=Small', fType: 'COMPONENT', masterId: 'comp:save-s' }),
    ],
  }, records);
  // No auto component file: both instances render as curated Images.
  assert.deepEqual(result.files.map((f) => f.path), ['RootScreen.kt']);
  const code = result.files[0]!.content;
  assert.match(code, /painterResource\(R\.drawable\.ic_save_large\)/);
  assert.match(code, /painterResource\(R\.drawable\.ic_save_small\)/);
  assert.doesNotMatch(code, /expanded/);
  assert.deepEqual(result.assets.map((a) => a.name), ['ic_save_large', 'ic_save_small']);
});

test('profile mappings still win over curated library assets', () => {
  const parsed = parseMappingProfile({
    schemaVersion: 1,
    profileName: 'p',
    colors: [],
    fonts: [],
    textStyles: [],
    components: [
      {
        source: { kind: 'component', componentName: 'Save' },
        target: { symbol: 'SaveButton' },
        arguments: [{ argument: 'modifier', source: { kind: 'modifier' } }],
      },
    ],
  });
  assert.equal(parsed.diagnostics.length, 0);
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('i1', 'Save', { mainComponent: { name: 'Save', id: 'comp:save' }, width: 120, height: 48 }, []),
  ]);
  const result = run(root, {
    profile: parsed.profile!,
    assetLibrary: [
      libraryLibraryEntry({ key: 'ic_save', fuid: 'asset:7', pageId: 'page:icons', nodeName: 'Save', fType: 'COMPONENT', masterId: 'comp:save' }),
    ],
  });
  const code = result.files[0]!.content;
  assert.match(code, /SaveButton\(/);
  assert.doesNotMatch(code, /painterResource/);
  assert.equal(result.assets.length, 0);
});
