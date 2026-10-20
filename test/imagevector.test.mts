import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIconsFile,
  imageVectorSymbol,
  parsePathData,
  svgToImageVector,
} from '../src/gen/imagevector.ts';
import { AssetRegistry, resolveAssetFormat, type ExportFormats } from '../src/gen/assets.ts';
import { generateCode, type GenerationOptions } from '../src/gen/generate.ts';
import { sniffImageExt } from '../src/util/images.ts';
import { Extractor } from '../src/extract/extract.ts';
import type { InstanceComponentInfo } from '../src/extract/figma-types.ts';
import type { LibraryAsset } from '../src/shared/marks.ts';
import { frameNode, instanceNode, rectNode, testContext, vectorNode } from './fixtures.ts';

/* ---------------------------------------------------------------------------
 * path data -> absolute cubics
 * ------------------------------------------------------------------------- */

test('relative M/H/V resolve against the advancing cursor', () => {
  const warn = new Set<string>();
  const cmds = parsePathData('M1 2 m4 0 h2 v3 H20 z', warn);
  assert.deepEqual([...warn], []);
  // M(1,2) -> m(+4,0)=M(5,2) -> h(+2)=(7,2) -> v(+3)=(7,5) -> H(abs 20)=(20,5) -> z
  const points = cmds
    .filter((c) => c.op === 'M' || c.op === 'L')
    .map((c) => [c!.x, c!.y]);
  assert.deepEqual(points, [
    [1, 2],
    [5, 2],
    [7, 2],
    [7, 5],
    [20, 5],
  ]);
  assert.equal(cmds[cmds.length - 1]!.op, 'Z');
});

test('quadratic (q) becomes the exact equivalent cubic', () => {
  const warn = new Set<string>();
  const cmds = parsePathData('M0 0 q2 2 4 0', warn);
  assert.deepEqual([...warn], []);
  const q = cmds[1]!;
  assert.equal(q.op, 'C');
  if (q.op === 'C') {
    // Control points sit at 1/3 and 2/3 along the quadratic tangents.
    assert.equal(q.x1, 4 / 3);
    assert.equal(q.y1, 4 / 3);
    assert.equal(q.x2, 8 / 3);
    assert.equal(q.y2, 4 / 3);
    assert.equal(q.x, 4);
    assert.equal(q.y, 0);
  }
});

test('a full circle made of two semicircular arcs is four exact 90-degree cubics', () => {
  const warn = new Set<string>();
  // Circle centered (5,5), r=4: starts left, sweeps through (5,9), (9,5), (5,1) and closes.
  const cmds = parsePathData('M1 5a4 4 0 1 0 8 0a4 4 0 1 0 -8 0Z', warn);
  assert.deepEqual([...warn], []);
  assert.equal(cmds[0]!.op, 'M');
  assert.equal(cmds[cmds.length - 1]!.op, 'Z');
  const cubics = cmds.filter((c) => c.op === 'C');
  assert.equal(cubics.length, 4);
  // The kappa standard: control offset = 4/3*tan(delta/4) * r (delta = 90deg).
  const kappa = (4 / 3) * Math.tan(Math.PI / 8) * 4; // 2.2091
  let start = { x: 1, y: 5 };
  for (const c of cubics) {
    assert.ok(c.op === 'C');
    if (c.op !== 'C') continue;
    // c1 sits kappa away from the segment start along an axis-aligned tangent;
    // c2 the same from the segment end.
    const fromStart =
      Math.abs(Math.abs(c.x1 - start.x) - kappa) < 1e-3 || Math.abs(Math.abs(c.y1 - start.y) - kappa) < 1e-3;
    const fromEnd =
      Math.abs(Math.abs(c.x2 - c.x) - kappa) < 1e-3 || Math.abs(Math.abs(c.y2 - c.y) - kappa) < 1e-3;
    assert.ok(fromStart, `control 1 off tangent at ${start.x},${start.y}`);
    assert.ok(fromEnd, `control 2 off tangent at ${c.x},${c.y}`);
    start = { x: c.x, y: c.y };
  }
  assert.deepEqual(
    cubics.map((c) => (c.op === 'C' ? [Math.round(c.x), Math.round(c.y)] : [0, 0])),
    [[5, 9], [9, 5], [5, 1], [1, 5]],
  );
});

