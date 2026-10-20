import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesignSystem,
  colorRoleFor,
  dsPercentToSp,
  numberUnitFor,
  textStyleSlotFor,
  type DsBoolToken,
  type DsColorToken,
  type DsNumberToken,
  type DsStringToken,
  type DsSkip,
  type DsTextToken,
  type DesignSystemInput,
} from '../src/gen/designsystem.ts';

type Built = ReturnType<typeof buildDesignSystem>;

/** Fetch one result file by its exact ZIP path. */
function fileBy(result: Built, path: string): { path: string; content: string; language: string } | undefined {
  return result.files.find((f) => f.path === path);
}

/** Blank input; pass partial sections (and `structure`) for the fields under test. */
function emptyInput(partial: Partial<DesignSystemInput> = {}): DesignSystemInput {
  return {
    colors: [],
    texts: [],
    numbers: [],
    strings: [],
    bools: [],
    skipped: [],
    ...partial,
  };
}

/* ---------------------------------------------------------------------------
 * name flattening, collisions, deterministic order
 * ------------------------------------------------------------------------- */

test('paths flatten to PascalCase symbols with distinct variables first', () => {
  const input = emptyInput({
    numbers: [{ name: 'Spacing/small', source: 'variable', value: 4 }],
    colors: [{ name: 'brand/primary', source: 'variable', rgba: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  const result = buildDesignSystem(input, 'com.example.app');
  assert.match(fileBy(result, 'DesignSystem.kt')?.content ?? '', /val BrandPrimary = Color\(0xFF000000\)/);
  assert.match(fileBy(result, 'DesignSystem.kt')?.content ?? '', /val SpacingSmall = 4\.dp/);
});

test('name collisions suffix within a scope; other sections keep the plain symbol', () => {
  const color: DsColorToken = { name: 'Brand/Primary', source: 'variable', rgba: { r: 0, g: 0, b: 1, a: 1 } };
  const styleColor: DsColorToken = { name: 'Brand/Primary', source: 'paint style', rgba: { r: 1, g: 0, b: 0, a: 1 } };
  const number: DsNumberToken = { name: 'Brand/Primary', source: 'variable', value: 1 };
  const first = buildDesignSystem(emptyInput({ colors: [color, styleColor], numbers: [number] }), 'x');
  const second = buildDesignSystem(emptyInput({ colors: [color, styleColor], numbers: [number] }), 'x');
  assert.deepEqual(first.files, second.files); // deterministic (whole set byte-equal)
  const colorContent = fileBy(first, 'DesignSystem.kt')?.content ?? '';
  const metricsContent = fileBy(first, 'DesignSystem.kt')?.content ?? '';
  // Same scope (object Colors): the variable wins the plain name; style gets 2.
  assert.match(colorContent, /\/\*\* Figma variable `Brand\/Primary`\.\s*\*\/\n {8}val BrandPrimary = Color\(0xFF0000FF\)/);
  assert.match(colorContent, /val BrandPrimary2 = Color\(0xFFFF0000\)/);
  // Different scope (object Metrics): Kotlin separates them, so no suffix.
  assert.match(metricsContent, /val BrandPrimary = 1\.dp/);
});

test('leading digits are X-prefixed via pascalCase and KDoc keeps paths', () => {
  const input = emptyInput({ numbers: [{ name: '8grid/base', source: 'variable', value: 8 }] });
  const result = buildDesignSystem(input, 'x');
  assert.match(fileBy(result, 'DesignSystem.kt')?.content ?? '', /val X8gridBase = 8\.dp/);
});

test('section wrapper prefixes are dropped from symbols, kept in KDoc', () => {
  const input = emptyInput({
    colors: [
      { name: 'Color/Base/Black', source: 'paint style', rgba: { r: 0, g: 0, b: 0, a: 1 } },
      { name: 'color/brand/primary', source: 'variable', rgba: { r: 1, g: 0, b: 0, a: 1 } },
      { name: 'Color/Primary', source: 'variable', rgba: { r: 0, g: 0, b: 1, a: 1 } },
      { name: 'Primary', source: 'paint style', rgba: { r: 1, g: 1, b: 0, a: 1 } },
    ],
    texts: [{ name: 'Type/Title', source: 'text style', fontFamily: 'Inter', fontSize: 14, fontWeight: 400, lineHeight: 20, letterSpacing: null, textAlign: null }],
    numbers: [{ name: 'Metrics/Spacing/x', source: 'variable', value: 4 }],
    strings: [{ name: 'Strings/label', source: 'variable', value: 'Tap' }],
    bools: [{ name: 'Booleans/flag', source: 'variable', value: true }],
  });
  const result = buildDesignSystem(input, 'x');
  const content = fileBy(result, 'DesignSystem.kt')!.content;
  // The wrapper word survives only in the KDoc, never in the symbol.
  assert.match(content, /\/\*\* Figma paint style `Color\/Base\/Black`\. \*\/\n {8}val BaseBlack = Color\(0xFF000000\)/);
  assert.doesNotMatch(content, /ColorBaseBlack|val TypeTitle|val StringsLabel|val BooleansFlag/);
  assert.match(content, /val BrandPrimary = Color\(0xFFFF0000\)/);
  // Collision suffixing still applies after stripping (variable before style).
  assert.match(content, /val Primary = Color\(0xFF0000FF\)/);
  assert.match(content, /val Primary2 = Color\(0xFFFFFF00\)/);
  assert.match(content, /val Title = TextStyle/);
  assert.match(content, /val SpacingX = 4\.dp/);
  assert.match(content, /val Label = "Tap"/);
  assert.match(content, /val Flag = true/);
});

test('font-weight variables become FontWeight vals and back matching text styles', () => {
  const texts: DsTextToken[] = [
    { name: 'Type/Title', source: 'text style', fontFamily: 'Inter', fontSize: 24, fontWeight: 700, lineHeight: 32, letterSpacing: null, textAlign: null },
    { name: 'Type/Body', source: 'text style', fontFamily: 'Inter', fontSize: 14, fontWeight: 500, lineHeight: 20, letterSpacing: null, textAlign: null },
    { name: 'Type/Caption', source: 'text style', fontFamily: 'Inter', fontSize: 12, fontWeight: 600, lineHeight: 16, letterSpacing: null, textAlign: null },
  ];
  const numbers: DsNumberToken[] = [
    { name: 'Font/Weight/Bold', source: 'variable', value: 700 },
    { name: 'Font/Weight/Fancy', source: 'variable', value: 650 },
    { name: 'Font/Weight/Off', source: 'variable', value: 1.5 }, // not a weight-domain integer -> stays a number
  ];
  const result = buildDesignSystem(emptyInput({ texts, numbers }), 'x');
  const content = fileBy(result, 'DesignSystem.kt')!.content;
  const typeSection = content.slice(content.indexOf('object Type {'), content.indexOf('object Metrics {'));
  // Weights are foundation vals ahead of the text styles; standard values
  // read as class aliases, custom values stay exact FontWeight(n).
  assert.match(typeSection, /val WeightBold = FontWeight\.Bold/);
  assert.match(typeSection, /val WeightFancy = FontWeight\(650\)/);
  assert.ok(typeSection.indexOf('val WeightBold') < typeSection.indexOf('val Title = TextStyle'));
  // Exact-value matches reference the weight variable; without a match the
  // hard-coded class expression is unchanged.
  assert.match(typeSection, /val Title = TextStyle\(\n {12}fontSize = 24\.sp,\n {12}fontWeight = WeightBold,/);
  assert.match(typeSection, /fontWeight = FontWeight\.W500,/);
  assert.match(typeSection, /fontWeight = FontWeight\.W600,/);
  // The out-of-domain value never entered the Type section.
  assert.match(content, /object Metrics \{\n[\s\S]*?val FontWeightOff = 1\.5\.sp/);
  assert.doesNotMatch(typeSection, /WeightOff/);
  // Material theme slots stay self-contained: direct values, no token refs.
  const material = buildDesignSystem(emptyInput({ texts, numbers, structure: 'material' }), 'x');
  const theme = fileBy(material, 'DesignSystem/Theme.kt')!.content;
  assert.doesNotMatch(theme, /WeightBold|WeightFancy/);
  assert.match(theme, /fontWeight = FontWeight\.Bold,/);
});

/* ---------------------------------------------------------------------------
 * units: dp vs sp heuristic, percent -> sp
 * ------------------------------------------------------------------------- */

test('typography-hinting paths become sp, spacing paths stay dp', () => {
  const number: DsNumberToken = { name: 'Typography/body-size', source: 'variable', value: 16 };
  const spacing: DsNumberToken = { name: 'Spacing/medium', source: 'variable', value: 12 };
  const leading: DsNumberToken = { name: 'Type/line-height', source: 'variable', value: 1.2 };
  const result = buildDesignSystem(emptyInput({ numbers: [number, spacing, leading] }), 'x');
  const content = fileBy(result, 'DesignSystem.kt')?.content ?? '';
  assert.match(content, /val SpacingMedium = 12\.dp/);
  assert.match(content, /val TypographyBodySize = 16\.sp/);
  assert.match(content, /val TypeLineHeight = 1\.2\.sp/);
});

test('multi-mode collections nest same-named variables into mode wrappers', () => {
  const input = emptyInput({
    colors: [
      { name: 'Theme/bg', source: 'variable', rgba: { r: 1, g: 1, b: 1, a: 1 }, group: 'Light', groupDefault: true },
      { name: 'Theme/bg', source: 'variable', rgba: { r: 0, g: 0, b: 0, a: 1 }, group: 'Dark' },
      { name: 'Standalone/accent', source: 'variable', rgba: { r: 0, g: 0, b: 1, a: 1 } },
    ],
    strings: [
      { name: 'Theme/cta', source: 'variable', value: 'Go', group: 'Light', groupDefault: true },
      { name: 'Theme/cta', source: 'variable', value: 'RUN', group: 'Dark' },
    ],
    numbers: [{ name: 'Spacing/md', source: 'variable', value: 16 }],
  });
  const result = buildDesignSystem(input, 'x');
  const content = fileBy(result, 'DesignSystem.kt')!.content;
  // Ungrouped tokens sit at the section root; the two `Theme/bg` values
  // become wrapper objects — same symbol, no suffixing across wrappers.
  assert.match(content, /object Colors \{\n {8}\/\*\* Figma variable `Standalone\/accent`\. \*\/\n {8}val StandaloneAccent = Color\(0xFF0000FF\)\n\n {8}object Dark \{\n {12}\/\*\* Figma variable `Theme\/bg` — `Dark` mode\. \*\/\n {12}val ThemeBg = Color\(0xFF000000\)\n {8}\}\n\n {8}object Light \{\n {12}\/\*\* Figma variable `Theme\/bg` — `Light` mode\. \*\/\n {12}val ThemeBg = Color\(0xFFFFFFFF\)\n {8}\}\n {4}\}/u);
  assert.doesNotMatch(content, /ThemeBg2/);
  // Strings nest under their own mode wrappers the same way.
  assert.match(content, /object Strings \{\n {8}object Dark \{\n {12}\/\*\* Figma variable `Theme\/cta` — `Dark` mode\. \*\/\n {12}val ThemeCta = "RUN"\n {8}\}\n\n {8}object Light \{\n {12}\/\*\* Figma variable `Theme\/cta` — `Light` mode\. \*\/\n {12}val ThemeCta = "Go"\n {8}\}\n {4}\}/u);
  // The default mode's wrapper is emitted beside the others (alphabetical
  // wrapper order, Dark before Light).
  const darkAt = content.indexOf('object Dark');
  const lightAt = content.indexOf('object Light');
  assert.ok(darkAt < lightAt && darkAt > content.indexOf('object Colors'));
});

test('wrapper names dodge section-root vals with the same symbol', () => {
  const input = emptyInput({
    colors: [
      { name: 'colors/Dark', source: 'variable', rgba: { r: 0, g: 0, b: 0, a: 1 } },
      { name: 'Theme/bg', source: 'variable', rgba: { r: 1, g: 1, b: 1, a: 1 }, group: 'Dark', groupDefault: true },
    ],
  });
  const content = fileBy(buildDesignSystem(input, 'x'), 'DesignSystem.kt')!.content;
  assert.match(content, /object Colors \{\n {8}\/\*\* Figma variable `colors\/Dark`\. \*\/\n {8}val Dark = Color\(0xFF000000\)\n\n {8}object Dark2 \{\n {12}\/\*\* Figma variable `Theme\/bg` — `Dark` mode\. \*\/\n {12}val ThemeBg = Color\(0xFFFFFFFF\)\n {8}\}\n {4}\}/u);
});

test('material slots prefer the collection default mode over alphabetical order', () => {
  const input = emptyInput({
    colors: [
      { name: 'Theme/primary', source: 'variable', rgba: { r: 1, g: 0, b: 0, a: 1 }, group: 'Light', groupDefault: true },
      { name: 'Theme/primary', source: 'variable', rgba: { r: 0, g: 0, b: 1, a: 1 }, group: 'Dark' },
    ],
    structure: 'material',
  });
  const theme = fileBy(buildDesignSystem(input, 'x'), 'DesignSystem/Theme.kt')!.content;
  // 'Dark' would sort first alphabetically; the default (Light) value wins.
  assert.match(theme, /primary = Color\(0xFFFF0000\),/);
  assert.doesNotMatch(theme, /primary = Color\(0xFF0000FF\)/);
});

test('weight refs stay wrapper-aware across mode groups', () => {
  const input = emptyInput({
    numbers: [
      { name: 'Font/Weight/Headline', source: 'variable', value: 700, group: 'Light', groupDefault: true },
      { name: 'Font/Weight/Headline', source: 'variable', value: 900, group: 'Dark' },
    ],
    texts: [
      { name: 'Type/Title', source: 'text style', fontFamily: 'Inter', fontSize: 24, fontWeight: 700, lineHeight: 32, letterSpacing: null, textAlign: null },
    ],
  });
  const content = fileBy(buildDesignSystem(input, 'x'), 'DesignSystem.kt')!.content;
  // The text style sits at the Type root and qualifies the weight through
  // the Light wrapper (the matching 700 val lives there). Root text vals
  // are at 8 spaces; wrapper member vals sit one level deeper (12).
  assert.match(content, /val Title = TextStyle\(\n {12}fontSize = 24\.sp,\n {12}fontWeight = Light\.WeightHeadline,/);
  assert.match(content, /object Dark \{\n {12}\/\*\* Figma variable `Font\/Weight\/Headline` — `Dark` mode\. \*\/\n {12}val WeightHeadline = FontWeight\.Black\n {8}\}\n\n {8}object Light \{\n {12}\/\*\* Figma variable `Font\/Weight\/Headline` — `Light` mode\. \*\/\n {12}val WeightHeadline = FontWeight\.Bold\n {8}\}\n {4}\}/u);
  assert.doesNotMatch(content, /WeightHeadline2/);
});

test('numberUnitFor covers the documented keyword hint family', () => {
  assert.equal(numberUnitFor('Type/Size'), 'sp');
  assert.equal(numberUnitFor('font/weight'), 'sp');
  assert.equal(numberUnitFor('Type/letter-spacing'), 'sp');
  assert.equal(numberUnitFor('leading tokens'), 'sp');
  assert.equal(numberUnitFor('Spacing/gap'), 'dp');
  assert.equal(numberUnitFor('Radius/md'), 'dp');
});

test('percent spacings resolve against the font size; unknown sizes fail', () => {
  assert.equal(dsPercentToSp(50, 20), 10);
  assert.equal(dsPercentToSp(120, 12.5), 15);
  assert.equal(dsPercentToSp(50, null), null);
  assert.equal(dsPercentToSp(Number.NaN, 20), null);
});

/* ---------------------------------------------------------------------------
 * text style emission
 * ------------------------------------------------------------------------- */

test('text styles emit a full TextStyle val with sp values and named weights', () => {
  const token: DsTextToken = {
    name: 'Type/Title',
    source: 'text style',
    fontFamily: 'Acme Serif Pro',
    fontSize: 24,
    fontWeight: 700,
    lineHeight: 32,
    letterSpacing: 0.4,
    textAlign: 'CENTER',
  };
  const result = buildDesignSystem(emptyInput({ texts: [token] }), 'x');
  assert.deepEqual(result.diagnostics, []);
  const content = fileBy(result, 'DesignSystem.kt')?.content ?? '';
  assert.match(content, /val Title = TextStyle\(\n {12}fontSize = 24\.sp,\n {12}fontWeight = FontWeight\.Bold,\n {12}fontFamily = FontFamily\.Serif, \/\/ Acme Serif Pro\n {12}lineHeight = 32\.sp,\n {12}letterSpacing = 0\.4\.sp,\n {12}textAlign = TextAlign\.Center,\n {8}\)/);
});

test('family classification picks Monospace/Serif/Cursive/Default by name', () => {
  const mk = (family: string): DsTextToken => ({
    name: family,
    source: 'text style',
    fontFamily: family,
    fontSize: 10,
    fontWeight: 400,
    lineHeight: null,
    letterSpacing: null,
    textAlign: null,
  });
  const result = buildDesignSystem(emptyInput({
    texts: [mk('JetBrains Mono Extra'), mk('Lora Serif'), mk('Cursive Demo'), mk('Inter')],
  }), 'x');
  const content = fileBy(result, 'DesignSystem.kt')?.content ?? '';
  assert.match(content, /fontFamily = FontFamily\.Monospace, \/\/ JetBrains Mono Extra/);
  assert.match(content, /fontFamily = FontFamily\.Serif, \/\/ Lora Serif/);
  assert.match(content, /fontFamily = FontFamily\.Cursive, \/\/ Cursive Demo/);
  assert.match(content, /fontFamily = FontFamily\.Default, \/\/ Inter/);
});

test('sans+serif composite names classify as Default, empty texts keep imports out', () => {
  const result = buildDesignSystem(emptyInput({
    texts: [{
      name: 'Odd',
      source: 'text style',
      fontFamily: 'Sans Serif Fallback',
      fontSize: 10,
      fontWeight: null,
      lineHeight: null,
      letterSpacing: null,
      textAlign: null,
    }],
  }), 'x');
  const content = fileBy(result, 'DesignSystem.kt')?.content ?? '';
  assert.match(content, /fontFamily = FontFamily\.Default, \/\/ Sans Serif Fallback/);
  assert.doesNotMatch(content, /FontWeight\./); // weight null -> no FontWeight import
});

/* ---------------------------------------------------------------------------
 * colors, gradients, strings, booleans
 * ------------------------------------------------------------------------- */

test('color channels bake alpha into one AARRGGBB literal', () => {
  const token: DsColorToken = { name: 'c', source: 'variable', rgba: { r: 1, g: 0.25, b: 0, a: 0.5 } };
  const result = buildDesignSystem(emptyInput({ colors: [token] }), 'x');
  assert.match(fileBy(result, 'DesignSystem.kt')?.content ?? '', /val C = Color\(0x80FF4000\)/);
});

test('strings and booleans emit simple escaped vals', () => {
  const string: DsStringToken = { name: 'copy/hello "world"', source: 'variable', value: 'Hi\n"tab"' };
  const bool: DsBoolToken = { name: 'flags/new-nav', source: 'variable', value: true };
  const result = buildDesignSystem(emptyInput({ strings: [string], bools: [bool] }), 'x');
  assert.match(fileBy(result, 'DesignSystem.kt')?.content ?? '', /val CopyHelloWorld = "Hi\\n\\"tab\\""/);
  assert.match(fileBy(result, 'DesignSystem.kt')?.content ?? '', /val FlagsNewNav = true/);
});

/* ---------------------------------------------------------------------------
 * diagnostics: skips, multi-mode collapse, empty input
 * ------------------------------------------------------------------------- */

test('empty input yields no files and one DS-EMPTY INFO diagnostic', () => {
  const { files, diagnostics } = buildDesignSystem(emptyInput(), 'x');
  assert.deepEqual(files, []);
  assert.deepEqual(diagnostics, [{
    level: 'INFO',
    code: 'DS-EMPTY',
    message: 'No representable design-system tokens were found; DesignSystem.kt was not generated.',
  }]);
});

test('every skip becomes an honest DS-* diagnostic, mode notes collapse', () => {
  const skipped: DsSkip[] = [
    { reason: 'skipped', name: 'photo', detail: 'image paint' },
    { reason: 'gradient', name: 'hero', detail: 'first color stop' },
    { reason: 'alias', name: 'Brand/Primary', detail: 'target missing' },
    { reason: 'mode', name: 'Theming', detail: '3 modes' },
    { reason: 'alias', name: 'Brand/Secondary', detail: 'target missing' },
  ];
  const { files, diagnostics } = buildDesignSystem(emptyInput({ skipped }), 'x');
  assert.deepEqual(files, []);
  // mode (INFO) first, then aliases in sorted order, then gradient, then skips.
  const codes = diagnostics.map((d) => d.code);
  assert.deepEqual(codes, ['DS-MODES', 'DS-ALIAS', 'DS-ALIAS', 'DS-GRADIENT', 'DS-SKIPPED', 'DS-EMPTY']);
  assert.equal(diagnostics[0]!.level, 'INFO');
  assert.match(diagnostics[0]!.message, /split per mode into wrapper objects \(3 modes\)/);
  assert.equal(diagnostics[4]!.level, 'WARNING');
  assert.match(diagnostics[4]!.message, /image paint/);
});

test('skips alongside tokens still produce files (data is never dropped)', () => {
  const skipped: DsSkip[] = [{ reason: 'skipped', name: 'Card/shadow', detail: 'effect style' }];
  const color: DsColorToken = { name: 'Vendor/Blue', source: 'paint style', rgba: { r: 0, g: 0, b: 1, a: 1 } };
  const { files, diagnostics } = buildDesignSystem(emptyInput({ colors: [color], skipped }), 'x');
  assert.equal(files.length, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, 'DS-SKIPPED');
  assert.equal(files[0]!.path, 'DesignSystem.kt');
  assert.match(files[0]!.content, /val VendorBlue = Color\(0xFF0000FF\)/);
});

/* ---------------------------------------------------------------------------
 * file layout: one accessor object, sections, imports, determinism
 * ------------------------------------------------------------------------- */

test('the object file lists populated sections in a fixed order (empty ones fold away)', () => {
  const input: DesignSystemInput = {
    colors: [{ name: 'Brand/Red', source: 'variable', rgba: { r: 1, g: 0, b: 0, a: 1 } }],
    texts: [{
      name: 'Type/Body',
      source: 'text style',
      fontFamily: 'Inter',
      fontSize: 14,
      fontWeight: 500,
      lineHeight: 20,
      letterSpacing: null,
      textAlign: 'JUSTIFIED',
    }],
    numbers: [
      { name: 'Spacing-md', source: 'variable', value: 8 },
      { name: 'Size-base', source: 'variable', value: 4 },
    ],
    strings: [{ name: 'label/action', source: 'variable', value: 'Tap' }],
    bools: [],
    skipped: [],
  };
  const result = buildDesignSystem(input, 'com.acme.app');
  assert.deepEqual(result.files.map((f) => f.path), ['DesignSystem.kt']);
  const file = result.files[0]!;
  assert.equal(file.language, 'kotlin');
  assert.match(file.content, /^\/\/ Generated by Compose Studio/u);
  assert.match(file.content, /not edit by hand/u);
  assert.match(file.content, /\npackage com\.acme\.app\n/u);
  // Sections appear in the fixed order; the empty Booleans family folds away.
  const sections = [...file.content.matchAll(/\n {4}object (Colors|Type|Metrics|Strings|Booleans) \{/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['Colors', 'Type', 'Metrics', 'Strings']);
  // Unioned import hygiene: KotlinFile's collation (localeCompare('en')).
  const imports: string[] = [...(file.content.match(/^import .*$/gm) ?? [])];
  assert.deepEqual(imports, [...imports].sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(imports.some((i) => i.includes('TextDecoration')), false);
  assert.ok(imports.includes('import androidx.compose.ui.graphics.Color'));
  assert.ok(imports.includes('import androidx.compose.ui.text.TextStyle'));
  assert.ok(imports.includes('import androidx.compose.ui.text.font.FontWeight'));
  assert.ok(imports.includes('import androidx.compose.ui.text.font.FontFamily'));
  assert.ok(imports.includes('import androidx.compose.ui.text.style.TextAlign'));
  assert.ok(imports.includes('import androidx.compose.ui.unit.sp'));
  assert.ok(imports.includes('import androidx.compose.ui.unit.dp'));
});

test('strings-only input emits the accessor with the screens package and no unused imports', () => {
  const string: DsStringToken = { name: 'a', source: 'variable', value: 'one' };
  const result = buildDesignSystem(emptyInput({ strings: [string] }), 'com.acme.app');
  assert.deepEqual(result.files.map((f) => f.path), ['DesignSystem.kt']);
  const content = fileBy(result, 'DesignSystem.kt')!.content;
  assert.match(content, /package com\.acme\.app/);
  assert.doesNotMatch(content, /androidx\.compose\.ui\.graphics\.Color/);
  assert.doesNotMatch(content, /androidx\.compose\.ui\.unit\.dp/);
  assert.doesNotMatch(content, /TextStyle/);
});

/* ---------------------------------------------------------------------------
 * Material 3 slot auto-matching
 * ------------------------------------------------------------------------- */

test('color roles match by longest path-word suffix', () => {
  assert.equal(colorRoleFor('Brand/Primary'), 'primary');
  assert.equal(colorRoleFor('Colors/On Primary Container'), 'onPrimaryContainer');
  assert.equal(colorRoleFor('Semantic/onSurfaceVariant'), 'onSurfaceVariant');
  assert.equal(colorRoleFor('Dashboard/Error'), 'error');
  assert.equal(colorRoleFor('Layers/Surface Variant'), 'surfaceVariant');
  assert.equal(colorRoleFor('Misc/Scrim'), 'scrim');
  assert.equal(colorRoleFor('Dark Mode/inverse-surface'), 'inverseSurface');
  // Not a role: stays a plain val (conservative, additive matching).
  assert.equal(colorRoleFor('Brand/Accent'), null);
  assert.equal(colorRoleFor('Error Red'), null);
  assert.equal(colorRoleFor('Spacing/Md'), null);
});

test('text slots match by suffix; bare keywords take the Large default', () => {
  assert.equal(textStyleSlotFor('Type/Display Large'), 'displayLarge');
  assert.equal(textStyleSlotFor('Type/Headline Small'), 'headlineSmall');
  assert.equal(textStyleSlotFor('Type/TitleMedium'), 'titleMedium');
  assert.equal(textStyleSlotFor('Text/Body Small'), 'bodySmall');
  // Bare keyword -> Large default; the last word decides, so 'Card Title'
  // (a generic title) maps too — generous but documented.
  assert.equal(textStyleSlotFor('Type/Title'), 'titleLarge');
  assert.equal(textStyleSlotFor('typography/body'), 'bodyLarge');
  assert.equal(textStyleSlotFor('Type/Card Title'), 'titleLarge');
  // No slope: stays a plain val.
  assert.equal(textStyleSlotFor('Type/Body 2'), null);
});

/* ---------------------------------------------------------------------------
 * structure modes
 * ------------------------------------------------------------------------- */

const THEME_COLORS: DsColorToken[] = [
  { name: 'Brand/Primary', source: 'variable', rgba: { r: 0.3, g: 0.2, b: 0.9, a: 1 } },
  { name: 'Brand/On Primary', source: 'variable', rgba: { r: 1, g: 1, b: 1, a: 1 } },
  { name: 'Brand/Accent (unmatched)', source: 'variable', rgba: { r: 1, g: 0, b: 0, a: 1 } },
];

const THEME_TEXTS: DsTextToken[] = [
  {
    name: 'Type/Title Large',
    source: 'text style',
    fontFamily: 'Inter',
    fontSize: 24,
    fontWeight: 700,
    lineHeight: 32,
    letterSpacing: null,
    textAlign: null,
  },
  {
    name: 'Type/Custom Caption',
    source: 'text style',
    fontFamily: 'Inter',
    fontSize: 11,
    fontWeight: 400,
    lineHeight: null,
    letterSpacing: null,
    textAlign: null,
  },
];

test('material structure adds Theme.kt with direct values; unmatched tokens stay vals', () => {
  const result = buildDesignSystem(emptyInput({ colors: THEME_COLORS, texts: THEME_TEXTS, structure: 'material' }), 'x');
  assert.deepEqual(result.files.map((f) => f.path), [
    'DesignSystem.kt',
    'DesignSystem/Theme.kt',
  ]);
  const theme = fileBy(result, 'DesignSystem/Theme.kt')!.content;
  // Roles are assigned DIRECTLY (resolved values), one per line, trailing commas.
  assert.match(theme, /val AppColorScheme = lightColorScheme\(\n {4}primary = Color\(0xFF4D33E6\),\n {4}onPrimary = Color\(0xFFFFFFFF\),\n\)/);
  // Typography slots inline full TextStyle values (nested block, 8-space args).
  assert.match(theme, /val AppTypography = Typography\(\n {4}titleLarge = TextStyle\(\n {8}fontSize = 24\.sp,\n {8}fontWeight = FontWeight\.Bold,\n {8}fontFamily = FontFamily\.Default, \/\/ Inter\n {8}lineHeight = 32\.sp,\n {4}\),\n\)/);
  assert.match(theme, /import androidx\.compose\.material3\.lightColorScheme/);
  assert.match(theme, /import androidx\.compose\.material3\.Typography/);
  // The theme is a self-contained snapshot: it never references the token
  // symbols (no reassignment of flattened vals) and needs no cross-file import.
  assert.doesNotMatch(theme, /BrandPrimary|BrandOnPrimary|TitleLarge/);
  assert.doesNotMatch(theme, /import com\./);
  // Unmatched tokens still emitted as plain vals in the accessor sections.
  const content = fileBy(result, 'DesignSystem.kt')!.content;
  assert.match(content, /val BrandAccentUnmatched = Color/);
  assert.match(content, /val CustomCaption = TextStyle/);
  assert.doesNotMatch(theme, /DesignSystemTheme/);
});

test('material-theme structure adds the composable with conditional args', () => {
  const colors: DsColorToken[] = [{ name: 'Brand/Primary', source: 'variable', rgba: { r: 1, g: 1, b: 1, a: 1 } }];
  const texts: DsTextToken[] = [{
    name: 'Type/Body Medium',
    source: 'text style',
    fontFamily: null,
    fontSize: 14,
    fontWeight: 400,
    lineHeight: null,
    letterSpacing: null,
    textAlign: null,
  }];
  const result = buildDesignSystem(emptyInput({ colors, texts, structure: 'material-theme' }), 'x');
  assert.deepEqual(result.files.map((f) => f.path), ['DesignSystem.kt', 'DesignSystem/Theme.kt']);
  const theme = fileBy(result, 'DesignSystem/Theme.kt')!.content;
  assert.match(theme, /@Composable\nfun DesignSystemTheme\(content: @Composable \(\) -> Unit\) \{\n {4}MaterialTheme\(colorScheme = AppColorScheme, typography = AppTypography, content = content\)\n\}/);
  assert.match(theme, /import androidx\.compose\.material3\.MaterialTheme/);
  assert.match(theme, /import androidx\.compose\.runtime\.Composable/);
  // Typography-only case: single conditional arg, and only its families exist.
  const textsOnly = buildDesignSystem(emptyInput({ texts, structure: 'material-theme' }), 'x'); // no color match
  assert.deepEqual(textsOnly.files.map((f) => f.path), ['DesignSystem.kt', 'DesignSystem/Theme.kt']);
  assert.match(fileBy(textsOnly, 'DesignSystem/Theme.kt')!.content, /MaterialTheme\(typography = AppTypography, content = content\)/);
});

test('object structure wraps everything in one DesignSystem accessor', () => {
  const numbers: DsNumberToken[] = [{ name: 'Spacing/md', source: 'variable', value: 16 }];
  const strings: DsStringToken[] = [{ name: 'copy/action', source: 'variable', value: 'Add' }];
  const bools: DsBoolToken[] = [{ name: 'flag/pub', source: 'variable', value: false }];
  const result = buildDesignSystem(emptyInput({ colors: THEME_COLORS, texts: THEME_TEXTS, numbers, strings, bools, structure: 'object' }), 'x');
  assert.deepEqual(result.files.map((f) => f.path), ['DesignSystem.kt']); // an object cannot span files
  const content = fileBy(result, 'DesignSystem.kt')!.content;
  assert.match(content, /\nobject DesignSystem \{\n/u);
  assert.match(content, /\n {4}object Colors \{\n[\s\S]*?\n {4}\}\n\n {4}object Type \{\n/u);
  assert.match(content, /\n {4}object Metrics \{\n[\s\S]*?val SpacingMd = 16\.dp\n {4}\}\n/u);
  assert.match(content, /\n {4}object Strings \{\n[\s\S]*?val CopyAction = "Add"\n {4}\}\n/u);
  assert.match(content, /\n {4}object Booleans \{\n[\s\S]*?val FlagPub = false\n {4}\}\n\}\n/u);
  assert.match(content, /val BrandPrimary = Color\(0xFF4D33E6\)/);
  assert.match(content, /val CopyAction = "Add"/);
  // Object structure has no Material artifacts.
  assert.doesNotMatch(content, /AppColorScheme|DesignSystemTheme/);
});

test('empty-material mode adds nothing (Theme.kt only when something matched)', () => {
  const colors: DsColorToken[] = [{ name: 'Brand/Accent', source: 'variable', rgba: { r: 0, g: 0, b: 0, a: 1 } }];
  const texts: DsTextToken[] = [{
    name: 'Type/Caption X',
    source: 'text style',
    fontFamily: 'Inter',
    fontSize: 10,
    fontWeight: 400,
    lineHeight: null,
    letterSpacing: null,
    textAlign: null,
  }];
  const defaultResult = buildDesignSystem(emptyInput({ colors, texts }), 'x');
  const material = buildDesignSystem(emptyInput({ colors, texts, structure: 'material' }), 'x');
  assert.deepEqual(defaultResult.files, material.files); // byte-equal whole set
});

test('structure modes are deterministic', () => {
  const input = { colors: THEME_COLORS, texts: THEME_TEXTS, structure: 'material-theme' as const };
  const one = buildDesignSystem(emptyInput(input), 'x');
  const two = buildDesignSystem(emptyInput({ ...input }), 'x');
  assert.deepEqual(one.files, two.files);
});

test('two runs over the same input are byte-identical', () => {
  const colors: DsColorToken[] = [
    { name: 'b/one', source: 'variable', rgba: { r: 1, g: 1, b: 1, a: 1 } },
    { name: 'a/one', source: 'paint style', rgba: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
    { name: 'a/one', source: 'paint style', rgba: { r: 0, g: 0, b: 0, a: 1 } },
  ];
  const texts: DsTextToken[] = [
    { name: 't/x', source: 'text style', fontFamily: 'X', fontSize: 12, fontWeight: 800, lineHeight: null, letterSpacing: null, textAlign: 'LEFT' },
    { name: 't/a', source: 'text style', fontFamily: 'A', fontSize: 12, fontWeight: 400, lineHeight: 18, letterSpacing: 1, textAlign: null },
  ];
  const numbers: DsNumberToken[] = [
    { name: 'n/beta', source: 'variable', value: 24 },
    { name: 'n/alpha', source: 'variable', value: 16 },
  ];
  const one = buildDesignSystem(emptyInput({ colors, texts, numbers }), 'same.pkg');
  const two = buildDesignSystem(emptyInput({ colors: [...colors].reverse(), texts: [...texts].reverse(), numbers: [...numbers].reverse() }), 'same.pkg');
  assert.deepEqual(one.files, two.files);
});
