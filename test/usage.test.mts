import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode } from '../src/gen/generate.ts';
import { Extractor } from '../src/extract/extract.ts';
import { buildDesignSystem, emptyDesignSystemInput, type DesignSystemInput } from '../src/gen/designsystem.ts';
import {
  buildUsageResolvers,
  colorKeyOf,
  collectUsageTokens,
  mergeDesignSystemInput,
  numberKeyOf,
  textKeyOf,
  type UsageHarvest,
} from '../src/gen/usage.ts';
import { frameNode, testContext, textNode } from './fixtures.ts';

/* ---------------------------------------------------------------------------
 * fixtures
 * ------------------------------------------------------------------------- */

/** Extracts one node into an IR doc (mirrors the generator tests). */
function docOf(root: ReturnType<typeof frameNode>) {
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  return doc!;
}

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const GRAY = { r: 0.4, g: 0.4, b: 0.4, a: 1 };

/** Reusable card: padding 16, gap 8, radius 12, white fill, one gray body text. */
function cardNode(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof frameNode> {
  const body = textNode(`${id}-t`, 'Body', {
    x: 0, y: 24,
    characters: 'Item',
    fontSize: 14,
    fills: [{ type: 'SOLID', color: GRAY, opacity: 1 }],
  });
  return frameNode(id, 'Card', {
    width: 96, height: 48,
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16,
    cornerRadius: 12,
    fills: [{ type: 'SOLID', color: WHITE, opacity: 1 }],
    ...overrides,
  }, [body]);
}

/** `n` cards under one auto-layout root screen. */
function cardsFixture(n: number, opts: { root?: Record<string, unknown> } = {}): ReturnType<typeof frameNode> {
  const cards = [];
  for (let i = 0; i < n; i++) cards.push(cardNode(`c${i}`, { y: i * 80 }));
  return frameNode('root', 'LoginScreen', {
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24,
    fills: [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.96, a: 1 }, opacity: 1 }],
    width: 360, height: 640,
    ...opts.root,
  }, cards);
}

/* ---------------------------------------------------------------------------
 * collection: thresholds, naming, determinism
 * ------------------------------------------------------------------------- */

test('repeated values become named tokens with dominant-context names', () => {
  const doc = docOf(cardsFixture(3));
  const usage = collectUsageTokens([doc], { min: 2 });

  const colorNames = usage.colors.map((c) => c.name);
  // White fills: exactly the three Cards -> strictly-majority context.
  assert.ok(colorNames.includes('Card Surface'));
  // Gray span colors recur in all three Cards -> dominant context names them too.
  assert.ok(colorNames.includes('Card OnSurface'));
  // Role-only fallback names never appear while a strict majority exists.
  assert.equal(colorNames.filter((name) => name === 'Surface').length, 0);
  assert.ok(!colorNames.includes('OnSurface'));

  const numberNames = usage.numbers.map((c) => c.name);
  ['Card Padding 16', 'Card Gap 8', 'Card Radius 12'].forEach((name) => assert.ok(numberNames.includes(name), name));
  // Root profile paddings/gap: one occurrence each -> below the threshold.
  assert.ok(!numberNames.includes('Card Padding 24'));
  assert.ok(!numberNames.includes('LoginScreen Padding 24'));
  assert.ok(!numberNames.includes('LoginScreen Gap 16'));

  const textNames = usage.texts.map((t) => t.name);
  assert.ok(textNames.includes('Card Text 14'));
});

test('threshold gate: values below min produce no tokens', () => {
  const doc = docOf(cardsFixture(2));
  const below = collectUsageTokens([doc], { min: 3 });
  assert.equal(below.colors.length, 0);
  assert.equal(below.numbers.length, 0);
  assert.equal(below.texts.length, 0);
  assert.equal(below.colorKeys.size, 0);
  // The same design at min=2 has tokens.
  const above = collectUsageTokens([doc], { min: 2 });
  assert.ok(above.colors.length >= 1);
  assert.ok(above.colorKeys.size === above.colors.length);
});