test('transform attributes bake into coordinates (rotate, matrix)', () => {
  // rotate(90): (x, y) -> (-y, x).
  const rotated = svgToImageVector(
    '<svg viewBox="0 0 24 24"><g transform="rotate(90)"><rect x="2" y="3" width="4" height="2"/></g></svg>',
    'rect_rot',
    'pkg',
  );
  assert.deepEqual(rotated.warnings, []);
  assert.match(rotated.kotlin, /moveTo\(-3\.0f, 2\.0f\)/);
  // matrix(1,1,0,1,0,0) is a supported affine shear: (x, y) -> (x, x + y).
  const sheared = svgToImageVector(
    '<svg viewBox="0 0 10 10"><g transform="matrix(1, 1, 0, 1, 0, 0)"><path d="M0 0h2v2H0Z"/></g></svg>',
    'sheared',
    'pkg',
  );
  assert.deepEqual(sheared.warnings, []);
  assert.match(sheared.kotlin, /moveTo\(0\.0f, 0\.0f\)/);
  assert.match(sheared.kotlin, /lineTo\(2\.0f, 2\.0f\)/); // (2,0) -> (2,2)
  assert.match(sheared.kotlin, /lineTo\(2\.0f, 4\.0f\)/); // (2,2) -> (2,4)
});

/* ---------------------------------------------------------------------------
 * total-converter guarantees
 * ------------------------------------------------------------------------- */

test('unrepresentable SVG pieces are skipped with warnings, never silently', () => {
  const svg =
    '<svg viewBox="0 0 24 24"><image href="x.png"/><text>hi</text>' +
    '<path fill="url(#grad)" d="M0 0h4v4H0Z"/><path clip-path="url(#c)" d="M6 6h4v4H6Z"/></svg>';
  const result = svgToImageVector(svg, 'ic_mixed', 'pkg');
  assert.ok(result.warnings.includes('<image> elements cannot be represented in ImageVector (skipped)'));
  assert.ok(result.warnings.includes('<text> elements cannot be represented in ImageVector (skipped)'));
  assert.ok(
    result.warnings.includes('gradient / pattern fills are not representable in ImageVector (approximated with a solid color)'),
  );
  assert.ok(result.warnings.includes('clip-path / mask is ignored (the full shape is kept)'));
  // Comments carry every warning into the file itself.
  assert.match(result.kotlin, /skipped: <image> elements cannot be represented/);
  assert.match(result.kotlin, /skipped: gradient \/ pattern fills/);
  // The shape under a clip survives — clipping is ignored, not the shape.
  assert.match(result.kotlin, /moveTo\(6\.0f, 6\.0f\)/);
});

test('garbage input still emits a compiling val (total function)', () => {
  const result = svgToImageVector('<div>not svg at all</div>', 'ic_broken', 'com.example');
  assert.match(result.kotlin, /public val IcBroken: ImageVector =/);
  assert.ok(result.warnings.includes('the export produced no <svg> element'));
  assert.match(result.kotlin, /no drawable geometry could be resolved/);
});

test('colors parse exactly and fill-opacity is baked into the Color literal', () => {
  const result = svgToImageVector(
    '<svg viewBox="0 0 4 4"><path d="M0 0h4v4H0Z" fill="#1E88E5"/><path d="M0 0h1v1H0Z" fill="#ff0000" fill-opacity="0.5"/></svg>',
    'colors',
    'pkg',
  );
  assert.match(result.kotlin, /Color\(0xFF1E88E5\)/);
  // 0.5 opacity -> 0x80 alpha channel, exactly once (never a fillAlpha multiplier too).
  assert.match(result.kotlin, /Color\(0x80FF0000\)/);
  assert.doesNotMatch(result.kotlin, /fillAlpha/);
});

