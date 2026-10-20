# Publishing to the Figma Community

Everything you need to submit Compose Studio as a free Community plugin. All
artifacts live in `publish/`; the texts in this document are ready to paste
into the **Publish plugin** wizard (Figma desktop app).

## Assets in `publish/`

| File | Size | Used for |
| --- | --- | --- |
| `icon-128.png` | 128 × 128 | Plugin icon (Figma recommends 128×128) |
| `cover-1920x1080.png` | 1920 × 1080 | Listing thumbnail (recommended size) |
| `carousel-mappings.png` | 1600 × 1000 | Carousel slide — Mappings tab |
| `carousel-assets.png` | 1600 × 1000 | Carousel slide — Assets & Ignore tab |
| `cover.html`, `icon.html`, `carousel.html` | — | Editable sources; change → screenshot → replace PNG |

`carousel.html` takes `?view=mappings` or `?view=assets`. The panel you see
inside the cover/carousel art is the **real built `dist/ui.html`** driven over
the plugin message API — regenerate it after any UI change:

```powershell
npm run build
node <path-to-a-static-server.mjs>   # serves the repo at 127.0.0.1:8794
# open /publish/cover.html in a browser, screenshot the <body> element
```

## Pre-publish checklist

1. Run the full gate one last time:
   `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
   `node scripts/sample-docs.mts`.
2. `node --check` the extracted `<script>` of the built `dist/ui.html`
   (as documented in `docs/phase1-verification.md`).
3. `LICENSE` — done (MIT, matching `package.json` and the cover badge).
4. Pick a support contact (email and/or GitHub issues URL) — the wizard needs one.
5. Decide the first-version number in `package.json` (it stamps notices in the UI).

The manifest already declares `networkAccess: { allowedDomains: ["none"] }`
and `title`/`ui`/`main` paths, so the desktop app can bundle straight from the
repo root. Do not zip manually — publishing is driven from the loaded
development plugin.

## Wizard texts (paste as-is)

**Name**

```
Compose Studio
```

**Tagline** (short, shown under the title)

```
Convert Figma selections into production-ready Jetpack Compose Kotlin — locally, deterministically, no AI.
```

**Description**

```
Compose Studio turns Figma selections into idiomatic Jetpack Compose Kotlin — a 100% local compiler pipeline. No AI, no network access, no telemetry.

What you get

- Kotlin files for any screen or component you select, written the way a Compose engineer writes: clean modifiers, Material 3 defaults, no layout hacks.
- A ZIP with your .kt files plus icon (SVG) and image (PNG) assets, arranged for an Android project — download and merge.
- Honest diagnostics: every approximation, skip, or unmapped instance is reported with stable codes and severity filters. The generator never silently discards your design.

Teach it your design system

- Map colors, text styles, font families, and components to your Compose identifiers — the generator writes your tokens instead of literals.
- Mapping profiles export/import as JSON, so you can version them with your code and share them across the team.
- Full curation: name-prefix ignore rules, per-layer asset-skip marks that survive renames, and a harvested asset library from a dedicated icon page that beats per-name prefixes everywhere.

Privacy by construction

- The manifest pins networkAccess: none and the runtime enforces it; output is deterministic — same selection and settings, same bytes, every time.
- Your design never leaves your machine.

Usage, supported features, and known limits: see the repository README. Issues and feedback: <support contact>
```

**Category** — pick **Software development** (closest match in the wizard's
list; re-check the current options when submitting).

**Images** — icon: `publish/icon-128.png`; thumbnail:
`publish/cover-1920x1080.png`; carousel: the two `carousel-*.png` slides
(optional, up to 9 allowed — desktop screenshots of real conversions are a
good later addition).

## Data security disclosure

Figma asks a short questionnaire and displays the answers on the listing —
they are reviewed. Answer from `docs/security-privacy.md`, in substance:

- **Does the plugin access user content?** Yes — the selection subtree, local
  variable collections for token resolution, and export bytes for nodes in the
  selection. Read-only within the producing session.
- **Does it collect, store, or transmit personal data?** No. No accounts, no
  telemetry, no analytics.
- **Network access?** None — `networkAccess: { allowedDomains: ["none"] }` is
  pinned in `manifest.json` and enforced by the plugin runtime.

## Final wizard details

- **Publish as**: you (or your team), free plugin. Paid plugins need creator
  approval — not applicable here.
- **Support contact**: your chosen email/issues URL (used for the listing's
  support button).
- **Contributors / comments**: your choice; comments on are normal for free
  community plugins.
- **Playground file** (optional): a small public Figma file with one frame
  styled like the cover's mock selection — nice for first-run demos.
- **Changelog**: only required when publishing an *update* to an already
  published plugin; keep a short per-version list from then on
  (phase1-verification.md's revision table is a good source).

## After submission

Figma reviews new plugins before they go live (usually days, not weeks).
While waiting you can keep using the dev-loaded plugin locally — the
published listing only serves the version you submitted.
