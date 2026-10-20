/**
 * Modifier chain builder.
 *
 * Modifiers are emitted in a fixed canonical order (documented in
 * docs/generation.md) so generated code is predictable and reviewable:
 *
 *   weight -> size/fill -> offset -> align -> shadow -> clip -> border
 *   -> background -> paint -> padding -> alpha
 */
import { dpLiteral, formatNumber } from '../util/format.ts';
import type { DpTokenResolver } from './usage.ts';

type Part = { name: string; args: string[] };

export class ModifierChain {
  private parts: Part[] = [];
  private readonly dpExpr: DpTokenResolver | null;

  constructor(dpExpr: DpTokenResolver | null = null) {
    this.dpExpr = dpExpr;
  }

  /** Slot-aware `Dp` for a value: design-system token ref or the literal. */
  private dp(value: number, slot: 'gap' | 'padding' | 'radius' | 'size' | 'border'): string {
    return this.dpExpr ? this.dpExpr(value, slot) : dpLiteral(value);
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }

  /** Names of the chained modifier parts in emission order (for import tracking). */
  partNames(): string[] {
    return this.parts.map((p) => p.name);
  }

  /** Row/Column-scope weight — emitted first so later sizing composes above it. */
  weight(fraction = 1): void {
    this.parts.push({ name: 'weight', args: [`${formatNumber(fraction)}f`] });
  }

  size(width: number | null, height: number | null): void {
    if (width == null && height == null) return;
    if (width != null && height != null) {
      this.parts.push(width === height ? { name: 'size', args: [this.dp(width, 'size')] } : { name: 'size', args: [this.dp(width, 'size'), this.dp(height, 'size')] });
    } else if (width != null) this.parts.push({ name: 'width', args: [this.dp(width, 'size')] });
    else this.parts.push({ name: 'height', args: [this.dp(height!, 'size')] });
  }

  fillMaxWidth(): void {
    this.parts.push({ name: 'fillMaxWidth', args: [] });
  }

  fillMaxHeight(): void {
    this.parts.push({ name: 'fillMaxHeight', args: [] });
  }

  fillMaxSize(): void {
    this.parts.push({ name: 'fillMaxSize', args: [] });
  }

  offset(x: number, y: number): void {
    if (x === 0 && y === 0) return;
    this.parts.push({ name: 'offset', args: [dpLiteral(x), dpLiteral(y)] });
  }

  /** Per-child scope alignment, e.g. `Alignment.CenterVertically`. */
  align(alignment: string): void {
    if (!alignment) return;
    this.parts.push({ name: 'align', args: [alignment] });
  }

  /** Vertically centers text inside a fixed-height constraint. */
  wrapContentHeight(alignment: string): void {
    if (!alignment) return;
    this.parts.push({ name: 'wrapContentHeight', args: [alignment] });
  }

  /** Drop shadow; `shapeExpression` may be null for rectangular shadows. */
  shadow(elevationPx: number, colorExpr: string, shapeExpression: string | null): void {
    if (elevationPx <= 0) return;
    if (shapeExpression) {
      this.parts.push({
        name: 'shadow',
        args: [
          `elevation = ${dpLiteral(elevationPx)}`,
          `shape = ${shapeExpression}`,
          `ambientColor = ${colorExpr}`,
          `spotColor = ${colorExpr}`,
        ],
      });
    } else {
      this.parts.push({ name: 'shadow', args: [`elevation = ${dpLiteral(elevationPx)}`] });
    }
  }

  /** Rounded clipping; a `null` shape falls back to plain rectangular clipping. */
  clip(shapeExpression: string | null): void {
    if (shapeExpression === null) this.parts.push({ name: 'clipToBounds', args: [] });
    else this.parts.push({ name: 'clip', args: [shapeExpression] });
  }

  border(widthPx: number, colorExpr: string, shapeExpression: string | null): void {
    if (widthPx <= 0) return;
    const args: string[] = [`width = ${this.dp(widthPx, 'border')}`, `color = ${colorExpr}`];
    if (shapeExpression) args.push(`shape = ${shapeExpression}`);
    this.parts.push({ name: 'border', args });
  }