test('evenodd fills and stroke attributes emit their builder params', () => {
  const result = svgToImageVector(
    '<svg viewBox="0 0 10 10"><path fill-rule="evenodd" d="M0 0h10v10H0Z" fill="#111"/>' +
      '<line x1="1" y1="2" x2="8" y2="6" stroke="#ff5252" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="bevel" stroke-opacity="0.8"/></svg>',
    'strokey',
    'pkg',
  );
  assert.match(result.kotlin, /pathFillType = PathFillType\.EvenOdd/);
  assert.match(result.kotlin, /strokeLineWidth = 2\.5f/);
  assert.match(result.kotlin, /strokeLineCap = StrokeCap\.Round/);
  assert.match(result.kotlin, /strokeLineJoin = StrokeJoin\.Bevel/);
  assert.doesNotMatch(result.kotlin, /strokeAlpha/);
  // SVG default: a stroked shape with no fill attribute is filled black;
  // stroke-opacity 0.8 bakes into the color as 0xCC, exactly once.
  assert.match(result.kotlin, /fill = SolidColor\(Color\(0xFF000000\)\), stroke = SolidColor\(Color\(0xCCFF5252\)\)/);
});

test('output is deterministic and structure-complete', () => {
  const svg = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2L22 12L12 22L2 12Z" fill="#7F52FF"/></svg>';
  const a = svgToImageVector(svg, 'ic_diamond', 'com.example.app').kotlin;
  const b = svgToImageVector(svg, 'ic_diamond', 'com.example.app').kotlin;
  assert.equal(a, b);
  assert.match(a, /^package com\.example\.app\n/);
  assert.match(a, /import androidx\.compose\.ui\.graphics\.Color/);
  const imports = a.split('\n').filter((l) => l.startsWith('import '));
  assert.deepEqual(imports, [...imports].sort((x, y) => x.localeCompare(y, 'en')));
  assert.match(a, /public val IcDiamond: ImageVector =/);
  assert.match(a, /viewportWidth = 24\.0f,/);
});

test('imageVectorSymbol derives a stable, legal Kotlin identifier', () => {
  assert.equal(imageVectorSymbol('ic_star'), 'IcStar');
  assert.equal(imageVectorSymbol('  ICON_HOME_PAGE '), 'IconHomePage');
  const digit = imageVectorSymbol('9g');
  assert.match(digit, /^[A-Za-z]/);
  assert.equal(imageVectorSymbol('9g'), imageVectorSymbol('9g'));
});

/* ---------------------------------------------------------------------------
 * merged Icons.kt
 * ------------------------------------------------------------------------- */

test('buildIconsFile merges vals under one package with unioned imports', () => {
  const merged = buildIconsFile(
    [
      { assetName: 'ic_star', svg: '<svg viewBox="0 0 24 24"><path d="M0 0h1v1H0Z" fill="#111111"/></svg>' },
      {
        assetName: 'ic_arrow',
        svg: '<svg viewBox="0 0 24 24"><path d="M0 0h1v1H0Z" fill="#222222" fill-rule="evenodd"/></svg>',
      },
    ],
    'com.example.app',
  );
  assert.match(merged.content, /^package com\.example\.app\n/);
  assert.equal(merged.content.match(/^package /gm)!.length, 1);
  assert.match(merged.content, /public val IcStar: ImageVector =/);
  assert.match(merged.content, /public val IcArrow: ImageVector =/);
  const imports = merged.content.split('\n').filter((l) => l.startsWith('import '));
  assert.equal(imports.length, imports.filter((v, i, arr) => arr.indexOf(v) === i).length);
  assert.ok(imports.some((l) => l.includes('PathFillType')));
  assert.equal(merged.content.split('\n').filter((l) => l.startsWith('// Generated by')).length, 2);

  // No vector uses the format -> empty string, no file at all.
  assert.deepEqual(buildIconsFile([], 'pkg').content, '');
});

/* ---------------------------------------------------------------------------
 * asset formats: resolution + gate
 * ------------------------------------------------------------------------- */

const FORMATS: ExportFormats = { exportAssets: true, vectorFormat: 'svg', imageFormat: 'auto' };

