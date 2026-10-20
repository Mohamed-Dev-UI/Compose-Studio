/**
 * Component configuration descriptions (CCD).
 *
 * A Figma component may carry a machine-readable configuration block inside
 * its own `description` field that tells Compose Studio how to treat the
 * component: which **role** it plays (button, card, slider, ... — mints the
 * role's parameters and, when the Figma look can be matched exactly, a
 * Material implementation), which **asset kind** its instances count as
 * (icon/image/vector — no name prefix needed), an **asset policy** (export
 * the component as an asset instead of code / never an asset), an inline
 * **component mapping** (an app composable) and a human **note**.
 *
 * The block format is deliberately a tiny subset of YAML: one marker line
 * `compose-studio:` followed by flat `key: value` lines, where lines starting
 * with `#` are comments. Figma descriptions are free text, so the block lives
 * after any designer prose; the prose is preserved when the plugin rewrites
 * the block (the plugin-UI configuration editor).
 *
 * Everything here is pure (no `figma` global) so the plugin sandbox, the
 * generator and unit tests can share it.
 */

import { pascalCase, safeIdentifier } from '../util/identifiers.ts';

export const COMPOSE_CONFIG_TAG = 'compose-studio';
/** Marker line that starts the configuration block (must be alone on a line). */
export const COMPOSE_CONFIG_MARKER = `${COMPOSE_CONFIG_TAG}:`;
export const COMPOSE_CONFIG_VERSION = 1;

/** Asset policy for a component's instances. */
export type ComposeAssetPolicy = 'auto' | 'export' | 'code';
/** Explicit asset-kind qualification (replaces the name-prefix heuristic). */
export type ComposeAssetKind = 'icon' | 'image' | 'vector';
/** `auto` = Material implementation when the look can be matched; `custom` = always the plain emission. */
export type ComposeImplementation = 'auto' | 'custom';

/**
 * Component roles. A role mints role-specific parameters on the generated
 * composable; `card`/`button`/`fab` can additionally be emitted through
 * their Material 3 composable when the design's look can be reproduced
 * exactly (see docs/generation.md). Unknown roles are reported and ignored.
 */
export type ComposeRole =
  | 'button'
  | 'card'
  | 'fab'
  | 'slider'
  | 'switch'
  | 'checkbox'
  | 'chip'
  | 'input'
  | 'progress'
  | 'badge'
  | 'avatar'
  | 'divider'
  | 'listitem';

export const COMPOSE_ROLES: readonly ComposeRole[] = [
  'button', 'card', 'fab', 'slider', 'switch', 'checkbox', 'chip',
  'input', 'progress', 'badge', 'avatar', 'divider', 'listitem',
];

export const COMPOSE_ASSET_KINDS: readonly ComposeAssetKind[] = ['icon', 'image', 'vector'];
export const COMPOSE_ASSET_POLICIES: readonly ComposeAssetPolicy[] = ['auto', 'export', 'code'];
export const COMPOSE_IMPLEMENTATIONS: readonly ComposeImplementation[] = ['auto', 'custom'];

/** One minted role parameter (`param: Type = def`). */
export type RoleParameter = {
  /** Kotlin parameter name as it appears in the generated composable. */
  param: string;
  /** Kotlin type expression. */
  type: string;
  /** Kotlin default expression; handler defaults are no-op placeholders the app overrides. */
  def: string;
};

/**
 * Role -> the parameters the generated composable gains. Handlers such as
 * `onClick` carry inert defaults so generated call sites stay unchanged;
 * app code overrides them where behavior is wanted (documented in
 * docs/generation.md).
 */
