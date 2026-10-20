/**
 * Asset registry: deterministic naming and dedupe for exported assets
 * (image fills, vector icons) referenced by generated Kotlin/resource files.
 *
 * Each asset kind can be gated by a name prefix (icons: SVG vectors, images:
 * PNG fills); kinds gate independently and an empty prefix means
 * auto-detect that kind. On top of the prefix filter, two curated layers
 * exist: the user's asset-skip marks (layout stays, no asset) and the
 * asset-library entries harvested from the designer's asset pages (their
 * canonical source wins even against an unfavourable prefix).
 */
import type { SourceRef } from '../ir/ir.ts';
import type { AssetFormat, AssetFormatOverride, LibraryAsset, NodeMark } from '../shared/marks.ts';
import { matchesMark } from '../shared/marks.ts';
import { snakeCase } from '../util/identifiers.ts';

export type AssetKind = 'svg' | 'png';

/** Global export-format configuration (plugin settings). */
export type ExportFormats = {
  /** `false` excludes every asset candidate (layout-only geometry). */
  exportAssets: boolean;
  /** Format for vector-source (svg-kind) assets. */
  vectorFormat: 'svg' | 'imagevector' | 'png';
  /** Format for image-fill (png-kind) assets: stored bytes or a re-render. */
  imageFormat: 'auto' | 'png' | 'jpg';
};

const DEFAULT_FORMATS: ExportFormats = { exportAssets: true, vectorFormat: 'svg', imageFormat: 'auto' };

/**
 * Resolves the effective export format for one asset: a curated entry's
 * per-entry `fmt` override wins when it is valid for the source kind;
 * otherwise the kind's global format applies (auto -> stored png/jpg bytes
 * for image fills, svg files for vectors).
 */
export function resolveAssetFormat(kind: AssetKind, entry: LibraryAsset | null, formats: ExportFormats): AssetFormat {
  const override = entry?.fmt as AssetFormatOverride | undefined;
  if (override && override !== 'auto') {
    // A raster source cannot become SVG/ImageVector code; ignore such a
    // malformed override defensively (the settings UI never produces it).
    const valid = kind === 'svg' || override === 'png' || override === 'jpg';
    if (valid) return override;
  }
  return kind === 'png' ? (formats.imageFormat === 'auto' ? 'png' : formats.imageFormat) : formats.vectorFormat;
}

export type AssetMeta = {
  /** For PNG assets: the Figma image hash to resolve bytes via `figma.getImageByHash`. */
  imageHash?: string;
  /** Library assets only: the source page id (loaded before cross-page export). */
  libraryPageId?: string;
  /** Library assets only: the locally matched node id (export fallback). */
  localFuid?: string;
};

/** Extra candidate facts `add()` uses for curated-library / skip matching. */
export type AssetCandidateExtra = {
  /** Candidate geometry (precision for library + skip matching). */
  size?: { width: number | null; height: number | null };
  /** For INSTANCE nodes: the master component key (exact library match). */
  masterId?: string | null;
  /**
   * Component-configuration-directed candidates (`kind:` / `assets: export` in
   * the component description): skip marks and the curated library still
   * apply, but the per-kind name prefix no longer rejects the candidate.
   */
  force?: boolean;
};

export type Asset = {
  /** Registry key: nodeId for vectors, nodeId for images (deduped per node). */
  key: string;
  /** Deterministic resource name (e.g. `ic_arrow_back`). */
  name: string;
  kind: AssetKind;
  /** Resolved export format (SVG file / ImageVector code / PNG / JPG raster). */
  fmt: AssetFormat;
  source: SourceRef;
  meta?: AssetMeta;
};

export type AssetPrefixes = { image?: string | null; icon?: string | null };

