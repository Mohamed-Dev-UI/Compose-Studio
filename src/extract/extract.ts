/**
 * Figma extractor.
 *
 * Reads a simplified subset of the Figma Plugin API node graph into the IR.
 * The module does not depend on the global `figma` object; it operates on the
 * structural interfaces from `figma-types.ts` so it can also run under Node.js
 * with mock fixtures (tests).
 *
 * Design constraints (from the spec):
 * - Read properties only when they exist for a node type.
 * - Never treat an inferred value as an explicit design property.
 * - Collect diagnostics for unsupported/interesting cases instead of silently dropping data.
 * - Deterministic: same input -> same IR.
 */
import type {
  AutoLayout,
  ComponentUsage,
  FontUsage,
  IrBorder,
  IrColor,
  IrDiagnostic,
  IrDocument,
  IrGeometry,
  IrGradientStop,
  IrNode,
  IrStyling,
  IrTextSpan,
  Radius,
  SizingAxis,
  ShadowSpec,
  SizeSemantics,
  SourceRef,
  TokenRef,
  VariableUsage,
  WithOrigin,
} from '../ir/ir.ts';
import { IR_VERSION } from '../ir/ir.ts';
import {
  geometryOf,
  irColor,
  isMixedValue,
  linearGradientEnds,
  radialGradientParams,
  relOffset,
  sourceRef,
  type FigmaContext,
  type FigmaGradientPaint,
  type FigmaPaint,
  type FigmaSceneNode,
  type FigmaSceneNodeBase,
  type FigmaSolidPaint,
  type FigmaStyledTextSegment,
  type FigmaInstanceNodeType,
  type FigmaTextNodeType,
} from './figma-types.ts';

const TEXT_SEGMENT_KEYS: readonly string[] = [
  'fontSize', 'fontName', 'fontWeight', 'fills', 'letterSpacing', 'lineHeight', 'textDecoration', 'textCase',
];

function emptyStyling(): IrStyling {
  return {
    background: null,
    extraBackgrounds: [],
    border: null,
    radius: null,
    opacity: { value: 1, origin: 'explicit' },
    clip: { value: false, origin: 'inferred' },
    effects: { mapped: [], unsupported: [] },
  };
}

/* ---------------------------------------------------------------------------
 * Text helpers
 * ------------------------------------------------------------------------ */

type NodeTypography = {
  fontSize?: number | symbol;
  fontName?: { family: string; style: string } | symbol;
  fontWeight?: number | symbol;
  letterSpacing?: { value: number; unit: 'PIXELS' | 'PERCENT' } | symbol;
  lineHeight?: { value: number; unit: 'PIXELS' | 'PERCENT' | 'AUTO' } | symbol;
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH' | symbol;
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | symbol;
};

function styledSegments(node: FigmaTextNodeType): readonly FigmaStyledTextSegment[] {
  if (typeof node.getStyledTextSegments !== 'function') return [];
  try {
    return node.getStyledTextSegments(TEXT_SEGMENT_KEYS) ?? [];
  } catch {
    return [];
  }
}

/** Build a segment out of node-level typography (fallback when segments are unavailable). */
function typographyFromNode(node: FigmaTextNodeType, ctx: FigmaContext): FigmaStyledTextSegment {
  const t = node as unknown as NodeTypography;
  const parcel = <T>(v: T | symbol): T | undefined => (v === undefined ? undefined : isMixedValue(ctx, v) ? undefined : (v as unknown as T));
  return {
    characters: node.characters ?? '',
    start: 0,
    end: (node.characters ?? '').length,
    fontSize: parcel(t.fontSize),
    fontName: parcel(t.fontName),
    fontWeight: parcel(t.fontWeight),
    fills: parcel(node.fills as readonly FigmaPaint[] | symbol),
    letterSpacing: parcel(t.letterSpacing),
    lineHeight: parcel(t.lineHeight),
    textDecoration: parcel(t.textDecoration),
    textCase: parcel(t.textCase),
  };
}

/** Layout-relevant signature of a text segment (for detecting mixed styles). */
function styleSignature(s: FigmaStyledTextSegment): string {
  const firstPaint = s.fills && s.fills[0] ? s.fills[0] : null;
  return JSON.stringify([
    s.fontSize ?? null,
    s.fontName?.family ?? null,
    s.fontName?.style ?? null,
    s.fontWeight ?? null,
    s.letterSpacing?.value ?? null,
    s.lineHeight?.value ?? null,
    s.textDecoration ?? null,
    s.textCase ?? null,
    firstPaint?.type ?? null,
    firstPaint?.type === 'SOLID' ? (firstPaint as FigmaSolidPaint).color : null,
  ]);
}

