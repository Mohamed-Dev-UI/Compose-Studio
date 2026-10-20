/**
 * Design-system code generation: turns already-resolved design-system tokens
 * (Figma variables and/or styles) into organized Kotlin files — one file per
 * token family under `DesignSystem/` (plus a matched-slots `Theme.kt` in the
 * material structures) so the design system stays maintainable. The `object`
 * structure mode intentionally stays a single `DesignSystem.kt` (a Kotlin
 * object cannot span files). Pure and deterministic — the figma-dependent
 * harvest lives in `main.ts` and feeds plain DTOs in; values here are final.
 *
 * Diagnostic ownership: every `DS-*` diagnostic is emitted here (including
 * those synthesized from the harvester's `skipped` list), so message shaping
 * is testable without the `figma` global.
 */
import type { GeneratedDiagnostic, GeneratedFile } from './generate.ts';
import { fontWeightExpr } from './expr.ts';
import { newKotlinFile, type KotlinFile } from './kotlin-writer.ts';
import { argbLiteral, dpLiteral, escapeKotlinString, spLiteral } from '../util/format.ts';
import { pascalCase } from '../util/identifiers.ts';

/** Where a token came from in the Figma design system. */
export type DsTokenSource = 'variable' | 'paint style' | 'text style' | 'usage';

/** (Clamped and resolved) RGBA color channels in Figma's 0..1 float range. */
export type DsRgba = { r: number; g: number; b: number; a: number };

/** Base shape every token carries: its original Figma path and its origin. */
export type DsBase = {
  /** Original Figma path, e.g. `Brand/Primary` (carried into the KDoc). */
  name: string;
  source: DsTokenSource;
  /**
   * Variable-collection mode this value was read from (e.g. `Light`, `Dark`).
   * Set only for multi-mode collections; each mode becomes a nested wrapper
   * object inside its section (`object Dark { val Background = … }`), so
   * same-named variables in different modes keep every value.
   */
  group?: string;
  /** True for the group's mode that was the collection default (slot/exact-value ties prefer it). */
  groupDefault?: boolean;
};

export type DsColorToken = DsBase & { rgba: DsRgba };
export type DsNumberToken = DsBase & { value: number };
export type DsStringToken = DsBase & { value: string };
export type DsBoolToken = DsBase & { value: boolean };

export type DsTextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';

export type DsTextToken = DsBase & {
  fontFamily: string | null;
  fontSize: number | null;
  fontWeight: number | null;
  /** Line height in sp (percent values were resolved using `fontSize`). */
  lineHeight: number | null;
  /** Letter spacing in sp (percent values were resolved using `fontSize`). */
  letterSpacing: number | null;
  textAlign: DsTextAlign | null;
};

/**
 * One design-system item the harvester could not (fully) resolve or that had
 * to be approximated. Every entry becomes a `DS-*` diagnostic; nothing is
 * silently dropped.
 */
export type DsSkip = {
  /**
   * `skipped` — unrepresentable item (WARNING, code `DS-SKIPPED`);
   * `gradient` — paint style approximated with its first stop (WARNING, code `DS-GRADIENT`);
   * `alias` — variable alias could not be applied (WARNING, code `DS-ALIAS`);
   * `mode` — a multi-mode collection's values are split into wrapper objects (INFO, code `DS-MODES`).
   */
  reason: 'skipped' | 'gradient' | 'alias' | 'mode';
  /** The affected item, as named in Figma. */
  name: string;
  /** Harvest-provided explanation woven into the diagnostic message. */
  detail: string;
};

export type DesignSystemInput = {
  colors: DsColorToken[];
  texts: DsTextToken[];
  numbers: DsNumberToken[];
  strings: DsStringToken[];
  bools: DsBoolToken[];
  skipped: DsSkip[];
  /** Output packaging; defaults to `object` when omitted. */
  structure?: DsStructure;
};

/**
 * Final Kotlin reference per token, assigned inside `buildDesignSystem`
 * (after sorting, wrapper grouping and collision suffixing): the val symbol,
 * optionally qualified through its mode wrapper (`Light.ThemeSurface`). The
 * mapper joins it as `DesignSystem.<section>.<value>`, so the design-system
 * file and the screens always agree on a full reference path.
 */
export type DsSymbolMap = WeakMap<DsBase, string>;

export type DesignSystemResult = {
  /**
   * Design-system Kotlin files — the single object-wrapped `DesignSystem.kt`
   * (plus `DesignSystem/Theme.kt` when a material structure matched at least
   * one Material 3 slot); empty when no representable tokens were found.
   */
  files: GeneratedFile[];
  diagnostics: GeneratedDiagnostic[];
  /** Final Kotlin symbol of every input token (see `DsSymbolMap`). */
  symbols: DsSymbolMap;
};

