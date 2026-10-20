# Compose Studio

A local Figma plugin that converts a selected Figma frame into idiomatic,
deterministic [Jetpack Compose](https://developer.android.com/jetpack/compose)
Kotlin — with no AI, no backend, and no network calls.

```
Figma selection → IR v1 → mapping resolver → Kotlin generator → preview + ZIP
```

- **Local-only & private**: `manifest.json` pins `networkAccess: none`; the
  conversion runs in your Figma session. See
  [docs/security-privacy.md](docs/security-privacy.md).
- **Never silently drops data**: every approximation or skip is surfaced as a
  diagnostic with a stable code and severity (see
  [docs/limitations.md](docs/limitations.md)).
- **Deterministic**: the same selection and mapping profile always produce
  byte-identical Kotlin and assets.
- **Design-system aware (optional)**: apply a JSON mapping profile to bind
  colors, fonts, text styles and Figma components to your real composables —
  see [docs/generation.md](docs/generation.md) and
  [examples/mapping-profile.json](examples/mapping-profile.json).

## Quick start

```bash
npm install
npm run build
```

Then, in the **Figma desktop app**: *Menu → Plugins → Development → Import
plugin from manifest…* and pick this folder's `manifest.json`. Full
instructions (including day-to-day use and dev watch mode) live in
[docs/setup.md](docs/setup.md).

## What converts today (phase 1)

| Category           | Highlights                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| Layout             | auto-layout → `Row`/`Column`, plain frames → `Box`, alignments, paddings, fill/weights, and Figma "ignore auto-layout" (absolute) children via a wrapper `Box` |
| Text               | `material3.Text` with full inline `TextStyle`, alignment, truncation, case       |
| Shapes             | rectangles, ellipses, lines with borders, radii, backgrounds, gradient brushes   |
| Shadows            | first drop shadow → `Modifier.shadow` (extras reported)                          |
| Vectors            | Asset export in **SVG file, Kotlin `ImageVector` (`Icons.kt`), or PNG**; live output preview and an on/off switch |
| Images             | Image-fill asset export into `drawable-nodpi` (Figma's stored bytes with real extension, or forced PNG/JPG re-render) |
| Ignore & curate    | ignore prefix, exact ignore marks (name+type+size, components by identity), asset-skip marks, and a curated **asset library** harvested from dedicated asset pages (icons page / images page) that applies to every future screen |
| Components         | Figma instances → your mapped composables with typed arguments and content lambdas; without a mapping they generate their own component files with type-safe variant parameters (`enum`/`sealed`/`Boolean`) and call sites; instances of curated asset-page components render as `Image` |
| Tokens             | local Figma color variables resolved via the design-token table                  |
| Design system      | opt-in design-system Kotlin from Figma variables and/or styles, split into organized files (`DesignSystem/Colors.kt`, `Typography.kt`, `Metrics.kt`, … , matched-slots `Theme.kt`) in **four structures**: plain vals, `object DesignSystem` accessor (single-file mode), matched Material 3 artifacts, or a ready `DesignSystemTheme` composable (collision suffixes, KDoc paths, honest per-skip diagnostics) |
| Export selection   | the Output tab's **Files &amp; assets** card downloads exactly what you tick on the previews — a checkbox on every file pill and every asset tile, with presets and the download button in the same card; the report is a manifest of the ZIP with `partialExport` flagged on subsets |

See [docs/supported-features.md](docs/supported-features.md) for the full
matrix, and [docs/export-and-android.md](docs/export-and-android.md) for how
the exported ZIP plugs into an Android Studio project.

## Project structure

```
manifest.json          Plugin manifest (dist entry points, networkAccess none)
src/
  main.ts              Plugin sandbox: selection wiring, asset bytes, UI messages
  ui/ui.html           Plugin UI (selection list, settings, preview, ZIP export)
  extract/             Scene-graph extractor (Node-testable, no figma global)
  ir/                  IR schema (version 1) + walker
  tokens/              Local variable → design-token collection (phase-3 subset)
  mapping/             Mapping profile schema, parsing and resolution
  gen/                 Kotlin generator, modifier chains, asset naming, exprs
  shared/messages.ts   Plugin ↔ UI message contract
scripts/
  build.mjs            esbuild bundling → dist/
  sample-docs.mts      Regenerates the code samples in docs/generation.md
test/                  Node-native tests over every pipeline stage
docs/                  All product/engineering documentation
examples/              Example mapping profile
```

## Commands

| Command                  | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `npm run build`          | Typecheck + bundle the plugin (`dist/`)              |
| `npm run watch:plugin`   | Rebuild plugin bundle on every change                |
| `npm run typecheck`      | `tsc --noEmit` for sources and tests                 |
| `npm test`               | Run the test suite (no Figma required)               |
| `npm run lint`           | ESLint                                               |

## Documentation

| Document                                    | What it covers                                    |
| ------------------------------------------- | --------------------------------------------------- |
| [docs/setup.md](docs/setup.md)              | Install, build, load into Figma, daily workflow      |
| [docs/generation.md](docs/generation.md)    | Emission rules, conventions, mapping precedence      |
| [docs/export-and-android.md](docs/export-and-android.md) | ZIP layout, Android integration, SVG→VectorDrawable |
| [docs/supported-features.md](docs/supported-features.md) | Full feature matrix with statuses           |
| [docs/limitations.md](docs/limitations.md)  | Honest list of gaps + every diagnostic code          |
| [docs/security-privacy.md](docs/security-privacy.md) | Privacy model, what is read and stored      |
| [docs/publishing.md](docs/publishing.md)    | Figma Community submission: assets, texts, checklist |

## Publishing

Community-submission art and texts live in `publish/` — plugin icon
(128×128), listing cover (1920×1080), two carousel slides, plus
`docs/publishing.md` with ready-to-paste wizard texts and the full checklist.

## Contributing

The pipeline is built in compiler-style layers (extract → IR → resolve →
generate), each of which takes plain data and returns plain data; the
`figma` global is only touched in `src/main.ts` and via the token collector.
That means you can develop and test the entire converter in Node with `npm
test` — fixtures in `test/fixtures.ts` mock the scene graph.

MIT licensed; see `LICENSE`.
