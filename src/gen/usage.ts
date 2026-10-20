/**
 * Usage-derived design-system tokens (opt-in: "design system from repeated
 * values").
 *
 * Design intent:
 * - Design systems should also be derivable when nothing is bound to Figma
 *   variables or styles. The individual values a design paints again and
 *   again (one background color behind every card, one 16 dp inset …) *are*
 *   the design system.
 * - Files are still analyzed at extraction time (the scene graph knowledge
 *   lives in the IR), so this module is pure over `IrDocument[]` and fully
 *   unit-testable — no `figma` global.
 * - Names are derived from *where a value is used mostly* (the majority
 *   context), so repeated colors become `CardSurface`, `OnSurface`,
 *   spacing values become `Padding16` / `Gap8`, radii `CardRadius12`,
 *   fixed sizes `AvatarSize48`, and typography `TitleLarge`-style names that
 *   feed straight into the existing Material 3 slot auto-matching.
 * - Substitution stays slot-correct: a number token is emitted as a
 *   reference only in the role(s) it was observed in (a radius stays a
 *   radius, a padding stays padding), so no value is ever referenced under
 *   a misleading name. Colors and text styles match by exact value.
 *
 * Everything in here is deterministic: identical designs produce identical
 * tokens and identical generated Kotlin.
 */
import type { IrDocument, IrNode, StyledIrNode, SizeSemantics } from '../ir/ir.ts';
import { sizingModifierParts } from './expr.ts';
import {
  DS_SECTIONS,
  type DesignSystemInput,
  type DsBase,
  type DsColorToken,
  type DsNumberToken,
  type DsRgba,
  type DsSymbolMap,
  type DsTextToken,
  emptyDesignSystemInput,
} from './designsystem.ts';import { floatByte, formatNumber, dpLiteral } from '../util/format.ts';

/** The coarse group a repeated number belongs to (collector-side role). */
export type UsageSlotGroup = 'spacing' | 'radius' | 'size' | 'border';

/**
 * Emit-time `Dp` slots for token references. `gap` and `padding` share the
 * spacing group on the collector side but resolve separately: a `Gap 16`
 * token must never back a `padding(16.dp)` argument and vice versa.
 */
export type DpSlot = UsageSlotGroup | 'gap' | 'padding';

/** Slot-aware `Dp` resolver threaded through the modifier/expression builders. */
export type DpTokenResolver = (value: number, slot: DpSlot) => string;

/** How a color is used on its node. */
export type UsageColorKind = 'fill' | 'stroke' | 'text';

export type UsageOptions = {
  /**
   * Minimum occurrences for a value to become a token. An occurrence is one
   * emitted literal site in the generated code (per element for paddings,
   * radii and sizes — matches the emitted modifier arguments), per node for
   * colors, per span for text styles. Clamped to >= 2, default 2.
   */
  min?: number;
};

/** Usage-derived tokens + the raw lookup keys used to substitute them. */
export type UsageHarvest = {
  /** Tokens appended to the design system, `source: 'usage'`. */
  colors: DsColorToken[];
  numbers: DsNumberToken[];
  texts: DsTextToken[];
  /** Emitted value -> color token (`#AARRGGBB` byte key; see `colorKeyOf`). */
  colorKeys: Map<string, DsColorToken>;
  /** Emitted value -> number token, keyed `${slot}|${numberKeyOf(value)}` with
   *  `slot` ∈ `gap | padding | radius | size | border` (see `DpSlot`). */
  numberKeys: Map<string, DsNumberToken>;
  /** Emitted style tuple -> text token (see `textKeyOf`). */
  textKeys: Map<string, DsTextToken>;
};

/** Where each generated screen looks up its repeated values. */
export type UsageResolvers = {
  /** `#AARRGGBB` byte key -> Kotlin color expression (`Colors.X`). */
  colors: Map<string, string>;
  /** `${slot}|${numberKeyOf(value)}` -> Kotlin `Dp` expression (see `DpSlot`). */
  numbers: Map<string, string>;
  /** `textKeyOf(span)` -> Kotlin `TextStyle` expression (`Type.X`). */
  texts: Map<string, string>;
};

