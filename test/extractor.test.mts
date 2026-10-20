import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkIr, type IrNode } from '../src/ir/ir.ts';
import { Extractor } from '../src/extract/extract.ts';
import type { InstanceComponentInfo } from '../src/extract/figma-types.ts';
import {
  columnFixture,
  ellipseNode,
  frameNode,
  groupNode,
  instanceNode,
  MIXED,
  rectNode,
  solidPaint,
  testContext,
  textNode,
} from './fixtures.ts';
import { withChildren, withStyling } from './ir-narrow.ts';

test('extracts a full login-screen fixture into IR v1', () => {
  const doc = new Extractor(testContext()).extractRoot(columnFixture());
  assert.notEqual(doc, null);
  assert.equal(doc!.version, 1);
  const root = doc!.root;
  assert.equal(root.type, 'container');
  if (root.type !== 'container') return;
  assert.equal(root.kind, 'CONTAINER');
  assert.equal(root.layout.value?.direction, 'COLUMN');
  assert.equal(root.layout.value?.gapPx?.value, 16);
  assert.deepEqual(root.layout.value?.padding?.value, { t: 24, r: 24, b: 24, l: 24 });
  assert.equal(root.background?.kind, 'SOLID');
  for (const child of root.children) assert.equal(child.parent, root.id);
});

test('records fonts used by the design', () => {
  const doc = new Extractor(testContext()).extractRoot(columnFixture());
  assert.notEqual(doc, null);
  const families = doc!.fonts.map((f) => f.family);
  assert.deepEqual([...families].sort(), ['Inter', 'Roboto']);
});

test('text spans preserve typography and color', () => {
  const doc = new Extractor(testContext()).extractRoot(columnFixture());
  assert.notEqual(doc, null);
  const card = withChildren(doc!.root).children[0]!;
  assert.equal(card.type, 'container');
  assert.equal(card.radius?.value.kind === 'fixed' ? card.radius.value.px : undefined, 12);
  const title = card.children[0]!;
  assert.equal(title.type, 'text');
  if (title.type !== 'text') return;
  assert.equal(title.spans.length, 1);
  const span = title.spans[0]!;
  assert.equal(span.text, 'Welcome');
  assert.equal(span.fontSizePx, 24);
  assert.equal(span.fontWeight, 700);
  assert.equal(span.lineHeightPx, 20);
});

test('mixed item spacing yields null gap instead of a wrong number', () => {
  const root = columnFixture();
  root.itemSpacing = MIXED;
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const container = doc!.root as { layout: { value: { gapPx: unknown } | null } };
  assert.equal(container.layout.value?.gapPx, null);
});

test('invisible nodes are excluded and reported (NODE-INVISIBLE)', () => {
  const root = frameNode('root', 'Root', {}, [textNode('hidden', 'Ghost', { visible: false })]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  assert.equal(withChildren(doc!.root).children.length, 0);
  assert.equal(doc!.diagnostics.some((d) => d.code === 'NODE-INVISIBLE'), true);
});

test('invisible roots return null', () => {
  const root = frameNode('root', 'Root', { visible: false });
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.equal(doc, null);
});

test('groups rebase child offsets by the group origin (Figma quirk)', () => {
  const child = textNode('c1', 'Child', { x: 110, y: 120, parent: null });
  const group = groupNode('g1', 'Group', [child], { x: 100, y: 100 });
  const root = frameNode('root', 'Root', {}, [group]);
  group.parent = root;
  child.parent = group;
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const groupIr = withChildren(doc!.root).children[0]!;
  assert.equal(groupIr.type, 'group');
  if (groupIr.type !== 'group') return;
  assert.deepEqual(groupIr.geometry, { x: 100, y: 100, width: 100, height: 100 });
  const childIr = groupIr.children[0]!;
  assert.deepEqual(childIr.geometry, { x: 10, y: 20, width: 120, height: 20 });
});

test('instances register component usage and report variants', () => {
  const button = instanceNode('i1', 'PrimaryButton', {
    variantProperties: { Type: 'Primary' },
    children: [textNode('b1', 'Label', { characters: 'OK', x: 0, y: 0 })],
  });
  const root = frameNode('root', 'Root', {}, [button]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  assert.equal(doc!.components.length, 1);
  assert.equal(doc!.components[0]!.componentName, 'Button');
  assert.equal(doc!.components[0]!.instanceCount, 1);
  assert.equal(doc!.diagnostics.some((d) => d.code === 'COMPONENT-VARIANT'), true);
  const inst = withChildren(doc!.root).children[0]!;
  assert.equal(inst.type, 'instance');
  if (inst.type !== 'instance') return;
  assert.deepEqual(inst.variantProps, { Type: 'Primary' });
});

test('instance master resolution prefers the context lookup (dynamic-page mode)', () => {
  // Under `documentAccess: 'dynamic-page'` reading the sync `mainComponent`
  // getter throws, so the property stays unset and the sandbox provides
  // masters through FigmaContext.instanceComponentLookup instead.
  const detached = instanceNode('i2', 'Detached', { mainComponent: undefined }, [
    textNode('b1', 'Label', { characters: 'OK', x: 0, y: 0 }),
  ]);
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'PrimaryButton', { mainComponent: undefined }, []),
    detached,
  ]);
  const lookup = (id: string): { name: string; id: string } | null => {
    if (id === 'i1') return { name: 'FigmaButton', id: 'comp:live' };
    return null; // unresolved master: the instance keeps its own identity
  };
  const doc = new Extractor({ ...testContext(), instanceComponentLookup: lookup }).extractRoot(root);
  assert.notEqual(doc, null);
  assert.equal(doc!.components.length, 2);
  const live = doc!.components.find((c) => c.componentKey === 'comp:live');
  assert.ok(live);
  assert.equal(live!.componentName, 'FigmaButton');
  const own = doc!.components.find((c) => c.componentKey === 'i2');
  assert.ok(own);
  assert.equal(own!.componentName, 'Detached');
});

