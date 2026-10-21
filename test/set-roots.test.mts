import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Extractor } from '../src/extract/extract.ts';
import { generateCode, type GenerationOptions } from '../src/gen/generate.ts';
import { applyComponentSetBehavior, parseVariantProps } from '../src/ir/set-roots.ts';
import type { IrContainerNode, IrDocument, IrInstanceNode } from '../src/ir/ir.ts';
import { componentNode, frameNode, testContext, textNode } from './fixtures.ts';
import { withChildren } from './ir-narrow.ts';

/**
 * Component-set root behavior (the shared selection strip): the pure IR
 * reshape plus the two generation modes it feeds — `component` (set doc
 * dropped, detached masters become the parameterized component) and
 * `frame-of-components` (frame kept, one plain composable per variant called
 * from the frame).
 */

/** Extracts a component-set root with two variant masters (+ optional stray content). */
function setRootDoc(options?: { stray?: boolean }): IrDocument {
  const children = [
    componentNode('m1', 'Type=Primary', { width: 200, height: 56 }, [
      textNode('m1t', 'Label', { characters: 'Primary' }),
    ]),
    componentNode('m2', 'Type=Secondary', { x: 0, y: 80, width: 200, height: 56 }, [
      textNode('m2t', 'Label', { characters: 'Secondary' }),
    ]),
  ];
  if (options?.stray) children.push(frameNode('stray', 'Stray', { x: 0, y: 160 }));
  const set = frameNode('set:button', 'Button', { type: 'COMPONENT_SET', width: 240, height: 160 }, children);
  const doc = new Extractor(testContext()).extractRoot(set);
  assert.notEqual(doc, null);
  return doc!;
}

function rootChildren(doc: IrDocument): IrContainerNode['children'] {
  assert.equal(doc.root.type, 'container');
  return withChildren(doc.root).children;
}

test('parseVariantProps reads Key=Value master names and rejects plain ones', () => {
  assert.deepEqual(parseVariantProps('Type=Primary, Size=Large'), { Type: 'Primary', Size: 'Large' });
  assert.deepEqual(parseVariantProps('Type=Primary'), { Type: 'Primary' });
  assert.equal(parseVariantProps('Button'), null);
  assert.equal(parseVariantProps(''), null);
  assert.deepEqual(parseVariantProps('Size=Large, oops'), { Size: 'Large' });
});

test('frame behavior passes a set root through untouched', () => {
  const doc = setRootDoc();
  const reshape = applyComponentSetBehavior([doc], 'frame');
  assert.equal(reshape.docs.length, 1);
  assert.equal(reshape.detached.length, 0);
  assert.equal(reshape.applied.length, 0);
  assert.equal(reshape.coverage.size, 0);
  assert.equal(reshape.notices.length, 0);
  assert.equal(reshape.droppedDiagnostics.length, 0);
  const children = rootChildren(reshape.docs[0]!);
  assert.ok(children.every((c) => c.type === 'container'), 'masters stay plain containers');
});

test('component behavior drops the set doc and detaches every master as a virtual instance', () => {
  const doc = setRootDoc();
  const reshape = applyComponentSetBehavior([doc], 'component');
  assert.equal(reshape.docs.length, 0, 'the set canvas is not emitted');
  assert.equal(reshape.detached.length, 2);
  assert.equal(reshape.applied.length, 1);
  assert.deepEqual(reshape.applied[0], {
    setId: 'set:button',
    setName: 'Button',
    behavior: 'component',
    masterIds: ['m1', 'm2'],
  });
  assert.deepEqual([...reshape.coverage.get('set:button') ?? []].sort(), ['m1', 'm2']);

  const first = reshape.detached[0]!;
  assert.equal(first.type, 'instance');
  assert.equal(first.componentName, 'Type=Primary');
  assert.equal(first.componentKey, 'm1');
  assert.deepEqual(first.componentSet, { id: 'set:button', name: 'Button' });
  assert.deepEqual(first.variantProps, { Type: 'Primary' });
  assert.equal(first.componentProps, null);
  const kids = withChildren(first).children;
  assert.equal(kids.length, 1, 'the master body rides along');
  assert.equal(kids[0]!.type, 'text');

  assert.equal(reshape.notices.length, 1);
  assert.match(reshape.notices[0]!.message, /\[COMPONENT-SET-ROOT\] Component set 'Button' is treated as one component with 2 variants/);
});

test('component behavior forwards dropped-doc diagnostics and warns about stray content', () => {
  const doc = setRootDoc({ stray: true });
  doc.diagnostics.push({
    severity: 'INFO',
    code: 'TEST-DIAG',
    feature: 'test',
    reason: 'forwarded verbatim',
    source: null,
  });
  const reshape = applyComponentSetBehavior([doc], 'component');
  assert.equal(reshape.docs.length, 0);
  assert.equal(reshape.detached.length, 2, 'stray content does not become a master');
  assert.equal(reshape.droppedDiagnostics.length, 1, 'the dropped doc diagnostics ride along');
  assert.equal(reshape.droppedDiagnostics[0]!.code, 'TEST-DIAG');
  const stray = reshape.notices.find((n) => n.level === 'warning');
  assert.ok(stray, 'a warning names the dropped stray content');
  assert.match(stray!.message, /non-variant content \(Stray\)/);
});

