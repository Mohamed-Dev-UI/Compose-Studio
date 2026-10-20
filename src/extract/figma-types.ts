/**
 * Structural interfaces for the subset of the Figma Plugin API that the
 * extractor consumes, plus small pure helpers shared with tests.
 *
 * These interfaces mirror `@figma/plugin-typings` loosely (structural typing
 * lets real plugin nodes pass directly, while tests pass mock fixtures).
 */
import type { IrGeometry, IrColor, SourceRef } from '../ir/ir.ts';
import type { MarkCandidate } from '../shared/marks.ts';
import type { ParsedComponentConfig } from '../shared/compose-config.ts';

export type FigmaColor = { r: number; g: number; b: number; a?: number };

type PaintCommon = {
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
  boundVariables?: { [key: string]: { id?: string } | undefined } | undefined;
};

export type FigmaSolidPaint = PaintCommon & { type: 'SOLID'; color: FigmaColor };

export type FigmaGradientPaint = PaintCommon & {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  /** Row-major 2x3 affine transform as returned by the Figma API. */
  gradientTransform: readonly [readonly [number, number, number], readonly [number, number, number]];
  gradientStops: readonly { position: number; color: FigmaColor }[];
};

export type FigmaImagePaint = PaintCommon & {
  type: 'IMAGE';
  imageHash: string;
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  rotation?: number;
};

export type FigmaVectorPaint = PaintCommon & {
  type: 'VECTOR';
  vectorPaths?: readonly { path: string }[];
};

export type FigmaPaint = FigmaSolidPaint | FigmaGradientPaint | FigmaImagePaint | FigmaVectorPaint;

export type FigmaEffect =
  | { type: 'DROP_SHADOW'; color: FigmaColor; offset: { x: number; y: number }; radius: number; spread?: number; visible?: boolean }
  | { type: 'INNER_SHADOW'; color: FigmaColor; offset: { x: number; y: number }; radius: number; spread?: number; visible?: boolean }
  | { type: 'LAYER_BLUR'; radius: number; visible?: boolean }
  | { type: 'BACKGROUND_BLUR'; radius: number; visible?: boolean };

export type FigmaFontName = { family: string; style: string };

export type FigmaStyledTextSegment = {
  characters: string;
  start: number;
  end: number;
  fontSize?: number;
  fontName?: FigmaFontName;
  fontWeight?: number;
  fills?: readonly FigmaPaint[];
  letterSpacing?: { value: number; unit: 'PIXELS' | 'PERCENT' };
  lineHeight?: { value: number; unit: 'PIXELS' | 'PERCENT' | 'AUTO' };
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
};

/** What we need from any scene node. All fields optional except identifying ones. */
export type FigmaSceneNodeBase = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  /** Offset relative to the coordinate space the node lives in (see `relOffset`). */
  x: number;
  y: number;
  width: number;
  height: number;
  parent: FigmaSceneNodeBase | null;
  readonly children?: readonly FigmaSceneNode[];
  opacity?: number;
  fills?: readonly FigmaPaint[] | symbol;
  strokes?: readonly FigmaPaint[] | symbol;
  strokeWeight?: number | symbol;
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  dashPattern?: readonly number[];
  cornerRadius?: number | symbol;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomLeftRadius?: number;
  bottomRightRadius?: number;
  effects?: readonly FigmaEffect[];
  clipsContent?: boolean;
  rotation?: number;
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  primaryAxisAlignItems?: 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'MAX' | 'CENTER' | 'BASELINE';
  itemSpacing?: number | symbol;
  counterAxisSpacing?: number | symbol;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  layoutWrap?: 'NO_WRAP' | 'WRAP';
  primaryAxisSizingMode?: 'FIXED' | 'AUTO';
  counterAxisSizingMode?: 'FIXED' | 'AUTO';
  layoutPositioning?: 'AUTO' | 'ABSOLUTE';
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL';
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL';
};

