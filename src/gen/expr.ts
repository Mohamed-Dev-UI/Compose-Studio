/**
 * Pure helper functions producing Kotlin expressions from IR values.
 * All functions are deterministic and side-effect free, except optional
 * import registration through the passed-in `useImport` hook.
 */
import type { AutoLayout, IrColor, IrGradient, Radius, SizingAxis, SizeSemantics } from '../ir/ir.ts';
import { argbLiteral, dpLiteral, formatNumber } from '../util/format.ts';
import type { DpTokenResolver } from './usage.ts';

/** Hook the generator gives helpers so they can register imports/lines on files. */
export type UseImport = (path: string) => void;

export type ExprHelpers = {
  useImport: UseImport;
  /** Slot-aware design-system token resolver (usage-derived values); optional. */
  dpExpr?: DpTokenResolver | null;
};

/** A `Color(...)` literal from channels (no token context). */
export function colorFromChannels(rgba: { r: number; g: number; b: number; a: number }): string {
  return `Color(${argbLiteral(rgba)})`;
}

/** Preferred signature: a function resolving a color with tokens/mapping. */
export type ColorResolver = (color: IrColor) => string;

export type ShapeHelpers = ExprHelpers & { colorExpr: ColorResolver };

export function shapeExprFromRadius(radius: Radius | null, helpers: ExprHelpers): string | null {
  if (!radius) return null;
  helpers.useImport('androidx.compose.foundation.shape.RoundedCornerShape');
  const dp = (value: number): string => helpers.dpExpr?.(value, 'radius') ?? dpLiteral(value);
  if (radius.kind === 'fixed') return `RoundedCornerShape(${dp(radius.px)})`;
  const { tl, tr, br, bl } = radius;
  if (tl === tr && tr === br && br === bl) return `RoundedCornerShape(${dp(tl)})`;
  return `RoundedCornerShape(topStart = ${dp(tl)}, topEnd = ${dp(tr)}, bottomEnd = ${dp(br)}, bottomStart = ${dp(bl)})`;
}

export function circleShapeExpr(helpers: ExprHelpers): string {
  helpers.useImport('androidx.compose.foundation.shape.CircleShape');
  return 'CircleShape';
}

/** Gradient brush expression (axis-aligned linear, centered radial; otherwise approximated). */
export function gradientBrushExpr(
  gradient: IrGradient,
  info: { width: number; height: number; kind: 'linear' | 'radial' },
  helpers: ShapeHelpers,
): string | null {
  if (gradient.stops.length === 0) return null;
  helpers.useImport('androidx.compose.ui.graphics.Brush');
  helpers.useImport('androidx.compose.ui.graphics.Color');
  const pairs = gradient.stops.map(
    (s) => `${formatNumber(Math.min(1, Math.max(0, s.offset)))}f to ${helpers.colorExpr(s.color)}`,
  );
  const arg = pairs.join(', ');

  if (info.kind === 'linear') {
    const p0 = gradient.p0;
    const p1 = gradient.p1 ?? [1, 0];
    const sameX = Math.abs(p0[0] - p1[0]) < 0.02;
    const sameY = Math.abs(p0[1] - p1[1]) < 0.02;
    if (sameX && p1[1] > p0[1]) return `Brush.verticalGradient(${arg})`;
    if (sameY && p1[0] > p0[0]) return `Brush.horizontalGradient(${arg})`;
    return `Brush.linearGradient(${arg})`;
  }
  return `Brush.radialGradient(${arg})`;
}

/** Main-axis alignment -> Compose `Arrangement` expression (direction aware). */
export function arrangementExpr(
  direction: 'ROW' | 'COLUMN',
  l: AutoLayout,
  helpers: ExprHelpers,
): string | null {
  helpers.useImport('androidx.compose.foundation.layout.Arrangement');
  helpers.useImport('androidx.compose.ui.Alignment');
  const gap = l.gapPx?.value ?? 0;
  const main = l.mainAxis?.value ?? 'START';
  const gapDp = (value: number): string => helpers.dpExpr?.(value, 'gap') ?? dpLiteral(value);
  if (gap > 0) {
    if (main === 'SPACE_BETWEEN') return 'Arrangement.SpaceBetween';
    if (main === 'START') return `Arrangement.spacedBy(${gapDp(gap)})`;
    if (main === 'END') {
      return direction === 'ROW'
        ? `Arrangement.spacedBy(${gapDp(gap)}, Alignment.End)`
        : `Arrangement.spacedBy(${gapDp(gap)}, Alignment.Bottom)`;
    }
    // CENTER
    return direction === 'ROW'
      ? `Arrangement.spacedBy(${gapDp(gap)}, Alignment.CenterHorizontally)`
      : `Arrangement.spacedBy(${gapDp(gap)}, Alignment.CenterVertically)`;
  }
  switch (main) {
    case 'SPACE_BETWEEN': return 'Arrangement.SpaceBetween';
    case 'END': return direction === 'ROW' ? 'Arrangement.End' : 'Arrangement.Bottom';
    case 'CENTER': return direction === 'ROW' ? 'Arrangement.CenterHorizontally' : 'Arrangement.CenterVertically';
    default: return null;
  }
}

