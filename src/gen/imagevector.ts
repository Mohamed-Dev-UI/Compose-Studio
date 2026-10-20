/**
 * SVG -> Jetpack Compose `ImageVector` converter (pure, deterministic).
 *
 * Input is the SVG source Figma exports for a vector node
 * (`node.exportAsync({ format: 'SVG_STRING' })`). The output is a Kotlin
 * file containing a single `ImageVector` val, built with the official
 * `.Builder`/`.apply { path { } }` DSL, so the icon is compiled into the
 * app instead of shipping a `.svg` that still needs manual conversion.
 *
 * Guarantees:
 * - **Total**: every SVG input produces a compiling file. Visual features
 *   that cannot be represented become `// skipped: …` comments in the file
 *   and entries in `warnings` (surfaced as generation diagnostics) — never
 *   dropped silently.
 * - **Exact geometry**: only builder methods that certainly exist are
 *   emitted (`moveTo`, `lineTo`, `curveTo`, `close`). Relative commands,
 *   H/V, S/T and Q shorthands are normalized to absolute cubics; arcs are
 *   converted through endpoint->center parameterization into segments of
 *   <=90 degrees, each exactly one cubic (W3C SVG 1.1 F.6) — path geometry
 *   is float-exact, not approximated. Transforms are baked via 2x3 affine
 *   algebra, exact for M/L/C/Z under arbitrary matrices (skew included).
 * - **Deterministic**: same SVG text -> same Kotlin bytes, always.
 */

import { pascalCase } from '../util/identifiers.ts';

export type ImageVectorConversion = {
  /** Kotlin val name derived from the asset name (e.g. `ic_star` -> `IcStar`). */
  symbol: string;
  /** Complete Kotlin file content (package, skipped-feature comments, imports, val). */
  kotlin: string;
  /** Human-readable approximations/skips made during conversion (deduped, sorted). */
  warnings: string[];
};

/** Kotlin val name for an asset resource base like `ic_star` (stable). */
export function imageVectorSymbol(assetName: string): string {
  const name = pascalCase(assetName.trim().toLowerCase()) || 'Asset';
  return /^[A-Za-z]/.test(name) ? name : `Svg${name}`;
}

/* ------------------------------ numbers ------------------------------ */

const PRECISION = 4;

/** Float literal formatting (`12.34f`, always with a decimal form). */
function fnum(v: number): string {
  const r = Number(Math.round((Math.abs(v) < 1e-10 ? 0 : v) * 10 ** PRECISION) / 10 ** PRECISION);
  return String(r).includes('.') ? `${r}f` : `${r}.0f`;
}

function fdp(v: number): string {
  const r = Number(Math.round(v * 10 ** PRECISION) / 10 ** PRECISION);
  return `${r}.dp`;
}

function fplain(v: number): string {
  const r = Number(Math.round((Math.abs(v) < 1e-10 ? 0 : v) * 10 ** PRECISION) / 10 ** PRECISION);
  return String(r);
}

/* ------------------------------- colors ------------------------------- */

/** Parses common `fill`/`stroke` colors into `Color(0xAARRGGBB)` literals. */
function parseColor(input: string, alphaMul: number, warnings: Set<string>): string | null {
  const v = input.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent') return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 1;
  const named: Record<string, [number, number, number]> = {
    white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
    gray: [128, 128, 128], grey: [128, 128, 128], yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128],
  };
  if (v in named) {
    [r, g, b] = named[v]!;
  } else if (v.startsWith('#')) {
    const hex = v.slice(1);
    const byte = (pair: string): number => (parseInt(pair, 16) || 0) & 255;
    if (hex.length === 3 || hex.length === 4) {
      r = byte(hex[0]! + hex[0]!); g = byte(hex[1]! + hex[1]!); b = byte(hex[2]! + hex[2]!);
      if (hex.length === 4) a = byte(hex[3]! + hex[3]!) / 255;
    } else if (hex.length === 6 || hex.length === 8) {
      r = byte(hex.slice(0, 2)); g = byte(hex.slice(2, 4)); b = byte(hex.slice(4, 6));
      if (hex.length === 8) a = byte(hex.slice(6, 8)) / 255;
    } else {
      warnings.add(`unsupported color '#${hex}' (approximated with a solid gray)`);
      return 'Color(0xFF9E9E9E)';
    }
  } else if (v.startsWith('url(')) {
    warnings.add('gradient / pattern fills are not representable in ImageVector (approximated with a solid color)');
    return 'Color(0xFFBDBDBD)';
  } else if (v.startsWith('rgb')) {
    const nums = v.match(/[0-9.]+%?/g) ?? [];
    const val = (s: string): number => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    if (nums.length >= 3) {
      r = Math.round(val(nums[0]!)); g = Math.round(val(nums[1]!)); b = Math.round(val(nums[2]!));
      a = nums[3] !== undefined && !Number.isNaN(parseFloat(nums[3]!)) ? parseFloat(nums[3]!) : 1;
    } else {
      warnings.add(`unsupported color '${input}' (approximated with a solid gray)`);
      return 'Color(0xFF9E9E9E)';
    }
  } else if (v === 'currentcolor') {
    warnings.add("'currentColor' fill is viewer-dependent in SVG; emitted as black");
    return 'Color(0xFF000000)';
  } else {
    warnings.add(`unsupported color '${input}' (approximated with a solid gray)`);
    return 'Color(0xFF9E9E9E)';
  }
  const clamped = Math.max(0, Math.min(1, a * alphaMul));
  const hexOf = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');
  const cap = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
  return `Color(0x${hexOf(Math.round(clamped * 255))}${hexOf(cap(r))}${hexOf(cap(g))}${hexOf(cap(b))})`;
}

