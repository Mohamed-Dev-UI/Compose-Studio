/**
 * Emission primitives for Kotlin code: an indent-aware writer and an import
 * tracker. Rendering is deterministic; imports are emitted sorted.
 */

export class KotlinFile {
  readonly packageName: string;
  private readonly imports = new Set<string>();
  private readonly importsToRemove = new Set<string>();
  private readonly lines: string[] = [];
  private indent = 0;

  constructor(packageName: string) {
    this.packageName = packageName;
  }

  useImport(importPath: string): void {
    if (!importPath) return;
    this.imports.add(importPath);
    this.importsToRemove.delete(importPath);
  }

  markUnusedImports(paths: string[]): void {
    for (const p of paths) this.importsToRemove.add(p);
  }

  line(text: string): void {
    this.lines.push(' '.repeat(this.indent * 4) + text);
  }

  /** Raw blank separator line (no indent padding). */
  blank(): void {
    this.lines.push('');
  }

  /** Current body line count (excludes the rendered package/import header). */
  lineCount(): number {
    return this.lines.length;
  }

  /** Rewrites one body line in place; out-of-range indexes are ignored. */
  mapLineAt(index: number, mapper: (line: string) => string): void {
    const line = this.lines[index];
    if (line !== undefined) this.lines[index] = mapper(line);
  }

  openBlock(header: string, footer: string): void {
    this.line(`${header} {`);
    this.indent += 1;
    this.footers.push(footer);
  }

  closeBlock(): void {
    this.indent -= 1;
    const footer = this.footers.pop() ?? null;
    if (footer !== null) this.line(footer);
  }

  /** Footers of currently open blocks (supports nesting). */
  private readonly footers: string[] = [];

  render(): string {
    const importLines = [...this.imports]
      .filter((i) => !this.importsToRemove.has(i))
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((i) => `import ${i}`);
    const parts: string[] = [];
    if (this.packageName) parts.push(`package ${this.packageName}`);
    if (importLines.length > 0) parts.push('');
    parts.push(...importLines);
    if (this.lines.length > 0) parts.push('');
    parts.push(...this.lines);
    parts.push('');
    return parts.join('\n');
  }
}

/** Create a fresh file writer establishing a package header. */
export function newKotlinFile(packageName: string): KotlinFile {
  return new KotlinFile(packageName);
}
