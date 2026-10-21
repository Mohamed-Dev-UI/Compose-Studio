/**
 * Plugin entry point (Figma sandbox / "main" thread).
 *
 * Responsibilities:
 * - show the plugin UI (a single self-contained ui.html bundled by esbuild);
 * - handle UI messages (inspect / convert / settings / notify / close);
 * - collect the design-token table once per conversion;
 * - run the extractor over the current selection and generate Kotlin;
 * - resolve asset bytes (image fills) and SVG sources (vectors) for the ZIP;
 * - never touch the network (enforced by manifest `networkAccess: none`).
 */
import type {
  ComponentPropSnapshot,
  FigmaContext,
  FigmaSceneNode,
  InstanceComponentInfo,
} from './extract/figma-types.ts';
import { Extractor } from './extract/extract.ts';
import { generateCode } from './gen/generate.ts';
import { buildIconsFile } from './gen/imagevector.ts';
import type { IrDocument, IrInstanceNode, IrNode } from './ir/ir.ts';
import { applyComponentSetBehavior, parseVariantProps } from './ir/set-roots.ts';
import { sniffImageExt } from './util/images.ts';
import type {
  ColorMapping,
  ComponentMapping,
  FontMapping,
  MappingProfile,
  TextMapping,
} from './mapping/profile.ts';
import type {
  AssetSourcesPayload,
  ComponentConfigInfo,
  ComponentConfigPreset,
  ComponentConfigsPayload,
  ConversionResultPayload,
  DiagnosticPayload,
  ExportedImageAssetPayload,
  ExportedVectorAssetPayload,
  InspectionPayload,
  OutputFilePayload,
  PageSummary,
  PluginSettings,
  PluginToUiMessage,
  SelectedNodeInfo,
  UiToPluginMessage,
} from './shared/messages.ts';
import type { AssetFormat, AssetFormatOverride, LibraryAsset, MarkCandidate, NodeMark } from './shared/marks.ts';
import { markId, matchesIgnorePrefix, matchesMark } from './shared/marks.ts';
import {
  applyComposeConfigToDescription,
  BUILTIN_COMPONENT_PRESETS,
  buildComposeConfigBlock,
  COMPOSE_CONFIG_MARKER,
  COMPOSE_CONFIG_TEMPLATE,
  COMPOSE_CONFIG_VERSION,
  describeComposeConfig,
  normalizeComponentConfig,
  parseComposeConfig,
  stripComposeConfig,
  suggestMappingName,
  type ParsedComponentConfig,
} from './shared/compose-config.ts';
import { snakeCase } from './util/identifiers.ts';
import type { DesignSystemInput, DesignSystemResult, DsRgba } from './gen/designsystem.ts';
import { buildDesignSystem, dsPercentToSp, emptyDesignSystemInput } from './gen/designsystem.ts';
import type { UsageHarvest, UsageResolvers } from './gen/usage.ts';
import { buildUsageResolvers, collectUsageTokens, mergeDesignSystemInput } from './gen/usage.ts';
import { collectTokens, tokenLookupFor, type TokenTable } from './tokens/collect.ts';
import uiHtml from './ui/ui.html';

/** Figma node types the extractor accepts as conversion roots. */
const CONVERTABLE_TYPES = new Set([
  'FRAME', 'SECTION', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'TEXT',
  'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'BOOLEAN_OPERATION', 'VECTOR', 'INSTANCE',
]);

const DEFAULT_SETTINGS: PluginSettings = {
  appName: 'ComposeApp',
  packageName: 'com.example.composeapp',
  fontFamilyMap: {},
  colorMap: {},
  colorMapNames: {},
  textStyleMap: {},
  iconAssetPrefix: '',
  imageAssetPrefix: '',
  ignorePrefix: '',
  componentMap: {},
  variantParamStyle: 'enum',
  variantShape: 'auto',
  exportAssets: true,
  vectorFormat: 'svg',
  imageFormat: 'auto',
  dsSource: 'off',
  dsStructure: 'object',
  dsUsage: false,
  dsUsageMin: 2,
  componentSetBehavior: 'component',
};

const SETTINGS_KEY = 'compose-studio-settings';
const IGNORE_MARKS_KEY = 'compose-studio-ignore-marks';
const ASSET_SKIP_KEY = 'compose-studio-asset-skip-marks';
const LIBRARY_KEY = 'compose-studio-asset-library';

let settings: PluginSettings = { ...DEFAULT_SETTINGS };

/** User ignore marks (exact node identities); loaded at boot. */
let ignoreMarks: NodeMark[] = [];
/** User asset-skip marks (keep layout, no asset export); loaded at boot. */
let assetSkipMarks: NodeMark[] = [];
/** Curated asset-library entries harvested from asset pages; loaded at boot. */
let assetLibrary: LibraryAsset[] = [];

/* ---------------------------------------------------------------------------
 * Messages
 * ------------------------------------------------------------------------ */

function postMessage(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

function notify(message: string, isError = false): void {
  postMessage({ type: 'notify', payload: { message, isError } });
}

/* ---------------------------------------------------------------------------
 * Settings persistence
 * ------------------------------------------------------------------------ */

async function loadSettings(): Promise<PluginSettings> {
  try {
    const raw = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Partial<PluginSettings> | null | undefined;
    if (raw && typeof raw === 'object') {
      const merged = { ...DEFAULT_SETTINGS, ...raw };
      // Validate enum-ish values that may be stale/garbage from older versions.
      if (!['enum', 'sealed', 'string'].includes(merged.variantParamStyle)) {
        merged.variantParamStyle = 'enum';
      }
      if (!['auto', 'when', 'functions', 'object'].includes(merged.variantShape)) {
        merged.variantShape = 'auto';
      }
      if (typeof merged.exportAssets !== 'boolean') merged.exportAssets = true;
      if (!['svg', 'imagevector', 'png'].includes(merged.vectorFormat)) merged.vectorFormat = 'svg';
      if (!['auto', 'png', 'jpg'].includes(merged.imageFormat)) merged.imageFormat = 'auto';
      if (!['off', 'variables', 'styles', 'both'].includes(merged.dsSource)) merged.dsSource = 'off';
      if (!['object', 'material', 'material-theme'].includes(merged.dsStructure)) merged.dsStructure = 'object';
      if (typeof merged.dsUsage !== 'boolean') merged.dsUsage = false;
      if (!['component', 'frame', 'frame-of-components'].includes(merged.componentSetBehavior)) {
        merged.componentSetBehavior = 'component';
      }
      // Migration: the retired Config-tab `variantGroupBehavior` maps onto the
      // shared strip (merge -> component, separate -> frame-of-components,
      // ask -> the new default).
      const legacyGroup = (raw as { variantGroupBehavior?: unknown }).variantGroupBehavior;
      if (raw.componentSetBehavior === undefined && typeof legacyGroup === 'string') {
        merged.componentSetBehavior = legacyGroup === 'separate' ? 'frame-of-components' : 'component';
      }
      const min = typeof merged.dsUsageMin === 'number' && Number.isFinite(merged.dsUsageMin) ? Math.round(merged.dsUsageMin) : 2;
      merged.dsUsageMin = Math.min(99, Math.max(2, min));
      return merged;
    }
  } catch {
    // Storage access is best-effort; defaults are fine.
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(value: PluginSettings): Promise<void> {
  settings = value;
  try {
    await figma.clientStorage.setAsync(SETTINGS_KEY, value);
  } catch {
    notify('Settings could not be persisted (storage unavailable).', true);
  }
}

/* ---------------------------------------------------------------------------
 * Ignore rules, asset-skip marks and the asset library (user curation)
 * ------------------------------------------------------------------------ */

/**
 * The user's curation state: three lists kept in client storage.
 * - Ignore rules: name prefix (a setting) + exact marks; matching nodes and
 *   their subtrees are skipped entirely in conversions and harvests.
 * - Asset-skip marks: matched nodes keep their layout but export no asset.
 * - Asset library: canonical assets harvested from dedicated asset pages;
 *   screen nodes matching an entry export the canonical asset.
 */

function parseMarks(raw: unknown): NodeMark[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: NodeMark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Partial<NodeMark>;
    if (typeof m.name !== 'string' || typeof m.fType !== 'string') continue;
    cleaned.push({
      id: typeof m.id === 'string' && m.id ? m.id : markId(m.name, m.fType, m.masterId ?? null, m.width ?? null, m.height ?? null),
      name: m.name,
      fType: m.fType,
      width: typeof m.width === 'number' ? m.width : null,
      height: typeof m.height === 'number' ? m.height : null,
      masterId: typeof m.masterId === 'string' && m.masterId ? m.masterId : null,
    });
  }
  return cleaned;
}

function parseLibraryEntries(raw: unknown): LibraryAsset[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: LibraryAsset[] = [];
  const seenKeys = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<LibraryAsset>;
    if (typeof e.key !== 'string' || !e.key) continue;
    if ((e.kind !== 'svg' && e.kind !== 'png') || typeof e.fuid !== 'string' || !e.fuid) continue;
    if (typeof e.pageId !== 'string' || typeof e.nodeName !== 'string' || typeof e.fType !== 'string') continue;
    if (seenKeys.has(e.key)) continue;
    seenKeys.add(e.key);
    // Per-entry format override persists only when it is a known, kind-valid
    // value ('auto' is the default and is stored as absent).
    const FORMAT_OVERRIDES = ['auto', 'svg', 'imagevector', 'png', 'jpg'];
    const fmtValid = typeof e.fmt === 'string' && FORMAT_OVERRIDES.includes(e.fmt)
      && !(e.kind === 'png' && (e.fmt === 'svg' || e.fmt === 'imagevector'));
    cleaned.push({
      key: e.key,
      kind: e.kind,
      fuid: e.fuid,
      pageId: e.pageId,
      nodeName: e.nodeName,
      fType: e.fType,
      width: typeof e.width === 'number' ? e.width : null,
      height: typeof e.height === 'number' ? e.height : null,
      masterId: typeof e.masterId === 'string' && e.masterId ? e.masterId : null,
      imageHash: typeof e.imageHash === 'string' && e.imageHash ? e.imageHash : null,
      ...(fmtValid && e.fmt !== 'auto' ? { fmt: e.fmt as AssetFormat } : {}),
    });
  }
  return cleaned;
}

/** Loads marks + library from client storage (best effort). */
async function loadCuration(): Promise<void> {
  try {
    const [ignoreRaw, skipRaw, libraryRaw] = await Promise.all([
      figma.clientStorage.getAsync(IGNORE_MARKS_KEY),
      figma.clientStorage.getAsync(ASSET_SKIP_KEY),
      figma.clientStorage.getAsync(LIBRARY_KEY),
    ]);
    ignoreMarks = parseMarks(ignoreRaw);
    assetSkipMarks = parseMarks(skipRaw);
    assetLibrary = parseLibraryEntries(libraryRaw);
  } catch {
    // Storage unavailable: run with empty curation rather than fail.
  }
}

/** Persists marks + library (best effort; failure is only notified). */
async function saveCuration(): Promise<void> {
  try {
    await Promise.all([
      figma.clientStorage.setAsync(IGNORE_MARKS_KEY, ignoreMarks),
      figma.clientStorage.setAsync(ASSET_SKIP_KEY, assetSkipMarks),
      figma.clientStorage.setAsync(LIBRARY_KEY, assetLibrary),
    ]);
  } catch {
    notify('Marks could not be persisted (storage unavailable).', true);
  }
}

/** Pages of the document for the harvest dropdown (root.children is readable). */
function listPages(): PageSummary[] {
  try {
    return figma.root.children.map((page) => ({ id: page.id, name: page.name, current: page.id === figma.currentPage.id }));
  } catch {
    const current = figma.currentPage;
    return [{ id: current.id, name: current.name, current: true }];
  }
}

/** Sends the current curation snapshot to the UI (with an optional notice). */
function postAssetSources(info?: string): void {
  const payload: AssetSourcesPayload = {
    pages: listPages(),
    ignoreMarks,
    assetSkipMarks,
    library: assetLibrary,
  };
  postMessage({ type: 'asset-sources', payload });
  if (info) notify(info);
}

/** Candidate facts for mark matching, read cheaply from any node. */
function markCandidateOf(node: { name: string; type: string; width: number | null; height: number | null }, masterId: string | null = null): MarkCandidate {
  return { name: node.name, fType: node.type, width: node.width, height: node.height, masterId };
}

function matchesIgnoreRules(candidate: MarkCandidate): boolean {
  if (matchesIgnorePrefix(settings.ignorePrefix, candidate)) return true;
  return ignoreMarks.some((mark) => matchesMark(mark, candidate));
}

async function markNodes(kind: 'ignore' | 'asset-skip'): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    notify('Select the frame, group or component to mark first (then use the mark button).', true);
    return;
  }
  const target = kind === 'ignore' ? ignoreMarks : assetSkipMarks;
  const label = kind === 'ignore' ? 'ignored' : 'excluded from asset export';
  let added = 0;
  for (const node of selection) {
    if (typeof node.name !== 'string' || typeof node.type !== 'string') continue;
    // Capture durable identity: components match by master id, instances via
    // the async master resolution; plain nodes match by name + type + size.
    let masterId: string | null = null;
    if (node.type === 'COMPONENT') {
      masterId = node.id;
    } else if (node.type === 'INSTANCE') {
      try {
        masterId = (await node.getMainComponentAsync())?.id ?? null;
      } catch {
        masterId = null;
      }
    }
    const width = typeof node.width === 'number' ? node.width : null;
    const height = typeof node.height === 'number' ? node.height : null;
    const entry: NodeMark = {
      id: markId(node.name, node.type, masterId, width, height),
      name: node.name,
      fType: node.type,
      width,
      height,
      masterId,
    };
    if (!target.some((mark) => mark.id === entry.id)) {
      target.push(entry);
      added += 1;
    }
  }
  await saveCuration();
  postAssetSources(added === 0 ? 'The selection is already marked.' : `Marked ${added} node(s) as ${label}.`);
}