/* ---------------------------------------------------------------------------
 * The extractor
 * ------------------------------------------------------------------------ */

interface NodeBase {
  id: string;
  ref: SourceRef;
  index: number;
  parent: string | null;
  idPath: string[];
  geometry: IrGeometry;
  absolute: boolean;
}

export class Extractor {
  private readonly ctx: FigmaContext;
  private readonly diagnostics: IrDiagnostic[] = [];
  private readonly fonts = new Map<string, FontUsage>();
  private readonly variables = new Map<string, VariableUsage>();
  private readonly components = new Map<string, ComponentUsage>();
  private nodeCount = 0;

  constructor(ctx: FigmaContext) {
    this.ctx = ctx;
  }

  extractRoot(node: FigmaSceneNode): IrDocument | null {
    if (!node.visible) {
      this.diag({ severity: 'INFO', code: 'NODE-INVISIBLE', feature: 'visibility', reason: 'Node is invisible; it will not be converted.', source: sourceRef(node) });
      return null;
    }
    const root = this.extractNode(node, null, [], { x: 0, y: 0 });
    if (!root) return null;
    return {
      version: IR_VERSION,
      root,
      fonts: [...this.fonts.values()],
      variables: [...this.variables.values()],
      components: [...this.components.values()],
      diagnostics: this.diagnostics,
    };
  }

  private diag(d: IrDiagnostic): void {
    this.diagnostics.push(d);
  }

  /**
   * Ignore-rule gate: true when the node matches the configured ignore
   * prefix or a user mark kept in plugin storage. One INFO per skipped node
   * so the conversion log shows exactly what was left out; children are
   * skipped transitively (nothing else sees them).
   */
  private ignored(node: FigmaSceneNode, masterId: string | null): boolean {
    const lookup = this.ctx.nodeMarkLookup;
    if (!lookup) return false;
    const geometry = geometryOf(node);
    const matched = lookup({ name: node.name, fType: node.type, width: geometry.width, height: geometry.height, masterId });
    if (!matched) return false;
    this.diag({
      severity: 'INFO',
      code: 'NODE-IGNORED',
      feature: 'ignore rule',
      reason: `'${node.name}' matches an ignore rule (name prefix or marked in the plugin); it and its children are skipped entirely.`,
      source: sourceRef(node),
    });
    return true;
  }

  private recordFont(family: string | null, style: string | null): void {
    if (!family) return;
    const key = `${family}|${style ?? ''}`;
    if (!this.fonts.has(key)) {
      const available = this.ctx.isFontAvailable ? this.ctx.isFontAvailable(family) : true;
      this.fonts.set(key, { family, style: style ?? '', available });
    }
  }

  private recordVariable(ref: TokenRef): void {
    if (!this.variables.has(ref.variableId)) {
      this.variables.set(ref.variableId, {
        variableId: ref.variableId,
        variableName: ref.variableName ?? '',
        collection: ref.collection,
        modeId: ref.modeId,
        modeName: ref.modeName,
      });
    }
  }

  /** Resolve a paint's bound color variable through the token table, if available. */
  private resolveTokenRef(paint: FigmaPaint, color: IrColor, ref: SourceRef): void {
    const vid = paint.boundVariables?.['COLOR']?.id;
    if (!vid) return;
    const info = this.ctx.tokenLookup?.(vid) ?? null;
    if (!info) {
      this.diag({
        severity: 'WARNING',
        code: 'UNRESOLVED-VARIABLE',
        feature: 'token',
        reason: `Variable ${vid} could not be resolved using the design-token table.`,
        suggestion: 'Collect variables before conversion, or map the color manually in the mapping profile.',
        source: ref,
      });
      return;
    }
    color.tokenRef = {
      variableId: info.id,
      variableName: info.name,
      collection: info.collection,
      modeId: info.defaultModeId,
      modeName: info.defaultModeName,
    };
    this.recordVariable(color.tokenRef);
  }

  /* ------------------------- node walk ------------------------- */

