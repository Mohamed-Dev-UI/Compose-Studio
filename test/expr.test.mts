import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangementExpr,
  childAlignExpr,
  contentScaleExpr,
  crossAlignParam,
  fontFamilyExpr,
  fontWeightExpr,
  gradientBrushExpr,
  shapeExprFromRadius,
  sizingModifierParts,
  transformTextCase,
} from '../src/gen/expr.ts';
import type { AutoLayout, Radius } from '../src/ir/ir.ts';

const helpers = () => {
  const imports: string[] = [];
  return { imports, useImport: (p: string) => imports.push(p) };
};

const layout = (over: Partial<AutoLayout> = {}): AutoLayout => ({
  direction: 'ROW',
  gapPx: { value: 8, origin: 'explicit' },
  padding: null,
  mainAxis: null,
  crossAxis: null,
  wrap: null,
  ...over,
});

test('arrangement: gap + main axis combinations', () => {
  const h = helpers();
  assert.equal(arrangementExpr('ROW', layout(), h), 'Arrangement.spacedBy(8.dp)');
  assert.equal(arrangementExpr('ROW', layout({ mainAxis: { value: 'SPACE_BETWEEN', origin: 'explicit' }, gapPx: null }), h), 'Arrangement.SpaceBetween');
  assert.equal(
    arrangementExpr('COLUMN', layout({ mainAxis: { value: 'END', origin: 'explicit' }, gapPx: null }), h),
    'Arrangement.Bottom',
  );
  assert.match(
    arrangementExpr('ROW', layout({ mainAxis: { value: 'CENTER', origin: 'explicit' }, gapPx: null }), h) ?? '',
    /Arrangement\.CenterHorizontally/,
  );
});

test('crossAlignParam maps Container cross alignment onto Row/Column params', () => {
  const h = helpers();
  assert.deepEqual(crossAlignParam('ROW', 'CENTER', h), { name: 'verticalAlignment', expr: 'Alignment.CenterVertically' });
  assert.deepEqual(crossAlignParam('COLUMN', 'END', h), { name: 'horizontalAlignment', expr: 'Alignment.End' });
  assert.equal(crossAlignParam('ROW', 'START', h), null); // compose default
});

test('childAlignExpr returns per-child scope alignments', () => {
  const h = helpers();
  assert.equal(childAlignExpr('row', 'BASELINE', h), 'Alignment.Baseline');
  assert.equal(childAlignExpr('column', 'START', h), null);
});

test('sizingModifierParts covers row, column, box and root behavior', () => {
  const sizing = {
    horizontal: { value: 'FILL' as const, origin: 'explicit' as const },
    vertical: { value: 'FIXED' as const, origin: 'explicit' as const },
  };
  assert.deepEqual(sizingModifierParts(sizing, 'row', { width: 40, height: 20 }), {
    weight: true,
    fillWidth: false,
    fillHeight: false,
    widthPx: null,
    heightPx: null,
  });
  assert.deepEqual(sizingModifierParts(sizing, 'column', { width: 40, height: 20 }), {
    weight: false,
    fillWidth: true,
    fillHeight: false,
    widthPx: null,
    heightPx: 20,
  });
  assert.deepEqual(sizingModifierParts(sizing, 'box', { width: 40, height: 20 }), {
    weight: false,
    fillWidth: true,
    fillHeight: false,
    widthPx: null,
    heightPx: 20,
  });
  assert.deepEqual(sizingModifierParts(sizing, null, { width: 40, height: 20 }), {
    weight: false,
    fillWidth: false,
    fillHeight: false,
    widthPx: 40,
    heightPx: 20,
  });
});

test('font weight expr clamps and aliases 400/700', () => {
  const h = helpers();
  assert.equal(fontWeightExpr(400, h), 'FontWeight.Normal');
  assert.equal(fontWeightExpr(700, h), 'FontWeight.Bold');
  assert.equal(fontWeightExpr(520, h), 'FontWeight.W500');
  assert.equal(fontWeightExpr(550, h), 'FontWeight.W600');
  assert.equal(fontWeightExpr(2000, h), 'FontWeight.W900');
  assert.equal(fontWeightExpr(10, h), 'FontWeight.W100');
});

