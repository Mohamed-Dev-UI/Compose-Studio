# Supported features

Status legend:

| Symbol    | Meaning                                                            |
| --------- | -------------------------------------------------------------------- |
| ✅         | reproduced faithfully                                                |
| 👍 / ⚠️     | approximated with a documented diagnostic (see limitations.md)        |
| ❌         | skipped, diagnostic explains why                                     |
| —          | not applicable                                                       |

## Layout

| Figma feature                             | Status | Notes                                                   |
| ----------------------------------------- | ------ | -------------------------------------------------------- |
| Frame                                     | ✅     | becomes `Row`/`Column`/`Box` per auto-layout             |
| Auto-layout HORIZONTAL / VERTICAL         | ✅     |                                                          |
| Auto-layout WRAP                          | ⚠️     | `LAYOUT-WRAP`: children stay single-line                 |
| `SPACE_BETWEEN`, MIN/MAX/CENTER alignment | ✅     | `Arrangement.*`, `Alignment.*`                           |
| `BASELINE` cross alignment (horizontal)   | ✅     | `Alignment.Baseline`                                     |
| Padding                                   | ✅     | collapses to `horizontal=`/`vertical=` where equal        |
| Fixed size / fixed corners                | ✅     | `Modifier.size(w,h)` etc.                                |
| Fill/hug sizing (`layoutSizing*`)         | ✅     | `weight(1f)` / `fillMaxWidth/Height()`                   |
| Absolute-positioned children (`layoutPositioning = ABSOLUTE`) | ✅ | wrapper `Box` hosts the flow stack plus offset children (see generation.md) |
| Group                                     | ✅     | children offset re-based by group origin                 |
| Boolean operation / polygon / star        | 👍 SVG | exported as vector asset                                 |
| clipsContent                              | ✅ / ❌ | root gets `.clipToBounds()`; nested clipping approximated |
| Component set + variants (as property)    | ✅     | variant property available to mappings; the set's masters are harvested so all variants are coded |

## Paints and shapes

| Figma feature                    | Status | Notes                                                |
| -------------------------------- | ------ | ------------------------------------------------------ |
| Solid fill                       | ✅     | `background(color = Color(0x…))`                        |
| Multiple fills                   | ⚠️     | first fill wins; `MULTIPLE-FILLS`                       |
| Gradient fills (linear)          | ⚠️     | axis-snapped `Brush.verticalGradient/linearGradient`    |
| Gradient fills (radial)          | ⚠️     | centered `Brush.radialGradient`; `RADIAL-CENTER`        |
| Gradient fills (angular/diamond) | ❌     | fill omitted + `UNSUPPORTED-FILL`                      |
| Image fills                      | ✅     | PNG asset + `Modifier.paint(...)` or background          |
| Image fill rotation              | ⚠️     | `IMAGE-ROTATION`                                        |
| Stroke / border                  | ✅     | solid stroke → `.border(...)`; inside-aligned           |
| Dashes strokes                   | ⚠️     | `DASHED-BORDER`: solid border emitted                   |
| Stroke align (outside/center)    | ⚠️     | `STROKE-ALIGN`: inside border approximated              |
| Corner radius (uniform/corners)  | ✅     | `RoundedCornerShape(...)` / `CircleShape`               |
| Individual corner radii          | ✅     | `topStart/topEnd/bottomEnd/bottomStart`                 |
| Drop shadow (single)             | ✅     | `Modifier.shadow(elevation, shape)`                     |
| Multiple shadows                 | ⚠️     | `MULTIPLE-SHADOWS`: only first                          |
| Shadow spread/offset             | ⚠️     | `EFFECT-SPREAD`, `SHADOW-OFFSET`                        |
| Inner shadow, blur               | ❌     | `UNSUPPORTED-EFFECT`                                    |
| Opacity                          | ✅     | `.alpha(x)` when < 1                                    |
| Blend modes                      | ❌     | ignored                                                 |
| Arc/pie ellipses                 | 👍 SVG | `SVG-REQUIRED`                                          |
| LINE                             | ✅     | thin `Box` with stroke background; `LINE-NO-STROKE` when strokeless |

## Text