export type FigmaTextNodeType = FigmaSceneNodeBase & {
  type: 'TEXT';
  characters: string;
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
  textAutoResize?: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  textStyleId?: string | symbol | null;
  fillStyleId?: string | symbol | null;
  getStyledTextSegments?: (keys: readonly string[]) => readonly FigmaStyledTextSegment[];
};

export type FigmaVectorLikeNode = FigmaSceneNodeBase & {
  ellipseArcData?: { startingAngle: number; endingAngle: number; innerRadius: number };
};

export type FigmaInstanceNodeType = FigmaSceneNodeBase & {
  type: 'INSTANCE';
  mainComponent?: { name: string; id: string } | null;
  mainComponentSet?: { name: string; id: string } | null;
  variantProperties?: Record<string, string> | null;
  overriddenFields?: readonly string[];
};

export type FigmaSceneNode =
  | FigmaSceneNodeBase
  | FigmaTextNodeType
  | FigmaInstanceNodeType
  | FigmaVectorLikeNode;

/**
 * Per-instance component data resolved by the sandbox through the async APIs
 * (no `figma` global reaches this far). VARIANT-typed entries are excluded —
 * variants arrive separately as `variantProperties`.
 */
export type ComponentPropSnapshot = {
  kind: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP' | 'OTHER';
  value: string | boolean;
};

export type InstanceComponentInfo = {
  name: string;
  id: string;
  /** When the master belongs to a component set, its identity (guarded async read). */
  set?: { id: string; name: string } | null;
  /**
   * Non-variant component properties with this instance's values; keys have
   * their `#id` suffix stripped. `null` when unavailable.
   */
  props?: Record<string, ComponentPropSnapshot> | null;
  /**
   * Component configuration description parsed from the master's Figma
   * `description` (see `shared/compose-config.ts`); `null` when the master
   * carries no `compose-studio:` block.
   */
  config?: ParsedComponentConfig | null;
};

/** Data the extractor needs from its calling environment (no `figma` global). */
export type FigmaContext = {
  /** Marker for `figma.mixed` (a unique symbol at runtime). */
  mixedMarker: symbol;
  /** Guard: maximum nodes to extract (fail fast for very large selections). */
  maxNodes: number;
  /** Optional: availability cache for font families (defaults to `true`). */
  isFontAvailable?: (family: string) => boolean;
  /** Optional: design-token table for resolving variable references (see tokens/collect). */
  tokenLookup?: TokenLookup;
  /**
   * Optional: resolves an instance's master component without the sync
   * `mainComponent` getter. Under the manifest's
   * `documentAccess: 'dynamic-page'` reading `mainComponent` throws, so the
   * sandbox pre-resolves masters via `getMainComponentAsync()` and provides
   * them here. When this hook is present the extractor never touches the
   * sync getter at all; when it is absent (tests / legacy access) the sync
   * getter is used directly.
   */
  instanceComponentLookup?: (instanceNodeId: string) => InstanceComponentInfo | null | undefined;
  /**
   * Optional: user ignore rules (name prefix + exact marks kept in plugin
   * storage). When it returns `true`, the node **and its whole subtree** are
   * skipped: no IR node, no diagnostics spam (one INFO per skipped root),
   * no asset exports. The extractor calls it with candidate facts (name,
   * type, geometry, master id when known) so marks can match by identity
   * rather than by name alone.
   */
  nodeMarkLookup?: (candidate: MarkCandidate) => boolean;
};

export type TokenLookup = (variableId: string) => TokenInfo | undefined;

export type TokenInfo = {
  id: string;
  name: string;
  collection: string;
  /** Name of the collection mode that should be used to resolve the value. */
  defaultModeId: string | null;
  defaultModeName: string | null;
  value: { kind: 'COLOR'; rgba: { r: number; g: number; b: number; a: number } } | null;
  /** id of the variable this token aliases (resolved chain terminal), or null. */
  aliasedVariableId: string | null;
};

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

