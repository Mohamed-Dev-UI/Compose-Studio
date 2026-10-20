/**
 * Intermediate Representation (IR) of a Figma design in Compose Studio.
 *
 * The IR is the boundary between the Figma extractor and the Kotlin generator.
 * It must be serializable, versioned, independent of the Figma Plugin API and
 * independent of Kotlin code generation, and must distinguish between values
 * that come from the design (explicit), values referenced through design
 * tokens, values inferred, and values supplied by the user.
 */

export const IR_VERSION = 1;

/** Reference to the source Figma node. */
export type SourceRef = {
  /** Figma node id. */
  fuid: string;
  /** Human-readable name of the node in the Figma document (before sanitizing). */
  nodeName: string;
  /** Figma node type, e.g. FRAME, TEXT, COMPONENT, INSTANCE... */
  fType: string;
};

/** Where a value in the IR comes from. This distinction is a core invariant. */
export type ValueOrigin = 'explicit' | 'token' | 'inferred' | 'user';

/** A value paired with the origin it came from. */
export type WithOrigin<T> = { value: T; origin: ValueOrigin };

/** Normalized color as 0..1 float channels (Figma convention). */
export type IrColorRgba = { r: number; g: number; b: number; a: number };

/** Stable references to design tokens (Figma variables) discovered during conversion. */
export type TokenRef = {
  variableId: string;
  variableName: string | null;
  /** Variable collection name when known (empty when not). */
  collection: string;
  /** Mode id used to resolve this reference's concrete value, when known. */
  modeId: string | null;
  modeName: string | null;
};

/** A color value that may also reference a token. */
export type IrColor = {
  rgba: IrColorRgba;
  tokenRef: TokenRef | null;
};

export type IrGradientStop = { offset: number; color: IrColor };

export type IrGradient = {
  kind: 'LINEAR' | 'RADIAL' | 'OTHER';
  /** LINEAR: start (p0) and end (p1) points in the node's normalized 0..1 space. */
  p0: [number, number];
  p1?: [number, number];
  /** RADIAL: center point and radius in normalized space. radius >= 0. */
  radius?: number;
  stops: IrGradientStop[];
};

export type IrImageFill = {
  imageHash: string;
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  /** Opacity of the image fill as a fraction (0..1). */
  opacity: number;
};

export type IrPaint =
  | { kind: 'SOLID'; color: IrColor; origin: ValueOrigin }
  | { kind: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'OTHER'; gradient: IrGradient; origin: ValueOrigin }
  | { kind: 'IMAGE'; image: IrImageFill; origin: ValueOrigin };

/** A border created with an explicit stroke. */
export type IrBorder = {
  widthPx: WithOrigin<number>;
  color: IrColor;
  strokeAlign: WithOrigin<'INSIDE' | 'OUTSIDE' | 'CENTER'>;
  dashPattern: number[] | null;
};

export type Radius = { kind: 'fixed'; px: number } | { kind: 'independent'; tl: number; tr: number; br: number; bl: number };

/** Only `DROP` shadows are mapped; everything else is reported as unsupported. */
export type ShadowSpec = {
  color: IrColor;
  blurPx: number;
  xPx: number;
  yPx: number;
  spreadPx: number;
  effectType: 'DROP_SHADOW';
};

/** Effects we deliberately cannot express; recorded so the report can explain them. */
export type UnsupportedEffect = { effectType: string; reason: string };