/**
 * Output structure of the design system (single accessor file, always):
 *
 * - `object` (default) — everything wrapped in one accessor:
 *   `object DesignSystem { object Colors { … } object Type { … } object
 *   Metrics { … } object Strings { … } object Booleans { … } }`.
 * - `material` — the same accessor plus matched Material 3 artifacts in
 *   `DesignSystem/Theme.kt`: `val AppColorScheme =
 *   lightColorScheme(primary = …)` and/or `val AppTypography =
 *   Typography(headlineSmall = …)` (auto-matched by token name; unmatched
 *   tokens simply keep their plain vals).
 * - `material-theme` — like `material`, plus a ready
 *   `@Composable fun DesignSystemTheme(content = …) { MaterialTheme(…) }`.
 */
export type DsStructure = 'object' | 'material' | 'material-theme';

/** Section names of the root accessor in `DesignSystem.kt`. */
export const DS_SECTIONS = { colors: 'Colors', typography: 'Type', numbers: 'Metrics' } as const;

type DsSectionKind = 'colors' | 'typography' | 'numbers' | 'strings' | 'booleans';

const SECTION_OBJECTS: Array<{ kind: DsSectionKind; name: string }> = [
  { kind: 'colors', name: DS_SECTIONS.colors },
  { kind: 'typography', name: DS_SECTIONS.typography },
  { kind: 'numbers', name: DS_SECTIONS.numbers },
  { kind: 'strings', name: 'Strings' },
  { kind: 'booleans', name: 'Booleans' },
];

/**
 * Leading path words that repeat the wrapping section's own name
 * (`Color/Base/Black` inside `object Colors`). They are dropped from the
 * emitted symbol — `DesignSystem.Colors.BaseBlack` instead of a stuttering
 * `Colors.ColorBaseBlack` — while the KDoc keeps the original full path.
 */
const SECTION_DROP_WORDS: Record<DsSectionKind, readonly string[]> = {
  colors: ['color', 'colors'],
  typography: ['type', 'types', 'typography', 'typographies', 'font', 'fonts'],
  numbers: ['metric', 'metrics'],
  strings: ['string', 'strings'],
  booleans: ['bool', 'bools', 'boolean', 'booleans'],
};

/**
 * Drops the section's wrapper words from the front of a token path
 * (`Color/Base/Black` -> `Base/Black`). Only a **prefix** is removed and at
 * least one word always survives; usage-derived tokens are exempt (their
 * names vote from real contexts, not wrappers). When nothing is dropped the
 * original name returns untouched, so existing flattening stays identical.
 */
function stripSectionPrefix(name: string, drop: readonly string[], source: DsTokenSource): string {
  if (source === 'usage') return name;
  const words = pathWords(name);
  let first = 0;
  while (first < words.length - 1 && drop.includes(words[first]!)) first++;
  if (first === 0) return name;
  return words.slice(first).join(' ');
}

/** Material 3 color-scheme roles that can be matched from token names. */
const M3_COLOR_ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'inversePrimary',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'background', 'onBackground', 'surface', 'onSurface', 'surfaceVariant',
  'onSurfaceVariant', 'surfaceTint', 'inverseSurface', 'inverseOnSurface',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'outline', 'outlineVariant', 'scrim',
] as const;

/** Material 3 `Typography` slots, in constructor order. */
const M3_TEXT_SLOTS = [
  'displayLarge', 'displayMedium', 'displaySmall',
  'headlineLarge', 'headlineMedium', 'headlineSmall',
  'titleLarge', 'titleMedium', 'titleSmall',
  'bodyLarge', 'bodyMedium', 'bodySmall',
  'labelLarge', 'labelMedium', 'labelSmall',
] as const;

/** A bare keyword (`Title` without a size) maps to the slot class default. */
const BARE_TEXT_SLOT: Record<string, string> = {
  display: 'displayLarge',
  headline: 'headlineLarge',
  title: 'titleLarge',
  body: 'bodyLarge',
  label: 'labelLarge',
};

/** Split a token path into role-matching words (`Brand/onPrimary` -> [brand, on, primary]). */
function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function roleWords(role: string): string[] {
  return role
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.toLowerCase());
}

/**
 * Material 3 slot auto-matching: the token's words must end with the slot's
 * keyword sequence (longest suffix wins; case-insensitive), so
 * `Brand/Primary` -> `primary`, `Colors/On Primary Container` ->
 * `onPrimaryContainer`, `Dashboard/Error` -> `error`. Everything else stays
 * an ordinary val — matching is additive, never destructive.
 */
