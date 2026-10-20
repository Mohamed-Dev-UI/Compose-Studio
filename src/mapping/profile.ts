/**
 * Semantic mapping profile schema (version 1) and validation.
 *
 * A mapping profile is a versioned JSON document describing how Figma concepts
 * map onto a target project's Kotlin design system. It is validated before use
 * and never executes arbitrary user code: arguments are resolved through the
 * typed source kinds below (`text`, `icon`, `constant`, `color`, `variantProp`,
 * `content`), not arbitrary expressions.
 */

import { MAPPING_ARG_DATATYPES, isMappingArgDataType, type MappingArgDataType } from '../shared/compose-config.ts';

export type ColorMappingSource = {
  kind: 'variable' | 'hex';
  /** Figma variable name (kind: variable) or hex string like "#RRGGBB" (kind: hex). */
  name?: string;
  /** Figma variable id, when the profile uses ids. */
  variableId?: string;
};

export type FontMappingSource = {
  kind: 'family';
  name: string;
};

export type ColorMapping = {
  source: ColorMappingSource;
  /** Kotlin expression, e.g. `AppTheme.colors.primary`. */
  target: string;
};

export type FontMapping = {
  source: FontMappingSource;
  /** Kotlin expression, e.g. `FontFamily.Default` or `FontFamily.SansSerif`. */
  target: string;
};

export type TextMappingSource = {
  kind: 'fontFamily' | 'styleName';
  name: string;
  /** Optional exact font size pairing, in design px. */
  fontSize?: number;
};

export type TextMapping = {
  source: TextMappingSource;
  /** Kotlin expression, e.g. `MaterialTheme.typography.titleLarge`. */
  target: string;
};

/** Argument source kind — how a Kotlin argument obtains its value. */
export type ComponentArgumentSource =
  | { kind: 'text'; childIndex?: number }
  | { kind: 'icon'; childIndex?: number }
  | { kind: 'color' }
  /** A constant Kotlin value; `dataType` renders the literal (e.g. Long suffix, `.dp`). */
  | { kind: 'constant'; value: string; dataType?: MappingArgDataType }
  | { kind: 'variantProp'; name: string; cases?: Record<string, string> }
  /** Pass computed modifiers to the mapped composable. */
  | { kind: 'modifier' }
  /** Content lambda (trailing argument). */
  | { kind: 'content' };

export type ComponentArgumentMapping = {
  /** Kotlin parameter name of the target composable. */
  argument: string;
  source: ComponentArgumentSource;
  /** Optional default value (Kotlin expression or literal text) when the source is absent. */
  defaultValue?: string;
  /** Explicitly omit this argument when the source is absent (default: omit). */
  omitIfAbsent?: boolean;
};

export type ComponentMappingSource =
  | { kind: 'component'; componentName?: string; variableId?: string }
  | { kind: 'nodeType'; nodeType: string };

export type ComponentMapping = {
  source: ComponentMappingSource;
  target: {
    /** Kotlin composable function name. */
    symbol: string;
  };
  arguments: ComponentArgumentMapping[];
  /** Optional notes shown in the mapping editor. */
  description?: string;
};

export type MappingProfile = {
  schemaVersion: 1;
  profileName: string;
  description?: string;
  colors: ColorMapping[];
  fonts: FontMapping[];
  textStyles: TextMapping[];
  components: ComponentMapping[];
};

export type ValidationDiagnostic = {
  level: 'ERROR' | 'WARNING';
  path: string;
  message: string;
};

export type ProfileParseResult = { profile: MappingProfile | null; diagnostics: ValidationDiagnostic[] };

const NUMERIC_OR_EMPTY = /^-?\d+(\.\d+)?$/;
const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const KOTLIN_EXPRESSION_SIMPLE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*(\([^)]*\))?$/;