test('no strict-majority context falls back to role-only names (Surface/OnSurface)', () => {
  // One white fill in Card, one in Header, plus a repeated gray text in each:
  const card = cardNode('c1');
  const headerText = textNode('ht', 'Header label', {
    characters: 'Hello',
    fontSize: 14,
    fills: [{ type: 'SOLID', color: GRAY, opacity: 1 }],
  });
  const header = frameNode('h1', 'Header', { layoutMode: 'NONE', fills: [{ type: 'SOLID', color: WHITE, opacity: 1 }] }, [headerText]);
  const root = frameNode('root', 'Split', { layoutMode: 'VERTICAL', itemSpacing: 8, fills: [] }, [card, header]);
  const doc = docOf(root);
  const usage = collectUsageTokens([doc], { min: 2 });

  const colorNames = usage.colors.map((c) => c.name);
  // White: 2 occurrences split across Card/Header -> no >50% context.
  assert.ok(colorNames.includes('Surface'));
  assert.ok(!colorNames.includes('Card Surface'));
  assert.ok(!colorNames.includes('Header Surface'));
  // Gray text: 2 occurrences in different contexts -> OnSurface.
  assert.ok(colorNames.includes('OnSurface'));
  assert.ok(!colorNames.includes('Card OnSurface'));
  // The shared 14sp style has no dominant context either -> explicit pattern name.
  assert.ok(usage.texts.map((t) => t.name).includes('Text 14'));
});

test('text styles inside a repeated Title context grade into M3 slot names', () => {
  const slots = (n: number, size: number, weight: number, family = 'Roboto'): ReturnType<typeof frameNode>[] => {
    const frames: ReturnType<typeof frameNode>[] = [];
    for (let i = 0; i < n; i++) {
      const text = textNode(`tt${i}`, 'Heading', {
        characters: 'Welcome',
        fontName: { family, style: 'Bold' },
        fontWeight: weight,
        fontSize: size,
        fills: [{ type: 'SOLID', color: GRAY, opacity: 1 }],
      });
      frames.push(frameNode(`titles${i}`, 'Title', { layoutMode: 'NONE', height: 28, fills: [] }, [text]));
    }
    return frames;
  };
  const root = frameNode('root', 'TypeScreen', { layoutMode: 'VERTICAL', itemSpacing: 16, fills: [] }, [
    ...slots(3, 22, 700),
    ...slots(2, 16, 700),
    ...slots(2, 14, 400, 'Inter'),
  ]);
  const usage = collectUsageTokens([docOf(root)], { min: 2 });

  const textNames = usage.texts.map((t) => t.name);
  // All spans live under `Title` containers: the context keyword grades each
  // recurring style into its M3 slot name (22 -> Large, 16 -> Medium, 14 -> Small).
  assert.ok(textNames.includes('TitleLarge'), 'TitleLarge expected');
  assert.ok(textNames.includes('TitleMedium'), 'TitleMedium expected');
  assert.ok(textNames.includes('TitleSmall'), 'TitleSmall expected');
  // No keyword class -> explicit pattern names; the graded path is not mixed with it.
  assert.ok(!textNames.includes('Inter Text 14'), 'graded style must not fall back to the pattern name');
  const large = usage.texts.find((t) => t.name === 'TitleLarge');
  assert.ok(large);
  assert.equal(large.fontSize, 22);
  assert.equal(large.fontWeight, 700);
});

test('number naming distinguishes gap vs padding dominance', () => {
  // value 12: used as gap on 3 nodes and as padding on 1 -> gap wins.
  const gapped = (id: string): ReturnType<typeof frameNode> =>
    frameNode(id, 'List', { layoutMode: 'VERTICAL', itemSpacing: 12, fills: [] });
  const padded = (id: string): ReturnType<typeof frameNode> =>
    frameNode(id, 'Detail', {
      layoutMode: 'VERTICAL',
      paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12,
      fills: [],
    });
  const root = frameNode('root', 'Sp', { layoutMode: 'VERTICAL', fills: [] }, [
    gapped('g1'), gapped('g2'), gapped('g3'), padded('p1'),
  ]);
  const usage = collectUsageTokens([docOf(root)], { min: 2 });
  const names = usage.numbers.map((c) => c.name);
  assert.ok(names.includes('List Gap 12'));
  assert.ok(!names.includes('List Padding 12'));
  assert.ok(!names.includes('Spacing 12'));
});

