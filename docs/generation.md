# Code generation conventions

This document describes exactly what Compose Studio emits. The generator
(`src/gen/generate.ts`) is deterministic: identical IR documents with an
identical mapping profile always produce byte-identical Kotlin.

For gaps and the meaning of every diagnostic code see [limitations.md](limitations.md).

## Pipeline

```
Figma selection
  └─ Extractor (src/extract)        → IR v1 documents (src/ir)
       └─ Mapping resolver (src/mapping) → typed mapping hits or null
            └─ Generator (src/gen)  → Kotlin files + asset manifest + diagnostics
                 └─ Plugin sandbox (src/main.ts) → PNG bytes / SVG text
                      └─ Plugin UI (src/ui) → preview, report, ZIP
```

Every stage takes plain data in and returns plain data out, so each can be
unit-tested in Node without the `figma` global (see `test/`).

## Value conventions

| Figma value                  | Emitted as                            |
| ---------------------------- | ------------------------------------- |
| `1 px` length                | `1.dp`                                |
| font size                    | `sp` (`fontSize = 24.sp`)             |
| line height / letter spacing | `sp`                                  |
| alpha 0..1                   | first byte of the ARGB literal        |

Numbers are printed with up to two decimals and trailing zeros are trimmed
(`16`, `16.5`). Figma pixels map 1:1 onto Compose `dp` at the design density
Android uses for mock-based layout; Figma font sizes become `sp` so the OS text
scale still applies.

## Figma type mapping

| Figma                              | Compose                                      |
| ---------------------------------- | -------------------------------------------- |
| Auto-layout `HORIZONTAL` frame     | `Row`                                        |
| Auto-layout `VERTICAL` frame       | `Column`                                     |
| Auto-layout `WRAP`                 | `Row`/`Column` + `LAYOUT-WRAP` diagnostic    |
| Plain frame / group                | `Box`                                        |
| `clipsContent` frame (root)        | `Box` + `.clipToBounds()`                    |
| `TEXT`                             | `androidx.compose.material3.Text`            |
| `RECTANGLE` / `ELLIPSE`            | `Box` carrying the shape/background modifiers |
| `LINE`                             | thin `Box` sized by its stroke               |
| `VECTOR`, boolean ops, polygons    | `Image(painterResource(R.drawable.…))` (SVG) |
| Arc/pie `ELLIPSE`                  | SVG asset + `SVG-REQUIRED`                   |
| `INSTANCE` (unmapped)              | `Box` over its children + info diagnostic    |
| `INSTANCE` (mapped)                | the mapped composable call                   |
| Anything else                      | skipped + `UNSUPPORTED-NODE`                 |

## Layout / sizing semantics

- `layoutSizingHorizontal/Vertical === 'FILL'` (or `AUTO` on the main axis)
  inside an auto-layout parent becomes `weight(1f)` on that axis or
  `fillMaxWidth()` / `fillMaxHeight()`.
- Everything else materializes as explicit `size(w, h)` from the Figma bounds.
  Roots always carry the explicit selection size so the screen does not
  collapse.
- Main-axis alignment maps `MIN/CENTER/MAX/SPACE_BETWEEN`
  onto `Arrangement.Start/CenterVertically/End/SpaceBetween`;
  cross-axis alignment maps to `verticalAlignment` (Row) / `horizontalAlignment`
  (Column).
- Per-child absolute offsets become `Modifier.offset(x, y)` **only inside Box
  parents**: in a Row/Column they would shift the flow, and weights/arrangement
  then take care of spacing.

### Absolute-positioned children ("ignore auto-layout")

A child with `layoutPositioning === 'ABSOLUTE'` (the Figma *absolute position*
toggle) deliberately ignores the parent auto-layout and places itself at its
explicit x/y. Compose `Row`/`Column` cannot express that, so the generator
decomposes the frame into a wrapper `Box`:

```
Box(frame decoration: size/clip/background/… — *without* padding) {
    Row/Column(Modifier[.fillMaxSize()][.padding(…)]) {  // arrangement moves here
        … auto-layout flow children …
    }
    Box(Modifier.offset(x, y)[.size(…)]…)                // each absolute child
}
```

Rules:

- The frame's **padding and arrangement live on the inner Row/Column** — Figma
  insets only flow children, and absolute children are positioned relative to
  the frame bounds, not the content box.
- The inner stack carries `Modifier.fillMaxSize()` when the wrapper ends up
  with an explicit size/weight/fill constraint (which is the case whenever the
  frame has a fixed size — including every root screen).
- Each absolute child keeps its full modifier chain (size, background, …) and
  gains `Modifier.offset(x, y)` because, as a Box child, that modifier is
  meaningful again.
- Mapped component calls are decomposed the same way inside their content
  lambda.
- Extraction reports one `ABSOLUTE-POSITION` info per flagged node.

Real sample (a VERTICAL panel with a flow title and an absolute badge at
`x: 24, y: 40`):

```kotlin
    Box(
        modifier = Modifier
            .size(360.dp, 200.dp)
            .clipToBounds(),
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(all = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text = "Flow child", …)
        }
        Box(
            modifier = Modifier
                .size(60.dp, 40.dp)
                .offset(24.dp, 40.dp),
        )
    }
```

(Lines 1–3 are the selection root; the samples in this section are regenerated
by `scripts/sample-docs.mts`.)

## Modifier canonical order

Every emitted chain follows one canonical order, fixed in
`src/gen/build-modifiers.ts` (also in `src/gen/modifiers.ts`):

