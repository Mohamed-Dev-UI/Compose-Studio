# Export and Android integration

After a conversion, **Download ZIP** produces one archive containing everything
needed to drop generated screens into an existing Android app (or a fresh
project).

## ZIP layout

```
<appName>/
├── app/src/main/java/<package-path>/        Kotlin files
│   ├── com/example/composeapp/
│   │   ├── LoginScreen.kt
│   │   ├── DesignSystem.kt                  one accessor object, sections per family
│   │   │                                    (only with the design-system setting on)
│   │   ├── DesignSystem/
│   │   │   └── Theme.kt                     matched Material artifacts (material modes)
│   │   └── Icons.kt                           (only with ImageVector-format assets)
├── app/src/main/res/drawable-nodpi/         rasters (image fills, or rasterized vectors)
│   ├── img_hero_photo.png
│   └── img_banner.jpg                       (JPG byte images keep their extension)
├── vectors/                                 SVG sources (SVG-format vector assets)
│   └── ic_star_icon.svg
└── conversion-report.json                   diagnostics + file/asset/format index
```

- `<appName>` defaults to `ComposeApp`; `<package-path>` comes from the
  package-name setting with each package segment becoming a folder
  (`com.example.composeapp` → `com/example/composeapp/`).
- An asset exported in ImageVector format writes **no file** — it compiles
  into the merged `Icons.kt` next to the screens (vals share the screens'
  package, so nothing is imported).
- Raster assets land in `drawable-nodpi` with their *real* extension: the
  plugin sniffs the stored bytes' magic header, so an imported JPEG photo is
  `img_banner.jpg` even though the fill may have been requested as PNG.
- The ZIP is a dependency-free "stored" ZIP (no compression, CRC32 included)
  written by the plugin UI itself — see the security notes in
  [security-privacy.md](security-privacy.md).

## Copy into an Android project

1. Open the ZIP; inside `<appName>/app/…` mirrors the Android project layout.
2. Copy the Kotlin files into `app/src/main/java/<package>/` of your project.
3. Copy `res/drawable-nodpi/*` into the same folder of your project
   (`.png` and `.jpg` both work — the extension is real).
4. Generated Kotlin references objects it expects to exist, depending on the
   asset's export format:
   - `Image(imageVector = IcStar)` for ImageVector-format assets — the
     `IcStar` val is defined in the generated `Icons.kt` in the same package;
   - `painterResource(R.drawable.<asset>)` for SVG-file and raster assets
     (`R` is imported from your package; adjust the import line if your `R`
     lives elsewhere);
   - mapped composable symbols (`AppButton`, `ButtonType.Primary`, …) that
     exist in your codebase when you convert in "Existing design system" mode.
5. Paste the generated composable into your `MainActivity` / navigation graph:

```kotlin
setContent {
    MaterialTheme {
        LoginScreen(modifier = Modifier.fillMaxSize())
    }
}
```

Every generated file contains a public `@Composable fun <ScreenName>(modifier:
Modifier = Modifier)` at a known package, so it is call-safe from anywhere.

## Import statements

Generated files import only what they use, sorted and de-duplicated:
`androidx.compose.foundation.*`, `androidx.compose.material3.*`,
`androidx.compose.runtime.*`, `androidx.compose.ui.*`. If a mapped target
expression references something else (`MaterialTheme.typography…`,
`AppButton`, `ButtonType`), add those imports/symbols in your codebase —
the generator copies mapping targets verbatim and does not invent imports for
user-mapped expressions.

## Vector asset formats (SVG / ImageVector / PNG)

Vector assets can be exported in three shapes, chosen globally in
Settings → Asset export (and per curated-library asset via the format
dropdown on its row):

- **SVG** (default): Figma's `exportAsync({ format: 'SVG_STRING' })` output
  lands in the `vectors/` folder as source files. Android can't use `.svg`
  directly; recommended paths:
  1. **Android Studio Vector Asset tool** — File → New → Vector Asset →
     *Local file (SVG)…* to convert `vectors/ic_button.svg` into a
     `res/drawable/ic_button.xml` `VectorDrawable`.
  2. Manual pipeline: run the SVG through `vd-tool` (`vectors/` to
     `drawables/`) or convert via your design-system build step.

  Then align the drawable name with the generated `R.drawable.<name>`
  references.
- **ImageVector**: the SVG source stays inside the plugin and is converted
  into idiomatic Kotlin — a merged `Icons.kt` with one
  `public val <Symbol>: ImageVector` per asset (`ic_star` → `IcStar`),
  screens referencing them with `Image(imageVector = IcStar)`. The
  conversion is pure and exact where exactness is possible: every path
  command becomes `moveTo`/`lineTo`/`curveTo`, quadratic Béziers become
  their exact cubic, arcs become true circle/ellipse cubics (≤90° segments),
  and transforms (translate/scale/rotate/skew matrices) are baked into the
  coordinates at 4-decimal precision. Whatever SVG cannot be represented
  (gradients, `<image>`, `<text>`, clip/mask) is listed by name as a
  `// skipped: …` comment in the file **and** surfaced in the Output
  diagnostics — nothing is silently dropped.
- **PNG**: each vector node is re-rendered at its natural size and written
  to `res/drawable-nodpi/<name>.png` like any raster.

Image fills additionally offer an *auto* mode (default) that keeps the
byte-for-byte original the designer imported — the extension is detected
from the bytes, so JPEG photos stay `.jpg`. `PNG`/`JPG` modes re-render the
node as displayed instead.