export class AssetRegistry {
  private readonly assets = new Map<string, Asset>();
  private readonly usedNames = new Set<string>();
  /** Per-kind name prefixes ('image' gates PNG assets, 'icon' gates SVG assets). */
  private readonly prefixes: { image: string | null; icon: string | null };
  /** Global export formats (asset gate + per-kind formats). */
  private readonly formats: ExportFormats;
  /** Curated asset-page entries (matched by name+type+size or masterId). */
  private readonly libraryByName = new Map<string, LibraryAsset>();
  private readonly libraryByMaster = new Map<string, LibraryAsset>();
  /** User-marked asset skips (layout stays, asset export doesn't). */
  private skipMarks: NodeMark[] = [];
  /** Reason of the latest rejection inside `add()` (for diagnostics). */
  rejectionReason: string | null = null;

  constructor(prefixes?: AssetPrefixes, formats?: Partial<ExportFormats>) {
    const trim = (v?: string | null): string | null => {
      const t = (v ?? '').trim();
      return t ? t : null;
    };
    this.prefixes = { image: trim(prefixes?.image), icon: trim(prefixes?.icon) };
    this.formats = { ...DEFAULT_FORMATS, ...formats };
  }

  /**
   * Pre-loads curated asset-library entries (from the designer's asset
   * pages). Library entries win over the name-prefix filter: a node that
   * matches one exports *the canonical curated asset* even if its own name
   * fails the prefix, because the designer explicitly curated it.
   */
  seedLibrary(entries: LibraryAsset[]): void {
    this.libraryByName.clear();
    this.libraryByMaster.clear();
    for (const entry of entries) {
      if (entry.masterId) {
        const mKey = `${entry.kind}:${entry.masterId}`;
        if (!this.libraryByMaster.has(mKey)) this.libraryByMaster.set(mKey, entry);
        continue;
      }
      const nKey = `${entry.kind}:${entry.fType}:${entry.nodeName.trim().toLowerCase()}`;
      if (!this.libraryByName.has(nKey)) this.libraryByName.set(nKey, entry);
    }
  }

  /** Pre-loads the user's asset-skip marks (checked before the prefix). */
  seedAssetSkips(marks: NodeMark[]): void {
    this.skipMarks = [...marks];
  }

  /** The prefix in effect for a kind (null = auto-detect); used in diagnostics text. */
  activePrefix(kind: AssetKind): string | null {
    return kind === 'png' ? this.prefixes.image : this.prefixes.icon;
  }

/** Human-readable reason behind the most recent `add()` rejection (`null` if none recorded). */
  exclusionReason(): string {
    return this.rejectionReason ?? 'the name does not match the configured asset prefixes (see plugin settings)';
  }