export type Background =
  | { kind: 'SOLID'; color: IrColor; origin: ValueOrigin }
  | { kind: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'; gradient: IrGradient; origin: ValueOrigin }
  | { kind: 'IMAGE'; image: IrImageFill; origin: ValueOrigin };

export type IrPadding = { t: number; r: number; b: number; l: number };

export type AutoLayout = {
  direction: 'ROW' | 'COLUMN';
  gapPx: WithOrigin<number> | null;
  padding: WithOrigin<IrPadding> | null;
  mainAxis: WithOrigin<'START' | 'END' | 'CENTER' | 'SPACE_BETWEEN'> | null;
  crossAxis: WithOrigin<'START' | 'END' | 'CENTER' | 'BASELINE'> | null;
  /** Figma `layoutWrap === 'WRAP'`. */
  wrap: WithOrigin<boolean> | null;
};

export type SizingAxis = 'FIXED' | 'HUG' | 'FILL';

export type SizeSemantics = {
  horizontal: WithOrigin<SizingAxis>;
  vertical: WithOrigin<SizingAxis>;
};

export type IrStyling = {
  background: Background | null;
  /** Additional paints behind the primary one that were not mapped. */
  extraBackgrounds: { paint: IrPaint; reason: string }[];
  border: IrBorder | null;
  radius: WithOrigin<Radius> | null;
  opacity: WithOrigin<number>;
  clip: WithOrigin<boolean>;
  effects: {
    mapped: ShadowSpec[];
    unsupported: UnsupportedEffect[];
  };
};

export type IrGeometry = { x: number; y: number; width: number; height: number };

type IrBase = {
  id: string;
  ref: SourceRef;
  /** Focused parent-child order (document order). */
  index: number;
  parent: string | null;
  /** Full path of ids from the document root (root last). */
  idPath: string[];
  geometry: IrGeometry;
  /**
   * True when the Figma node had `layoutPositioning === 'ABSOLUTE'` — it
   * ignores its parent's auto-layout and is placed at its explicit x/y.
   * (Added during phase 1 development, before any release: still IR v1.)
   */
  absolute: boolean;
};

export type IrContainerNode = IrBase & IrStyling & {
  type: 'container';
  kind: 'SCREEN' | 'COMPONENT' | 'CONTAINER';
  layout: WithOrigin<AutoLayout | null>;
  sizing: SizeSemantics;
  children: IrNode[];
};

export type IrGroupNode = IrBase & IrStyling & {
  type: 'group';
  children: IrNode[];
};

export type IrTextNode = IrBase & IrStyling & {
  type: 'text';
  spans: IrTextSpan[];
  textAlignHorizontal: WithOrigin<'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> | null;
  textAlignVertical: WithOrigin<'TOP' | 'CENTER' | 'BOTTOM'> | null;
  textAutoResize: WithOrigin<'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE' | 'NONE'>;
  sizing: SizeSemantics;
};

export type IrTextSpan = {
  text: string;
  fontFamily: string | null;
  fontWeight: number | null;
  fontStyle: 'regular' | 'italic';
  fontSizePx: number | null;
  lineHeightPx: number | null;
  letterSpacingPx: number | null;
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  color: IrColor | null;
  /** Whether this span's style came from a text style (grouped) or is inline. */
  origin: ValueOrigin;
};

export type IrInstanceNode = IrBase & IrStyling & {
  type: 'instance';
  componentName: string;
  /** Figma component key (id of the master component). */
  componentKey: string;
  /** Variant string like "Type=Primary" when this instance belongs to a component set. */
  variantProps: Record<string, string> | null;
  /**
   * When the master belongs to a component set: the set's identity. Variant
   * families generate one composable with variant parameters (see docs).
   */
  componentSet: { id: string; name: string } | null;
  /**
   * Non-variant component properties with this instance's values; keys have
   * their `#id` suffix stripped (TEXT/BOOLEAN/…, never VARIANT).
   */
  componentProps: Record<string, { kind: 'TEXT' | 'BOOLEAN' | 'OTHER'; value: string | boolean }> | null;
  /** True when this instance is derived from a mapping, i.e. resolved to a user component. */
  children: IrNode[];
  layout: WithOrigin<AutoLayout | null>;
  sizing: SizeSemantics;
};

export type IrShapeNode = IrBase & IrStyling & {
  type: 'shape';
  shape: 'RECTANGLE' | 'ELLIPSE' | 'LINE';
  ellipseArc?: { startingAngle: number; endingAngle: number; innerRadius: number };
};

export type IrVectorNode = IrBase & IrStyling & {
  type: 'vector';
  vectorType: 'VECTOR' | 'BOOLEAN_OPERATION' | 'POLYGON' | 'STAR';
};

export type IrUnknownNode = IrBase & {
  type: 'unknown';
  reason: string;
};

export type IrNode =
  | IrContainerNode
  | IrGroupNode
  | IrTextNode
  | IrInstanceNode
  | IrShapeNode
  | IrVectorNode
  | IrUnknownNode;

/** Which fonts are referenced by the design (needed for the font mapping UI). */
export type FontUsage = { family: string; style: string; available: boolean };

/** Which Figma variables are referenced by the design. */
export type VariableUsage = { variableId: string; variableName: string; collection: string; modeId: string | null; modeName: string | null };

/** Components referenced by instances (for the mapping UI). */
export type ComponentUsage = { componentName: string; componentKey: string; instanceCount: number };

export type IrDocument = {
  version: typeof IR_VERSION;
  root: IrNode;
  fonts: FontUsage[];
  variables: VariableUsage[];
  components: ComponentUsage[];
  diagnostics: IrDiagnostic[];
};

export type DiagnosticSeverity = 'INFO' | 'WARNING' | 'ERROR';

export type IrDiagnostic = {
  severity: DiagnosticSeverity;
  /** Stable machine code, e.g. `MISSING-FONT`. */
  code: string;
  /** Stable human-readable feature, e.g. "text style". */
  feature: string;
  reason: string;
  suggestion?: string;
  source: SourceRef | null;
};

/** All node kinds carrying full styling/layout data (unknown nodes are skipped in generation). */
export type StyledIrNode = IrContainerNode | IrGroupNode | IrTextNode | IrInstanceNode | IrShapeNode | IrVectorNode;

/** Node ids as used in the IR are simply the Figma node ids (stable strings). */
export function irNodeFuid(node: IrNode): string {
  return node.id;
}

/** Walk the IR node tree in document order. */
export function walkIr(node: IrNode, visit: (n: IrNode) => void): void {
  visit(node);
  const children = node.type === 'container' || node.type === 'group' || node.type === 'instance' ? node.children : null;
  if (children) for (const c of children) walkIr(c, visit);
}