  /**
   * Prepends a raw `clickable(...)` part so the whole node — including its
   * padding — responds to clicks, matching how a real control behaves. Used
   * for role-parameter wiring on custom body roots.
   */
  clickableFirst(args: string[]): void {
    if (args.length === 0) return;
    this.parts.unshift({ name: 'clickable', args });
  }

  background(colorOrBrushExpr: string, shapeExpression: string | null): void {
    const isBrush = colorOrBrushExpr.startsWith('Brush.');
    const args: string[] = [isBrush ? `brush = ${colorOrBrushExpr}` : `color = ${colorOrBrushExpr}`];
    if (shapeExpression) args.push(`shape = ${shapeExpression}`);
    this.parts.push({ name: 'background', args });
  }

  /** Paints a resource (painterResource) scaled to the bounds (image fills, vector images). */
  paint(painterExpr: string, contentScale: string | null): void {
    const args: string[] = [`painter = ${painterExpr}`];
    if (contentScale) args.push(`contentScale = ${contentScale}`);
    this.parts.push({ name: 'paint', args });
  }

  padding(t: number, r: number, b: number, l: number): void {
    if (t === 0 && r === 0 && b === 0 && l === 0) return;
if (t === b && r === l) {
      if (t === r) {
        this.parts.push({ name: 'padding', args: [`all = ${this.dp(t, 'padding')}`] });
      } else if (t === 0) {
        this.parts.push({ name: 'padding', args: [`horizontal = ${this.dp(r, 'padding')}`] });
      } else if (r === 0) {
        this.parts.push({ name: 'padding', args: [`vertical = ${this.dp(t, 'padding')}`] });
      } else {
        this.parts.push({ name: 'padding', args: [`horizontal = ${this.dp(r, 'padding')}`, `vertical = ${this.dp(t, 'padding')}`] });
      }
      return;
    }
    const args: string[] = [];
    if (l !== 0) args.push(`start = ${this.dp(l, 'padding')}`);
    if (t !== 0) args.push(`top = ${this.dp(t, 'padding')}`);
    if (r !== 0) args.push(`end = ${this.dp(r, 'padding')}`);
    if (b !== 0) args.push(`bottom = ${this.dp(b, 'padding')}`);
    if (args.length === 1) {
      // Compose `padding(x.dp)` pads all sides; avoid confusing one-sided args.
      this.parts.push({ name: 'padding', args });
    } else {
      this.parts.push({ name: 'padding', args });
    }
  }

  alpha(value: number): void {
    if (value >= 1) return;
    this.parts.push({ name: 'alpha', args: [`alpha = ${formatNumber(value)}f`] });
  }

  /**
   * Drop the padding chip. Used when a wrapper Box delegates the frame's
   * auto-layout insets to the inner Row/Column (absolute-positioned children
   * in Figma are not inset by the parent padding).
   */
  withoutPadding(): void {
    this.parts = this.parts.filter((p) => p.name !== 'padding');
  }

  /**
   * Render the modifier chain as one or more fully-indented lines.
   * `indent` is the base indentation of the argument list the modifier
   * appears in; continuation lines are emitted one level (4 spaces) deeper.
   * `prefix` is text that goes directly before `Modifier` (e.g. `modifier = `).
   */
  toKotlinLines(indent: string, prefix: string): string[] {
    if (this.parts.length === 0) return [`${indent}${prefix}Modifier`];
    const render = (p: Part): string => `${p.name}(${p.args.join(', ')})`;
    if (this.parts.length === 1) {
      const p = this.parts[0];
      if (!p) return [`${indent}${prefix}Modifier`];
      return [`${indent}${prefix}Modifier.${render(p)}`];
    }
    const lines: string[] = [`${indent}${prefix}Modifier`];
    for (const p of this.parts) {
      lines.push(`${indent}    .${render(p)}`);
    }
    return lines;
  }
}