test('text case transform operates on the rendered string', () => {
  assert.equal(transformTextCase('hello world', 'UPPER'), 'HELLO WORLD');
  assert.equal(transformTextCase('HELLO WORLD', 'LOWER'), 'hello world');
  assert.equal(transformTextCase('hello world', 'TITLE'), 'Hello World');
  assert.equal(transformTextCase('unchanged', 'ORIGINAL'), 'unchanged');
});

test('shapeExprFromRadius supports uniform, per-corner and null radii', () => {
  const h = helpers();
  const uniform: Radius = { kind: 'fixed', px: 12 };
  assert.equal(shapeExprFromRadius(uniform, h), 'RoundedCornerShape(12.dp)');
  const perCorner: Radius = { kind: 'independent', tl: 4, tr: 8, br: 12, bl: 0 };
  assert.equal(
    shapeExprFromRadius(perCorner, h),
    'RoundedCornerShape(topStart = 4.dp, topEnd = 8.dp, bottomEnd = 12.dp, bottomStart = 0.dp)',
  );
  assert.equal(shapeExprFromRadius(null, h), null);
});

test('gradientBrushExpr picks vertical/horizontal/linear variants', () => {
  const gh = helpers() as unknown as Parameters<typeof gradientBrushExpr>[2] & { imports: string[] };
  gh.colorExpr = (c) => `Color(0xFF${c.rgba.r === 1 ? 'FFFFFF' : '000000'})`;
  const stops = [
    { offset: 0, color: { rgba: { r: 0, g: 0, b: 0, a: 1 }, tokenRef: null } },
    { offset: 1, color: { rgba: { r: 1, g: 1, b: 1, a: 1 }, tokenRef: null } },
  ];
  const vertical = gradientBrushExpr(
    { kind: 'LINEAR', p0: [0.5, 0], p1: [0.5, 1], stops },
    { width: 100, height: 100, kind: 'linear' },
    gh,
  );
  assert.equal(vertical, 'Brush.verticalGradient(0f to Color(0xFF000000), 1f to Color(0xFFFFFFFF))');
  const diagonal = gradientBrushExpr(
    { kind: 'LINEAR', p0: [0, 0], p1: [1, 1], stops },
    { width: 100, height: 100, kind: 'linear' },
    gh,
  );
  assert.equal(diagonal, 'Brush.linearGradient(0f to Color(0xFF000000), 1f to Color(0xFFFFFFFF))');
  const radial = gradientBrushExpr(
    { kind: 'RADIAL', p0: [0.5, 0.5], radius: 0.7, stops },
    { width: 100, height: 100, kind: 'radial' },
    gh,
  );
  assert.equal(radial, 'Brush.radialGradient(0f to Color(0xFF000000), 1f to Color(0xFFFFFFFF))');
  assert.equal(gradientBrushExpr({ kind: 'LINEAR', p0: [0, 0], stops: [] }, { width: 1, height: 1, kind: 'linear' }, gh), null);
  assert.equal(gh.imports.includes('androidx.compose.ui.graphics.Brush'), true);
});

test('contentScaleExpr approximates FILL/CROP/TILE with Crop, keeps Fit', () => {
  const h = helpers();
  assert.equal(contentScaleExpr('FIT', h), 'ContentScale.Fit');
  assert.equal(contentScaleExpr('FILL', h), 'ContentScale.Crop');
  assert.equal(contentScaleExpr('TILE', h), 'ContentScale.Crop');
});

test('fontFamilyExpr pins to the platform default (documented)', () => {
  const h = helpers();
  assert.equal(fontFamilyExpr(h), 'FontFamily.Default');
  assert.equal(h.imports.includes('androidx.compose.ui.text.font.FontFamily'), true);
});