test('fractional dp values keep a distinct, non-ambiguous word', () => {
  const gapped = (id: string): ReturnType<typeof frameNode> =>
    frameNode(id, 'List', { layoutMode: 'VERTICAL', itemSpacing: 10.5, fills: [] });
  const root = frameNode('root', 'Sp', { layoutMode: 'VERTICAL', fills: [] }, [gapped('a'), gapped('b')]);
  const usage = collectUsageTokens([docOf(root)], { min: 2 });
  const names = usage.numbers.map((c) => c.name);
  assert.ok(names.includes('List Gap 10V5'));
});

test('usage harvest is deterministic across runs', () => {
  const doc = docOf(cardsFixture(3));
  const a = JSON.stringify(collectUsageTokens([doc], { min: 2 }));
  const b = JSON.stringify(collectUsageTokens([doc], { min: 2 }));
  assert.equal(a, b);
});

test('color keys quantize to the emitted ARGB byte level', () => {
  assert.equal(colorKeyOf({ r: 1, g: 1, b: 1, a: 1 }), '#FFFFFFFF');
  assert.equal(colorKeyOf({ r: 0.4, g: 0.4, b: 0.4, a: 1 }), '#FF666666');
  assert.equal(colorKeyOf({ r: 0.5, g: 0, b: 0, a: 0.5 }), '#80800000');
  // Channels that round to the same byte emit the same Kotlin literal and
  // must therefore share one key.
  assert.equal(
    colorKeyOf({ r: 0.199, g: 0.2, b: 0.3, a: 1 }),
    colorKeyOf({ r: 0.1999, g: 0.2, b: 0.3, a: 1 }),
  );
});

test('number and text keys are quantized and comparable', () => {
  assert.equal(numberKeyOf(16), '16');
  assert.equal(numberKeyOf(16.25), '16.25');
  assert.equal(textKeyOf({ fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeight: null, letterSpacing: null }),
    'Inter|14|400|-|-');
});

/* ---------------------------------------------------------------------------
 * end-to-end: DS files + screens referencing the tokens
 * ------------------------------------------------------------------------- */

interface E2E {
  screen: string;
  ds: string;
  dsFiles: string[];
  usage: UsageHarvest;
}

function runPipeline(root: ReturnType<typeof frameNode>, min: number, structure: 'object' | 'material', harvestOverride?: DesignSystemInput): E2E {
  const doc = docOf(root);
  const usage = collectUsageTokens([doc], { min });
  const harvested = harvestOverride ?? { ...emptyDesignSystemInput(), structure };
  const merged = mergeDesignSystemInput(harvested, usage);
  merged.structure = structure;
  const dsResult = buildDesignSystem(merged, 'com.example.app');
  const resolvers = buildUsageResolvers(usage, harvested, dsResult.symbols);
  const result = generateCode([doc], { packageName: 'com.example.app', profile: null, usage: resolvers });
  const screen = result.files.find((f) => f.path === 'LoginScreen.kt')?.content ?? '';
  const ds = dsResult.files.find((f) => f.path === 'DesignSystem.kt')?.content ?? '';
  return { screen, ds, dsFiles: dsResult.files.map((f) => f.path), usage };
}

