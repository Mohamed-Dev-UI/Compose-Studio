import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, type GenerationOptions } from '../src/gen/generate.ts';
import { parseMappingProfile, type MappingProfile } from '../src/mapping/profile.ts';
import { Extractor } from '../src/extract/extract.ts';
import type { InstanceComponentInfo } from '../src/extract/figma-types.ts';
import type { IrInstanceNode } from '../src/ir/ir.ts';
import { parseComposeConfig } from '../src/shared/compose-config.ts';
import {
  columnFixture,
  ellipseNode,
  frameNode,
  instanceNode,
  rectNode,
  solidPaint,
  testContext,
  textNode,
  vectorNode,
} from './fixtures.ts';

function run(
  root: ReturnType<typeof frameNode>,
  profile: MappingProfile | null = null,
  extra: Partial<GenerationOptions> = {},
  componentRecords?: Record<string, InstanceComponentInfo | null>,
) {
  const context = {
    ...testContext(),
    instanceComponentLookup: componentRecords ? (id: string) => componentRecords[id] ?? null : undefined,
  };
  const doc = new Extractor(context).extractRoot(root);
  assert.notEqual(doc, null);
  const options: GenerationOptions = { packageName: 'com.example.app', profile, ...extra };
  return generateCode([doc!], options);
}