function libEntry(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    key: 'ic_star',
    kind: 'svg',
    fuid: 'asset:1',
    pageId: 'page:icons',
    nodeName: 'Star',
    fType: 'COMPONENT',
    width: 24,
    height: 24,
    masterId: null,
    imageHash: null,
    ...overrides,
  };
}

test('resolveAssetFormat follows globals, then the per-entry override', () => {
  assert.equal(resolveAssetFormat('svg', libEntry(), FORMATS), 'svg');
  assert.equal(resolveAssetFormat('png', libEntry(), FORMATS), 'png');
  assert.equal(resolveAssetFormat('svg', libEntry(), { ...FORMATS, vectorFormat: 'imagevector' }), 'imagevector');
  assert.equal(resolveAssetFormat('png', libEntry(), { ...FORMATS, imageFormat: 'jpg' }), 'jpg');
  // Per-entry override beats the global, in both directions.
  assert.equal(resolveAssetFormat('svg', libEntry({ fmt: 'png' }), FORMATS), 'png');
  assert.equal(resolveAssetFormat('png', libEntry({ kind: 'png', fmt: 'png' }), { ...FORMATS, imageFormat: 'jpg' }), 'png');
  // Unknown override text falls through to the global default.
  assert.equal(resolveAssetFormat('png', libEntry({ kind: 'png', fmt: 'img' as 'png' }), FORMATS), 'png');
});

test('resolveAssetFormat rejects raster->vector overrides defensively', () => {
  // A raster source cannot become SVG/ImageVector code: fall back to global.
  assert.equal(resolveAssetFormat('png', libEntry({ kind: 'png', fmt: 'svg' }), FORMATS), 'png');
  assert.equal(resolveAssetFormat('png', libEntry({ kind: 'png', fmt: 'imagevector' }), FORMATS), 'png');
  // ...but jpg/png remain valid raster overrides.
  assert.equal(resolveAssetFormat('png', libEntry({ kind: 'png', fmt: 'jpg' }), FORMATS), 'jpg');
});

test('exportAssets=false excludes every candidate with a disabled reason', () => {
  const registry = new AssetRegistry({}, { exportAssets: false, vectorFormat: 'svg', imageFormat: 'auto' });
  assert.equal(registry.add('svg', { fuid: 'n1', nodeName: 'Star', fType: 'VECTOR' }, 'Star'), null);
  assert.match(registry.exclusionReason(), /asset export is disabled/);
  assert.equal(registry.add('png', { fuid: 'n2', nodeName: 'img_bg', fType: 'RECTANGLE' }, 'img_bg', { imageHash: 'h' }), null);
  assert.equal(registry.size(), 0);
  // Library seeding and matching stay intact; the gate stays first.
  registry.seedLibrary([libEntry()]);
  assert.equal(registry.libraryMatch('svg', { fuid: 'x', nodeName: 'Star', fType: 'COMPONENT' }), 'ic_star');
  assert.equal(registry.add('svg', { fuid: 'x', nodeName: 'Star', fType: 'COMPONENT' }), null);
});

test('formatOf resolves registered assets in every format', () => {
  const registry = new AssetRegistry({}, { exportAssets: true, vectorFormat: 'imagevector', imageFormat: 'auto' });
  assert.equal(registry.add('svg', { fuid: 'n1', nodeName: 'star', fType: 'VECTOR' }, 'star'), 'ic_star');
  assert.equal(registry.formatOf('ic_star'), 'imagevector');
  assert.equal(registry.formatOf('missing'), null);
});

/* ---------------------------------------------------------------------------
 * generation: reference emission per format
 * ------------------------------------------------------------------------- */

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
  const options: GenerationOptions = { packageName: 'com.example.app', profile: null, ...extra };
  return generateCode([doc!], options);
}