/** Inline `TextStyle` span shape used for text-token lookups. */
export type TextStyleQuery = {
  fontFamily: string | null;
  fontWeight: number | null;
  fontSize: number | null;
  lineHeight: number | null;
  letterSpacing: number | null;
};

/** Style-token resolver; null when the span should keep its inline style. */
export type TextStyleTokenResolver = (span: TextStyleQuery) => string | null;

/* ---------------------------------------------------------------------------
 * Stable value keys (shared by the DS harvester inputs and the generator)
 * ------------------------------------------------------------------------- */

/**
 * Color key on the emitted byte level: generated literals quantize 0..1
 * channels to 8-bit ARGB (`Color(0xAARRGGBB)`), so two near-identical
 * channels that produce the same emitted color must also share one token.
 */
export function colorKeyOf(rgba: DsRgba): string {
  return `#${floatByte(rgba.a)}${floatByte(rgba.r)}${floatByte(rgba.g)}${floatByte(rgba.b)}`;
}

/** Number key (`16` / `16.5`), quantized exactly like the Kotlin literal. */
export function numberKeyOf(value: number): string {
  return formatNumber(value);
}

/** Deterministic key of a repeated text style (same tuple = same token). */
export function textKeyOf(text: TextStyleQuery): string {
  const part = (value: number | null): string =>
    value == null || !Number.isFinite(value) ? '-' : numberKeyOf(value);
  return `${text.fontFamily ?? '-'}|${part(text.fontSize)}|${part(text.fontWeight)}|${part(text.lineHeight)}|${part(text.letterSpacing)}`;
}

/* ---------------------------------------------------------------------------
 * Context naming: where a value is used mostly
 * ------------------------------------------------------------------------- */

/**
 * Structural words that carry no naming signal for tokens (`Frame 2`,
 * `wrapper`, asset prefixes like `ic_` …). Dropped before a candidate
 * context name is considered meaningful.
 */
const GENERIC_WORDS = new Set([
  'frame', 'group', 'rect', 'rectangle', 'box', 'vector', 'ellipse', 'oval',
  'line', 'path', 'shape', 'container', 'wrapper', 'root', 'canvas',
  'artboard', 'layout', 'auto', 'cell', 'item', 'row', 'column', 'ic',
  'icon', 'img', 'image', 'placeholder', 'temp', 'tmp', 'empty', 'new',
]);

/**
 * Turns a raw node name into a context word used for token names:
 * generic structure words and digits are dropped (`Frame 24`, `ic_home`,
 * `Rectangle` become null; `Frame 1123 Card` becomes `Card`,
 * `Top Bar`/`list row Card` become `TopBar` / `Card`).
 */
function contextNameOf(name: string): string | null {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean);
  const kept = words.filter((word) => !GENERIC_WORDS.has(word.toLowerCase()) && !/^\d+$/.test(word));
  if (kept.length === 0) return null;
  // At most two words keeps names readable (`Card`, `TopBar`), and the
  // leading word stays the classifier for the value's dominant context.
  return kept.slice(0, 2).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * Names a value by its usage: the *nearest meaningful* node name wins the
 * vote (self first for surfaces/strokes/sizes, ancestors only for text,
 * whose own name is the text content). Looking outward stops at the first
 * meaningful name so generic wrappers and the screen root never outvote
 * the closest real context.
 */
function nearestContext(names: string[], skipSelf: boolean): string | null {
  for (let i = skipSelf ? 1 : 0; i < names.length; i++) {
    const ctx = contextNameOf(names[i] ?? '');
    if (ctx) return ctx;
  }
  return null;
}

/** Strict majority: a context only names a token when >50% of its uses agree. */
function dominantContext(contexts: Map<string, number>, count: number): string | null {
  let best: { name: string; count: number } | null = null;
  for (const [name, ctxCount] of contexts) {
    if (ctxCount * 2 > count && (best === null || ctxCount > best.count)) {
      best = { name, count: ctxCount };
    }
  }
  return best?.name ?? null;
}

