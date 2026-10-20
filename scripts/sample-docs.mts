/**
 * Sample generator used when writing docs: converts the test login fixture,
 * a mapped instance fixture and a variant-family fixture (auto-generated
 * component), printing the exact Kotlin the plugin emits.
 * Run: node --experimental-strip-types --no-warnings scripts/sample-docs.mts
 */
import { Extractor } from '../src/extract/extract.ts';
import { generateCode } from '../src/gen/generate.ts';
import { parseMappingProfile } from '../src/mapping/profile.ts';
import type { InstanceComponentInfo } from '../src/extract/figma-types.ts';
import { columnFixture, frameNode, instanceNode, rectNode, textNode, testContext } from '../test/fixtures.ts';

const doc = new Extractor(testContext()).extractRoot(columnFixture())!;
const standalone = generateCode([doc], { packageName: 'com.example.composeapp', profile: null });
console.log('=== STANDALONE ===');
console.log(standalone.files[0]!.content);

const profile = parseMappingProfile({
  schemaVersion: 1,
  profileName: 'illuminated Profile',
  colors: [
    { source: { kind: 'hex', name: '#666666' }, target: 'MaterialTheme.colorScheme.onSurfaceVariant' },
    { source: { kind: 'variable', name: 'Brand/Primary' }, target: 'Color(0xFF4F46E5)' },
  ],
  fonts: [{ source: { kind: 'family', name: 'Roboto' }, target: 'AppTypography' }],
  textStyles: [{ source: { kind: 'fontFamily', name: 'Inter' }, target: 'MaterialTheme.typography.bodyMedium' }],
  components: [
    {
      source: { kind: 'component', componentName: 'Button' },
      target: { symbol: 'AppButton' },
      arguments: [
        { argument: 'label', source: { kind: 'text', childIndex: 0 } },
        { argument: 'type', source: { kind: 'variantProp', name: 'Type', cases: { Primary: 'ButtonType.Primary' } } },
        { argument: 'modifier', source: { kind: 'modifier' } },
        { argument: 'content', source: { kind: 'content' } },
      ],
    },
  ],
}).profile!;

// New: an auto-layout panel with an absolute-positioned badge (the Figma
// "ignore auto-layout" toggle, `layoutPositioning: ABSOLUTE`).
const absRoot = frameNode('root', 'HomeScreen', { width: 360, height: 200 }, [
  frameNode('panel', 'Panel', {
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16,
    width: 360, height: 200,
  }, [
    textNode('t1', 'Title', { characters: 'Flow child', width: 100, height: 20 }),
    rectNode('r1', 'Badge', { layoutPositioning: 'ABSOLUTE', x: 24, y: 40, width: 60, height: 40 }),
  ]),
]);
const absDoc = new Extractor(testContext()).extractRoot(absRoot)!;
const absOut = generateCode([absDoc], { packageName: 'com.example.composeapp', profile: null });
console.log('=== ABSOLUTE ===');
console.log(absOut.files[0]!.content);

const mappedRoot = frameNode('root', 'ProfileScreen', { width: 360, height: 200 }, [
  instanceNode('i1', 'Save', {
    mainComponent: { name: 'Button', id: 'comp:1' },
    variantProperties: { Type: 'Primary' },
    layoutMode: 'VERTICAL',
    itemSpacing: 0,
    width: 200,
    height: 56,
    children: [textNode('b1', 'Label', { characters: 'Sign in' })],
  }),
]);
const mappedDoc = new Extractor(testContext()).extractRoot(mappedRoot)!;
const mapped = generateCode([mappedDoc], { packageName: 'com.example.composeapp', profile });
console.log('=== MAPPED ===');
console.log(mapped.files[0]!.content);

// New: a variant family without a profile — the auto-generated component
// file (one composable, typed `when` per variant) plus the parameterized
// calls. True/False variants become Boolean; other keys become enums.
const varRoot = frameNode('root', 'Root', { width: 400, height: 300 }, [
  instanceNode('a1', 'PrimaryBtn', {
    mainComponent: { name: 'Destructive=False, Size=xl', id: 'comp:p1' },
    variantProperties: { Destructive: 'False', Size: 'xl' },
    width: 320,
    height: 48,
    children: [textNode('a1lbl', 'Label', { characters: 'Sign In', width: 120, height: 20 })],
  }),
  instanceNode('a2', 'SecondaryBtn', {
    mainComponent: { name: 'Destructive=True, Size=md', id: 'comp:p2' },
    variantProperties: { Destructive: 'True', Size: 'md' },
    x: 0,
    y: 80,
    width: 320,
    height: 48,
    children: [textNode('a2lbl', 'Label', { characters: 'Sign Up', width: 140, height: 20 })],
  }),
]);
const varRecords = {
  a1: { name: 'Destructive=False, Size=xl', id: 'comp:p1', set: { id: 'set:button', name: 'Button' } },
  a2: { name: 'Destructive=True, Size=md', id: 'comp:p2', set: { id: 'set:button', name: 'Button' } },
} satisfies Record<string, InstanceComponentInfo>;
const varDoc = new Extractor({
  ...testContext(),
  instanceComponentLookup: (id: string) => varRecords[id as keyof typeof varRecords] ?? null,
}).extractRoot(varRoot)!;
// Classic `when` (the Variant code shape setting pinned explicitly) …
const auto = generateCode([varDoc], {
  packageName: 'com.example.composeapp', profile: null, variantShape: 'when',
});
for (const f of auto.files) {
  console.log(`--- ${f.path} ---`);
  console.log(f.content);
}

// … and the automatic shape on the same family: the variant bodies differ
// only in a value token, so the tier lifts it into a typed parameter
// (no variant-key parameters, no enum).
const autoTier = generateCode([varDoc], {
  packageName: 'com.example.composeapp', profile: null, variantShape: 'auto',
});
console.log('=== AUTO PARAMS ===');
const autoComp = autoTier.files.find((f) => f.path === 'Button.kt');
console.log(autoComp?.content);
const autoScreen = autoTier.files.find((f) => f.path === 'RootScreen.kt');
if (autoScreen) {
  console.log('=== AUTO PARAMS SCREEN ===');
  console.log(autoScreen.content);
}

console.log('=== DIAGS ===');
console.log(JSON.stringify(mapped.diagnostics, null, 2));