async function unmark(kind: 'ignore' | 'asset-skip', id: string): Promise<void> {
  const target = kind === 'ignore' ? ignoreMarks : assetSkipMarks;
  const index = target.findIndex((mark) => mark.id === id);
  if (index >= 0) target.splice(index, 1);
  await saveCuration();
  postAssetSources(index >= 0 ? 'Mark removed.' : 'That mark is no longer on the list.');
}

/** Unique, canonical resource-name base for a harvested asset. */
function uniqueLibraryKey(name: string, usedKeys: Set<string>): string {
  const base = snakeCase(name) || 'asset';
  let key = base;
  let n = 1;
  while (usedKeys.has(key)) {
    n += 1;
    key = `${base}_${n}`;
  }
  return key;
}

/**
 * Harvests canonical assets from a dedicated asset page: top-level children
 * (SECTION children expand one level) become library entries. Nodes with an
 * image fill become PNG entries; everything else becomes an SVG entry.
 * COMPONENT masters record their master id so screen instances match by
 * exact identity; plain instances are skipped (they repeat a master).
 * Ignore rules apply here too, so curated "not an asset" names stay out.
 */
async function harvestPage(pageId: string | null): Promise<void> {
  let page = figma.currentPage;
  if (pageId) {
    try {
      const found = await figma.getNodeByIdAsync(pageId);
      if (found && found.type === 'PAGE') page = found as unknown as typeof page;
    } catch {
      // Fall back to the current page.
    }
  }
  try {
    await page.loadAsync();
  } catch {
    // Already-loaded pages (the current one) do not need loadAsync.
  }
  type HarvestLikeNode = {
    id: string;
    name: string;
    type: string;
    visible?: boolean;
    width: number;
    height: number;
    children?: readonly HarvestLikeNode[];
  };
  let tops: HarvestLikeNode[] = [];
  try {
    tops = page.children as unknown as HarvestLikeNode[];
  } catch {
    postAssetSources(`Page '${page.name}' contents could not be loaded.`);
    return;
  }
  const candidates: HarvestLikeNode[] = [];
  for (const top of tops) {
    if (top.type === 'SECTION' && Array.isArray(top.children)) candidates.push(...top.children);
    else candidates.push(top);
  }
  if (candidates.length === 0) {
    postAssetSources(`Page '${page.name}' has no top-level layers to harvest.`);
    return;
  }
  let added = 0;
  let updated = 0;
  let skippedIgnored = 0;
  const usedKeys = new Set(assetLibrary.map((entry) => entry.key));
  for (const node of candidates) {
    if (node.visible === false) continue;
    const masterId = node.type === 'COMPONENT' ? node.id : null;
    const width = typeof node.width === 'number' ? node.width : null;
    const height = typeof node.height === 'number' ? node.height : null;
    if (matchesIgnoreRules(markCandidateOf(node, masterId))) {
      skippedIgnored += 1;
      continue;
    }
    let kind: 'svg' | 'png' = 'svg';
    let imageHash: string | null = null;
    try {
      const paints = (node as unknown as { fills?: unknown }).fills;
      if (Array.isArray(paints)) {
        for (const paint of paints) {
          const p = paint as { type?: string; visible?: boolean; imageHash?: string };
          if (p.type === 'IMAGE' && p.visible !== false && typeof p.imageHash === 'string' && p.imageHash) {
            kind = 'png';
            imageHash = p.imageHash;
            break;
          }
        }
      }
    } catch {
      // fills not readable (mixed paints); treat the node as an SVG source.
    }
    const entry: LibraryAsset = {
      key: uniqueLibraryKey(node.name, usedKeys),
      kind,
      fuid: node.id,
      pageId: page.id,
      nodeName: node.name,
      fType: node.type,
      width,
      height,
      masterId,
      imageHash,
    };
    // Re-harvesting the same page refreshes entries instead of duplicating.
    const existing = assetLibrary.find((e) => e.fuid === node.id);
    if (existing) {
      usedKeys.delete(existing.key);
      Object.assign(existing, entry);
      updated += 1;
    } else {
      assetLibrary.push(entry);
      added += 1;
    }
    usedKeys.add(entry.key);
  }
  await saveCuration();
  const summary = added || updated ? `Harvested ${added + updated} asset(s) from '${page.name}'` : `No harvestable assets found on '${page.name}'`;
  const note = skippedIgnored ? ` (${skippedIgnored} layer(s) matched an ignore rule)` : '';
  postAssetSources(`${summary}${note}.`);
}

async function removeLibraryEntry(key: string): Promise<void> {
  const index = assetLibrary.findIndex((entry) => entry.key === key);
  if (index >= 0) assetLibrary.splice(index, 1);
  await saveCuration();
  postAssetSources(index >= 0 ? 'Library asset removed.' : 'That asset is no longer in the library.');
}

/** Sets or clears ('auto') one library entry's per-entry export format. */
async function setLibraryFmt(key: string, fmt: AssetFormatOverride): Promise<void> {
  const entry = assetLibrary.find((e) => e.key === key);
  if (!entry) {
    postAssetSources('That asset is no longer in the library.');
    return;
  }
  // A raster source cannot become SVG/ImageVector code; ignore such overrides.
  const kindValid = entry.kind === 'svg' || fmt === 'png' || fmt === 'jpg' || fmt === 'auto';
  if (!kindValid) {
    postAssetSources('That format does not apply to a raster asset.');
    return;
  }
  if (fmt === 'auto') {
    if ('fmt' in entry) delete entry.fmt;
  } else {
    entry.fmt = fmt;
  }
  await saveCuration();
  const label = fmt === 'auto' ? 'follow the global default' : fmt.toUpperCase();
  postAssetSources(`Format for '${key}' set to ${label}.`);
}