/** Validate and normalize a mapping profile from unknown parsed JSON. */
export function parseMappingProfile(input: unknown): ProfileParseResult {
  const diagnostics: ValidationDiagnostic[] = [];
  if (typeof input !== 'object' || input === null) {
    return { profile: null, diagnostics: [{ level: 'ERROR', path: '', message: 'Profile must be a JSON object.' }] };
  }
  const root = input as Record<string, unknown>;
  const schemaVersion = root['schemaVersion'];
  if (schemaVersion !== 1) {
    return {
      profile: null,
      diagnostics: [{ level: 'ERROR', path: 'schemaVersion', message: `Unsupported mapping profile version ${String(schemaVersion)}; expected 1.` }],
    };
  }
  const profileName = typeof root['profileName'] === 'string' ? root['profileName'] as string : 'Unnamed profile';
  if (!profileName.trim()) {
    diagnostics.push({ level: 'WARNING', path: 'profileName', message: 'Profile name is empty; using fallback.' });
  }
  const description = typeof root['description'] === 'string' ? root['description'] : undefined;

  const colors = parseArray(root['colors'], 'colors', (item, index) => parseColorMapping(item, `colors[${index}]`, diagnostics), diagnostics);
  const fonts = parseArray(root['fonts'], 'fonts', (item, index) => parseFontMapping(item, `fonts[${index}]`, diagnostics), diagnostics);
  const textStyles = parseArray(root['textStyles'], 'textStyles', (item, index) => parseTextMapping(item, `textStyles[${index}]`, diagnostics), diagnostics);
  const components = parseArray(root['components'], 'components', (item, index) => parseComponentMapping(item, `components[${index}]`, diagnostics), diagnostics);

  const profile: MappingProfile | null = {
    schemaVersion: 1,
    profileName,
    description,
    colors,
    fonts,
    textStyles,
    components,
  };
  return { profile, diagnostics };
}

