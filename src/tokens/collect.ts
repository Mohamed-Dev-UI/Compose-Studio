/**
 * Design-token collection (Phase 3 subset).
 *
 * Walks Figma's local variable collections and variables and builds a token
 * table used to resolve variable bindings during extraction. This module uses
 * the plugin-global `figma` API and is therefore only used inside the plugin
 * sandbox (main.ts); tests use the token table directly.
 */

export type TokenValue =
  | { kind: 'COLOR'; rgba: { r: number; g: number; b: number; a: number } }
  | { kind: 'FLOAT'; value: number }
  | { kind: 'STRING'; value: string }
  | { kind: 'BOOLEAN'; value: boolean };

export type TokenMode = { modeId: string; name: string };

export type TokenVariable = {
  id: string;
  /** Full Figma variable name, e.g. "Primary/900". */
  name: string;
  collection: string;
  modes: TokenMode[];
  defaultModeId: string;
  resolvedType: 'BOOLEAN' | 'FLOAT' | 'COLOR' | 'STRING';
  /** values keyed by mode id. */
  valuesByMode: Record<string, TokenValue | { alias: string }>;
  description: string;
};

export type TokenCollection = {
  id: string;
  name: string;
  modes: TokenMode[];
  defaultModeId: string;
};

export type TokenTable = {
  collections: TokenCollection[];
  variables: TokenVariable[];
  byId: Map<string, TokenVariable>;
};

/** Reduced structural typing for the variable API this module consumes. */
type FigmaVariablesApi = {
  getLocalVariableCollectionsAsync?: () => Promise<Array<{
    id: string; name: string; modes: TokenMode[]; defaultModeId: string;
  }>>;
  getLocalVariablesAsync?: () => Promise<Array<{
    id: string; name: string; resolvedType: TokenVariable['resolvedType']; description: string;
    variableCollectionId: string;
    valuesByMode: Record<string, TokenValue | { type: 'VARIABLE_ALIAS'; id: string }>;
    scopes?: string[];
  }>>;
};

/** Collect the design-token table from Figma variables. Never throws. */
export async function collectTokens(variablesApi: FigmaVariablesApi): Promise<TokenTable> {
  const collections: TokenCollection[] = [];
  const variables: TokenVariable[] = [];
  try {
    const cols = (await variablesApi.getLocalVariableCollectionsAsync?.()) ?? [];
    for (const c of cols) {
      collections.push({ id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId });
    }
    const vars = (await variablesApi.getLocalVariablesAsync?.()) ?? [];
    const colById = new Map(collections.map((c) => [c.id, c]));
    for (const v of vars) {
      const col = colById.get(v.variableCollectionId);
      const valuesByMode: Record<string, TokenValue | { alias: string }> = {};
      for (const [modeId, raw] of Object.entries(v.valuesByMode ?? {})) {
        valuesByMode[modeId] = normalizeTokenValue(raw);
      }
      variables.push({
        id: v.id,
        name: v.name,
        collection: col?.name ?? '',
        modes: col?.modes ?? [],
        defaultModeId: col?.defaultModeId ?? (col?.modes[0]?.modeId ?? ''),
        resolvedType: v.resolvedType,
        valuesByMode,
        description: v.description ?? '',
      });
    }
  } catch (e) {
    // Token collection is best-effort; conversion continues without tokens.
    console.warn('Token collection failed:', e);
  }
  return { collections, variables, byId: new Map(variables.map((v) => [v.id, v])) };
}

function normalizeTokenValue(
  raw: TokenValue | { type: 'VARIABLE_ALIAS'; id: string } | undefined,
): TokenValue | { alias: string } {
  if (!raw) return { kind: 'FLOAT', value: 0 };
  if (typeof raw === 'object' && raw !== null) {
    if ('type' in raw && raw.type === 'VARIABLE_ALIAS') {
      const alias = raw as { type: 'VARIABLE_ALIAS'; id: string };
      return { alias: alias.id };
    }
    const v = raw as TokenValue;
    if (v.kind === 'COLOR') return v;
    if (v.kind === 'FLOAT') return v;
    if (v.kind === 'BOOLEAN') return v;
    if (v.kind === 'STRING') return v;
  }
  return { kind: 'FLOAT', value: 0 };
}

/**
 * Resolve a color variable's concrete value for the preferred mode.
 * Follows alias chains, guarded against cycles.
 */
export function resolveTokenColor(
  table: TokenTable,
  variableId: string,
  preferredModeId?: string,
): { rgba: { r: number; g: number; b: number; a: number }; modeId: string; modeName: string | null } | null {
  let currentId = variableId;
  for (let depth = 0; depth < 8; depth += 1) {
    const variable = table.byId.get(currentId);
    if (!variable) return null;
    const preferred = preferredModeId ? variable.valuesByMode[preferredModeId] : undefined;
    const raw = preferred ?? firstColorValue(variable);
    if (!raw) return null;
    if ('alias' in raw) {
      currentId = raw.alias;
      continue;
    }
    if (raw.kind !== 'COLOR') return null;
    const useModeId = modeIdOfValue(variable, raw, preferredModeId);
    const modeName = variable.modes.find((m) => m.modeId === useModeId)?.name ?? null;
    return { rgba: raw.rgba, modeId: useModeId, modeName };
  }
  return null;
}

/** Mode id whose value is identical (by reference) to `val`. */
function modeIdOfValue(v: TokenVariable, val: TokenValue, preferredModeId?: string): string {
  for (const [modeId, raw] of Object.entries(v.valuesByMode)) {
    if (raw === val) {
      if (preferredModeId && modeId === preferredModeId) return preferredModeId;
      return modeId;
    }
  }
  return v.defaultModeId;
}

/** First COLOR value found in the variable (any mode). */
function firstColorValue(v: TokenVariable): TokenValue | null {
  for (const val of Object.values(v.valuesByMode)) {
    if (val && 'kind' in val && val.kind === 'COLOR') return val;
  }
  return null;
}

/** Build a lookup function for the extractor. */
export function tokenLookupFor(table: TokenTable): (variableId: string) => {
  id: string; name: string; collection: string;
  defaultModeId: string | null; defaultModeName: string | null;
  value: { kind: 'COLOR'; rgba: { r: number; g: number; b: number; a: number } } | null;
  aliasedVariableId: string | null;
} | undefined {
  return (variableId: string) => {
    const v = table.byId.get(variableId);
    if (!v) return undefined;
    const resolvedColor = resolveTokenColor(table, variableId);
    return {
      id: v.id,
      name: v.name,
      collection: v.collection,
      defaultModeId: resolvedColor?.modeId ?? null,
      defaultModeName: resolvedColor?.modeName ?? null,
      value: resolvedColor ? { kind: 'COLOR', rgba: resolvedColor.rgba } : null,
      aliasedVariableId: null,
    };
  };
}
