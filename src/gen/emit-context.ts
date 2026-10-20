/**
 * Shared emission context + helpers for node emitters.
 *
 * `EmitCtx` describes where a node is emitted: its indent level, the layout
 * kind of its parent, whether it is the root call of a composable (which
 * changes the modifier base from `Modifier` to the incoming `modifier`
 * parameter) and the parent's cross alignment.
 */
import type { IrColor, SourceRef } from '../ir/ir.ts';
import type { MappingProfile } from '../mapping/profile.ts';
import { argbLiteral, argbLiteralToHexString } from '../util/format.ts';
import { AssetRegistry } from './assets.ts';
import type { KotlinFile } from './kotlin-writer.ts';
import type { ColorResolver } from './expr.ts';
import { colorKeyOf } from './usage.ts';
import type { DpTokenResolver, TextStyleTokenResolver, UsageResolvers } from './usage.ts';
import type { ModifierHelpers } from './build-modifiers.ts';

export type EmitCtx = {
  indent: number;
  parent: 'row' | 'column' | 'box' | null;
  isRoot: boolean;
  crossAlign: string | null;
};

export type EmitEnv = {
  file: KotlinFile;
  packageName: string;
  /** Never null: callers pass an empty profile when none is configured. */
  profile: MappingProfile;
  assetRegistry: AssetRegistry;
  diag: (level: 'INFO' | 'WARNING' | 'ERROR', code: string, message: string, ref: SourceRef | null, feature?: string) => void;
  useImport: (path: string) => void;
  colorExpr: ColorResolver;
  /** Slot-aware design-system `Dp` tokens (usage-derived values); optional. */
  dpExpr?: DpTokenResolver;
  /** Inline `TextStyle` -> design-system typography token; optional. */
  textExpr?: TextStyleTokenResolver;
};

/** Normalize a hex color key (`#RRGGBB` or `#AARRGGBB`) to canonical `RRGGBBAA`. */
function normalizeHexKey(hex: string): string {
  const raw = hex.trim().replace(/^#/, '').toUpperCase();
  return raw.length === 8 ? raw : `FF${raw.padStart(6, '0')}`;
}

/**
 * Build the color resolver implementing the documented precedence:
 * variable id -> variable name -> hex value -> repeated-value design-system
 * token (usage-derived) -> `Color(0xAARRGGBB)` literal.
 */
export function makeColorExpr(profile: MappingProfile, usage?: UsageResolvers | null): ColorResolver {
  return (color: IrColor): string => {
    const argb = argbLiteral(color.rgba);
    if (color.tokenRef) {
      const ref = color.tokenRef;
      if (ref.variableId) {
        const byId = profile.colors.find((m) => m.source.kind === 'variable' && m.source.variableId === ref.variableId);
        if (byId) return byId.target;
      }
      if (ref.variableName) {
        const byName = profile.colors.find((m) => m.source.kind === 'variable' && m.source.name === ref.variableName);
        if (byName) return byName.target;
      }
    }
    const hexKey = normalizeHexKey(argbLiteralToHexString(argb));
    const byHex = profile.colors.find(
      (m) => m.source.kind === 'hex' && m.source.name && normalizeHexKey(m.source.name) === hexKey,
    );
    if (byHex) return byHex.target;
    const usageExpr = usage?.colors.get(colorKeyOf(color.rgba));
    if (usageExpr) return usageExpr;
    return `Color(${argb})`;
  };
}

/** Wrap a color resolver so `Color(...)` literals carry their import. */
export function colorExprWithImport(raw: ColorResolver, useImport: (path: string) => void): ColorResolver {
  return (color: IrColor): string => {
    const expr = raw(color);
    if (expr.startsWith('Color(')) useImport('androidx.compose.ui.graphics.Color');
    return expr;
  };
}

export function modifierHelpers(env: EmitEnv): ModifierHelpers {
  return {
    useImport: (path) => env.useImport(path),
    colorExpr: env.colorExpr,
    dpExpr: env.dpExpr ?? null,
    assetRegistry: env.assetRegistry,
    diag: (level, code, message, ref) => env.diag(level, code, message, ref),
  };
}

/** Child emission context: one level deeper, parent kind set, root false. */
export function childCtx(parent: EmitCtx, kind: 'row' | 'column' | 'box', crossAlign: string | null): EmitCtx {
  return { indent: parent.indent + 1, parent: kind, isRoot: false, crossAlign };
}