export function colorRoleFor(path: string): string | null {
  const words = pathWords(path);
  let best: { slot: string; length: number } | null = null;
  for (const role of M3_COLOR_ROLES) {
    const keywords = roleWords(role);
    if (keywords.length === 0 || keywords.length > words.length) continue;
    const suffix = words.slice(words.length - keywords.length);
    if (keywords.every((word, i) => suffix[i] === word) && (best === null || keywords.length > best.length)) {
      best = { slot: role, length: keywords.length };
    }
  }
  return best?.slot ?? null;
}

/**
 * Same suffix rule for Material 3 `Typography` slots; a bare base keyword
 * (`Title` alone) maps to its Large-slot default.
 */
export function textStyleSlotFor(path: string): string | null {
  const words = pathWords(path);
  let best: { slot: string; length: number } | null = null;
  for (const slot of M3_TEXT_SLOTS) {
    const keywords = roleWords(slot);
    const suffix = words.slice(words.length - keywords.length);
    if (keywords.length <= words.length && keywords.every((word, i) => suffix[i] === word)
      && (best === null || keywords.length > best.length)) {
      best = { slot, length: keywords.length };
    }
  }
  if (best) return best.slot;
  const last = words[words.length - 1];
  return last ? BARE_TEXT_SLOT[last] ?? null : null;
}

const SKIP_LEVEL: Record<DsSkip['reason'], GeneratedDiagnostic['level']> = {
  skipped: 'WARNING',
  gradient: 'WARNING',
  alias: 'WARNING',
  mode: 'INFO',
};

const SKIP_CODE: Record<DsSkip['reason'], string> = {
  skipped: 'DS-SKIPPED',
  gradient: 'DS-GRADIENT',
  alias: 'DS-ALIAS',
  mode: 'DS-MODES',
};

/** INFO diagnostics (mode notes) first, then warnings — deterministic. */
const SKIP_RANK: Record<DsSkip['reason'], number> = { mode: 0, alias: 1, gradient: 2, skipped: 3 };

/** Variables first on ties, then paint styles, then text styles, then derived usage tokens. */
const SOURCE_RANK: Record<DsTokenSource, number> = { variable: 0, 'paint style': 1, 'text style': 2, usage: 3 };

/**
 * NUMBER tokens whose path hints at typography become `sp` rather than `dp`.
 * Deliberately simple keyword heuristic, applied to the flattened Figma path
 * (collection/variable), e.g. `Typography/Body` or `font/leading`.
 */
export function numberUnitFor(path: string): 'dp' | 'sp' {
  return /font|typ|letter|leading|line\s?-?height/i.test(path) ? 'sp' : 'dp';
}

/**
 * A NUMBER token is a typography **weight** variable when its path carries an
 * explicit `weight` word (`Font/Weight/Bold`, `weight-semibold`) and the value
 * is an integer inside Kotlin's `FontWeight` domain (1..1000). Detected tokens
 * are pulled out of `Metrics` and emitted in the `Type` section as
 * `FontWeight` vals, and text styles whose weight matches one of them
 * reference the token instead of a hard-coded class. Values outside the
 * domain (non-integers, out of range) stay regular dp/sp numbers.
 */
export function fontWeightValueOf(token: { name: string; value: number }): number | null {
  if (!pathWords(token.name).includes('weight')) return null;
  const value = token.value;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 1000) return null;
  return value;
}

/** Canonical Kotlin class aliases for exact standard weights (exact otherwise). */
const M3_WEIGHT_ALIASES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** Figma percent-of-font-size spacing -> sp value (documented 1 px == 1 sp). */
export function dsPercentToSp(percent: number, fontSize: number | null): number | null {
  if (fontSize == null || !Number.isFinite(fontSize) || !Number.isFinite(percent)) return null;
  return (fontSize * percent) / 100;
}

/* (blank no-op removed) */

/**
 * Build the design-system Kotlin files. Returns empty `files` with a
 * `DS-EMPTY` INFO diagnostic when the input produced no representable tokens.
 */