  private extractNode(node: FigmaSceneNode, parent: string | null, idPath: string[], childOffset: { x: number; y: number }): IrNode | null {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') {
      this.diag({ severity: 'ERROR', code: 'INVALID-SOURCE', feature: 'node', reason: 'Node is missing or has no id.', source: null });
      return null;
    }
    this.nodeCount += 1;
    if (this.nodeCount > this.ctx.maxNodes) {
      throw new Error(`Selection is too large (more than ${this.ctx.maxNodes} nodes). Select a smaller subtree.`);
    }
    if (node.visible === false) {
      this.diag({ severity: 'INFO', code: 'NODE-INVISIBLE', feature: 'visibility', reason: 'Node is invisible; it will not be converted.', source: sourceRef(node) });
      return null;
    }
    if (this.ignored(node, null)) return null;
    const absolute = node.layoutPositioning === 'ABSOLUTE' && parent !== null;
    const base: NodeBase = {
      id: node.id,
      ref: sourceRef(node),
      index: 0,
      parent,
      idPath: [...idPath],
      geometry: {
        x: childOffset.x,
        y: childOffset.y,
        width: geometryOf(node).width,
        height: geometryOf(node).height,
      },
      absolute,
    };
    if (absolute) {
      this.diag({
        severity: 'INFO',
        code: 'ABSOLUTE-POSITION',
        feature: 'layout',
        reason: 'Node ignores its parent auto-layout (absolute positioned). It is emitted as an offset child inside a wrapper Box, preserving its explicit x/y placement.',
        source: base.ref,
      });
    }
    if (typeof node.rotation === 'number' && Math.abs(node.rotation ?? 0) > 0.01) {
      this.diag({ severity: 'WARNING', code: 'ROTATED-NODE', feature: 'transform', reason: 'Rotated nodes are emitted without the rotation.', source: base.ref });
    }