test('ImageVector format references the generated val instead of painterResource', () => {
  const root = frameNode('root', 'Root', {}, [vectorNode('v1', 'icon_star', { fills: [] })]);
  const result = run(root, { iconAssetPrefix: 'icon_', vectorFormat: 'imagevector', exportAssets: true, imageFormat: 'auto' });
  assert.equal(result.assets[0]!.fmt, 'imagevector');
  const code = result.files[0]!.content;
  assert.match(code, /Image\(\s*imageVector = IcStar/);
  assert.doesNotMatch(code, /painterResource/);
  assert.doesNotMatch(code, /import androidx\.compose\.ui\.res\.painterResource/);
});

test('SVG (default) and raster formats keep R.drawable references', () => {
  const svgRoot = frameNode('root', 'Root', {}, [vectorNode('v1', 'icon_star', { fills: [] })]);
  const svgResult = run(svgRoot, { iconAssetPrefix: 'icon_' });
  assert.equal(svgResult.assets[0]!.fmt, 'svg');
  assert.match(svgResult.files[0]!.content, /painter = painterResource\(R\.drawable\.ic_star\)/);

  const rasterRoot = frameNode('root2', 'Root2', {}, [vectorNode('v1', 'icon_star', { fills: [] })]);
  const rasterResult = run(rasterRoot, { iconAssetPrefix: 'icon_', vectorFormat: 'png' });
  assert.equal(rasterResult.assets[0]!.fmt, 'png');
  assert.match(rasterResult.files[0]!.content, /painter = painterResource\(R\.drawable\.ic_star\)/);
});

test('image fills resolve png by default and honor imageFormat=jpg', () => {
  const fill = () => ({ type: 'IMAGE', imageHash: 'h1', scaleMode: 'FILL', visible: true });
  const makeRoot = (id: string) =>
    frameNode(id, 'Root', {}, [rectNode('r1', 'Hero', { fills: [fill()] })]);
  const plain = run(makeRoot('root-a'), {});
  assert.equal(plain.assets[0]!.fmt, 'png');
  const withJpg = run(makeRoot('root-b'), { imageFormat: 'jpg', vectorFormat: 'svg', exportAssets: true });
  assert.equal(withJpg.assets[0]!.fmt, 'jpg');
});

test('a curated instance with an imagevector override references the val', () => {
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'Star', { mainComponent: { name: 'Star', id: 'comp:star' }, width: 24, height: 24 }, []),
  ]);
  const result = run(
    root,
    {
      assetLibrary: [
        libEntry({ key: 'ic_star', masterId: 'comp:star', fType: 'COMPONENT', nodeName: 'Star', fmt: 'imagevector' }),
      ],
    },
    { i1: { name: 'Star', id: 'comp:star', set: null } },
  );
  assert.deepEqual(result.assets.map((a) => a.fmt), ['imagevector']);
  assert.match(result.files[0]!.content, /Image\(\s*imageVector = IcStar/);
});

test('asset gate at generation level produces exclusion diagnostics with kept layout', () => {
  const root = frameNode('root', 'Root', {}, [
    vectorNode('v1', 'icon_star', { fills: [] }),
    rectNode('r1', 'Hero', { fills: [{ type: 'IMAGE', imageHash: 'h1', scaleMode: 'FILL', visible: true }] }),
  ]);
  const result = run(root, { exportAssets: false });
  assert.equal(result.assets.length, 0);
  const excluded = result.diagnostics.filter((d) => d.code === 'ASSET-EXCLUDED');
  assert.ok(excluded.some((d) => /asset export is disabled/.test(d.message)), 'vector exclusion explains the gate');
  // The nodes still emit their geometry with an empty placeholder box.
  assert.match(result.files[0]!.content, /Box\(/);
});

/* ---------------------------------------------------------------------------
 * byte extension sniffing
 * ------------------------------------------------------------------------- */

test('sniffImageExt reads magic bytes and defaults to png', () => {
  assert.equal(sniffImageExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(sniffImageExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  // WebP/RIFF (or anything else) can be re-encoded to png losslessly.
  assert.equal(sniffImageExt(new Uint8Array([0x52, 0x49, 0x46, 0x46])), 'png');
  assert.equal(sniffImageExt(new Uint8Array()), 'png');
});
