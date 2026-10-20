# Security & privacy

Compose Studio is built to be safe to use in untrusted company workspaces.

## No network access

The plugin manifest pins:

```json
"networkAccess": { "allowedDomains": ["none"] }
```

Figma asks you to confirm this restriction when loading the plugin in
development mode; the runtime blocks every outbound request from the plugin
code and its UI. The plugin also never *tries* to send anything: no telemetry,
no analytics, no fetching of fonts, images, or version checks. Building the
plugin requires npm access (devDependencies) but the built artifact makes zero
network calls.

## No AI, no remote models

Conversion is a plain deterministic compiler pipeline: extract → IR → resolve
mappings → generate. No model calls, no "AI assist", no prompt data hoarding.
`dist/code.js` is a self-contained bundle you read before loading. If you
want, 1) run the build, 2) skim the bundle — everything is plain TypeScript
compiled by esbuild; nothing obfuscated.

## What the plugin reads

- The Figma files/pages you explicitly run it on; **selection nodes only**:
  `figma.currentPage.selection`, then the subtree of the selection.
- Your local variable collections (`figma.variables.getLocalVariablesAsync`)
  to resolve color-token references during conversion (`src/tokens/collect.ts`).
- PNG bytes of image fills **part of your selection** only, via
  `figma.getImageByHash(hash).getBytesAsync()`.
- SVG source for vector nodes in the selection via `exportAsync('SVG_STRING')`.

Nothing else under `figma` is read. The plugin never modifies your document.

## What leaves the plugin runtime

Everything stays local in one of two places:

1. **Figma client storage** (`figma.clientStorage`) — plugin settings and
   mapping profile under `compose-studio-settings`, plus the user's curation
   lists: ignore marks (`compose-studio-ignore-marks`), asset-skip marks
   (`compose-studio-asset-skip-marks`) and the curated asset library
   (`compose-studio-asset-library`, page/node ids and names only — never
   asset bytes). That storage lives inside your Figma account on this
   machine, is not accessible to other plugins and does not sync our data
   anywhere (it is per-client).
2. **The ZIP you download** via the standard browser download flow — writes
   only to your local Downloads folder.

## UI sandbox

The plugin UI is a single static HTML file (`dist/ui.html`) with inline
styles/scripts and no dependencies; the ZIP writer inside it is
hand-rolled (store-method ZIP, CRC32) to avoid adding even one npm runtime
package. The UI iframe talks to the plugin sandbox exclusively via a strict
`pluginMessage` envelope (see `src/shared/messages.ts`). Files selected in
the "Import profile JSON" dialog are read locally and applied as mappings
only.

## Data provenance

Generated Kotlin, the report, and assets contain only data you gave: node
names you set in Figma and colors/strings from the design. If that data is
secret, treat generated files accordingly; they are never shipped anywhere by
the plugin.

## Report an issue

If you suspect a security problem (e.g. unexpected file or network access),
report it in the project's issue tracker rather than loading a patched build;
the fix process is the same as for any bug.
