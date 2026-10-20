/**
 * Mapping resolution: turning a mapping profile + a design node into Kotlin
 * expression strings. Documented precedence order:
 *
 * Color mapping: variableId exact -> variable name exact -> hex exact -> null
 * (the generator then falls back to `Color(0xxxxxxxxx)`).
 *
 * Font mapping: family name exact -> null.
 *
 * Text style mapping: (fontFamily+fontSize) exact -> fontFamily -> null.
 *
 * Component mapping: component id exact -> component name exact -> nodeName
 * exact -> nodeType -> null (the generator then emits default Compose code).
 */

import type { ComponentMapping, ComponentArgumentMapping, MappingProfile } from './profile.ts';

export function resolveColorMapping(
  profile: MappingProfile,
  ref: { variableId?: string | null; variableName?: string | null; hex?: string | null },
): { target: string; precedence: 'variableId' | 'variableName' | 'hex' } | null {
  if (ref.variableId) {
    const hit = profile.colors.find((m) => m.source.kind === 'variable' && m.source.variableId === ref.variableId);
    if (hit) return { target: hit.target, precedence: 'variableId' };
  }
  if (ref.variableName) {
    const hit = profile.colors.find((m) => m.source.kind === 'variable' && (m.source.name ?? '') === ref.variableName);
    if (hit) return { target: hit.target, precedence: 'variableName' };
  }
  if (ref.hex) {
    const hit = profile.colors.find((m) => m.source.kind === 'hex' && m.source.name?.trim().toLowerCase() === ref.hex!.trim().toLowerCase());
    if (hit) return { target: hit.target, precedence: 'hex' };
  }
  return null;
}

export function resolveFontMapping(profile: MappingProfile, family: string | null): { target: string } | null {
  if (!family) return null;
  const hit = profile.fonts.find((m) => m.source.name === family);
  if (hit) return { target: hit.target };
  return null;
}

export function resolveTextMapping(
  profile: MappingProfile,
  ref: { fontFamily: string | null; fontSize: number | null },
): { target: string } | null {
  if (ref.fontFamily != null && ref.fontSize != null) {
    const hit = profile.textStyles.find((m) => m.source.kind === 'fontFamily' && m.source.name === ref.fontFamily && m.source.fontSize === ref.fontSize);
    if (hit) return { target: hit.target };
  }
  if (ref.fontFamily != null) {
    const hit = profile.textStyles.find((m) => m.source.kind === 'fontFamily' && m.source.name === ref.fontFamily);
    if (hit) return { target: hit.target };
  }
  return null;
}

/** Find the component mapping for an instance or node. */
export function resolveComponentMapping(
  profile: MappingProfile,
  ref: { componentKey?: string | null; componentName?: string | null; nodeName?: string | null; nodeType?: string | null },
): ComponentMapping | null {
  if (ref.componentKey) {
    const exact = profile.components.find(
      (m) => m.source.kind === 'component' && m.source.variableId === ref.componentKey,
    );
    if (exact) return exact;
  }
  if (ref.componentName) {
    const byName = profile.components.find(
      (m) => m.source.kind === 'component' && (m.source.componentName ?? '').toLowerCase() === ref.componentName!.toLowerCase(),
    );
    if (byName) return byName;
  }
  if (ref.nodeType) {
    const byType = profile.components.find(
      (m) => m.source.kind === 'nodeType' && (m.source.nodeType === ref.nodeType || (m.source.nodeType === 'text' && ref.nodeType === 'text')),
    );
    if (byType) return byType;
  }
  return null;
}

/** Check a mapping against a verification fixture. Returns a small report. */
export function verifyComponentMapping(
  mapping: ComponentMapping,
  sample: { texts: string[]; iconCount: number },
): { problems: string[]; previewArguments: Array<[string, string]> } {
  const problems: string[] = [];
  const preview: Array<[string, string]> = [];
  let contentSeen = false;
  for (const arg of mapping.arguments) {
    if (arg.source.kind === 'content') {
      if (contentSeen) problems.push('Multiple content arguments; only the last one is emitted as a trailing lambda.');
      contentSeen = true;
      preview.push([arg.argument, 'content']);
      continue;
    }
    if (arg.source.kind === 'text') {
      const idx = arg.source.childIndex ?? 0;
      if (sample.texts.length === 0) problems.push(`text source for '${arg.argument}' has no text child available in the sample.`);
      else if (idx >= sample.texts.length) problems.push(`text source index ${idx} is out of range for the sample (has ${sample.texts.length} text child/children).`);
      preview.push([arg.argument, sample.texts[idx] ?? '']);
      continue;
    }
    if (arg.source.kind === 'icon') {
      const idx = arg.source.childIndex ?? 0;
      if (idx >= sample.iconCount) problems.push(`icon source index ${idx} is out of range for the sample (has ${sample.iconCount} icon child/children).`);
      preview.push([arg.argument, `R.drawable.ic_res_${idx}`]);
      continue;
    }
    if (arg.source.kind === 'color') {
      preview.push([arg.argument, 'Color(0xFF000000)']);
      continue;
    }
    if (arg.source.kind === 'constant') {
      preview.push([arg.argument, `"${arg.source.value}"`]);
      continue;
    }
    if (arg.source.kind === 'variantProp') {
      preview.push([arg.argument, `${arg.source.name}=…`]);
      continue;
    }
    if (arg.source.kind === 'modifier') {
      preview.push([arg.argument, 'Modifier']);
      continue;
    }
  }
  const duplicate = new Set<string>();
  for (const [name] of preview) {
    if (duplicate.has(name)) problems.push(`Duplicate argument name '${name}'.`);
    duplicate.add(name);
  }
  return { problems, previewArguments: preview };
}

/** Convenience: quick preview summary of a mapping. */
export function mappingSummary(mapping: ComponentMapping): string {
  const source = mapping.source.kind === 'component'
    ? `component '${mapping.source.componentName ?? mapping.source.variableId ?? ''}'`
    : `node type '${mapping.source.nodeType}'`;
  const args = mapping.arguments.map((a: ComponentArgumentMapping) => `${a.argument}:${a.source.kind}`).join(', ');
  return `${source} -> ${mapping.target.symbol}(${args})`;
}