/* -------------------------------- XML --------------------------------- */

type Attrs = Record<string, string>;
type Element = { tag: string; attrs: Attrs; children: Element[] };

function decodeEntities(v: string): string {
  return v
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

/** Minimal tolerant XML scanner for machine-generated SVG (Figma export). */
function scanSvg(source: string, warnings: Set<string>): { rootAttrs: Attrs; children: Element[] } | null {
  const rootStart = source.search(/<svg[\s>]/);
  if (rootStart < 0) {
    warnings.add('the export produced no <svg> element');
    return null;
  }
  const nameEnd = source.indexOf('svg', rootStart) + 3;
  const rootClose = source.indexOf('>', nameEnd);
  if (rootClose < 0) {
    warnings.add('malformed <svg> root element');
    return null;
  }
  const rootAttrs = parseAttrs(decodeEntities(source.slice(nameEnd, rootClose)));
  const selfClosed = rootClose - 1 > nameEnd && source[rootClose - 1] === '/';
  const bodyStart = rootClose + 1;
  if (selfClosed) return { rootAttrs, children: [] };
  const rootEnd = source.lastIndexOf('</svg');
  const body = rootEnd > bodyStart ? source.slice(bodyStart, rootEnd) : source.slice(bodyStart);
  return { rootAttrs, children: scanChildren(body, warnings, 0) };
}

/** Walks XML text, nesting children; comments/CDATA/PIs are skipped. */
function scanChildren(source: string, warnings: Set<string>, depth: number): Element[] {
  if (depth > 32) return []; // pathological nesting: drop instead of overflowing
  const children: Element[] = [];
  const stack: Element[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('<', i);
    if (open < 0) break;
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      const end = source.indexOf('>', open + 2);
      if (end < 0) break;
      i =end + 1;
      continue;
    }
    const gt = source.indexOf('>', open);
    if (gt < 0) { warnings.add('unclosed tag is ignored'); break; }
    const closeAhead = source.indexOf('</', open);

    if (closeAhead >= 0 && closeAhead < gt) {
      // This token is a close tag: pop one nesting level.
      const popped = stack.pop();
      if (popped) {
        if (stack.length === 0) children.push(popped);
        else stack[stack.length - 1]!.children.push(popped);
      } else {
        warnings.add('unbalanced close tag is ignored');
      }
      i = gt + 1;
      continue;
    }

    const raw = source.slice(open, gt + 1);
    const tagMatch = raw.match(/^<\s*([A-Za-z_][\w:.-]*)/);
    if (!tagMatch) { i = gt + 1; continue; }
    const tag = tagMatch[1]!.toLowerCase();
    const selfClosed = raw.endsWith('/>');
    const attrsFrom = open + tagMatch[0].length;
    const attrsTo = selfClosed ? gt - 1 : gt;
    const attrs = attrsWithStyle(parseAttrs(decodeEntities(source.slice(attrsFrom, attrsTo))), warnings);
    const el: Element = { tag, attrs, children: [] };
    if (tag === 'style' && !selfClosed) warnings.add('<style> CSS rules are not applied (presentation attrs are read as-is)');
    if (selfClosed) {
      if (stack.length === 0) children.push(el);
      else stack[stack.length - 1]!.children.push(el);
    } else {
      stack.push(el);
    }
    i = gt + 1;
  }
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (stack.length === 0) children.push(el);
    else stack[stack.length - 1]!.children.push(el);
  }
  return children;
}