    switch (node.type) {
      case 'FRAME':
      case 'SECTION':
      case 'COMPONENT':
      case 'COMPONENT_SET': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        const kind = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET'
          ? 'COMPONENT'
          : node.type === 'SECTION'
            ? 'SCREEN'
            : 'CONTAINER';
        const children = this.extractChildren(node as FigmaSceneNodeBase & { children?: readonly FigmaSceneNode[] }, node.id, base.idPath);
        return {
          type: 'container',
          kind,
          ...base,
          layout: readAutoLayout(node as FigmaSceneNodeBase & { children?: readonly FigmaSceneNode[] }, this.ctx, base.ref),
          sizing: readSizing(node as FigmaSceneNodeBase, this.ctx, parent == null),
          children,
          ...styling,
        };
      }
      case 'GROUP': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        const children = this.extractChildren(node as FigmaSceneNodeBase & { children?: readonly FigmaSceneNode[] }, node.id, base.idPath);
        return { type: 'group', ...base, children, ...styling };
      }
      case 'TEXT': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        return this.extractText(node as FigmaTextNodeType, base, styling);
      }
      case 'RECTANGLE': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        return { type: 'shape', shape: 'RECTANGLE', ...base, ...styling };
      }
      case 'ELLIPSE': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        const arc = (node as { ellipseArcData?: { startingAngle: number; endingAngle: number; innerRadius: number } }).ellipseArcData;
        const isPlain = !arc
          || (Math.abs(arc.startingAngle) < 0.001 && Math.abs(arc.endingAngle - 2 * Math.PI) < 0.001 && arc.innerRadius <= 0);
        if (isPlain) return { type: 'shape', shape: 'ELLIPSE', ...base, ...styling };
        this.diag({ severity: 'INFO', code: 'SVG-REQUIRED', feature: 'shape', reason: 'Ellipse arc/pie geometry is exported as an SVG vector asset.', source: base.ref });
        return { type: 'vector', vectorType: 'VECTOR', ...base, ...styling };
      }
      case 'LINE': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        return { type: 'shape', shape: 'LINE', ...base, ...styling };
      }
      case 'POLYGON':
      case 'STAR':
      case 'BOOLEAN_OPERATION':
      case 'VECTOR': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        this.diag({ severity: 'INFO', code: 'SVG-REQUIRED', feature: 'vector', reason: `Geometry of type ${node.type} is exported as an SVG vector asset.`, source: base.ref });
        return {
          type: 'vector',
          vectorType: node.type === 'BOOLEAN_OPERATION' ? 'BOOLEAN_OPERATION' : node.type === 'POLYGON' ? 'POLYGON' : node.type === 'STAR' ? 'STAR' : 'VECTOR',
          ...base,
          ...styling,
        };
      }
      case 'INSTANCE': {
        const styling = this.extractStyling(node as FigmaSceneNodeBase, base.ref);
        const inst = node as FigmaInstanceNodeType;
        // Dynamic-page document access forbids the sync `mainComponent` getter
        // (it throws at read time), so a provided lookup always wins. The
        // sandbox guarantees a full map (value or null), never `undefined`.
        const mainInfo = this.ctx.instanceComponentLookup
          ? (this.ctx.instanceComponentLookup(node.id) ?? null)
          : null;
        const mainComponent = mainInfo
          ? { name: mainInfo.name, id: mainInfo.id }
          : (inst.mainComponent ?? null);
        const componentName = mainComponent?.name ?? node.name;
        const componentKey = mainComponent?.id ?? node.id;
        // Instances ignore-match by exact component identity when the user
        // marked the master component (or another instance of it).
        if (this.ignored(node, componentKey)) return null;
        const existing = this.components.get(componentKey);
        if (existing) existing.instanceCount += 1;
        else this.components.set(componentKey, { componentName, componentKey, instanceCount: 1 });
        // Component set (for variant grouping) and non-variant properties
        // come from the async snapshot; absent lookups degrade to null.
        const componentSet = mainInfo?.set ? { id: mainInfo.set.id, name: mainInfo.set.name } : null;
        let componentProps: Record<string, { kind: 'TEXT' | 'BOOLEAN' | 'OTHER'; value: string | boolean }> | null = null;
        if (mainInfo?.props) {
          componentProps = {};
          for (const [rawKey, entry] of Object.entries(mainInfo.props)) {
            const key = rawKey.split('#')[0] || rawKey;
            componentProps[key] = {
              kind: entry.kind === 'TEXT' ? 'TEXT' : entry.kind === 'BOOLEAN' ? 'BOOLEAN' : 'OTHER',
              value: entry.value,
            };
          }
        }
        if (inst.variantProperties) {
          this.diag({ severity: 'INFO', code: 'COMPONENT-VARIANT', feature: 'component', reason: `Instance resolves variant ${JSON.stringify(inst.variantProperties)} of component '${componentName}'.`, source: base.ref });
        }
        // Component configuration descriptions (CCD) that turn the whole
        // instance into an asset (kind/icon/image/vector or `assets: export`)
        // keep the subtree out of the IR: no stray children code, assets or
        // diagnostics; the generator renders the instance as an asset
        // reference and the plugin exports the instance node itself. An
        // explicit `assets: code` policy wins over `kind`, so the subtree
        // walks normally and the component is coded instead.
        const config = mainInfo?.config ?? null;
        const assetOnly =
          config !== null &&
          config.assets !== 'code' &&
          (config.assets === 'export' || config.kind !== null);
        const children = assetOnly
          ? []
          : this.extractChildren(node as FigmaSceneNodeBase & { children?: readonly FigmaSceneNode[] }, node.id, base.idPath);
        return {
          type: 'instance',
          componentName,
          componentKey,
          variantProps: inst.variantProperties ?? null,
          componentSet,
          componentProps,
          children,
          layout: readAutoLayout(node as FigmaSceneNodeBase & { children?: readonly FigmaSceneNode[] }, this.ctx, base.ref),
          sizing: readSizing(node as FigmaSceneNodeBase, this.ctx, false),
          ...base,
          ...styling,
        };
      }
      default: {
        this.diag({ severity: 'ERROR', code: 'UNSUPPORTED-NODE', feature: node.type, reason: `Figma node type '${node.type}' is not supported.`, source: base.ref });
        return { type: 'unknown', reason: `Unsupported node type ${node.type}`, ...base };
      }
    }
  }

  private extractChildren(node: FigmaSceneNodeBase & { children?: readonly FigmaSceneNode[] }, nodeId: string, idPath: string[]): IrNode[] {
    const out: IrNode[] = [];
    let index = 0;
    for (const child of node.children ?? []) {
      const offset = relOffset(node, child);
      const extracted = this.extractNode(child, nodeId, [...idPath, nodeId], offset);
      if (extracted) {
        extracted.index = index;
        out.push(extracted);
        index += 1;
      }
    }
    return out;
  }

  /* ------------------------- styling ------------------------- */

  private extractStyling(node: FigmaSceneNodeBase, ref: SourceRef): IrStyling {
    const styling: IrStyling = emptyStyling();
    const ctx = this.ctx;

    // -- background fill (`fills`) ------------------------------------
    const paints = node.fills;
    if (paints && !isMixedValue(ctx, paints) && Array.isArray(paints) && paints.length > 0) {
      const visible = (paints as readonly FigmaPaint[]).filter(
        (p) => p && p.visible !== false && (p as { type: string }).type !== 'VIDEO',
      );
      const primary = visible[0];
      if (primary) {
        const mapped = this.paintToBackground(primary, ref);
        styling.background = mapped.background;
        if (mapped.unsupported) {
          this.diag({ severity: 'WARNING', code: 'UNSUPPORTED-FILL', feature: 'fill', reason: mapped.unsupported, source: ref });
        }
      }
      for (const extra of visible.slice(1)) {
        styling.extraBackgrounds.push({
          paint: { kind: 'OTHER', gradient: { kind: 'LINEAR', p0: [0, 0], stops: [] }, origin: 'explicit' },
          reason: `${extra.type} paint was not mapped (only the first paint is used).`,
        });
      }
      if (visible.length > 1) {
        this.diag({ severity: 'INFO', code: 'MULTIPLE-FILLS', feature: 'fill', reason: `Node has ${visible.length} fills; only the first is emitted.`, source: ref });
      }
    }

    // -- strokes ------------------------------------------------------
    const strokes = node.strokes;
    if (strokes && !isMixedValue(ctx, strokes) && Array.isArray(strokes) && !isMixedValue(ctx, node.strokeWeight)) {
      const weight = typeof node.strokeWeight === 'number' ? node.strokeWeight : 0;
      const primary = (strokes as readonly FigmaPaint[]).find((p) => p && p.visible !== false && p.type === 'SOLID');
      if (primary && weight > 0) {
        const align = node.strokeAlign ?? 'INSIDE';
        const color = irColor((primary as FigmaSolidPaint).color, typeof primary.opacity === 'number' ? primary.opacity : 1);
        this.resolveTokenRef(primary, color, ref);
        const border: IrBorder = {
          widthPx: { value: weight, origin: 'explicit' },
          color,
          strokeAlign: { value: align, origin: 'explicit' },
          dashPattern: node.dashPattern && node.dashPattern.length > 0 ? [...node.dashPattern] : null,
        };
        styling.border = border;
        if (border.dashPattern) {
          this.diag({ severity: 'WARNING', code: 'DASHED-BORDER', feature: 'stroke', reason: 'Dashed strokes have no direct Compose equivalent; a solid border is emitted.', source: ref });
        }
        if (align !== 'INSIDE') {
          this.diag({ severity: 'INFO', code: 'STROKE-ALIGN', feature: 'stroke', reason: `Stroke align '${align}' is approximated with an inside border.`, source: ref });
        }
      }
    }

    // -- corner radius ------------------------------------------------
    styling.radius = this.readRadius(node);

    // -- opacity ------------------------------------------------------
    if (typeof node.opacity === 'number' && node.opacity < 1) {
      styling.opacity = { value: node.opacity, origin: 'explicit' };
    }

    // -- clipping -----------------------------------------------------
    if (typeof node.clipsContent === 'boolean') {
      styling.clip = { value: node.clipsContent, origin: 'explicit' };
    }

    // -- effects ------------------------------------------------------
    for (const fx of node.effects ?? []) {
      if (fx.visible === false) continue;
      if (fx.type === 'DROP_SHADOW') {
        const color = irColor(fx.color);
        this.resolveTokenRef({ type: 'SOLID', color: fx.color } as unknown as FigmaPaint, color, ref);
        const shadow: ShadowSpec = {
          color,
          blurPx: fx.radius,
          xPx: fx.offset?.x ?? 0,
          yPx: fx.offset?.y ?? 0,
          spreadPx: fx.spread ?? 0,
          effectType: 'DROP_SHADOW',
        };
        styling.effects.mapped.push(shadow);
        if ((fx.spread ?? 0) > 0) {
          this.diag({ severity: 'INFO', code: 'EFFECT-SPREAD', feature: 'shadow', reason: 'Shadow spread is ignored (Compose `Modifier.shadow` has no spread parameter).', source: ref });
        }
        if (Math.abs(fx.offset?.x ?? 0) > 0.01 || Math.abs(fx.offset?.y ?? 0) > 0.01) {
          this.diag({ severity: 'WARNING', code: 'SHADOW-OFFSET', feature: 'shadow', reason: 'Compose `Modifier.shadow` has no offset parameter; the shadow is emitted centered by default.', source: ref });
        }
      } else {
        styling.effects.unsupported.push({ effectType: fx.type, reason: `${fx.type} effect has no direct Compose mapping.` });
        this.diag({
          severity: 'WARNING',
          code: 'UNSUPPORTED-EFFECT',
          feature: fx.type,
          reason: `${fx.type} effect is reported but not reproduced.`,
          suggestion: fx.type === 'BACKGROUND_BLUR' ? 'Consider `Modifier.blur` on the composable, or accept reduced fidelity.' : undefined,
          source: ref,
        });
      }
    }
    return styling;
  }

  private readRadius(node: FigmaSceneNodeBase): WithOrigin<Radius> | null {
    if (!isMixedValue(this.ctx, node.cornerRadius ?? null) && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      return { value: { kind: 'fixed', px: node.cornerRadius }, origin: 'explicit' };
    }
    const tl = node.topLeftRadius ?? 0;
    const tr = node.topRightRadius ?? 0;
    const br = node.bottomRightRadius ?? 0;
    const bl = node.bottomLeftRadius ?? 0;
    if (tl === 0 && tr === 0 && br === 0 && bl === 0) return null;
    if (tl === tr && tr === br && br === bl) return { value: { kind: 'fixed', px: tl }, origin: 'explicit' };
    return { value: { kind: 'independent', tl, tr, br, bl }, origin: 'explicit' };
  }

  private paintToBackground(paint: FigmaPaint, ref: SourceRef): { background: IrStyling['background']; unsupported?: string } {
    const opacity = typeof paint.opacity === 'number' ? paint.opacity : 1;
    if (paint.type === 'SOLID') {
      const solid = paint as FigmaSolidPaint;
      const color = irColor(solid.color, opacity);
      this.resolveTokenRef(paint, color, ref);
      return { background: { kind: 'SOLID', color, origin: 'explicit' } };
    }
    if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') {
      const gp = paint as FigmaGradientPaint;
      if (paint.type === 'GRADIENT_LINEAR') {
        const { p0, p1 } = linearGradientEnds(gp.gradientTransform);
        return { background: { kind: 'GRADIENT_LINEAR', gradient: { kind: 'LINEAR', p0, p1, stops: this.gradientStops(gp) }, origin: 'explicit' } };
      }
      if (paint.type === 'GRADIENT_RADIAL') {
        const { center, radius } = radialGradientParams(gp.gradientTransform);
        return { background: { kind: 'GRADIENT_RADIAL', gradient: { kind: 'RADIAL', p0: center, radius, stops: this.gradientStops(gp) }, origin: 'explicit' } };
      }
      return { background: null, unsupported: `${paint.type} gradient is not supported; the fill is omitted.` };
    }
    if (paint.type === 'IMAGE') {
      const ip = paint as FigmaImagePaintAlias;
      if (ip.rotation && Math.abs(ip.rotation ?? 0) > 0.001) {
        this.diag({ severity: 'INFO', code: 'IMAGE-ROTATION', feature: 'image', reason: 'Rotated image fills are approximated without the rotation.', source: ref });
      }
      return { background: { kind: 'IMAGE', image: { imageHash: ip.imageHash, scaleMode: ip.scaleMode ?? 'FILL', opacity }, origin: 'explicit' } };
    }
    return { background: null, unsupported: `Fill type '${paint.type}' is not supported and was ignored.` };
  }

  private gradientStops(gp: FigmaGradientPaint): IrGradientStop[] {
    const stops: IrGradientStop[] = [];
    for (const s of gp.gradientStops ?? []) {
      const color = irColor(s.color);
      this.resolveTokenRef({ type: 'SOLID', color: s.color } as unknown as FigmaPaint, color, { fuid: '', nodeName: '', fType: 'GRADIENT' });
      stops.push({ offset: Math.min(1, Math.max(0, s.position)), color });
    }
    return stops;
  }

  /* ------------------------- text ------------------------- */

  private extractText(node: FigmaTextNodeType, base: NodeBase, styling: IrStyling): IrNode {
    let segments = styledSegments(node);
    if (segments.length === 0) segments = [typographyFromNode(node, this.ctx)];

    const spans: IrTextSpan[] = [];
    let lastSignature: string | null = null;
    for (const seg of segments) {
      const sig = styleSignature(seg);
      if (lastSignature !== null && sig !== lastSignature) {
        this.diag({
          severity: 'WARNING',
          code: 'MIXED-TEXT-STYLES',
          feature: 'text style',
          reason: 'Text node contains mixed styles; only the first style is emitted.',
          suggestion: 'Split the node into separate text layers in Figma to preserve per-segment styles.',
          source: base.ref,
        });
        break;
      }
      lastSignature = sig;
      const span = this.spanToIrSpan(seg);
      const last = spans[spans.length - 1];
      if (last != null) last.text += span.text;
      else spans.push(span);
    }

    return {
      type: 'text',
      ...base,
      spans,
      textAlignHorizontal: node.textAlignHorizontal
        ? { value: node.textAlignHorizontal, origin: 'explicit' }
        : null,
      textAlignVertical: node.textAlignVertical
        ? { value: node.textAlignVertical, origin: 'explicit' }
        : null,
      textAutoResize: { value: node.textAutoResize ?? 'WIDTH_AND_HEIGHT', origin: 'explicit' },
      sizing: textSizing(node),
      ...styling,
    };
  }

  private spanToIrSpan(seg: FigmaStyledTextSegment): IrTextSpan {
    const fontSize = typeof seg.fontSize === 'number' ? seg.fontSize : null;
    const lineHeightValue = seg.lineHeight as { value: number; unit: 'PIXELS' | 'PERCENT' | 'AUTO' } | undefined;
    const letterSpacingValue = seg.letterSpacing as { value: number; unit: 'PIXELS' | 'PERCENT' } | undefined;

    let lineHeightPx: number | null = null;
    if (lineHeightValue) {
      if (lineHeightValue.unit === 'PIXELS') lineHeightPx = lineHeightValue.value;
      else if (lineHeightValue.unit === 'PERCENT' && fontSize != null) lineHeightPx = (fontSize * lineHeightValue.value) / 100;
    }
    let letterSpacingPx: number | null = null;
    if (letterSpacingValue) {
      if (letterSpacingValue.unit === 'PIXELS') letterSpacingPx = letterSpacingValue.value;
      else if (letterSpacingValue.unit === 'PERCENT' && fontSize != null) letterSpacingPx = (fontSize * letterSpacingValue.value) / 100;
      else if (letterSpacingValue.unit === 'PERCENT' && fontSize == null) {
        this.diag({ severity: 'INFO', code: 'MIXED-TEXT-STYLES', feature: 'letter spacing', reason: 'Percent letter spacing requires font size; the value is omitted.', source: null });
      }
    }

    const family = seg.fontName?.family ?? null;
    const style = seg.fontName?.style ?? '';
    this.recordFont(family, style);
    const weight = typeof seg.fontWeight === 'number' ? seg.fontWeight : weightFromName(style);
    const italic = /italic/i.test(style);

    let color: IrColor | null = null;
    const fills = seg.fills && !isMixedValue(this.ctx, seg.fills) ? (seg.fills as readonly FigmaPaint[]) : null;
    const solid = fills?.find((p) => p.visible !== false && p.type === 'SOLID');
    if (solid) {
      const sp = solid as FigmaSolidPaint;
      color = irColor(sp.color, typeof solid.opacity === 'number' ? solid.opacity : 1);
      this.resolveTokenRef(solid, color, baseRefOf(seg));
    } else if (fills && fills.length > 0) {
      this.diag({ severity: 'INFO', code: 'UNSUPPORTED-FILL', feature: 'text fill', reason: 'Text fill is not a solid color; the color is omitted.', source: null });
    }

    return {
      text: seg.characters ?? '',
      fontFamily: family,
      fontWeight: weight,
      fontStyle: italic ? 'italic' : 'regular',
      fontSizePx: fontSize,
      lineHeightPx,
      letterSpacingPx,
      textCase: typeof seg.textCase === 'string' ? seg.textCase : 'ORIGINAL',
      decoration: typeof seg.textDecoration === 'string' ? seg.textDecoration : 'NONE',
      color,
      origin: 'explicit',
    };
  }
}