export function buildDesignSystem(input: DesignSystemInput, packageName: string): DesignSystemResult {
  const diagnostics: GeneratedDiagnostic[] = sortedSkips(input.skipped).map(skipDiagnostic);

  const used = new Map<string, number>();

  /**
   * Groups one kind's tokens by their variable-collection mode. The `''` key
   * is the section root (single-mode collections, styles, usage tokens);
   * every other key is a mode name that becomes a nested wrapper object, so
   * same-named variables in different modes keep every value instead of
   * suffixing. Suffix scoping is per wrapper and per section, not global.
   */
  const bucketize = <T extends DsBase>(items: T[], dropWords: readonly string[], kind: DsSectionKind): Map<string, Array<NamedToken<T>>> => {
    const grouped = new Map<string, T[]>();
    for (const token of items) {
      const key = token.group ?? '';
      const bucket = grouped.get(key);
      if (bucket) bucket.push(token);
      else grouped.set(key, [token]);
    }
    const buckets = new Map<string, Array<NamedToken<T>>>();
    for (const [bucketKey, bucket] of grouped) {
      buckets.set(bucketKey, assignNames(bucket, used, dropWords, `${kind}|${bucketKey}`));
    }
    return buckets;
  };

  const colorBuckets = bucketize(input.colors, SECTION_DROP_WORDS.colors, 'colors');
  const textBuckets = bucketize(input.texts, SECTION_DROP_WORDS.typography, 'typography');
  // Font-weight variables become `FontWeight` vals inside the Type section,
  // not dp/sp numbers in Metrics (see `fontWeightValueOf`); their suffix
  // namespace is the Type section's, shared with the text styles.
  const weightBuckets = bucketize(
    input.numbers.filter((token) => fontWeightValueOf(token) !== null),
    SECTION_DROP_WORDS.typography,
    'typography',
  );
  const numberBuckets = bucketize(input.numbers.filter((token) => fontWeightValueOf(token) === null), SECTION_DROP_WORDS.numbers, 'numbers');
  const stringBuckets = bucketize(input.strings, SECTION_DROP_WORDS.strings, 'strings');
  const boolBuckets = bucketize(input.bools, SECTION_DROP_WORDS.booleans, 'booleans');

  const KIND_BUCKETS: Record<DsSectionKind, Map<string, Array<NamedToken<DsBase>>>> = {
    colors: colorBuckets,
    typography: textBuckets,
    numbers: numberBuckets,
    strings: stringBuckets,
    booleans: boolBuckets,
  };
  // Typography nests weights AND text styles inside one wrapper per mode.
  const KIND_MAPS: Record<DsSectionKind, Array<Map<string, Array<NamedToken<DsBase>>>>> = {    colors: [colorBuckets],
    typography: [textBuckets, weightBuckets],
    numbers: [numberBuckets],
    strings: [stringBuckets],
    booleans: [boolBuckets],
  };

  /**
   * Wrapper object name per mode. Mode names are PascalCased (`light` ->
   * `Light`, `Dark Mode` -> `DarkMode`); same-named modes from different
   * collections merge into one wrapper on purpose. Names dodge every root
   * val in the section and each other deterministically (`Dark2`).
   */
  const WRAPPER_SYMBOLS: Record<DsSectionKind, Map<string, string | null>> = {
    colors: new Map(),
    typography: new Map(),
    numbers: new Map(),
    strings: new Map(),
    booleans: new Map(),
  };
  for (const [kind, maps] of Object.entries(KIND_MAPS) as Array<[DsSectionKind, Array<Map<string, Array<NamedToken<DsBase>>>>]>) {
    const taken = new Set<string>();
    for (const items of maps) {
      const root = items.get('');
      if (root) for (const named of root) taken.add(named.symbol);
    }
    const keys = new Set<string>();
    for (const items of maps) for (const key of items.keys()) if (key !== '') keys.add(key);
    const names = new Map<string, string | null>([['', null]]);
    for (const key of [...keys].sort()) {
      let symbol = pascalCase(key);
      let n = 2;
      while (taken.has(symbol)) symbol = `${pascalCase(key)}${n++}`;
      taken.add(symbol);
      names.set(key, symbol);
    }
    WRAPPER_SYMBOLS[kind] = names;
  }

  /**
   * Final Kotlin reference per token: the val symbol, optionally qualified
   * through its wrapper (`Light.Background`) — the exact remainder that
   * follows `DesignSystem.<section>.` in emitted screen references.
   */
  const symbols: DsSymbolMap = new WeakMap();
  for (const [kind, maps] of Object.entries(KIND_MAPS) as Array<[DsSectionKind, Array<Map<string, Array<NamedToken<DsBase>>>>]>) {
    const wrappers = WRAPPER_SYMBOLS[kind];
    for (const bucketMap of maps) {
      for (const [key, list] of bucketMap) {
        const prefix = wrappers.get(key);
        for (const named of list) symbols.set(named.token, prefix ? `${prefix}.${named.symbol}` : named.symbol);
      }
    }
  }

  /**
   * Theme priority for one-token ties (slot matching, exact-value resolvers):
   * the collection's default mode first, then ungrouped tokens, then the
   * remaining modes; ties keep their input order (stable sort).
   */
  const modePrioritized = <T extends DsBase>(maps: Array<Map<string, Array<NamedToken<T>>>>): Array<NamedToken<T>> =>
    maps.flatMap((bucketMap) => [...bucketMap.values()].flat())
      .sort((a, b) =>
        (a.token.groupDefault ? 0 : a.token.group ? 2 : 1)
        - (b.token.groupDefault ? 0 : b.token.group ? 2 : 1));

  /** Font-weight token reference kept against an exact numeric weight. */
  type WeightRefSpec = { wrapper: string | null; symbol: string };
  const weightWrappers = WRAPPER_SYMBOLS.typography;
  const orderedWeightBuckets: Array<[string, Array<NamedToken<DsNumberToken>>]> = [];
  const rootWeights = weightBuckets.get('');
  if (rootWeights) orderedWeightBuckets.push(['', rootWeights]);
  orderedWeightBuckets.push(
    ...[...weightBuckets.entries()]
      .filter(([key]) => key !== '' && weightWrappers.get(key))
      .sort(([a], [b]) => (weightWrappers.get(a) ?? '').localeCompare(weightWrappers.get(b) ?? '', 'en')),
  );
  // One reference per numeric weight; refs prefer the text style's own
  // wrapper, then the ungrouped token, then the first wrapper in order.
  const weightRefs: Map<number, Map<string, WeightRefSpec>> = new Map();
  for (const [bucketKey, list] of orderedWeightBuckets) {
    for (const weight of list) {
      const value = fontWeightValueOf(weight.token)!;
      let byBucket = weightRefs.get(value);
      if (!byBucket) weightRefs.set(value, byBucket = new Map());
      if (!byBucket.has(bucketKey)) byBucket.set(bucketKey, { wrapper: weightWrappers.get(bucketKey) ?? null, symbol: weight.symbol });
    }
  }
  const weightRefFor = (value: number, group: string | undefined): WeightRefSpec | null => {
    const byBucket = weightRefs.get(value);
    if (!byBucket) return null;
    return (group && byBucket.get(group)) || byBucket.get('') || byBucket.values().next().value || null;
  };

  if (KIND_BUCKETS.colors.size === 0 && KIND_BUCKETS.typography.size === 0 && weightBuckets.size === 0
    && KIND_BUCKETS.numbers.size === 0 && KIND_BUCKETS.strings.size === 0 && KIND_BUCKETS.booleans.size === 0) {
    diagnostics.push({
      level: 'INFO',
      code: 'DS-EMPTY',
      message: 'No representable design-system tokens were found; DesignSystem.kt was not generated.',
    });
    return { files: [], diagnostics, symbols };
  }

  const structure = input.structure ?? 'object';
  const material = structure === 'material' || structure === 'material-theme';

  // Material 3 slot matching is additive: matched tokens are inlined into
  // the theme artifacts as direct values while every token also keeps its
  // plain val representation; ties prefer the collection's default mode.
  const colorRoles = new Map<string, NamedToken<DsColorToken>>();
  const textSlots = new Map<string, NamedToken<DsTextToken>>();
  if (material) {
    for (const item of modePrioritized([colorBuckets])) {
      const role = colorRoleFor(item.token.name);
      if (role && !colorRoles.has(role)) colorRoles.set(role, item);
    }
    for (const item of modePrioritized([textBuckets])) {
      const slot = textStyleSlotFor(item.token.name);
      if (slot && !textSlots.has(slot)) textSlots.set(slot, item);
    }
  }

  /** One `ind<arg>,` line per argument (trailing commas); the comma lands on
   *  the value, before any trailing `// comment`. */
  const argLines = (args: string[], indent: string): string[] =>
    args.map((arg) => {
      const hash = arg.indexOf(' //');
      if (hash === -1) return `${indent}${arg},`;
      return `${indent}${arg.slice(0, hash).trimEnd()}, ${arg.slice(hash + 1)}`;
    });

  /** Writes pre-formatted lines through the writer (it indents by depth). */
  const pushLines = (file: KotlinFile, lines: string[]): void => {
    for (const text of lines) file.line(text);
  };

  /** Resolved TextStyle argument list; registers its imports on the file. */
  const textStyleArgs = (file: KotlinFile, item: NamedToken<DsTextToken>, allowWeightRefs: boolean): string[] => {
    const token = item.token;
    const args: string[] = [];
    if (token.fontSize != null) {
      file.useImport('androidx.compose.ui.unit.sp');
      args.push(`fontSize = ${spLiteral(token.fontSize)}`);
    }
    if (token.fontWeight != null) {
      // An exact-matching weight variable keeps the design system linked:
      // `fontWeight = WeightBold` (or `Light.WeightBold` when the variable
      // itself lives in a mode wrapper) reads as one object reference and
      // survives weight retuning.
      const ref = allowWeightRefs ? weightRefFor(token.fontWeight, token.group) : null;
      const refExpr = ref ? `${ref.wrapper ? `${ref.wrapper}.` : ''}${ref.symbol}` : null;
      args.push(`fontWeight = ${refExpr ?? fontWeightExpr(token.fontWeight, { useImport: (path) => file.useImport(path) })}`);
    }
    if (token.fontFamily) {
      file.useImport('androidx.compose.ui.text.font.FontFamily');
      args.push(`fontFamily = ${fontFamilyExpr(token.fontFamily)} // ${token.fontFamily.replace(/\*/g, '\\*')}`);
    }
    if (token.lineHeight != null) {
      file.useImport('androidx.compose.ui.unit.sp');
      args.push(`lineHeight = ${spLiteral(token.lineHeight)}`);
    }
    if (token.letterSpacing != null) {
      file.useImport('androidx.compose.ui.unit.sp');
      args.push(`letterSpacing = ${spLiteral(token.letterSpacing)}`);
    }
    if (token.textAlign != null) {
      file.useImport('androidx.compose.ui.text.style.TextAlign');
      args.push(`textAlign = ${textAlignExpr(token.textAlign)}`);
    }
    return args;
  };

  /**
   * A `name = TextStyle(…)` argument inside a parent call (e.g. a
   * Typography slot), formatted one argument per line; relative indents —
   * KotlinFile indents by block depth. The closing paren always carries the
   * trailing comma of the parent argument list.
   */
  const textStyleSlotLines = (
    file: KotlinFile,
    name: string,
    item: NamedToken<DsTextToken>,
    indent: string,
  ): string[] => {
    file.useImport('androidx.compose.ui.text.TextStyle');
    // Theme.kt stays a self-contained snapshot: no weight-token references.
    const inner = textStyleArgs(file, item, false);
    const lines = inner.length === 0
      ? [`${indent}${name} = TextStyle()`]
      : [`${indent}${name} = TextStyle(`, ...argLines(inner, `${indent}    `), `${indent})`];
    lines[lines.length - 1] += ',';
    return lines;
  };

  /**
   * A weight token val: canonical standard weights read as the Kotlin class
   * aliases (`FontWeight.Bold`), anything else stays an exact custom value
   * (`FontWeight(650)`) — no silent clamping like screen-side expressions.
   */
  const weightVal = (file: KotlinFile, item: NamedToken<DsNumberToken>): string => {
    file.useImport('androidx.compose.ui.text.font.FontWeight');
    const value = fontWeightValueOf(item.token)!;
    const alias = M3_WEIGHT_ALIASES[value];
    return alias ? `FontWeight.${alias}` : `FontWeight(${value})`;
  };

  /** Full `val Sym = …` lines for one token in its family section. */
  const itemValLines = (
    file: KotlinFile,
    kind: 'colors' | 'typography' | 'numbers' | 'strings' | 'booleans',
    isWeightToken: boolean,
    item: NamedToken<DsBase>,
  ): string[] => {
    if (kind === 'colors') return [`val ${item.symbol} = ${colorExpr(file, item as NamedToken<DsColorToken>)}`];
    if (kind === 'typography') {
      if (isWeightToken) return [`val ${item.symbol} = ${weightVal(file, item as NamedToken<DsNumberToken>)}`];
      const inner = textStyleArgs(file, item as NamedToken<DsTextToken>, true);
      file.useImport('androidx.compose.ui.text.TextStyle');
      return inner.length === 0
        ? [`val ${item.symbol} = TextStyle()`]
        : [`val ${item.symbol} = TextStyle(`, ...argLines(inner, '    '), `)`];
    }
    if (kind === 'numbers') return [`val ${item.symbol} = ${numberExpr(file, item as NamedToken<DsNumberToken>)}`];
    if (kind === 'strings') return [`val ${item.symbol} = ${stringExpr(file, item as NamedToken<DsStringToken>)}`];
    return [`val ${item.symbol} = ${boolExpr(file, item as NamedToken<DsBoolToken>)}`];
  };

  /** Shared banner + render for exactly one design-system Kotlin file. */
  const finishKotlinFile = (file: KotlinFile, path: string): GeneratedFile => ({
    path,
    content: [
      '// Generated by Compose Studio: design-system tokens from the Figma design system.',
      '// Do not edit by hand - regenerate from the plugin instead.',
      '',
      file.render(),
    ].join('\n'),
    language: 'kotlin',
  });

  const files: GeneratedFile[] = [];

  // Expression builders take the target KotlinFile so every split file
  // imports exactly what it uses.
  const colorExpr = (file: KotlinFile, item: NamedToken<DsColorToken>): string => {
    file.useImport('androidx.compose.ui.graphics.Color');
    return `Color(${argbLiteral(item.token.rgba)})`;
  };
  const numberExpr = (file: KotlinFile, item: NamedToken<DsNumberToken>): string => {
    if (numberUnitFor(item.token.name) === 'sp') {
      file.useImport('androidx.compose.ui.unit.sp');
      return spLiteral(item.token.value);
    }
    file.useImport('androidx.compose.ui.unit.dp');
    return dpLiteral(item.token.value);
  };
  const stringExpr = (_file: KotlinFile, item: NamedToken<DsStringToken>): string => `"${escapeKotlinString(item.token.value)}"`;
  const boolExpr = (_file: KotlinFile, item: NamedToken<DsBoolToken>): string => String(item.token.value);

  {
    const file = newKotlinFile(packageName);
    file.openBlock('object DesignSystem', '}');
    for (const section of SECTION_OBJECTS) {
      const maps = KIND_MAPS[section.kind];
      const wrappers = WRAPPER_SYMBOLS[section.kind];
      const valEntries = (key: string): Array<{ weight: boolean; item: NamedToken<DsBase> }> =>
        section.kind === 'typography'
          ? [...(weightBuckets.get(key) ?? []).map((item) => ({ weight: true, item: item as NamedToken<DsBase> })),
             ...(textBuckets.get(key) ?? []).map((item) => ({ weight: false, item: item as NamedToken<DsBase> }))]
          : (maps[0]!.get(key) ?? []).map((item) => ({ weight: false, item }));

      const emitVals = (entries: Array<{ weight: boolean; item: NamedToken<DsBase> }>): void => {
        for (let i = 0; i < entries.length; i++) {
          if (i > 0) file.blank();
          const entry = entries[i]!;
          file.line(kdocFor(entry.item.token));
          pushLines(file, itemValLines(file, section.kind, entry.weight, entry.item));
        }
      };

      // Section-root vals first, then the mode wrappers beside them; a
      // blank separates siblings only (never leads the block).
      const rootEntries = valEntries('');
      const wrapperKeys = [...wrappers.keys()]
        .filter((key) => key !== '' && valEntries(key).length > 0)
        .sort((a, b) => (wrappers.get(a) ?? '').localeCompare(wrappers.get(b) ?? '', 'en'));
      if (rootEntries.length === 0 && wrapperKeys.length === 0) continue;
      file.blank();
      file.openBlock(`object ${section.name}`, '}');
      emitVals(rootEntries);
      let siblings = rootEntries.length;
      for (const key of wrapperKeys) {
        if (siblings > 0) file.blank();
        file.openBlock(`object ${wrappers.get(key)}`, '}');
        // The Type section mixes foundations and styles: font-weight
        // variables come first, then the text styles referencing them.
        emitVals(valEntries(key));
        file.closeBlock();
        siblings += 1;
      }
      file.closeBlock();
    }
    file.closeBlock();
    files.push(finishKotlinFile(file, 'DesignSystem.kt'));
  }

  // Material artifacts live in their own Theme.kt and assign the matched
  // values directly — `primary = Color(0xFF…)` and full inline
  // `TextStyle(…)` slots — so the theme is a self-contained snapshot that
  // never depends on (or duplicates references into) the token file.
  if (material && (colorRoles.size > 0 || textSlots.size > 0)) {
    const file = newKotlinFile(packageName);
    file.line('/** Material 3 artifacts (default light base) built directly from the matched token values. */');
    let wrote = false;
    if (colorRoles.size > 0) {
      file.useImport('androidx.compose.material3.lightColorScheme');
      if (wrote) file.blank();
      wrote = true;
      file.line('val AppColorScheme = lightColorScheme(');
      const roles = M3_COLOR_ROLES.filter((role) => colorRoles.has(role));
      for (const role of roles) {
        file.line(`    ${role} = ${colorExpr(file, colorRoles.get(role)!)},`);
      }
      file.line(')');
    }
    if (textSlots.size > 0) {
      file.useImport('androidx.compose.material3.Typography');
      if (wrote) file.blank();
      wrote = true;
      file.line('val AppTypography = Typography(');
      const slots = M3_TEXT_SLOTS.filter((slot) => textSlots.has(slot));
      for (const slot of slots) {
        pushLines(file, textStyleSlotLines(file, slot, textSlots.get(slot)!, '    '));
      }
      file.line(')');
    }
    if (structure === 'material-theme') {
      if (wrote) file.blank();
      file.useImport('androidx.compose.runtime.Composable');
      file.useImport('androidx.compose.material3.MaterialTheme');
      const themeArgs = [
        ...(colorRoles.size > 0 ? [`colorScheme = AppColorScheme`] : []),
        ...(textSlots.size > 0 ? [`typography = AppTypography`] : []),
        'content = content',
      ];
      file.line('/** Applies the design system\'s matched Material 3 slots to app content. */');
      file.line('@Composable');
      file.line('fun DesignSystemTheme(content: @Composable () -> Unit) {');
      file.line(`    MaterialTheme(${themeArgs.join(', ')})`);
      file.line('}');
    }
    files.push(finishKotlinFile(file, 'DesignSystem/Theme.kt'));
  }

  return { files, diagnostics, symbols };
}