| Figma feature                        | Status | Notes                                          |
| ------------------------------------ | ------ | ------------------------------------------------ |
| Text node                            | ✅     | `material3.Text`                                  |
| Single-style typography              | ✅     | inline `TextStyle(...)`                            |
| Mixed styles in one text node        | ⚠️     | `MIXED-TEXT-STYLES`: first style wins              |
| Fonts family mapping                 | ✅     | profile `fonts`/`textStyles`; else `FontFamily.Default` + `FONT-NOT-MAPPED` |
| Weight / italic                      | ✅     | number clamp + named styles (`Bold`, `Light`, …)    |
| Line height / letter spacing (px)    | ✅     | `sp`                                                |
| Letter spacing (%)                   | ⚠️     | requires font size to convert; omitted otherwise    |
| Underline / strikethrough            | ✅     | `TextDecoration.Underline/LineThrough`              |
| Text align                           | ✅     | `TextAlign.End/Center/Justified` for non-LEFT       |
| Truncate (`textAutoResize` TRUNCATE) | ✅     | `overflow = TextOverflow.Ellipsis`                  |
| Case transform                       | ✅     | UPPER/LOWER/TITLE rendered into the literal         |
| Text style (Figma library) reference | ⚠️     | read via `getStyledTextSegments`; ids are not dereferenced |
| Vertical align inside fixed-height text box | ✅ | `wrapContentHeight`                              |

## Components, instances and mappings

| Figma feature                          | Status | Notes                                                     |
| -------------------------------------- | ------ | ------------------------------------------------------------ |
| Instance of local component            | ✅     | mapped to a composable or plain layout                        |
| Curated component as asset            | ✅     | harvest the master on an asset page; its instances render as `Image` instead of being decomposed |
| Auto-generated component per instance  | ✅     | standalone instances generate their own composable file + parameterized call (no mapping needed) |
| Variant properties                     | ✅     | exposed to `variantProp` mapping arguments; auto-generated components code **every variant of the set** (masters harvested from the source, not just instantiated ones) and structure the bodies per the *Variant code shape* setting: `auto` picks per component (typed value parameters for near-identical variants, the `when` in between, one composable per variant for divergent bodies), or force `when` / per-variant `functions` / an `object` grouping; variant parameters (`Boolean` for True/False keys, `enum class`/`sealed interface` otherwise, strings as legacy) apply to the `when` tier |
| Component `TEXT` properties            | ✅     | auto-generated components take them as `String` parameters (body substitution) |
| Component `BOOLEAN`/swap properties    | ⚠️     | reported (`COMPONENT-PROP-UNSUPPORTED`), reference content used               |
| Nested instance inside instance        | ✅     | recursive conversion                                          |
| Overridden text in instance            | ✅     | text arguments read the overridden value                      |
| Component mapping arg sources          | ✅     | `text`, `icon`, `color`, `constant`, `variantProp`, `modifier`, `content` |
| Component configuration description    | ✅     | a `compose-studio:` block in the component description: `role` mints parameters (`onClick` & friends, Material `Card`/`Button`/`FAB` when the look matches exactly, ripple-free clickable otherwise), `kind`/`assets` turn instances into exported assets without name prefixes, `assets: code` forces code, and `mapping`/`mappingArgs` call an app composable. The Config tab edits it visually (presets, mixed multi-selection overrides, component sets treated per the shared strip: one component with variants, frame with content, or frame of components), the Guide tab documents it |
| nodeType fallback mappings             | ✅     | e.g. all `text` nodes → your `StyledText` composable           |
| Color mapping (variable id/name, hex)  | ✅     | documented precedence in generation.md                       |
| Design-token resolution (variables)    | ✅     | local Figma variables resolved to IR token references         |

## Assets and conversion infrastructure

| Capability                               | Status | Notes                                             |
| ----------------------------------------- | ------ | --------------------------------------------------- |
| PNG export (image hashes)                 | ✅     | via `figma.getImageByHash(hash).getBytesAsync()`    |
| SVG export                                | ✅     | via `node.exportAsync('SVG_STRING')`                |
| Deterministic asset naming                | ✅     | snake_case `ic_`/`img_` prefixes, collision suffixes; kind-specific name filters (icon prefix for vectors, image prefix for PNG fills; `ASSET-EXCLUDED` when filtered) |
| Ignore rules (prefix + exact marks)       | ✅     | `_ignore`-style prefix or marked nodes skip their whole subtree (`NODE-IGNORED`); marks match by name + type + size, components by master id |
| Asset-skip marks                          | ✅     | keep the layout, drop the asset (`ASSET-EXCLUDED` with the reason)  |
| Asset page (curated library)              | ✅     | harvest a dedicated icons/images page; matching screen nodes export the canonical asset, curated component instances render as `Image` |
| Cross-page asset sources                  | ✅     | library exports load the source page first (`PageNode.loadAsync`) and fall back to the matched node |
| Diagnostics                               | ✅     | every skipped/approximated fact gets a stable code; clickable severity filters in the UI |
| ZIP export                                | ✅     | dependency-free stored ZIP with CRC32                |
| Mapping profile import/export             | ✅     | JSON (schema versioned)                              |
| Determinism                               | ✅     | same input = byte-identical output                   |