test('frame-of-components keeps the frame and swaps masters for self-referencing instances', () => {
  const doc = setRootDoc({ stray: true });
  const reshape = applyComponentSetBehavior([doc], 'frame-of-components');
  assert.equal(reshape.docs.length, 1, 'the frame composable stays');
  assert.equal(reshape.detached.length, 0);
  assert.equal(reshape.applied[0]!.behavior, 'frame-of-components');
  assert.deepEqual([...reshape.coverage.get('set:button') ?? []].sort(), ['m1', 'm2']);

  const children = rootChildren(reshape.docs[0]!);
  assert.equal(children.length, 3, 'stray content keeps its slot');
  const first = children[0]!;
  assert.equal(first.type, 'instance');
  const instance = first as IrInstanceNode;
  assert.equal(instance.componentName, 'ButtonPrimary', 'the per-variant composable name is set + value');
  assert.equal(instance.componentKey, 'm1');
  assert.equal(instance.componentSet, null, 'no set identity: each master stays its own component');
  assert.equal(instance.variantProps, null, 'no variant parameters on per-variant composables');
  assert.deepEqual(instance.componentProps, {}, 'snapshot-backed, so the generator does not skip the group');
  assert.equal(children[2]!.type, 'container', 'stray content stays a plain container');
  assert.equal(reshape.notices.length, 1);
  assert.match(reshape.notices[0]!.message, /one composable per variant \(2\) plus the frame composable/);
});

test('a set root without variant masters stays untouched in component mode', () => {
  const set = frameNode('set:solo', 'Solo', { type: 'COMPONENT_SET' }, [
    frameNode('stray', 'Stray', {}),
  ]);
  const doc = new Extractor(testContext()).extractRoot(set);
  assert.notEqual(doc, null);
  const reshape = applyComponentSetBehavior([doc!], 'component');
  assert.equal(reshape.docs.length, 1, 'nothing to detach: the frame stays');
  assert.equal(reshape.detached.length, 0);
  assert.equal(reshape.applied.length, 0);
});

test('non-set roots pass through every behavior', () => {
  const doc = new Extractor(testContext()).extractRoot(frameNode('root', 'Home', {}));
  assert.notEqual(doc, null);
  for (const behavior of ['component', 'frame', 'frame-of-components'] as const) {
    const reshape = applyComponentSetBehavior([doc!], behavior);
    assert.equal(reshape.docs.length, 1, `${behavior} keeps plain frames`);
    assert.equal(reshape.detached.length, 0);
    assert.equal(reshape.applied.length, 0);
  }
});

test('component behavior generates only the parameterized component file', () => {
  const reshape = applyComponentSetBehavior([setRootDoc()], 'component');
  const options: GenerationOptions = { packageName: 'com.example.app', profile: null };
  // With `variantShape: 'when'` the detached masters become the classic
  // parameterized component; `auto` would legitimately lift the two
  // near-identical bodies into value parameters instead (params plan).
  const result = generateCode([], { ...options, variantMasters: reshape.detached, variantShape: 'when' });
  assert.deepEqual(result.files.map((f) => f.path), ['Button.kt'], 'no screen file, just the component');
  const code = result.files[0]!.content;
  assert.match(code, /enum class ButtonType \{ PRIMARY, SECONDARY \}/);
  assert.match(code, /fun Button\(/);
  assert.match(code, /when \(type\) \{/);
  assert.doesNotMatch(code, /fun ButtonPrimary\(/, 'one parameterized component, not per-variant functions');
  const rootDiag = result.diagnostics.find((d) => d.code === 'COMPONENT-SET-ROOT');
  assert.equal(rootDiag, undefined, 'reshape notices are plugin-side, not generator diagnostics');

  // The default `auto` shape still applies: near-identical variants share one
  // composable whose differing value is lifted into a typed parameter.
  const auto = generateCode([], { ...options, variantMasters: reshape.detached });
  assert.match(auto.files[0]!.content, /fun Button\(\s*\n\s*modifier: Modifier = Modifier,\s*\n\s*text: String = "Primary",/);
});

test('frame-of-components behavior generates one plain composable per variant plus the frame', () => {
  const reshape = applyComponentSetBehavior([setRootDoc()], 'frame-of-components');
  const result = generateCode(reshape.docs, { packageName: 'com.example.app', profile: null });
  assert.deepEqual(
    result.files.map((f) => f.path).sort(),
    ['Button.kt', 'ButtonPrimary.kt', 'ButtonSecondary.kt'],
    'the frame file and one file per variant',
  );
  const frame = result.files.find((f) => f.path === 'Button.kt')!.content;
  assert.match(frame, /fun Button\(\s*\n\s*modifier: Modifier = Modifier,\s*\n\) \{/);
  assert.match(frame, /ButtonPrimary\(/, 'the frame calls the per-variant composables');
  assert.match(frame, /ButtonSecondary\(/);
  assert.doesNotMatch(frame, /when \(/, 'the frame body has no variant dispatch');

  for (const path of ['ButtonPrimary.kt', 'ButtonSecondary.kt']) {
    const code = result.files.find((f) => f.path === path)!.content;
    assert.match(code, /fun (ButtonPrimary|ButtonSecondary)\(\s*\n\s*modifier: Modifier = Modifier,\s*\n\) \{/);
    assert.doesNotMatch(code, /enum class|sealed interface/, 'no variant parameters on per-variant composables');
    assert.doesNotMatch(code, /when \(/);
  }
  assert.match(
    result.files.find((f) => f.path === 'ButtonPrimary.kt')!.content,
    /text = "Primary"/,
    'each variant renders its own master body',
  );
});
