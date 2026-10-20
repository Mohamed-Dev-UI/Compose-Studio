import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceRef, StyledIrNode, WithOrigin } from '../src/ir/ir.ts';
import { argbLiteral } from '../src/util/format.ts';
import { buildModifierChain, type ModifierHelpers } from '../src/gen/build-modifiers.ts';
import { ModifierChain } from '../src/gen/modifiers.ts';
import { AssetRegistry } from '../src/gen/assets.ts';

function withOrigin<T>(value: T, origin: WithOrigin<T>['origin'] = 'explicit'): WithOrigin<T> {
  return { value, origin };
}

function helpers(): ModifierHelpers & { imports: string[] } {
  const imports: string[] = [];
  return {
    imports,
    useImport: (path: string) => imports.push(path),
    colorExpr: (color) => `Color(${argbLiteral(color.rgba)})`,
    dpExpr: null,
    assetRegistry: new AssetRegistry(),
    diag: () => {
      /* captured by chain-order tests where relevant */
    },
  } as ModifierHelpers & { imports: string[] };
}

function baseNode(over: Partial<StyledIrNode> = {}): StyledIrNode {
  const shape: StyledIrNode = {
    id: 'n1',
    ref: { fuid: 'n1', nodeName: 'Node', fType: 'RECTANGLE' } satisfies SourceRef,
    index: 0,
    parent: null,
    idPath: [],
    geometry: { x: 8, y: 12, width: 40, height: 40 },
    background: { kind: 'SOLID', color: { rgba: { r: 0, g: 0, b: 0, a: 1 }, tokenRef: null }, origin: 'explicit' },
    extraBackgrounds: [],
    border: null,
    radius: withOrigin({ kind: 'fixed', px: 8 }),
    opacity: withOrigin(1),
    clip: withOrigin(false),
    effects: { mapped: [], unsupported: [] },
    type: 'shape',
    shape: 'RECTANGLE',
    ...over,
  } as StyledIrNode;
  return shape;
}

type UnknownPartial = Record<string, unknown>;

test('modifier chain follows the canonical order', () => {
  const node = baseNode({
    border: {
      widthPx: { value: 1, origin: 'explicit' },
      color: { rgba: { r: 0, g: 0, b: 0, a: 1 }, tokenRef: null },
      strokeAlign: { value: 'INSIDE', origin: 'explicit' },
      dashPattern: null,
    },
    clip: withOrigin(true),
  });
  node.effects.mapped.push({
    color: { rgba: { r: 0, g: 0, b: 0, a: 0.2 }, tokenRef: null },
    blurPx: 8,
    xPx: 0,
    yPx: 4,
    spreadPx: 0,
    effectType: 'DROP_SHADOW',
  });
  const mc = buildModifierChain(node, { kind: 'box', isRoot: false, crossAlign: null }, helpers());
  assert.deepEqual(mc.partNames(), [
    'size',
    'offset',
    'shadow',
    'clip',
    'border',
    'background',
  ]);
});

test('root nodes consume explicit size, no offset', () => {
  const node = baseNode();
  const mc = buildModifierChain(node, { kind: 'box', isRoot: true, crossAlign: null }, helpers());
  assert.deepEqual(mc.partNames(), ['size', 'background']);
  const lines = mc.toKotlinLines('    ', 'modifier = ');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '    modifier = Modifier');
  assert.equal(lines[1], '        .size(40.dp)');
  assert.match(lines[2]!, /\.background\(color = Color\(0xFF000000\), shape = RoundedCornerShape\(8\.dp\)\)/);
});

test('per-child offset is emitted only inside Box parents', () => {
  const node = baseNode();
  const inBox = buildModifierChain(node, { kind: 'box', isRoot: false, crossAlign: null }, helpers());
  assert.equal(inBox.partNames().includes('offset'), true);
  const inRow = buildModifierChain(node, { kind: 'row', isRoot: false, crossAlign: null }, helpers());
  assert.equal(inRow.partNames().includes('offset'), false);
  const atRoot = buildModifierChain(node, { kind: 'box', isRoot: true, crossAlign: null }, helpers());
  assert.equal(atRoot.partNames().includes('offset'), false);
});

test('per-child cross alignment becomes a scope align call', () => {
  const node = baseNode();
  const mc = buildModifierChain(node, { kind: 'row', isRoot: false, crossAlign: 'CENTER' }, helpers());
  assert.equal(mc.partNames().includes('align'), true);
});

test('weight and fill sizing inside a Row', () => {
  const node = baseNode({
    type: 'container',
    kind: 'CONTAINER',
    layout: { value: null, origin: 'inferred' },
    sizing: {
      horizontal: withOrigin('FILL'),
      vertical: withOrigin('FILL'),
    },
    children: [],
  } as UnknownPartial);
  const mc = buildModifierChain(node, { kind: 'row', isRoot: false, crossAlign: null }, helpers());
  assert.deepEqual(mc.partNames(), ['weight', 'fillMaxHeight', 'background']);
});