async function clearLibrary(): Promise<void> {
  assetLibrary = [];
  await saveCuration();
  postAssetSources('Asset library cleared.');
}

/* ---------------------------------------------------------------------------
 * Mapping profile from plugin settings
 * ------------------------------------------------------------------------ */

const KOTLIN_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Translate the settings records into a typed mapping profile.
 * Values are filtered defensively so malformed entries never reach the
 * generator (they are dropped, not silently misused).
 */
function profileFromSettings(value: PluginSettings): MappingProfile {
  const colors: ColorMapping[] = [];
  for (const [hex, target] of Object.entries(value.colorMap ?? {})) {
    if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex) && typeof target === 'string' && target) {
      colors.push({ source: { kind: 'hex', name: hex }, target });
    }
  }
  for (const [name, target] of Object.entries(value.colorMapNames ?? {})) {
    if (name && typeof target === 'string' && target) {
      colors.push({ source: { kind: 'variable', name }, target });
    }
  }
  const fonts: FontMapping[] = [];
  for (const [family, target] of Object.entries(value.fontFamilyMap ?? {})) {
    if (family && typeof target === 'string' && target) {
      fonts.push({ source: { kind: 'family', name: family }, target });
    }
  }
  const textStyles: TextMapping[] = [];
  for (const [family, target] of Object.entries(value.textStyleMap ?? {})) {
    if (family && typeof target === 'string' && target) {
      textStyles.push({ source: { kind: 'fontFamily', name: family }, target });
    }
  }
  const components: ComponentMapping[] = [];
  for (const [name, symbol] of Object.entries(value.componentMap ?? {})) {
    if (name && typeof symbol === 'string' && KOTLIN_SYMBOL.test(symbol)) {
      components.push({ source: { kind: 'component', componentName: name }, target: { symbol }, arguments: [] });
    }
  }
  return {
    schemaVersion: 1,
    profileName: 'Plugin settings',
    colors,
    fonts,
    textStyles,
    components,
  };
}

/* ---------------------------------------------------------------------------
 * Selection inspection
 * ------------------------------------------------------------------------ */

function inspectionPayload(): InspectionPayload {
  const selectedNodes: SelectedNodeInfo[] = figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.type,
    convertable: node.visible !== false && CONVERTABLE_TYPES.has(node.type),
  }));
  return { selectedNodes };
}

/* Live selection updates: `selectionchange` fires continuously while the user
 * drags a marquee or moves nodes, so posts are debounced and suppressed when
 * the payload did not actually change (also avoids UI re-render flicker). */

let selectionTimer: ReturnType<typeof setTimeout> | null = null;
let lastSelectionSignature = '';

function selectionSignature(payload: InspectionPayload): string {
  return payload.selectedNodes
    .map((node) => `${node.id}|${node.name}|${node.kind}|${node.convertable ? 1 : 0}`)
    .join(';');
}

/** Sends the current selection to the UI (deduplicates identical payloads). */
function postInspection(): void {
  const payload = inspectionPayload();
  const signature = selectionSignature(payload);
  if (signature === lastSelectionSignature) return;
  lastSelectionSignature = signature;
  postMessage({ type: 'inspection', payload });
}

function watchSelection(): void {
  figma.on('selectionchange', () => {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      postInspection();
      void postComponentConfigs();
    }, 200);
  });
}

/* ---------------------------------------------------------------------------
 * Component configuration descriptions (CCD)
 * ------------------------------------------------------------------------ */

/* Saved component-configuration presets: named snapshots of a parsed config
 * in client storage, reusable on any component (Config tab). Everything is
 * normalized before persisting, so storage only ever holds clean configs.
 */
const COMPONENT_PRESETS_KEY = 'compose-studio-component-presets';
const COMPONENT_PRESETS_CAP = 30;
let componentPresets: ComponentConfigPreset[] = [];

/** Names are trimmed, whitespace-squeezed and capped (unique enough for reuse). */
function clampPresetName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 48) : '';
}

async function loadComponentPresets(): Promise<ComponentConfigPreset[]> {
  try {
    const raw = (await figma.clientStorage.getAsync(COMPONENT_PRESETS_KEY)) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: ComponentConfigPreset[] = [];
    for (const item of raw.slice(0, COMPONENT_PRESETS_CAP)) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as { name?: unknown; config?: unknown };
      const name = clampPresetName(entry.name);
      const { config, issues } = normalizeComponentConfig(entry.config);
      if (name && config && issues.length === 0) out.push({ name, config });
    }
    return out;
  } catch {
    return [];
  }
}

/** Persists the preset list and lets the UI refresh its preset bar. */
async function persistComponentPresets(): Promise<void> {
  try {
    await figma.clientStorage.setAsync(COMPONENT_PRESETS_KEY, componentPresets);
  } catch {
    notify('The preset list could not be stored (client storage is unavailable).', true);
    return;
  }
  postMessage({ type: 'component-presets', payload: { presets: mergedComponentPresets() } });
}

/**
 * The preset catalog the UI sees: the user's own presets first, then the
 * shipped starting points (a saved preset with the same name shadows the
 * built-in, and deleting it brings the built-in back).
 */
function mergedComponentPresets(): ComponentConfigPreset[] {
  const out: ComponentConfigPreset[] = componentPresets.map((preset) => ({ ...preset }));
  for (const builtin of BUILTIN_COMPONENT_PRESETS) {
    if (out.some((preset) => preset.name === builtin.name)) continue;
    out.push({ name: builtin.name, config: { ...builtin.config }, builtin: true });
  }
  return out;
}

/** Saves (or replaces) a named preset built from the visual editor's payload. */
async function saveComponentPreset(payload: { name: string; config: unknown }): Promise<void> {
  const name = clampPresetName(payload?.name);
  if (!name) {
    notify('Give the preset a name before saving.', true);
    return;
  }
  const { config, issues } = normalizeComponentConfig(payload?.config);
  if (issues.length > 0) {
    notify(`The configuration could not become a preset: ${issues.join(' ')}`, true);
    return;
  }
  componentPresets = [{ name, config }, ...componentPresets.filter((p) => p.name !== name)].slice(0, COMPONENT_PRESETS_CAP);
  await persistComponentPresets();
  notify(`Preset '${name}' saved.`, false);
}

/** Deletes a preset by name (no-op for unknown names). */
async function deleteComponentPreset(payload: { name: string }): Promise<void> {
  const name = clampPresetName(payload?.name);
  componentPresets = componentPresets.filter((p) => p.name !== name);
  await persistComponentPresets();
  notify(`Preset '${name}' deleted.`, false);
}

/** Selection nodes that carry (or can carry) a configuration: INSTANCE or COMPONENT. */
function selectionComponentCandidates(): { id: string; names: string[] }[] {
  const namesById = new Map<string, string[]>();
  const order: string[] = [];
  const visit = (node: unknown): void => {
    const n = node as { id?: string; type?: string; name?: string; children?: readonly unknown[] };
    if (!n || typeof n.id !== 'string') return;
    if (n.type === 'INSTANCE' || n.type === 'COMPONENT') {
      order.push(n.id);
      const list = namesById.get(n.id) ?? [];
      if (typeof n.name === 'string') list.push(n.name);
      namesById.set(n.id, list);
    }
    if (n.children) for (const child of n.children) visit(child);
  };
  for (const node of figma.currentPage.selection) visit(node);
  return order.map((id) => ({ id, names: [...new Set(namesById.get(id) ?? [])] }));
}

/** Builds one UI record for a master component description. */
function componentConfigInfo(
  masterId: string,
  masterName: string,
  nodeNames: string[],
  description: unknown,
  variant: { setId: string | null; setName: string | null; variantProps: Record<string, string> | null },
): ComponentConfigInfo {
  let prose = '';
  let blockText: string | null = null;
  let config: ParsedComponentConfig | null = null;
  let issues: string[] = [];
  let summary = '';
  try {
    const text = typeof description === 'string' ? description : '';
    const parsed = parseComposeConfig(text);
    prose = parsed.prose;
    issues = parsed.issues;
    if (parsed.config) {
      config = parsed.config;
      summary = describeComposeConfig(parsed.config);
      const lines = text.split(/\r?\n/);
      const markerAt = lines.findIndex((l) => l.trim() === COMPOSE_CONFIG_MARKER);
      blockText = markerAt >= 0 ? lines.slice(markerAt + 1).join('\n').trim() : null;
    }
  } catch {
    issues = ['the component description could not be read'];
  }
  return {
    masterId,
    masterName,
    nodeNames,
    hasConfig: blockText !== null,
    summary,
    prose,
    blockText,
    config,
    issues,
    suggestedMapping: suggestMappingName(masterName),
    setId: variant.setId,
    setName: variant.setName,
    variantProps: variant.variantProps,
  };
}