## Design system (tokens as code)

Opt-in via Settings → *Design system as code* (`off` by default); emits one
Kotlin accessor object `DesignSystem.kt` next to the screens — every token
family sits in its own section object — plus matched-slots `Theme.kt` in
the material structures. See [generation.md](generation.md) for the
emission rules.

| Capability                               | Status  | Notes                                             |
| ----------------------------------------- | ------- | --------------------------------------------------- |
| Variable collections (COLOR/FLOAT/STRING/BOOLEAN) | ✅ | resolved per mode: single-mode collections at the default mode, multi-mode collections emit every mode inside nested wrapper objects (`Colors.Light.Surface` / `Colors.Dark.Surface`); one `DS-MODES` note per multi-mode collection |
| Variable aliases                          | ✅/⚠️   | followed exactly one hop into local variables; published-library targets or deeper chains → `DS-ALIAS` |
| Paint styles                              | ✅/⚠️   | first visible solid wins; gradients keep their first stop (`DS-GRADIENT`); image-only styles → `DS-SKIPPED` |
| Text styles                               | ✅/⚠️   | `TextStyle` vals; family classified by name hints; percent spacing resolved against font size decorations/text case not represented |
| Effect styles                             | ❌      | `DS-SKIPPED` — effects become runtime modifiers, not constants |
| NUMBER unit choice                        | ✅/⚠️   | `dp` by default, `sp` when the path hints at typography (documented heuristic) |
| Naming                                     | ✅      | path flattening (`brand/primary` → `BrandPrimary`), wrapper prefixes dropped (`Color/Base/Black` → `BaseBlack`, KDoc keeps the original path), collision suffixes scoped to the Kotlin lexical scope (section object / mode wrapper; sibling scopes share symbols) |
| Font-weight variables                      | ✅/⚠️   | `weight`-word path + integer 1..1000 → `FontWeight` vals in `Type` (aliases for 100..900, exact `FontWeight(650)` otherwise); matching text styles reference the variable through its wrapper when one exists (`fontWeight = Light.WeightHeadline`) — no token refs inside `Theme.kt` |
| Empty / unrepresentable sources            | ✅      | `DS-EMPTY` INFO without file; every skip gets an honest diagnostic |
| Structure modes                            | ✅      | `object` accessor (default) / `material` artifacts (values assigned directly) / `material-theme` composable |
| File layout                                | ✅      | one object-wrapped `DesignSystem.kt` (sections per family, empty ones fold away); `Theme.kt` only when something matched |
| Material 3 slot matching                   | ✅/⚠️   | auto by token-name suffix (31 color roles, 15 typography slots); exact-value ties prefer the collection's default mode; unmatched tokens stay plain vals |
| Usage-derived tokens (`dsUsage`)           | ✅/⚠️   | opt-in; tokens minted from values repeating across the frames (≥ `dsUsageMin`, default `2`) with dominant-context names; slot-correct substitution in screens; heuristics can miss or misname below a strict majority |

### Choosing what to export

The Output tab's **Files & assets** card downloads exactly the selected
files and assets — selected directly on the previews (a checkbox on every
file pill and every asset tile, with tri-state masters above the items),
plus quick presets and the download button in the card's export footer.
ImageVector assets ride via `Icons.kt`; the report is a manifest of
the exported ZIP and flags `partialExport` on subsets. See
[export-and-android.md](export-and-android.md).

Future phases (scaffolded, not implemented): a full mapping-rule editor with
argument previews per component, spacing maps, per-screen shared element
hints, and Figma plugin command variants. See limitations.md for the current
phase-1 contract.