export const ROLE_PARAMETERS: Record<ComposeRole, readonly RoleParameter[]> = {
  button: [
    { param: 'onClick', type: '() -> Unit', def: '{ }' },
    { param: 'enabled', type: 'Boolean', def: 'true' },
  ],
  card: [{ param: 'onClick', type: '() -> Unit', def: '{ }' }],
  fab: [{ param: 'onClick', type: '() -> Unit', def: '{ }' }],
  slider: [
    { param: 'value', type: 'Float', def: '0f' },
    { param: 'onValueChange', type: '(Float) -> Unit', def: '{ }' },
    { param: 'enabled', type: 'Boolean', def: 'true' },
  ],
  switch: [
    { param: 'checked', type: 'Boolean', def: 'false' },
    { param: 'onCheckedChange', type: '(Boolean) -> Unit', def: '{ }' },
  ],
  checkbox: [
    { param: 'checked', type: 'Boolean', def: 'false' },
    { param: 'onCheckedChange', type: '(Boolean) -> Unit', def: '{ }' },
  ],
  chip: [
    { param: 'onClick', type: '() -> Unit', def: '{ }' },
    { param: 'selected', type: 'Boolean', def: 'false' },
  ],
  input: [
    { param: 'value', type: 'String', def: '""' },
    { param: 'onValueChange', type: '(String) -> Unit', def: '{ }' },
    { param: 'enabled', type: 'Boolean', def: 'true' },
  ],
  progress: [{ param: 'progress', type: 'Float', def: '0f' }],
  badge: [],
  avatar: [],
  divider: [],
  listitem: [{ param: 'onClick', type: '() -> Unit', def: '{ }' }],
};

/** Roles whose generated **body** gets the click behavior wired in (ripple-free clickable). */
export const WIRED_ROLES: readonly ComposeRole[] = ['card', 'button', 'fab', 'listitem'];
/** Roles with a dedicated Material 3 implementation (when the look can be matched exactly). */
export const MATERIAL_ROLES: readonly ComposeRole[] = ['card', 'button', 'fab'];

/** Human label per role (UI hints + diagnostics). */
export const ROLE_LABELS: Record<ComposeRole, string> = {
  button: 'Button',
  card: 'Card',
  fab: 'Floating action button',
  slider: 'Slider',
  switch: 'Switch',
  checkbox: 'Checkbox',
  chip: 'Chip',
  input: 'Text input',
  progress: 'Progress indicator',
  badge: 'Badge',
  avatar: 'Avatar',
  divider: 'Divider',
  listitem: 'List item',
};

/** Short explanation per role (UI hints + diagnostics). */
export const ROLE_NOTES: Record<ComposeRole, string> = {
  button: 'mints `onClick` + `enabled`; Material `Button` when the look matches, else a ripple-free clickable custom emission',
  card: 'mints `onClick`; Material `Card` when the look matches (solid fill, no border/shadow), else a ripple-free clickable custom emission',
  fab: 'mints `onClick`; Material `FloatingActionButton` for circular solid fills, else a ripple-free clickable custom emission',
  slider: 'mints `value`/`onValueChange`/`enabled` (visual layout stays the custom emission)',
  switch: 'mints `checked`/`onCheckedChange` (visual layout stays the custom emission)',
  checkbox: 'mints `checked`/`onCheckedChange` (visual layout stays the custom emission)',
  chip: 'mints `onClick`/`selected` (visual layout stays the custom emission)',
  input: 'mints `value`/`onValueChange`/`enabled` (visual layout stays the custom emission)',
  progress: 'mints `progress` (visual layout stays the custom emission)',
  badge: 'no parameters; a badge is visual only',
  avatar: 'no parameters; an avatar is visual only',
  divider: 'no parameters; a divider is visual only',
  listitem: 'mints `onClick`; the custom emission becomes ripple-free clickable',
};

/** Explicit Kotlin literal types a constant mapping argument can carry. */
export const MAPPING_ARG_DATATYPES = [
  'int', 'long', 'float', 'double', 'boolean', 'string', 'char', 'dp', 'sp', 'color', 'object',
] as const;

export type MappingArgDataType = (typeof MAPPING_ARG_DATATYPES)[number];

export function isMappingArgDataType(value: unknown): value is MappingArgDataType {
  return (MAPPING_ARG_DATATYPES as readonly string[]).includes(value as string);
}

/** One mapping argument value: a special source, or a (typed) constant. */
export type MappingArgSource =
  | { kind: 'text' | 'icon' | 'color' | 'content' | 'modifier' }
  | { kind: 'constant'; value: string; dataType?: MappingArgDataType };

export type ParsedComponentMappingArg = {
  /** Kotlin parameter name of the target composable. */
  argument: string;
  source: MappingArgSource;
};