/** Resolves the selection to master components and posts the editor payload. */
async function postComponentConfigs(): Promise<void> {
  const candidates = selectionComponentCandidates();
  const masters = new Map<string, {
    name: string;
    description: unknown;
    nodeNames: string[];
    setId: string | null;
    setName: string | null;
    variantProps: Record<string, string> | null;
  }>();
  await Promise.all(candidates.map(async (candidate) => {
    let node: unknown = null;
    try {
      node = await figma.getNodeByIdAsync(candidate.id);
    } catch {
      return;
    }
    if (node && (node as { type?: string }).type === 'INSTANCE') {
      const getter = (node as unknown as { getMainComponentAsync?: () => Promise<unknown> }).getMainComponentAsync;
      if (typeof getter !== 'function') return;
      try {
        node = await getter.call(node);
      } catch {
        return;
      }
    }
    if (!node || (node as { type?: string }).type !== 'COMPONENT') return;
    // Variant grouping for the Config tab: a master inside a COMPONENT_SET is
    // a variant; its assignments come from `variantProperties` (name-derived,
    // sync-safe on the loaded node) with the `Key=Value` name as fallback.
    let setId: string | null = null;
    let setName: string | null = null;
    let variantProps: Record<string, string> | null = null;
    try {
      const parent = (node as unknown as { parent?: { type?: string; id?: string; name?: string } }).parent;
      if (parent && parent.type === 'COMPONENT_SET' && typeof parent.id === 'string' && typeof parent.name === 'string') {
        setId = parent.id;
        setName = parent.name;
      }
    } catch {
      // Relational reads degrade per field (dynamic-page safety).
    }
    try {
      const props = (node as unknown as { variantProperties?: Record<string, string> | null }).variantProperties;
      if (props && typeof props === 'object' && Object.keys(props).length > 0) variantProps = { ...props };
    } catch {
      // Property reads degrade per field.
    }
    if (!variantProps && setName !== null) {
      variantProps = parseVariantProps((node as { name: string }).name);
    }
    const masterId = (node as { id: string }).id;
    const entry = masters.get(masterId) ?? {
      name: (node as { name: string }).name,
      description: (node as { description?: unknown }).description,
      nodeNames: [],
      setId,
      setName,
      variantProps,
    };
    entry.nodeNames.push(...candidate.names);
    masters.set(masterId, entry);
  }));
  const payload: ComponentConfigsPayload = {
    version: COMPOSE_CONFIG_VERSION,
    template: COMPOSE_CONFIG_TEMPLATE,
    presets: mergedComponentPresets(),
    masters: [...masters.entries()].map(([masterId, entry]) =>
      componentConfigInfo(masterId, entry.name, entry.nodeNames, entry.description, {
        setId: entry.setId,
        setName: entry.setName,
        variantProps: entry.variantProps,
      })),
  };
  postMessage({ type: 'component-configs', payload });
}

/** Writes one master's configuration (visual config / raw block / removal), then re-posts. */
async function writeComponentConfig(
  payload: { masterId: string; config?: unknown; yaml?: string; remove?: boolean },
): Promise<void> {
  let node: unknown = null;
  try {
    node = await figma.getNodeByIdAsync(payload.masterId);
  } catch {
    node = null;
  }
  if (!node || (node as { type?: string }).type !== 'COMPONENT') {
    notify('The component for this configuration is no longer available (it may have been deleted).', true);
    return;
  }
  const master = node as unknown as { name: string; description: string };
  const current = typeof master.description === 'string' ? master.description : '';
  const prose = stripComposeConfig(current);
  let notes = '';
  let blockText: string | null = null;
  if (!payload.remove) {
    if (typeof payload.yaml === 'string' && payload.yaml.trim() !== '') {
      // Raw block text (advanced editor): written verbatim so comments survive.
      blockText = payload.yaml.trim();
      const check = parseComposeConfig(`${COMPOSE_CONFIG_MARKER}\n${blockText}`);
      notes = check.issues.join(' ');
    } else if (payload.config !== undefined) {
      // Visual editor payload: normalized, then rendered back to block text.
      const { config, issues } = normalizeComponentConfig(payload.config);
      blockText = buildComposeConfigBlock(config, false);
      if (issues.length > 0) notes = issues.join(' ');
    }
    if (blockText !== null && blockText.trim() === '') {
      // An all-default config has nothing to say — strip the block instead
      // of writing a bare marker (which would parse to "carries no keys").
      blockText = null;
    }
  }
  const next = blockText === null ? prose : applyComposeConfigToDescription(prose, blockText);
  const removed = !payload.remove && blockText === null;
  try {
    master.description = next;
  } catch (e) {
    notify(`The description could not be written (${e instanceof Error ? e.message : String(e)}). The configuration can still be copy-pasted into the description manually.`, true);
    return;
  }
  if (payload.remove || removed) notify('Configuration removed.', false);
  else if (notes) notify(`Configuration saved, with notes: ${notes}`, false);
  else notify('Configuration saved.', false);
  await postComponentConfigs();
}

/* ---------------------------------------------------------------------------
 * Conversion
 * ------------------------------------------------------------------------ */

let tokenTable: TokenTable | null = null;

async function ensureTokens(): Promise<TokenTable> {
  if (!tokenTable) {
    tokenTable = await collectTokens(figma as unknown as Parameters<typeof collectTokens>[0]);
  }
  return tokenTable;
}

/** ID map of every node in the current selection subtree (for asset exports). */
function selectionNodesById(): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const visit = (node: { id: string; children?: readonly unknown[] }): void => {
    map.set(node.id, node);
    const children = node.children;
    if (children) for (const child of children) visit(child as { id: string; children?: readonly unknown[] });
  };
  for (const node of figma.currentPage.selection) {
    visit(node as unknown as { id: string; children?: readonly unknown[] });
  }
  return map;
}

interface ExportableNode {
  exportAsync(options: { format: 'SVG_STRING' }): Promise<string>;
  exportAsync(options: { format: 'PNG' | 'JPG'; contentsOnly?: boolean }): Promise<Uint8Array>;
}

function bytesToBase64(bytes: Uint8Array): Promise<string> {
  // figma.base64Encode's exact signature has shifted across plugin versions;
  // accept both sync string and Promise returns.
  const result = (figma.base64Encode as unknown as (data: Uint8Array) => string | Promise<string>)(bytes);
  return Promise.resolve(result);
}

/**
 * Exports every asset the generation requested, honoring each asset's
 * resolved format:
 * - `svg` / `imagevector` (vector sources): `exportAsync(SVG_STRING)`;
 *   the SVG text is kept for the ZIP (`svg`) or the serif-free Kotlin
 *   conversion (`imagevector`) and is always returned for the UI preview.
 * - `png` / `jpg` on a vector source: a node raster re-render.
 * - png-kind (image fills): `stored` keeps Figma's imported bytes (the
 *   extension is sniffed from the actual bytes — a JPEG photo stays .jpg);
 *   forced png/jpg re-renders the source node to that format.
 * Every failure emits a diagnostic, never a silent skip.
 */
