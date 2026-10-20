// Shared types between the plugin code (sandbox) and the plugin UI (iframe).

import type { AssetFormatOverride, LibraryAsset, NodeMark } from './marks.ts';
import type { ParsedComponentConfig } from './compose-config.ts';

/** Message sent from the plugin (main thread) to the UI iframe. */
export type PluginToUiMessage =
  /** Answer to `ui->plugin 'convert-selection'`. */
  | {
      type: 'conversion';
      payload: ConversionResultPayload;
    }
  /** Answer to `ui->plugin 'inspect-selection'`. */
  | {
      type: 'inspection';
      payload: InspectionPayload;
    }
  /**
   * Component configuration descriptions for the current selection (async
   * after `inspection`): per-master parsed config + the format vocabulary
   * the editor needs, including the copy-paste template and saved presets.
   */
  | {
      type: 'component-configs';
      payload: ComponentConfigsPayload;
    }
  /** The saved component-configuration presets (after save/delete; no editor re-render). */
  | {
      type: 'component-presets';
      payload: { presets: ComponentConfigPreset[] };
    }
  /** Settings snapshot at startup and after updates. */
  | {
      type: 'settings';
      payload: PluginSettings;
    }
  /** Answer to `ui->plugin 'list-pages'` and `'harvest-page'`. */
  | {
      type: 'asset-sources';
      payload: AssetSourcesPayload;
    }
  /** Small informational messages (errors, notices). */
  | {
      type: 'notify';
      payload: { message: string; isError?: boolean };
    };

export type UiToPluginMessage =
  | { type: 'inspect-selection' }
  | { type: 'convert-selection'; payload: ConvertSelectionPayload }
  | { type: 'update-settings'; payload: PluginSettings }
  | { type: 'list-pages' }
  | { type: 'mark-ignored' }
  | { type: 'unmark-ignored'; payload: { id: string } }
  | { type: 'mark-asset-skip' }
  | { type: 'unmark-asset-skip'; payload: { id: string } }
  | { type: 'harvest-page'; payload: { pageId: string | null } }
  | { type: 'remove-library-entry'; payload: { key: string } }

  /** Sets (or clears with `'auto'`) the per-entry export-format override. */
  | { type: 'set-library-fmt'; payload: { key: string; fmt: AssetFormatOverride } }
  | { type: 'clear-library' }
  | { type: 'notify-figma'; payload: { message: string } }
  /**
   * Writes the configuration description of one component master. Payload:
   * `config` = the visual editor's parsed values (normalized by the plugin),
   * `yaml` = raw block text from the advanced editor (kept verbatim so
   * comments survive), or `remove` strips the block and keeps prose. The
   * plugin re-reads and re-posts `component-configs` afterwards.
   */
  | {
      type: 'set-component-config';
      payload: { masterId: string; config?: unknown; yaml?: string; remove?: boolean };
    }
  /** Saves a named configuration preset (client storage; replaces same-name entries). */
  | { type: 'save-component-preset'; payload: { name: string; config: unknown } }
  /** Deletes a saved configuration preset by name. */
  | { type: 'delete-component-preset'; payload: { name: string } }
  | { type: 'close-plugin' };

/** Current pages + curated marks + asset library, sent after any of them change. */
export type AssetSourcesPayload = {
  /** Document pages for the harvest dropdown (id + name, current flagged). */
  pages: PageSummary[];
  /** User ignore marks (without the name prefix rule, which is a setting). */
  ignoreMarks: NodeMark[];
  /** User asset-skip marks (layout kept, asset export skipped). */
  assetSkipMarks: NodeMark[];
  /** Curated assets harvested from asset pages. */
  library: LibraryAsset[];
};

export type PageSummary = {
  id: string;
  name: string;
  current: boolean;
};

export type ConvertSelectionPayload = {
  mode: 'standalone' | 'existing-design-system';
};