/** A parsed configuration block (tolerant parse; `issues` needs a human). */
export type ParsedComponentConfig = {
  tag: string;
  version: number;
  role: ComposeRole | null;
  kind: ComposeAssetKind | null;
  assets: ComposeAssetPolicy;
  implementation: ComposeImplementation;
  /** Inline component mapping: the app composable symbol instances call. */
  mapping: string | null;
  /** Typed/constant arguments for the mapping target. */
  mappingArgs: ParsedComponentMappingArg[];
  /** Human note, copied into the generated file as a comment. */
  note: string | null;
};

export type ComposeConfigParseResult = {
  /** Description content before the block (designer prose), trimmed. */
  prose: string;
  /** The parsed block, or `null` when the description carries no configuration. */
  config: ParsedComponentConfig | null;
  /** Human-readable problems found during parsing (tolerant — unknown keys and values do not abort). */
  issues: string[];
};

const SPECIAL_ARG_KINDS = ['text', 'icon', 'color', 'content', 'modifier'] as const;
type SpecialArgKind = (typeof SPECIAL_ARG_KINDS)[number];

/** Full qualification (`my.pkg.MyButton`) or a simple symbol. */
const KOTLIN_SYMBOL_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

function isRole(value: string): value is ComposeRole {
  return (COMPOSE_ROLES as readonly string[]).includes(value);
}

function isKind(value: string): value is ComposeAssetKind {
  return (COMPOSE_ASSET_KINDS as readonly string[]).includes(value);
}

function isPolicy(value: string): ComposeAssetPolicy | null {
  return (COMPOSE_ASSET_POLICIES as readonly string[]).includes(value) ? (value as ComposeAssetPolicy) : null;
}

function isImplementation(value: string): value is ComposeImplementation {
  return (COMPOSE_IMPLEMENTATIONS as readonly string[]).includes(value);
}

/** Unquotes a value when it is wrapped in single/double quotes. */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Splits `a=1, b="x, y"` on commas that sit outside quotes. */
function splitTop(str: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Typed constant literal validation: returns an issue (downgrade reason) or
 * `null` when the value fits the datatype. Values stay as typed by the user
 * (rendering to Kotlin literals happens at generation).
 */
function typedLiteralIssue(dataType: MappingArgDataType, value: string): string | null {
  const number = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
  switch (dataType) {
    case 'int':
    case 'long':
      return /^[+-]?\d+$/.test(value) ? null : "expects a whole number (e.g. a Kotlin Int/Long literal)";
    case 'float':
    case 'double':
    case 'dp':
    case 'sp':
      return number.test(value) ? null : "expects a number (e.g. 0.5)";
    case 'boolean':
      return value === 'true' || value === 'false' ? null : "expects true or false";
    case 'char':
      return [...value].length === 1 ? null : "expects exactly one character";
    case 'color': {
      const hex = value.startsWith('#') ? value.slice(1) : value;
      return /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex) ? null : "expects a hex color (#RRGGBB or #AARRGGBB)";
    }
    case 'string':
      return value.length > 0 ? null : "expects the string content (empty strings need the \"\" form)";
    case 'object':
      return value.trim().length > 0 ? null : "expects a Kotlin expression (e.g. TextStyle.Default)";
  }
}

/**
 * Parses one `mappingArgs` value: a comma-separated list of `arg=value`
 * entries where values are design sources (`@text`/`@icon`/`@color`/
 * `@content`/`@modifier`), typed constants (`int:42` / `long:1` / `float:0.5` /
 * `double:0.5` / `boolean:true` / `string:label` / `char:a` / `dp:16` /
 * `sp:14` / `color:8080FF` / `object:TextStyle.Default` — the `@type:value`
 * spelling is accepted too, and payload quoting protects commas), or untyped
 * Kotlin constants (`"quoted"` / `true` / `42` / any Kotlin expression) which
 * remain valid for older blocks.
 */
