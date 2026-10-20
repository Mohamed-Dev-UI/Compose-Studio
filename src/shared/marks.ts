/**
 * User-curated marks shared between the plugin sandbox, the extractor and
 * the generator: ignore rules (skip a node + subtree entirely) and asset
 * skips (keep the layout, export no asset). Everything here is pure data +
 * matching logic with no `figma` or Kotlin dependency, so the generator can
 * use it in Node tests like every other pipeline stage.
 *
 * Matching precision: entries carry the node name, node type and — when the
 * user marked a concrete node — its size, so an unrelated node that merely
 * shares the name does not match by accident. Entries that capture a
 * component identity (a COMPONENT master or an INSTANCE) additionally carry
 * `masterId`, which matches by exact component identity (no name collision
 * risk at all).
 */

/** A user mark: "this exact-looking thing is ignored / skipped". */
export type NodeMark = {
  /** Deterministic identity of the mark itself (also used for removal). */
  id: string;
  /** Node name at marking time (e.g. "Status Bar - iPhone 15"). */
  name: string;
  /** Figma node type at marking time (FRAME, INSTANCE, COMPONENT, …). */
  fType: string;
  /** Node size at marking time; `null` when the node had no geometry. */
  width: number | null;
  height: number | null;
  /** For COMPONENT/INSTANCE marks: the master component id (exact match). */
  masterId: string | null;
};

/** One curated asset from the designer's asset page ("asset library"). */
export type LibraryAsset = {
  /** Canonical, unique resource name base (e.g. `icon_star`). */
  key: string;
  kind: 'svg' | 'png';
  /** The source node on the asset page (the canonical export source). */
  fuid: string;
  /** The source page id; exports load it first (`PageNode.loadAsync`). */
  pageId: string;
  /** Source node name/type (display + diagnostics). */
  nodeName: string;
  fType: string;
  /** Source geometry, used for matching screen nodes to this entry. */
  width: number | null;
  height: number | null;
  /** For COMPONENT sources: matches instances by master identity. */
  masterId: string | null;
  /** For PNG sources: the Figma image hash of the fill. */
  imageHash: string | null;
  /**
   * Per-entry export-format override. `'auto'` (or absent) follows the
   * kind's global format; SVG/ImageVector/PNG/JPG pin the export for this
   * entry alone (CSV-compatible with every other library consumer).
   */
  fmt?: AssetFormatOverride;
};

/**
 * Export formats a generated asset can take. Source kinds map onto them:
 * vector sources (`svg`) can become an SVG file, Kotlin `ImageVector`
 * code, or a PNG/JPG raster; image-fill sources (`png`) are rasters and
 * pick PNG/JPG (or keep Figma's stored bytes).
 */
export type AssetFormat = 'svg' | 'imagevector' | 'png' | 'jpg';

/** Per-library-entry format override; `'auto'` (or absent) follows the global kind format. */
export type AssetFormatOverride = 'auto' | AssetFormat;

/** Facts a candidate node exposes for matching (no Figma types needed). */
export type MarkCandidate = {
  name: string;
  fType: string;
  width: number | null;
  height: number | null;
  masterId: string | null;
};

const NAME_TOLERANCE = 0.75; // px; < 1 keeps sub-pixel rounding from breaking matches

/** Deterministic dedupe/removal id for a mark. */
export function markId(name: string, fType: string, masterId: string | null, width: number | null, height: number | null): string {
  return [masterId ?? '', fType, name, width == null ? '' : round2(width), height == null ? '' : round2(height)].join('|');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function sizesMatch(mark: { width: number | null; height: number | null }, c: MarkCandidate): boolean {
  if (mark.width == null || mark.height == null || c.width == null || c.height == null) return true;
  return Math.abs(mark.width - c.width) <= NAME_TOLERANCE && Math.abs(mark.height - c.height) <= NAME_TOLERANCE;
}

/**
 * True when a mark covers the candidate. Component marks (masterId set)
 * only match candidates that carry the same master id — a component mark is
 * an identity statement, not a name pattern. Plain name marks require name
 * + type equality, plus the size match when both sides know it.
 */
export function matchesMark(mark: NodeMark, c: MarkCandidate): boolean {
  if (mark.masterId != null) return c.masterId != null && mark.masterId === c.masterId;
  // Name-only mark (plain nodes, or an instance whose master was not
  // resolvable at marking time): match by name + type + known sizes.
  if (mark.name.trim().toLowerCase() !== c.name.trim().toLowerCase()) return false;
  if ((mark.fType || 'FRAME').toLowerCase() !== (c.fType || 'FRAME').toLowerCase()) return false;
  return sizesMatch(mark, c);
}

/**
 * True when a curated library asset covers the candidate: exact master
 * identity first, then name + type + size. The candidate's kind must be
 * compatible (`svg` for vector-ish nodes, `png` for nodes with image fills)
 * and is validated by the caller.
 */
export function matchesLibraryAsset(entry: LibraryAsset, c: MarkCandidate): boolean {
  if (entry.masterId != null) return c.masterId != null && entry.masterId === c.masterId;
  if (entry.key == null || !entry.nodeName) return false;
  return (
    entry.nodeName.trim().toLowerCase() === c.name.trim().toLowerCase() &&
    entry.fType === c.fType &&
    sizesMatch({ width: entry.width, height: entry.height }, c)
  );
}

/** True when the candidate name starts with the prefix (case-insensitive). */
export function matchesIgnorePrefix(prefix: string, c: MarkCandidate): boolean {
  const p = (prefix ?? '').trim().toLowerCase();
  if (!p) return false;
  return c.name.trim().toLowerCase().startsWith(p);
}