test('padding is collapsed for symmetric values', () => {
  const node = baseNode({
    type: 'container',
    kind: 'CONTAINER',
    layout: {
      value: {
        direction: 'ROW',
        gapPx: null,
        padding: withOrigin({ t: 8, r: 16, b: 8, l: 16 }),
        mainAxis: null,
        crossAxis: null,
        wrap: null,
      },
      origin: 'explicit',
    },
    sizing: { horizontal: withOrigin('HUG'), vertical: withOrigin('HUG') },
    children: [],
  } as Partial<StyledIrNode>);
  const mc = buildModifierChain(node, { kind: 'box', isRoot: false, crossAlign: null }, helpers());
  assert.equal(mc.partNames().includes('padding'), true);
  const all = mc.toKotlinLines('', 'modifier = ').join(' ');
  assert.match(all, /padding\(horizontal = 16\.dp, vertical = 8\.dp\)/);
});

test('opacity below 1 emits alpha last', () => {
  const node = baseNode({ opacity: withOrigin(0.5) });
  const mc = buildModifierChain(node, { kind: 'box', isRoot: true, crossAlign: null }, helpers());
  const names = mc.partNames();
  assert.equal(names[names.length - 1], 'alpha');
});

test('ellipse nodes use CircleShape; radius uses RoundedCornerShape', () => {
  const ellipse = baseNode({
    type: 'shape',
    shape: 'ELLIPSE',
    radius: null,
  } as Partial<StyledIrNode>);
  const circleChain = buildModifierChain(ellipse, { kind: 'box', isRoot: true, crossAlign: null }, helpers());
  assert.match(circleChain.toKotlinLines('', '').join(' '), /CircleShape/);
});

test('ModifierChain renders multiline chains with exact indentation', () => {
  const mc = new ModifierChain();
  mc.fillMaxWidth();
  mc.background('Color(0xFF000000)', 'RoundedCornerShape(8.dp)');
  mc.alpha(0.5);
  const lines = mc.toKotlinLines('  ', 'modifier = ');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '  modifier = Modifier');
  assert.equal(lines[1], '      .fillMaxWidth()');
  assert.equal(lines[2], '      .background(color = Color(0xFF000000), shape = RoundedCornerShape(8.dp))');
  assert.equal(lines[3], '      .alpha(alpha = 0.5f)');
});

test('single-part chains render inline', () => {
  const mc = new ModifierChain();
  mc.size(120, null);
  assert.deepEqual(mc.toKotlinLines('', 'modifier = '), ['modifier = Modifier.width(120.dp)']);
});

test('image backgrounds register an asset and reference painterResource + ContentScale', () => {
  const node = baseNode({
    background: {
      kind: 'IMAGE',
      image: { imageHash: 'h1', scaleMode: 'FILL', opacity: 1 },
      origin: 'explicit',
    },
  });
  const h = helpers();
  const mc = buildModifierChain(node, { kind: null, isRoot: true, crossAlign: null }, h);
  assert.deepEqual(mc.partNames(), ['size', 'paint']);
  const all = mc.toKotlinLines('', 'modifier = ').join(' ');
  assert.match(all, /painter = painterResource\(id = R\.drawable\.img_node\)/);
  assert.match(all, /contentScale = ContentScale\.Crop/);
  assert.equal(h.imports.includes('androidx.compose.ui.layout.ContentScale'), true);
});

test('gradient backgrounds emit a Brush axis-aligned approximation', () => {
  const node = baseNode({
    background: {
      kind: 'GRADIENT_LINEAR',
      gradient: {
        kind: 'LINEAR',
        p0: [0.5, 0],
        p1: [0.5, 1],
        stops: [
          { offset: 0, color: { rgba: { r: 1, g: 0, b: 0, a: 1 }, tokenRef: null } },
          { offset: 1, color: { rgba: { r: 0, g: 0, b: 1, a: 1 }, tokenRef: null } },
        ],
      },
      origin: 'explicit',
    },
  } as Partial<StyledIrNode>);
  const h = helpers();
  const mc = buildModifierChain(node, { kind: 'box', isRoot: true, crossAlign: null }, h);
  const all = mc.toKotlinLines('', 'modifier = ').join(' ');
  assert.match(all, /brush = Brush\.verticalGradient\(0f to Color\(0xFFFF0000\), 1f to Color\(0xFF0000FF\)\)/);
  assert.equal(h.imports.includes('androidx.compose.ui.graphics.Brush'), true);
});