/**
 * Blank input ready for appending harvested/derived tokens (mirrors the documented DTO shape).
 */
export function emptyDesignSystemInput(): DesignSystemInput {
  return { colors: [], texts: [], numbers: [], strings: [], bools: [], skipped: [] };
}

function kdocFor(token: DsBase): string {
  if (token.source === 'usage') {
    const safeName = token.name.replace(/`/g, `'`);
    return `/** Recurring value \`${safeName}\` derived from the converted frames (repeats are picked by usage; names follow where the value is used mostly). */`;
  }
  const label = token.source === 'variable' ? 'variable' : `${token.source}`;
  const safeName = token.name.replace(/`/g, `'`);
  // Multi-mode values carry the collection mode they were read from — two
  // same-path KDocs otherwise look identical (see `group`).
  const groupNote = token.group ? ` — \`${token.group}\` mode` : '';
  return `/** Figma ${label} \`${safeName}\`${groupNote}. */`;
}

/**
 * Classify a Figma font family into one of Compose's built-in families; the
 * original name is preserved as an inline comment by the caller.
 */
function fontFamilyExpr(family: string): string {
  const lower = family.toLowerCase();
  if (lower.includes('mono')) return 'FontFamily.Monospace';
  if (!lower.includes('sans') && lower.includes('serif')) return 'FontFamily.Serif';
  if (lower.includes('cursive') || lower.includes('script')) return 'FontFamily.Cursive';
  return 'FontFamily.Default';
}

function textAlignExpr(value: DsTextAlign): string {
  // Mirrors the TextAlign mapping used for nodes in generate.ts.
  if (value === 'CENTER') return 'TextAlign.Center';
  if (value === 'RIGHT') return 'TextAlign.Right';
  if (value === 'JUSTIFIED') return 'TextAlign.Justify';
  return 'TextAlign.Left';
}

function skipDiagnostic(skip: DsSkip): GeneratedDiagnostic {
  const name = JSON.stringify(skip.name);
  let message: string;
  switch (skip.reason) {
    case 'gradient':
      message = `Gradient paint style ${name} approximated with its first color stop.`;
      break;
    case 'alias':
      message = `Variable ${name} skipped: ${skip.detail}.`;
      break;
    case 'mode':
      message = `Variable collection ${name} split per mode into wrapper objects (${skip.detail}).`;
      break;
    default:
      message = `Skipped ${name}: ${skip.detail}.`;
  }
  return { level: SKIP_LEVEL[skip.reason], code: SKIP_CODE[skip.reason], message };
}

function sortedSkips(skips: DsSkip[]): DsSkip[] {
  return [...skips].sort((a, b) =>
    SKIP_RANK[a.reason] - SKIP_RANK[b.reason]
    || a.name.localeCompare(b.name, 'en')
    || a.detail.localeCompare(b.detail, 'en'));
}

type NamedToken<T extends DsBase> = { token: T; symbol: string };

/**
 * Sort tokens deterministically and assign unique PascalCase identifiers by
 * flattening the Figma path (`brand/primary` -> `BrandPrimary`); the wrapping
 * section's own leading words are dropped first (`Color/Base/Black` ->
 * `BaseBlack`). Collisions across the whole file get numeric suffixes
 * (`BrandPrimary2`); the original path stays in the KDoc.
 */
function assignNames<T extends DsBase>(
  items: T[],
  used: Map<string, number>,
  dropWords: readonly string[],
  scopeKey: string,
): Array<NamedToken<T>> {
  const sorted = [...items].sort((a, b) =>
    a.name.localeCompare(b.name, 'en')
    || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    // Item order from the Figma async getters is already stable; the final
    // JSON tiebreak makes the sort total even for duplicated (name, source).
    || JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const out: Array<NamedToken<T>> = [];
  for (const token of sorted) {
    const stripped = stripSectionPrefix(token.name, dropWords, token.source);
    const base = pascalCase(stripped);
    // Collisions suffix within their (section, wrapper) scope only, so
    // same-named variables in different mode wrappers keep the plain name.
    const key = `${scopeKey}|${base}`;
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    out.push({ token, symbol: n === 1 ? base : `${base}${n}` });
  }
  return out;
}