async function resolveAssets(): Promise<{
  imageAssets: ExportedImageAssetPayload[];
  vectorAssets: ExportedVectorAssetPayload[];
  /** SVG source per exported vector asset (UI preview + ImageVector conversion). */
  svgSources: Map<string, string>;
  diagnostics: DiagnosticPayload[];
}> {
  const imageAssets: ExportedImageAssetPayload[] = [];
  const vectorAssets: ExportedVectorAssetPayload[] = [];
  const svgSources = new Map<string, string>();
  const diagnostics: DiagnosticPayload[] = [];
  const nodeById = selectionNodesById();

  /** Loads an asset's export source, preferring the current document. */
  const resolveNode = async (fuid: string, libraryPageId?: string, localFuid?: string): Promise<ExportableNode | undefined> => {
    let node = nodeById.get(fuid) as ExportableNode | undefined;
    if (!node && libraryPageId) {
      node = await loadCrossPageAssetNode(fuid, libraryPageId);
    }
    if (!node && localFuid) {
      node = nodeById.get(localFuid) as ExportableNode | undefined;
      if (!node) {
        try {
          const found = await figma.getNodeByIdAsync(localFuid);
          node = (found ?? undefined) as unknown as ExportableNode | undefined;
        } catch {
          node = undefined;
        }
      }
    }
    return node;
  };

  for (const asset of pendingAssets) {
    if (asset.kind === 'png') {
      if (asset.stored) {
        const hash = asset.meta?.imageHash;
        if (!hash) {
          diagnostics.push({ level: 'error', message: `Image asset '${asset.name}' has no image hash; it is skipped.` });
          continue;
        }
        try {
          const image = figma.getImageByHash(hash);
          if (!image) {
            diagnostics.push({ level: 'error', message: `Image asset '${asset.name}' could not be created from hash '${hash}'.` });
            continue;
          }
          const bytes = await image.getBytesAsync();
          imageAssets.push({ assetName: asset.name, bytesBase64: await bytesToBase64(bytes), ext: sniffImageExt(bytes) });
        } catch (e) {
          diagnostics.push({
            level: 'error',
            message: `Image asset '${asset.name}' could not be exported: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      } else {
        // Forced PNG/JPG re-render of the node as displayed.
        const node = await resolveNode(asset.source.fuid, asset.meta?.libraryPageId, asset.meta?.localFuid);
        if (!node) {
          diagnostics.push({
            level: 'error',
            message: `Image asset '${asset.name}' source node ('${asset.source.nodeName}') could not be found; it is skipped. If it came from the asset library, re-harvest the asset page.`,
          });
          continue;
        }
        try {
          const bytes = await node.exportAsync({ format: asset.fmt === 'jpg' ? 'JPG' : 'PNG', contentsOnly: true });
          imageAssets.push({ assetName: asset.name, bytesBase64: await bytesToBase64(bytes), ext: sniffImageExt(bytes) });
        } catch (e) {
          diagnostics.push({
            level: 'error',
            message: `Image asset '${asset.name}' could not be re-rendered as ${asset.fmt.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      continue;
    }

    // Vector source: either SVG text (svg file / ImageVector code) or a raster.
    if (asset.fmt === 'png' || asset.fmt === 'jpg') {
      const node = await resolveNode(asset.source.fuid, asset.meta?.libraryPageId, asset.meta?.localFuid);
      if (!node) {
        diagnostics.push({
          level: 'error',
          message: `Vector asset '${asset.name}' source node ('${asset.source.nodeName}') could not be found; it is skipped. If it came from the asset library, re-harvest the asset page.`,
        });
        continue;
      }
      try {
        const bytes = await node.exportAsync({ format: asset.fmt === 'jpg' ? 'JPG' : 'PNG', contentsOnly: true });
        imageAssets.push({ assetName: asset.name, bytesBase64: await bytesToBase64(bytes), ext: sniffImageExt(bytes) });
      } catch (e) {
        diagnostics.push({
          level: 'error',
          message: `Vector asset '${asset.name}' could not be rasterized as ${asset.fmt.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }

    // SVG text is needed for the .svg file and the ImageVector conversion,
    // and is always kept so the UI can preview the asset.
    const node = await resolveNode(asset.source.fuid, asset.meta?.libraryPageId, asset.meta?.localFuid);
    if (!node) {
      diagnostics.push({
        level: 'error',
        message: `Vector asset '${asset.name}' source node ('${asset.source.nodeName}') could not be found; it is skipped. If it came from the asset library, re-harvest the asset page.`,
      });
      continue;
    }
    try {
      const svg = await node.exportAsync({ format: 'SVG_STRING' });
      svgSources.set(asset.name, svg);
      vectorAssets.push({ assetName: asset.name, fmt: asset.fmt === 'imagevector' ? 'imagevector' : 'svg', content: svg });
    } catch (e) {
      diagnostics.push({
        level: 'error',
        message: `Vector asset '${asset.name}' could not be exported: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { imageAssets, vectorAssets, svgSources, diagnostics };
}

/** Assets requested by the most recent generation (filled by `convert`). */
let pendingAssets: Array<{
  name: string;
  kind: 'png' | 'svg';
  /** Resolved export format (SVG file / ImageVector code / PNG / JPG raster). */
  fmt: AssetFormat;
  /** png-kind only: keep Figma's stored bytes instead of re-rendering. */
  stored: boolean;
  source: { fuid: string; nodeName: string; fType: string };
  meta?: { imageHash?: string; libraryPageId?: string; localFuid?: string };
}> = [];

/**
 * Resolves a node that lives on another (asset) page for library-sourced
 * assets: the page is loaded first (`PageNode.loadAsync` under dynamic-page
 * document access), then the node itself is fetched by id.
 */
async function loadCrossPageAssetNode(fuid: string, pageId: string): Promise<ExportableNode | undefined> {
  try {
    const page = await figma.getNodeByIdAsync(pageId);
    if (page && typeof (page as { loadAsync?: unknown }).loadAsync === 'function') {
      await (page as unknown as { loadAsync: () => Promise<void> }).loadAsync();
    }
    const node = await figma.getNodeByIdAsync(fuid);
    return (node ?? undefined) as unknown as ExportableNode | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve instance component data up front via the async APIs.
 *
 * The manifest runs with `documentAccess: 'dynamic-page'`: reading the sync
 * `instanceNode.mainComponent` getter throws there, while
 * `getMainComponentAsync()` is the sanctioned replacement. Alongside the
 * master, the guarded cross-page reads below try the component-set parent
 * (variant grouping) and collect the instance's non-variant component
 * property values (parameters for generated components). Failures degrade
 * per field: the conversion continues with whatever was resolvable and the
 * master failure still reports a warning.
 */
/** Reports CCD parse problems once per master (instances share masters). */
function resolveConfigWarn(
  diagnostics: DiagnosticPayload[],
  warned: Set<string>,
  masterId: string,
  masterName: string,
  issues: string[],
): void {
  if (issues.length === 0 || warned.has(masterId)) return;
  warned.add(masterId);
  diagnostics.push({
    level: 'warning',
    message: `[COMPONENT-CONFIG-INVALID] Component '${masterName}': ${issues.join(' ')} (fix the block in the component description).`,
    nodeName: masterName,
    nodeKind: 'COMPONENT',
  });
}

async function resolveInstanceComponents(
  diagnostics: DiagnosticPayload[],
  configs: Map<string, ParsedComponentConfig>,
): Promise<{ components: Map<string, InstanceComponentInfo | null>; setNames: Map<string, string> }> {
  const resolved = new Map<string, InstanceComponentInfo | null>();
  const setNames = new Map<string, string>();
  const configWarned = new Set<string>();
  type InstanceLike = { id: string; name: string; mainComponent?: unknown; getMainComponentAsync?: () => Promise<ComponentNode | null>; componentProperties?: unknown };
  type NodeLike = { id: string; name: string; type: string; children?: readonly unknown[] };
  const collect = (node: NodeLike, out: InstanceLike[]): void => {
    if (node.type === 'INSTANCE') out.push(node as unknown as InstanceLike);
    const children = node.children;
    if (children) for (const child of children) collect(child as unknown as NodeLike, out);
  };
  const queued = new Set<string>();
  const pending: Promise<void>[] = [];
  /** Resolves one instance; master subtrees queue their nested instances too. */
  const resolveOne = (inst: InstanceLike): void => {
    if (queued.has(inst.id)) return;
    queued.add(inst.id);
    pending.push((async () => {
      try {
        const master = await inst.getMainComponentAsync?.();
        if (!master) {
          resolved.set(inst.id, null);
          return;
        }
        const info: InstanceComponentInfo = { name: master.name, id: master.id, set: null, props: null };
        // Component configuration description (CCD): the master's own
        // `description` may carry a `compose-studio:` block that governs
        // roles/asset policy/mapping for every instance of it.
        try {
          const rawDescription = (master as unknown as { description?: unknown }).description;
          const parsed = parseComposeConfig(typeof rawDescription === 'string' ? rawDescription : '');
          if (parsed.issues.length > 0) {
            resolveConfigWarn(diagnostics, configWarned, master.id, master.name, parsed.issues);
          }
          if (parsed.config) configs.set(master.id, parsed.config);
          // Extractor record: asset directives make the extractor drop the
          // instance's subtree (the generator renders the instance as an
          // asset instead). A mapping takes precedence in the generator —
          // the mapped call *replaces* code emission — and the mapped call
          // may still need the subtree for its @text/@icon argument sources.
          // The record therefore neutralizes the asset directives whenever a
          // mapping exists; the generator map above keeps the raw config
          // (its mapping branch wins there anyway).
          if (parsed.config) {
            info.config = parsed.config.mapping !== null
              ? { ...parsed.config, kind: null, assets: 'auto' }
              : parsed.config;
          }
        } catch {
          // Description reads are expected to stay cheap; any quirk degrades.
        }
        try {
          const parent = (master as unknown as { parent?: { type?: string; id?: string; name?: string } }).parent;
          if (parent && parent.type === 'COMPONENT_SET' && typeof parent.id === 'string' && typeof parent.name === 'string') {
            info.set = { id: parent.id, name: parent.name };
            setNames.set(parent.id, parent.name);
            // Variant sets are generated from every master, and master bodies
            // contain their own (nested) instances: pre-resolve those masters
            // here so the async extractor never touches the sync getter.
            const nested: InstanceLike[] = [];
            collect(master as unknown as NodeLike, nested);
            for (const child of nested) resolveOne(child);
          }
        } catch {
          // Cross-page relational reads are blocked in dynamic-page mode;
          // variant grouping then falls back to per-master components.
        }
        try {
          const props = inst.componentProperties as Record<string, { type?: string; value?: string | boolean }> | null;
          if (props && typeof props === 'object') {
            const mapped: Record<string, ComponentPropSnapshot> = {};
            for (const [rawKey, entry] of Object.entries(props)) {
              // VARIANT entries are covered by variantProperties separately.
              if ((entry?.type ?? '') === 'VARIANT') continue;
              if (entry.value === undefined) continue;
              const kind = entry.type;
              mapped[rawKey] = {
                kind: kind === 'BOOLEAN' || kind === 'TEXT' || kind === 'INSTANCE_SWAP' ? kind : 'OTHER',
                value: entry.value as string | boolean,
              };
            }
            info.props = mapped;
          }
        } catch {
          // Instance component properties unavailable; parameters degrade.
        }
        resolved.set(inst.id, info);
      } catch (e) {
        resolved.set(inst.id, null);
        diagnostics.push({
          level: 'warning',
          message: `Instance '${inst.name}': master component could not be resolved (${e instanceof Error ? e.message : String(e)}); the instance keeps its own name and will not match component mappings.`,
          nodeName: inst.name,
          nodeKind: 'INSTANCE',
        });
      }
    })());
  };
  const selection: InstanceLike[] = [];
  for (const node of figma.currentPage.selection) {
    collect(node as unknown as NodeLike, selection);
  }
  for (const inst of selection) resolveOne(inst);
  // Masters discovered during a batch queue further work: drain to fixpoint.
  while (pending.length > 0) {
    const batch = pending.splice(0);
    await Promise.all(batch);
  }
  return { components: resolved, setNames };
}

/**
 * Expands every component-set family in the conversion to its full master
 * list: variant masters that the selection never instantiates are extracted
 * into "virtual instance" IR nodes (component-props-less, variant props
 * parsed from the master's name) so the generator codes the whole variant
 * surface — every variant of a component in use gets a composable branch or
 * body even when only some of them appear in the selection. Uses only async
 * APIs (dynamic-page safety).
 */
async function expandComponentMasters(
  docs: IrDocument[],
  setNames: Map<string, string>,
  context: FigmaContext,
  diagnostics: DiagnosticPayload[],
  configs: Map<string, ParsedComponentConfig>,
  coveredExtra?: Map<string, Set<string>>,
): Promise<IrInstanceNode[]> {
  const covered = new Map<string, Set<string>>();
  if (coveredExtra) {
    for (const [setId, masters] of coveredExtra) covered.set(setId, new Set(masters));
  }
  const visit = (node: IrNode): void => {
    if (node.type === 'instance') {
      const setId = node.componentSet?.id ?? null;
      if (setId && setNames.has(setId)) {
        let seen = covered.get(setId);
        if (!seen) {
          seen = new Set();
          covered.set(setId, seen);
        }
        seen.add(node.componentKey);
      }
      return;
    }
    if (node.type === 'container' || node.type === 'group') {
      for (const child of node.children) visit(child);
    }
  };
  for (const doc of docs) visit(doc.root);

  const virtuals: IrInstanceNode[] = [];
  for (const [setId, seen] of covered) {
    const setName = setNames.get(setId) ?? setId;
    let setNode: unknown = null;
    try {
      // `getComponentSetByIdAsync` is not in every typings release; the same
      // async-getter contract covers the set and loads its page.
      setNode = await figma.getNodeByIdAsync(setId);
    } catch (e) {
      diagnostics.push({
        level: 'warning',
        message: `[COMPONENT-VARIANT-UNEXPANDED] Component set '${setName}' could not be loaded (${e instanceof Error ? e.message : String(e)}); only the variant masters referenced by the selection are coded.`,
        nodeName: setName,
        nodeKind: 'COMPONENT_SET',
      });
      continue;
    }
    const children = ((setNode as { children?: readonly unknown[] } | null)?.children ?? []) as unknown[];
    for (const raw of children) {
      const master = raw as { id: unknown; name: unknown; type: unknown; width?: unknown; height?: unknown };
      if (typeof master.id !== 'string' || typeof master.name !== 'string' || master.type !== 'COMPONENT') continue;
      if (seen.has(master.id)) continue;
      const props = parseVariantProps(master.name);
      if (!props) continue; // plain (non-variant) member: nothing to add
      const candidate = markCandidateOf({
        name: master.name,
        type: String(master.type),
        width: typeof master.width === 'number' ? master.width : null,
        height: typeof master.height === 'number' ? master.height : null,
      }, master.id);
      if (matchesIgnoreRules(candidate)) continue;
      // Variant masters carry their own descriptions: parse their CCD block
      // so per-variant configurations apply to the harvested branches too.
      try {
        const rawDescription = (master as unknown as { description?: unknown }).description;
        const parsed = parseComposeConfig(typeof rawDescription === 'string' ? rawDescription : '');
        if (parsed.issues.length > 0) {
          diagnostics.push({
            level: 'warning',
            message: `[COMPONENT-CONFIG-INVALID] Component '${master.name}': ${parsed.issues.join(' ')} (fix the block in the component description).`,
            nodeName: master.name,
            nodeKind: 'COMPONENT',
          });
        }
        if (parsed.config) configs.set(master.id, parsed.config);
      } catch {
        // Description reads degrade gracefully.
      }
      try {
        const mdoc = new Extractor(context).extractRoot(master as unknown as FigmaSceneNode);
        if (!mdoc || mdoc.root.type !== 'container') continue;
        const root = mdoc.root;
        const virtual: IrInstanceNode = {
          type: 'instance',
          id: root.id,
          ref: { ...root.ref, nodeName: master.name },
          index: root.index,
          parent: root.parent,
          idPath: root.idPath,
          geometry: root.geometry,
          absolute: root.absolute,
          background: root.background,
          extraBackgrounds: root.extraBackgrounds,
          border: root.border,
          radius: root.radius,
          opacity: root.opacity,
          clip: root.clip,
          effects: root.effects,
          componentName: master.name,
          componentKey: master.id,
          componentProps: null,
          componentSet: { id: setId, name: setName },
          variantProps: props,
          layout: root.layout,
          sizing: root.sizing,
          children: root.children,
        };
        virtuals.push(virtual);
        // Master content diagnostics are honest content notes (the same
        // diagnostics the generator would forward for an instance body).
        for (const d of mdoc.diagnostics) {
          diagnostics.push({
            level: d.severity.toLowerCase() as 'error' | 'warning' | 'info',
            message: `[${d.code}] ${d.reason}${d.source?.nodeName ? ` (in '${d.source.nodeName}')` : ''}`,
            nodeName: d.source?.nodeName,
            nodeKind: d.source?.fType,
          });
        }
        diagnostics.push({
          level: 'info',
          message: `[COMPONENT-VARIANT-SOURCE] Component set '${setName}': master '${master.name}' (${Object.entries(props).map(([k, v]) => `${k}=${v}`).join(', ')}) is coded from the source, not just from selection instances.`,
          nodeName: master.name,
          nodeKind: 'COMPONENT',
        });
      } catch (e) {
        diagnostics.push({
          level: 'warning',
          message: `[COMPONENT-VARIANT-MASTER] Variant master '${master.name}' of component set '${setName}' could not be extracted (${e instanceof Error ? e.message : String(e)}); its branch is rendered through the nearest reference instance as before.`,
          nodeName: master.name,
          nodeKind: 'COMPONENT',
        });
      }
    }
  }
  return virtuals;
}

/* ---------------------------------------------------------------------------
 * Design-system harvest (opt-in, `dsSource`)
 * ------------------------------------------------------------------------ */

/** VARIABLE_ALIAS values (single and typed variants) point at another variable. */
function isAliasValue(value: unknown): value is { type: string; id: string } {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { type?: unknown }).type;
  return kind === 'VARIABLE_ALIAS' || kind === 'TYPED_VARIABLE_ALIAS';
}

/**
 * Harvests the Figma design system into the DTOs `buildDesignSystem`
 * consumes: local variable collections (values resolved per mode — single-mode
 * collections at their default mode, multi-mode collections at every mode;
 * aliases are followed exactly one hop, at the same mode when the target
 * collection carries it) and local paint/text/effect styles. Everything
 * unrepresentable is recorded in `skipped` — the pure builder turns every
 * entry into a DS-* diagnostic, so nothing is silently dropped. Uses only
 * async APIs (dynamic-page safety).
 */
async function harvestDesignSystem(
  source: Exclude<PluginSettings['dsSource'], 'off'>,
): Promise<DesignSystemInput> {
  const input: DesignSystemInput = { colors: [], texts: [], numbers: [], strings: [], bools: [], skipped: [] };

  if (source === 'variables' || source === 'both') {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    const collectionById = new Map(collections.map((c) => [c.id, c]));
    const variableById = new Map(variables.map((v) => [v.id, v]));
    const modeNoted = new Set<string>();

    for (const variable of variables) {
      const collection = variable.variableCollectionId
        ? collectionById.get(variable.variableCollectionId)
        : undefined;
      if (!collection) {
        input.skipped.push({
          reason: 'skipped',
          name: variable.name,
          detail: 'variable collection is not part of the local document',
        });
        continue;
      }
      const multiMode = collection.modes.length > 1;
      // Multi-mode collections keep EVERY value: each mode becomes a nested
      // wrapper object in the design system, so same-named variables in
      // different themes coexist (`Colors.Light.Background` /
      // `Colors.Dark.Background`). One INFO note per collection, not one per
      // variable.
      if (multiMode && !modeNoted.has(collection.id)) {
        modeNoted.add(collection.id);
        input.skipped.push({
          reason: 'mode',
          name: collection.name,
          detail: `${collection.modes.length} modes split into wrapper objects (${collection.modes.map((m) => m.name).join(', ')})`,
        });
      }
      for (const mode of multiMode ? collection.modes : [null]) {
        const path = `${collection.name}/${variable.name}`;
        const modeId = mode?.modeId ?? collection.defaultModeId;
        applyVariableValue(
          input,
          variable.valuesByMode[modeId],
          path,
          collectionById,
          variableById,
          true,
          mode ? { name: mode.name, isDefault: mode.modeId === collection.defaultModeId } : undefined,
          modeId,
        );
      }
    }
  }

  if (source === 'styles' || source === 'both') {
    for (const style of await figma.getLocalPaintStylesAsync()) {
      readPaintStyle(input, style);
    }
    for (const style of await figma.getLocalTextStylesAsync()) {
      readTextStyle(input, style);
    }
    for (const style of await figma.getLocalEffectStylesAsync()) {
      input.skipped.push({
        reason: 'skipped',
        name: style.name,
        detail: 'effect styles become runtime modifiers (shadow/blur), not a design-system constant',
      });
    }
  }

  return input;
}

/** Normalizes a Figma COLOR value (RGB, alpha implied 1, or RGBA). */
function normalizeColorValue(value: unknown): DsRgba | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!['r', 'g', 'b'].every((key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]))) {
    return null;
  }
  const channels = (candidate as { r: number; g: number; b: number });
  const alpha = typeof candidate.a === 'number' && Number.isFinite(candidate.a) ? candidate.a : 1;
  return { r: channels.r, g: channels.g, b: channels.b, a: alpha };
}

/** Composed colors pair a color with a separate opacity handling. */
function isComposedColor(value: unknown): value is { color: unknown; opacity: unknown } {
  return !!value && typeof value === 'object' && 'color' in value && 'opacity' in value;
}

/** Pushes one resolved variable value (or its one-hop alias target) into the DTOs. */
function applyVariableValue(
  input: DesignSystemInput,
  value: VariableValue | undefined,
  path: string,
  collectionById: Map<string, VariableCollection>,
  variableById: Map<string, Variable>,
  allowAlias: boolean,
  group?: { name: string; isDefault: boolean },
  modeId?: string,
): void {
  const skipped = input.skipped;
  if (value === undefined) {
    // Typings label valuesByMode lookups non-optional; older documents can
    // still miss a mode entry — never silently pass.
    skipped.push({
      reason: 'skipped',
      name: path,
      detail: group ? `the \`${group.name}\` mode has no value for this variable` : 'the collection default mode has no value for this variable',
    });
    return;
  }
  if (isAliasValue(value)) {
    const aliasId = (value as { id?: unknown }).id;
    const target = typeof aliasId === 'string' ? variableById.get(aliasId) : undefined;
    if (!target) {
      skipped.push({ reason: 'alias', name: path, detail: 'aliased variable is not a local variable (published library variables are not resolvable)' });
      return;
    }
    if (!allowAlias) {
      skipped.push({ reason: 'alias', name: path, detail: 'alias chains deeper than one hop are not applied' });
      return;
    }
    const targetCollection = target.variableCollectionId ? collectionById.get(target.variableCollectionId) : undefined;
    // Theme hops stay mode-aware: resolve the target at the SAME mode when
    // its collection carries it, so `Dark/bg -> surface` keeps the dark hue.
    const targetValue = targetCollection
      ? (modeId && targetCollection.modes.some((m) => m.modeId === modeId)
        ? target.valuesByMode[modeId] ?? target.valuesByMode[targetCollection.defaultModeId]
        : target.valuesByMode[targetCollection.defaultModeId])
      : undefined;
    if (targetValue === undefined) {
      skipped.push({ reason: 'alias', name: path, detail: 'aliased variable has no value for the referenced mode' });
      return;
    }
    applyVariableValue(input, targetValue, path, collectionById, variableById, false, group, modeId);
    return;
  }
  if (isComposedColor(value)) {
    // Full fidelity needs a second hop for the inner color/opacity aliases;
    // bounded to direct (non-aliased) composed colors instead.
    if (isAliasValue(value.color) || isAliasValue(value.opacity)) {
      skipped.push({ reason: 'alias', name: path, detail: 'composed colors whose color or opacity is itself a variable alias are not applied' });
      return;
    }
    const color = normalizeColorValue(value.color);
    const opacity = typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? value.opacity : null;
    if (!color || opacity === null) {
      skipped.push({ reason: 'skipped', name: path, detail: 'composed color values have no Compose constant equivalent' });
      return;
    }
    input.colors.push({ name: path, source: 'variable', rgba: { ...color, a: color.a * opacity }, ...(group ? { group: group.name, groupDefault: group.isDefault } : {}) });
    return;
  }
  const color = normalizeColorValue(value);
  if (color) {
    input.colors.push({ name: path, source: 'variable', rgba: color, ...(group ? { group: group.name, groupDefault: group.isDefault } : {}) });
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      skipped.push({ reason: 'skipped', name: path, detail: 'numeric value is not finite' });
      return;
    }
    input.numbers.push({ name: path, source: 'variable', value, ...(group ? { group: group.name, groupDefault: group.isDefault } : {}) });
    return;
  }
  if (typeof value === 'boolean') {
    input.bools.push({ name: path, source: 'variable', value, ...(group ? { group: group.name, groupDefault: group.isDefault } : {}) });
    return;
  }
  if (typeof value === 'string') {
    input.strings.push({ name: path, source: 'variable', value, ...(group ? { group: group.name, groupDefault: group.isDefault } : {}) });
    return;
  }
  skipped.push({ reason: 'skipped', name: path, detail: 'object values have no Compose constant equivalent' });
}

/** First visible solid paint wins; otherwise the first gradient's first stop. */
function readPaintStyle(input: DesignSystemInput, style: PaintStyle): void {
  let gradient: DsRgba | null = null;
  for (const paint of style.paints) {
    if (paint.visible === false) continue;
    const opacity = Math.min(1, Math.max(0, paint.opacity ?? 1));
    if (paint.type === 'SOLID') {
      input.colors.push({ name: style.name, source: 'paint style', rgba: { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: opacity } });
      return;
    }
    if (
      paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL'
      || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND'
    ) {
      if (paint.gradientStops.length === 0 || gradient !== null) continue;
      const stops = [...paint.gradientStops].sort((a, b) => a.position - b.position);
      const first = stops[0];
      if (!first) continue;
      gradient = { r: first.color.r, g: first.color.g, b: first.color.b, a: first.color.a * opacity };
    }
  }
  if (gradient) {
    input.colors.push({ name: style.name, source: 'paint style', rgba: gradient });
    input.skipped.push({ reason: 'gradient', name: style.name, detail: 'first color stop' });
  } else {
    input.skipped.push({
      reason: 'skipped',
      name: style.name,
      detail: 'no visible solid or gradient paint (e.g. image fill, or everything hidden)',
    });
  }
}

/** A text style becomes one `TextStyle` token; percent spacings resolve to sp. */
function readTextStyle(input: DesignSystemInput, style: TextStyle): void {
  const t = style;
  const skipped = input.skipped;
  const family = t.fontName ? t.fontName.family : null;
  const fontSize = typeof t.fontSize === 'number' && Number.isFinite(t.fontSize) ? t.fontSize : null;

  let lineHeight: number | null = null;
  if (t.lineHeight.unit === 'PIXELS' && Number.isFinite(t.lineHeight.value)) {
    lineHeight = t.lineHeight.value; // documented 1 px == 1 sp
  } else if (t.lineHeight.unit === 'PERCENT') {
    lineHeight = dsPercentToSp(t.lineHeight.value, fontSize);
    if (lineHeight === null) {
      skipped.push({ reason: 'skipped', name: style.name, detail: 'line height kept as % of an unknown font size' });
    }
  }
  // AUTO stays omitted: natural line height is exactly what Compose does
  // without a `lineHeight` argument.

  let letterSpacing: number | null = null;
  if (t.letterSpacing.unit === 'PIXELS' && Number.isFinite(t.letterSpacing.value)) {
    letterSpacing = t.letterSpacing.value;
  } else if (t.letterSpacing.unit === 'PERCENT') {
    letterSpacing = dsPercentToSp(t.letterSpacing.value, fontSize);
    if (letterSpacing === null) {
      skipped.push({ reason: 'skipped', name: style.name, detail: 'letter spacing kept as % of an unknown font size' });
    }
  }

  // `fontWeight`/`textAlignHorizontal` are not on every pinned typings
  // version; read them defensively so both old and new documents work.
  const weightRaw = (t as unknown as { fontWeight?: unknown }).fontWeight;
  const align = (t as unknown as { textAlignHorizontal?: unknown }).textAlignHorizontal;
  const fontWeight = typeof weightRaw === 'number' && Number.isFinite(weightRaw) ? weightRaw : null;
  const textAlign = align === 'LEFT' || align === 'CENTER' || align === 'RIGHT' || align === 'JUSTIFIED'
    ? align
    : null;

  // Guard against styles that expose nothing at all (presentation-only or
  // older documents); everything else yields at least a FontFamily choice.
  if (family === null && fontSize === null && lineHeight === null && letterSpacing === null) {
    skipped.push({ reason: 'skipped', name: style.name, detail: 'no representable text properties' });
    return;
  }
  input.texts.push({
    name: style.name,
    source: 'text style',
    fontFamily: family,
    fontSize,
    fontWeight,
    lineHeight,
    letterSpacing,
    textAlign,
  });
}

const COMPONENT_SET_BEHAVIORS = ['component', 'frame', 'frame-of-components'] as const;

async function convert(payload: {
  mode: 'standalone' | 'existing-design-system';
  componentSetBehavior?: string;
}): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    notify('Nothing selected. Select a frame to convert.', true);
    return;
  }

  settings = await loadSettings();
  // The strip control's value at click time wins; the persisted setting is
  // the fallback (stale payloads from older UI builds, direct API calls).
  const behavior = payload.componentSetBehavior
    && (COMPONENT_SET_BEHAVIORS as readonly string[]).includes(payload.componentSetBehavior)
    ? payload.componentSetBehavior as (typeof COMPONENT_SET_BEHAVIORS)[number]
    : settings.componentSetBehavior;
  const table = await ensureTokens();

  // Dynamic-page manifest access forbids the sync `mainComponent` getter;
  // resolve master components up front through the async API instead. This
  // also collects component configuration descriptions (CCD) keyed by the
  // master component id.
  const masterDiagnostics: DiagnosticPayload[] = [];
  const componentConfigs = new Map<string, ParsedComponentConfig>();
  const { components: instanceComponents, setNames } = await resolveInstanceComponents(masterDiagnostics, componentConfigs);

  const context: FigmaContext = {
    mixedMarker: figma.mixed as unknown as symbol,
    maxNodes: 4000,
    tokenLookup: tokenLookupFor(table),
    instanceComponentLookup: (id) => instanceComponents.get(id),
    nodeMarkLookup: (candidate) => matchesIgnoreRules(candidate),
  };

  const docs: IrDocument[] = [];
  let ignoredRoots = 0;
  for (const node of selection) {
    if (node.visible === false) continue;
    if (matchesIgnoreRules(markCandidateOf(node))) {
      ignoredRoots += 1;
      continue;
    }
    const doc = new Extractor(context).extractRoot(node as unknown as FigmaSceneNode);
    if (doc) docs.push(doc);
  }

  // Component-set roots follow the shared strip choice before anything else
  // consumes the documents: `component` detaches the variant masters as the
  // component's body, `frame-of-components` swaps them for self-referencing
  // instance call sites, `frame` keeps the set canvas as-is.
  const setReshape = applyComponentSetBehavior(docs, behavior);
  docs.length = 0;
  docs.push(...setReshape.docs);

  // Detached and in-doc reshaped variant masters carry their own
  // descriptions: parse their CCD blocks so per-master configurations apply.
  for (const setNode of selection) {
    if ((setNode as { type?: string }).type !== 'COMPONENT_SET') continue;
    const application = setReshape.applied.find((a) => a.setId === (setNode as { id: string }).id);
    if (!application) continue;
    for (const raw of ((setNode as unknown as { children?: readonly unknown[] }).children ?? []) as unknown[]) {
      const master = raw as { id?: unknown; type?: unknown; description?: unknown; name?: unknown };
      if (typeof master.id !== 'string' || master.type !== 'COMPONENT') continue;
      if (!application.masterIds.includes(master.id)) continue;
      try {
        const parsed = parseComposeConfig(typeof master.description === 'string' ? master.description : '');
        if (parsed.issues.length > 0) {
          masterDiagnostics.push({
            level: 'warning',
            message: `[COMPONENT-CONFIG-INVALID] Component '${String(master.name)}': ${parsed.issues.join(' ')} (fix the block in the component description).`,
            nodeName: String(master.name),
            nodeKind: 'COMPONENT',
          });
        }
        if (parsed.config) componentConfigs.set(master.id, parsed.config);
      } catch {
        // Description reads degrade gracefully.
      }
    }
  }

  if (docs.length === 0 && setReshape.detached.length === 0) {
    notify(
      ignoredRoots > 0
        ? 'Every selected node matches an ignore rule (name prefix or marked), so nothing was converted.'
        : 'The selection contains no convertible nodes.',
      true,
    );
    return;
  }

  const packageName = settings.packageName || DEFAULT_SETTINGS.packageName;
  const profile = payload.mode === 'existing-design-system' ? profileFromSettings(settings) : null;

  // Design-system sources run BEFORE screen generation when the usage option
  // is on, so the generated screens can reference the emitted token symbols
  // instead of raw literals (Colors.CardSurface, Metrics.Padding16, …).
  let dsSourceInput: DesignSystemInput = emptyDesignSystemInput();
  let dsResult: DesignSystemResult | null = null;
  let usageResolvers: UsageResolvers | null = null;
  const wantsDs = settings.dsSource !== 'off';
  const wantsUsage = settings.dsUsage === true;
  if (wantsDs || wantsUsage) {
    try {
      const dsSource = settings.dsSource;
      if (dsSource !== 'off') dsSourceInput = await harvestDesignSystem(dsSource);
      if (wantsUsage) {
        const usage: UsageHarvest = collectUsageTokens(docs, { min: settings.dsUsageMin });
        const dsInput = mergeDesignSystemInput(dsSourceInput, usage);
        dsInput.structure = settings.dsStructure;
        dsResult = buildDesignSystem(dsInput, packageName);
        usageResolvers = buildUsageResolvers(usage, dsSourceInput, dsResult.symbols);
      } else {
        dsSourceInput.structure = settings.dsStructure;
        dsResult = buildDesignSystem(dsSourceInput, packageName);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      dsResult = {
        files: [],
        diagnostics: [{
          level: 'ERROR',
          code: 'DS-ERROR',
          message: `Design-system harvest failed (${reason}); DesignSystem.kt was not generated.`,
        }],
        symbols: new WeakMap(),
      };
      usageResolvers = null;
    }
  }

  // Variant masters of every component set in the conversion expand the
  // grouping: each set's non-instantiated masters are extracted as virtual
  // instances so all variants are coded (async, best effort per master).
  // Detached masters from set roots ride in first; their sets are pre-marked
  // covered so the expansion never harvests them twice.
  for (const notice of setReshape.notices) {
    masterDiagnostics.push({ level: notice.level, message: notice.message, nodeName: notice.nodeName, nodeKind: notice.nodeKind });
  }
  for (const d of setReshape.droppedDiagnostics) {
    masterDiagnostics.push({
      level: d.severity.toLowerCase() as 'error' | 'warning' | 'info',
      message: `[${d.code}] ${d.reason}${d.source?.nodeName ? ` (in '${d.source.nodeName}')` : ''}`,
      nodeName: d.source?.nodeName,
      nodeKind: d.source?.fType,
    });
  }
  const variantMasters: IrInstanceNode[] = [...setReshape.detached];
  try {
    variantMasters.push(...await expandComponentMasters(docs, setNames, context, masterDiagnostics, componentConfigs, setReshape.coverage));
  } catch (e) {
    masterDiagnostics.push({
      level: 'warning',
      message: `[COMPONENT-VARIANT-UNEXPANDED] Component-set variant expansion failed (${e instanceof Error ? e.message : String(e)}); only the variants instantiated in the selection are coded.`,
    });
  }

  const result = generateCode(docs, {
    packageName: packageName,
    profile,
    iconAssetPrefix: settings.iconAssetPrefix || '',
    imageAssetPrefix: settings.imageAssetPrefix || '',
    variantParamStyle: settings.variantParamStyle || 'enum',
    variantShape: settings.variantShape || 'auto',
    variantMasters,
    assetLibrary,
    assetSkipMarks,
    exportAssets: settings.exportAssets,
    vectorFormat: settings.vectorFormat,
    imageFormat: settings.imageFormat,
    // Component configuration descriptions parsed from master descriptions
    // (roles, asset kinds/policies, inline mappings).
    componentConfigs: Object.fromEntries(componentConfigs),
    // Repeated values are emitted as design-system references (opt-in).
    usage: usageResolvers,
  });
  pendingAssets = result.assets.map((a) => ({
    name: a.name,
    kind: a.kind,
    fmt: a.fmt,
    // png-kind 'auto' keeps Figma's stored bytes; a forced png/jpg re-renders.
    stored: a.kind === 'png' && (settings.imageFormat || 'auto') === 'auto',
    source: a.source,
    meta: a.meta,
  }));

  const assetExport = await resolveAssets();

  const files: OutputFilePayload[] = result.files.map((f) => ({
    path: f.path,
    content: f.content,
    language: f.language,
  }));

  // Vector assets exported as Kotlin `ImageVector` code get their vals merged
  // into one Icons.kt next to the screens; screen references use the same
  // deterministic val names, so the pair compiles together.
  const imageVectorEntries = [...assetExport.svgSources]
    .filter(([name]) => pendingAssets.find((a) => a.name === name)?.fmt === 'imagevector')
    .map(([name, svg]) => ({ assetName: name, svg }));
  if (imageVectorEntries.length > 0) {
    const icons = buildIconsFile(imageVectorEntries, packageName);
    files.push({ path: 'Icons.kt', content: icons.content, language: 'kotlin' });
    for (const per of icons.warnings) {
      if (per.warnings.length > 0) {
        assetExport.diagnostics.push({
          level: 'warning',
          message: `ImageVector '${per.assetName}' approximations: ${per.warnings.join('; ')}.`,
        });
      }
    }
  }

  // Design-system tokens (opt-in): the harvest/usage analysis already ran
  // before screen generation (so screens could resolve token references);
  // the generated `DesignSystem/*.kt` files land after the screens here.
  if (dsResult) {
    for (const dsFile of dsResult.files) {
      files.push({ path: dsFile.path, content: dsFile.content, language: 'kotlin' });
    }
  }

  const diagnostics: DiagnosticPayload[] = [
    ...result.diagnostics.map((d): DiagnosticPayload => ({
      level: d.level.toLowerCase() as 'error' | 'warning' | 'info',
      message: d.message,
      nodeName: d.nodeName,
      nodeKind: d.nodeKind,
    })),
    ...masterDiagnostics,
    ...assetExport.diagnostics,
    ...(dsResult?.diagnostics ?? []).map((d): DiagnosticPayload => ({
      level: d.level.toLowerCase() as 'error' | 'warning' | 'info',
      message: d.message,
    })),
  ];

  const conversion: ConversionResultPayload = {
    diagnostics,
    files,
    imageAssets: assetExport.imageAssets,
    vectorAssets: assetExport.vectorAssets,
    screenName: selection[0]?.name ?? 'Screen',
    appName: settings.appName,
    packageName,
  };
  postMessage({ type: 'conversion', payload: conversion });
}

/* ---------------------------------------------------------------------------
 * Message wiring
 * ------------------------------------------------------------------------ */

figma.ui.onmessage = async (raw: unknown): Promise<void> => {
  const message = raw as UiToPluginMessage;
  if (!message || typeof message.type !== 'string') return;
  try {
    switch (message.type) {
      case 'inspect-selection':
        lastSelectionSignature = '';
        postInspection();
        void postComponentConfigs();
        break;
      case 'convert-selection':
        await convert(message.payload);
        break;
      case 'update-settings':
        await saveSettings(message.payload);
        postMessage({ type: 'settings', payload: settings });
        break;
      case 'list-pages':
        postAssetSources();
        break;
      case 'mark-ignored':
        await markNodes('ignore');
        break;
      case 'unmark-ignored':
        await unmark('ignore', message.payload.id);
        break;
      case 'mark-asset-skip':
        await markNodes('asset-skip');
        break;
      case 'unmark-asset-skip':
        await unmark('asset-skip', message.payload.id);
        break;
      case 'harvest-page':
        await harvestPage(message.payload.pageId);
        break;
      case 'remove-library-entry':
        await removeLibraryEntry(message.payload.key);
        break;
      case 'set-library-fmt':
        await setLibraryFmt(message.payload.key, message.payload.fmt);
        break;
      case 'clear-library':
        await clearLibrary();
        break;
      case 'notify-figma':
        figma.notify(message.payload.message);
        break;
      case 'set-component-config':
        await writeComponentConfig(message.payload);
        break;
      case 'save-component-preset':
        await saveComponentPreset(message.payload);
        break;
      case 'delete-component-preset':
        await deleteComponentPreset(message.payload);
        break;
      default:
        break;
    }
  } catch (e) {
    notify(`Conversion failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
};

/* ---------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------ */

async function boot(): Promise<void> {
  settings = await loadSettings();
  await loadCuration();
  componentPresets = await loadComponentPresets();
  figma.showUI(uiHtml, { width: 520, height: 700, themeColors: true });
  postMessage({ type: 'settings', payload: settings });
  postInspection();
  postAssetSources();
  watchSelection();
}

void boot();