function parseArray<T>(
  value: unknown,
  fieldName: string,
  parseItem: (item: unknown, index: number) => T | null,
  diagnostics: ValidationDiagnostic[],
): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push({ level: 'ERROR', path: fieldName, message: `'${fieldName}' must be an array.` });
    return [];
  }
  const out: T[] = [];
  value.forEach((item, index) => {
    const parsed = parseItem(item, index);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

function parseColorMapping(item: unknown, path: string, diagnostics: ValidationDiagnostic[]): ColorMapping | null {
  if (typeof item !== 'object' || item === null) {
    diagnostics.push({ level: 'ERROR', path, message: 'Color mapping must be an object.' });
    return null;
  }
  const o = item as Record<string, unknown>;
  const src = o['source'] as Record<string, unknown> | undefined;
  const kind = src?.['kind'];
  if (kind !== 'variable' && kind !== 'hex') {
    diagnostics.push({ level: 'ERROR', path: `${path}.source.kind`, message: `Color source kind must be 'variable' or 'hex', got: ${String(kind)}.` });
    return null;
  }
  if (kind === 'hex' && typeof src?.['name'] === 'string' && !HEX_COLOR.test(src['name'])) {
    diagnostics.push({ level: 'ERROR', path: `${path}.source.name`, message: `Invalid hex color '${String(src['name'])}'; expected '#RRGGBB' or '#AARRGGBB'.` });
    return null;
  }
  const target = o['target'];
  if (typeof target !== 'string' || target.length === 0) {
    diagnostics.push({ level: 'ERROR', path: `${path}.target`, message: 'Color mapping target must be a non-empty string.' });
    return null;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$.()'"!?]*$/.test(target)) {
    diagnostics.push({ level: 'ERROR', path: `${path}.target`, message: `Color target '${target}' contains unsupported characters for a Kotlin expression.` });
    return null;
  }
  return {
    source: {
      kind: kind as 'variable' | 'hex',
      name: typeof src?.['name'] === 'string' ? src['name'] as string : undefined,
      variableId: typeof src?.['variableId'] === 'string' ? src['variableId'] as string : undefined,
    },
    target: target as string,
  };
}

function parseFontMapping(item: unknown, path: string, diagnostics: ValidationDiagnostic[]): FontMapping | null {
  if (typeof item !== 'object' || item === null) {
    diagnostics.push({ level: 'ERROR', path, message: 'Font mapping must be an object.' });
    return null;
  }
  const o = item as Record<string, unknown>;
  const src = o['source'] as Record<string, unknown> | undefined;
  if (src?.['kind'] !== 'family' || typeof src?.['name'] !== 'string' || !src['name']) {
    diagnostics.push({ level: 'ERROR', path: `${path}.source`, message: "Font source must be { kind: 'family', name: string }." });
    return null;
  }
  const target = o['target'];
  if (typeof target !== 'string' || target.length === 0) {
    diagnostics.push({ level: 'ERROR', path: `${path}.target`, message: 'Font mapping target must be a non-empty string.' });
    return null;
  }
  return {
    source: { kind: 'family', name: src['name'] as string },
    target: target as string,
  };
}

function parseTextMapping(item: unknown, path: string, diagnostics: ValidationDiagnostic[]): TextMapping | null {
  if (typeof item !== 'object' || item === null) {
    diagnostics.push({ level: 'ERROR', path, message: 'Text mapping must be an object.' });
    return null;
  }
  const o = item as Record<string, unknown>;
  const src = o['source'] as Record<string, unknown> | undefined;
  const kind = src?.['kind'];
  if (kind !== 'fontFamily' && kind !== 'styleName') {
    diagnostics.push({ level: 'ERROR', path: `${path}.source.kind`, message: "Text mapping source kind must be 'fontFamily' or 'styleName'." });
    return null;
  }
  if (typeof src?.['name'] !== 'string' || !src['name']) {
    diagnostics.push({ level: 'ERROR', path: `${path}.source.name`, message: 'Text mapping source name must be a non-empty string.' });
    return null;
  }
  const fontSizeRaw = src?.['fontSize'];
  if (fontSizeRaw !== undefined && !(typeof fontSizeRaw === 'number' && fontSizeRaw > 0)) {
    diagnostics.push({ level: 'ERROR', path: `${path}.source.fontSize`, message: 'fontSize must be a positive number.' });
    return null;
  }
  const target = o['target'];
  if (typeof target !== 'string' || target.length === 0) {
    diagnostics.push({ level: 'ERROR', path: `${path}.target`, message: 'Text mapping target must be a non-empty string.' });
    return null;
  }
  return {
    source: {
      kind: kind as 'fontFamily' | 'styleName',
      name: src['name'] as string,
      fontSize: typeof fontSizeRaw === 'number' ? fontSizeRaw : undefined,
    },
    target: target as string,
  };
}

function parseComponentMapping(item: unknown, path: string, diagnostics: ValidationDiagnostic[]): ComponentMapping | null {
  if (typeof item !== 'object' || item === null) {
    diagnostics.push({ level: 'ERROR', path, message: 'Component mapping must be an object.' });
    return null;
  }
  const o = item as Record<string, unknown>;
  const src = o['source'] as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') {
    diagnostics.push({ level: 'ERROR', path: `${path}.source`, message: 'Component mapping source is required.' });
    return null;
  }
  const kind = src['kind'];
  if (kind === 'component') {
    const name = src['componentName'];
    const variableId = src['variableId'];
    if ((typeof name !== 'string' || !name) && (typeof variableId !== 'string' || !variableId)) {
      diagnostics.push({ level: 'ERROR', path: `${path}.source`, message: "Component source with kind 'component' needs componentName or variableId." });
      return null;
    }
  } else if (kind === 'nodeType') {
    if (typeof src['nodeType'] !== 'string' || !src['nodeType']) {
      diagnostics.push({ level: 'ERROR', path: `${path}.source.nodeType`, message: 'nodeType source must have a non-empty string.' });
      return null;
    }
  } else {
    diagnostics.push({ level: 'ERROR', path: `${path}.source.kind`, message: "Component source kind must be 'component' or 'nodeType'." });
    return null;
  }
  const target = o['target'] as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object') {
    diagnostics.push({ level: 'ERROR', path: `${path}.target`, message: 'Component mapping target is required.' });
    return null;
  }
  if (target['kind'] !== undefined && target['kind'] !== 'composable') {
    diagnostics.push({ level: 'ERROR', path: `${path}.target.kind`, message: "Only 'composable' targets are supported for now." });
    return null;
  }
  if (typeof target['symbol'] !== 'string' || !isKotlinSymbol(target['symbol'] as string)) {
    diagnostics.push({ level: 'ERROR', path: `${path}.target.symbol`, message: `Target symbol '${String(target['symbol'])}' is not a valid Kotlin identifier.` });
    return null;
  }

  const argsRaw = o['arguments'];
  const args: ComponentArgumentMapping[] = [];
  if (argsRaw !== undefined && argsRaw !== null && !Array.isArray(argsRaw)) {
    diagnostics.push({ level: 'ERROR', path: `${path}.arguments`, message: "'arguments' must be an array." });
    return null;
  }
  const argList = Array.isArray(argsRaw) ? argsRaw as unknown[] : [];
  const seenArgs = new Set<string>();
  argList.forEach((raw, idx) => {
    const parsed = parseArgumentMapping(raw, `${path}.arguments[${idx}]`, diagnostics);
    if (parsed) {
      if (seenArgs.has(parsed.argument)) {
        diagnostics.push({ level: 'ERROR', path: `${path}.arguments[${idx}].argument`, message: `Duplicate argument name '${parsed.argument}'.` });
      } else {
        seenArgs.add(parsed.argument);
        args.push(parsed);
      }
    }
  });

  return {
    source: kind === 'component'
      ? {
          kind: 'component',
          componentName: typeof src['componentName'] === 'string' ? src['componentName'] as string : undefined,
          variableId: typeof src['variableId'] === 'string' ? src['variableId'] as string : undefined,
        }
      : { kind: 'nodeType', nodeType: src['nodeType'] as string },
    target: { symbol: target['symbol'] as string },
    arguments: args,
    description: typeof o['description'] === 'string' ? o['description'] as string : undefined,
  };
}