test('component snapshot populates the instance set identity and property values', () => {
  // The sandbox resolves sets and per-instance property values async and
  // delivers them with the master; VARIANT entries are excluded (they arrive
  // as variantProperties) and `#id` suffixes are stripped from prop keys.
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'PrimaryButton', { mainComponent: undefined, variantProperties: { Type: 'Primary' } }, [
      textNode('b1', 'Label', { characters: 'Sign in', x: 0, y: 0 }),
    ]),
  ]);
  const lookup = (id: string): InstanceComponentInfo | null =>
    id === 'i1'
      ? {
          name: 'Type=Primary',
          id: 'comp:p1',
          set: { id: 'set:button', name: 'Button' },
          props: {
            'Label#12:0': { kind: 'TEXT', value: 'Sign in' },
            'Icon#12:1': { kind: 'BOOLEAN', value: true },
            'Swap#12:2': { kind: 'INSTANCE_SWAP', value: 'comp:q' },
          },
        }
      : null;
  const doc = new Extractor({ ...testContext(), instanceComponentLookup: lookup }).extractRoot(root);
  assert.notEqual(doc, null);
  const rootIr: IrNode = doc!.root;
  const inst = (rootIr.type === 'container' ? rootIr.children : [])[0]!;
  assert.equal(inst.type, 'instance');
  assert.equal(inst.componentKey, 'comp:p1'); // lookup wins over the sync getter
  assert.deepEqual(inst.variantProps, { Type: 'Primary' });
  assert.deepEqual(inst.componentSet, { id: 'set:button', name: 'Button' });
  assert.deepEqual(inst.componentProps, {
    Label: { kind: 'TEXT', value: 'Sign in' },
    Icon: { kind: 'BOOLEAN', value: true },
    Swap: { kind: 'OTHER', value: 'comp:q' },
  });
});

test('plain ellipse becomes a shape; arcs degrade to vectors with SVG-REQUIRED', () => {
  const plain = ellipseNode('e1', 'Dot');
  const arc = ellipseNode('e2', 'Pie', { ellipseArcData: { startingAngle: 0, endingAngle: 3, innerRadius: 0.2 } });
  const root = frameNode('root', 'Root', {}, [plain, arc]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  assert.equal(withChildren(doc!.root).children[0]!.type, 'shape');
  assert.equal(withChildren(doc!.root).children[1]!.type, 'vector');
  assert.equal(doc!.diagnostics.filter((d) => d.code === 'SVG-REQUIRED').length, 1);
});

test('unsupported effects are reported and not mapped', () => {
  const withBlur = frameNode('root', 'Root', {
    effects: [{ type: 'LAYER_BLUR', radius: 8, visible: true }],
  });
  const doc = new Extractor(testContext()).extractRoot(withBlur);
  assert.notEqual(doc, null);
  assert.equal(withStyling(doc!.root).effects.mapped.length, 0);
  assert.equal(doc!.diagnostics.some((d) => d.code === 'UNSUPPORTED-EFFECT'), true);
});

test('drop shadows are mapped to the first shadow with diagnostics for extras', () => {
  const withShadows = frameNode('root', 'Root', {
    effects: [
      { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, visible: true },
      { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 2, y: 2 }, radius: 4, visible: true },
    ],
  });
  const doc = new Extractor(testContext()).extractRoot(withShadows);
  assert.notEqual(doc, null);
  assert.equal(withStyling(doc!.root).effects.mapped.length, 2);
});