type FigmaImagePaintAlias = {
  type: 'IMAGE';
  imageHash: string;
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  rotation?: number;
  opacity?: number;
};

function baseRefOf(seg: FigmaStyledTextSegment): SourceRef {
  return { fuid: `seg:${seg.start}-${seg.end}`, nodeName: seg.characters.slice(0, 24), fType: 'TEXT_SEGMENT' };
}

/* ---------------------------------------------------------------------------
 * Auto-layout, sizing and text properties
 * ------------------------------------------------------------------------ */

function readAutoLayout(
  node: FigmaSceneNodeBase,
  ctx: FigmaContext,
  ref: SourceRef,
): WithOrigin<AutoLayout | null> {
  const mode = node.layoutMode;
  if (mode === undefined || mode === null || mode === 'NONE') return { value: null, origin: 'inferred' };
  const direction: AutoLayout['direction'] = mode === 'HORIZONTAL' ? 'ROW' : 'COLUMN';

  let gap: WithOrigin<number> | null = null;
  if (!isMixedValue(ctx, node.itemSpacing ?? null) && typeof node.itemSpacing === 'number') {
    gap = { value: node.itemSpacing, origin: 'explicit' };
  }
  if (isMixedValue(ctx, node.itemSpacing ?? null)) {
    this_diagGapMissing(ref);
  }

  const padding = {
    t: node.paddingTop ?? 0,
    r: node.paddingRight ?? 0,
    b: node.paddingBottom ?? 0,
    l: node.paddingLeft ?? 0,
  };

  const main = mapMainAxis(node.primaryAxisAlignItems);
  const cross = mapCrossAxis(node.counterAxisAlignItems);
  const wrap: WithOrigin<boolean> | null = node.layoutWrap === 'WRAP' ? { value: true, origin: 'explicit' } : null;

  const layout: AutoLayout = {
    direction,
    gapPx: gap,
    padding: { value: padding, origin: 'explicit' },
    mainAxis: { value: main, origin: 'explicit' },
    crossAxis: { value: cross, origin: 'explicit' },
    wrap,
  };
  return { value: layout, origin: 'explicit' };
}