test('a screen fixture generates one Kotlin file, keeping existing Screen names', () => {
  const result = run(columnFixture());
  assert.equal(result.files.length, 1);
  const file = result.files[0]!;
  assert.equal(file.path, 'LoginScreen.kt');
  assert.match(file.content, /^package com\.example\.app\n/);
  assert.match(file.content, /import androidx\.compose\.runtime\.Composable/);
  assert.match(file.content, /fun LoginScreen\(\s*\n\s*modifier: Modifier = Modifier,\s*\n\) \{/);
});

test('imports are emitted sorted and deduplicated', () => {
  const result = run(columnFixture());
  const header = result.files[0]!.content.split('\n').filter((l) => l.startsWith('import '));
  const sorted = [...header].sort((a, b) => a.localeCompare(b, 'en'));
  assert.deepEqual(header, sorted);
  assert.equal(new Set(header).size, header.length);
});

test('auto-layout containers become Column with arrangement and alignment', () => {
  const result = run(columnFixture());
  const code = result.files[0]!.content;
  assert.match(code, /Column\(/);
  assert.match(code, /verticalArrangement = Arrangement\.spacedBy\(16\.dp\)/);
  assert.match(code, /horizontalAlignment = Alignment\.CenterHorizontally/);
});

test('nested cards emit radius, padding and background modifiers', () => {
  const result = run(columnFixture());
  const code = result.files[0]!.content;
  assert.match(code, /RoundedCornerShape\(12\.dp\)/);
  assert.match(code, /padding\(all = 16\.dp\)/);
  assert.match(code, /background\(color = Color\(0xFFFFFFFF\)/);
});

test('text nodes emit material3 Text with style and color', () => {
  const result = run(columnFixture());
  const code = result.files[0]!.content;
  assert.match(code, /Text\(\s*\n\s*text = "Welcome"/);
  assert.match(code, /fontSize = 24\.sp/);
  assert.match(code, /fontWeight = FontWeight\.Bold/);
  assert.match(code, /import androidx\.compose\.material3\.Text/);
});

test('ellipse shapes emit a CircleShape box', () => {
  const root = frameNode('root', 'DotRoot', {}, [ellipseNode('e1', 'Dot', { fills: [] })]);
  const result = run(root);
  const code = result.files[0]!.content;
  assert.match(code, /CircleShape/);
});

test('vectors become Image calls registered as svg assets', () => {
  const root = frameNode('root', 'IconRoot', {}, [vectorNode('v1', 'Star Icon', { fills: [] })]);
  const result = run(root);
  assert.equal(result.assets.length, 1);
  const asset = result.assets[0]!;
  assert.equal(asset.kind, 'svg');
  assert.equal(asset.name, 'ic_star_icon');
  const code = result.files[0]!.content;
  assert.match(code, /Image\(\s*\n\s*painter = painterResource\(R\.drawable\.ic_star_icon\)/);
  assert.match(code, /contentDescription = null/);
});

test('image-fill rectangles register png assets with the source hash', () => {
  const root = frameNode('root', 'PhotoRoot', {}, [
    rectNode('r1', 'Hero Photo', {
      fills: [{ type: 'IMAGE', imageHash: 'img-hash-1', scaleMode: 'FILL', visible: true }],
    }),
  ]);
  const result = run(root);
  const asset = result.assets.find((a) => a.kind === 'png');
  assert.notEqual(asset, undefined);
  assert.equal(asset!.meta?.imageHash, 'img-hash-1');
  assert.equal(asset!.name, 'img_hero_photo');
});

test('asset prefix exports only matching names and strips the prefix from resource names', () => {
  const root = frameNode('root', 'Root', {}, [
    vectorNode('v1', 'icon_star', { fills: [] }),
    vectorNode('v2', 'Wing', { fills: [] }),
    rectNode('r1', 'img_Bg', { fills: [{ type: 'IMAGE', imageHash: 'img-h', scaleMode: 'FILL', visible: true }] }),
    rectNode('r2', 'Banner Photo', { fills: [{ type: 'IMAGE', imageHash: 'img-h2', scaleMode: 'FILL', visible: true }] }),
  ]);
  const result = run(root, null, { iconAssetPrefix: 'icon_', imageAssetPrefix: 'img_' });
  // Only matching names are exported; each kind's prefix is stripped from
  // its own base (`icon_star` -> `ic_star`, `img_Bg` -> `img_bg`).
  assert.deepEqual(result.assets.map((a) => `${a.kind}:${a.name}`), ['svg:ic_star', 'png:img_bg']);

  const code = result.files[0]!.content;
  assert.match(code, /painterResource\(R\.drawable\.ic_star\)/);
  assert.doesNotMatch(code, /R\.drawable\.img_banner_photo/);
  assert.doesNotMatch(code, /ic_wing/);

  // Every exclusion is reported as a WARNING that names the prefix.
  const excluded = result.diagnostics.filter((d) => d.code === 'ASSET-EXCLUDED');
  assert.equal(excluded.length, 2);
  assert.match(excluded[0]!.message, /'icon_'/);

  // Regression guard: with no prefix the same tree exports all four assets.
  const free = run(root);
  assert.equal(free.assets.length, 4);
  assert.equal(free.diagnostics.some((d) => d.code === 'ASSET-EXCLUDED'), false);
});

test('vector exclusion falls back to a placeholder Box that keeps geometry', () => {
  const root = frameNode('root', 'Root', {}, [vectorNode('v1', 'Wing', { fills: [] })]);
  const result = run(root, null, { iconAssetPrefix: 'ic_' });
  const code = result.files[0]!.content;
  assert.doesNotMatch(code, /painterResource/);
  assert.equal(result.assets.length, 0);
  // Placeholder keeps the positional chain (no Image call).
  assert.match(code, /Box\(/);
});

test('unmapped instances fall back to plain layout and are reported once', () => {
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'Button A', { mainComponent: { name: 'Button', id: 'c1' }, width: 200, height: 56 }, [
      textNode('b1', 'Label', { characters: 'Sign in', x: 0, y: 0 }),
    ]),
    instanceNode('i2', 'Button B', { mainComponent: { name: 'Button', id: 'c1' }, x: 0, y: 80, width: 200, height: 56 }, []),
  ]);
  const result = run(root);
  const code = result.files[0]!.content;
  assert.match(code, /Box\(/);
  assert.equal(result.diagnostics.filter((d) => d.code === 'COMPONENT-UNMAPPED').length, 1);
  // No component snapshot -> no auto-generated component file at all.
  assert.equal(result.files.length, 1);
});

test('variant family generates one component file with a when and parameterized calls', () => {
  const root = frameNode('root', 'Root', { width: 400, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, [
      textNode('a1lbl', 'Label', { characters: 'Sign in', x: 0, y: 0 }),
    ]),
    instanceNode('a2', 'SecondaryBtn', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, x: 0, y: 80, width: 200, height: 56 }, [
      textNode('a2lbl', 'Label', { characters: 'Create account', x: 0, y: 0 }),
    ]),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: { name: 'Type=Primary', id: 'comp:p1', set: { id: 'set:button', name: 'Button' }, props: { 'Label#1:2': { kind: 'TEXT', value: 'Sign in' } } },
    a2: { name: 'Type=Secondary', id: 'comp:p2', set: { id: 'set:button', name: 'Button' }, props: { 'Label#1:2': { kind: 'TEXT', value: 'Create account' } } },
  };
  const result = run(root, null, { variantShape: 'when' }, records);
  const component = result.files.find((f) => f.path === 'Button.kt');
  assert.notEqual(component, undefined);
  const comp = component!.content;
  // Default style is a type-safe enum (minted from set name 'Button' + key 'Type').
  assert.match(comp, /enum class ButtonType \{ PRIMARY, SECONDARY \}/);
  assert.match(comp, /fun Button\(\s*\n\s*modifier: Modifier = Modifier,/);
  assert.match(comp, /type: ButtonType = ButtonType\.PRIMARY,/);
  assert.match(comp, /label: String = "Sign in",/);
  assert.match(comp, /when \(type\) \{/);
  assert.match(comp, /ButtonType\.PRIMARY -> \{/);
  assert.match(comp, /ButtonType\.SECONDARY -> \{/);
  // Body texts render through the parameter, not literals.
  assert.match(comp, /text = label/);
  // Branch roots must not inherit parent-relative offsets from the original screen.
  assert.doesNotMatch(comp, /\.offset\(/);

  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!;
  assert.match(screen.content, /Button\(\s*\n\s*modifier = Modifier/);
  assert.match(screen.content, /type = ButtonType\.PRIMARY,\s*\n\s*label = "Sign in"/);
  assert.match(screen.content, /type = ButtonType\.SECONDARY,\s*\n\s*label = "Create account"/);
  // The secondary instance's call must not fall back to a plain Box.
  assert.equal(screen.content.match(/Box\(/g)!.length, 1); // root box only
});

test('sealed style mints sealed interfaces with object entries', () => {
  const root = frameNode('root', 'Root', { width: 200, height: 140 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, []),
    instanceNode('a2', 'SecondaryBtn', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, x: 0, y: 60, width: 200, height: 56 }, []),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: { name: 'Type=Primary', id: 'comp:p1', set: { id: 'set:button', name: 'Button' } },
    a2: { name: 'Type=Secondary', id: 'comp:p2', set: { id: 'set:button', name: 'Button' } },
  };
  const result = run(root, null, { variantParamStyle: 'sealed', variantShape: 'when' }, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  assert.match(comp, /sealed interface ButtonType \{/);
  assert.match(comp, /object Primary : ButtonType/);
  assert.match(comp, /object Secondary : ButtonType/);
  assert.match(comp, /type: ButtonType = ButtonType\.Primary,/);
  assert.match(comp, /ButtonType\.Primary -> \{/);
  assert.match(comp, /ButtonType\.Secondary -> \{/);
  assert.doesNotMatch(comp, /enum class/);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!;
  assert.match(screen.content, /type = ButtonType\.Secondary,/);
});

test('True/False variant properties become Boolean parameters', () => {
  const root = frameNode('root', 'Root', { width: 240, height: 90 }, [
    instanceNode('a1', 'BtnA', { mainComponent: { name: 'Destructive=False,Icon=True', id: 'comp:x1' }, variantProperties: { Destructive: 'False', Icon: 'True' }, width: 200, height: 40 }, []),
    instanceNode('a2', 'BtnB', { mainComponent: { name: 'Destructive=True,Icon=False', id: 'comp:x2' }, variantProperties: { Destructive: 'True', Icon: 'False' }, x: 0, y: 50, width: 200, height: 40 }, []),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: { name: 'Destructive=False,Icon=True', id: 'comp:x1', set: { id: 'set:toggle', name: 'Toggle' } },
    a2: { name: 'Destructive=True,Icon=False', id: 'comp:x2', set: { id: 'set:toggle', name: 'Toggle' } },
  };
  const result = run(root, null, { variantShape: 'when' }, records);
  const comp = result.files.find((f) => f.path === 'Toggle.kt')!.content;
  // Booleans are type-safe without a dedicated enum.
  assert.match(comp, /destructive: Boolean = false,/);
  assert.match(comp, /icon: Boolean = true,/);
  assert.match(comp, /when \(destructive to icon\) \{/);
  assert.match(comp, /false to true -> \{/);
  assert.match(comp, /true to false -> \{/);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!;
  assert.match(screen.content, /destructive = false,/);
  assert.match(screen.content, /icon = true,/);
  assert.doesNotMatch(comp, /enum class/);
});

test('string style keeps the legacy plain-string parameters', () => {
  const root = frameNode('root', 'Root', { width: 200, height: 140 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, []),
    instanceNode('a2', 'SecondaryBtn', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, x: 0, y: 60, width: 200, height: 56 }, []),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: { name: 'Type=Primary', id: 'comp:p1', set: { id: 'set:button', name: 'Button' } },
    a2: { name: 'Type=Secondary', id: 'comp:p2', set: { id: 'set:button', name: 'Button' } },
  };
  const result = run(root, null, { variantParamStyle: 'string', variantShape: 'when' }, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  assert.match(comp, /type: String = "Primary",/);
  assert.match(comp, /"Primary" -> \{/);
  assert.match(comp, /"Secondary" -> \{/);
  assert.doesNotMatch(comp, /enum class/);
  assert.doesNotMatch(comp, /sealed interface/);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!;
  assert.match(screen.content, /type = "Secondary",/);
});

test('text and boolean component properties drive parameters and diagnostics', () => {
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('a1', 'Save', { mainComponent: { name: 'Button', id: 'comp:1' }, width: 120, height: 48 }, [
      textNode('lbl', 'Label', { characters: 'Save', x: 0, y: 0 }),
    ]),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: {
      name: 'Button',
      id: 'comp:1',
      props: {
        'Label#2:3': { kind: 'TEXT', value: 'Save' },
        'Icon#2:4': { kind: 'BOOLEAN', value: true },
      },
    },
  };
  const result = run(root, null, {}, records);
  assert.equal(result.files.length, 2); // screen + Button.kt
  const comp = result.files.find((f) => f.path === 'Button.kt')!;
  // Single master, no variants: direct body, no `when`.
  assert.doesNotMatch(comp.content, /when \(/);
  assert.match(comp.content, /label: String = "Save",/);
  assert.match(comp.content, /text = label/);
  const unsupported = result.diagnostics.filter((d) => d.code === 'COMPONENT-PROP-UNSUPPORTED');
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0]!.message, /'Icon'/);
  const screen = result.files[0]!.content + result.files[1]!.content;
  // Only the TEXT property feeds the call; nothing is emitted for the boolean.
  assert.match(screen, /label = "Save"/);
  assert.equal(/Icon = /.test(screen), false);
});

test('boolean-only component properties still fall back cleanly without text params', () => {
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('a1', 'Badge', { mainComponent: { name: 'Badge', id: 'comp:b1' }, width: 80, height: 24 }, []),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: { name: 'Badge', id: 'comp:b1', props: { 'Selected#3:1': { kind: 'BOOLEAN', value: false } } },
  };
  const result = run(root, null, {}, records);
  // A component file exists (parameterized by modifier only) and no text param.
  const comp = result.files.find((f) => f.path === 'Badge.kt');
  assert.notEqual(comp, undefined);
  assert.doesNotMatch(comp!.content, /selected/);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-PROP-UNSUPPORTED'), true);
});

test('profile mappings win over auto components', () => {
  const parsed = parseMappingProfile({
    schemaVersion: 1,
    profileName: 'p',
    colors: [],
    fonts: [],
    textStyles: [],
    components: [
      {
        source: { kind: 'component', componentName: 'Button' },
        target: { symbol: 'AppButton' },
        arguments: [{ argument: 'modifier', source: { kind: 'modifier' } }],
      },
    ],
  });
  assert.equal(parsed.diagnostics.length, 0);
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('a1', 'Save', { mainComponent: { name: 'Button', id: 'comp:1' }, width: 120, height: 48 }, [
      textNode('lbl', 'Label', { characters: 'Save', x: 0, y: 0 }),
    ]),
  ]);
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: { name: 'Button', id: 'comp:1', set: { id: 'set:button', name: 'Button' }, props: { 'Label#1': { kind: 'TEXT', value: 'Save' } } },
  };
  const result = run(root, parsed.profile, {}, records);
  // The profile call is used; no auto component file is generated.
  assert.equal(result.files.length, 1);
  assert.match(result.files[0]!.content, /AppButton\(/);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-PROP-UNSUPPORTED'), false);
});

test('mapped instances resolve to the profile composable with typed arguments', () => {
  const profile = parseMappingProfile({
    schemaVersion: 1,
    profileName: 'p',
    colors: [],
    fonts: [],
    textStyles: [],
    components: [
      {
        source: { kind: 'component', componentName: 'Button' },
        target: { symbol: 'AppButton' },
        arguments: [
          { argument: 'text', source: { kind: 'text', childIndex: 0 } },
          { argument: 'type', source: { kind: 'variantProp', name: 'Type', cases: { Primary: 'ButtonType.Primary' } } },
          { argument: 'content', source: { kind: 'content' } },
        ],
      },
    ],
  }).profile!;
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'Save', {
      variantProperties: { Type: 'Primary' },
      layoutMode: 'VERTICAL',
      itemSpacing: 0,
      width: 200, height: 56,
      children: [textNode('b1', 'Label', { characters: 'Sign in', x: 0, y: 0 })],
    }),
  ]);
  const result = run(root, profile);
  assert.equal(result.files.length, 1);
  const code = result.files[0]!.content;
  assert.match(code, /AppButton\(\s*\n\s*text = "Sign in",\s*\n\s*type = ButtonType\.Primary,\s*\n\s*modifier = /);
  assert.match(code, /AppButton\(\s*[\s\S]*\) \{\s*\n\s*Text\(/);
});

test('absolute-positioned children emit a wrapper Box and keep their offset', () => {
  // The user's report: a rectangle inside a VERTICAL auto-layout frame with the
  // "absolute position" toggle must not join the Column flow and lose its x/y.
  const root = frameNode('root', 'Root', { width: 360, height: 200 }, [
    frameNode('panel', 'Panel', {
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16,
      width: 360, height: 200,
    }, [
      textNode('t1', 'Title', { characters: 'Flow', width: 100, height: 20 }),
      rectNode('r1', 'Badge', { layoutPositioning: 'ABSOLUTE', x: 24, y: 40, width: 60, height: 40 }),
    ]),
  ]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const result = generateCode([doc!], { packageName: 'com.example.app', profile: null });
  const code = result.files[0]!.content;
  // The wrapper Box replaces the panel: frame decoration, but *no* padding chip.
  assert.match(code, /Box\(\s*\n\s*modifier = Modifier\s*\n\s*\.size\(360\.dp, 200\.dp\)\s*\n\s*\.clipToBounds\(\),\s*\n\s*\) \{\s*\n\s*Column\(/);
  // The inner Column keeps arrangement and carries the flow-axis insets.
  assert.match(code, /Column\(\s*\n\s*modifier = Modifier\.fillMaxSize\(\)\.padding\(all = 16\.dp\),\s*\n\s*verticalArrangement = Arrangement\.spacedBy\(8\.dp\)/);
  // The absolute child becomes a Box sibling with its explicit offset.
  assert.match(code, /\.size\(60\.dp, 40\.dp\)\s*\n\s*\.offset\(24\.dp, 40\.dp\)/);
  assert.equal(result.diagnostics.some((d) => d.code === 'ABSOLUTE-POSITION'), true);
});

test('mapped instances keep absolute-positioned children inside the content lambda', () => {
  const profile = parseMappingProfile({
    schemaVersion: 1,
    profileName: 'p',
    colors: [],
    fonts: [],
    textStyles: [],
    components: [
      {
        source: { kind: 'component', componentName: 'Button' },
        target: { symbol: 'AppButton' },
        arguments: [
          { argument: 'content', source: { kind: 'content' } },
          { argument: 'modifier', source: { kind: 'modifier' } },
        ],
      },
    ],
  }).profile!;
  const root = frameNode('root', 'Root', { width: 200, height: 80 }, [
    instanceNode('i1', 'Save', {
      mainComponent: { name: 'Button', id: 'c1' },
      layoutMode: 'VERTICAL',
      itemSpacing: 4,
      width: 200, height: 80,
    }, [
      textNode('b1', 'Label', { characters: 'Sign in' }),
      rectNode('r1', 'Dot', { layoutPositioning: 'ABSOLUTE', x: 150, y: 8, width: 20, height: 20 }),
    ]),
  ]);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const result = generateCode([doc!], { packageName: 'com.example.app', profile });
  const code = result.files[0]!.content;
  assert.match(code, /AppButton\(modifier = Modifier\.size\(200\.dp, 80\.dp\)\) \{/);
  // The content lambda hosts the wrapper Box: flow container first, then the
  // offset child.
  assert.match(code, /\) \{\s*\n\s*Box \{\s*\n\s*Column\(verticalArrangement = Arrangement\.spacedBy\(4\.dp\)\) \{/);
  assert.match(code, /\.size\(20\.dp\)\s*\n\s*\.offset\(150\.dp, 8\.dp\)/);
});

test('mapped instances without a content argument report omitted children', () => {
  const profile = parseMappingProfile({
    schemaVersion: 1,
    profileName: 'p',
    colors: [],
    fonts: [],
    textStyles: [],
    components: [
      {
        source: { kind: 'component', componentName: 'Button' },
        target: { symbol: 'AppButton' },
        arguments: [{ argument: 'text', source: { kind: 'text', childIndex: 0 } }],
      },
    ],
  }).profile!;
  const root = frameNode('root', 'Root', {}, [
    instanceNode('i1', 'Save', { children: [textNode('b1', 'Label', { characters: 'Sign in' })] }),
  ]);
  const result = run(root, profile);
  assert.match(result.files[0]!.content, /AppButton\(/);
  assert.equal(
    result.diagnostics.some((d) => d.code === 'INSTANCE-CHILDREN-OMITTED'),
    true,
  );
});

test('text mapping replaces inline TextStyle with the profile typography', () => {
  const profile = parseMappingProfile({
    schemaVersion: 1,
    profileName: 'p',
    colors: [],
    fonts: [],
    textStyles: [{ source: { kind: 'fontFamily', name: 'Inter' }, target: 'MaterialTheme.typography.bodyMedium' }],
    components: [],
  }).profile!;
  const root = frameNode('root', 'Root', {}, [textNode('t1', 'Body', { characters: 'Hello' })]);
  const result = run(root, profile);
  const code = result.files[0]!.content;
  assert.match(code, /style = MaterialTheme\.typography\.bodyMedium/);
  assert.doesNotMatch(code, /TextStyle\(/);
});

test('multiple roots produce unique function arguments and files', () => {
  const doc1 = new Extractor(testContext()).extractRoot(frameNode('a', 'Header', { width: 100, height: 40 }));
  const doc2 = new Extractor(testContext()).extractRoot(frameNode('b', 'Header', { width: 100, height: 40 }));
  assert.notEqual(doc1, null);
  assert.notEqual(doc2, null);
  const result = generateCode([doc1!, doc2!], { packageName: 'com.example.app', profile: null });
  assert.equal(result.files.length, 2);
  assert.notEqual(result.files[0]!.path, result.files[1]!.path);
});

test('generator forwards extractor diagnostics verbatim first', () => {
  const root = columnFixture();
  const ghost = textNode('ghost', 'Ghost', { visible: false, characters: 'hidden' });
  root.children!.push(ghost);
  const doc = new Extractor(testContext()).extractRoot(root);
  assert.notEqual(doc, null);
  const extractorCodes = doc!.diagnostics.map((d) => d.code);
  assert.equal(extractorCodes.includes('NODE-INVISIBLE'), true);
  const result = generateCode([doc!], { packageName: 'com.example.app', profile: null });
  // The extractor's diagnostics are forwarded verbatim (codes survive the merge).
  assert.equal(result.diagnostics.some((d) => d.code === 'NODE-INVISIBLE'), true);
  assert.deepEqual(
    result.diagnostics.filter((d) => extractorCodes.includes(d.code)).map((d) => d.code),
    extractorCodes,
  );
});

/* --------------------- variant code shape (rev 27) --------------------- */

const variantRecord = (
  set: { id: string; name: string },
  master: { name: string; id: string },
  props?: InstanceComponentInfo['props'],
): InstanceComponentInfo => ({ name: master.name, id: master.id, set, props: props ?? null });

test('auto shape lifts value-only variant differences into typed parameters', () => {
  const root = frameNode('root', 'Root', { width: 420, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56, fills: [solidPaint({ r: 0.149, g: 0.388, b: 0.922 })] }, []),
    instanceNode('a2', 'NeutralBtn', { mainComponent: { name: 'Type=Neutral', id: 'comp:p2' }, variantProperties: { Type: 'Neutral' }, x: 0, y: 80, width: 200, height: 56, fills: [solidPaint({ r: 0.38, g: 0.44, b: 0.5 })] }, []),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }),
    a2: variantRecord(set, { name: 'Type=Neutral', id: 'comp:p2' }),
  };
  const result = run(root, null, {}, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  // One composable: no `when`, and the variant-key enum is not minted
  // because nothing dispatches on the keys.
  assert.match(comp, /fun Button\(/);
  assert.doesNotMatch(comp, /when \(/);
  assert.doesNotMatch(comp, /enum class/);
  // The differing fill lifts into a typed Color parameter with the
  // reference variant's value as the default.
  assert.match(comp, /color: Color = Color\(0x[0-9A-F]+\),/);
  // The choice is reported so the report explains the shape.
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-VARIANT-PARAMS'), true);
  // Call sites: the reference variant passes no value chip, the other one
  // carries its own color (instance-shell colors stay on the modifier).
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.equal((screen.match(/Button\(/g) ?? []).length, 2);
  assert.equal((screen.match(/^\s+color = Color\(0x/gm) ?? []).length, 1);
});

test('auto shape collapses variants whose bodies render identically', () => {
  const root = frameNode('root', 'Root', { width: 420, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, [
      textNode('a1lbl', 'Label', { characters: 'Sign in' }),
    ]),
    instanceNode('a2', 'SecondaryBtn', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, x: 0, y: 80, width: 200, height: 56 }, [
      textNode('a2lbl', 'Label', { characters: 'Create account' }),
    ]),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }, { 'Label#1:2': { kind: 'TEXT', value: 'Sign in' } }),
    a2: variantRecord(set, { name: 'Type=Secondary', id: 'comp:p2' }, { 'Label#1:2': { kind: 'TEXT', value: 'Create account' } }),
  };
  const result = run(root, null, {}, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  // The text differences became the `label` parameter, so the bodies are
  // identical: one shared composable, no `when`, no enum.
  assert.equal((comp.match(/fun Button\(/g) ?? []).length, 1);
  assert.doesNotMatch(comp, /when \(/);
  assert.doesNotMatch(comp, /enum class/);
  assert.match(comp, /label: String = "Sign in",/);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.equal((screen.match(/Button\(/g) ?? []).length, 2);
  assert.equal((screen.match(/label = "/g) ?? []).length, 2);
  assert.equal((screen.match(/type = /g) ?? []).length, 0);
});

test('auto shape explodes into per-variant composables when bodies diverge structurally', () => {
  const root = frameNode('root', 'Root', { width: 420, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, [
      textNode('a1lbl', 'Label', { characters: 'Sign in' }),
    ]),
    instanceNode('a2', 'DetailedBtn', { mainComponent: { name: 'Type=Detailed', id: 'comp:p2' }, variantProperties: { Type: 'Detailed' }, x: 0, y: 80, width: 200, height: 56 }, [
      rectNode('a2r1', 'Pill', { cornerRadius: 12 }),
      textNode('a2lbl', 'Label', { x: 8, characters: 'Create account' }),
      rectNode('a2r2', 'Pill 2', { x: 20, cornerRadius: 12 }),
      ellipseNode('a2e', 'Dot'),
      rectNode('a2r3', 'Pill 3', { x: 40, cornerRadius: 12 }),
    ]),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }),
    a2: variantRecord(set, { name: 'Type=Detailed', id: 'comp:p2' }),
  };
  const result = run(root, null, {}, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  // One composable per variant named from the component + its values.
  assert.match(comp, /fun ButtonPrimary\(/);
  assert.match(comp, /fun ButtonDetailed\(/);
  assert.doesNotMatch(comp, /when \(/);
  assert.doesNotMatch(comp, /enum class/);
  assert.doesNotMatch(comp, /object Button/);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-VARIANT-FUNCTIONS'), true);
  // Call sites pick their variant's function directly.
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.match(screen, /ButtonPrimary\(/);
  assert.match(screen, /ButtonDetailed\(/);
  assert.equal((screen.match(/Box\(/g) ?? []).length, 1); // root only
});

test('auto shape keeps the parameterized when for moderate structural differences', () => {
  const root = frameNode('root', 'Root', { width: 420, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, [
      textNode('a1lbl', 'Label', { characters: 'Title' }),
      rectNode('a1r1', 'Row', {}),
      rectNode('a1r2', 'Row', { y: 12 }),
      rectNode('a1r3', 'Row', { y: 24 }),
      rectNode('a1r4', 'Row', { y: 36 }),
    ]),
    instanceNode('a2', 'ExtraBtn', { mainComponent: { name: 'Type=Extra', id: 'comp:p2' }, variantProperties: { Type: 'Extra' }, x: 0, y: 80, width: 200, height: 56 }, [
      textNode('a2lbl', 'Label', { characters: 'Title' }),
      rectNode('a2r1', 'Row', {}),
      rectNode('a2r2', 'Row', { y: 12 }),
      rectNode('a2r3', 'Row', { y: 24 }),
      rectNode('a2r4', 'Row', { y: 36 }),
      rectNode('a2r5', 'Row', { y: 48 }),
    ]),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }),
    a2: variantRecord(set, { name: 'Type=Extra', id: 'comp:p2' }),
  };
  const result = run(root, null, {}, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  // One extra child box shifts the body slightly: too structural to lift
  // into parameters, too small to justify separate composables — the `when`
  // stays.
  assert.match(comp, /enum class ButtonType/);
  assert.match(comp, /when \(type\) \{/);
  assert.doesNotMatch(comp, /fun ButtonPrimary\(/);
});

test('functions shape always emits one top-level composable per variant', () => {
  const root = frameNode('root', 'Root', { width: 400, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, []),
    instanceNode('a2', 'SecondaryBtn', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, x: 0, y: 80, width: 200, height: 56 }, []),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }),
    a2: variantRecord(set, { name: 'Type=Secondary', id: 'comp:p2' }),
  };
  const result = run(root, null, { variantShape: 'functions' }, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  assert.match(comp, /fun ButtonPrimary\(/);
  assert.match(comp, /fun ButtonSecondary\(/);
  assert.doesNotMatch(comp, /when \(/);
  assert.doesNotMatch(comp, /enum class/);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.match(screen, /ButtonPrimary\(/);
  assert.match(screen, /ButtonSecondary\(/);
});

test('object shape nests the per-variant composables inside an object', () => {
  const root = frameNode('root', 'Root', { width: 400, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, []),
    instanceNode('a2', 'SecondaryBtn', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, x: 0, y: 80, width: 200, height: 56 }, []),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }),
    a2: variantRecord(set, { name: 'Type=Secondary', id: 'comp:p2' }),
  };
  const result = run(root, null, { variantShape: 'object' }, records);
  const comp = result.files.find((f) => f.path === 'Button.kt')!.content;
  assert.match(comp, /object Button \{/);
  assert.match(comp, /^ {4}fun Primary\(/m);
  assert.match(comp, /^ {4}fun Secondary\(/m);
  assert.doesNotMatch(comp, /when \(/);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.match(screen, /Button\.Primary\(/);
  assert.match(screen, /Button\.Secondary\(/);
});

test('variant masters harvested from their set extend values and branches', () => {
  const screenTree = frameNode('root', 'Root', { width: 400, height: 300 }, [
    instanceNode('a1', 'PrimaryBtn', { mainComponent: { name: 'Type=Primary', id: 'comp:p1' }, variantProperties: { Type: 'Primary' }, width: 200, height: 56 }, []),
  ]);
  const set = { id: 'set:button', name: 'Button' };
  const records: Record<string, InstanceComponentInfo | null> = {
    a1: variantRecord(set, { name: 'Type=Primary', id: 'comp:p1' }),
  };
  const doc = new Extractor({
    ...testContext(),
    instanceComponentLookup: (id) => records[id] ?? null,
  }).extractRoot(screenTree);
  assert.notEqual(doc, null);

  // The plugin-side expansion extracts that set's remaining master from the
  // source and hands its IR instance to the generator via variantMasters.
  const masterTree = instanceNode('b1', 'Type=Secondary', { mainComponent: { name: 'Type=Secondary', id: 'comp:p2' }, variantProperties: { Type: 'Secondary' }, width: 220, height: 60 }, []);
  const masterRecords: Record<string, InstanceComponentInfo | null> = { b1: variantRecord(set, { name: 'Type=Secondary', id: 'comp:p2' }) };
  const masterDoc = new Extractor({
    ...testContext(),
    instanceComponentLookup: (id) => masterRecords[id] ?? null,
  }).extractRoot(masterTree);
  assert.notEqual(masterDoc, null);

  const whenShape = generateCode([doc!], {
    packageName: 'com.example.app',
    profile: null,
    variantShape: 'when',
    variantMasters: [masterDoc!.root as unknown as IrInstanceNode],
  });
  const comp = whenShape.files.find((f) => f.path === 'Button.kt')!.content;
  // Values extend beyond the selection's instances:
  assert.match(comp, /enum class ButtonType \{ PRIMARY, SECONDARY \}/);
  assert.match(comp, /ButtonType\.SECONDARY -> \{/);
  assert.match(comp, /ButtonType\.PRIMARY -> \{/);
  // The screen instantiates only the Primary variant.
  assert.equal((comp.match(/ButtonType\.SECONDARY -> /g) ?? []).length, 1);

  const functionsShape = generateCode([doc!], {
    packageName: 'com.example.app',
    profile: null,
    variantShape: 'functions',
    variantMasters: [masterDoc!.root as unknown as IrInstanceNode],
  });
  const fns = functionsShape.files.find((f) => f.path === 'Button.kt')!.content;
  assert.match(fns, /fun ButtonPrimary\(/);
  assert.match(fns, /fun ButtonSecondary\(/);
});

/* --------------- component configuration descriptions (rev 28) --------------- */

const ccd = (yaml: string) => parseComposeConfig(`compose-studio:\n${yaml}`).config!;

test('card role with an exact look emits through Material Card with role parameters', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'Card', { mainComponent: { name: 'Card', id: 'comp:card1' }, width: 200, height: 96, cornerRadius: 12, clipsContent: true, fills: [solidPaint({ r: 0.97, g: 0.97, b: 0.98 })] }, [
      textNode('a1t', 'Title', { characters: 'Your balance' }),
    ]),
  ]);
  const set = { id: 'set:card', name: 'Card' };
  const records = {
    a1: { name: 'Card', id: 'comp:card1', set, props: null, config: ccd('role: card') },
  };
  const result = run(root, null, { componentConfigs: { 'comp:card1': ccd('role: card') } }, records);
  const comp = result.files.find((f) => f.path === 'Card.kt');
  assert.notEqual(comp, undefined);
  const body = comp!.content;
  // Role parameters land right after the modifier, with inert defaults.
  assert.match(body, /fun Card\(/);
  assert.match(body, /modifier: Modifier = Modifier,\n\s{4}onClick: \(\) -> Unit = \{ \},/);
  // The Material implementation: colors/shape/elevation as arguments; the
  // background no longer paints through the modifier.
  assert.match(body, /import androidx\.compose\.material3\.Card\n/);
  assert.match(body, /Card\(\n\s+onClick = onClick,\n\s+colors = CardDefaults\.cardColors\(containerColor = Color\(0x[0-9A-F]+\)\),\n\s+shape = RoundedCornerShape\(12\.dp\),\n\s+elevation = CardDefaults\.cardElevation\(defaultElevation = 0\.dp\),/);
  assert.doesNotMatch(body, /\.background\(color = Color\(0xFFF/);
  // The choice is reported.
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-CONFIG'), true);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-CONFIG-ROLE' && d.message.includes('Material 3 Card')), true);
  // Call sites stay unchanged (defaults carry the role parameters).
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.match(screen, /Card\(/);
  assert.doesNotMatch(screen, /onClick = /);
});

test('button role under implementation: custom keeps the plain emission and becomes ripple-free clickable', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'Submit', { mainComponent: { name: 'Submit', id: 'comp:sub1' }, width: 200, height: 56, cornerRadius: 8, clipsContent: true, fills: [solidPaint({ r: 0.1, g: 0.4, b: 0.9 })] }, [
      textNode('a1t', 'Label', { characters: 'Sign in' }),
    ]),
  ]);
  const yaml = 'role: button\nimplementation: custom';
  const set = { id: 'set:sub', name: 'Submit' };
  const records = { a1: { name: 'Submit', id: 'comp:sub1', set, props: null, config: ccd(yaml) } };
  const result = run(root, null, { componentConfigs: { 'comp:sub1': ccd(yaml) } }, records);
  const body = result.files.find((f) => f.path === 'Submit.kt')!.content;
  // No Material route: the design paints through the custom chain.
  assert.doesNotMatch(body, /material3\.Button/);
  assert.doesNotMatch(body, /ButtonDefaults/);
  assert.match(body, /\.background\(/);
  // Role parameters stay; the root wraps in a ripple-free clickable that
  // carries the minted handlers (prepended so the whole node is hittable).
  assert.match(body, /onClick: \(\) -> Unit = \{ \},\n\s{4}enabled: Boolean = true,/);
  assert.match(body, /\.clickable\(onClick = onClick, enabled = enabled, indication = null, interactionSource = remember \{ MutableInteractionSource\(\) \}\)/);
  assert.match(body, /import androidx\.compose\.foundation\.clickable\n/);
  assert.match(body, /import androidx\.compose\.foundation\.interaction\.MutableInteractionSource\n/);
});

test('non-material roles mint parameters without changing the visual layout', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'VolumeSlider', { mainComponent: { name: 'VolumeSlider', id: 'comp:s1' }, width: 240, height: 40 }, []),
  ]);
  const records = { a1: { name: 'VolumeSlider', id: 'comp:s1', set: { id: 'set:s1', name: 'VolumeSlider' }, props: null, config: ccd('role: slider') } };
  const result = run(root, null, { componentConfigs: { 'comp:s1': ccd('role: slider') } }, records);
  const body = result.files.find((f) => f.path === 'VolumeSlider.kt')!.content;
  assert.match(body, /value: Float = 0f,\n\s{4}onValueChange: \(Float\) -> Unit = \{ \},\n\s{4}enabled: Boolean = true,/);
  // The layout emission itself is untouched (no click wiring, no Material).
  assert.doesNotMatch(body, /clickable\(/);
  assert.doesNotMatch(body, /material3\.Slider/);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-CONFIG'), true);
});

test('kind: icon config exports unprefixed instances as assets and skips their subtree', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'Star', { mainComponent: { name: 'Star', id: 'comp:star1' }, width: 24, height: 24 }, [
      vectorNode('a1v', 'StarShape'),
      textNode('a1x', 'Inner', { characters: 'Hidden' }),
    ]),
  ]);
  const records = { a1: { name: 'Star', id: 'comp:star1', set: { id: 'set:star1', name: 'Star' }, props: null, config: ccd('kind: icon') } };
  const result = run(root, null, { componentConfigs: { 'comp:star1': ccd('kind: icon') } }, records);
  // The subtree never reached the IR (extractor skipped it), so the inner
  // text does not exist in the screen and no component file is minted.
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.doesNotMatch(screen, /Hidden/);
  assert.equal(result.files.some((f) => f.path === 'Star.kt'), false);
  // The instance itself became an Image referencing an exported asset; the
  // name needs no icon prefix.
  assert.match(screen, /Image\(\n\s+painter = painterResource\(R\.drawable\.ic_star\),\n\s+contentDescription = null,/);
  assert.equal(result.assets.some((a) => a.name === 'ic_star' && a.kind === 'svg'), true);
  assert.equal(result.diagnostics.some((d) => d.code === 'COMPONENT-CONFIG-ASSET'), true);
});

test('assets: export renders the whole instance as an asset without code', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'HeroCard', { mainComponent: { name: 'HeroCard', id: 'comp:hero1' }, width: 200, height: 96 }, [
      textNode('a1t', 'Title', { characters: 'Banner' }),
    ]),
  ]);
  const records = { a1: { name: 'HeroCard', id: 'comp:hero1', set: { id: 'set:hero1', name: 'HeroCard' }, props: null, config: ccd('assets: export') } };
  const result = run(root, null, { componentConfigs: { 'comp:hero1': ccd('assets: export') } }, records);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.equal(result.files.some((f) => f.path === 'HeroCard.kt'), false);
  assert.doesNotMatch(screen, /Banner/);
  assert.match(screen, /painter = painterResource\(R\.drawable\.ic_herocard\)/);
  assert.equal(result.assets.some((a) => a.name === 'ic_herocard'), true);
});

test('assets: code overrides kind so the component generates code after all', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'Star', { mainComponent: { name: 'Star', id: 'comp:star2' }, width: 24, height: 24 }, [
      textNode('a1x', 'Inner', { characters: 'Real' }),
    ]),
  ]);
  const yaml = 'kind: icon\nassets: code';
  const records = { a1: { name: 'Star', id: 'comp:star2', set: { id: 'set:star2', name: 'Star' }, props: null, config: ccd(yaml) } };
  const result = run(root, null, { componentConfigs: { 'comp:star2': ccd(yaml) } }, records);
  // No asset and no Image: the component keeps its full code emission.
  assert.equal(result.assets.some((a) => a.name === 'ic_star'), false);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.doesNotMatch(screen, /painterResource/);
  assert.match(screen, /Star\(/);
  const comp = result.files.find((f) => f.path === 'Star.kt');
  assert.notEqual(comp, undefined);
  assert.match(comp!.content, /Real/);
});

test('the configuration mapping maps instances to an app composable without an auto file', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'Badge', { mainComponent: { name: 'Badge', id: 'comp:badge1' }, width: 60, height: 24 }, [
      textNode('a1t', 'Label', { characters: 'Home' }),
    ]),
  ]);
  const yaml = 'mapping: MyAppBadge\nmappingArgs: title=@text, alpha=0.8';
  const records = { a1: { name: 'Badge', id: 'comp:badge1', set: null, props: null, config: ccd(yaml) } };
  const result = run(root, null, { componentConfigs: { 'comp:badge1': ccd(yaml) } }, records);
  // No auto component: every instance calls the mapped symbol with its
  // resolved arguments (the first text feeds `title`, 0.8 is a constant).
  assert.equal(result.files.some((f) => f.path === 'Badge.kt'), false);
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.match(screen, /MyAppBadge\(/);
  assert.match(screen, /title = "Home",/);
  assert.match(screen, /alpha = 0\.8,/);
});

test('typed mapping arguments render Kotlin literals (suffixes, units, colors, strings)', () => {
  const root = frameNode('root', 'Root', { width: 300, height: 200 }, [
    instanceNode('a1', 'Badge', { mainComponent: { name: 'Badge', id: 'comp:badge2' }, width: 60, height: 24 }, [
      textNode('a1t', 'Label', { characters: 'Home' }),
    ]),
  ]);
  const yaml = 'mapping: MyAppBadge\nmappingArgs: count=int:42, delay=long:5, opacity=float:0.5, ratio=double:0.5,'
    + ' on=boolean:true, label=string:Signed, ch=char:a, pad=dp:16, size=sp:14, tint=color:80FF40, style=object:TextStyle.Default';
  const result = run(root, null, { componentConfigs: { 'comp:badge2': ccd(yaml) } });
  const screen = result.files.find((f) => f.path === 'RootScreen.kt')!.content;
  assert.match(screen, /count = 42,/);
  assert.match(screen, /delay = 5L,/);
  assert.match(screen, /opacity = 0\.5f,/);
  assert.match(screen, /ratio = 0\.5,/);
  assert.match(screen, /on = true,/);
  assert.match(screen, /label = "Signed",/);
  assert.match(screen, /ch = 'a',/);
  assert.match(screen, /pad = 16\.dp,/);
  assert.match(screen, /size = 14\.sp,/);
  assert.match(screen, /tint = Color\(0xFF80FF40\),/);
  assert.match(screen, /style = TextStyle\.Default,/);
  const imports = screen.split('\n').filter((l) => l.startsWith('import '));
  assert.ok(imports.includes('import androidx.compose.ui.unit.dp'), 'dp arguments import the unit extension');
  assert.ok(imports.includes('import androidx.compose.ui.unit.sp'), 'sp arguments import the unit extension');
  assert.ok(imports.includes('import androidx.compose.ui.graphics.Color'), 'color arguments import Color');
});

test('the unit-import sweep fixes missing dp/sp imports for plain layout emission too', () => {
  // columnFixture emits .dp/.sp literals but never wired the unit imports.
  const result = run(columnFixture());
  const imports = result.files[0]!.content.split('\n').filter((l) => l.startsWith('import '));
  assert.ok(imports.includes('import androidx.compose.ui.unit.dp'));
  assert.ok(imports.includes('import androidx.compose.ui.unit.sp'));
});