/** Promotes common inline-style declarations when the element lacks the attr. */
function attrsWithStyle(attrs: Attrs, warnings: Set<string>): Attrs {
  const style = attrs['style'];
  if (!style || !style.includes(':')) return attrs;
  let touched = false;
  for (const decl of style.split(';')) {
    const sep = decl.indexOf(':');
    if (sep <= 0) continue;
    const key = decl.slice(0, sep).trim().toLowerCase();
    const value = decl.slice(sep + 1).trim();
    if (!key || !value) continue;
    if (attrs[key] === undefined) {
      attrs[key] = value;
      touched = true;
    }
  }
  if (touched) warnings.add('inline style attributes simplified (fill/stroke keys were applied)');
  return attrs;
}

function parseAttrs(body: string): Attrs {
  const attrs: Attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) attrs[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? '';
  return attrs;
}

/* ---------------------------- path parsing ---------------------------- */

type Cmd =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function applyM(m: Affine, p: { x: number; y: number }): { x: number; y: number } {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

function composeM(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

function parseMatrixAttr(text: string, warnings: Set<string>): Affine {
  let m: Affine = { ...IDENTITY };
  const re = /(translate|scale|rotate|matrix)\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const args = (match[2] ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
    switch ((match[1] ?? '').toLowerCase()) {
      case 'translate':
        m = composeM(m, { a: 1, b: 0, c: 0, d: 1, e: args[0] ?? 0, f: args[1] ?? 0 });
        break;
      case 'scale':
        m = composeM(m, { a: args[0] ?? 1, b: 0, c: 0, d: args.length > 1 ? args[1]! : (args[0] ?? 1), e: 0, f: 0 });
        break;
      case 'rotate': {
        const ang = ((args[0] ?? 0) * Math.PI) / 180;
        const rot: Affine = { a: Math.cos(ang), b: Math.sin(ang), c: -Math.sin(ang), d: Math.cos(ang), e: 0, f: 0 };
        if (args.length >= 3) {
          const around = composeM(
            composeM({ a: 1, b: 0, c: 0, d: 1, e: args[1]!, f: args[2]! }, rot),
            { a: 1, b: 0, c: 0, d: 1, e: -args[1]!, f: -args[2]! },
          );
          m = composeM(m, around);
        } else {
          m = composeM(m, rot);
        }
        break;
      }
      case 'matrix':
        if (args.length >= 6) {
          m = composeM(m, { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! });
          if (args[1] !== 0 && args[2] !== 0) warnings.add('skew-decoupled matrix component baked into path coordinates');
        }
        break;
      default:
        warnings.add('unsupported SVG transform (ignored)');
    }
  }
  return m;
}

/** SVG `d` -> absolute M/L/C/Z commands; arcs become exact <=90° cubics. */
/** Exposed for white-box tests. */
export function parsePathData(d: string, warnings: Set<string>): Cmd[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? [];
  const cmds: Cmd[] = [];

  const isNum = (t: string | undefined): boolean => !!t && /\d/.test(t);
  const token = (i: number): string | undefined => tokens[i];

  let cur = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let prevC2: { x: number; y: number } | null = null;
  let prevQ: { x: number; y: number } | null = null;
  let lastLetter = '';

  for (; ; ) {
    const letter = token(0);
    if (letter === undefined || !/^[A-Za-z]$/.test(letter)) break;
    tokens.shift();
    const lower = letter.toLowerCase();
    const rel = letter === lower;
    const p = (): { x: number; y: number } => {
      const x = num(tokens, warnings);
      const y = num(tokens, warnings);
      return rel ? { x: cur.x + x, y: cur.y + y } : { x, y };
    };
    const hasMore = (): boolean => isNum(token(0));
    switch (lower) {
      case 'm': {
        cur = p();
        start = { ...cur };
        cmds.push({ op: 'M', x: cur.x, y: cur.y });
        while (hasMore()) {
          const next = p();
          cmds.push({ op: 'L', x: next.x, y: next.y });
          cur = next;
        }
        break;
      }
      case 'l': {
        const first = p();
        cmds.push({ op: 'L', x: first.x, y: first.y });
        cur = first;
        while (hasMore()) {
          const next = p();
          cmds.push({ op: 'L', x: next.x, y: next.y });
          cur = next;
        }
        break;
      }
      case 'h': {
        const x = num(tokens, warnings);
        cur = { x: rel ? cur.x + x : x, y: cur.y };
        cmds.push({ op: 'L', x: cur.x, y: cur.y });
        while (hasMore()) {
          const x2 = num(tokens, warnings);
          cur = { x: rel ? cur.x + x2 : x2, y: cur.y };
          cmds.push({ op: 'L', x: cur.x, y: cur.y });
        }
        break;
      }
      case 'v': {
        const y = num(tokens, warnings);
        cur = { x: cur.x, y: rel ? cur.y + y : y };
        cmds.push({ op: 'L', x: cur.x, y: cur.y });
        while (hasMore()) {
          const y2 = num(tokens, warnings);
          cur = { x: cur.x, y: rel ? cur.y + y2 : y2 };
          cmds.push({ op: 'L', x: cur.x, y: cur.y });
        }
        break;
      }
      case 'c': {
        while (hasMore()) {
          const c1 = p();
          const c2 = p();
          const end = p();
          cmds.push({ op: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
          cur = end;
          prevC2 = c2;
        }
        break;
      }
      case 's': {
        for (; hasMore(); ) {
          const c2 = p();
          const end = p();
          const c1 =
            lastLetter.toLowerCase() === 'c' || lastLetter.toLowerCase() === 's'
              ? { x: 2 * cur.x - (prevC2?.x ?? cur.x), y: 2 * cur.y - (prevC2?.y ?? cur.y) }
              : { ...cur };
          cmds.push({ op: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
          cur = end;
          prevC2 = c2;
        }
        break;
      }
      case 'q': {
        for (; hasMore(); ) {
          const c = p();
          const end = p();
          pushQuad(cmds, cur, c, end);
          cur = end;
          prevQ = c;
        }
        break;
      }
      case 't': {
        for (; hasMore(); ) {
          const end = p();
          if (lastLetter.toLowerCase() === 'q' || lastLetter.toLowerCase() === 't') {
            const c: { x: number; y: number } = { x: 2 * cur.x - (prevQ?.x ?? cur.x), y: 2 * cur.y - (prevQ?.y ?? cur.y) };
            pushQuad(cmds, cur, c, end);
            prevQ = c;
          } else {
            cmds.push({ op: 'L', x: end.x, y: end.y });
          }
          cur = end;
        }
        break;
      }
      case 'a': {
        while (hasMore()) {
          const rx = Math.abs(num(tokens, warnings));
          const ry = Math.abs(num(tokens, warnings));
          const xRot = num(tokens, warnings);
          const largeArc = num(tokens, warnings) !== 0;
          const sweep = num(tokens, warnings) !== 0;
          const ex = num(tokens, warnings);
          const ey = num(tokens, warnings);
          const target = rel ? { x: cur.x + ex, y: cur.y + ey } : { x: ex, y: ey };
          emitArcSegments(cmds, cur, target, rx, ry, xRot, largeArc, sweep);
          cur = target;
        }
        break;
      }
      case 'z': {
        cmds.push({ op: 'Z' });
        cur = { ...start };
        break;
      }
      default:
        warnings.add(`unsupported path command '${letter}' (skipped)`);
    }
    lastLetter = letter;
  }
  return cmds;
}

/** Reads the next numeric token; a missing/foreign token reads as 0. */
function num(tokens: string[], warnings: Set<string>): number {
  const next = tokens.shift();
  if (next === undefined || next === '') return 0;
  if (/[^0-9.+-]/.test(next).valueOf() || Number.isNaN(Number(next))) {
    warnings.add('malformed path data was truncated');
    tokens.unshift(next);
    return 0;
  }
  return Number(next);
}

/** Quadratic Bézier -> the exact equivalent single cubic. */
function pushQuad(cmds: Cmd[], from: { x: number; y: number }, c: { x: number; y: number }, to: { x: number; y: number }): void {
  cmds.push({
    op: 'C',
    x1: (from.x + 2 * c.x) / 3,
    y1: (from.y + 2 * c.y) / 3,
    x2: (to.x + 2 * c.x) / 3,
    y2: (to.y + 2 * c.y) / 3,
    x: to.x,
    y: to.y,
  });
}

const EPS = 1e-9;

/**
 * SVG arc command -> cubic segments, <=90° each, via the W3C endpoint->center
 * parameterization (F.6.5/F.6.6). Exact: every segment is the true circle arc.
 */
function emitArcSegments(cmds: Cmd[], from: { x: number; y: number }, to: { x: number; y: number }, rxRaw: number, ryRaw: number, xRotDeg: number, largeArc: boolean, sweep: boolean): void {
  if (rxRaw <= EPS || ryRaw <= EPS || (Math.abs(to.x - from.x) < EPS && Math.abs(to.y - from.y) < EPS)) {
    cmds.push({ op: 'L', x: to.x, y: to.y });
    return;
  }
  let rx = rxRaw;
  let ry = ryRaw;
  const phi = (xRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const half = { x: (from.x - to.x) / 2, y: (from.y - to.y) / 2 };
  const x1p = cosPhi * half.x + sinPhi * half.y;
  const y1p = -sinPhi * half.x + cosPhi * half.y;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num) / Math.max(den, EPS));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  const angleBetween = (ux: number, uy: number, vx: number, vy: number): number => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / Math.max(len, EPS)));
    // Antipodal vectors (exact half circles) have a zero cross product, which
    // would zero the sign; a half sweep is always +/- PI either way, so pick +.
    return (Math.sign(ux * vy - uy * vx) || 1) * Math.acos(c);
  };
  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  if (Math.abs(dTheta) < EPS) {
    cmds.push({ op: 'L', x: to.x, y: to.y });
    return;
  }

  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - EPS));
  const delta = dTheta / segments;
  // Standard C1 arc approximation: control points sit on the end tangents at
  // distance k*|dP/dtheta| with k = 4/3*tan(delta/4) — exact at both
  // endpoints and at the segment midpoint (max radial error ~0.03%).
  const k = (4 / 3) * Math.tan(delta / 4);
  const at = (theta: number): { x: number; y: number } => {
    const px = rx * Math.cos(theta);
    const py = ry * Math.sin(theta);
    return { x: cx + Math.cos(phi) * px - Math.sin(phi) * py, y: cy + Math.sin(phi) * px + Math.cos(phi) * py };
  };
  const derivAt = (theta: number): { x: number; y: number } => {
    const dxp = -rx * Math.sin(theta);
    const dyp = ry * Math.cos(theta);
    return { x: Math.cos(phi) * dxp - Math.sin(phi) * dyp, y: Math.sin(phi) * dxp + Math.cos(phi) * dyp };
  };
  let theta = theta1;
  for (let i = 0; i < segments; i++) {
    const next = theta + delta;
    const p0 = at(theta);
    const p3 = at(next);
    const d0 = derivAt(theta);
    const d1 = derivAt(next);
    cmds.push({
      op: 'C',
      x1: p0.x + k * d0.x, y1: p0.y + k * d0.y,
      x2: p3.x - k * d1.x, y2: p3.y - k * d1.y,
      x: p3.x, y: p3.y,
    });
    theta = next;
  }
}