function this_diagGapMissing(ref: SourceRef): void {
  void ref;
  // Mixed item spacing (e.g. first/last-child spacing) is reported at generation time;
  // here we leave `gapPx = null` which the generator then handles explicitly.
}

type MainAxisValue = NonNullable<AutoLayout['mainAxis']>['value'];
type CrossAxisValue = NonNullable<AutoLayout['crossAxis']>['value'];

function mapMainAxis(v: FigmaSceneNodeBase['primaryAxisAlignItems']): MainAxisValue {
  switch (v) {
    case 'MAX': return 'END';
    case 'CENTER': return 'CENTER';
    case 'SPACE_BETWEEN': return 'SPACE_BETWEEN';
    default: return 'START';
  }
}

function mapCrossAxis(v: FigmaSceneNodeBase['counterAxisAlignItems']): CrossAxisValue {
  switch (v) {
    case 'MAX': return 'END';
    case 'CENTER': return 'CENTER';
    case 'BASELINE': return 'BASELINE';
    default: return 'START';
  }
}

/** Sizing semantics of a node; uses `layoutSizing*` when the API provides it, else inferred. */
function readSizing(node: FigmaSceneNodeBase, ctx: FigmaContext, root: boolean): SizeSemantics {
  const h = node.layoutSizingHorizontal;
  const v = node.layoutSizingVertical;
  let horizontal: SizingAxis = 'FIXED';
  let vertical: SizingAxis = 'FIXED';
  let origin: 'explicit' | 'inferred' = 'inferred';
  if (h === 'FIXED' || h === 'HUG' || h === 'FILL') horizontal = h;
  if (v === 'FIXED' || v === 'HUG' || v === 'FILL') vertical = v;
  if (h !== undefined || v !== undefined) {
    origin = !isMixedValue(ctx, h ?? null) || !isMixedValue(ctx, v ?? null) ? 'explicit' : origin;
  }
  if (root) {
    horizontal = 'FIXED';
    vertical = 'FIXED';
    origin = 'explicit';
  }
  return {
    horizontal: { value: horizontal, origin },
    vertical: { value: vertical, origin },
  };
}

