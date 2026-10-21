# Limitations and diagnostics

Phase 1 converts concrete UI selections to Compose screens with documented,
visible approximations — never silent data loss. Everything the converter
cannot represent 1:1 shows up as a diagnostic in the plugin UI and in
`conversion-report.json`.

## Known structural gaps (not diagnostics, but still true)

- Rotation around centers is not reproduced (`ROTATED-NODE` covers it): the
  node's geometry is flattened.
- Only *local* Figma variables are resolved (document variables are not
  readable through the plugin API).
- Generated files target the package name you configure; they don't ship
  `R` import corrections for different app modules (update the import after).
- Clash of same-named Figma components with different case-norms resolves per
  the case-insensitive name match (first match wins) — see the mapping
  precedence in [generation.md](generation.md).
- Raster assets keep Figma's stored resolution (no @2x/@3x density split);
  forced `PNG`/`JPG` re-renders export the node at its natural size.
- Text style *library ids* are not dereferenced (no fetching of published
  styles), so library text styles read back as their on-node inline values.
- Design-system tokens are local-document values only: font families are
  classified by name hints (`mono`, `serif`, `cursive`) rather than bundled,
  text decorations and text case are not represented, composed colors whose
  color or opacity is itself a variable are skipped, and gradients keep only
  their first stop (`DS-GRADIENT`). The Kotlin output stays a single
  object-wrapped `DesignSystem.kt` (empty families fold away as empty
  sections). Multi-mode collections emit every mode inside nested wrapper
  objects (`Colors.Light.Surface` / `Colors.Dark.Surface`); screens and
  Material slots prefer the collection's default mode when values tie, and
  wrapper names that collide with a same-section val are suffixed
  (`Dark2`). In the material modes `Theme.kt`
  duplicates the matched values (a self-contained snapshot, not symbol
  references) — regenerate the design system after changing tokens.
  Font-weight variable detection is a name contract: the path must carry an
  explicit `weight` word and an integer value in 1..1000 — otherwise the
  number stays a regular `dp`/`sp` token; custom weights emit exactly
  (`FontWeight(650)`), never clamped. The
  opt-in `dsUsage` extractor mints tokens from values repeating across the
  converted frames and names them from the strict-majority context: values
  split across contexts degrade to role names (`Surface`, `Gap 12`), values
  under the repeat threshold stay literal, and heuristic names may lag a
  designer's vocabulary — but every emitted reference stays slot-correct
  (a gap token never backs a padding argument).

Absolute-positioned children ("ignore auto-layout") *are* supported: they are
decomposed into a wrapper `Box` around the flow counterpart (see
[generation.md](generation.md) for the exact pattern and its trade-offs).

Component configuration descriptions (CCD) carry their own boundaries:

- Roles other than `card`/`button`/`fab` only mint parameters — the emitted
  layout does not switch to `Slider`/`Switch`/`Input` composables (that
  would replace the designer's styling); wire the minted parameters in app
  code.
- The Material implementation requires an exact look match (single solid
  fill, no shadow/border, `clipsContent` on with nonzero radius, no absolute
  children, circular shape for `fab`); anything else keeps the custom
  emission with the role parameters and a ripple-free clickable for the
  wired roles (`COMPONENT-CONFIG-ROLE` explains which rule failed).
- A configuration block lives per component master. Variant masters of one
  set share one group composable, so conflicting blocks across variants warn
  (`COMPONENT-CONFIG-CONFLICT`) and the first configured master wins.
- Component *sets* are not edited in the Selection tab's visual editor — select
  a variant master or the master component. When the shared card's
  *Component + variants* treatment groups the set, Apply writes every
  variant's description; the frame treatments keep the masters separate. The
  set object's own description is never written.
  The editor writes the master's
  description through the API; Figma shows edited descriptions only after a
  re-publish (the generated output uses the new value immediately).
- The visual editor rewrites the block from parsed values, so comments inside
  a block disappear once it is saved from the Selection tab; the collapsed
  "Edit as raw text" advanced editor (single-component selection) applies
  text verbatim and keeps comments.
- Presets live in Figma client storage and are per-machine/per-account as far
  as Figma syncs them; the list is capped at 30 entries and same-name saves
  replace. Presets hold one configuration each — components that were edited
  as a mixed multi-selection capture the first configured component's values.
- `mappingArgs` values are single-line and flat by design (no nested YAML,
  no multiline strings); complex expressions go as constants
  (`styles/radius8.kt`-style imports cannot be expressed yet).

## Diagnostic reference

Severity meanings: `ERROR` — wrong output would be produced without user
attention; `WARNING` — approximation made; `INFO` — noteworthy data point.

| Code                        | Severity | Meaning                                                                                   |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `INVALID-SOURCE`              | ERROR    | The selection included something unnamed/id-less; that node is skipped.                    |
| `UNSUPPORTED-NODE`            | ERROR    | Node type (e.g. `CODE`, `EMBED`) has no Compose analog; skipped entirely.                   |
| `UNRESOLVED-VARIABLE`         | WARNING  | A color variable reference could not be resolved into a token; the literal color is used.   |
| `NODE-INVISIBLE`              | INFO     | Invisible node(s) were excluded from the conversion.                                        |
| `NODE-IGNORED`                | INFO     | Node matched an ignore rule (prefix or user mark); it and its children are skipped entirely. |
| `ROTATED-NODE`                | WARNING  | Node rotation is not emitted; geometry is flattened (1:1 axis-aligned).                      |
| `MULTIPLE-FILLS`              | INFO     | Only the first (bottom-most) visible fill is emitted.                                       |
| `UNSUPPORTED-FILL`            | WARNING  | A paint is not representable (e.g. angular gradient, video) — the fill is omitted.          |
| `UNSUPPORTED-EFFECT`          | WARNING  | Inner shadow / layer or background blur not reproduced.                                     |
| `MULTIPLE-SHADOWS`            | INFO     | Only the first mapped shadow is emitted.                                                    |
| `EFFECT-SPREAD`               | INFO     | Compose `Modifier.shadow` has no spread; spread ignored.                                    |
| `SHADOW-OFFSET`               | WARNING  | Compose `Modifier.shadow` has no offset; shadow centered.                                   |
| `DASHED-BORDER`               | WARNING  | Dashes cannot be expressed with a solid border; solid emitted.                              |
| `STROKE-ALIGN`                | INFO     | Outside/center-aligned strokes approximated as inside border.                               |
| `SVG-REQUIRED`                | INFO     | Node geometry (arc/pie/vector types) exported as an SVG asset; `Image` emitted.              |
| `ASSET-EXCLUDED`              | WARNING  | No asset exported: either the node's name misses the kind's asset prefix (a vector renders as a placeholder; an image fill is omitted), the node is on the asset-skip list, or asset export is switched off in the settings (message says which; layout is kept in every case). |
| `IMAGE-ROTATION`              | INFO     | Rotated image fills are approximated without the rotation.                                  |
| `MIXED-TEXT-STYLES`           | WARNING  | Text node has more than one style; first style wins for the whole node.                     |
| `COMPONENT-VARIANT`           | INFO     | Instance resolves a variant property (value reported)                                       |
| `ABSOLUTE-POSITION`           | INFO     | Node ignores its parent auto-layout; emitted as an offset child inside a wrapper Box.       |
| `FONT-NOT-MAPPED`             | INFO     | Font family wasn't mapped by profile; `FontFamily.Default` emitted (profile mode only).     |
| `GRADIENT-ANGLE`              | INFO     | Non-axis-aligned gradient approximated to nearest supported axis.                            |
| `RADIAL-CENTER`               | INFO     | Radial gradient center snapped to node center.                                              |
| `LAYOUT-WRAP`                 | INFO     | Wrapping auto-layout emitted as a single Row/Column line (no wrap).                          |
| `TEXT-EMPTY`                  | INFO     | Empty text node skipped entirely.                                                           |
| `LINE-NO-STROKE`              | WARNING  | A LINE shape with no solid stroke is omitted (there is nothing to render).                   |
| `COMPONENT-UNMAPPED`          | INFO     | Instance without a profile component mapping; emitted as plain layout (`Box`).               |
| `COMPONENT-VARIANT-SINGLE`    | INFO     | Component set with variant parameters, but only one variant present in the conversion; the generated composable always renders that variant's content. |
| `COMPONENT-VARIANT-PARAMS`    | INFO     | Auto variant shape: near-identical variants collapsed into one composable with typed value parameters (counts and share reported). |
| `COMPONENT-VARIANT-FUNCTIONS` | INFO     | Auto variant shape picked per-variant composables for divergent bodies, or an explicit functions/object shape is applied. |
| `COMPONENT-VARIANT-SOURCE`    | INFO     | A master not instantiated in the selection was harvested from its component set and coded from the source (variant assignments reported). |
| `COMPONENT-VARIANT-UNEXPANDED`| WARNING  | A component set could not be loaded (async page read failed) or expansion threw; only the selection's variant masters are coded. |
| `COMPONENT-VARIANT-MASTER`    | WARNING  | A harvested master could not be extracted; its body falls back to the nearest reference instance. |
| `COMPONENT-PROP-UNSUPPORTED`  | INFO     | `BOOLEAN`/instance-swap component properties are not parameterized; the reference instance's content is used. |
| `COMPONENT-CONFIG`            | INFO     | A component's configuration description (CCD) drives the generation; the applied values are summarized. |
| `COMPONENT-CONFIG-INVALID`    | WARNING  | The component description's `compose-studio:` block has problems (unknown keys/values, malformed layout); the tolerant parse skips only the bad keys. |
| `COMPONENT-CONFIG-ROLE`       | INFO     | A role's implementation decision: Material composable used, or the reason the custom emission (with the role parameters) stayed. |
| `COMPONENT-CONFIG-ASSET`      | INFO     | The component's `kind`/`assets: export` configuration renders every instance as an exported asset instead of code. |
| `COMPONENT-CONFIG-CONFLICT`   | WARNING  | A component set's variants carry different configuration blocks; the first configured master's block applies to the whole generated component. |
| `MAPPING-INJECTED-MODIFIER`   | INFO     | Mapping lacked a `modifier` argument; node modifier injected automatically.                  |
| `INSTANCE-CHILDREN-OMITTED`   | INFO     | Mapping lacks a `content` argument; the instance's children were not rendered.               |
| `MAPPING-ARG-MISSING`         | INFO     | Mapping argument could not resolve from the subtree; argument omitted from the call.         |
| `MAPPING-ARG-DEFAULTED`       | INFO     | Same as above but the mapping provided a default value to fall back to.                      |
| `DS-EMPTY`                    | INFO     | Design-system generation enabled but no representable tokens found; no `DesignSystem.kt`.    |
| `DS-SKIPPED`                  | WARNING  | A design-system item has no constant analog (image paint styles, effect styles, unsupported object values, unresolvable modes, unknown line-height/letter-spacing percent without a font size). |
| `DS-GRADIENT`                 | WARNING  | A gradient paint style is approximated with its first color stop.                            |
| `DS-ALIAS`                    | WARNING  | A variable aliased to a non-local target (published library) or to a chain deeper than one hop; skipped. |
| `DS-MODES`                    | INFO     | A multi-mode variable collection was split per mode into nested wrapper objects (default mode preferred for screen/Material ties). |
| `DS-ERROR`                    | ERROR    | Design-system harvest threw; `DesignSystem.kt` was not generated (screens are unaffected).    |

### Design-system structure modes

The `dsStructure` setting packages the same tokens two-plus-one ways
(`object` by default, with the material modes adding artifacts), and the
same guardrails hold: token content is identical, only added artifacts
change. Honest limitations of the Material modes:

- Slot wiring is a **name heuristic by design** — 31 color-role suffixes and
  15 typography-slot suffixes, documented in
  [generation.md](generation.md). Tokens whose names don't carry the Material
  vocabulary are never invented into slots; they simply remain plain vals.
- One token per slot (first in sort order wins; mode ties prefer the
  collection's default mode); a token named both roles keeps only its first
  assignment. The newer M3 `surfaceContainer*` color group is not matched
  (no classic-slot analog).
- `AppColorScheme` stays a light-scheme override: multi-mode collections do
  emit every mode as wrapper objects, but the Material slots pick the
  collection's **default** mode's values; a full `darkColorScheme()` twin is
  not generated (`DS-MODES` still notes the split).

### Export selection

The Output tab's Files & assets card is a selection, not a new pipeline: the
ZIP contains exactly the checked files and assets (checkboxes on the file
pills and asset tiles; presets and download live in the same card),
`Icons.kt` carries its ImageVector vals (no standalone vector file exists
for that format), and the report inside lists exactly the ZIP contents
(`partialExport: true` flags subsets). All conversion rules, diagnostics and
curation still describe the full conversion.

## Other conversion realities

Node-count guard: the extractor halts beyond 4000 nodes per conversion with a
hard error (selection too large) instead of hanging the session.

Instance master components run through Figma's async API. The manifest uses
`documentAccess: 'dynamic-page'`, where reading the sync
`instanceNode.mainComponent` getter throws ("Cannot call with documentAccess").
Before extraction the plugin resolves every instance's master, its component
set and the instance's component property values via the async APIs; if a
field cannot be read, the conversion continues with what it has and a warning
is added to the conversion report.

Auto-generated components (standalone instances turned into dedicated
composables) honestly carry these restrictions: the full-variant expansion
walks the component set's masters and extracts each one it can, but masters
that fail to load or extract, that carry an ignore mark, or that have no
`Key=Value` variant name are skipped (`COMPONENT-VARIANT-UNEXPANDED` /
`COMPONENT-VARIANT-MASTER`) and fall back to the reference instance's body —
and `BOOLEAN` / instance-swap component properties are declared but not
parameterized, because their content lives inside untouched instances that
cannot be reached cross-page in resolved form (`COMPONENT-PROP-UNSUPPORTED`).
Text substitution happens only when a body text node's full content equals
the property value; harvested masters carry no component-property snapshot,
so their text stays literal (the `Key=Value` state itself is always parsed
from the master's name).

Typed variant parameters scope themselves to what the component set (whole
masters, harvested included) plus the converted values expose: enum/sealed
types list every variant value of every harvested master, and — when nothing
harvests (a set could not be loaded) — only the values seen in the
selection. That boundary is deliberate (the plugin cannot emit what it has
not seen) — add the missing variants to the selection to extend the type.
True/False variant keys always become `Boolean` parameters, and the
plain-string option exists purely as a legacy/escape hatch.

The **auto** variant shape measures the variant bodies rather than asking the
user, which has its own honest boundaries: the comparison runs on the
emitted Kotlin (line skeletons with value tokens erased), so a structural
difference the emitter would render identically — or vice versa — leans on
what the emitter produces, not on Figma's semantics; thresholds are fixed
(3 differing lines / 35% / 6 lifted tokens for the params tier, 55% body
divergence for per-variant functions — documented in generation.md); and the
lift covers only value tokens, so structural-but-small differences still
become a `when`.

Curation limits the same way, honestly:

- **Marks are identities, not patterns.** A mark stores name + type + size
  (+ master component id for components/instances). A same-named node with a
  different size, or a same-named node of another type, does **not** match;
  components match by master id. If you later rename or resize a design, the
  mark keeps matching (name/size are captured at marking time, and component
  identity survives renames).
- **Asset-library sources live on their pages.** Screen nodes reference the
  canonical asset-page node; if the file is re-structured (source deleted),
  exports fall back to the locally matched node and a diagnostic asks for a
  re-harvest. Library entries do not follow duplicate-paste ids across files —
  re-harvest after copying a file.
- **Harvest sees top-level layers** (top-level sections expand one level).
  Deeply nested vectors inside frames are not enumerated; keep asset pages
  flat for best results.
- Client-storage contents are best-effort: if storage is unavailable the
  plugin runs with empty curation and notifies instead of failing.

Mixed values (`figma.mixed`) never become numbers. Whenever a design value is
a mix (e.g. itemSpacing set per-child), the field is carried as `null` into
the IR with the appropriate diagnostic; the generator then omits the
corresponding modifier/default instead of inventing a wrong value.

Determinism: no Date/random in output paths or names; repeated conversion of
an unchanged selection produces the same ZIP hashes.
