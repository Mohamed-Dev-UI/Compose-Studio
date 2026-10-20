/**
 * Kotlin code generator (orchestrator).
 *
 * Consumes IR documents + a mapping profile and produces generated Kotlin
 * files, an asset manifest and diagnostics. Deterministic: identical inputs
 * produce identical output.
 *
 * Conventions (documented in docs/generation.md):
 * - Auto Layout frames become Row/Column; plain frames/groups become Box.
 * - `1 Figma px == 1 dp`; font sizes are emitted in sp.
 * - Modifier chains follow the canonical order in modifiers.ts.
 * - Text nodes use material3 `Text` unless a mapping resolves to a custom
 *   composable; typography uses inline TextStyle unless a text mapping is
 *   configured in the profile.
 */
import type {
  AutoLayout,
  IrColor,
  IrContainerNode,
  IrDocument,
  IrGroupNode,
  IrInstanceNode,
  IrNode,
  IrShapeNode,
  IrTextSpan,
  IrTextNode,
  IrVectorNode,
  SourceRef,
  StyledIrNode,
} from '../ir/ir.ts';
import type { ComponentArgumentMapping, ComponentMapping, MappingProfile } from '../mapping/profile.ts';
import { emptyProfile } from '../mapping/profile.ts';
import { resolveComponentMapping, resolveFontMapping, resolveTextMapping } from '../mapping/resolve.ts';
import type { LibraryAsset, NodeMark } from '../shared/marks.ts';
import { escapeKotlinString, spLiteral } from '../util/format.ts';
import { camelCase, isKotlinSafeIdentifier, pascalCase, safeIdentifier, sanitizeKotlinIdentifier, snakeCase } from '../util/identifiers.ts';
import type { Asset, AssetCandidateExtra, AssetKind } from './assets.ts';
import { AssetRegistry } from './assets.ts';
import { imageVectorSymbol } from './imagevector.ts';
import { buildModifierChain, type ModifierHelpers, type ParentInfo } from './build-modifiers.ts';
import {
  arrangementExpr,
  childAlignExpr,
  circleShapeExpr,
  crossAlignParam,
  fontWeightExpr,
  shapeExprFromRadius,
} from './expr.ts';
import {
  childCtx,
  colorExprWithImport,
  makeColorExpr,
  modifierHelpers,
  type EmitCtx,
  type EmitEnv,
} from './emit-context.ts';
import { KotlinFile } from './kotlin-writer.ts';
import { ModifierChain } from './modifiers.ts';
import { makeDpExpr, makeTextStyleResolver, type UsageResolvers } from './usage.ts';
import {
  composeConfigSignature,
  describeComposeConfig,
  MATERIAL_ROLES,
  ROLE_NOTES,
  ROLE_PARAMETERS,
  WIRED_ROLES,
  type MappingArgDataType,
  type ParsedComponentConfig,
} from '../shared/compose-config.ts';

export type GeneratedFile = { path: string; content: string; language: 'kotlin' };
export type GeneratedDiagnostic = {
  level: 'INFO' | 'WARNING' | 'ERROR';
  code: string;
  message: string;
  nodeName?: string;
  nodeKind?: string;
  feature?: string;
};
export type GenerationOptions = {
  packageName: string;
  profile: MappingProfile | null;
  /**
   * Icon asset name filter (e.g. `ic_`). When set, only vector nodes whose
   * name starts with it (case-insensitively) are exported as SVG assets;
   * everything else is treated as decoration. Empty/null = auto-detect.
   */
  iconAssetPrefix?: string | null;
  /**
   * Image asset name filter (e.g. `img_`). Same as `iconAssetPrefix` but for
   * PNG image fills.
   */
  imageAssetPrefix?: string | null;
  /**
   * How auto-generated components declare variant parameters: `enum`
   * (default), `sealed`, or plain `string` (legacy).
   */
  variantParamStyle?: VariantParamStyle;
  /**
   * How multi-variant component bodies are structured (`variantShape`
   * setting): `auto` measures the differences between the variant bodies and
   * picks `params` (near-identical variants -> shared value parameters),
   * `when` (moderate differences), or `functions` (very different bodies);
   * `when` always keeps the classic parameterized `when`; `functions` emits
   * one top-level composable per variant; `object` nests them inside
   * `object <Name>`. Single-master components are unaffected.
   */
  variantShape?: VariantShape;
  /**
   * Component masters harvested from their component sets (async, plugin
   * side) so every variant of a set in use is coded even when the selection
   * instantiates only some of them. `null` props on these entries marks them
   * as harvested masters (no instance-backed component properties).
   */
  variantMasters?: IrInstanceNode[];
  /**
   * Curated asset-library entries harvested from the designer's asset
   * pages. Nodes matching an entry export the canonical page asset (the
   * matched node kind must agree: vectors/SVG, image fills/PNG).
   */
  assetLibrary?: LibraryAsset[];
  /**
   * User-marked asset skips: matched nodes keep their layout but export no
   * asset (`ASSET-EXCLUDED` with the mark reason).
   */
  assetSkipMarks?: NodeMark[];
  /**
   * Master asset gate (plugin settings): `false` excludes every asset
   * candidate. Defaults to `true`.
   */
  exportAssets?: boolean;
  /**
   * Export format for vector-source assets: `svg` file (default),
   * Kotlin `ImageVector` code, or a `png` raster.
   */
  vectorFormat?: 'svg' | 'imagevector' | 'png';
  /**
   * Export format for image-fill assets: `auto` keeps Figma's stored
   * bytes/extension (default), `png`/`jpg` re-render the node.
   */
  imageFormat?: 'auto' | 'png' | 'jpg';
  /**
   * Design-system value substitution (usage-derived tokens). When set,
   * colors/sizes/radii/paddings/gaps/borders/text styles that carry an exact
   * entry are emitted as references to the generated design-system symbols
   * (`Colors.CardSurface`, `Metrics.Padding16`, `Type.TitleLarge`, …)
   * instead of raw literals. Null keeps every literal as before.
   */
  usage?: UsageResolvers | null;
  /**
   * Component configuration descriptions (CCD) keyed by the master
   * component id, parsed from each component's Figma `description` by the
   * plugin (see `shared/compose-config.ts`). `role` mints role parameters on
   * the generated composable and may route the body through its Material 3
   * composable when the look can be matched exactly; `kind`/`assets` turn
   * every instance of the component into an asset; `mapping` maps instances
   * to an app composable (profile mappings still win).
   */
  componentConfigs?: Record<string, ParsedComponentConfig>;
};
export type GenerationResult = {
  files: GeneratedFile[];
  assets: Asset[];
  diagnostics: GeneratedDiagnostic[];
};

const INDENT_STEP = 4;

/**
 * Modifier part name -> required import path. Parts that are member extensions
 * of Row/Column/Box content scopes (`weight`, `align`) resolve from the
 * receiver scope and need no import.
 */
const MODIFIER_PART_IMPORTS: Record<string, string | undefined> = {
  size: 'androidx.compose.foundation.layout.size',
  width: 'androidx.compose.foundation.layout.width',
  height: 'androidx.compose.foundation.layout.height',
  fillMaxWidth: 'androidx.compose.foundation.layout.fillMaxWidth',
  fillMaxHeight: 'androidx.compose.foundation.layout.fillMaxHeight',
  fillMaxSize: 'androidx.compose.foundation.layout.fillMaxSize',
  offset: 'androidx.compose.foundation.layout.offset',
  wrapContentHeight: 'androidx.compose.foundation.layout.wrapContentHeight',
  padding: 'androidx.compose.foundation.layout.padding',
  shadow: 'androidx.compose.ui.draw.shadow',
  clip: 'androidx.compose.ui.draw.clip',
  clipToBounds: 'androidx.compose.ui.draw.clipToBounds',
  clickable: 'androidx.compose.foundation.clickable',
  border: 'androidx.compose.foundation.border',
  background: 'androidx.compose.foundation.background',
  paint: 'androidx.compose.ui.draw.paint',
  alpha: 'androidx.compose.ui.draw.alpha',
};

const LAYOUT_COMPOSABLE_IMPORTS: Record<'Row' | 'Column' | 'Box', string> = {
  Row: 'androidx.compose.foundation.layout.Row',
  Column: 'androidx.compose.foundation.layout.Column',
  Box: 'androidx.compose.foundation.layout.Box',
};

/** Facts a mapped composable call can draw from the design subtree. */
export type MappingInfo = {
  /** Text contents (document order) available to `text` argument sources. */
  texts: string[];
  /** Vector nodes (document order; nested vector subtrees are not descended) for `icon` sources. */
  iconNodes: StyledIrNode[];
  /** Representative color: first text color, else the node's solid background. */
  firstColor: IrColor | null;
};

export function generateCode(docs: IrDocument[], opts: GenerationOptions): GenerationResult {
  const g = new Generator(opts);
  g.buildAutoComponents(docs);
  g.generateAutoComponentFiles();
  for (const doc of docs) g.generateScreen(doc);
  return { files: g.files, assets: g.assets.list(), diagnostics: g.diagnostics };
}

/* ---------------------------- auto components ---------------------------- */

/**
 * How variant parameters are declared on auto-generated components.
 * `enum` (default) mints `enum class` types, `sealed` mints `sealed
 * interface` hierarchies of `object`s, `string` keeps plain string
 * parameters (legacy behavior).
 */
export type VariantParamStyle = 'enum' | 'sealed' | 'string';

/**
 * Emission shape of a multi-variant component body (Settings → *Variant code
 * shape*). See `GenerationOptions.variantShape`.
 */
export type VariantShape = 'auto' | 'when' | 'functions' | 'object';

/** The emission plan chosen for one multi-variant component. */
export type VariantPlan =
  | { kind: 'when' }
  /**
   * The variant bodies are near-identical: the differing value tokens lift
   * into typed parameters (Color/String/Boolean/Dp/TextUnit/FontWeight) with
   * the reference variant's values as defaults; the variant-key parameters
   * disappear because nothing dispatches on them.
   */
  | { kind: 'params'; lifts: VariantLift[]; values: Map<string, string[]> }
  /**
   * One composable per variant: distinct funs named `<Component><Value…>`
   * (`functions`) or `<Valu…>` inside `object <Component>` (`object`). Call
   * sites pick the variant's function directly (no `when`, no variant-key
   * parameters).
   */
  | { kind: 'functions'; fns: Map<string, string> }
  | { kind: 'object'; objectName: string; fns: Map<string, string> };

/** One value token lifted from the reference body into a parameter (params shape). */
export type VariantLift = {
  /** Body line index (the reference master's emitted body). */
  line: number;
  /** Ordinal of the differing token on that line. */
  tok: number;
  param: string;
  kind: 'color' | 'string' | 'bool' | 'dp' | 'sp' | 'weight';
  /** Kotlin parameter type. */
  typeName: string;
  /** Expression default (the reference master's token) written in the signature. */
  defaultExpr: string;
};

/** Value-token kinds liftable into parameters, with their Kotlin types/imports. */
const LIFT_KINDS: Record<VariantLift['kind'], { type: string; import: string | null }> = {
  color: { type: 'Color', import: 'androidx.compose.ui.graphics.Color' },
  string: { type: 'String', import: null },
  bool: { type: 'Boolean', import: null },
  dp: { type: 'Dp', import: 'androidx.compose.ui.unit.Dp' },
  sp: { type: 'TextUnit', import: 'androidx.compose.ui.unit.TextUnit' },
  weight: { type: 'FontWeight', import: 'androidx.compose.ui.text.font.FontWeight' },
};

/**
 * Value tokens detected inside emitted lines: string literals, color
 * constants, dp/sp numbers, FontWeight constants and bare booleans.
 */
const VALUE_TOKEN_RE =
  /"((?:[^"\\]|\\.)*)"|Color\(0x[0-9A-Fa-f]{6,8}\)|-?(?:\d+(?:\.\d+)?)\.(?:dp|sp)\b|FontWeight\.[A-Z][A-Za-z]*|\btrue\b|\bfalse\b/g;

function tokenKindOf(token: string, quoted: boolean): VariantLift['kind'] {
  if (quoted) return 'string';
  if (token.startsWith('Color(')) return 'color';
  if (/\.dp$/.test(token)) return 'dp';
  if (/\.sp$/.test(token)) return 'sp';
  if (token.startsWith('FontWeight.')) return 'weight';
  return 'bool';
}

/**
 * Auto-tiering thresholds (documented in generation.md): value-only
 * differences lift into parameters while they stay small — at most 3
 * differing lines or 35% of the body, and at most 6 lifted tokens; bodies
 * with 55%+ divergent lines (and structural differences) become separate
 * composables; everything between stays a `when`.
 */
const AUTO_PARAMS_MAX_DIFFS = 3;
const AUTO_PARAMS_MAX_RATIO = 0.35;
const AUTO_PARAMS_MAX_LIFTS = 6;
const AUTO_FUNCTIONS_MIN_RATIO = 0.55;