function dominantK<T extends string>(map: Map<T, number>, order: readonly T[]): T | null {
  let best: T | null = null;
  let bestCount = 0;
  for (const value of order) {
    const count = map.get(value) ?? 0;
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/* ---------------------------------------------------------------------------
 * Typographic slot-class naming (reuses the M3 default sizes of designsystem.ts)
 * ------------------------------------------------------------------------- */

/** Material 3 default font sizes per slot class (sp): Large/Medium/Small. */
const M3_CLASS_SIZE: Record<string, [number, number, number]> = {
  display: [57, 45, 36],
  headline: [32, 28, 24],
  title: [22, 16, 14],
  body: [16, 14, 12],
  label: [14, 12, 11],
};

/** Titles a context name into one of the M3 typography keyword classes. */
function typographyClass(ctx: string): string | null {
  const words = ctx.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
  for (const word of words.reverse()) {
    if (word === 'display' || word === 'headline' || word === 'title' || word === 'body' || word === 'label') return word;
  }
  return null;
}

/** Picks Large/Medium/Small by distance to the M3 default sizes (Larger wins ties). */
function gradeBySize(clazz: string, size: number): string {
  const sizes = M3_CLASS_SIZE[clazz];
  if (!sizes) return 'Large';
  const [large, medium, small] = sizes;
  const dl = Math.abs(large - size);
  const dm = Math.abs(medium - size);
  const ds = Math.abs(small - size);
  if (dl <= dm && dl <= ds) return 'Large';
  if (dm <= ds) return 'Medium';
  return 'Small';
}

/** Weight word for a text token name (400 stays implicit). */
function weightWord(weight: number | null): string {
  if (weight == null || !Number.isFinite(weight)) return '';
  const clamped = Math.min(900, Math.max(100, weight));
  if (clamped === 400) return '';
  if (clamped === 700) return 'Bold';
  if (clamped === 300) return 'Light';
  return `W${Math.round(clamped / 100) * 100}`;
}

/* ---------------------------------------------------------------------------
 * The collector
 * ------------------------------------------------------------------------- */

type ColorEntry = {
  rgba: DsRgba;
  count: number;
  contexts: Map<string, number>;
  kinds: Map<UsageColorKind, number>;
};

type NumberEntry = {
  value: number;
  count: number;
  contexts: Map<string, number>;
  /** Sub-role counts inside a group (`gap`/`padding`, `width`/`height`/`size`). */
  subSlots: Map<string, number>;
};

type TextEntry = {
  query: TextStyleQuery;
  count: number;
  contexts: Map<string, number>;
};

type WalkEnv = {
  kind: 'row' | 'column' | 'box' | null;
  isRoot: boolean;
  ancestors: string[];
};

class Collector {
  private readonly min: number;
  private colors = new Map<string, ColorEntry>();
  private numbers = new Map<string, NumberEntry>();
  private texts = new Map<string, TextEntry>();

  constructor(min: number) {
    this.min = min;
  }

  color(kind: UsageColorKind, rgba: DsRgba, ctx: string | null, count = 1): void {
    const key = colorKeyOf(rgba);
    const entry = this.colors.get(key) ?? { rgba, count: 0, contexts: new Map(), kinds: new Map() };
    entry.count += count;
    const kindCount = (entry.kinds.get(kind) ?? 0) + count;
    entry.kinds.set(kind, kindCount);
    if (ctx) entry.contexts.set(ctx, (entry.contexts.get(ctx) ?? 0) + count);
    this.colors.set(key, entry);
  }

  number(group: UsageSlotGroup, subSlot: string, value: number, ctx: string | null, count = 1): void {
    if (!Number.isFinite(value) || value <= 0) return;
    // Spacing resolves per sub-slot (gap vs padding); the other groups emit
    // in one call family each, so the slot word is the group itself.
    const slot: DpSlot = group === 'spacing' ? (subSlot === 'gap' ? 'gap' : 'padding') : group;
    const key = `${slot}|${numberKeyOf(value)}`;
    const entry = this.numbers.get(key) ?? { value, count: 0, contexts: new Map(), subSlots: new Map() };
    entry.count += count;
    entry.subSlots.set(subSlot, (entry.subSlots.get(subSlot) ?? 0) + count);
    if (ctx) entry.contexts.set(ctx, (entry.contexts.get(ctx) ?? 0) + count);
    this.numbers.set(key, entry);
  }

  text(query: TextStyleQuery, ctx: string | null, count = 1): void {
    const key = textKeyOf(query);
    const entry = this.texts.get(key) ?? { query, count: 0, contexts: new Map() };
    entry.count += count;
    if (ctx) entry.contexts.set(ctx, (entry.contexts.get(ctx) ?? 0) + count);
    this.texts.set(key, entry);
  }

  /* ------------------------------ walk ------------------------------ */

  walk(doc: IrDocument): void {
    this.walkNode(doc.root, { kind: null, isRoot: true, ancestors: [] });
  }

  private walkNode(node: IrNode, env: WalkEnv): void {
    if (node.type === 'unknown') return;
    const styled = node as StyledIrNode;
    const selfNames = [node.ref.nodeName, ...env.ancestors];
    // One vote per occurrence: the nearest meaningful node name (self
    // included) stands for everything attached to this node. Text excludes
    // the text node itself — its name is the content, not a context.
    const ctx = nearestContext(selfNames, false);

    // -- colors + border ------------------------------------------------
    // A text node's fill paints its glyphs; the IR mirrors the span color into
    // `background` as well, so only the spans vote here (one per node) and the
    // same value is not double-billed with conflicting contexts.
    if (styled.background?.kind === 'SOLID' && node.type !== 'text') {
      this.color('fill', styled.background.color.rgba, ctx);
    }
    if (styled.border) {
      this.color('stroke', styled.border.color.rgba, ctx);
      this.number('border', 'border', styled.border.widthPx.value, ctx);
    }
    if (styled.radius) {
      const radius = styled.radius.value;
      const corners: number[] = radius.kind === 'fixed' ? [radius.px] : [radius.tl, radius.tr, radius.br, radius.bl];
      const distinct = new Set(corners.filter((value) => value > 0));
      for (const value of distinct) this.number('radius', 'radius', value, ctx);
    }

    // -- sizes (mirrors the emitted modifier arguments) ------------------
    if (node.type === 'container' || node.type === 'instance' || node.type === 'text') {
      const parts = this.sizingParts(node.sizing, env, node.geometry);
      if (parts.widthPx != null) this.number('size', 'width', parts.widthPx, ctx);
      if (parts.heightPx != null) this.number('size', 'height', parts.heightPx, ctx);
    } else {
      // shape/vector: always emitted as `size(w, h)`
      if (node.geometry.width > 0) this.number('size', 'both', node.geometry.width, ctx);
      if (node.geometry.height > 0 && node.geometry.height !== node.geometry.width) {
        this.number('size', 'both', node.geometry.height, ctx);
      }
    }

    // -- auto-layout spacing --------------------------------------------
    if (node.type === 'container' || node.type === 'instance') {
      const layout = node.layout.value;
      if (layout) {
        if (layout.gapPx && layout.gapPx.value > 0) this.number('spacing', 'gap', layout.gapPx.value, ctx);
        const pad = layout.padding?.value ?? null;
        if (pad) this.padding(pad.t, pad.r, pad.b, pad.l, ctx);
      }
    }
    // Text colors / styles (own node name excluded — it is the text content).
    if (node.type === 'text') {
      const textCtx = nearestContext(selfNames, true);
      for (const span of node.spans) {
        if (span.color) this.color('text', span.color.rgba, textCtx);
        this.text(
          {
            fontFamily: span.fontFamily,
            fontWeight: span.fontWeight,
            fontSize: span.fontSizePx,
            lineHeight: span.lineHeightPx,
            letterSpacing: span.letterSpacingPx,
          },
          textCtx,
        );
      }
    }

    // -- children --------------------------------------------------------
    let childKind: 'row' | 'column' | 'box' | null = null;
    if (node.type === 'container' || node.type === 'instance') {
      const layout = node.layout.value;
      childKind = layout ? (layout.direction === 'ROW' ? 'row' : 'column') : 'box';
    } else if (node.type === 'group') {
      childKind = 'box';
    }
    const children = node.type === 'container' || node.type === 'group' || node.type === 'instance' ? node.children : null;
    if (childKind === null || children === null) return;
    // Absolute-positioned children are emitted as Box children (wrapper).
    const childEnv: WalkEnv = { kind: childKind, isRoot: false, ancestors: selfNames };
    const absEnv: WalkEnv = { kind: 'box', isRoot: false, ancestors: selfNames };
    for (const child of children) {
      this.walkNode(child, child.absolute ? absEnv : childEnv);
    }
  }

  /** Padding counts mirror the emitted `padding(...)` arguments. */
  private padding(t: number, r: number, b: number, l: number, ctx: string | null): void {
    if (t === 0 && r === 0 && b === 0 && l === 0) return;
    if (t === b && r === l) {
      if (t === r) {
        this.number('spacing', 'padding', t, ctx);
      } else {
        if (t !== 0) this.number('spacing', 'padding', t, ctx);
        if (r !== 0) this.number('spacing', 'padding', r, ctx);
      }
      return;
    }
    for (const side of new Set([t, r, b, l])) {
      if (side !== 0) this.number('spacing', 'padding', side, ctx);
    }
  }

  /** Mirrors `sizingModifierParts`' slot decisions (shape of emitted args). */
  private sizingParts(
    sizing: SizeSemantics | null,
    env: WalkEnv,
    geometry: { width: number; height: number },
  ): { widthPx: number | null; heightPx: number | null } {
    if (env.isRoot) return { widthPx: null, heightPx: null };
    const parts = sizingModifierParts(sizing ?? null, env.kind, geometry);
    return { widthPx: parts.widthPx, heightPx: parts.heightPx };
  }

  /* ------------------------------ naming ---------------------------- */

  finish(): UsageHarvest {
    const harvest: UsageHarvest = {
      colors: [],
      numbers: [],
      texts: [],
      colorKeys: new Map(),
      numberKeys: new Map(),
      textKeys: new Map(),
    };
    const usedNames = new Set<string>();
    const nextName = (base: string | null): string => {
      const candidate = base || 'Value';
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
      let n = 2;
      while (usedNames.has(`${candidate} ${n}`)) n += 1;
      const out = `${candidate} ${n}`;
      usedNames.add(out);
      return out;
    };

    // Deterministic processing order: most frequent first, then by key.
    const colorEntries = [...this.colors].sort(
      ([aKey, a], [bKey, b]) => b.count - a.count || aKey.localeCompare(bKey, 'en'),
    );
    for (const [key, entry] of colorEntries) {
      if (entry.count < this.min) continue;
      const kind = dominantK(entry.kinds, ['fill', 'stroke', 'text'] as const) ?? 'fill';
      const ctx = dominantContext(entry.contexts, entry.count);
      let base: string;
      if (kind === 'fill') base = `${ctx ?? ''} Surface`.trim();
      else if (kind === 'stroke') base = `${ctx ?? ''} Outline`.trim();
      else base = `${ctx ?? ''} OnSurface`.trim();
      const name = nextName(base);
      const token: DsColorToken = { name, source: 'usage', rgba: entry.rgba };
      harvest.colors.push(token);
      harvest.colorKeys.set(key, token);
    }

    const numberEntries = [...this.numbers].sort(
      ([aKey, a], [bKey, b]) => b.count - a.count || aKey.localeCompare(bKey, 'en'),
    );
    for (const [key, entry] of numberEntries) {
      if (entry.count < this.min) continue;
      const slot = key.slice(0, key.indexOf('|')) as DpSlot;
      const ctx = dominantContext(entry.contexts, entry.count);
      const valueStr = numberValueWord(entry.value);
      let base: string;
      if (slot === 'gap' || slot === 'padding') {
        base = `${ctx ? `${ctx} ` : ''}${slot === 'gap' ? 'Gap' : 'Padding'} ${valueStr}`;
      } else if (slot === 'radius') {
        base = `${ctx ? `${ctx} ` : ''}Radius ${valueStr}`;
      } else if (slot === 'border') {
        base = `${ctx ? `${ctx} ` : ''}Border ${valueStr}`;
      } else {
        // size: dominant axis wins the word, mixed usage collapses to `Size`
        const widthCount = (entry.subSlots.get('width') ?? 0) + (entry.subSlots.get('both') ?? 0);
        const heightCount = (entry.subSlots.get('height') ?? 0) + (entry.subSlots.get('both') ?? 0);
        const word = widthCount > heightCount * 2 ? 'Width' : heightCount > widthCount * 2 ? 'Height' : 'Size';
        base = `${ctx ? `${ctx} ` : ''}${word} ${valueStr}`;
      }
      const name = nextName(base);
      const token: DsNumberToken = { name, source: 'usage', value: entry.value };
      harvest.numbers.push(token);
      harvest.numberKeys.set(key, token);
    }

    const textEntries = [...this.texts].sort(
      ([aKey, a], [bKey, b]) => b.count - a.count || aKey.localeCompare(bKey, 'en'),
    );
    for (const [key, entry] of textEntries) {
      if (entry.count < this.min) continue;
      const ctx = dominantContext(entry.contexts, entry.count);
      const name = nextName(textBaseName(ctx, entry.query));
      const token: DsTextToken = {
        name,
        source: 'usage',
        fontFamily: entry.query.fontFamily,
        fontSize: entry.query.fontSize,
        fontWeight: entry.query.fontWeight,
        lineHeight: entry.query.lineHeight,
        letterSpacing: entry.query.letterSpacing,
        textAlign: null,
      };
      harvest.texts.push(token);
      harvest.textKeys.set(key, token);
    }

    return harvest;
  }
}

/** Value word for token names: fractional dp values stay distinct (`16.5` → `16V5`). */
function numberValueWord(value: number): string {
  const key = numberKeyOf(value);
  return key.indexOf('.') === -1 ? key : `${key.replace('.', 'V')}`;
}

/**
 * Text token base name. A context that carries a Material 3 typography
 * keyword (`Title`, `Body`, `Headline`, `Display`, `Label` — usually the
 * section the text lives in) names the token after the graded slot
 * (`TitleLarge`), which then feeds the existing M3 slot auto-matching.
 * Everything else falls back to an explicit `Text<size><Weight>` pattern
 * with the optional context/family prefix.
 */
function textBaseName(ctx: string | null, query: TextStyleQuery): string {
  const cls = ctx ? typographyClass(ctx) : null;
  if (cls && query.fontSize != null && Number.isFinite(query.fontSize)) {
    return `${cls.charAt(0).toUpperCase()}${cls.slice(1)}${gradeBySize(cls, query.fontSize)}`;
  }
  const size = query.fontSize != null && Number.isFinite(query.fontSize) ? ` ${numberValueWord(query.fontSize)}` : '';
  const weight = weightWord(query.fontWeight);
  const prefix = ctx ? `${ctx} ` : '';
  const family = !size && query.fontFamily ? `${query.fontFamily} ` : '';
  return `${prefix}${family}Text${size}${weight}`.trim();
}

/* ---------------------------------------------------------------------------
 * Public entry points
 * ------------------------------------------------------------------------- */

/** Collects usage-derived tokens from the converted documents. */
export function collectUsageTokens(docs: IrDocument[], options: UsageOptions = {}): UsageHarvest {
  const min = Math.min(99, Math.max(2, Math.round(options.min ?? 2)));
  const collector = new Collector(min);
  for (const doc of docs) collector.walk(doc);
  return collector.finish();
}

/** Appends the usage tokens after the variables/styles harvest (own source, own KDoc). */
export function mergeDesignSystemInput(harvested: DesignSystemInput, usage: UsageHarvest): DesignSystemInput {
  const input = emptyDesignSystemInput();
  input.colors = [...harvested.colors, ...usage.colors];
  input.texts = [...harvested.texts, ...usage.texts];
  input.numbers = [...harvested.numbers, ...usage.numbers];
  input.strings = [...harvested.strings];
  input.bools = [...harvested.bools];
  input.skipped = [...harvested.skipped];
  input.structure = harvested.structure;
  return input;
}

/**
 * Slot-correct default resolver: falls back to the emitted `dp` literal.
 */
export function makeDpExpr(resolvers: UsageResolvers | null): DpTokenResolver {
  return (value, slot) =>
    resolvers?.numbers.get(`${slot}|${numberKeyOf(value)}`) ?? dpLiteral(value);
}

/** Text-style resolver over the repeated-style tuple; null keeps the inline style. */
export function makeTextStyleResolver(resolvers: UsageResolvers | null): TextStyleTokenResolver {
  return (span) => resolvers?.texts.get(textKeyOf(span)) ?? null;
}

/**
 * Builds the runtime lookup tables for the generator:
 * - usage tokens always participate;
 * - on value equality, colors and text styles also fall back to the exact
 *   variable/style token from the harvested input, so repeated values can
 *   point into the generated design system even when the usage heuristics
 *   did not mint a token; ties prefer the collection's default mode first
 *   (the `Light`/`Dark` wrapper values share one keyed slot);
 * - number slots only ever resolve through usage tokens (slot semantics).
 *
 * Tokens always live inside the accessor object (`DesignSystem.kt`), so all
 * references qualify through it (`DesignSystem.Colors.CardSurface`); mode
 * wrappers add one hop (`DesignSystem.Colors.Dark.Background`).
 */
export function buildUsageResolvers(
  usage: UsageHarvest,
  harvested: DesignSystemInput,
  symbols: DsSymbolMap,
): UsageResolvers {
  const resolvers: UsageResolvers = { colors: new Map(), numbers: new Map(), texts: new Map() };
  const expr = (token: DsBase, section: string): string | null => {
    const path = symbols.get(token);
    if (!path) return null;
    return `DesignSystem.${section}.${path}`;
  };

  // Exact-value ties prefer the collection's default mode (groupDefault),
  // then ungrouped tokens, then the remaining modes — stable sort.
  const modeRank = (t: { group?: string; groupDefault?: boolean }): number => (t.groupDefault ? 0 : t.group ? 2 : 1);

  for (const [key, token] of usage.colorKeys) {
    const e = expr(token, DS_SECTIONS.colors);
    if (e) resolvers.colors.set(key, e);
  }
  for (const token of [...harvested.colors].sort((a, b) => modeRank(a) - modeRank(b))) {
    const key = colorKeyOf(token.rgba);
    if (!resolvers.colors.has(key)) {
      const e = expr(token, DS_SECTIONS.colors);
      if (e) resolvers.colors.set(key, e);
    }
  }

  for (const [key, token] of usage.numberKeys) {
    const e = expr(token, DS_SECTIONS.numbers);
    if (e) resolvers.numbers.set(key, e);
  }

  for (const [key, token] of usage.textKeys) {
    const e = expr(token, DS_SECTIONS.typography);
    if (e) resolvers.texts.set(key, e);
  }
  for (const token of [...harvested.texts].sort((a, b) => modeRank(a) - modeRank(b))) {
    const key = textKeyOf({
      fontFamily: token.fontFamily,
      fontWeight: token.fontWeight,
      fontSize: token.fontSize,
      lineHeight: token.lineHeight,
      letterSpacing: token.letterSpacing,
    });
    if (!resolvers.texts.has(key)) {
      const e = expr(token, DS_SECTIONS.typography);
      if (e) resolvers.texts.set(key, e);
    }
  }

  return resolvers;
}