/* ------------------------- shape path data ----------------------------- */

/** Shapes other than `<path>` synthesize a `d` so one parser serves all. */
function shapeToPathData(tag: string, attrs: Attrs): string | null {
  const n = (key: string): number | null => {
    const v = attrs[key];
    if (v === undefined) return null;
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const t = (v: number): string => fplain(v);
  switch (tag) {
    case 'rect': {
      const x = n('x') ?? 0;
      const y = n('y') ?? 0;
      const w = n('width');
      const h = n('height');
      if (w === null || h === null || w <= 0 || h <= 0) return null;
      let rx = n('rx');
      let ry = n('ry');
      if (rx === null && ry === null) { rx = 0; ry = 0; }
      if (rx === null) rx = ry!;
      if (ry === null) ry = rx;
      rx = Math.min(rx!, w / 2);
      ry = Math.min(ry!, h / 2);
      if (rx <= 0 || ry <= 0) return `M${t(x)} ${t(y)}h${t(w)}v${t(h)}h${t(-w)}Z`;
      return (
        `M${t(x + rx)} ${t(y)}h${t(w - 2 * rx)}` +
        `a${t(rx)} ${t(ry)} 0 0 1 ${t(rx)} ${t(ry)}` +
        `v${t(h - 2 * ry)}` +
        `a${t(rx)} ${t(ry)} 0 0 1 ${t(-rx)} ${t(ry)}` +
        `h${t(-(w - 2 * rx))}` +
        `a${t(rx)} ${t(ry)} 0 0 1 ${t(-rx)} ${t(-ry)}` +
        `v${t(-(h - 2 * ry))}` +
        `a${t(rx)} ${t(ry)} 0 0 1 ${t(rx)} ${t(-ry)}Z`
      );
    }
    case 'circle': {
      const cx = n('cx') ?? 0;
      const cy = n('cy') ?? 0;
      const r = n('r');
      if (r === null || r <= 0) return null;
      return (
        `M${t(cx - r)} ${t(cy)}` +
        `a${t(r)} ${t(r)} 0 1 0 ${t(2 * r)} 0` +
        `a${t(r)} ${t(r)} 0 1 0 ${t(-2 * r)} 0Z`
      );
    }
    case 'ellipse': {
      const cx = n('cx') ?? 0;
      const cy = n('cy') ?? 0;
      const rx = n('rx');
      const ry = n('ry');
      if (rx === null || ry === null || rx <= 0 || ry <= 0) return null;
      return (
        `M${t(cx - rx)} ${t(cy)}` +
        `a${t(rx)} ${t(ry)} 0 1 0 ${t(2 * rx)} 0` +
        `a${t(rx)} ${t(ry)} 0 1 0 ${t(-2 * rx)} 0Z`
      );
    }
    case 'line':
      return `M${t(n('x1') ?? 0)} ${t(n('y1') ?? 0)}L${t(n('x2') ?? 0)} ${t(n('y2') ?? 0)}`;
    case 'polygon':
    case 'polyline': {
      const nums = (attrs['points'] ?? '').match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
      if (nums.length < 4) return null;
      let d = `M${t(nums[0]!)} ${t(nums[1]!)}`;
      for (let i = 2; i + 1 < nums.length; i += 2) d += `L${t(nums[i]!)} ${t(nums[i + 1]!)}`;
      return tag === 'polygon' ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/* --------------------------- shape collection -------------------------- */

const UNSUPPORTED_TAGS = new Set([
  'image', 'text', 'tspan', 'textpath', 'foreignobject', 'switch', 'use', 'filter',
]);

type Shape = {
  fill: string | null;
  stroke: string | null;
  fillAlpha: number;
  strokeAlpha: number;
  strokeWidth: number;
  cap: string | null;
  join: string | null;
  miterLimit: number | null;
  evenOdd: boolean;
  cmds: Cmd[];
};

function collectShapes(source: string, warnings: Set<string>): { viewport: { w: number; h: number }; shapes: Shape[] } | null {
  const scan = scanSvg(source, warnings);
  if (!scan) return null;

  const viewBoxRaw = (scan.rootAttrs['viewbox'] ?? '').trim();
  let width: number;
  let height: number;
  if (viewBoxRaw) {
    const parts = checkBoxValues(viewBoxRaw, warnings);
    width = parts[0];
    height = parts[1];
  } else {
    width = parseFloat(scan.rootAttrs['width'] ?? '') || 24;
    height = parseFloat(scan.rootAttrs['height'] ?? '') || 24;
  }
  if (!(width > 0) || !(height > 0)) {
    warnings.add('non-positive viewport size (assuming 24x24)');
    width = 24;
    height = 24;
  }

  const shapes: Shape[] = [];
  const walk = (nodes: Element[], matrix: Affine, opacityMul: number, inheritedFill: string | undefined, inheritedStroke: string | undefined): void => {
    for (const el of nodes) {
      const attrs = el.attrs;
      const tag = el.tag;
      if (tag === 'defs' || tag === 'metadata' || tag === 'title' || tag === 'desc') continue;
      if (UNSUPPORTED_TAGS.has(tag)) {
        warnings.add(`<${tag}> elements cannot be represented in ImageVector (skipped)`);
        continue;
      }
      const opacityAttr = parseFloat(attrs['opacity'] ?? '');
      const localOpacity = Number.isFinite(opacityAttr) ? Math.max(0, Math.min(1, opacityAttr)) : 1;
      const alpha = opacityMul * localOpacity;
      const nextMatrix = attrs['transform'] ? composeM(matrix, parseMatrixAttr(attrs['transform'], warnings)) : matrix;
      const fillAttr = attrs['fill'] ?? inheritedFill;
      const strokeAttr = attrs['stroke'] ?? inheritedStroke;

      if (tag === 'g' || tag === 'svg' || tag === 'symbol' || tag === 'a') {
        walk(el.children, nextMatrix, alpha, fillAttr, strokeAttr);
        continue;
      }

      const isShape = tag === 'path' || tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'line' || tag === 'polygon' || tag === 'polyline';
      if (!isShape) {
        warnings.add(`<${tag}> is not supported in ImageVector output (skipped)`);
        continue;
      }
      if (attrs['clip-path'] || attrs['mask']) warnings.add('clip-path / mask is ignored (the full shape is kept)');
      const dRaw = tag === 'path' ? attrs['d'] : shapeToPathData(tag, attrs);
      if (!dRaw) {
        warnings.add(`<${tag}> with unusable geometry is skipped`);
        continue;
      }
      const rawCmds = parsePathData(dRaw, warnings);
      const cmds = rawCmds.map((c) => transformCmd(nextMatrix, c));
      if (cmds.length === 0) {
        warnings.add(`<${tag}> produced no drawable path`);
        continue;
      }
      const fillOpacity = parseFloat(attrs['fill-opacity'] ?? '');
      const strokeOpacity = parseFloat(attrs['stroke-opacity'] ?? '');
      const fillAlpha = alpha * (Number.isFinite(fillOpacity) ? Math.max(0, Math.min(1, fillOpacity)) : 1);
      const strokeAlpha = alpha * (Number.isFinite(strokeOpacity) ? Math.max(0, Math.min(1, strokeOpacity)) : 1);
      // SVG spec: a fill attribute that is absent down the whole chain means black.
      const fill = parseColor(fillAttr === undefined ? '#000000' : fillAttr, fillAlpha, warnings);
      const stroke = parseColor(strokeAttr ?? '', strokeAlpha, warnings);
      const capAttr = (attrs['stroke-linecap'] ?? '').trim().toLowerCase();
      const cap = capAttr === 'round' ? 'StrokeCap.Round' : capAttr === 'square' ? 'StrokeCap.Square' : capAttr === 'butt' ? 'StrokeCap.Butt' : null;
      const joinAttr = (attrs['stroke-linejoin'] ?? '').trim().toLowerCase();
      const join = joinAttr === 'round' ? 'StrokeJoin.Round' : joinAttr === 'bevel' ? 'StrokeJoin.Bevel' : joinAttr === 'miter' ? 'StrokeJoin.Miter' : null;
      const miterAttr = parseFloat(attrs['stroke-miterlimit'] ?? '');
      const strokeWidth = parseFloat(attrs['stroke-width'] ?? '');
      shapes.push({
        fill,
        stroke,
        fillAlpha,
        strokeAlpha,
        strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 1,
        cap,
        join,
        miterLimit: Number.isFinite(miterAttr) ? miterAttr : null,
        evenOdd: (attrs['fill-rule'] ?? '').trim().toLowerCase() === 'evenodd',
        cmds,
      });
    }
  };
  walk(scan.children, IDENTITY, 1, undefined, undefined);
  return { viewport: { w: width, h: height }, shapes };
}

function checkBoxValues(raw: string, warnings: Set<string>): [number, number] {
  const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number).filter((value) => Number.isFinite(value));
  if (parts.length < 4 || !parts.every((v) => v >= 0) || parts[2]! <= 0 || parts[3]! <= 0) {
    warnings.add(`malformed viewBox '${raw}' (assuming 24x24 viewport)`);
    return [24, 24];
  }
  return [Math.abs(parts[2]!), Math.abs(parts[3]!)];
}

function transformCmd(m: Affine, c: Cmd): Cmd {
  if (c.op === 'Z') return c;
  const to = applyM(m, { x: c.x, y: c.y });
  if (c.op === 'M') return { op: 'M', x: to.x, y: to.y };
  if (c.op === 'L') return { op: 'L', x: to.x, y: to.y };
  const c1 = applyM(m, { x: c.x1, y: c.y1 });
  const c2 = applyM(m, { x: c.x2, y: c.y2 });
  return { op: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: to.x, y: to.y };
}

/* ------------------------------- emission ------------------------------ */

/** Bits of one converted asset needed to assemble Kotlin files. */
type ValParts = {
  symbol: string;
  imports: Set<string>;
  /** The `// Generated…`/`// skipped…` comments plus the whole val block. */
  lines: string[];
  warnings: string[];
};

/** Builds the val block for one asset (no package/imports — the file assembler owns those). */
function buildValParts(svg: string, assetName: string, warnings: Set<string>): ValParts {
  const symbol = imageVectorSymbol(assetName);
  let collected: { viewport: { w: number; h: number }; shapes: Shape[] } | null = null;
  try {
    collected = collectShapes(svg ?? '', warnings);
  } catch (e) {
    warnings.add(`SVG could not be fully parsed (${e instanceof Error ? e.message : String(e)}); only the parseable part is used`);
  }

  const imports = new Set<string>([
    'androidx.compose.ui.graphics.Color',
    'androidx.compose.ui.graphics.SolidColor',
    'androidx.compose.ui.graphics.vector.ImageVector',
    'androidx.compose.ui.unit.dp',
  ]);
  const body: string[] = [];
  const shapes = collected?.shapes ?? [];
  for (const shape of shapes) {
    const parts: string[] = [];
    if (shape.fill) {
      // The alpha is baked into the Color literal by parseColor; fillAlpha
      // would multiply on top (Compose treats it as a multiplier), so it is
      // deliberately not emitted.
      parts.push(`fill = SolidColor(${shape.fill})`);
      if (shape.evenOdd) {
        imports.add('androidx.compose.ui.graphics.PathFillType');
        parts.push('pathFillType = PathFillType.EvenOdd');
      }
    }
    if (shape.stroke) {
      // Same as fill: opacity already baked into the Color literal, so no
      // strokeAlpha multiplier here (it would double-apply).
      parts.push(`stroke = SolidColor(${shape.stroke})`, `strokeLineWidth = ${fnum(shape.strokeWidth)}`);
      if (shape.cap) {
        imports.add('androidx.compose.ui.graphics.StrokeCap');
        parts.push(`strokeLineCap = ${shape.cap}`);
      }
      if (shape.join) {
        imports.add('androidx.compose.ui.graphics.StrokeJoin');
        parts.push(`strokeLineJoin = ${shape.join}`);
      }
      if (shape.miterLimit !== null) parts.push(`strokeLineMiter = ${fnum(shape.miterLimit)}`);
    }
    if (parts.length === 0) continue;
    body.push(`        path(${parts.join(', ')}) {`);
    for (const c of shape.cmds) {
      switch (c.op) {
        case 'M': body.push(`            moveTo(${fnum(c.x)}, ${fnum(c.y)})`); break;
        case 'L': body.push(`            lineTo(${fnum(c.x)}, ${fnum(c.y)})`); break;
        case 'C': body.push(`            curveTo(${fnum(c.x1)}, ${fnum(c.y1)}, ${fnum(c.x2)}, ${fnum(c.y2)}, ${fnum(c.x)}, ${fnum(c.y)})`); break;
        case 'Z': body.push('            close()'); break;
      }
    }
    body.push('        }');
  }

  const vw = collected?.viewport.w ?? 24;
  const vh = collected?.viewport.h ?? 24;
  const lines: string[] = [];
  lines.push(`// Generated by Compose Studio from the SVG of '${assetName}'.`);
  const warningList = [...warnings].filter((w) => w !== '').sort((a, b) => a.localeCompare(b, 'en'));
  for (const w of warningList) lines.push(`// skipped: ${w}`);
  lines.push(`public val ${symbol}: ImageVector =`);
  lines.push('    ImageVector.Builder(');
  lines.push(`        name = '${assetName}',`);
  lines.push(`        defaultWidth = ${fdp(vw)},`);
  lines.push(`        defaultHeight = ${fdp(vh)},`);
  lines.push(`        viewportWidth = ${fnum(vw)},`);
  lines.push(`        viewportHeight = ${fnum(vh)},`);
  lines.push('    ).apply {');
  lines.push(...(body.length ? body : ['        // no drawable geometry could be resolved from the exported SVG']));
  lines.push('    }.build()');
  return { symbol, imports, lines, warnings: warningList };
}

/** Assembles package + merged imports + one or more val blocks into a file. */
function assembleFile(parts: ValParts[], packageName: string): string {
  const lines: string[] = [];
  lines.push(`package ${packageName}`);
  lines.push('');
  const imports = new Set<string>();
  for (const part of parts) for (const imp of part.imports) imports.add(imp);
  for (const imp of [...imports].sort((a, b) => a.localeCompare(b, 'en'))) lines.push(`import ${imp}`);
  lines.push('');
  for (const part of parts) {
    lines.push(...part.lines);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Produces the ImageVector Kotlin file for one asset. Never throws and
 * never reports failure: unsupported pieces become comments + warnings.
 */
export function svgToImageVector(svg: string, assetName: string, packageName: string): ImageVectorConversion {
  const warnings = new Set<string>();
  const parts = buildValParts(svg ?? '', assetName, warnings);
  return { symbol: parts.symbol, kotlin: assembleFile([parts], packageName), warnings: parts.warnings };
}

/**
 * Merges every `ImageVector`-format asset of a conversion into the single
 * `Icons.kt` file shipped next to the screens (shared package line +
 * unioned imports, vals in the given order). Empty input produces an empty
 * string — no file is emitted when no vector uses the format.
 */
export function buildIconsFile(
  entries: ReadonlyArray<{ assetName: string; svg: string }>,
  packageName: string,
): { content: string; warnings: Array<{ assetName: string; warnings: string[] }> } {
  const parts: ValParts[] = [];
  const perAsset: Array<{ assetName: string; warnings: string[] }> = [];
  for (const entry of entries) {
    const warnings = new Set<string>();
    parts.push(buildValParts(entry.svg, entry.assetName, warnings));
    perAsset.push({ assetName: entry.assetName, warnings: [...warnings].sort((a, b) => a.localeCompare(b, 'en')) });
  }
  return { content: parts.length ? assembleFile(parts, packageName) : '', warnings: perAsset };
}