  /**
   * Register an asset; returns the deterministic resource name, or `null`
   * when the source is excluded. Exclusion order (first hit wins):
   * user-marked asset skips -> curated library match (wins even against an
   * unfavourable prefix) -> the kind's name prefix. With a configured
   * prefix, only nodes whose name starts with it (case-insensitively)
   * become assets — other names are treated as plain decoration and callers
   * report `ASSET-EXCLUDED` (see `rejectionReason` for the exact cause of
   * the latest rejection). Matching library assets register the canonical
   * source node on the asset page (cross-page exports load that page first
   * and fall back to the locally matched node).
   */
  add(kind: AssetKind, source: SourceRef, preferHint?: string | null, meta?: AssetMeta, extra?: AssetCandidateExtra): string | null {
    this.rejectionReason = null;
    const hint = (preferHint && preferHint.trim() ? preferHint : source.nodeName) || 'asset';
    const size = extra?.size ?? null;
    const masterId = extra?.masterId ?? null;

    // 0. Global asset export gate (plugin settings): every candidate is
    // excluded and the caller keeps bare layout geometry.
    if (!this.formats.exportAssets) {
      this.rejectionReason = 'asset export is disabled in the plugin settings';
      return null;
    }

    // 1. User-marked asset skips: keep layout, no asset export.
    if (
      this.skipMarks.some((m) =>
        matchesMark(m, { name: hint, fType: source.fType, width: size?.width ?? null, height: size?.height ?? null, masterId }),
      )
    ) {
      this.rejectionReason = `it is on the asset-skip list (marked in the plugin settings)`;
      return null;
    }

    // 2. Curated library assets: the canonical entry wins over the prefix.
    const library = this.libraryEntryFor(kind, hint, source.fType, size, masterId);
    if (library) {
      const key = `lib:${library.key}`;
      const existing = this.assets.get(key);
      if (existing) {
        if (meta && !existing.meta?.imageHash) existing.meta = { ...existing.meta, imageHash: meta.imageHash ?? existing.meta?.imageHash };
        return existing.name; // entry.key, no stripping/prefixing
      }
      const asset: Asset = {
        key,
        name: library.key,
        kind,
        fmt: resolveAssetFormat(kind, library, this.formats),
        source: { fuid: library.fuid, nodeName: library.nodeName, fType: library.fType },
        meta: {
          ...(library.imageHash ? { imageHash: library.imageHash } : meta?.imageHash ? { imageHash: meta.imageHash } : {}),
          libraryPageId: library.pageId,
          localFuid: source.fuid,
        },
      };
      this.assets.set(key, asset);
      return library.key;
    }

    // 3. Per-kind prefix filter (auto-detect when unset). Forced candidates
    //    (component-configuration directed) skip the prefix gate only.
    const prefix = this.activePrefix(kind);
    const prefixLower = prefix?.toLowerCase() ?? null;
    if (prefixLower !== null && !hint.toLowerCase().startsWith(prefixLower) && extra?.force !== true) {
      this.rejectionReason = `the name does not match the configured ${kind === 'png' ? 'image' : 'icon'} asset prefix '${prefix}'`;
      return null;
    }
    let base = hint;
    if (prefix !== null) {
      const stripped = base.slice(prefix.length).trim();
      if (stripped) base = stripped;
    }
    const key = kind === 'png' ? `img:${source.fuid}` : `svg:${source.fuid}`;
    const existing = this.assets.get(key);
    if (existing) {
      if (meta && !existing.meta) existing.meta = meta;
      return existing.name;
    }
    const usedNames = this.usedNames;
    let name = snakeCase(`${kind === 'png' ? 'img' : 'ic'}_${base}`);
    // dedupe
    let n = 1;
    while (usedNames.has(name)) {
      n += 1;
      name = snakeCase(`${kind === 'png' ? 'img' : 'ic'}_${base}_${n}`);
    }
    usedNames.add(name);
    const asset: Asset = { key, name, kind, fmt: resolveAssetFormat(kind, null, this.formats), source, ...(meta ? { meta } : {}) };
    this.assets.set(key, asset);
    return name;
  }

  /** The resolved export format of a registered resource name (`null` if unknown). */
  formatOf(name: string): AssetFormat | null {
    for (const asset of this.assets.values()) {
      if (asset.name === name) return asset.fmt;
    }
    return null;
  }

  /**
   * Library-only lookup for nodes that are not asset candidates by nature
   * (e.g. component instances): returns the canonical library asset name
   * only when the candidate matches a curated entry (master identity first,
   * then name + type). Unlike `add()`, this never falls back to auto-detect
   * name rules, so ordinary instances stay byte-for-byte identical to the
   * previous behavior.
   */
  libraryMatch(kind: AssetKind, source: SourceRef, extra?: AssetCandidateExtra): string | null {
    const entry = this.libraryEntryFor(kind, source.nodeName, source.fType, extra?.size ?? null, extra?.masterId ?? null);
    return entry ? entry.key : null;
  }

  private libraryEntryFor(kind: AssetKind, name: string, fType: string, size: { width: number | null; height: number | null } | null, masterId: string | null): LibraryAsset | null {
    if (masterId) {
      const byMaster = this.libraryByMaster.get(`${kind}:${masterId}`);
      if (byMaster) return byMaster;
    }
    const byName = this.libraryByName.get(`${kind}:${fType}:${name.trim().toLowerCase()}`);
    if (byName) return byName;
    // Size-agnostic fallback for frame-kind name matches with different sizes
    // is NOT applied on purpose: a same-named node with other dimensions is
    // a different asset (rare but kept exact, mirroring the ignore marks).
    void size;
    return null;
  }

  list(): Asset[] {
    return [...this.assets.values()].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  }

  size(): number {
    return this.assets.size;
  }
}