/** Source-consumed value tokens per body line (per variant master). */
type MasterSurface = {
  /** Token-erased skeleton lines (shape comparison across masters). */
  shapes: string[];
  /** Raw lines aligned with `shapes`. */
  lines: string[];
  /** Value tokens per line, in scan order. */
  lineTokens: string[][];
  /** Token kinds per line, aligned with `lineTokens`. */
  lineKinds: string[][];
};

/** Fallback base names for lifted parameters when no argument hint exists. */
const KIND_PARAM_NAMES: Record<VariantLift['kind'], string> = {
  color: 'color',
  string: 'text',
  bool: 'flag',
  dp: 'dim',
  sp: 'scale',
  weight: 'weight',
};

/** Splits a rendered scratch file into its pure body lines. */
function scratchBodyLines(rendered: string): string[] {
  const lines = rendered.split('\n');
  let start = 0;
  while (start < lines.length && (lines[start] === '' || lines[start]!.startsWith('package ') || lines[start]!.startsWith('import '))) {
    start += 1;
  }
  while (lines.length > start && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(start);
}

/** Scans value tokens per line: erased skeletons, raw lines, tokens, kinds. */
function tokenizeSurface(lines: string[]): MasterSurface {
  const shapes: string[] = [];
  const lineTokens: string[][] = [];
  const lineKinds: string[][] = [];
  for (const raw of lines) {
    let shape = '';
    let last = 0;
    const tokens: string[] = [];
    const kinds: string[] = [];
    VALUE_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VALUE_TOKEN_RE.exec(raw)) !== null) {
      const kind = tokenKindOf(m[0], m[1] !== undefined);
      shape += `${raw.slice(last, m.index)}<${kind}>`;
      tokens.push(m[0]);
      kinds.push(kind);
      last = m.index + m[0].length;
    }
    shapes.push(shape + raw.slice(last));
    lineTokens.push(tokens);
    lineKinds.push(kinds);
  }
  return { shapes, lines, lineTokens, lineKinds };
}

/** Replaces the `tok`-th value token on `line` with `replacement`. */
function replaceTokenAt(line: string, tok: number, replacement: string): string {
  VALUE_TOKEN_RE.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = VALUE_TOKEN_RE.exec(line)) !== null) {
    if (n === tok) return `${line.slice(0, m.index)}${replacement}${line.slice(m.index + m[0].length)}`;
    n += 1;
  }
  return line;
}