function parseArgumentMapping(item: unknown, path: string, diagnostics: ValidationDiagnostic[]): ComponentArgumentMapping | null {
  if (typeof item !== 'object' || item === null) {
    diagnostics.push({ level: 'ERROR', path, message: 'Argument mapping must be an object.' });
    return null;
  }
  const o = item as Record<string, unknown>;
  if (typeof o['argument'] !== 'string' || !o['argument']) {
    diagnostics.push({ level: 'ERROR', path: `${path}.argument`, message: 'Argument name must be a non-empty string.' });
    return null;
  }
  const src = o['source'] as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') {
    diagnostics.push({ level: 'ERROR', path: `${path}.source`, message: 'Argument source is required.' });
    return null;
  }
  let source: ComponentArgumentSource;
  switch (src['kind']) {
    case 'text':
      if (src['childIndex'] !== undefined && !(typeof src['childIndex'] === 'number' && src['childIndex'] >= 0)) {
        diagnostics.push({ level: 'ERROR', path: `${path}.source.childIndex`, message: 'childIndex must be a non-negative number.' });
        return null;
      }
      source = { kind: 'text', childIndex: typeof src['childIndex'] === 'number' ? src['childIndex'] : 0 };
      break;
    case 'icon':
      if (src['childIndex'] !== undefined && !(typeof src['childIndex'] === 'number' && src['childIndex'] >= 0)) {
        diagnostics.push({ level: 'ERROR', path: `${path}.source.childIndex`, message: 'childIndex must be a non-negative number.' });
        return null;
      }
      source = { kind: 'icon', childIndex: typeof src['childIndex'] === 'number' ? src['childIndex'] : 0 };
      break;
    case 'color':
      source = { kind: 'color' };
      break;
    case 'constant': {
      if (typeof src['value'] !== 'string') {
        diagnostics.push({ level: 'ERROR', path: `${path}.source.value`, message: "Constant source requires a string 'value'." });
        return null;
      }
      const rawDataType = src['dataType'];
      if (rawDataType === undefined) {
        source = { kind: 'constant', value: src['value'] as string };
        break;
      }
      if (typeof rawDataType === 'string' && isMappingArgDataType(rawDataType)) {
        source = { kind: 'constant', value: src['value'] as string, dataType: rawDataType };
      } else {
        diagnostics.push({
          level: 'ERROR',
          path: `${path}.source.dataType`,
          message: `Constant source dataType must be one of ${MAPPING_ARG_DATATYPES.join(', ')}.`,
        });
        return null;
      }
      break;
    }
    case 'variantProp':
      if (typeof src['name'] !== 'string' || !src['name']) {
        diagnostics.push({ level: 'ERROR', path: `${path}.source.name`, message: "variantProp source requires a 'name'." });
        return null;
      }
      source = { kind: 'variantProp', name: src['name'] as string, cases: normalizeCases(src['cases']) };
      break;
    case 'modifier':
      source = { kind: 'modifier' };
      break;
    case 'content':
      source = { kind: 'content' };
      break;
    default:
      diagnostics.push({ level: 'ERROR', path: `${path}.source.kind`, message: `Unsupported argument source kind: '${String(src['kind'])}'.` });
      return null;
  }
  return {
    argument: o['argument'] as string,
    source,
    defaultValue: typeof o['defaultValue'] === 'string' ? o['defaultValue'] as string : undefined,
    omitIfAbsent: o['omitIfAbsent'] === true,
  };
}

function normalizeCases(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function isKotlinSymbol(symbol: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)
    && !NUMERIC_OR_EMPTY.test(symbol)
    && KOTLIN_EXPRESSION_SIMPLE.test(symbol);
}

/** Default empty profile. */
export function emptyProfile(): MappingProfile {
  return { schemaVersion: 1, profileName: 'Default', colors: [], fonts: [], textStyles: [], components: [] };
}
