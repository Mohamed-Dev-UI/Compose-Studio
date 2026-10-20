/**
 * Ambient declaration for HTML imports: esbuild bundles referenced `.html`
 * files as raw text (string default export) so the UI can be inlined into the
 * plugin bundle. TypeScript needs this to typecheck `src/main.ts`.
 */
declare module '*.html' {
  const content: string;
  export default content;
}