/** Settings persisted in Figma client storage. */
export type PluginSettings = {
  appName: string;
  packageName: string;
  /** Mapping from Figma font family names to Compose font family names. */
  fontFamilyMap: Record<string, string>;
  /** Mapping from figma solid colors (`#RRGGBB`/`#AARRGGBB`) to Compose expressions. */
  colorMap: Record<string, string>;
  /** Mapping from figma color variable names to Compose expressions. */
  colorMapNames: Record<string, string>;
  /** Mapping from figma text style names to Compose expressions. */
  textStyleMap: Record<string, string>;
  /** Mapping from figma spacing-ish values (in px) to Compose expressions. */
  spacingMap?: Record<string, string>;
  /**
   * When non-empty, only vector nodes whose name starts with this prefix
   * (case-insensitive, e.g. `ic_`) are exported as SVG icon assets; other
   * names are treated as decoration. Empty string = auto-detect.
   */
  iconAssetPrefix: string;
  /**
   * Same as `iconAssetPrefix`, but gates PNG image fills into
   * `drawable-nodpi` resources (e.g. `img_`).
   */
  imageAssetPrefix: string;
  /**
   * When non-empty, nodes whose name starts with this prefix
   * (case-insensitive) — and their whole subtrees — are ignored in every
   * conversion: no IR, no layout, no assets. Empty string = no prefix rule.
   */
  ignorePrefix: string;
  /** Component mappings (Figma component name -> Compose composable). */
  componentMap: Record<string, string>;
  /**
   * How auto-generated components declare variant parameters: `enum`
   * (default), `sealed`, or plain `string` (legacy).
   */
  variantParamStyle: 'enum' | 'sealed' | 'string';
  /**
   * How multi-variant component bodies are structured: `auto` picks per
   * component (near-identical variants -> shared value parameters, large
   * differences -> one composable per variant, otherwise a `when`),
   * `when` keeps the classic parameterized `when`, and `functions` /
   * `object` emit one composable per variant (top-level or inside an
   * `object <Name>`).
   */
  variantShape: 'auto' | 'when' | 'functions' | 'object';
  /**
   * Export assets at all? `true` (default) follows the prefixes/library;
   * `false` excludes every asset candidate (`ASSET-EXCLUDED`, layout kept).
   */
  exportAssets: boolean;
  /**
   * Export format for vector-source assets (icons/shapes): an SVG file in
   * the ZIP's `vectors/` folder, Kotlin `ImageVector` code (compiled into
   * the app, no runtime file), or a PNG raster in `drawable-nodpi`.
   */
  vectorFormat: 'svg' | 'imagevector' | 'png';
  /**
   * Export format for image-fill assets: `auto` keeps Figma's stored bytes
   * (byte-identical, extension reflects the real format), `png`/`jpg`
   * re-render the node to force a specific format.
   */
  imageFormat: 'auto' | 'png' | 'jpg';
  /**
   * Generate a `DesignSystem.kt` of flat Compose constants from the Figma
   * design system? `off` (default) skips generation entirely; `variables`
   * reads local variable collections, `styles` reads local paint/text
   * styles, and `both` merges both sources into one file.
   */
  dsSource: 'off' | 'variables' | 'styles' | 'both';
  /**
   * Output structure of `DesignSystem.kt`: `object` (default) wraps every
   * token family in a `DesignSystem` accessor with section objects;
   * `material` adds name-matched Material 3 `AppColorScheme`/`AppTypography`;
   * `material-theme` additionally emits a `DesignSystemTheme` composable.
   */
  dsStructure: 'object' | 'material' | 'material-theme';
  /**
   * Derive design-system tokens from values that repeat across the converted
   * frames, even when nothing is bound to Figma variables/styles: colors,
   * spacing values, radii, borders, fixed sizes and text styles recurring at
   * least `dsUsageMin` times become named tokens (`CardSurface`,
   * `Padding16`, `TitleLarge`, —), and the generated screens reference them
   * in the roles the values were used in instead of emitting raw literals.
   */
  dsUsage: boolean;
  /**
   * Minimum occurrences for a repeated value to become a usage-derived
   * token (2..99; baked into the exported conversion report).
   */
  dsUsageMin: number;
};