/** Cross-axis alignment container parameter (Row: verticalAlignment; Column: horizontalAlignment). */
export function crossAlignParam(
  direction: 'ROW' | 'COLUMN',
  cross: string,
  helpers: ExprHelpers,
): { name: 'verticalAlignment' | 'horizontalAlignment'; expr: string } | null {
  helpers.useImport('androidx.compose.ui.Alignment');
  if (direction === 'ROW') {
    switch (cross) {
      case 'CENTER': return { name: 'verticalAlignment', expr: 'Alignment.CenterVertically' };
      case 'END': return { name: 'verticalAlignment', expr: 'Alignment.Bottom' };
      case 'BASELINE': return { name: 'verticalAlignment', expr: 'Alignment.Baseline' };
      default: return null; // Top is the Compose Row default
    }
  }
  switch (cross) {
    case 'CENTER': return { name: 'horizontalAlignment', expr: 'Alignment.CenterHorizontally' };
    case 'END': return { name: 'horizontalAlignment', expr: 'Alignment.End' };
    default: return null; // Start is the Compose Column default
  }
}

/** Per-child cross alignment when it differs from the container default. */
export function childAlignExpr(parentKind: 'row' | 'column' | 'box', alignment: string, helpers: ExprHelpers): string | null {
  helpers.useImport('androidx.compose.ui.Alignment');
  if (parentKind === 'row') {
    switch (alignment) {
      case 'CENTER': return 'Alignment.CenterVertically';
      case 'END': return 'Alignment.Bottom';
      case 'BASELINE': return 'Alignment.Baseline';
      default: return null;
    }
  }
  switch (alignment) {
    case 'CENTER': return 'Alignment.CenterHorizontally';
    case 'END': return 'Alignment.End';
    default: return null;
  }
}

/** ContentScale name mapping for image fills. */
export function contentScaleExpr(scaleMode: string, helpers: ExprHelpers): string {
  helpers.useImport('androidx.compose.ui.layout.ContentScale');
  switch (scaleMode) {
    case 'FIT': return 'ContentScale.Fit';
    default: return 'ContentScale.Crop'; // FILL/CROP/TILE approximated with Crop (documented)
  }
}

export function fontFamilyExpr(helpers: ExprHelpers): string {
  helpers.useImport('androidx.compose.ui.text.font.FontFamily');
  return 'FontFamily.Default';
}

/** Font weight expression (Figma 100..900 -> FontWeight.W*, 700/400 aliases). */
export function fontWeightExpr(weight: number, helpers: ExprHelpers): string {
  helpers.useImport('androidx.compose.ui.text.font.FontWeight');
  const clamped = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  if (clamped === 700) return 'FontWeight.Bold';
  if (clamped === 400) return 'FontWeight.Normal';
  return `FontWeight.W${clamped}`;
}

/** Figma sizing -> modifier parts, given the parent's layout kind. */
export type SizingParts = {
  weight: boolean;
  fillWidth: boolean;
  fillHeight: boolean;
  widthPx: number | null;
  heightPx: number | null;
};

export function sizingModifierParts(
  sizing: SizeSemantics | null,
  parentKind: 'row' | 'column' | 'box' | null,
  geometry: { width: number; height: number },
): SizingParts {
  const h: SizingAxis = sizing?.horizontal?.value ?? 'FIXED';
  const v: SizingAxis = sizing?.vertical?.value ?? 'FIXED';
  const parts: SizingParts = { weight: false, fillWidth: false, fillHeight: false, widthPx: null, heightPx: null };
  if (parentKind === 'row') {
    if (h === 'FILL') parts.weight = true;
    if (v === 'FILL') parts.fillHeight = true;
    if (h === 'FIXED') parts.widthPx = geometry.width;
  } else if (parentKind === 'column') {
    if (v === 'FILL') parts.weight = true;
    if (h === 'FILL') parts.fillWidth = true;
    if (v === 'FIXED') parts.heightPx = geometry.height;
  } else if (parentKind === 'box') {
    if (h === 'FILL') parts.fillWidth = true;
    else if (h !== 'HUG') parts.widthPx = geometry.width;
    if (v === 'FILL') parts.fillHeight = true;
    else if (v !== 'HUG') parts.heightPx = geometry.height;
  } else {
    parts.widthPx = geometry.width;
    parts.heightPx = geometry.height;
  }
  return parts;
}

/** Transforms text case (UPPER/LOWER/TITLE). */
export function transformTextCase(text: string, textCase: string): string {
  switch (textCase) {
    case 'UPPER': return text.toLocaleUpperCase('en');
    case 'LOWER': return text.toLocaleLowerCase('en');
    case 'TITLE':
      return text.replace(/(^|\s)([a-z])/g, (_, p, c) => p + c.toLocaleUpperCase('en'));
    default: return text;
  }
}