/** Name hint for a lifted token: the `arg =` assignment immediately before it. */
function paramHintFor(line: string, tok: number): string | null {
  VALUE_TOKEN_RE.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  let tokenStart = -1;
  while ((m = VALUE_TOKEN_RE.exec(line)) !== null) {
    if (n === tok) {
      tokenStart = m.index;
      break;
    }
    n += 1;
  }
  if (tokenStart < 0) return null;
  const before = line.slice(0, tokenStart);
  const arg = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(before);
  if (arg) return arg[1] ?? null;
  // No named argument: fall back to the enclosing call's method name
  // (e.g. `.size(200.dp, …)` hints `size`).
  const method = /\.([A-Za-z_][A-Za-z0-9_]*)\([^()]*$/.exec(before);
  return method ? method[1] ?? null : null;
}

/**
 * A parameter derived from one Figma variant property key. Values that are
 * exactly True/False become `Boolean` parameters; other parameterized keys
 * follow the configured style (enum/sealed mint one type per key).
 */
type AutoVariantParam = {
  /** Figma variant property key (raw, e.g. `size`). */
  key: string;
  /** Kotlin parameter name (unique within the signature). */
  paramName: string;
  /** Declaration kind after applying the configured style. */
  kind: 'boolean' | 'enum' | 'sealed' | 'string';
  /** Kotlin type in the signature (`String`, `Boolean`, or the minted type name). */
  typeName: string;
  /** Distinct variant values across the group's instances (sorted). */
  values: string[];
  /** Entry names aligned with `values` (`XL`, …); boolean/string params stay empty. */
  entries: string[];
  /** Default value (the first master's value). */
  defaultValue: string;
};

/**
 * A generated component parameter derived from a `TEXT` component property.
 * The body's matching text node renders `text = <paramName>` instead of a
 * literal; call sites pass each instance's value.
 */
type AutoTextParam = { propKey: string; paramName: string; defaultValue: string };

/** One master's renderable body: the reference instance plus substitutions. */
type AutoMasterBody = {
  masterKey: string;
  referenceId: string;
  /** Variant values aligned with `variantParams` order. */
  variantValues: string[];
  /** Text node id -> parameter name (body emission reads this). */
  substitutions: Map<string, string>;
};

/** One role-minted parameter: `logical` identifies the role slot (`onClick`, …). */
type AutoRoleParam = {
  logical: string;
  param: string;
  type: string;
  def: string;
};

/** The full spec of an auto-generated component file. */
type AutoComponentSpec = {
  symbol: string;
  groupName: string;
  /** One per variant key, in sorted key order. */
  variantParams: AutoVariantParam[];
  textParams: AutoTextParam[];
  /** Component configuration description (may be null; shared for the group). */
  config: ParsedComponentConfig | null;
  /** Role-minted parameters (empty without a configured role). */
  roleParams: AutoRoleParam[];
  /** Insertion order; the first master provides the defaults. */
  masters: AutoMasterBody[];
  /** Variant emission plan; assigned during `generateAutoComponentFiles`. */
  plan: VariantPlan;
};

class Generator {
  readonly files: GeneratedFile[] = [];
  readonly diagnostics: GeneratedDiagnostic[] = [];
  readonly assets: AssetRegistry;
  private readonly opts: GenerationOptions;
  private readonly profileActive: boolean;
  private file: KotlinFile | null = null;
  private envInstance: EmitEnv | null = null;
  private readonly usedFnNames = new Set<string>();
  /** Minted enum/sealed type names (unique across the whole conversion). */
  private readonly usedTypeNames = new Set<string>();
  /** Repeated-value design-system substitution (optional; see GenerationOptions). */
  private readonly usageResolvers: UsageResolvers | null;
  private readonly unmappedComponents = new Set<string>();
  private readonly fontHints = new Set<string>();
  /** Built component specs (emission order) and their instance membership. */
  private readonly autoSpecs: AutoComponentSpec[] = [];
  private readonly autoByInstance = new Map<string, AutoComponentSpec>();
  /** Index from instance id -> instance node across all converted documents. */
  private readonly instanceIndex = new Map<string, IrInstanceNode>();
  /** Active while emitting a component body: text node id -> parameter name. */
  private substitutions: Map<string, string> | null = null;
  /** True while rendering scratch surfaces (emission diagnostics suppressed). */
  private silent = false;
  /** Active while emitting one auto-component body root: clickable wiring for role roles. */
  private pendingRootWiring: { node: object; args: string[] } | null = null;
  /** Emitted-once per component keys for the config diagnostics. */
  private readonly configDiagKeys = new Set<string>();
  /** CCD component mappings, synthesized per master key on first use. */
  private readonly ccdMappings = new Map<string, ComponentMapping>();

  constructor(opts: GenerationOptions) {
    this.opts = opts;
    this.usageResolvers = opts.usage ?? null;
    this.assets = new AssetRegistry(
      { image: opts.imageAssetPrefix ?? null, icon: opts.iconAssetPrefix ?? null },
      { exportAssets: opts.exportAssets ?? true, vectorFormat: opts.vectorFormat ?? 'svg', imageFormat: opts.imageFormat ?? 'auto' },
    );
    if (opts.assetLibrary?.length) this.assets.seedLibrary(opts.assetLibrary);
    if (opts.assetSkipMarks?.length) this.assets.seedAssetSkips(opts.assetSkipMarks);
    this.profileActive = opts.profile !== null;
  }

  /* ----------------------------- plumbing ----------------------------- */

  private get f(): KotlinFile {
    const file = this.file;
    if (!file) throw new Error('No active Kotlin file (generator misuse).');
    return file;
  }

  private env(): EmitEnv {
    const env = this.envInstance;
    if (!env) throw new Error('No active emission environment (generator misuse).');
    return env;
  }

  private ind(level: number): string {
    return ' '.repeat(Math.max(0, level) * INDENT_STEP);
  }

  private helpers(): ModifierHelpers {
    return modifierHelpers(this.env());
  }

  /** Builds the shared emission environment for one Kotlin file. */
  private makeEmitEnv(file: KotlinFile): EmitEnv {
    const profile = this.opts.profile ?? emptyProfile();
    return {
      file,
      packageName: this.opts.packageName,
      profile,
      assetRegistry: this.assets,
      diag: (level, code, message, ref, feature) => this.diag(level, code, message, ref, feature),
      useImport: (path) => file.useImport(path),
      colorExpr: colorExprWithImport(makeColorExpr(profile, this.usageResolvers), (p) => file.useImport(p)),
      dpExpr: makeDpExpr(this.usageResolvers),
      textExpr: makeTextStyleResolver(this.usageResolvers),
    };
  }

  diag(level: GeneratedDiagnostic['level'], code: string, message: string, ref: SourceRef | null, feature?: string): void {
    // Scratch-surface rendering repeats real emission bodies to measure
    // variant differences; its purpose is measurement, not reporting.
    if (this.silent) return;
    this.diagnostics.push({
      level,
      code,
      message,
      nodeName: ref?.nodeName,
      nodeKind: ref?.fType,
      feature,
    });
  }

  /* ----------------------------- main ----------------------------- */

  /* --------------------- auto components (standalone) --------------------- */

  /**
   * Group standalone instances that carry an async component snapshot into
   * auto-generated components. Instances resolved by a profile mapping are
   * skipped (profile mappings always win). Groups not backed by the snapshot
   * (componentSet and componentProps both null) keep the legacy plain-layout
   * fallback, so runs without the lookup behave exactly as before.
   */
  buildAutoComponents(docs: IrDocument[]): void {
    this.instanceIndex.clear();
    const visit = (node: IrNode): void => {
      if (node.type === 'instance') {
        this.instanceIndex.set(node.id, node);
        for (const child of node.children) visit(child);
        return;
      }
      if (node.type === 'container' || node.type === 'group') {
        for (const child of node.children) visit(child);
      }
    };
    // Masters harvested from their component sets (async, plugin side) ride
    // in first, so every variant of a set in use is coded even when the
    // selection instantiates only some of them. Their subtrees are indexed
    // with the same walk, giving nested component instances call sites too.
    for (const master of this.opts.variantMasters ?? []) {
      this.instanceIndex.set(master.id, master);
      visit(master);
    }
    for (const doc of docs) visit(doc.root);

    const groups = new Map<string, { groupName: string; masters: Map<string, IrInstanceNode[]> }>();
    for (const node of this.instanceIndex.values()) {
      if (this.componentMappingFor(node)) continue; // a profile or configuration mapping takes precedence
      if (this.instanceLibraryMatch(node)) continue; // curated asset-page component: renders as Image
      const ccd = this.componentConfigFor(node.componentKey);
      if (ccd && (ccd.mapping || ccd.assets === 'export' || (ccd.kind !== null && ccd.assets !== 'code'))) {
        continue; // configuration says this component is asset-only or mapped
      }
      if (node.componentProps == null && node.componentSet == null) continue; // legacy path
      const setId = node.componentSet?.id ?? null;
      const groupId = setId ?? node.componentKey;
      const groupName = (setId !== null ? node.componentSet!.name : node.componentName) || 'Component';
      let group = groups.get(groupId);
      if (!group) {
        group = { groupName, masters: new Map() };
        groups.set(groupId, group);
      }
      let members = group.masters.get(node.componentKey);
      if (!members) {
        members = [];
        group.masters.set(node.componentKey, members);
      }
      members.push(node);
    }

    for (const group of groups.values()) {
      this.buildAutoComponentSpec(group);
    }
  }

  /**
   * True when the instance matches a curated asset-library entry (usually
   * by master identity, because a component's instances all share it, so
   * whole groups match or none do). Early-outs when no library is loaded.
   */
  private instanceLibraryMatch(node: IrInstanceNode): boolean {
    const library = this.opts.assetLibrary;
    if (!library || library.length === 0) return false;
    return this.assets.libraryMatch('svg', node.ref, {
      size: { width: node.geometry.width, height: node.geometry.height },
      masterId: node.componentKey,
    }) !== null;
  }

  /** The component configuration description of one master component id. */
  private componentConfigFor(componentKey: string): ParsedComponentConfig | null {
    return this.opts.componentConfigs?.[componentKey] ?? null;
  }

  /**
   * Component mapping for an instance: the mapping profile wins (exact id or
   * name), then the component configuration description's inline `mapping`.
   */
  private componentMappingFor(node: IrInstanceNode): ComponentMapping | null {
    if (this.opts.profile) {
      const hit = resolveComponentMapping(this.opts.profile, {
        componentKey: node.componentKey,
        componentName: node.componentName,
        nodeType: 'INSTANCE',
      });
      if (hit) return hit;
    }
    const cfg = this.componentConfigFor(node.componentKey);
    if (!cfg?.mapping) return null;
    let cached = this.ccdMappings.get(node.componentKey);
    if (!cached) {
      const arguments_: ComponentArgumentMapping[] = cfg.mappingArgs.map((arg) => ({
        argument: arg.argument,
        source: arg.source.kind === 'constant'
          ? (arg.source.dataType
            ? { kind: 'constant', value: arg.source.value, dataType: arg.source.dataType }
            : { kind: 'constant', value: arg.source.value })
          : { kind: arg.source.kind, ...(arg.source.kind === 'text' || arg.source.kind === 'icon' ? { childIndex: 0 } : {}) },
      }));
      cached = {
        source: { kind: 'component', variableId: node.componentKey, componentName: node.componentName },
        target: { symbol: cfg.mapping },
        arguments: arguments_,
      };
      this.ccdMappings.set(node.componentKey, cached);
    }
    return cached;
  }

  /** Turns one group (component set family or standalone master) into a spec. */
  private buildAutoComponentSpec(group: { groupName: string; masters: Map<string, IrInstanceNode[]> }): void {
    const references: AutoMasterBody[] = [];
    for (const [masterKey, members] of group.masters) {
      if (members.length === 0 || !members[0]) continue;
      references.push({
        masterKey,
        referenceId: members[0].id,
        variantValues: [],
        substitutions: new Map(),
      });
    }
    if (references.length === 0) return;

    // Parameter defaults and text substitutions read best from a real
    // instance: hoist an instance-backed reference (deterministically, the
    // first in master order) to the front; harvested masters keep their
    // literal content and join the body list after it.
    const propsIdx = references.findIndex((ref) => this.instanceIndex.get(ref.referenceId)?.componentProps != null);
    if (propsIdx > 0) references.unshift(references.splice(propsIdx, 1)[0]!);

    const allInstances = [...group.masters.values()].flat();
    const variantKeys = [
      ...new Set(allInstances.flatMap((n) => Object.keys(n.variantProps ?? {}))),
    ].sort();
    const first = this.instanceIndex.get(references[0]!.referenceId)!;
    const variantDefaults = variantKeys.map((key) => first.variantProps?.[key] ?? '');

    // Parameter names must stay unique within the file signature.
    const usedNames = new Set<string>(['modifier']);
    const paramFor = (base: string): string => {
      let name = camelCase(base);
      let n = 2;
      while ((usedNames.has(name) || !isKotlinSafeIdentifier(name))) {
        name = `${camelCase(base)}_${n}`;
        n += 1;
      }
      usedNames.add(name);
      return name;
    };

    const variantParams = this.buildVariantParams(
      group.groupName,
      variantKeys,
      variantDefaults,
      allInstances,
      paramFor,
    );

    // TEXT component properties -> string parameters with body substitution.
    const textParams: AutoTextParam[] = [];
    const firstProps = first.componentProps;
    if (firstProps) {
      for (const [propKey, entry] of Object.entries(firstProps)) {
        if (entry.kind !== 'TEXT' || typeof entry.value !== 'string') continue;
        const textNodeId = this.findSubstitution(first, entry.value);
        if (!textNodeId) continue; // no matching body node; stays literal
        const paramName = paramFor(propKey);
        references[0]!.substitutions.set(textNodeId, paramName);
        textParams.push({ propKey, paramName, defaultValue: entry.value });
      }
      for (const [propKey, entry] of Object.entries(firstProps)) {
        if (entry.kind === 'TEXT') continue;
        this.diag(
          'INFO',
          'COMPONENT-PROP-UNSUPPORTED',
          `Property '${propKey}' (kind ${entry.kind}) of component '${group.groupName}' is declared but not parameterized; the reference instance's content is used.`,
          first.ref,
          'components',
        );
      }
    }

    for (const ref of references) {
      const instance = this.instanceIndex.get(ref.referenceId)!;
      ref.variantValues = variantParams.map((p) => instance.variantProps?.[p.key] ?? '');
      if (ref === references[0]) continue;
      // Other masters substitute the same parameter keys with their own text.
      if (firstProps) {
        for (const tp of textParams) {
          const own = instance.componentProps?.[tp.propKey];
          if (!own || typeof own.value !== 'string') continue;
          const hit = this.findSubstitution(instance, own.value);
          if (hit) ref.substitutions.set(hit, tp.paramName);
        }
      }
    }

    // Component configuration description (CCD): the group adopts the config
    // of its first configured master; differing configs across a set's
    // masters are reported (variants are one composable, one config).
    let config: ParsedComponentConfig | null = null;
    let conflicting = false;
    const referenceInstances = references.map((r) => this.instanceIndex.get(r.referenceId)!).filter(Boolean);
    for (const inst of referenceInstances) {
      const cfg = this.componentConfigFor(inst.componentKey);
      if (!cfg) continue;
      if (!config) config = cfg;
      else if (composeConfigSignature(cfg) !== composeConfigSignature(config)) conflicting = true;
    }
    if (conflicting) {
      this.diag(
        'WARNING',
        'COMPONENT-CONFIG-CONFLICT',
        `Component '${group.groupName}': the selected variants carry different configuration descriptions; the first configured master's configuration applies to the whole component (configure variants identically, or split the sets).`,
        first.ref,
        'components',
      );
    }

    // Role-minted parameters: `onClick`/`enabled`/… declared after the
    // modifier and before variant/text parameters, with inert defaults so
    // generated call sites stay unchanged (app code overrides them).
    const roleParams: AutoRoleParam[] = [];
    if (config?.role) {
      for (const rp of ROLE_PARAMETERS[config.role]) {
        roleParams.push({ logical: rp.param, param: paramFor(rp.param), type: rp.type, def: rp.def });
      }
    }
    if (config) {
      this.diag(
        'INFO',
        'COMPONENT-CONFIG',
        `Component '${group.groupName}' uses its configuration description (${describeComposeConfig(config)})${config.role ? `: ${ROLE_NOTES[config.role]}` : ''}.`,
        first.ref,
        'components',
      );
    }

    const spec: AutoComponentSpec = {
      symbol: '', // assigned in generateAutoComponentFiles (reserved fn name)
      groupName: group.groupName,
      variantParams,
      textParams,
      config,
      roleParams,
      masters: references,
      plan: { kind: 'when' }, // the emission step picks the real shape
    };
    const defaultsForMessage = variantParams.map((p) => p.defaultValue);
    if (variantParams.length > 0 && references.length === 1) {
      this.diag(
        'INFO',
        'COMPONENT-VARIANT-SINGLE',
        `Component '${group.groupName}' has variant properties (${variantParams.map((p) => p.key).join(', ')}), but only the '${defaultsForMessage.join('/')}' variant was found in the conversion; the generated composable keeps its parameter but always renders this variant's content.`,
        first.ref,
        'components',
      );
    }
    this.autoSpecs.push(spec);
    for (const [, members] of group.masters) {
      for (const member of members) this.autoByInstance.set(member.id, spec);
    }
  }

  /**
   * Builds one typed parameter per variant key. Values that are exactly
   * True/False (case-insensitive) become `Boolean` parameters regardless of
   * style; other keys follow the configured style — `enum`/`sealed` mint a
   * `<Group><Key>` type, `string` keeps plain strings (legacy).
   */
  private buildVariantParams(
    groupName: string,
    keys: string[],
    defaults: string[],
    instances: IrInstanceNode[],
    paramFor: (base: string) => string,
  ): AutoVariantParam[] {
    const style = this.opts.variantParamStyle ?? 'enum';
    if (keys.length === 0) return [];
    const params: AutoVariantParam[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const values = [
        ...new Set(instances.map((inst) => inst.variantProps?.[key]).filter((v): v is string => v != null)),
      ].sort((a, b) => a.localeCompare(b, 'en'));
      const defaultValue = defaults[i] ?? '';
      if (values.length === 0) continue; // a key with no resolvable values: no parameter

      let kind: AutoVariantParam['kind'] = style;
      let typeName = 'String';
      let entries: string[] = [];
      const isBool =
        style !== 'string' && values.every((v) => /^true$/i.test(v) || /^false$/i.test(v));
      if (isBool) {
        kind = 'boolean';
        typeName = 'Boolean';
      } else if (style !== 'string') {
        kind = style; // 'enum' | 'sealed'
        const typeBase = `${sanitizeKotlinIdentifier(groupName, 'X')}${sanitizeKotlinIdentifier(pascalCase(key), 'X')}`;
        typeName = this.uniqueTypeName(typeBase);
        entries = this.uniqueEntries(values, style);
      }
      params.push({ key, paramName: paramFor(key), kind, typeName, values, entries, defaultValue });
    }
    return params;
  }

  /** Reserves a top-level type name unique across the whole conversion. */
  private uniqueTypeName(hint: string): string {
    let name = hint;
    let n = 2;
    while (this.usedTypeNames.has(name)) {
      name = `${hint}${n}`;
      n += 1;
    }
    this.usedTypeNames.add(name);
    return name;
  }

  /** Kotlin entry names for the values: UPPER_SNAKE for enums, PascalCase for sealed. */
  private uniqueEntries(values: string[], style: 'enum' | 'sealed'): string[] {
    const used = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const base = safeIdentifier(style === 'enum' ? snakeCase(value).toUpperCase() : pascalCase(value));
      let entry = base;
      let n = 2;
      while (used.has(entry)) {
        entry = `${base}_${n}`;
        n += 1;
      }
      used.add(entry);
      out.push(entry);
    }
    return out;
  }

  /** Kotlin expression for one variant value under its parameter's kind. */
  private variantValueExpr(param: AutoVariantParam, value: string): string {
    if (param.kind === 'boolean') return /^true$/i.test(value) ? 'true' : 'false';
    if (param.kind === 'string') return `"${escapeKotlinString(value)}"`;
    // Unresolvable values fall back to the parameter's default entry so the
    // emitted `when` arms stay type-correct even when a master misses a
    // variant property value.
    let idx = param.values.indexOf(value);
    if (idx < 0) idx = param.values.indexOf(param.defaultValue);
    const entry = param.entries[idx >= 0 ? idx : 0];
    return `${param.typeName}.${entry ?? ''}`;
  }

  /**
   * Finds a text node inside `instance`'s subtree whose full text equals
   * `value`; that node becomes the substitution target. Deterministic: first
   * match in document order.
   */
  private findSubstitution(instance: IrInstanceNode, value: string): string | null {
    let hit: string | null = null;
    const visit = (node: IrNode): void => {
      if (hit) return;
      if (node.type === 'text') {
        const text = node.spans.map((s) => s.text).join('');
        if (text === value) {
          hit = node.id;
        }
        return;
      }
      if (node.type === 'container' || node.type === 'group' || node.type === 'instance') {
        for (const child of node.children) visit(child);
      }
    };
    for (const child of instance.children) visit(child);
    return hit;
  }

  /**
   * Emits one component file per spec, structured by the spec's emission
   * plan (`variantShape` setting). Single-master components stay plain;
   * multi-variant families emit either the classic parameterized `when`
   * (one branch per master), one composable whose lifted value parameters
   * carry the near-identical variants' differences (`params`), or one
   * composable per variant (`functions` / `object`).
   */
  generateAutoComponentFiles(): void {
    for (const spec of this.autoSpecs) {
      if (spec.symbol) continue;
      spec.symbol = this.uniqueFn(sanitizeKotlinIdentifier(spec.groupName, 'Composable'));
      spec.plan = spec.masters.length > 1 ? this.planVariantEmission(spec) : { kind: 'when' };
      const file = new KotlinFile(this.opts.packageName);
      this.file = file;
      this.envInstance = this.makeEmitEnv(file);
      file.useImport('androidx.compose.runtime.Composable');
      file.useImport('androidx.compose.ui.Modifier');

      if (spec.plan.kind === 'functions' || spec.plan.kind === 'object') {
        this.emitFunctionComponents(spec, spec.plan);
      } else {
        // The `params` shape has nothing dispatching on the variant keys, so
        // their enum/sealed types are not minted; the lifted value parameters
        // carry the differences instead.
        if (spec.plan.kind === 'params') {
          for (const lift of spec.plan.lifts) {
            const meta = LIFT_KINDS[lift.kind];
            if (meta.import) file.useImport(meta.import);
          }
          file.line('@Composable');
          this.emitConfigNote(spec);
          this.emitComponentSignature(spec);
          file.line(') {');
          const bodyStart = file.lineCount();
          this.emitInstanceBody(spec.masters[0]!, spec, { indent: 1, parent: null, isRoot: true, crossAlign: null });
          this.applyVariantLifts(file, bodyStart, spec.plan);
          file.line('}');
          this.files.push({ path: `${spec.symbol}.kt`, content: file.render(), language: 'kotlin' });
          this.file = null;
          this.envInstance = null;
          continue;
        }
        // Typed variant parameters mint their types before the composable.
        // (Each group mints one type per parameterized key, unique across the
        // whole conversion, so same-named variant keys never collide.)
        for (const param of spec.variantParams) {
          if (param.kind === 'enum') {
            file.line(`enum class ${param.typeName} { ${param.entries.join(', ')} }`);
          } else if (param.kind === 'sealed') {
            file.line(`sealed interface ${param.typeName} {`);
            param.entries.forEach((entry, i) => {
              void i;
              file.line(`${this.ind(1)}object ${entry} : ${param.typeName}`);
            });
            file.line('}');
          }
        }
        if (spec.variantParams.some((p) => p.kind === 'enum' || p.kind === 'sealed')) {
          file.line('');
        }

        file.line('@Composable');
        this.emitConfigNote(spec);
        this.emitComponentSignature(spec);
        file.line(') {');

        const first = spec.masters[0]!;
        if (spec.masters.length === 1) {
          this.emitInstanceBody(first, spec, { indent: 1, parent: null, isRoot: true, crossAlign: null });
        } else {
          this.call('Box', ['modifier = modifier'], 1, () => this.emitVariantWhen(spec));
        }
        file.line('}');
      }
      this.files.push({ path: `${spec.symbol}.kt`, content: file.render(), language: 'kotlin' });
      this.file = null;
      this.envInstance = null;
    }
  }

  /** Shared signature: external `modifier`, then role/text/variant parameters. */
  private emitComponentSignature(spec: AutoComponentSpec): void {
    const file = this.f;
    file.line(`fun ${spec.symbol}(`);
    file.line(`${this.ind(1)}modifier: Modifier = Modifier,`);
    for (const rp of spec.roleParams) {
      file.line(`${this.ind(1)}${rp.param}: ${rp.type} = ${rp.def},`);
    }
    if (spec.plan.kind === 'params') {
      for (const lift of spec.plan.lifts) {
        file.line(`${this.ind(1)}${lift.param}: ${lift.typeName} = ${lift.defaultExpr},`);
      }
    } else {
      for (const param of spec.variantParams) {
        const def = this.variantValueExpr(param, param.defaultValue);
        file.line(`${this.ind(1)}${param.paramName}: ${param.typeName} = ${def},`);
      }
    }
    for (const tp of spec.textParams) {
      file.line(`${this.ind(1)}${tp.paramName}: String = "${escapeKotlinString(tp.defaultValue)}",`);
    }
  }

  /** Replaces lifted value tokens in the emitted body with parameter names. */
  private applyVariantLifts(
    file: KotlinFile,
    bodyStart: number,
    plan: Extract<VariantPlan, { kind: 'params' }>,
  ): void {
    const byLine = new Map<number, VariantLift[]>();
    for (const lift of plan.lifts) {
      const list = byLine.get(lift.line);
      if (list) list.push(lift);
      else byLine.set(lift.line, [lift]);
    }
    for (const [lineIdx, lifts] of byLine) {
      // Right-to-left: replacing a token shifts the ordinals seen by a
      // re-scan, so later tokens must be lifted first.
      const aligned = lifts.slice().sort((a, b) => b.tok - a.tok);
      file.mapLineAt(bodyStart + lineIdx, (line) => {
        let out = line;
        for (const lift of aligned) out = replaceTokenAt(out, lift.tok, lift.param);
        return out;
      });
    }
  }

  /** `functions` / `object` plans: one composable per variant master. */
  private emitFunctionComponents(
    spec: AutoComponentSpec,
    plan: Extract<VariantPlan, { kind: 'functions' | 'object' }>,
  ): void {
    const file = this.f;
    const inObject = plan.kind === 'object';
    if (inObject) file.line(`object ${plan.objectName} {`);
    spec.masters.forEach((master, i) => {
      if (i > 0) file.blank();
      const fn = plan.fns.get(master.masterKey)!;
      const base = inObject ? 1 : 0;
      if (i === 0) this.emitConfigNote(spec);
      file.line(`${this.ind(base)}@Composable`);
      file.line(`${this.ind(base)}fun ${fn}(`);
      file.line(`${this.ind(base + 1)}modifier: Modifier = Modifier,`);
      for (const rp of spec.roleParams) {
        file.line(`${this.ind(base + 1)}${rp.param}: ${rp.type} = ${rp.def},`);
      }
      for (const tp of spec.textParams) {
        file.line(`${this.ind(base + 1)}${tp.paramName}: String = "${escapeKotlinString(tp.defaultValue)}",`);
      }
      file.line(`${this.ind(base)}) {`);
      this.emitInstanceBody(master, spec, { indent: base + 1, parent: null, isRoot: true, crossAlign: null });
      file.line(`${this.ind(base)}}`);
    });
    if (inObject) file.line('}');
  }

  /** `when (type)` / `when (type to size)` with one branch per master body. */
  private emitVariantWhen(spec: AutoComponentSpec): void {
    const file = this.f;
    const subjectArgs = spec.variantParams.map((p) => p.paramName);
    const subject = subjectArgs.length === 1 ? subjectArgs[0]! : subjectArgs.join(' to ');
    file.line(`${this.ind(2)}when (${subject}) {`);
    for (const master of spec.masters) {
      const pattern = master.variantValues
        .map((v, i) => this.variantValueExpr(spec.variantParams[i]!, v))
        .join(' to ');
      file.line(`${this.ind(3)}${pattern} -> {`);
      // `parent: null` keeps the branch root free of parent-relative offset
      // (the reference instance's position in the original screen is an
      // artifact) and with a `Modifier` base rather than the incoming
      // external `modifier` (which the wrapper Box carries).
      this.emitInstanceBody(master, spec, { indent: 4, parent: null, isRoot: false, crossAlign: null });
      file.line(`${this.ind(3)}}`);
    }
    file.line(`${this.ind(2)}}`);
  }

  /**
   * Picks a multi-variant component's emission plan and reports how it was
   * chosen. `when` keeps the classic dispatcher; explicit `functions` /
   * `object` always explode; `auto` renders the variant bodies to scratch
   * surfaces and compares them line by line with value tokens erased:
   *
   * - near-identical bodies (value-token-only differences within the params
   *   thresholds) lift the differing values into typed parameters,
   * - bodies diverging in 55%+ of their lines become one composable per
   *   variant,
   * - everything else keeps the `when`.
   */
  private planVariantEmission(spec: AutoComponentSpec): VariantPlan {
    const shape = this.opts.variantShape ?? 'auto';
    const refInstance = this.instanceIndex.get(spec.masters[0]!.referenceId);
    const ref = refInstance?.ref ?? null;

    if (shape === 'functions' || shape === 'object') {
      const plan = this.explodePlan(spec, shape);
      this.diag(
        'INFO',
        'COMPONENT-VARIANT-FUNCTIONS',
        `Component '${spec.groupName}' emits one composable per variant (variantShape setting: '${shape}'); call sites pick their variant's function directly.`,
        ref,
        'components',
      );
      return plan;
    }
    if (shape === 'when') return { kind: 'when' };

    /* shape === 'auto': measure the variant bodies. */
    const surfaces = spec.masters.map((m) => this.renderMasterSurface(m, spec));
    if (surfaces.some((s) => s === null)) return { kind: 'when' }; // measurement failed; keep the proven shape
    const first = surfaces[0]!;
    const refMasterKey = spec.masters[0]!.masterKey;

    let valueOnly = true;
    let differing = 0;
    /** slot key `${line}:${tok}` -> candidate lift: kinds/values across masters. */
    const candidates = new Map<string, { line: number; tok: number; kind: string; values: Map<string, string> }>();
    for (let i = 1; i < spec.masters.length; i++) {
      const other = surfaces[i]!;
      if (other.shapes.length !== first.shapes.length) {
        // Line-count differences count only the missing/extra lines; the rest
        // of the body may still line up.
        differing = Math.max(differing, Math.abs(first.shapes.length - other.shapes.length));
        valueOnly = false;
        continue;
      }
      for (let l = 0; l < other.shapes.length; l++) {
        if (other.shapes[l] === first.shapes[l]) {
          // Same token-erased skeleton: every difference is a value token,
          // captured as a lift candidate when any master differs there.
          const refTokens = first.lineTokens[l]!;
          const otherTokens = other.lineTokens[l]!;
          if (refTokens.length !== otherTokens.length) {
            valueOnly = false; // misaligned masks: structural difference
            continue;
          }
          let lineDiffers = false;
          for (let t = 0; t < refTokens.length; t++) {
            if (refTokens[t] === otherTokens[t]) continue;
            lineDiffers = true;
            const key = `${l}:${t}`;
            let slot = candidates.get(key);
            if (!slot) {
              slot = { line: l, tok: t, kind: first.lineKinds[l]![t]!, values: new Map([[refMasterKey, refTokens[t]!]]) };
              candidates.set(key, slot);
            }
            slot.values.set(spec.masters[i]!.masterKey, otherTokens[t]!);
          }
          if (lineDiffers) differing += 1;
          continue;
        }
        // Different skeletons: a structural difference (nothing lifts here).
        differing += 1;
        valueOnly = false;
      }
    }

    const ratio = differing / Math.max(1, first.shapes.length);
    const liftCandidates = [...candidates.values()].sort((a, b) => a.line - b.line || a.tok - b.tok);

    // Fill each candidate's value map for every master (masters that match
    // the reference at that slot keep the reference's value; full-alignment
    // is guaranteed because valueOnly passed).
    for (const slot of liftCandidates) {
      for (let i = 1; i < spec.masters.length; i++) {
        const masterKey = spec.masters[i]!.masterKey;
        if (slot.values.has(masterKey)) continue;
        slot.values.set(masterKey, surfaces[i]!.lineTokens[slot.line]?.[slot.tok] ?? slot.values.get(refMasterKey)!);
      }
    }

    if (valueOnly && liftCandidates.length <= AUTO_PARAMS_MAX_LIFTS && (differing <= AUTO_PARAMS_MAX_DIFFS || ratio <= AUTO_PARAMS_MAX_RATIO)) {
      const lifts: VariantLift[] = [];
      const usedNames = new Set<string>([...spec.textParams.map((t) => t.paramName), ...spec.roleParams.map((r) => r.param), 'modifier']);
      // String slots equal to a TEXT component property's value stay owned by
      // that property's `label`-style parameter (canonicalized surfaces make
      // them look like plain literals when harvested masters differ); lifting
      // them too would mint a second, overlapping text parameter.
      const textParamDefaults = new Set(
        spec.textParams.map((tp) => `"${escapeKotlinString(tp.defaultValue)}"`),
      );
      for (const slot of liftCandidates) {
        const meta = LIFT_KINDS[slot.kind as VariantLift['kind']];
        if (!meta) {
          valueOnly = false;
          break;
        }
        if (slot.kind === 'string' && textParamDefaults.has(slot.values.get(refMasterKey)!)) {
          continue;
        }
        const hint = paramHintFor(first.lines[slot.line]!, slot.tok) ?? KIND_PARAM_NAMES[slot.kind as VariantLift['kind']] ?? 'variant';
        let name = camelCase(hint);
        if (name === 'modifier' || !isKotlinSafeIdentifier(name)) name = KIND_PARAM_NAMES[slot.kind as VariantLift['kind']] ?? 'variantParam';
        let unique = name;
        let n = 2;
        while (usedNames.has(unique)) {
          unique = `${name}${n}`;
          n += 1;
        }
        usedNames.add(unique);
        lifts.push({
          line: slot.line,
          tok: slot.tok,
          param: unique,
          kind: slot.kind as VariantLift['kind'],
          typeName: meta.type,
          defaultExpr: slot.values.get(refMasterKey)!,
        });
      }
      if (valueOnly) {
        const values = new Map<string, string[]>();
        for (const master of spec.masters) {
          values.set(
            master.masterKey,
            lifts.map((lift) => candidates.get(`${lift.line}:${lift.tok}`)!.values.get(master.masterKey)!),
          );
        }
        this.diag(
          'INFO',
          'COMPONENT-VARIANT-PARAMS',
          liftCandidates.length === 0 && differing === 0
            ? `Component '${spec.groupName}' variants render identically; one shared composable covers every variant.`
            : `Component '${spec.groupName}' variants differ only in ${lifts.length} value${lifts.length === 1 ? '' : 's'} (${Math.round(ratio * 100)}% of the body); one composable with typed value parameters replaces the variant-key parameters.`,
          ref,
          'components',
        );
        return { kind: 'params', lifts, values };
      }
    }

    if (!valueOnly && ratio >= AUTO_FUNCTIONS_MIN_RATIO) {
      const plan = this.explodePlan(spec, 'functions');
      this.diag(
        'INFO',
        'COMPONENT-VARIANT-FUNCTIONS',
        `Component '${spec.groupName}' variants diverge in ${Math.round(ratio * 100)}% of the emitted body; one composable per variant replaces the parameterized when.`,
        ref,
        'components',
      );
      return plan;
    }
    return { kind: 'when' };
  }

  /**
   * Renders one master's body into a scratch Kotlin file (silent) and
   * tokenizes it for the variant diff. Text-property substitutions are
   * canonicalized back to their original literals first, so instance-backed
   * bodies (`text = label`) and harvested masters' bodies
   * (`text = "Continue"`) compare on real body differences only — the
   * `label` string parameter keeps carrying text differences.
   */
  private renderMasterSurface(master: AutoMasterBody, spec: AutoComponentSpec): MasterSurface | null {
    const scratch = new KotlinFile(this.opts.packageName);
    const prevFile = this.file;
    const prevEnv = this.envInstance;
    const prevSubs = this.substitutions;
    const prevSilent = this.silent;
    this.file = scratch;
    this.envInstance = this.makeEmitEnv(scratch);
    this.substitutions = master.substitutions;
    this.silent = true;
    try {
      const ref = this.instanceIndex.get(master.referenceId);
      if (!ref) return null;
      // The real body path (Material root + role wiring included) keeps the
      // variant measurement aligned with what the component renders.
      this.emitInstanceBody(master, spec, { indent: 1, parent: null, isRoot: true, crossAlign: null });
      // Canonicalize text substitutions back to literals (per this master's
      // property values; the reference's default covers harvested masters).
      const restores: Array<[string, string]> = [];
      for (const tp of spec.textParams) {
        const instance = this.instanceIndex.get(master.referenceId);
        const own = instance?.componentProps?.[tp.propKey];
        const value = typeof own?.value === 'string' ? own.value : tp.defaultValue;
        restores.push([tp.paramName, `"${escapeKotlinString(value)}"`]);
      }
      const raw = scratch.render();
      let lines = scratchBodyLines(raw);
      if (restores.length > 0) {
        lines = lines.map((line) => {
          let out = line;
          for (const [name, literal] of restores) {
            out = out.replace(new RegExp(`\\b${name}(?!\\w)`, 'g'), literal);
          }
          return out;
        });
      }
      return tokenizeSurface(lines);
    } catch {
      return null;
    } finally {
      this.file = prevFile;
      this.envInstance = prevEnv;
      this.substitutions = prevSubs;
      this.silent = prevSilent;
    }
  }

  /** Names one composable per variant master (`<Component><Value…>` or `<Value…>`). */
  private explodePlan(
    spec: AutoComponentSpec,
    kind: 'functions' | 'object',
  ): Extract<VariantPlan, { kind: 'functions' | 'object' }> {
    const fns = new Map<string, string>();
    const used = new Set<string>();
    for (const master of spec.masters) {
      let base = master.variantValues.map((v) => pascalCase(v)).join('');
      if (!base) base = 'Default';
      const root = kind === 'object' ? base : `${spec.symbol}${base}`;
      let name = root;
      let n = 2;
      while (used.has(name)) {
        name = `${root}${n}`;
        n += 1;
      }
      used.add(name);
      fns.set(master.masterKey, name);
    }
    return kind === 'object' ? { kind: 'object', objectName: spec.symbol, fns } : { kind: 'functions', fns };
  }

  /** Copies the configuration description's `note` into the file as comments. */
  private emitConfigNote(spec: AutoComponentSpec): void {
    const note = spec.config?.note;
    if (!note) return;
    for (const line of String(note).split(/\r?\n/)) this.f.line(`// ${line}`);
  }

  /** Renders one master body: the reference instance's plain-layout tree. */
  private emitInstanceBody(master: AutoMasterBody, spec: AutoComponentSpec, ctx: EmitCtx): void {
    const ref = this.instanceIndex.get(master.referenceId);
    if (!ref) return;
    const previous = this.substitutions;
    this.substitutions = master.substitutions;
    const material = this.materialImplFor(spec, ref);
    if (material) {
      this.emitMaterialRoot(material, spec, ref, ctx);
    } else {
      // Role wiring (ripple-free clickable) attaches to the body root only.
      const wiring = this.roleWiringFor(spec);
      this.pendingRootWiring = wiring ? { node: ref, args: wiring } : null;
      this.emitStack(ref, ref.layout.value, ctx);
      this.pendingRootWiring = null;
    }
    this.substitutions = previous;
  }

  /**
   * Role wiring for the custom-emission body root: a ripple-free
   * `clickable` (a default ripple would change the static look) covering the
   * whole node, with the role's minted handler/enabled parameters. Enabled
   * only exists on some roles; the wiring adapts.
   */
  private roleWiringFor(spec: AutoComponentSpec): string[] | null {
    const role = spec.config?.role ?? null;
    // This runs on the custom path only (Material roots exited earlier);
    // wired roles attach a ripple-free clickable carrying the role's handler.
    if (!role || !(WIRED_ROLES as readonly string[]).includes(role)) return null;
    const onClick = spec.roleParams.find((p) => p.logical === 'onClick')?.param ?? null;
    if (!onClick) return null;
    const args = [`onClick = ${onClick}`];
    const enabled = spec.roleParams.find((p) => p.logical === 'enabled')?.param;
    if (enabled) args.push(`enabled = ${enabled}`);
    args.push('indication = null', 'interactionSource = remember { MutableInteractionSource() }');
    return args;
  }

  /**
   * Decides whether one master's body root routes through its Material 3
   * composable (`card` / `button` / `fab`), only when the generated look can
   * match the design exactly:
   *
   * - exactly one solid background fill (no extras),
   * - no shadow (Material elevation is uniform, Figma shadows are arbitrary
   *   — the custom emission reproduces them precisely),
   * - no border (BorderStroke draws inside; the custom chain is exact),
   * - `clipsContent` on when any corner radius nonzero (Material containers
   *   always clip),
   * - no absolute-positioned children (they need the wrapper Box),
   * - `fab` additionally requires a circular shape.
   *
   * Anything unmatched keeps the custom emission **with the role's
   * parameters** (and the ripple-free clickable for wired roles), reported
   * once per component.
   */
  private materialImplFor(spec: AutoComponentSpec, ref: IrInstanceNode): 'card' | 'button' | 'fab' | null {
    const cfg = spec.config;
    const role = cfg?.role ?? null;
    if (!role) return null;
    if (cfg!.implementation === 'custom') return null; // declared custom: never attempt
    if (!(MATERIAL_ROLES as readonly string[]).includes(role)) return null;
    const materialRole = role as 'card' | 'button' | 'fab';

    const reject = (why: string): null => {
      this.roleFallbackDiag(spec, ref, role, `the look cannot be matched exactly: ${why}`);
      return null;
    };

    const bg = ref.background;
    if (!bg || bg.kind !== 'SOLID') return reject('the container has no single solid fill');
    if (ref.extraBackgrounds.length > 0) return reject('extra background paints exist');
    if (ref.effects.mapped.length > 0) return reject('a shadow has no exact Material equivalent');
    if (ref.border) return reject('a border is emitted exactly by the custom chain only');
    if (ref.children.some((c) => c.absolute)) return reject('absolute-positioned children need the Box wrapper emission');
    const radius = ref.radius?.value ?? null;
    const maxCorner = radius ? (radius.kind === 'fixed' ? radius.px : Math.max(radius.tl, radius.tr, radius.br, radius.bl)) : 0;
    if (maxCorner > 0 && ref.clip.value === false) return reject('children may overflow the rounded corners (clipsContent is off)');
    if (role === 'fab') {
      const w = ref.geometry.width || 0;
      const h = ref.geometry.height || 0;
      const minSide = Math.min(w, h);
      const shapeRadius = maxCorner;
      if (!(shapeRadius >= minSide / 2 - 0.5 && Math.abs(w - h) <= 1)) {
        return reject('the shape is not circular');
      }
    }
    this.roleMaterialDiag(spec, ref, materialRole);
    return materialRole;
  }

  /** Reports the Material implementation choice once per component. */
  private roleMaterialDiag(spec: AutoComponentSpec, ref: IrInstanceNode, role: string): void {
    const key = `${spec.groupName}:material`;
    if (this.configDiagKeys.has(key)) return;
    this.configDiagKeys.add(key);
    const symbol = role === 'card' ? 'Card' : role === 'button' ? 'Button' : 'FloatingActionButton';
    this.diag(
      'INFO',
      'COMPONENT-CONFIG-ROLE',
      `Component '${spec.groupName}': the '${role}' role is emitted through the Material 3 ${symbol} (colors/shape moved from the modifier into arguments; children unchanged, look identical).`,
      ref.ref,
      'components',
    );
  }

  /** Reports why a role fell back to the custom emission (once per component). */
  private roleFallbackDiag(spec: AutoComponentSpec, ref: IrInstanceNode, role: string, reason: string): void {
    const key = `${spec.groupName}:fallback:${reason}`;
    if (this.configDiagKeys.has(key)) return;
    this.configDiagKeys.add(key);
    const wired = (WIRED_ROLES as readonly string[]).includes(role);
    this.diag(
      'INFO',
      'COMPONENT-CONFIG-ROLE',
      `Component '${spec.groupName}': the '${role}' role stays the custom emission because ${reason}; the role parameters remain${wired ? ' and the body is ripple-free clickable' : ' (visual layout unchanged)'}.`,
      ref.ref,
      'components',
    );
  }

  /**
   * Emits one master body root through its Material 3 composable: the
   * modifier's paint parts (background, border, radius/shadow) become
   * composable arguments; children emit unchanged inside the content lambda
   * through a stripped clone of the reference (sizing/padding/alpha kept).
   */
  private emitMaterialRoot(role: 'card' | 'button' | 'fab', spec: AutoComponentSpec, ref: IrInstanceNode, ctx: EmitCtx): void {
    const env = this.env();
    const paramOf = (logical: string): string | null => spec.roleParams.find((p) => p.logical === logical)?.param ?? null;
    const stripped: IrInstanceNode = {
      ...ref,
      background: null,
      extraBackgrounds: [],
      border: null,
      radius: null,
      effects: { mapped: [], unsupported: [] },
      clip: { value: false, origin: 'user' },
    };
    const mc = this.modifierFor(stripped, ctx);
    const bg = ref.background && ref.background.kind === 'SOLID' ? ref.background : null;
    const radius = ref.radius?.value ?? null;
    const shape = role === 'fab' ? circleShapeExpr(this.helpers()) : shapeExprFromRadius(radius, this.helpers());
    const chips: string[] = [];

    if (role === 'card') {
      env.useImport('androidx.compose.material3.Card');
      env.useImport('androidx.compose.material3.CardDefaults');
      chips.push(`onClick = ${paramOf('onClick') ?? 'onClick'}`);
      if (bg) chips.push(`colors = CardDefaults.cardColors(containerColor = ${env.colorExpr(bg.color)})`);
      if (shape) chips.push(`shape = ${shape}`);
      chips.push('elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)');
    } else if (role === 'button') {
      env.useImport('androidx.compose.material3.Button');
      env.useImport('androidx.compose.material3.ButtonDefaults');
      env.useImport('androidx.compose.foundation.layout.PaddingValues');
      chips.push(`onClick = ${paramOf('onClick') ?? 'onClick'}`);
      const enabled = paramOf('enabled');
      if (enabled) chips.push(`enabled = ${enabled}`);
      if (bg) chips.push(`colors = ButtonDefaults.buttonColors(containerColor = ${env.colorExpr(bg.color)})`);
      if (shape) chips.push(`shape = ${shape}`);
      chips.push('contentPadding = PaddingValues(0.dp)');
      chips.push('elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp, pressedElevation = 0.dp)');
    } else {
      env.useImport('androidx.compose.material3.FloatingActionButton');
      env.useImport('androidx.compose.material3.FloatingActionButtonDefaults');
      chips.push(`onClick = ${paramOf('onClick') ?? 'onClick'}`);
      if (bg) chips.push(`containerColor = ${env.colorExpr(bg.color)}`);
      chips.push('shape = CircleShape');
      chips.push('elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 0.dp)');
    }
    const modChip = this.modifierChip(mc, ctx.isRoot);
    if (modChip) chips.push(modChip);
    const body = ref.children.length > 0 ? this.childEmitterFor(ref.children, ref.layout.value ?? null, ctx) : null;
    const symbol = role === 'card' ? 'Card' : role === 'button' ? 'Button' : 'FloatingActionButton';
    this.call(symbol, chips, ctx.indent, body);
  }

  private emitAutoComponentCall(spec: AutoComponentSpec, node: IrInstanceNode, ctx: EmitCtx): void {
    const plan = spec.plan;
    const mc = this.modifierFor(node, ctx);
    const chips: string[] = [];
    const modChip = this.modifierChip(mc, ctx.isRoot);
    if (modChip) chips.push(modChip);
    const textChips = (chips: string[]): void => {
      for (const tp of spec.textParams) {
        const value = node.componentProps?.[tp.propKey];
        if (value && typeof value.value === 'string') chips.push(`${tp.paramName} = "${escapeKotlinString(value.value)}"`);
      }
    };

    // `functions` / `object`: the variant identity is baked into the called
    // composable; only text properties remain as arguments.
    if (plan.kind === 'functions' || plan.kind === 'object') {
      const fn = plan.fns.get(node.componentKey);
      if (fn) {
        textChips(chips);
        const symbol = plan.kind === 'object' ? `${plan.objectName}.${fn}` : fn;
        this.call(symbol, chips, ctx.indent, null);
        return;
      }
    }

    // `params`: hand the lifted value parameters the instance's variant values.
    if (plan.kind === 'params') {
      const values = plan.values.get(node.componentKey);
      if (values) {
        plan.lifts.forEach((lift, i) => {
          const expr = values[i];
          if (expr != null && expr !== lift.defaultExpr) chips.push(`${lift.param} = ${expr}`);
        });
      }
      textChips(chips);
      this.call(spec.symbol, chips, ctx.indent, null);
      return;
    }

    // `when`: classic variant-key arguments.
    for (const param of spec.variantParams) {
      const value = node.variantProps?.[param.key];
      if (value != null) chips.push(`${param.paramName} = ${this.variantValueExpr(param, value)}`);
    }
    textChips(chips);
    this.call(spec.symbol, chips, ctx.indent, null);
  }

  /* ----------------------------- screen files ----------------------------- */

  generateScreen(doc: IrDocument): void {
    // Forward extractor diagnostics first so the report mirrors pipeline order.
    for (const d of doc.diagnostics) {
      this.diag(d.severity, d.code, d.reason, d.source, d.feature);
    }

    const root = doc.root;
    if (root.type === 'unknown') return; // already reported by the extractor

    const file = new KotlinFile(this.opts.packageName);
    this.file = file;
    this.envInstance = this.makeEmitEnv(file);

    if (this.profileActive) this.hintUnmappedFonts(doc);

    file.useImport('androidx.compose.runtime.Composable');
    file.useImport('androidx.compose.ui.Modifier');

    // Top-level frames/sections are screens; component masters keep their name.
    const isScreen = root.type === 'container' && root.kind !== 'COMPONENT';
    const base = sanitizeKotlinIdentifier(root.ref.nodeName, isScreen ? 'Screen' : 'Composable');
    const withSuffix = isScreen && !/screen$/i.test(base) ? `${base}Screen` : base;
    const fnName = this.uniqueFn(withSuffix);

    file.line('@Composable');
    file.line(`fun ${fnName}(`);
    file.line(`${this.ind(1)}modifier: Modifier = Modifier,`);
    file.line(') {');
    this.emitStyledNode(root, { indent: 1, parent: null, isRoot: true, crossAlign: null });
    file.line('}');

    this.files.push({ path: `${fnName}.kt`, content: file.render(), language: 'kotlin' });
    this.file = null;
    this.envInstance = null;
  }

  private uniqueFn(hint: string): string {
    let name = hint;
    let n = 2;
    while (this.usedFnNames.has(name)) {
      name = `${hint}${n}`;
      n += 1;
    }
    this.usedFnNames.add(name);
    return name;
  }

  private hintUnmappedFonts(doc: IrDocument): void {
    const profile = this.env().profile;
    for (const font of doc.fonts) {
      if (this.fontHints.has(font.family)) continue;
      this.fontHints.add(font.family);
      const mapped = profile.fonts.some((m) => m.source.name === font.family)
        || profile.textStyles.some((m) => m.source.name === font.family);
      if (!mapped) {
        this.diag(
          'INFO',
          'FONT-NOT-MAPPED',
          `Font family '${font.family}' is emitted as FontFamily.Default. Add a fonts or textStyles mapping to bind it to your typography.`,
          null,
          'font',
        );
      }
    }
  }

  /* ----------------------------- node dispatch ----------------------------- */

  private emitStyledNode(node: IrNode, ctx: EmitCtx): void {
    switch (node.type) {
      case 'container':
        this.emitStack(node, node.layout.value, ctx);
        break;
      case 'group':
        this.emitStack(node, null, ctx);
        break;
      case 'instance':
        this.emitInstance(node, ctx);
        break;
      case 'text':
        this.emitText(node, ctx);
        break;
      case 'shape':
        this.emitShape(node, ctx);
        break;
      case 'vector':
        this.emitVector(node, ctx);
        break;
      case 'unknown':
        break; // reported by the extractor
    }
  }

  /* ----------------------------- stacks (Row/Column/Box) ----------------------------- */

  private emitStack(node: IrContainerNode | IrGroupNode | IrInstanceNode, layout: AutoLayout | null, ctx: EmitCtx): void {
    const env = this.env();
    const callName: 'Row' | 'Column' | 'Box' = layout ? (layout.direction === 'ROW' ? 'Row' : 'Column') : 'Box';
    env.useImport(LAYOUT_COMPOSABLE_IMPORTS[callName]);
    if (layout?.wrap?.value === true) {
      env.diag(
        'INFO',
        'LAYOUT-WRAP',
        'Wrapping layout (layoutWrap) has no direct Row/Column equivalent; children are emitted in a single line.',
        node.ref,
        'layout',
      );
    }

    if (layout && node.children.some((c) => c.absolute)) {
      this.emitStackWithAbsoluteChildren(node, layout, ctx);
      return;
    }

    const mc = this.modifierFor(node, ctx);
    this.attachPendingWiring(node, mc);
    const chips: string[] = [];
    const modChip = this.modifierChip(mc, ctx.isRoot);
    if (modChip) chips.push(modChip);

    if (callName !== 'Box' && layout) {
      const arrangement = arrangementExpr(layout.direction, layout, env);
      if (arrangement) {
        chips.push(`${layout.direction === 'ROW' ? 'horizontalArrangement' : 'verticalArrangement'} = ${arrangement}`);
      }
      const cross = layout.crossAxis?.value ?? null;
      if (cross) {
        const crossAlign = crossAlignParam(layout.direction, cross, env);
        if (crossAlign) chips.push(`${crossAlign.name} = ${crossAlign.expr}`);
      }
    }

    const body = node.children.length > 0 ? this.childEmitterFor(node.children, layout, ctx) : null;
    this.call(callName, chips, ctx.indent, body);
  }

  /**
   * Emission for an auto-layout container whose design contains
   * absolute-positioned children (`layoutPositioning === 'ABSOLUTE'`).
   *
   * Compose Row/Column cannot reproduce "ignores auto-layout" placement, so
   * the design is decomposed into a wrapper Box:
   *
   *   Box(frame decoration: size/clip/background/…, *without* padding) {
   *     Row/Column(Modifier.fillMaxSize().<padding>) { flow children }  // arrangement moves here
   *     Box(Modifier.offset(x, y)…)        // each absolute child
   *   }
   *
   * Padding and arrangement belong to the inner Row/Column because Figma
   * insets only auto-layout flow children, not absolute ones. The inner
   * container fills the wrapper only when the wrapper ends up with an
   * explicit size/weight/fill constraint.
   */
  private emitStackWithAbsoluteChildren(
    node: IrContainerNode | IrGroupNode | IrInstanceNode,
    layout: AutoLayout,
    ctx: EmitCtx,
  ): void {
    // Decoration of the frame itself, minus the padding (which models the
    // auto-layout content inset and therefore belongs to the inner stack).
    const wrapperMc = this.modifierFor(node, ctx);
    this.attachPendingWiring(node, wrapperMc);
    wrapperMc.withoutPadding();
    const wrapperChip = this.modifierChip(wrapperMc, ctx.isRoot);
    const wrapperChips = wrapperChip ? [wrapperChip] : [];
    const wrapperHasSize = wrapperMc
      .partNames()
      .some((n) => n === 'size' || n === 'width' || n === 'height' || n === 'fillMaxWidth' || n === 'fillMaxHeight' || n === 'weight');
    this.emitWrapperForAutoLayout(layout, node.children, ctx, { innerFill: wrapperHasSize, wrapperChips });
  }

  /**
   * Shared content emission for an auto-layout container that contains
   * absolute-positioned children (`layoutPositioning === 'ABSOLUTE'`):
   *
   *   Box(<wrapperChips>) {
   *     Row/Column(Modifier[.fillMaxSize()][.padding(...)]) { flow children }
   *     Box(Modifier.offset(x, y)…)        // each absolute child
   *   }
   *
   * Padding and arrangement belong to the inner Row/Column because Figma
   * insets only auto-layout flow children, not absolute ones. Used both by
   * the plain stack emitter (wrapper carries the frame decoration) and by
   * mapped-instance content lambdas (wrapper is plain; the mapped composable
   * owns the decoration).
   */
  private emitWrapperForAutoLayout(
    layout: AutoLayout,
    children: readonly IrNode[],
    ctx: EmitCtx,
    opts: { innerFill: boolean; wrapperChips: string[] },
  ): void {
    const env = this.env();
    const flowChildren = children.filter((c) => !c.absolute);
    const absChildren = children.filter((c) => c.absolute);
    const innerCallName: 'Row' | 'Column' = layout.direction === 'ROW' ? 'Row' : 'Column';
    env.useImport(LAYOUT_COMPOSABLE_IMPORTS[innerCallName]);
    env.useImport(LAYOUT_COMPOSABLE_IMPORTS.Box);
    if (layout.wrap?.value === true) {
      env.diag(
        'INFO',
        'LAYOUT-WRAP',
        'Wrapping layout (layoutWrap) has no direct Row/Column equivalent; children are emitted in a single line.',
        null,
        'layout',
      );
    }

    const body = (): void => {
      const wrapperCtx: EmitCtx = { indent: ctx.indent + 1, parent: 'box', isRoot: false, crossAlign: null };
      if (flowChildren.length > 0) {
        const innerMc = new ModifierChain(this.usageResolvers ? makeDpExpr(this.usageResolvers) : null);
        if (opts.innerFill) innerMc.fillMaxSize();
        const pad = layout.padding?.value ?? null;
        if (pad) innerMc.padding(pad.t, pad.r, pad.b, pad.l);
        this.registerModifierImports(innerMc);
        const innerChips: string[] = [];
        if (!innerMc.isEmpty()) {
          const lines = innerMc.toKotlinLines('', 'modifier = ');
          innerChips.push(lines.map((l, i) => (i === 0 ? l : l.trim())).join(''));
        }
        const arrangement = arrangementExpr(layout.direction, layout, env);
        if (arrangement) {
          innerChips.push(`${layout.direction === 'ROW' ? 'horizontalArrangement' : 'verticalArrangement'} = ${arrangement}`);
        }
        const cross = layout.crossAxis?.value ?? null;
        if (cross) {
          const crossAlign = crossAlignParam(layout.direction, cross, env);
          if (crossAlign) innerChips.push(`${crossAlign.name} = ${crossAlign.expr}`);
        }
        const innerKind = layout.direction === 'ROW' ? 'row' : 'column';
        const crossValue = layout.crossAxis?.value ?? null;
        this.call(innerCallName, innerChips, wrapperCtx.indent, () => {
          const childContext = childCtx(wrapperCtx, innerKind, crossValue);
          for (const flowChild of flowChildren) this.emitStyledNode(flowChild, childContext);
        });
      }
      for (const abs of absChildren) this.emitStyledNode(abs, wrapperCtx);
    };
    this.call('Box', opts.wrapperChips, ctx.indent, body);
  }

  private childEmitterFor(children: readonly IrNode[], layout: AutoLayout | null, ctx: EmitCtx): () => void {
    const kind = layout ? (layout.direction === 'ROW' ? 'row' : 'column') : 'box';
    const cross = layout?.crossAxis?.value ?? null;
    return this.childEmitter(children, kind, cross, ctx);
  }

  private childEmitter(
    children: readonly IrNode[],
    kind: 'row' | 'column' | 'box',
    crossAlign: string | null,
    ctx: EmitCtx,
  ): () => void {
    return () => {
      const childContext = childCtx(ctx, kind, crossAlign);
      for (const child of children) this.emitStyledNode(child, childContext);
    };
  }

  /* ----------------------------- modifiers ----------------------------- */

  private modifierFor(node: StyledIrNode, ctx: EmitCtx): ModifierChain {
    const parent: ParentInfo = { kind: ctx.parent, isRoot: ctx.isRoot, crossAlign: ctx.crossAlign };
    const mc = buildModifierChain(node, parent, this.helpers());
    this.registerModifierImports(mc);
    return mc;
  }

  private registerModifierImports(mc: ModifierChain): void {
    const env = this.env();
    for (const part of mc.partNames()) {
      const path = MODIFIER_PART_IMPORTS[part];
      if (path) env.useImport(path);
    }
  }

  /**
   * Attaches the current role wiring (ripple-free clickable, position-first)
   * to one chain. Fires at most for the body root the wiring was set for —
   * deeper emitStack calls inside the same subtree miss the identity check,
   * which is exactly the intent.
   */
  private attachPendingWiring(node: StyledIrNode, mc: ModifierChain): void {
    const pending = this.pendingRootWiring;
    if (!pending || pending.node !== (node as object)) return;
    // The wiring part is appended after the chain's own imports registered,
    // so this hook registers all three of its own requirements.
    const env = this.env();
    env.useImport('androidx.compose.foundation.clickable');
    env.useImport('androidx.compose.foundation.interaction.MutableInteractionSource');
    env.useImport('androidx.compose.runtime.remember');
    mc.clickableFirst(pending.args);
  }

  /**
   * Render the chain as a chip (possibly multi-line). For root calls the base
   * `Modifier` is replaced with the incoming `modifier` parameter so callers
   * can override sizing. `paramName` may differ for mapped-call arguments.
   */
  private modifierChip(mc: ModifierChain, isRoot: boolean, paramName = 'modifier'): string | null {
    if (mc.isEmpty()) return isRoot ? `${paramName} = modifier` : null;
    let lines = mc.toKotlinLines('', `${paramName} = `);
    if (isRoot) {
      const re = new RegExp(`^(${paramName} = )Modifier(\\.|$)`);
      lines = lines.map((line, i) => (i === 0 ? line.replace(re, '$1modifier$2') : line));
    }
    return lines.join('\n');
  }

  /** Add box-internal position chips (offset / per-child align) for custom chains. */
  private addPositionalModifiers(mc: ModifierChain, node: StyledIrNode, ctx: EmitCtx): void {
    const env = this.env();
    if (ctx.parent === 'box' && !ctx.isRoot) mc.offset(node.geometry.x, node.geometry.y);
    if (ctx.crossAlign && ctx.parent && ctx.parent !== 'box') {
      const expr = childAlignExpr(ctx.parent, ctx.crossAlign, env);
      if (expr) mc.align(expr);
    }
  }

  /* ----------------------------- shared call emitter ----------------------------- */

  private call(name: string, chips: string[], indent: number, body: (() => void) | null): void {
    const f = this.f;
    if (chips.length === 0) {
      if (body === null) {
        f.line(`${this.ind(indent)}${name}()`);
        return;
      }
      f.line(`${this.ind(indent)}${name} {`);
      body();
      f.line(`${this.ind(indent)}}`);
      return;
    }
    const hasMultilineChip = chips.some((c) => c.includes('\n'));
    const totalLen = chips.reduce((acc, c) => acc + c.length, 0) + (chips.length - 1) * 2;
    if (chips.length === 1 && !hasMultilineChip && totalLen <= 64) {
      if (body === null) {
        f.line(`${this.ind(indent)}${name}(${chips[0]})`);
      } else {
        f.line(`${this.ind(indent)}${name}(${chips[0]}) {`);
        body();
        f.line(`${this.ind(indent)}}`);
      }
      return;
    }
    f.line(`${this.ind(indent)}${name}(`);
    for (const chip of chips) {
      const lines = chip.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const lineText = `${lines[i]}${i === lines.length - 1 ? ',' : ''}`;
        f.line(`${this.ind(indent + 1)}${lineText}`);
      }
    }
    if (body === null) {
      f.line(`${this.ind(indent)})`);
    } else {
      f.line(`${this.ind(indent)}) {`);
      body();
      f.line(`${this.ind(indent)}}`);
    }
  }

  /* ----------------------------- instances ----------------------------- */

  private emitInstance(node: IrInstanceNode, ctx: EmitCtx): void {
    const mapping = this.componentMappingFor(node); // profile first, then the configuration description's inline mapping
    if (mapping) {
      this.emitMappedCall(mapping, node, this.collectMappingInfo(node), ctx);
      return;
    }
    // Component configuration: `kind` (icon/image/vector) or `assets: export`
    // render the whole instance as an asset (no name prefix needed; skip
    // marks and the master export setting still veto). `assets: code`
    // suppresses this branch and the curated-library branch below.
    const cfg = this.componentConfigFor(node.componentKey);
    if (cfg && cfg.assets !== 'code' && (cfg.assets === 'export' || cfg.kind !== null)) {
      const kind: AssetKind = cfg.kind === 'image' ? 'png' : 'svg';
      const assetName = this.assets.add(kind, node.ref, node.ref.nodeName, undefined, {
        size: { width: node.geometry.width, height: node.geometry.height },
        masterId: node.componentKey,
        force: true,
      });
      if (assetName) {
        this.assetDirectiveDiag(node, cfg);
        this.emitAsImage(node, assetName, ctx);
        return;
      }
      // Skip-marked or asset export off: keep the layout honestly (below).
    }
    // Instances of curated asset-page components become plain Images, even
    // in standalone mode (the designer marked the component as an asset).
    // `libraryMatch` (unlike `add`) never auto-detects: only curated entries
    // match, so unmarked instances keep their exact previous behavior.
    if (!cfg || cfg.assets !== 'code') {
      const libraryExtra: AssetCandidateExtra = {
        size: { width: node.geometry.width, height: node.geometry.height },
        masterId: node.componentKey,
      };
      const libraryKey = this.assets.libraryMatch('svg', node.ref, libraryExtra);
      if (libraryKey) {
        // Register the canonical library asset (same inputs always hit the
        // same library branch); a skip-mark on the same component conflicts
        // and excludes the asset, in which case we expand normally.
        const assetName = this.assets.add('svg', node.ref, node.ref.nodeName, undefined, libraryExtra);
        if (assetName) {
          this.emitAsImage(node, assetName, ctx);
          return;
        }
      }
    }
    const auto = this.autoByInstance.get(node.id);
    if (auto) {
      this.emitAutoComponentCall(auto, node, ctx);
      return;
    }
    this.hintUnmappedComponent(node);
    this.emitStack(node, node.layout.value, ctx);
  }

  /** Reports one asset-directive decision once per component master. */
  private assetDirectiveDiag(node: IrInstanceNode, cfg: ParsedComponentConfig): void {
    const key = `asset:${node.componentKey}`;
    if (this.configDiagKeys.has(key)) return;
    this.configDiagKeys.add(key);
    const why = cfg.assets === 'export' ? 'assets: export' : `kind: ${cfg.kind}`;
    this.diag(
      'INFO',
      'COMPONENT-CONFIG-ASSET',
      `Component '${node.componentName}': every instance exports as an asset instead of code (${why}, from the component description); the instance node itself is exported (resource under its own name).`,
      node.ref,
      'components',
    );
  }

  /** Emits any styled node as an `Image` backed by an asset in any format. */
  private emitAsImage(node: StyledIrNode, assetName: string, ctx: EmitCtx): void {
    const env = this.env();
    env.useImport('androidx.compose.foundation.Image');
    // One node can match multiple times (e.g. the same instance in several
    // positions); `add()` dedupes, so nothing else is needed here.
    const stripped: StyledIrNode = { ...node, background: null, border: null, radius: null };
    const mc = this.modifierFor(stripped, ctx);
    this.call('Image', this.assetImageChips(assetName, mc, ctx.isRoot, env), ctx.indent, null);
  }

  /**
   * Emission chips for an asset-backed `Image`: `ImageVector`-format assets
   * reference the generated Kotlin val (same package — the Icons file is
   * emitted next to the screens, so no import is needed); every other
   * format resolves a drawable resource through `painterResource`.
   */
  private assetImageChips(assetName: string, mc: ModifierChain, isRoot: boolean, env: EmitEnv): string[] {
    const chips: string[] = [];
    if (this.assets.formatOf(assetName) === 'imagevector') {
      chips.push(`imageVector = ${imageVectorSymbol(assetName)}`, 'contentDescription = null');
    } else {
      env.useImport('androidx.compose.ui.res.painterResource');
      chips.push(`painter = painterResource(R.drawable.${assetName})`, 'contentDescription = null');
    }
    const modChip = this.modifierChip(mc, isRoot);
    if (modChip) chips.push(modChip);
    return chips;
  }

  private hintUnmappedComponent(node: IrInstanceNode): void {
    if (this.unmappedComponents.has(node.componentKey)) return;
    this.unmappedComponents.add(node.componentKey);
    this.diag(
      'INFO',
      'COMPONENT-UNMAPPED',
      `Instance of component '${node.componentName}' is emitted as plain layout. Add a components mapping for '${node.componentName}' to emit your design-system composable instead.`,
      node.ref,
      'components',
    );
  }

  private collectMappingInfo(node: IrInstanceNode | IrTextNode): MappingInfo {
    if (node.type === 'text') {
      return {
        texts: [node.spans.map((s) => s.text).join('')],
        iconNodes: [],
        firstColor: node.spans.find((s) => s.color)?.color ?? null,
      };
    }
    const info: MappingInfo = { texts: [], iconNodes: [], firstColor: null };
    const visit = (n: IrNode): void => {
      if (n.type === 'text') {
        const text = n.spans.map((s) => s.text).join('');
        if (text) info.texts.push(text);
        if (!info.firstColor) {
          for (const s of n.spans) {
            if (s.color) {
              info.firstColor = s.color;
              break;
            }
          }
        }
        return;
      }
      if (n.type === 'vector') {
        info.iconNodes.push(n);
        return; // do not descend into vector subtrees
      }
      if (n.type === 'container' || n.type === 'group' || n.type === 'instance') {
        for (const c of n.children) visit(c);
      }
    };
    for (const child of node.children) visit(child);
    const bg = node.background;
    if (!info.firstColor && bg && bg.kind === 'SOLID') info.firstColor = bg.color;
    return info;
  }

  /** Emit a mapped composable call with resolved typed arguments. */
  private emitMappedCall(
    mapping: ComponentMapping,
    node: IrInstanceNode | IrTextNode,
    info: MappingInfo,
    ctx: EmitCtx,
  ): void {
    const env = this.env();
    const mc = this.modifierFor(node, ctx);
    const chips: string[] = [];
    let contentArg: ComponentArgumentMapping | null = null;
    let hasModifierArg = false;

    for (const arg of mapping.arguments) {
      switch (arg.source.kind) {
        case 'text': {
          const text = info.texts[arg.source.childIndex ?? 0];
          if (text != null && text.length > 0) {
            chips.push(`${arg.argument} = "${escapeKotlinString(text)}"`);
          } else {
            this.missingMappedArg(
              mapping,
              arg,
              node,
              `text source has no text child at index ${arg.source.childIndex ?? 0}`,
            );
          }
          break;
        }
        case 'icon': {
          const iconNode = info.iconNodes[arg.source.childIndex ?? 0];
          if (iconNode) {
            const asset = this.assets.add('svg', iconNode.ref, iconNode.ref.nodeName, undefined, {
              size: { width: iconNode.geometry.width, height: iconNode.geometry.height },
              masterId: iconNode.type === 'instance' ? iconNode.componentKey : null,
            });
            if (asset) {
              chips.push(`${arg.argument} = R.drawable.${asset}`);
            } else {
              this.missingMappedArg(
                mapping,
                arg,
                node,
                `icon source '${iconNode.ref.nodeName}' is not exported as an asset (${this.assets.exclusionReason()})`,
              );
            }
          } else {
            this.missingMappedArg(
              mapping,
              arg,
              node,
              `icon source has no vector child at index ${arg.source.childIndex ?? 0}`,
            );
          }
          break;
        }
        case 'color': {
          if (info.firstColor) {
            chips.push(`${arg.argument} = ${env.colorExpr(info.firstColor)}`);
          } else {
            this.missingMappedArg(mapping, arg, node, 'color source found no colors in the subtree');
          }
          break;
        }
        case 'constant': {
          if (arg.source.dataType) {
            chips.push(`${arg.argument} = ${this.typedConstantLiteral(arg.source.dataType, arg.source.value, env)}`);
          } else {
            const v = arg.source.value;
            const literal = /^(true|false|-?\d+(\.\d+)?)$/.test(v) ? v : `"${escapeKotlinString(v)}"`;
            chips.push(`${arg.argument} = ${literal}`);
          }
          break;
        }
        case 'variantProp': {
          const value = node.type === 'instance' ? ((node.variantProps ?? null) as Record<string, string> | null)?.[arg.source.name] ?? null : null;
          if (value != null) {
            const cases = arg.source.cases ?? {};
            chips.push(`${arg.argument} = ${cases[value] ?? `"${escapeKotlinString(value)}"`}`);
          } else {
            this.missingMappedArg(mapping, arg, node, `variant property '${arg.source.name}' is not set on the instance`);
          }
          break;
        }
        case 'modifier': {
          hasModifierArg = true;
          const chip = this.modifierChip(mc, ctx.isRoot, arg.argument);
          if (chip) chips.push(chip);
          break;
        }
        case 'content': {
          contentArg = arg;
          break;
        }
      }
    }

    if (!hasModifierArg && !mc.isEmpty()) {
      const chip = this.modifierChip(mc, ctx.isRoot);
      if (chip) {
        chips.push(chip);
        env.diag(
          'INFO',
          'MAPPING-INJECTED-MODIFIER',
          `Mapping for '${mapping.target.symbol}' has no modifier argument; the node's Modifiers were injected automatically as 'modifier'.`,
          node.ref,
          'mapping',
        );
      }
    }

    const layout = node.type === 'instance' ? node.layout.value : null;
    const instanceChildren = node.type === 'instance' ? node.children : null;
    if (!contentArg && instanceChildren && instanceChildren.length > 0) {
      env.diag(
        'INFO',
        'INSTANCE-CHILDREN-OMITTED',
        `Mapped node '${node.ref.nodeName}' has ${instanceChildren.length} children, but the mapping for '${mapping.target.symbol}' has no 'content' argument; the children are not emitted.`,
        node.ref,
        'mapping',
      );
    }

    const hasAbsolute = Boolean(layout && instanceChildren && instanceChildren.some((c) => c.absolute));
    const body = contentArg && instanceChildren && instanceChildren.length > 0
      ? hasAbsolute
        ? // The wrapper Box lives one level below the mapped call, inside its
          // content lambda.
          () => this.emitWrapperForAutoLayout(layout!, instanceChildren!, { ...ctx, indent: ctx.indent + 1 }, { innerFill: false, wrapperChips: [] })
        : this.childEmitterFor(instanceChildren, layout, ctx)
      : null;
    this.call(mapping.target.symbol, chips, ctx.indent, body);
  }

  /**
   * Renders one typed constant as its Kotlin literal. Values were validated at
   * parse time, so the shapes normally pass; anything odd degrades to a
   * quoted string rather than emitting broken Kotlin.
   */
  private typedConstantLiteral(dataType: MappingArgDataType, value: string, env: EmitEnv): string {
    const numeric = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
    switch (dataType) {
      case 'int':
        return /^[+-]?\d+$/.test(value) ? value : `"${escapeKotlinString(value)}"`;
      case 'long':
        return /^[+-]?\d+$/.test(value) ? `${value}L` : `"${escapeKotlinString(value)}"`;
      case 'float':
        return numeric.test(value) ? `${value}f` : `"${escapeKotlinString(value)}"`;
      case 'double':
        return numeric.test(value) ? (value.includes('.') ? value : `${value}.0`) : `"${escapeKotlinString(value)}"`;
      case 'boolean':
        return value === 'true' || value === 'false' ? value : `"${escapeKotlinString(value)}"`;
      case 'char':
        return [...value].length === 1
          ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
          : `"${escapeKotlinString(value)}"`;
      case 'dp': {
        if (!numeric.test(value)) return `"${escapeKotlinString(value)}"`;
        env.useImport('androidx.compose.ui.unit.dp');
        return `${value}.dp`;
      }
      case 'sp': {
        if (!numeric.test(value)) return `"${escapeKotlinString(value)}"`;
        env.useImport('androidx.compose.ui.unit.sp');
        return `${value}.sp`;
      }
      case 'color': {
        const hex = (value.startsWith('#') ? value.slice(1) : value).toUpperCase();
        if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) return `"${escapeKotlinString(value)}"`;
        env.useImport('androidx.compose.ui.graphics.Color');
        return `Color(0x${hex.length === 6 ? `FF${hex}` : hex})`;
      }
      case 'string':
        return `"${escapeKotlinString(value)}"`;
      case 'object':
        return value;
    }
  }

  private missingMappedArg(
    mapping: ComponentMapping,
    arg: ComponentArgumentMapping,
    node: IrInstanceNode | IrTextNode,
    what: string,
  ): void {
    if (arg.defaultValue !== undefined) {
      // defaultValue is applied by the target composable; nothing to emit.
      this.diag(
        'INFO',
        'MAPPING-ARG-DEFAULTED',
        `Argument '${arg.argument}' of '${mapping.target.symbol}' falls back to its default (${what}).`,
        node.ref,
        'mapping',
      );
      return;
    }
    this.diag(
      'INFO',
      'MAPPING-ARG-MISSING',
      `Argument '${arg.argument}' of '${mapping.target.symbol}' is omitted (${what}). Set a defaultValue or omitIfAbsent in the mapping to silence this.`,
      node.ref,
      'mapping',
    );
  }

  /* ----------------------------- text ----------------------------- */

  private emitText(node: IrTextNode, ctx: EmitCtx): void {
    const env = this.env();
    const text = node.spans.map((s) => s.text).join('');
    if (!text) {
      env.diag('INFO', 'TEXT-EMPTY', `Text node '${node.ref.nodeName}' is empty and was skipped.`, node.ref, 'text');
      return;
    }
    const mapping = this.opts.profile ? resolveComponentMapping(this.opts.profile, { nodeType: 'text' }) : null;
    if (mapping) {
      this.emitMappedCall(mapping, node, this.collectMappingInfo(node), ctx);
      return;
    }
    this.emitDefaultText(node, text, ctx);
  }

  private emitDefaultText(node: IrTextNode, text: string, ctx: EmitCtx): void {
    const env = this.env();
    // TS narrowing: a non-empty text join implies spans[0] exists (guarded by
    // the TEXT-EMPTY check above); nothing else is behind this branch.
    const span = node.spans[0];
    if (!span) return;
    env.useImport('androidx.compose.material3.Text');

    const textArg = this.substitutions?.get(node.id);
    const chips: string[] = [
      textArg ? `text = ${textArg}` : `text = "${escapeKotlinString(text)}"`,
    ];
    const modChip = this.modifierChip(this.modifierFor(node, ctx), ctx.isRoot);
    if (modChip) chips.push(modChip);
    if (span.color) chips.push(`color = ${env.colorExpr(span.color)}`);

    const textAlign = node.textAlignHorizontal?.value ?? null;
    if (textAlign && textAlign !== 'LEFT') {
      env.useImport('androidx.compose.ui.text.style.TextAlign');
      chips.push(`textAlign = ${textAlignExpr(textAlign)}`);
    }

    const textStyleMapping = this.opts.profile
      ? resolveTextMapping(this.opts.profile, { fontFamily: span.fontFamily, fontSize: span.fontSizePx })
      : null;
    // Repeated text styles become design-system typography tokens. The
    // substitution keeps inline-only traits (italic, decorations) literal so
    // nothing is lost; user-configured style mappings keep precedence.
    const spanHasInlineOnlyTrait = span.fontStyle === 'italic' || span.decoration === 'UNDERLINE' || span.decoration === 'STRIKETHROUGH';
    const textStyleToken = !textStyleMapping && !spanHasInlineOnlyTrait
      ? env.textExpr?.({ fontFamily: span.fontFamily, fontWeight: span.fontWeight, fontSize: span.fontSizePx, lineHeight: span.lineHeightPx, letterSpacing: span.letterSpacingPx }) ?? null
      : null;
    if (textStyleMapping) {
      chips.push(`style = ${textStyleMapping.target}`);
    } else if (textStyleToken) {
      chips.push(`style = ${textStyleToken}`);
    } else {
      const styleArgs = this.textStyleArgs(span, env);
      if (styleArgs.length > 0) chips.push(`style = TextStyle(${styleArgs.join(', ')})`);
    }

    if (node.textAutoResize.value === 'TRUNCATE') {
      env.useImport('androidx.compose.ui.text.style.TextOverflow');
      chips.push('overflow = TextOverflow.Ellipsis');
    }

    this.call('Text', chips, ctx.indent, null);
  }

  private textStyleArgs(span: IrTextSpan, env: EmitEnv): string[] {
    const args: string[] = [];
    if (span.fontSizePx != null) args.push(`fontSize = ${spLiteral(span.fontSizePx)}`);
    if (span.fontWeight != null) args.push(`fontWeight = ${fontWeightExpr(span.fontWeight, env)}`);
    if (span.fontStyle === 'italic') {
      env.useImport('androidx.compose.ui.text.font.FontStyle');
      args.push('fontStyle = FontStyle.Italic');
    }
    if (span.fontFamily) args.push(`fontFamily = ${this.fontFamilyFor(span.fontFamily, env)}`);
    if (span.lineHeightPx != null) args.push(`lineHeight = ${spLiteral(span.lineHeightPx)}`);
    if (span.letterSpacingPx != null) args.push(`letterSpacing = ${spLiteral(span.letterSpacingPx)}`);
    if (span.decoration === 'UNDERLINE' || span.decoration === 'STRIKETHROUGH') {
      env.useImport('androidx.compose.ui.text.style.TextDecoration');
      args.push(span.decoration === 'UNDERLINE'
        ? 'textDecoration = TextDecoration.Underline'
        : 'textDecoration = TextDecoration.LineThrough');
    }
    if (args.length > 0) env.useImport('androidx.compose.ui.text.TextStyle');
    return args;
  }

  private fontFamilyFor(family: string, env: EmitEnv): string {
    const hit = resolveFontMapping(env.profile, family);
    if (hit) return hit.target;
    this.hintUnmappedFont(family);
    env.useImport('androidx.compose.ui.text.font.FontFamily');
    return 'FontFamily.Default';
  }

  private hintUnmappedFont(family: string): void {
    if (!this.profileActive) return;
    if (this.fontHints.has(family) || this.env().profile.fonts.some((m) => m.source.name === family)) {
      this.fontHints.add(family);
      return;
    }
    this.fontHints.add(family);
    this.diag(
      'INFO',
      'FONT-NOT-MAPPED',
      `Font family '${family}' is emitted as FontFamily.Default. Add a fonts or textStyles mapping to bind it to your typography.`,
      null,
      'font',
    );
  }

  /* ----------------------------- shapes ----------------------------- */

  private emitShape(node: IrShapeNode, ctx: EmitCtx): void {
    if (node.shape === 'LINE') {
      this.emitLine(node, ctx);
      return;
    }
    this.env().useImport(LAYOUT_COMPOSABLE_IMPORTS.Box);
    const mc = this.modifierFor(node, ctx);
    this.call('Box', this.modifierChips(mc, ctx.isRoot), ctx.indent, null);
  }

  /** A LINE is a stroked bar: the stroke weight becomes the thin axis. */
  private emitLine(node: IrShapeNode, ctx: EmitCtx): void {
    const env = this.env();
    const border = node.border;
    if (!border || border.widthPx.value <= 0) {
      env.diag('WARNING', 'LINE-NO-STROKE', `Line '${node.ref.nodeName}' has no solid stroke color; it is omitted.`, node.ref, 'stroke');
      return;
    }
    const mc = new ModifierChain(this.usageResolvers ? makeDpExpr(this.usageResolvers) : null);
    this.addPositionalModifiers(mc, node, ctx);
    const horizontal = node.geometry.width >= node.geometry.height;
    const thickness = Math.max(1, border.widthPx.value);
    if (horizontal) mc.size(node.geometry.width, thickness);
    else mc.size(thickness, node.geometry.height);
    mc.background(env.colorExpr(border.color), null);
    this.registerModifierImports(mc);
    this.call('Box', this.modifierChips(mc, ctx.isRoot), ctx.indent, null);
  }

  /* ----------------------------- vectors ----------------------------- */

  private emitVector(node: IrVectorNode, ctx: EmitCtx): void {
    const env = this.env();
    const assetName = this.assets.add('svg', node.ref, node.ref.nodeName, undefined, {
      size: { width: node.geometry.width, height: node.geometry.height },
    });
    if (!assetName) {
      // Excluded (asset-skip mark or configured name prefix): the node keeps
      // its geometry (size/position/opacity) but cannot be drawn.
      env.diag(
        'WARNING',
        'ASSET-EXCLUDED',
        `Vector node '${node.ref.nodeName}' is not exported as an asset because ${this.assets.exclusionReason()}; it is emitted as an empty placeholder.`,
        node.ref,
        'asset',
      );
      const plain: IrVectorNode = { ...node, background: null, border: null, radius: null };
      const mc = this.modifierFor(plain, ctx);
      this.call('Box', this.modifierChips(mc, ctx.isRoot), ctx.indent, null);
      return;
    }
    env.useImport('androidx.compose.foundation.Image');
    // Asset export bakes fills/strokes in (SVG file, ImageVector code or a
    // raster), so background, border and radius modifiers would double-paint;
    // they are stripped from the emitted chain.
    const stripped: IrVectorNode = { ...node, background: null, border: null, radius: null };
    const mc = this.modifierFor(stripped, ctx);
    this.call('Image', this.assetImageChips(assetName, mc, ctx.isRoot, env), ctx.indent, null);
  }

  private modifierChips(mc: ModifierChain, isRoot: boolean): string[] {
    const chip = this.modifierChip(mc, isRoot);
    return chip ? [chip] : [];
  }
}

function textAlignExpr(value: string): string {
  switch (value) {
    case 'CENTER': return 'TextAlign.Center';
    case 'RIGHT': return 'TextAlign.Right';
    case 'JUSTIFIED': return 'TextAlign.Justify';
    default: return 'TextAlign.Left';
  }
}