export function isMixedValue(ctx: FigmaContext, value: unknown): boolean {
  return value === ctx.mixedMarker;
}

/** Numeric value of a possibly-mixed Figma value. */
export function numberOrMixed(ctx: FigmaContext, value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/** Normalize a Figma RGBA (0..1, optional a) into an IR color. */
export function irColor(rgba: FigmaColor, alphaMultiplier = 1): IrColor {
  const a = (rgba.a == null ? 1 : rgba.a) * alphaMultiplier;
  return {
    rgba: {
      r: clamp01(rgba.r),
      g: clamp01(rgba.g),
      b: clamp01(rgba.b),
      a: clamp01(a),
    },
    tokenRef: null,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function sourceRef(node: FigmaSceneNode): SourceRef {
  return { fuid: node.id, nodeName: node.name, fType: node.type };
}

/** Raw geometry of a node (in the node's own coordinate space). */
export function geometryOf(node: FigmaSceneNode): IrGeometry {
  return {
    x: numberOrMixedSafe(node.x),
    y: numberOrMixedSafe(node.y),
    width: numberOrMixedSafe(node.width),
    height: numberOrMixedSafe(node.height),
  };
}

function numberOrMixedSafe(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Offset of a child relative to its parent, in the parent's space.
 * Figma quirk: children of GROUP nodes live in the *parent-of-group* coordinate
 * space (same space as the group itself), so their stored x/y must be
 * re-based by the group's own x/y.
 */
export function relOffset(parent: FigmaSceneNodeBase, child: FigmaSceneNode): { x: number; y: number } {
  if (parent.type === 'GROUP') {
    return { x: safeNumber(child.x) - safeNumber(parent.x), y: safeNumber(child.y) - safeNumber(parent.y) };
  }
  return { x: safeNumber(child.x), y: safeNumber(child.y) };
}

function safeNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/* ---------------------------------------------------------------------------
 * Gradient helpers (from the Figma gradientTransform)
 * ------------------------------------------------------------------------ */

/** Inverse of a 2x3 row-major affine transform [[a,b,c],[d,e,f]]. */
export function invert2x3(m: readonly [readonly [number, number, number], readonly [number, number, number]]): {
  a: number; b: number; c: number; d: number; e: number; f: number;
} {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) {
    // Determinant vanished; fall back to identity to keep generation deterministic.
    return { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
  }
  return {
    a: e / det,
    b: -b / det,
    c: (b * f - e * c) / det,
    d: -d / det,
    e: a / det,
    f: (d * c - a * f) / det,
  };
}

function applyInv(inv: { a: number; b: number; c: number; d: number; e: number; f: number }, x: number, y: number): [number, number] {
  return [inv.a * x + inv.b * y + inv.c, inv.d * x + inv.e * y + inv.f];
}

/**
 * Endpoints of a linear gradient in the node's normalized 0..1 space,
 * computed by inverting the Figma `gradientTransform` and mapping the
 * gradient-space handle points (0, 0.5) and (1, 0.5) into object space.
 */
export function linearGradientEnds(
  t: readonly [readonly [number, number, number], readonly [number, number, number]],
): { p0: [number, number]; p1: [number, number] } {
  const inv = invert2x3(t as [[number, number, number], [number, number, number]]);
  return { p0: applyInv(inv, 0, 0.5), p1: applyInv(inv, 1, 0.5) };
}

/** Center point and radius of a radial gradient in normalized object space. */
export function radialGradientParams(
  t: readonly [readonly [number, number, number], readonly [number, number, number]],
): { center: [number, number]; radius: number } {
  const inv = invert2x3(t as [[number, number, number], [number, number, number]]);
  const center = applyInv(inv, 0.5, 0.5);
  const edge = applyInv(inv, 1, 0.5);
  const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
  return { center, radius };
}