test('borders keep dash patterns and alignment diagnostics', () => {
  const bordered = frameNode('root', 'Root', {
    strokes: [solidPaint({ r: 0, g: 0, b: 0 })],
    strokeWeight: 2,
    strokeAlign: 'CENTER',
    dashPattern: [4, 4],
  });
  const doc = new Extractor(testContext()).extractRoot(bordered);
  assert.notEqual(doc, null);
  const root = withStyling(doc!.root);
  assert.notEqual(root.border, null);
  assert.equal(root.border!.dashPattern![0], 4);
  const codes = doc!.diagnostics.map((d) => d.code);
  assert.equal(codes.includes('DASHED-BORDER'), true);
  assert.equal(codes.includes('STROKE-ALIGN'), true);
});

test('image fills are preserved with hash and scale mode', () => {
  const img = rectNode('r1', 'Photo', {
    fills: [{ type: 'IMAGE', imageHash: 'abc123', scaleMode: 'FILL', visible: true }],
  });
  const root = frameNode('root', 'Root', {}, [img]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const child = withStyling(withChildren(doc!.root).children[0]!);
  assert.equal(child.background?.kind, 'IMAGE');
  if (child.background?.kind !== 'IMAGE') return;
  assert.equal(child.background.image.imageHash, 'abc123');
  assert.equal(child.background.image.scaleMode, 'FILL');
});

test('rotated nodes are reported (ROTATED-NODE)', () => {
  const rotated = rectNode('r1', 'Tilt', { rotation: 15 });
  const root = frameNode('root', 'Root', {}, [rotated]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.equal(doc!.diagnostics.some((d) => d.code === 'ROTATED-NODE'), true);
});

test('multiple fills keep the first and report the rest', () => {
  const multi = rectNode('r1', 'Layered', {
    fills: [solidPaint({ r: 0, g: 0, b: 0 }), solidPaint({ r: 1, g: 1, b: 1 })],
  });
  const root = frameNode('root', 'Root', {}, [multi]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const child = withStyling(withChildren(doc!.root).children[0]!);
  assert.equal(child.background?.kind, 'SOLID');
  assert.deepEqual(child.background?.color.rgba, { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(child.extraBackgrounds.length, 1);
  assert.equal(doc!.diagnostics.some((d) => d.code === 'MULTIPLE-FILLS'), true);
});

test('unsupported node types become unknown IR nodes (UNSUPPORTED-NODE)', () => {
  const weird = rectNode('r1', 'Canvas', { type: 'CODE' as string });
  const root = frameNode('root', 'Root', {}, [weird]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  assert.equal(withChildren(doc!.root).children[0]!.type, 'unknown');
  assert.equal(doc!.diagnostics.some((d) => d.code === 'UNSUPPORTED-NODE'), true);
});

test('maxNodes guard throws instead of hanging on huge selections', () => {
  const children = Array.from({ length: 5 }, (_, i) => textNode('t' + i, 'Text' + i));
  const root = frameNode('root', 'Root', {}, children);
  root.children = children;
  assert.throws(() => new Extractor(testContext(3)).extractRoot(root), /too large/);
});

test('absolute-positioned children are flagged and reported (ABSOLUTE-POSITION)', () => {
  const badge = rectNode('r1', 'Badge', { layoutPositioning: 'ABSOLUTE', x: 24, y: 40, width: 60, height: 40 });
  const label = textNode('t1', 'Label', { characters: 'Flow' });
  const root = frameNode('root', 'Root', {
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    width: 200, height: 120,
  }, [label, badge]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const children = withChildren(doc!.root).children;
  assert.equal(children[0]!.absolute, false);
  assert.equal(children[1]!.absolute, true);
  assert.equal(doc!.diagnostics.some((d) => d.code === 'ABSOLUTE-POSITION'), true);
});

test('walkIr visits every node exactly once in document order', () => {
  const doc = new Extractor(testContext()).extractRoot(columnFixture());
  assert.notEqual(doc, null);
  const visited: string[] = [];
  walkIr(doc!.root, (n) => visited.push(n.id));
  assert.deepEqual(visited, ['screen', 'card', 't1', 't2']);
});
