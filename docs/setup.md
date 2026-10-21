# Setup

Compose Studio is a local Figma plugin: build it once, load it once, and it
runs entirely inside your Figma session — no backend, no accounts, no network.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer (tested on Node 24)
- Figma **desktop app** (plugin development requires the desktop client)

## Build

```bash
npm install
npm run build      # typechecks (tsc --noEmit) and bundles with esbuild
```

Scripts:

| Command            | What it does                                                        |
| ------------------ | -------------------------------------------------------------------- |
| `npm run build`    | Typecheck + bundle `dist/code.js` and `dist/ui.html`                  |
| `npm run watch:plugin` | Rebuild on file change (good while iterating on Figma code)      |
| `npm run typecheck`| `tsc --noEmit` for plugin sources **and** test sources                |
| `npm test`         | Node-native test runner over `test/*.test.mts` (no Figma needed)      |
| `npm run lint`     | ESLint                                                               |

The build is fully local: `scripts/build.mjs` bundles `src/main.ts` (plugin
sandbox) into an IIFE at `dist/code.js` and copies `src/ui.html` to
`dist/ui.html`. No code is compiled for distribution beyond this `dist/`
folder.

## Load the plugin in Figma

1. Open the Figma desktop app and any file.
2. Open the menu **Figma → Plugins → Development → Import plugin from manifest…**
3. Select this repository's `manifest.json`.
4. Run it via **Plugins → Development → Compose Studio**.

The manifest declares:

```json
{ "main": "dist/code.js", "ui": "dist/ui.html", "editorType": ["figma"],
  "networkAccess": { "allowedDomains": ["none"] } }
```

`networkAccess: none` is enforced by the Figma runtime — the plugin cannot
make requests even if its code later changed maliciously; see
[security-privacy.md](security-privacy.md).

## Use it

1. Select one or more top-level frames in the canvas (screens are usually the
   whole `Frame` on the page). The panel is organized into seven tabs:
   **Convert**, **Mappings**, **Config**, **Assets & Ignore**, **Output**,
   **Guide**, **Settings**.
   The Selection card in **Convert** follows the canvas live — click frames
   and the list updates without pressing anything.
2. In **Settings**, set the **app name** and **package name** (default
   `com.example.composeapp`) and pick how component variants become
   parameters (enum, sealed, or plain strings).
3. Optionally open the **Mappings** tab (colors, fonts, text styles,
   components) and/or import a mapping profile JSON (see
   [generation.md](generation.md) and `examples/mapping-profile.json`).
4. Optionally curate in **Assets & Ignore**: set an ignore prefix, mark
   selected nodes as ignored (or asset-skip-only), and harvest a dedicated
   icons/images page into the asset library — curated assets apply to every
   future conversion.
5. In **Convert**, pick a mode:
   - **Standalone Compose** — literal colors, inline `TextStyle`, unmapped
     instances keep their plain layout.
   - **Design system (existing)** — the mappings configured
     above are applied during generation.
6. Click **Convert selection**. The panel jumps to the **Output** tab:
   generated Kotlin per file (with copy), plus diagnostics that list
   everything that was approximated or skipped. The severity chips are
   filters — and the **Copy** button on that row copies exactly what is
   currently visible (all diagnostics, or only the errors/warnings/notes of
   the active filter) as plain text.
7. Grab **ZIP download** for a ready-to-merge folder structure (see
   [export-and-android.md](export-and-android.md)).

Settings persist in Figma client storage under the keys
`compose-studio-settings` plus the curation lists
(`compose-studio-ignore-marks`, `compose-studio-asset-skip-marks`,
`compose-studio-asset-library`) — only for this plugin running in your Figma
account on this machine.

## Development notes

- Plugin code must run inside the sandbox with no `DOM` lib; `tsc` config
  strips lib DOM on purpose (Figma typings supply their own console/fetch).
- The test suite runs against mock scene-graph fixtures
  (`test/fixtures.ts`), so all pipeline logic (extract→map→generate→format)
  is exercised in plain Node without Figma.
- Keep `src/` free of Figma-global accesses outside `src/main.ts` and
  `src/tokens/collect.ts`; everything else should accept plain data.