export function parseMappingArgs(value: string): { args: ParsedComponentMappingArg[]; issues: string[] } {
  const args: ParsedComponentMappingArg[] = [];
  const issues: string[] = [];
  for (const raw of splitTop(value)) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      issues.push(`mappingArgs entry '${raw}' is not argument=value form; skipped`);
      continue;
    }
    const argument = unquote(raw.slice(0, eq));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) {
      issues.push(`mappingArgs argument name '${argument}' is not a Kotlin identifier; skipped`);
      continue;
    }
    const { source, issue } = mappingArgSource(argument, raw.slice(eq + 1).trim());
    if (issue) issues.push(issue);
    args.push({ argument, source });
  }
  return { args, issues };
}

/** Typed constant (`type:value` / `@type:value`), possibly downgraded with a note. */
function typedArgSource(
  argument: string,
  dataType: MappingArgDataType,
  payload: string,
): { source: MappingArgSource; issue?: string } {
  const value = unquote(payload);
  const problem = typedLiteralIssue(dataType, value);
  if (problem === null) return { source: { kind: 'constant', value, dataType } };
  return {
    source: { kind: 'constant', value },
    issue: `mappingArgs value for '${argument}' is not valid for @${dataType} (${problem}); treated as a plain constant`,
  };
}

/** Resolves the source half of one `=`-split entry. */
function mappingArgSource(argument: string, valueText: string): { source: MappingArgSource; issue?: string } {
  if (valueText.startsWith('@')) {
    const rest = valueText.slice(1);
    const colon = rest.indexOf(':');
    const token = (colon >= 0 ? rest.slice(0, colon) : rest).toLowerCase();
    // Bare design sources never carry values; a colon payload means typed.
    if (colon < 0 && (SPECIAL_ARG_KINDS as readonly string[]).includes(token)) {
      return { source: { kind: token as SpecialArgKind } };
    }
    if (colon >= 0 && isMappingArgDataType(token)) {
      return typedArgSource(argument, token, rest.slice(colon + 1));
    }
    return {
      source: { kind: 'constant', value: unquote(valueText) },
      issue: `unknown mapping source '${valueText}'; treated as a constant (sources: @text/@icon/@color/@content/@modifier; typed values: int:42, float:0.5, dp:16, object:Expr, …)`,
    };
  }
  // Bare form: `type:value` when the head token names a datatype, else a
  // plain untyped constant (legacy blocks keep working).
  const colon = valueText.indexOf(':');
  const head = colon >= 0 ? valueText.slice(0, colon).toLowerCase() : null;
  if (head !== null && isMappingArgDataType(head)) {
    return typedArgSource(argument, head, valueText.slice(colon + 1));
  }
  return { source: { kind: 'constant', value: unquote(valueText) } };
}

/**
 * Parses a component description into `{ prose, config, issues }`. The block
 * runs from the first `compose-studio:` marker line (alone on its own line)
 * to the end of the description; anything before it is prose. Keys are flat
 * `key: value`; lines starting with `#` are comments. Unknown/invalid values
 * are reported via `issues` and skip that key only — the parse stays
 * tolerant, and other keys still apply.
 */