/** Text sizing derived from `textAutoResize` (fixed-size text boxes vs hug). */
function textSizing(node: FigmaTextNodeType): SizeSemantics {
  switch (node.textAutoResize ?? 'WIDTH_AND_HEIGHT') {
    case 'WIDTH_AND_HEIGHT':
      return { horizontal: { value: 'HUG', origin: 'explicit' }, vertical: { value: 'HUG', origin: 'explicit' } };
    case 'HEIGHT':
      return { horizontal: { value: 'FIXED', origin: 'explicit' }, vertical: { value: 'HUG', origin: 'explicit' } };
    default:
      return { horizontal: { value: 'FIXED', origin: 'explicit' }, vertical: { value: 'FIXED', origin: 'explicit' } };
  }
}

/** Fallback font weight inferred from the Figma font style name. */
function weightFromName(style: string): number | null {
  const s = style.toLowerCase();
  if (s.includes('extrabold') || s.includes('extra bold')) return 800;
  if (s.includes('black')) return 900;
  if (s.includes('semibold') || s.includes('semi bold')) return 600;
  if (s.includes('bold')) return 700;
  if (s.includes('medium')) return 500;
  if (s.includes('light')) return 300;
  if (s.includes('thin')) return 200;
  if (s.includes('regular') || s.includes('normal')) return 400;
  return null;
}