PNG image fills are otherwise byte-for-byte the image Figma stored for the
fill hash (`figma.getImageByHash(hash).getBytesAsync()`) and written into
`res/drawable-nodpi/` (nodpi keeps the 1:1 px↔dp mapping used by the
generator).

## Choosing what counts as an asset

**Master switch and formats.** Settings → Asset export controls the whole
pipeline: *Exporting/Off* — off excludes every asset candidate (each node
keeps its geometry and is reported with an `ASSET-EXCLUDED` warning), and
the two format pickers pick what vectors and image fills become (see the
previous section).

By default every image fill and every vector shape (vector/boolean/polygon/
star/arc ellipse) is exported as an asset. When that is too eager — e.g. a
background photo or a stray vector keeps failing its export and you would
rather exclude it — the plugin project settings take **two kind-specific
name prefixes**:

- **Icon prefix** (e.g. `ic_`) gates *vector shapes*. Matching vectors are
  exported as SVGs and referenced through
  `Image(painterResource(R.drawable.ic_…))`.
- **Image prefix** (e.g. `img_`) gates *image fills*. Matching fills are
  exported as PNGs into `drawable-nodpi` and referenced through
  `Modifier.paint(painterResource(R.drawable.img_…))` at the node.

The two prefixes work independently — vectors and image fills gate on their
own kind's field. With a prefix configured for a kind:

- only objects of that kind whose name starts with the prefix
  (case-insensitively) become assets of that kind;
- everything else keeps its geometry but is not exported, and each exclusion
  is reported once with an `ASSET-EXCLUDED` warning;
- the prefix itself is stripped from the resource name, so Figma
  `icon_arrow` becomes drawable `ic_arrow`, and `img_banner` stays
  drawable `img_banner`.

Leave a field empty to restore auto-detection for that kind.

**Beyond prefixes — marks and the asset library.** Three curated tools
complement the prefixes (all persisted; see generation.md for matching
precision):

- **Ignore rules** — an ignore prefix plus "mark as ignored" selections.
  Ignored nodes (e.g. the phone status bar) and their subtrees disappear from
  every conversion: no layout, no assets, one `NODE-IGNORED` info line each.
- **Asset-skip marks** — "skip asset export only": the node keeps its layout
  but exports no asset. Useful for decorative elements whose export keeps
  failing.
- **Asset library** — harvest a dedicated icons/images page (top-level
  layers; sections expand one level). Screen nodes matching an entry — by
  canonical name + type (+ size), or by component master identity — export
  the **canonical** asset from that page (even across pages: the plugin
  loads the source page first, with a fallback to the matched node). Harvest
  a `COMPONENT` icon once and every instance of it on any future screen
  renders as a curated `Image(…)` instead of being decomposed into layout.
  Each library row also has a **format dropdown** (`auto` follows the global
  setting) that lets a single asset take a different export format than the
  rest — e.g. keep one brand mark as SVG while everything else compiles to
  ImageVector code. Raster sources only offer raster formats; the override
  is applied first, and the report records which overrides were active.

## conversion-report.json

A one-file audit trail, useful in PRs — including which formats were active:

```json
{
  "generatedBy": "Compose Studio",
  "mode": "existing-design-system",
  "assetExport": {
    "exportAssets": true,
    "vectorFormat": "imagevector",
    "imageFormat": "auto",
    "overrides": [{ "key": "ic_brand_mark", "fmt": "svg" }]
  },
  "designSystem": {
    "source": "both",
    "structure": "object"
  },
  "diagnostics": [
    { "level": "info", "message": "…", "nodeName": "Save", "nodeKind": "INSTANCE" }
  ],
  "partialExport": false,
  "files": ["LoginScreen.kt", "DesignSystem.kt", "DesignSystem/Theme.kt", "Icons.kt"],
  "imageAssets": [
    { "assetName": "img_hero_photo", "ext": "png" }
  ],
  "vectorAssets": [
    { "assetName": "ic_star_icon", "fmt": "svg" }
  ]
}
```

### Choosing what to export

The **Files & assets** card on the Output tab downloads exactly what you
select — not necessarily the whole conversion — and everything lives in one
place:

* Every **file pill** carries an export checkbox (tick = include in the ZIP;
  the pill button itself still previews), and every **asset preview tile**
  carries a corner checkbox that also toggles when you click the tile.
  Tri-state "Files"/"Assets" masters sit right above the items, and the
  card's export footer holds quick presets — **Everything**, **Files only**,
  **Assets only**, **None** — plus the download button with the live
  selection count (disabled at zero) and the partial/full hint.
* ImageVector-format assets have no standalone file — they compile into
  `Icons.kt` and are exported together with it (their tiles show as pinned
  with a hint; every other asset exports as a real file). That is why the
  Assets subgroup only appears when assets exist, and the whole card opens
  on conversion when there is a Kotlin file or an asset to look at.
* Conversion flows (markers, prefixes, per-entry format overrides) are
  unchanged — the selection applies at download time, and a fresh conversion
  always resets to a full selection.

The report is the **manifest of that ZIP**: `files`/`imageAssets`/
`vectorAssets` list exactly what went in, `partialExport` is `true` when a
subset was chosen, and the full-conversion diagnostics stay unchanged
(diagnostics describe the conversion, not the export).

Every diagnostic in there — and its meaning — is documented in
[limitations.md](limitations.md).