test('screens emit slot-correct token references; one-off values stay literal', () => {
  const { screen, ds } = runPipeline(cardsFixture(3), 2, 'object');

  // design system carries the tokens inside the accessor object
  assert.match(ds, /val CardSurface = Color\(0xFFFFFFFF\)/);
  assert.match(ds, /\/\*\* Recurring value `Card Surface`/);

  // gaps: the card's internal 8 gap resolves; the root's one-off 16 stays literal
  assert.match(screen, /verticalArrangement = Arrangement\.spacedBy\(DesignSystem\.Metrics\.CardGap8\)/);
  assert.ok(!screen.includes('CardGap16'), 'one-off root gap must stay a dp literal');
  assert.match(screen, /verticalArrangement = Arrangement\.spacedBy\(16\.dp\)/);

  // paddings + radius
  assert.match(screen, /padding\(all = DesignSystem\.Metrics\.CardPadding16\)/);
  assert.match(screen, /padding\(all = 24\.dp\)/);
  assert.match(screen, /RoundedCornerShape\(DesignSystem\.Metrics\.CardRadius12\)/);

  // colors
  assert.match(screen, /background\(color = DesignSystem\.Colors\.CardSurface/);
  assert.match(screen, /background\(color = Color\(0xFFF5F5F5\)/); // one-off root bg stays literal

  // text style: repeated 14sp body -> token; one-off color + size stay literal
  assert.match(screen, /style = DesignSystem\.Type\.CardText14/);
  assert.ok(!screen.includes('style = TextStyle(fontSize = 14.sp'));
});

test('material mode keeps the qualified references and adds Theme.kt', () => {
  const { screen, dsFiles } = runPipeline(cardsFixture(3), 2, 'material');
  // No split token files anywhere: the object file plus the theme artifact.
  assert.deepEqual(dsFiles, ['DesignSystem.kt', 'DesignSystem/Theme.kt']);
  assert.match(screen, /background\(color = DesignSystem\.Colors\.CardSurface/);
  assert.match(screen, /style = DesignSystem\.Type\.CardText14/);
});

test('variable token fallback: exact-value colors resolve to the harvested token', () => {
  const harvested = emptyDesignSystemInput();
  harvested.colors = [{ name: 'Brand/Primary', source: 'variable', rgba: { r: 0, g: 0, b: 1, a: 1 } }];
  const blue = { r: 0, g: 0, b: 1, a: 1 };
  const nodes = [0, 1].map((i) =>
    frameNode(`sq${i}`, 'Badge', { width: 24, height: 24, fills: [{ type: 'SOLID', color: blue, opacity: 1 }] }));
  const { screen, ds } = runPipeline(
    frameNode('root', 'LoginScreen', { layoutMode: 'VERTICAL', fills: [], width: 120, height: 40 }, nodes),
    99,
    'object',
    harvested,
  );
  // usage tokens were skipped (min 99), the exact-value variable token still wins.
  assert.match(ds, /val BrandPrimary = Color\(0xFF0000FF\)/);
  assert.match(screen, /background\(color = DesignSystem\.Colors\.BrandPrimary/);
  assert.ok(!screen.includes('Color(0xFF0000FF)'));
});

test('mode wrappers: exact-value ties prefer the collection default mode', () => {
  const harvested = emptyDesignSystemInput();
  // Collection 'Theme' carries Light (default) and Dark modes for the same
  // variable; repeated black screens must reference the default (Light) val.
  harvested.colors = [
    { name: 'Theme/surface', source: 'variable', rgba: { r: 0, g: 0, b: 0, a: 1 }, group: 'Light', groupDefault: true },
    { name: 'Theme/surface', source: 'variable', rgba: { r: 1, g: 1, b: 1, a: 1 }, group: 'Dark' },
  ];
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const nodes = [0, 1].map((i) =>
    frameNode(`sq${i}`, 'Tile', { width: 24, height: 24, fills: [{ type: 'SOLID', color: black, opacity: 1 }] }));
  const { screen, ds } = runPipeline(
    frameNode('root', 'LoginScreen', { layoutMode: 'VERTICAL', fills: [], width: 120, height: 40 }, nodes),
    99,
    'object',
    harvested,
  );
  // Both wrappers keep every value; the screen picks the default mode's.
  assert.match(ds, /object Dark \{\n {12}\/\*\* Figma variable `Theme\/surface` — `Dark` mode\. \*\/\n {12}val ThemeSurface = Color\(0xFFFFFFFF\)/);
  assert.match(ds, /object Light \{\n {12}\/\*\* Figma variable `Theme\/surface` — `Light` mode\. \*\/\n {12}val ThemeSurface = Color\(0xFF000000\)/);
  assert.match(screen, /background\(color = DesignSystem\.Colors\.Light\.ThemeSurface/);
  assert.doesNotMatch(screen, /DesignSystem\.Colors\.Dark\.ThemeSurface/);
});