export type ConversionResultPayload = {
  diagnostics: DiagnosticPayload[];
  files: OutputFilePayload[];
  /** Assets that need to be exported as bytes (images). Resolved by plugin to bytes via `exportAsync`. */
  imageAssets: ExportedImageAssetPayload[];
  /** Text (SVG) assets that are ready to write into files. */
  vectorAssets: ExportedVectorAssetPayload[];
  screenName: string;
  appName: string;
  packageName: string;
};

export type DiagnosticPayload = {
  level: 'error' | 'warning' | 'info';
  message: string;
  /** Name of the source node the diagnostic refers to (best effort). */
  nodeName?: string;
  /** Kind of the node the diagnostic refers to. */
  nodeKind?: string;
};

export type OutputFilePayload = {
  /** Destination path of the file inside the exported structure. */
  path: string;
  /** Text content of the file (kotlin / json / xml / etc.). */
  content: string;
  /** Language hint used by the preview panel. */
  language: 'kotlin' | 'json' | 'xml';
};

export type ExportedImageAssetPayload = {
  /** Stable asset id (used for naming in the generated Kotlin). */
  assetName: string;
  /** Byte content as base64 (UI turns it back to bytes for the ZIP). */
  bytesBase64: string;
  /**
   * Real file extension for the ZIP (`png`/`jpg` — matches the actual
   * bytes: re-rendered rasters export in their chosen format, stored
   * bytes keep the format Figma saved when the image was imported).
   */
  ext: 'png' | 'jpg';
};

export type ExportedVectorAssetPayload = {
  assetName: string;
  /**
   * What this asset was exported as: `'svg'` ships the SVG source to the
   * ZIP's `vectors/` folder; `'imagevector'` compiles it into the generated
   * `Icons.kt` (no file). Either way `content` carries the SVG source so
   * the UI can preview the asset.
   */
  fmt: 'svg' | 'imagevector';
  content: string;
};

export type InspectionPayload = {
  selectedNodes: SelectedNodeInfo[];
};

export type SelectedNodeInfo = {
  id: string;
  name: string;
  kind: string;
  /** True when this node can be converted. */
  convertable: boolean;
};

/** One component master whose description carries (or could carry) a configuration block. */
export type ComponentConfigInfo = {
  /** Master component id (the write-back target). */
  masterId: string;
  /** Master name, e.g. `Variants/Button/Primary`. */
  masterName: string;
  /** Selection node names that resolve to this master. */
  nodeNames: string[];
  /** True when the description carries a `compose-studio:` block. */
  hasConfig: boolean;
  /** Human one-liner of the parsed config (empty when not configured). */
  summary: string;
  /** Description prose above the block (kept when the block is rewritten). */
  prose: string;
  /** The block content below the marker line, or `null` when not configured. */
  blockText: string | null;
  /** The parsed configuration (null when the master carries no readable block). */
  config: ParsedComponentConfig | null;
  /** Parse problems (unknown keys, invalid values); empty when fine. */
  issues: string[];
};

/** A named, reusable component configuration (persisted in client storage). */
export type ComponentConfigPreset = {
  /** Unique preset name (1..48 chars after trim). */
  name: string;
  /** The configuration values. */
  config: ParsedComponentConfig;
};

export type ComponentConfigsPayload = {
  /** Configuration format version the plugin understands. */
  version: number;
  /** Copy-paste template (the full `compose-studio:` block). */
  template: string;
  /** Saved presets (also posted alone via `component-presets`). */
  presets: ComponentConfigPreset[];
  /** Current selection's masters. */
  masters: ComponentConfigInfo[];
};