export function parseComposeConfig(description: string): ComposeConfigParseResult {
  const issues: string[] = [];
  if (typeof description !== 'string' || description.trim() === '') {
    return { prose: '', config: null, issues };
  }

  const lines = description.split(/\r?\n/);
  const markerIndex = lines.findIndex((l) => l.trim() === COMPOSE_CONFIG_MARKER);
  if (markerIndex < 0) {
    if (lines.some((l) => l.trim().startsWith(COMPOSE_CONFIG_MARKER))) {
      issues.push(`'${COMPOSE_CONFIG_MARKER}' must sit alone on its line to start the block; block not read`);
    }
    return { prose: description.trim(), config: null, issues };
  }

  const prose = lines.slice(0, markerIndex).join('\n').trim();
  const config: ParsedComponentConfig = {
    tag: COMPOSE_CONFIG_TAG,
    version: COMPOSE_CONFIG_VERSION,
    role: null,
    kind: null,
    assets: 'auto',
    implementation: 'auto',
    mapping: null,
    mappingArgs: [],
    note: null,
  };
  let sawKey = false;

  for (const rawLine of lines.slice(markerIndex + 1)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === COMPOSE_CONFIG_MARKER) continue; // duplicated marker inside the block: harmless
    const colon = line.indexOf(':');
    if (colon <= 0) {
      issues.push(`block line '${line}' is not key: value; skipped`);
      continue;
    }
    const key = unquote(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();
    sawKey = true;
    switch (key) {
      case COMPOSE_CONFIG_TAG:
        break;
      case 'version': {
        const v = Number.parseInt(unquote(value), 10);
        if (!Number.isFinite(v)) {
          issues.push(`version value '${value}' is not a number; ignored`);
          break;
        }
        if (v !== COMPOSE_CONFIG_VERSION) {
          issues.push(`configuration version ${v} is newer than this plugin (expects ${COMPOSE_CONFIG_VERSION}); parsed anyway`);
        }
        config.version = v;
        break;
      }
      case 'role': {
        const r = unquote(value);
        if (r === '') {
          config.role = null;
          break;
        }
        if (isRole(r)) config.role = r;
        else issues.push(`unknown role '${r}'; known roles: ${COMPOSE_ROLES.join(', ')}`);
        break;
      }
      case 'kind': {
        const k = unquote(value);
        if (k === '') {
          config.kind = null;
          break;
        }
        if (isKind(k)) config.kind = k;
        else issues.push(`unknown kind '${k}'; known kinds: ${COMPOSE_ASSET_KINDS.join(', ')}`);
        break;
      }
      case 'assets': {
        const p = isPolicy(unquote(value));
        if (p) config.assets = p;
        else issues.push(`unknown assets policy '${value}'; known policies: ${COMPOSE_ASSET_POLICIES.join(', ')}`);
        break;
      }
      case 'implementation': {
        const imp = unquote(value);
        if (imp === '') {
          config.implementation = 'auto';
          break;
        }
        if (isImplementation(imp)) config.implementation = imp;
        else issues.push(`unknown implementation '${value}'; known values: ${COMPOSE_IMPLEMENTATIONS.join(', ')}`);
        break;
      }
      case 'mapping': {
        const m = unquote(value);
        if (m === '') {
          config.mapping = null;
          break;
        }
        if (KOTLIN_SYMBOL_RE.test(m)) config.mapping = m;
        else issues.push(`mapping '${m}' is not a valid Kotlin symbol (identifier or fully-qualified name); ignored`);
        break;
      }
      case 'mappingArgs': {
        const { args, issues: argIssues } = parseMappingArgs(value);
        config.mappingArgs = args;
        issues.push(...argIssues);
        break;
      }
      case 'note': {
        if (config.note === null) config.note = unquote(value) || null;
        else if (unquote(value)) issues.push('duplicate note key; the first one wins');
        break;
      }
      default:
        issues.push(`unknown key '${key}'; known keys: version, role, kind, assets, implementation, mapping, mappingArgs, note`);
        break;
    }
  }

  if (!sawKey) {
    issues.push(`the block after '${COMPOSE_CONFIG_MARKER}' carries no keys`);
    return { prose, config: null, issues };
  }
  return { prose, config, issues };
}