```
weight -> (fill / size) -> wrapContentHeight -> offset -> align
  -> shadow -> clip -> border -> background -> paint -> padding -> alpha
```

Why this order matters in Compose:

1. Stretch/sizing first so later chains reason about the final box.
2. Alignment and offset position that box inside its parent scope.
3. Shadow, clip, border, background and paint share the same *shape target*
   (`CircleShape` or `RoundedCornerShape(...)`), so they are grouped
   immediately after the geometry chips.
4. Padding shrinks the content area last (Figma auto-layout padding lives
   inside the container), matching Compose's expectation that
   `background(...).padding(...)` paints up to the border before insetting.
5. `alpha` decorates the complete result.

The modifier parameter itself is rendered as `modifier = modifier.<chip>` on
the root element so callers can wrap the screen; children use
`Modifier.<chip>…`. Chips are one per line with trailing commas.

Padding collapses shared sides: `.padding(all = 16.dp)`, `.padding(horizontal
= 8.dp)`, `.padding(vertical = 8.dp)` or a combination.

## Color resolution

`src/gen/emit-context.ts` resolves every `IrColor` in this order:

1. Profile color mapping (see below) — highest precedence.
2. Literal packing: `Color(0xFFFFFFFF)` (ARGB with alpha first; Figma colors
   are converted with alpha applied).

Tokens collected from Figma variables (`src/tokens/collect.ts`) attach a
`variableId`/`variableName` to the IR color so they can participate in the
mapping instead of resolving to the baked value at extraction time. If the
variable reference cannot be resolved the extractor reports
`UNRESOLVED-VARIABLE` and the literal is used.

## Text

* Text nodes render as `material3.Text` with `color` from the first text span
  fill, plus `textAlign` (when not `LEFT`) and `overflow` (`textAutoResize`
  `TRUNCATE`).
* Mixed styles within one text node are collapsed to the first span's style
  and logged via `MIXED-TEXT-STYLES`.
* `fontFamily` resolves through the profile fonts mapping. Without a match the
  renderer emits `FontFamily.Default` and (when a profile is active) raises
  `FONT-NOT-MAPPED` once per family.
* Inline `TextStyle(fontSize, fontWeight, fontStyle, fontFamily, lineHeight,
  letterSpacing, textDecoration)` is emitted unless a profile text-style
  mapping matched — then only `style = <target>` is emitted and every inline
  arg is skipped.

Empty text nodes are skipped (`TEXT-EMPTY`).

## Mapping profiles

A mapping profile (`src/mapping/profile.ts`) carries four result lists:

```jsonc
{
  "schemaVersion": 1,
  "profileName": "My project",
  "colors":     [{ "source": { "kind": "variable", "name": "Brand/Primary" }, "target": "Color(0xFF4F46E5)" }],
  "fonts":      [{ "source": { "kind": "family", "name": "Roboto" }, "target": "AppTypography" }],
  "textStyles": [{ "source": { "kind": "fontFamily", "name": "Inter" },
                   "target": "MaterialTheme.typography.bodyMedium" }],
  "components": [{ "source": { "kind": "component", "componentName": "Button" }, "target": { "symbol": "AppButton" } }]
}
```

Resolution precedence, implemented top-to-bottom in `src/mapping/resolve.ts`:

| List         | First match wins                                                                     | Fallback                     |
| ------------ | -------------------------------------------------------------------------------------- | ---------------------------- |
| `colors`     | variable **id** exact → variable **name** exact → hex (case-insensitive)                | literal `Color(0x…)`         |
| `fonts`      | family name exact                                                                       | `FontFamily.Default`         |
| `textStyles` | fontFamily + fontSize exact → fontFamily only                                            | inline `TextStyle(…)`        |
| `components` | component **key** (master id) → component name (case-insensitive) → nodeType             | plain `Box`/default emitters |

Targets are arbitrary Kotlin expressions — the generator never rounds here, it
copies them verbatim into emitted code. Anything unknown gets a diagnostic not
a silent replacement.

### Component mapping arguments

A component mapping describes how to turn a design subtree into arguments of
the target composable:

| Source kind    | Emitted argument value                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `text`         | contents of the Nth text node (`childIndex`, document order)                                      |
| `icon`         | `painterResource(R.drawable.ic_…)` for the Nth vector child (document order)                       |
| `color`        | the resolved color expression of the first text fill or solid background                          |
| `constant`     | Kotlin literal: `true`/`false`/numbers raw, other strings quoted and escaped                      |
| `variantProp`  | mapped enum case of the instance's Figma variant property                                         |
| `modifier`     | receives the composed modifier chain of the instance                                              |
| `content`      | trailing lambda; children of the instance are rendered inside it                                  |

Rules:

- With no `modifier` argument in the mapping, the instance's modifier chain is
  appended to the call automatically and `MAPPING-INJECTED-MODIFIER` is raised.
- With no `content` argument, the instance's children are *not* rendered and
  `INSTANCE-CHILDREN-OMITTED` is raised.
- When an argument source cannot resolve (e.g. no Nth text child) the argument
  is omitted; `MAPPING-ARG-MISSING` (INFO) is raised, or
  `MAPPING-ARG-DEFAULTED` when the mapping defines a default.

## Auto-generated components (standalone mode)

In standalone mode (no profile `components` mapping matching an instance) the
conversion normally expands the instance as plain layout. When the instance
carries component data — which Figma exposes per instance — the generator
instead produces a **dedicated composable file** and reduces the call site to
a parameterized call. Profile mappings always win: mapped instances never
generate files.

