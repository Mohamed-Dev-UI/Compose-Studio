/**
 * Assembles a ModifierChain for an IR node given its parent context.
 * Canonical modifier order is documented in docs/generation.md:
 *
 *   weight -> fill/size -> wrapContentHeight -> offset -> align -> shadow
 *   -> clip -> border -> background -> paint -> padding -> alpha
 */
import type { IrPadding, StyledIrNode, SourceRef, SizeSemantics } from '../ir/ir.ts';
import type { AssetRegistry } from './assets.ts';
import { ModifierChain } from './modifiers.ts';
import type { DpTokenResolver } from './usage.ts';
import {
  childAlignExpr,
  circleShapeExpr,
  contentScaleExpr,
  gradientBrushExpr,
  shapeExprFromRadius,
  sizingModifierParts,
  type ColorResolver,
} from './expr.ts';

export type ModifierHelpers = {
  useImport: (path: string) => void;
  colorExpr: ColorResolver;
  /** Slot-aware design-system `Dp` tokens for repeated values (may be null). */
  dpExpr: DpTokenResolver | null;
  assetRegistry: AssetRegistry;
  diag: (level: 'INFO' | 'WARNING' | 'ERROR', code: string, message: string, ref: SourceRef | null) => void;
};

export type ParentInfo = {
  kind: 'row' | 'column' | 'box' | null;
  isRoot: boolean;
  crossAlign?: string | null;
};

export function buildModifierChain(node: StyledIrNode, parent: ParentInfo, h: ModifierHelpers): ModifierChain {
  const mc = new ModifierChain(h.dpExpr ?? null);
  const shapeTarget = shapeTargetOf(node, h);

  // 1. weight / fill / size
  if (node.type === 'container' || node.type === 'instance' || node.type === 'text') {
    const isText = node.type === 'text';
    applySizingParts(mc, node.sizing, parent, node.geometry, isText, isText ? node.textAlignVertical?.value : undefined);
  } else {
    mc.size(node.geometry.width, node.geometry.height);
  }

  // 2. offset inside Box
  if (parent.kind === 'box' && !parent.isRoot) {
    mc.offset(node.geometry.x, node.geometry.y);
  }

  // 3. per-child cross alignment
  if (parent.crossAlign && parent.kind !== 'box') {
    const alignExpr = childAlignExpr(parent.kind ?? 'box', parent.crossAlign, h);
    if (alignExpr) mc.align(alignExpr);
  }

  // 4. shadow (first mapped shadow only)
  const shadows = node.effects.mapped;
  const firstShadow = shadows[0];
  if (firstShadow) {
    mc.shadow(Math.max(1, Math.round(firstShadow.blurPx / 2)), h.colorExpr(firstShadow.color), shapeTarget);
    if (shadows.length > 1) {
      h.diag('INFO', 'MULTIPLE-SHADOWS', `Node has ${shadows.length} shadows; only the first is emitted.`, node.ref);
    }
  }

  // 5. clip
  if (node.clip.value === true) {
    mc.clip(shapeTarget ?? null);
  }

  // 6. border
  if (node.border) {
    mc.border(node.border.widthPx.value, h.colorExpr(node.border.color), shapeTarget);
  }

  // 7. background / paint
  applyBackground(mc, node, h, shapeTarget);

  // 8. padding (auto-layout containers only)
  if (node.type === 'container' || node.type === 'instance') {
    const pad: IrPadding | null = node.layout.value?.padding?.value ?? null;
    if (pad) mc.padding(pad.t, pad.r, pad.b, pad.l);
  }

  // 9. alpha
  if (node.opacity.value < 1) mc.alpha(node.opacity.value);
  return mc;
}

function applySizingParts(
  mc: ModifierChain,
  sizing: SizeSemantics | null,
  parent: ParentInfo,
  geometry: { width: number; height: number },
  isText: boolean,
  verticalAlign: string | undefined,
): void {
  const parts = sizingModifierParts(
    sizing,
    parent.isRoot ? null : parent.kind,
    geometry,
  );
  if (parts.weight) mc.weight(1);
  if (parts.fillWidth) mc.fillMaxWidth();
  if (parts.fillHeight) mc.fillMaxHeight();
  if (parts.widthPx != null || parts.heightPx != null) mc.size(parts.widthPx, parts.heightPx);
  if (isText && parent.isRoot === false && verticalAlign && verticalAlign !== 'TOP') {
    // Only meaningful when the text node has a fixed height box.
    const verticallyFixed = sizing?.vertical?.value === 'FIXED';
    if (verticallyFixed) {
      mc.wrapContentHeight(verticalAlign === 'CENTER' ? 'Alignment.CenterVertically' : 'Alignment.Bottom');
    }
  }
}

function applyBackground(mc: ModifierChain, node: StyledIrNode, h: ModifierHelpers, shapeTarget: string | null): void {
  const bg = node.background;
  if (!bg) return;
  if (bg.kind === 'SOLID') {
    mc.background(h.colorExpr(bg.color), shapeTarget);
    return;
  }
  if (bg.kind === 'IMAGE') {
    const asset = h.assetRegistry.add(
      'png',
      node.ref,
      node.ref.nodeName,
      { imageHash: bg.image.imageHash },
      { size: { width: node.geometry.width, height: node.geometry.height } },
    );
    if (asset) {
      mc.paint(`painterResource(id = R.drawable.${asset})`, contentScaleExpr(bg.image.scaleMode, h));
    } else {
      h.diag(
        'WARNING',
        'ASSET-EXCLUDED',
        `Image fill excluded: node name '${node.ref.nodeName}' is not exported as an image asset because ${h.assetRegistry.exclusionReason()}; the fill is omitted.`,
        node.ref,
      );
    }
    return;
  }
  if (bg.kind === 'GRADIENT_LINEAR') {
    h.diag('INFO', 'GRADIENT-ANGLE', 'Non-axis-aligned linear gradients are approximated with the nearest supported axis.', node.ref);
    const brush = gradientBrushExpr(bg.gradient, { width: node.geometry.width, height: node.geometry.height, kind: 'linear' }, h);
    if (brush) mc.background(brush, shapeTarget);
    return;
  }
  if (bg.kind === 'GRADIENT_RADIAL') {
    const g = bg.gradient;
    if (Math.abs(g.p0[0] - 0.5) > 0.03 || Math.abs(g.p0[1] - 0.5) > 0.03) {
      h.diag('INFO', 'RADIAL-CENTER', 'Radial gradient center approximated to the bounds center.', node.ref);
    }
    const brush = gradientBrushExpr(g, { width: node.geometry.width, height: node.geometry.height, kind: 'radial' }, h);
    if (brush) mc.background(brush, shapeTarget);
  }
}

function shapeTargetOf(node: StyledIrNode, h: ModifierHelpers): string | null {
  if (node.type === 'shape' && node.shape === 'ELLIPSE') return circleShapeExpr(h);
  if (node.radius) return shapeExprFromRadius(node.radius.value, h);
  return null;
}