/** Formats one mapping argument back to its `arg=value` text. */
function mappingArgToText(arg: ParsedComponentMappingArg): string {
  const v = arg.source;
  if (v.kind === 'constant') {
    const text = String(v.value);
    const wrap = (raw: string): string => {
      const needsQuotes =
        raw === '' ||
        raw !== raw.trim() ||
        raw.startsWith('@') ||
        /[,=#"'`\n]/.test(raw);
      const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return needsQuotes ? `"${escaped}"` : raw;
    };
    if (v.dataType) return `${arg.argument}=${v.dataType}:${wrap(text)}`;
    return `${arg.argument}=${wrap(text)}`;
  }
  return `${arg.argument}=@${v.kind}`;
}

/**
 * Renders the block content back to text (without the marker line) — exactly
 * what the parser round-trips. Keys in fixed order; defaulted values are
 * omitted. `withHelp` adds comment lines listing the accepted values so a
 * freshly generated block documents itself.
 */
export function buildComposeConfigBlock(config: ParsedComponentConfig, withHelp = false): string {
  const lines: string[] = [];
  if (withHelp) {
    lines.push('# keys: version | role | kind | assets | implementation | mapping | mappingArgs | note');
  }
  const add = (key: string, value: string | null, help?: string): void => {
    if (value !== null) lines.push(`${key}: ${value}`);
    else if (withHelp && help) lines.push(help);
  };
  if (config.version !== COMPOSE_CONFIG_VERSION) lines.push(`version: ${config.version}`);
  add(
    'role',
    config.role,
    withHelp ? `# role: ${COMPOSE_ROLES.join(' | ')}` : undefined,
  );
  add('kind', config.kind, withHelp ? '# kind: icon | image | vector' : undefined);
  add('assets', config.assets === 'auto' ? null : config.assets, withHelp ? '# assets: auto | export | code' : undefined);
  add(
    'implementation',
    config.implementation === 'auto' ? null : config.implementation,
    withHelp ? '# implementation: auto | custom' : undefined,
  );
  add('mapping', config.mapping, withHelp ? '# mapping: MyAppButton' : undefined);
  if (config.mappingArgs.length > 0) {
    lines.push(`mappingArgs: ${config.mappingArgs.map(mappingArgToText).join(', ')}`);
  } else if (withHelp) {
    lines.push('# mappingArgs: title="Sign In", count=int:2, opacity=float:0.5, icon=@icon');
  }
  add('note', config.note, withHelp ? '# note: copied into the generated file as a comment' : undefined);
  return lines.join('\n');
}

/**
 * Builds a full description: kept prose, blank line, marker, block. An old
 * block inside `prose` is stripped first so repeated applies do not stack
 * blocks. Empty prose yields a description that is exactly the block.
 */
export function applyComposeConfigToDescription(prose: string, block: string): string {
  const base = stripComposeConfig(prose);
  const tail = `${COMPOSE_CONFIG_MARKER}\n${block}`;
  return base ? `${base}\n\n${tail}` : tail;
}

/** The description with the configuration block removed (prose only). */
export function stripComposeConfig(description: string): string {
  return parseComposeConfig(description).prose;
}

/** The copy-paste template shipped in the plugin UI and docs. */
export const COMPOSE_CONFIG_TEMPLATE = [
  `${COMPOSE_CONFIG_MARKER}`,
  '# Compose Studio component configuration (version 1).',
  '# Lines starting with # are comments and are ignored.',
  '#',
  '# role mints the role\'s parameters (e.g. onClick) and, when the Figma look',
  '# can be matched exactly (solid fill, no border/shadow), a Material',
  '# implementation — otherwise the custom emission with the parameters:',
  `#   ${COMPOSE_ROLES.join(' | ')}`,
  '#',
  '# kind makes every instance render as an asset (no name prefix needed):',
  '#   icon | image | vector',
  '#',
  '# assets sets the asset policy:',
  '#   auto   name prefixes and other rules decide (default)',
  '#   export the component exports as an asset instead of code',
  '#   code   the component is always code, never an asset',
  '#',
  '# implementation: auto (Material when possible) | custom (always custom)',
  '#',
  '# mapping maps this component to an app composable instead of generating:',
  '#   mapping: MyAppButton',
  '#   mappingArgs: title="Sign In", count=int:2, delay=long:1, opacity=float:0.5,',
  '#                padding=dp:16, fontSize=sp:14, tint=color:8080FF, icon=@icon',
  '#   sources: @text first text | @icon icon | @color color | @content slot | @modifier modifier',
  '#   typed constants: int long float double boolean string char dp sp color object',
  '#   (e.g. boolean:true, string:label, char:a, object:TextStyle.Default; 42/"x"',
  '#    stay valid untyped constants)',
  '#',
  '# note: extra human context, copied into the generated file as a comment',
  'role: card',
].join('\n');

/**
 * Validates the visual editor's config payload (arbitrary JSON from the
 * plugin UI) into a `ParsedComponentConfig`. Fields are applied one by one:
 * unknown shapes/values are reported via `issues` and fall back to the
 * default, while valid siblings still apply — the same tolerance the text
 * parser shows. `tag`/`version` are always forced to the current constants
 * (the visual editor cannot invent them).
 */
export function normalizeComponentConfig(raw: unknown): { config: ParsedComponentConfig; issues: string[] } {
  const issues: string[] = [];
  const config: ParsedComponentConfig = {
    tag: COMPOSE_CONFIG_TAG,
    version: COMPOSE_CONFIG_VERSION,
    role: null,
    kind: null,
    assets: 'auto',
    implementation: 'auto',
    mapping: null,
    mappingArgs: [],
    note: null,
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push('the configuration payload is not an object');
    return { config, issues };
  }
  const src = raw as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

  const role = text(src.role);
  if (role !== null) {
    if (isRole(role)) config.role = role;
    else issues.push(`unknown role '${role}'; known roles: ${COMPOSE_ROLES.join(', ')}`);
  }
  const kind = text(src.kind);
  if (kind !== null) {
    if (isKind(kind)) config.kind = kind;
    else issues.push(`unknown kind '${kind}'; known kinds: ${COMPOSE_ASSET_KINDS.join(', ')}`);
  }
  const policy = text(src.assets);
  if (policy !== null) {
    const p = isPolicy(policy);
    if (p) config.assets = p;
    else issues.push(`unknown assets policy '${policy}'; known policies: ${COMPOSE_ASSET_POLICIES.join(', ')}`);
  }
  const implementation = text(src.implementation);
  if (implementation !== null) {
    if (isImplementation(implementation)) config.implementation = implementation;
    else issues.push(`unknown implementation '${implementation}'; known values: ${COMPOSE_IMPLEMENTATIONS.join(', ')}`);
  }
  const mapping = text(src.mapping);
  if (mapping !== null) {
    if (KOTLIN_SYMBOL_RE.test(mapping)) config.mapping = mapping;
    else issues.push(`mapping '${mapping}' is not a valid Kotlin symbol; ignored`);
  }
  if (Array.isArray(src.mappingArgs)) {
    const seen = new Set<string>();
    const known = [...SPECIAL_ARG_KINDS, ...MAPPING_ARG_DATATYPES].map((k) => `@${k}`).join(', ');
    for (const rawArg of src.mappingArgs) {
      if (typeof rawArg !== 'object' || rawArg === null) {
        issues.push('mappingArgs entry is not an object; skipped');
        continue;
      }
      const entry = rawArg as Record<string, unknown>;
      const argument = text(entry.argument);
      if (argument === null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) {
        issues.push('mappingArgs entry has no valid Kotlin argument name; skipped');
        continue;
      }
      if (seen.has(argument)) {
        issues.push(`duplicate mapping argument '${argument}'; the first one wins`);
        continue;
      }
      seen.add(argument);
      const rawSource = entry.source;
      // Typed payloads rebuild a serialized config (the visual editor, presets)
      // — trust the field but still validate the datatype tag.
      let source: MappingArgSource = { kind: 'constant', value: '' };
      if (typeof rawSource === 'object' && rawSource !== null && !Array.isArray(rawSource)) {
        const s = rawSource as Record<string, unknown>;
        const sKind = text(s.kind);
        if (sKind !== null && sKind !== 'constant' && (SPECIAL_ARG_KINDS as readonly string[]).includes(sKind)) {
          source = { kind: sKind as SpecialArgKind };
        } else if (sKind === 'constant') {
          const dataType = s.dataType;
          if (isMappingArgDataType(dataType)) source = { kind: 'constant', value: text(s.value) ?? '', dataType };
          else if (dataType !== undefined) {
            issues.push(`unknown mapping datatype '${String(dataType)}'; treated as a constant (known: ${MAPPING_ARG_DATATYPES.join(', ')})`);
            source = { kind: 'constant', value: text(s.value) ?? '' };
          } else source = { kind: 'constant', value: text(s.value) ?? '' };
        } else if (typeof s.value === 'string' && isMappingArgDataType(sKind) && s.value !== '') {
          // Shorthand `{ kind: '@int', value: '42' }` — a typed constant without `dataType`.
          source = { kind: 'constant', value: s.value, dataType: sKind };
        } else {
          if (sKind !== null && sKind !== 'constant') {
            issues.push(`unknown mapping source '${sKind}'; treated as a constant (known: ${known})`);
          }
          source = { kind: 'constant', value: text(s.value) ?? '' };
        }
      } else {
        issues.push(`mapping argument '${argument}' has no source object; treated as a constant`);
      }
      config.mappingArgs.push({ argument, source });
    }
  } else if (src.mappingArgs !== undefined) {
    issues.push('mappingArgs is not a list; ignored');
  }
  config.note = text(src.note);
  return { config, issues };
}

/** Short UI summary of a parsed config, e.g. `role card · kind icon · assets: export`. */
export function describeComposeConfig(config: ParsedComponentConfig): string {
  const parts: string[] = [];
  if (config.role) parts.push(`role ${config.role}`);
  if (config.kind) parts.push(`kind ${config.kind}`);
  if (config.assets !== 'auto') parts.push(`assets: ${config.assets}`);
  if (config.implementation !== 'auto') parts.push(`implementation: ${config.implementation}`);
  if (config.mapping) parts.push(`mapping \u2192 ${config.mapping}`);
  if (config.mappingArgs.length > 0) parts.push(`${config.mappingArgs.length} mapping arg(s)`);
  return parts.length > 0 ? parts.join(' \u00b7 ') : 'no configuration values';
}

/** Deterministic identity of a parsed config (used for conflict detection). */
export function composeConfigSignature(config: ParsedComponentConfig): string {
  return [
    config.role ?? '',
    config.kind ?? '',
    config.assets,
    config.implementation,
    config.mapping ?? '',
    config.mappingArgs
      .map((a) => {
        const v = a.source;
        if (v.kind !== 'constant') return `${a.argument}:@${v.kind}`;
        return `${a.argument}:@${v.dataType ?? 'raw'}=${v.value}`;
      })
      .join('|'),
    config.note ?? '',
  ].join('~');
}

/**
 * Suggests the app-composable name a component's mapping should point at,
 * derived from the master component name ("Working Level" -> `WorkingLevel`,
 * "Primary=large" -> `PrimaryLarge`). Returns `null` when the name carries
 * nothing usable. It is only a starting point for the Config editor: the
 * suggestion is applied (written into the block) when the user hits Apply,
 * and can be edited or cleared first.
 */
export function suggestMappingName(masterName: string): string | null {
  const raw = typeof masterName === 'string' ? masterName : '';
  if (raw.trim() === '') return null;
  return safeIdentifier(pascalCase(raw));
}

/** A shipped starting-point preset (merged under the user's own presets). */
export type BuiltinComponentPreset = {
  name: string;
  config: ParsedComponentConfig;
};

/** One all-defaults builder for the shipped presets. */
function builtinConfig(
  overrides: Partial<Pick<ParsedComponentConfig, 'role' | 'kind' | 'assets' | 'implementation' | 'mapping' | 'note' | 'mappingArgs'>>,
): ParsedComponentConfig {
  return {
    tag: COMPOSE_CONFIG_TAG,
    version: COMPOSE_CONFIG_VERSION,
    role: overrides.role ?? null,
    kind: overrides.kind ?? null,
    assets: overrides.assets || 'auto',
    implementation: overrides.implementation || 'auto',
    mapping: overrides.mapping ?? null,
    note: overrides.note ?? null,
    mappingArgs: overrides.mappingArgs ?? [],
  };
}

/**
 * Pre-made presets the Config tab offers out of the box, so a new user has
 * starting points without saving anything first. The plugin merges them
 * under the user's own presets; saving a preset with the same name shadows
 * the built-in (and deleting it again brings the built-in back).
 */
export const BUILTIN_COMPONENT_PRESETS: readonly BuiltinComponentPreset[] = [
  { name: 'Material Button', config: builtinConfig({ role: 'button' }) },
  { name: 'Material Card', config: builtinConfig({ role: 'card' }) },
  { name: 'Material Fab', config: builtinConfig({ role: 'fab' }) },
  { name: 'Icon — export as asset', config: builtinConfig({ kind: 'icon', assets: 'export' }) },
  { name: 'Icon — keep as code', config: builtinConfig({ kind: 'icon', assets: 'code' }) },
  { name: 'Image — export as asset', config: builtinConfig({ kind: 'image', assets: 'export' }) },
  { name: 'Defaults — remove config', config: builtinConfig({}) },
];