How the data is gathered: the sandbox resolves each instance's master via
`getMainComponentAsync()`, then (both guarded) reads the master's component
set parent and the instance's component property values. Without those
snapshots (e.g. old access mode) the legacy plain-layout fallback applies.
All of this works under `documentAccess: 'dynamic-page'`.

Grouping and parameter derivation:

| Concept                     | Rule                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Group                       | instances of the same component **set** (one composable per set); per-master when no set               |
| Reference body              | first instance of each master (document order) is extracted as that variant's body; masters the selection never instantiated are harvested from the component set the same way (see below) |
| Variant parameters          | **typed by default**: True/False variants become `Boolean`; every other key gets an `enum class` (or a `sealed interface`, user's choice); plain `String` is the legacy option |
| `TEXT` component properties | one `String` per property; body node with matching text renders `text = <param>`; calls pass values    |
| `BOOLEAN` / swap properties | not parameterized (body content cannot be reconstructed); reported, listed in diagnostics              |
| Modifier                    | first parameter, `Modifier = Modifier`; the call site injects the instance's geometry chain            |

Variant parameters (plugin setting "Variant parameters", default **enum**;
they apply whenever the component keeps variant-key parameters — the `when`
tier of *Variant code shape* and single-variant components):

- `enum` — one `enum class` per variant key, named `<ComponentSet><Key>`
  (`Button` + `size` → `ButtonSize`); entries are UPPER_SNAKE values
  (`xl` → `XL`). Call sites stay type-safe: `size = ButtonSize.XL`.
- `sealed` — a `sealed interface` with one `object` per value
  (`object Primary : ButtonType`), useful when app code wants exhaustive
  `when` handling over custom states.
- `string` — plain string parameters, the pre-typing behavior.
- Regardless of style, variant keys whose values are exactly True/False
  (Figma's toggle-style variant properties, e.g. `Destructive`) become
  `Boolean` parameters (`destructive: Boolean = false`).
- Boolean-like keys stay Boolean even with enum/sealed; they are never
  wrapped in a synthetic enum.

Multi-variant families are coded from the **whole component set**: the
plugin looks up the set behind every resolved instance, walks its masters
(async, dynamic-page safe), and extracts every master the selection never
instantiated as a "virtual" reference body — so all variants of a component
in use get coded, not just the ones present in the selection
(`COMPONENT-VARIANT-SOURCE`). Masters that carry an ignore mark, that fail
to extract, or that have no `Key=Value` name (plain components) are skipped
and reported.

The body structure follows the plugin setting **Variant code shape**
(`variantShape`, default **auto**):

- `when` — the classic parameterized composable: variant keys stay
  parameters and a `when` inside a wrapper `Box(modifier = modifier)` picks
  each master's body. Each master becomes a branch; the enum/sealed types
  follow the *Variant parameters* setting:

```kotlin
enum class ButtonSize { MD, XL }

@Composable
fun Button(
    modifier: Modifier = Modifier,
    destructive: Boolean = false,
    size: ButtonSize = ButtonSize.XL,
) {
    Box(modifier = modifier) {
        when (destructive to size) {
            false to ButtonSize.XL -> {
                Box(modifier = Modifier.size(320.dp, 48.dp)) {
                    Text(
                        text = "Sign In",
                        modifier = Modifier.background(color = Color(0xFF000000)),
                        color = Color(0xFF000000),
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal, fontFamily = FontFamily.Default, lineHeight = 20.sp, letterSpacing = 0.sp),
                    )
                }
            }
            true to ButtonSize.MD -> {
                /* the Destructive=True Size=md master's body, same shape */
            }
        }
    }
}

// at the call site:
Button(
    modifier = Modifier
        .size(320.dp, 48.dp)
        .offset(0.dp, 80.dp),
    destructive = true,
    size = ButtonSize.MD,
)
```

Because typed parameters make the `when` arms compile-time constants, invalid
variant combinations are impossible to express at call sites without a type
error — the compiler, not a string, enforces which variants exist.

- `auto` (default) — the plugin renders each master's body to scratch
  (substitutions canonicalized so text parameters compare fairly) and
  compares the bodies line by line with value tokens erased, then picks the
  best structure itself:

  - **near-identical variants → one composable with typed value
    parameters (`params`)**: when the differences are pure value tokens
    (colors, `.dp`/`.sp` sizes, booleans, strings, weights) and stay small —
    at most 3 differing lines or 35% of the body, and at most 6 lifted
    tokens — the plugin lifts them into typed parameters with the reference
    variant's literals as defaults and omits the variant-key parameters and
    their types entirely (`COMPONENT-VARIANT-PARAMS`). Call sites pass only
    the values that differ from the default:

    ```kotlin
    @Composable
    fun Button(
        modifier: Modifier = Modifier,
        text: String = "Sign In",
    ) {
        Box(modifier = modifier.size(320.dp, 48.dp)) {
            Text(
                text = text,
                modifier = Modifier.background(color = Color(0xFF000000)),
                color = Color(0xFF000000),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal, fontFamily = FontFamily.Default, lineHeight = 20.sp, letterSpacing = 0.sp),
            )
        }
    }

    // at the call site (only the value that differs from the default):
    Button(modifier = Modifier.size(320.dp, 48.dp))              /* reference variant */
    Button(modifier = Modifier…offset(0.dp, 80.dp), text = "Sign Up")
    ```

    Parameter names come from the argument name on the emitted line
    (`color =`, `padding(all =)`) or the enclosing call (`Modifier.size(…)`
    → `size`), deduplicated deterministically. Value slots that a TEXT
    component property already parameterizes stay owned by that property's
    `label`-style parameter — the planner never mints a second, overlapping
    text parameter (its per-master values ride the `label` chips instead).

  - **divergent variants → one composable per variant (`functions`)**: when
    the bodies are structurally different in 55% or more of their lines,
    every variant gets its own top-level composable named
    `<Component><PascalCase values>` (`ButtonLargePrimary`,
    `ButtonSmallPressed`, …) and call sites call the variant directly
    (`COMPONENT-VARIANT-FUNCTIONS`).

  - **everything in between → the `when`** keeps the variant-key parameters
    (the classic structure shown above).

- `functions` / `object` — always explode, regardless of how small the
  differences are: `functions` emits the per-variant top-level composables
  described above; `object` nests the same per-variant composables inside
  `object <Component>` so call sites read `Button.LargePrimary(...)`. These
  two shapes mint no variant-key enum/sealed types and no variant parameters
  — the variant identity is baked into the function name; `TEXT` component
  properties stay `String` parameters on every variant function.

Restrictions that remain (see also limitations.md): with a single variant
the generated composable keeps its parameter but always renders that
variant's content (`COMPONENT-VARIANT-SINGLE`); component properties of kind
BOOLEAN / instance-swap are declared but not parameterized
(`COMPONENT-PROP-UNSUPPORTED`); enum/sealed entry names come from the
whole component set plus the converted values, so a variant value that
exists neither in the set nor in the selection cannot be selected at a call
site (by design — the plugin can only emit what it has seen).


## Component configuration descriptions (CCD)

A Figma component can carry a machine-readable **configuration block inside
its own `description`** that tells the plugin how to treat every instance of
that component, without name prefixes or global settings. The block is a tiny
flat YAML subset after a `compose-studio:` marker line; any prose above it
(styling notes etc.) is preserved when the plugin rewrites the block.

```text
compose-studio:
role: card
kind: icon            # optional: make every instance an asset
assets: auto          # auto | export | code
implementation: auto  # auto | custom
mapping: MyAppCard    # optional: call an app composable instead
mappingArgs: title="Sign In", icon=@icon
note: human note, copied into the generated file
```

| Key              | Values / shape                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `version`        | config format version; today `1` (a newer value still parses, with a report)   |
| `role`           | see the role table below                                                       |
| `kind`           | `icon` \| `image` \| `vector` — every instance of the component exports as an asset; no name prefix needed |
| `assets`         | `auto` (default) \| `export` (the whole component exports as an asset instead of code) \| `code` (always code, never an asset — overrides `kind`) |
| `implementation` | `auto` (Material composable when the look can be matched exactly) \| `custom` (always the plain emission) |
| `mapping`        | Kotlin symbol (simple or `pkg.Named`) of an app composable; instances call it   |
| `mappingArgs`    | comma list of `arg=value`; sources `@text` (first text), `@icon`, `@color`, `@content` (content lambda), `@modifier`; anything else is a constant Kotlin expression (`42`, `0.8f`, `"quoted"`; quotation is optional for plain words) |
| `note`           | free text; emitted as a comment above the composable                            |

Lines starting with `#` are comments; unknown keys or values are reported
(`COMPONENT-CONFIG-INVALID` as a plugin diagnostic, plus an in-editor note)
and skipped without aborting the parse. The exact template is available in
the plugin UI (Config tab → advanced raw-text editor, or **Copy block** from
an unconfigured component).

### Roles

`role` mints role-specific parameters on the generated composable. All
defaults are inert so generated call sites stay unchanged; app code overrides
them where behavior is wanted:

| Role                    | Parameters minted                                                              |
| ----------------------- | ------------------------------------------------------------------------------ |
| `button`                | `onClick: () -> Unit = { }`, `enabled: Boolean = true`                          |
| `card`                  | `onClick: () -> Unit = { }`                                                     |
| `fab`                   | `onClick: () -> Unit = { }`                                                     |
| `slider`                | `value: Float = 0f`, `onValueChange: (Float) -> Unit = { }`, `enabled = true`    |
| `switch` / `checkbox`   | `checked: Boolean = false`, `onCheckedChange: (Boolean) -> Unit = { }`          |
| `chip`                  | `onClick: () -> Unit = { }`, `selected: Boolean = false`                        |
| `input`                 | `value: String = ""`, `onValueChange: (String) -> Unit = { }`, `enabled = true`  |
| `progress`              | `progress: Float = 0f`                                                          |
| `listitem`              | `onClick: () -> Unit = { }`                                                     |
| `badge` / `avatar` / `divider` | none (visual only)                                                       |

Implementation behavior per role:

- **Material 3 implementation** — only `card`, `button`, `fab` and only when
  the design's look can be matched exactly: a single solid background fill,
  no extra paints, no shadow, no border, uniform corner radius,
  `clipsContent` on whenever the radius is nonzero, and no
  absolute-positioned children (`fab` additionally requires a circular
  shape). On a match the root goes through `Card` / `Button` /
  `FloatingActionButton`: the background and radius move into
  `colors`/`shape` arguments, elevation is pinned to `0.dp` so the static
  look is identical, `Button` gets `contentPadding = PaddingValues(0.dp)`,
  and the children/role parameters (like `onClick`) flow into the call
  (`COMPONENT-CONFIG-ROLE`). `implementation: custom` skips the attempt
  deliberately.
- **Custom fallback** — for `card`, `button`, `fab`, `listitem` without an
  exact look match, the plain emission stays but its root modifier gains a
  placed-first, **ripple-free** `clickable(onClick = …, enabled = …,
  indication = null, interactionSource = remember { MutableInteractionSource() })`
  (ripple off so the static look is unchanged; a default ripple would change
  the visuals). Other roles keep their minted parameters only.
- Role parameter names participate in the variant-lift deduplication, and
  conflicting configurations across a set's variants warn once
  (`COMPONENT-CONFIG-CONFLICT`) with the first configured master winning.

### How directives combine with other generation rules

Precedence, highest first: user marks (skip / ignore) → mapping profile →
configuration mapping → configuration `kind`/`assets` directives → curated
asset library → auto-component generation.

- `mapping:` (or a profile mapping) routes instances to the app composable;
  no auto component file is generated for them. Mapping therefore outranks
  `kind`/`assets` directives and the extractor keeps the subtree for mapped
  instances (the mapped call's `@text`/`@icon` argument sources resolve from
  it) — an instance may still be exported as an asset by other rules.
- `kind:` or `assets: export` render each instance as an `Image` over an
  exported asset of the whole instance node; the subtree is excluded from
  code generation entirely (no stray strings/messages). The example
  component named "HeroCard" produces `R.drawable.ic_herocard` (the same
  snake_case rules as normal assets, without any prefix requirement).
  Asset-skip marks and the global 'Export assets' setting still veto the
  export honestly (layout is kept, not silently dropped).
- `assets: code` suppresses both the asset directive and the curated-library
  branch, and the component keeps its full code emission even when prefix
  or library rules would normally make it an asset.
- With no configuration, everything behaves exactly as in previous
  revisions.

### Plugin UI editor (Config tab)

Selecting instances or components fills the **Config** tab with a single
visual editor for the whole selection (every selection node resolves to its
master component first; multiple selection nodes pointing at one master show
once). Instead of editing text, fields are parsed-config controls:

| Field                        | Control                                       |
| ---------------------------- | --------------------------------------------- |
| Role                         | dropdown of all 13 roles + `none`             |
| Asset kind                   | `none` / `icon` / `image` / `vector` segments |
| Assets policy                | `auto` / `export` / `code` segments           |
| Implementation               | `auto` / `custom` (only when the role is `card` / `button` / `fab`) |
| Mapping                      | text input; seeded with a Kotlin function name derived from the component name (`Working Level` → `WorkingLevel`) whenever the component carries no mapping — edit or clear it, nothing is written until **Apply**; mapping arguments get a row editor (name + source + constant value). The rows and the *+ Add argument* button unlock the moment the mapping is set; until then the button renders disabled with a tooltip and a hint explains that a mapping is required |
| Note                         | free-text area                                |

Actions per editor: **Apply** (writes prose + rendered block per component,
prose preserved), **Remove** / **Remove from all** (strips the block, keeps
prose), **Copy block** (single-selection; keeps the plugin-agnostic
copy-paste path for Figma sandboxes that refuse description writes) and a
collapsed **Edit as raw text** advanced editor that applies text verbatim so
hand-written comments survive. Apply with every field at its default clears
the block instead of writing a bare marker.

**Multi-component behavior.** When several components are selected and they
disagree on a field, that control shows a *multiple values* chip listing the
distinct values and no value is active. Leaving it untouched keeps each
component's own value on Apply; setting it once overrides it on **all**
selected components. Untouched-but-shared fields (and per-component parse
issues listed above the fields) keep applying per component.

**Presets.** The plugin ships built-in starters (marked ★: Material Button /
Card / Fab, icon and image assets, and an all-defaults reset) so new users
have starting points without saving anything first. *Save current…* captures
the values Apply would write (mixed fields fall back to the first configured
component's value) under a name and persists it in Figma client storage (up
to 30, same-name saves replace). Picking a preset from the dropdown loads its
values into the editor fields — nothing reaches a component until **Apply**.
*Delete* removes the preset; built-in starters cannot be deleted (a save
under the same name shadows one, and deleting it brings the starter back).

The **Guide** tab documents the block format, roles, Material rules, asset
directives, mapping sources, mixed-selection semantics and presets (including
the shipped starters and the mapping auto-suggestion, which is a starting
point only — Apply is what writes). Component
*sets* are still not edited — select a variant master or the master component
itself instead. Figma's known description-display lag applies to UI writes
exactly as to manual edits — the block applies immediately at generation
time; the published page text updates on the next re-publish. Because the
visual editor rewrites the block text from parsed values (not the original
lines), comments inside a block written by the visual editor fall back to the
defaults; the raw-text advanced editor keeps them verbatim.

## Ignore rules, asset-skip marks and the asset library

The plugin keeps a user-curated "curation" state in Figma client storage
(survives sessions):

| Tool                    | Effect on conversions                                                                                                | Where it comes from                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Ignore prefix**       | nodes whose name starts with it (case-insensitive) — **and their whole subtrees** — are skipped entirely               | a project setting (`ignorePrefix`), e.g. `_ignore` |
| **Ignore marks**        | exact node identities kept on a list; matching nodes and their subtrees are skipped entirely                          | "Ignore selected" button (marks persist)   |
| **Asset-skip marks**    | matched nodes **keep their layout** but export **no asset** (any format)                                               | "Skip asset export" button (marks persist) |
| **Asset library**       | canonical assets harvested from dedicated asset pages; matching screen nodes export/render the canonical asset        | "Harvest page" button (by page)            |

Because ignoring happens at extraction, an ignored node produces no IR, no
children, no assets and a single `NODE-IGNORED` info diagnostic (per matched
node) — status bars, watermarks and helper frames disappear cleanly.

**Matching precision (no accidental name collisions):** marks store the
node's name, type and size plus — for components and instances — the master
component id, so they match exactly like the marked design:

| Mark kind                     | Matches a node when…                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Component/instance mark       | the candidate's master component id equals the marked one (variants included), or name + type + size all match |
| Plain node mark               | name, node type and size match (sizes within 0.75 px; name-only when the node had no geometry) |
| Prefix rule                   | the name starts with the prefix (case-insensitive)                                    |

The same matching is used for asset-skip marks, so a same-named but
differently-sized node is never skipped by accident.

**Asset library harvest** ("Asset page" in the plugin): pick a page — often a
designer's dedicated icons or images page — and harvest it. Top-level layers
become library entries (top-level `SECTION`s expand one level): nodes with an
image fill become PNG entries, everything else an SVG entry. `COMPONENT`
masters record their master id, so **their instances on any screen render as
`Image`** (not expanded layout) and export the canonical asset. Re-harvesting
the same page refreshes entries instead of duplicating; ignore rules apply at
harvest time too.

Library matching on a screen (id-space, deterministic):

1. exact master identity (curated components → their instances), then
2. canonical name + node type (+ source-size equality for geometry-bearing entries).

A curated entry beats the per-kind asset prefixes — the designer explicitly
curated it — while ordinary nodes keep following the prefix rules. When a
library asset is exported, the bytes/SVG come from the canonical source node
on the asset page (the plugin loads that page first); if the source was
deleted, export falls back to the locally matched node and reports a
diagnostic advising a re-harvest.

Precedence for component instances:

`profile mapping` → `asset library` → `auto-generated component` → plain layout.

Curated instances are excluded from auto-component grouping, so no unused
composable file is generated for a fully curated set; a set with only some
masters curated still generates the composable for the remaining variants.

### Asset formats and how they flow through the pipeline

Asset export has a master switch and two format settings (`Settings` tab):
`exportAssets` gates the whole registry — off means every candidate gets a
single `ASSET-EXCLUDED` warning explaining the settings state and keeps its
layout. `vectorFormat` (`svg` | `imagevector` | `png`) and `imageFormat`
(`auto` | `png` | `jpg`) pick the sort of artifact each kind produces, and a
curated entry's `fmt` override (Asset rows dropdown) wins over its kind's
global format. A curated *raster* entry can never become SVG/ImageVector
code — malformed or impossible overrides fall back to the kind's global
format defensively.

Format resolution is deterministic and tested unit-wise: for a registered
asset the resolved format is visible in the asset manifest (`result.assets`
carries `fmt`), on the `Output` preview tiles, and in the
`conversion-report.json` `assetExport` section. The generator branches on
the resolved format for the emitted reference
(`Image(imageVector = <Symbol>)` vs `Image(painter = painterResource(...))`)
and `Modifier.paint(...)` image fills always use `painterResource` because
they are rasters in every mode (`auto` = Figma's stored bytes, extension
sniffed from the magic bytes; forced values re-render the node).

ImageVector conversion (`src/gen/imagevector.ts`) is a pure, total function
of the exported SVG string: same SVG in, same Kotlin out, unsupported
constructs are honest warnings listed as `// skipped: …` comments, and all
recognized vectors of a conversion merge into one deterministic `Icons.kt`.

## Design system as code

The `dsSource` setting (`off` | `variables` | `styles` | `both`, default
`off`) reads the file's design system and appends one Kotlin accessor object
— `DesignSystem.kt` next to the generated screens (same package) — so every
family is reachable through one entry point (`DesignSystem.Colors.…`).
Independently of `dsSource`, the plugin can also mint tokens from values that
repeat across the converted frames — the subsection *Usage-derived tokens*
below.

Sources (Settings → *Design system as code*):

* `variables` — local variable collections (`figma.variables`). Values are
  resolved per mode: single-mode collections keep their default mode, while
  multi-mode collections emit **every mode**, each inside a nested wrapper
  object named for the mode (`Colors.Light.Surface` / `Colors.Dark.Surface`)
  with one `DS-MODES` INFO note per collection. Variable aliases are followed
  exactly one hop into local variables, resolved at the same mode when the
  target collection carries it (fallback: its default mode); deeper chains or
  references into published libraries become `DS-ALIAS` warnings.
* `styles` — local paint styles become colors (first visible solid paint
  wins; gradients keep only their first stop plus a `DS-GRADIENT` warning),
  local text styles become `TextStyle` vals, and local effect styles are
  reported as `DS-SKIPPED` (effects become runtime modifiers, not constants).
* `both` merges both sources with collision suffixes.

Emission (`src/gen/designsystem.ts`, pure and deterministic):

* Token symbols use path flattening: `brand/primary` → `BrandPrimary`.
  Leading wrapper words that repeat the wrapping section's own name are
  dropped first (`Color/Base/Black` inside `object Colors` → `BaseBlack`,
  `Metrics/Spacing/x` → `SpacingX`, `Font/Weight/Bold` → `WeightBold`), so
  `DesignSystem.Colors.BaseBlack` never stutters. Collision suffixing is
  scoped to the Kotlin lexical scope: names collide only inside the same
  section object / mode wrapper and get numeric suffixes there
  (`BrandPrimary2`), while sibling scopes may share a symbol. Every token
  keeps its original full path as KDoc
  (`/** Figma variable `Color/Base/Black`. */`); values read from a specific
  mode of a multi-mode collection add it to the KDoc
  (`/** Figma variable `Theme/bg` — `Dark` mode. */`).
* Variable-collection modes become nested wrapper objects. Single-mode
  collections, styles and usage tokens stay at the section root; every mode
  of a multi-mode collection nests under a PascalCased object named after the
  mode (`light` → `Light`, `Dark Mode` → `DarkMode`), so same-named variables
  keep every value (`Colors.Light.Surface` next to `Colors.Dark.Surface`).
  Distinct collections with identically named modes share one wrapper; a
  wrapper name colliding with a section-root val is suffixed
  deterministically (`Dark2`). Screens qualify through the wrappers
  (`DesignSystem.Colors.Light.ThemeSurface`), and exact-value ties — Material
  slots and screen fallback tokens — prefer the collection's default mode
  first, then ungrouped tokens, then the remaining modes (stable order).
* One object-wrapped file `DesignSystem.kt`:
  `object DesignSystem { object Colors { … } object Type { … }
  object Metrics { … } object Strings { … } object Booleans { … } }` — the
  populated section objects in this fixed order, empty families folded away,
  the shared package header and exactly the imports the file needs.
  (`Color(0xAARRGGBB)` literals with alpha baked once; `TextStyle(fontSize,
  fontWeight, fontFamily, lineHeight, letterSpacing, textAlign)`; numbers as
  `dp`/`sp`; plain strings and booleans.) The text-styles object is named
  `Type` so it can never shadow the material3 `Typography` class.
* NUMBER variables emit `dp` unless their flattened path hints at typography
  (`font`, `typo…`, `letter`, `leading`, `lineheight`) — documented
  heuristic — with one exception: a NUMBER whose path carries a `weight`
  word (`Font/Weight/Bold`, `weight-semibold`) **and** an integer value in
  Kotlin's `FontWeight` domain (1..1000) is a font-weight token. It lands in
  the `Type` section before the text styles, as
  `val WeightBold = FontWeight.Bold` — standard weights 100..900 read as the
  Kotlin class aliases (`WeightMedium` = `FontWeight.Medium`), anything else
  stays exact (`WeightFancy` = `FontWeight(650)`, no clamping). Text styles
  whose weight matches one of those values reference the variable instead of
  a hard-coded class (`fontWeight = WeightBold`), mirroring how Figma's own
  design system wires weight variables into typography styles; text styles
  without a matching weight variable keep the previous class expressions
  (`FontWeight.W600`). Values outside the domain (non-integers, out of
  range) stay regular `dp`/`sp` numbers in `Metrics`.
* Text-size percent line heights/letter spacings resolve against the style's
  font size (`1 px == 1 sp`); font families classify by name into
  `FontFamily.Monospace` / `Serif` / `Cursive` / `Default` (unknown names stay
  `Default` with a trailing comment carrying the original family).
* With nothing representable, no file is written and one `DS-EMPTY` INFO
  diagnostic reports it. Every unrepresentable item gets an honest `DS-*`
  diagnostic — nothing is silently dropped; the `conversion-report.json`
  `designSystem` section records the active source and structure.

### Structure modes (`dsStructure`)

The second control of the card chooses what joins the accessor object
(`object` | `material` | `material-theme`, default `object`):

* `object` — the accessor file above, referenced as
  `DesignSystem.Colors.BrandPrimary` (default). Because the tokens always
  live inside the object, the generated screens reference them through it,
  so a flat split-file layout is not offered.
* `material` — the same accessor **plus** a `DesignSystem/Theme.kt` with
  the matched Material 3 artifacts, assigning the **resolved values
  directly** (no re-assignment through the token symbols):
  `val AppColorScheme = lightColorScheme(primary = Color(0xFF…), …)` and/or
  `val AppTypography = Typography(titleLarge = TextStyle(fontSize = 24.sp,
  fontWeight = FontWeight.Bold, …), …)`. Slot matching is **additive
  by name** — tokens whose path does not match a Material slot simply keep
  their plain `val` in the object, so no token is ever lost. `Theme.kt` is a
  self-contained snapshot: it duplicates the matched values on purpose, so
  it never depends on token symbols and can be kept/edited independently of
  `DesignSystem.kt` (regenerate to refresh it).
* `material-theme` — everything `material` emits, plus a ready
  `@Composable fun DesignSystemTheme(content: @Composable () -> Unit) { …
  MaterialTheme(…) }` inside `DesignSystem/Theme.kt`, wrapping
  `MaterialTheme(colorScheme = AppColorScheme, typography =
  AppTypography, content = content)`; arguments appear only for artifact
  groups that actually matched. The composable is only emitted when at least
  one slot matched, and `Theme.kt` itself only exists when at least one
  artifact matched ("when possible").

Formatting: every multi-argument call (`lightColorScheme(…)`,
`Typography(…)`, every `TextStyle(…)`) is emitted **one argument per line**
with trailing commas, and consecutive `val`s are separated by blank lines —
inside `object DesignSystem` too (the writer indents nested blocks).

Slot auto-matching (deterministic, unit-tested):

* A token's path is split into words (`Brand/onPrimaryContainer` →
  `brand on primary container`).
* **Colors** (31 classic Material 3 roles): the role's keyword sequence must
  end the token's words, longest match wins — `Brand/Primary` → `primary`,
  `Colors/On Primary Container` → `onPrimaryContainer`,
  `Dashboard/Error` → `error`, `Dark/inverse-surface` → `inverseSurface`.
  `Brand/Accent` matches nothing.
* **Typography** (15 slots): `Type/Display Large` → `displayLarge`,
  `TitleMedium` → `titleMedium`; a bare base keyword takes the Large default
  (`Title` → `titleLarge`, `Body` → `bodyLarge`). Everything else stays a
  plain val.
* One token per slot (first in the section's sort order wins); exact ties
  prefer the collection's default mode's value, then ungrouped tokens, then
  the remaining modes (stable order); the `surfaceContainer*` color group of
  newer M3 versions is intentionally not matched (kept as plain vals).

### Usage-derived tokens (`dsUsage`)

Beyond the Figma-native sources, the card's *Extract from repeated values*
toggle (`dsUsage`, default `off`) derives a design system from the converted
frames themselves (`src/gen/usage.ts`, pure over the IR docs — deterministic,
unit-testable without the `figma` global): the values a design paints again
and again **are** its design system. It works alone (with `dsSource: off`) or
merges its tokens after a `dsSource` harvest into one design system; either
way the generated screens can reference the emitted symbols instead of raw
literals, because the design system is built **before** the screens.

* What is counted: exact values occurring at least `dsUsageMin` times (number
  input in the card, clamped `2..99`, default `2`) — an occurrence is one
  emitted literal site: per element for paddings/radii/sizes, per node for
  colors and borders, per span for text styles.
* Naming follows usage: each occurrence votes for its nearest *meaningful*
  node name (generic names like `Frame 2`, `wrapper` or asset prefixes are
  ignored); only a strict majority (>50%) names the token, otherwise the name
  degrades to a bare role (`Surface`, `Gap 12`).
* Colors: fills → `Card Surface` (`CardSurface`), strokes → `Outline`,
  text fill colors → `OnSurface`.
* Numbers: `Card Padding 16`, `Card Gap 8`, `Card Radius 12`,
  `Card Border 1`; sizes name by the dominant axis (`Card Size 48` /
  `Width` / `Height`). Fractional dp keeps an unambiguous word: `16.5` →
  `List Gap 10V5`.
* Text styles: a context carrying an M3 keyword (`Title`, `Body`, `Headline`,
  `Display`, `Label`) grades the recurring style by the M3 default sizes into
  `TitleLarge` / `TitleMedium` / `TitleSmall` — those names then feed the
  typography slot auto-matching above. Everything else names explicitly:
  `Card Text 14`, `Text 16 Bold`.
* Substitution stays slot-correct: a number token is referenced only in the
  role(s) it was observed in — `Arrangement.spacedBy(
  DesignSystem.Metrics.CardGap8)` for gaps, `padding(all =
  DesignSystem.Metrics.CardPadding16)` for paddings, `RoundedCornerShape(
  DesignSystem.Metrics.CardRadius12)` for radii; offsets/elevation stay
  literals, and a repeated
  *gap* value never backs a *padding* argument. Colors match by emitted byte
  value (`#AARRGGBB`) and qualify through the accessor too
  (`DesignSystem.Colors.CardSurface`), text styles by the exact
  family/size/weight/line-height/letter-spacing tuple (`style =
  DesignSystem.Type.CardText14`); spans carrying
  italic or decorations keep their inline `TextStyle` so nothing is lost.
  User-configured hex/color and typography mappings keep precedence over the
  auto-substitution.
* On exact value equality, colors and text styles also fall back to the
  variable/style token of a `dsSource` harvest, so a repeated value can point
  at `DesignSystem.Colors.BrandPrimary` even when the usage heuristics stayed
  below `dsUsageMin`.
* The `conversion-report.json` `designSystem` section records `usage` (on/off)
  and `usageMin`; with nothing qualifying, the usual `DS-EMPTY` diagnostic
  appears and screens stay literal-only.

## Full example

Source design (Figma):

```
LoginScreen (VERTICAL, gap 16, padding 24, clipsContent, #F5F5F5)
 └─ Card (VERTICAL, gap 8, radius 12, padding 16, white)
     ├─ Title (TEXT "Welcome", Roboto Bold 24)
     └─ Body  (TEXT "Sign in to continue", Inter Regular 14, #666666)
```

Real generated output (package `com.example.composeapp`, standalone mode):

```kotlin
package com.example.composeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle

@Composable
fun LoginScreen(
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .size(360.dp, 640.dp)
            .clipToBounds()
            .background(color = Color(0xFFF5F5F5))
            .padding(all = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier
                .height(80.dp)
                .align(Alignment.CenterHorizontally)
                .clip(RoundedCornerShape(12.dp))
                .background(color = Color(0xFFFFFFFF), shape = RoundedCornerShape(12.dp))
                .padding(all = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Welcome",
                modifier = Modifier.background(color = Color(0xFF000000)),
                color = Color(0xFF000000),
                style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Default, lineHeight = 20.sp, letterSpacing = 0.sp),
            )
            Text(
                text = "Sign in to continue",
                modifier = Modifier.background(color = Color(0xFF666666)),
                color = Color(0xFF666666),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal, fontFamily = FontFamily.Default, lineHeight = 20.sp, letterSpacing = 0.sp),
            )
        }
    }
}
```

Mapping a `Button` component to `AppButton` with `text`, `variantProp`,
`modifier` and `content` arguments, plus an Inter →
`MaterialTheme.typography.bodyMedium` binding produces:

```kotlin
@Composable
fun ProfileScreen(
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(360.dp, 200.dp)
            .clipToBounds(),
    ) {
        AppButton(
            label = "Sign in",
            type = ButtonType.Primary,
            modifier = Modifier.size(200.dp, 56.dp),
        ) {
            Text(
                text = "Sign in",
                modifier = Modifier.background(color = Color(0xFF000000)),
                color = Color(0xFF000000),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
```

Both samples are regenerated by `node --experimental-strip-types --no-warnings scripts/sample-docs.mts`.
