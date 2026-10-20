import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * UI harness for the CCD visual configuration editor (rev. 29).
 *
 * The plugin UI is a plain script embedded in `src/ui/ui.html`; the esbuild
 * build embeds it as text, so a regression would only surface inside Figma.
 * This harness extracts the script, runs it under a minimal DOM stub and
 * exercises the editor through its rendered controls and postMessage
 * payloads: per-key "multiple values" detection for multi-component
 * selections, untouched-keeps-own / set-overrides-all apply snapshots,
 * mapping-argument rows, and the preset save/load/delete message contract.
 */

type El = { children?: El[]; [key: string]: unknown };

function makeStubElement(): El {
  const element: El = {
    id: '',
    children: [],
    textContent: '',
    value: '',
    type: '',
    className: '',
    title: '',
    hidden: false,
    disabled: false,
    spellcheck: false,
    placeholder: '',
    style: {},
    dataset: {},
    parentElement: null,
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    appendChild(child: El): El {
      if (!Array.isArray(this.children)) this.children = [];
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    replaceWith(next: El): void {
      const parent = this.parentElement as El | null;
      if (parent && Array.isArray(parent.children)) {
        const at = parent.children.indexOf(this);
        if (at >= 0) parent.children[at] = next;
      }
    },
    querySelectorAll(): El[] {
      return [];
    },
    querySelector(): El | null {
      return null;
    },
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    focus: () => {},
    click: () => {},
  };
  let html = '';
  Object.defineProperty(element, 'innerHTML', {
    get: () => html,
    set(value: string) {
      html = String(value);
      if (Array.isArray(element.children)) element.children.length = 0;
    },
  });
  return element;
}

type PostedMessage = { type: string; payload: unknown };
type DomStub = {
  document: { getElementById: (id: string) => El };
  stubWindow: El;
  posted: PostedMessage[];
};

function makeDomStub(): DomStub {
  const posted: PostedMessage[] = [];
  const elements = new Map<string, El>();
  const document = {
    createElement: () => makeStubElement(),
    getElementById: (id: string): El => {
      let element = elements.get(id);
      if (!element) {
        element = makeStubElement();
        element.id = id;
        elements.set(id, element);
      }
      return element;
    },
    querySelectorAll: (): El[] => [],
    addEventListener: () => {},
    body: makeStubElement(),
  };
  // The script assigns `window.onmessage = ...`; the stub window records it.
  const stubWindow: El = {};
  return { document, stubWindow, posted };
}

/** Extracts the UI script and runs it once with the stubs handed over via globals. */
function runUiScript(document: El, stubWindow: El, posted: PostedMessage[]): void {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/ui.html'), 'utf8');
  const open = html.lastIndexOf('<script>');
  const close = html.lastIndexOf('</script>');
  assert.ok(open >= 0 && close > open, 'the UI markup contains a script block');
  const source = html.slice((open as number) + '<script>'.length, close as number);

  (globalThis as Record<string, unknown>).__ccdUiStub = { document, window: stubWindow, posted };
  const preamble = [
    'const document = globalThis.__ccdUiStub.document;',
    'const window = globalThis.__ccdUiStub.window;',
    'const parent = { postMessage: (m) => { globalThis.__ccdUiStub.posted.push(m && m.pluginMessage ? m.pluginMessage : m); } };',
    'const navigator = { clipboard: { writeText() { return Promise.resolve(); } } };',
    'const crypto = { randomUUID() { return "u0"; } };',
    'const URL = { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} };',
    'const alert = () => {};',
    'const setTimeout = (fn) => { if (typeof fn === "function") fn(); return 0; };',
    'const clearTimeout = () => {};',
    'const setInterval = () => 0;',
    'const clearInterval = () => {};',
  ].join('\n');
  new Function(`${preamble}\n${source}`)();
}

const of = (posted: PostedMessage[], type: string): PostedMessage[] =>
  posted.filter((m) => (m as { type?: string }).type === type);

/* --------------------------- fixtures --------------------------- */

type PartialConfig = {
  role: string | null;
  kind: string | null;
  assets: string;
  implementation: string;
  mapping: string | null;
  mappingArgs: { argument: string; source: Record<string, unknown> }[];
  note: string | null;
};
const blankConfig = (): PartialConfig => ({
  role: null, kind: null, assets: 'auto', implementation: 'auto', mapping: null, mappingArgs: [], note: null,
});

type MasterFixture = {
  masterId: string;
  masterName: string;
  hasConfig: boolean;
  config: PartialConfig | null;
  issues?: string[];
  /** The payload's derived app-composable suggestion (null in the real flow for blank names). */
  suggestedMapping?: string;
};

function postConfigs(stubWindow: El, masters: MasterFixture[], presets: unknown[] = []): void {
  const onmessage = stubWindow.onmessage as (event: unknown) => void;
  const payload = {
    version: 1,
    template: 'compose-studio:\nrole: card',
    presets,
    masters: masters.map((master) => ({
      masterId: master.masterId,
      masterName: master.masterName,
      nodeNames: [master.masterName],
      hasConfig: master.hasConfig,
      summary: '',
      prose: '',
      blockText: null,
      issues: master.issues ?? [],
      suggestedMapping: master.suggestedMapping ?? null,
      config: master.config ? { ...master.config, tag: 'compose-studio', version: 1 } : null,
    })),
  };
  onmessage({ data: { pluginMessage: { type: 'component-configs', payload } } });
}

/** Finds elements recursively whose className contains all tokens. */
function findAll(root: El, className: string): El[] {
  const tokens = className.split(' ');
  const out: El[] = [];
  const visit = (element: El): void => {
    for (const child of Array.isArray(element.children) ? element.children : []) {
      const cls = typeof child.className === 'string' ? child.className : '';
      if (tokens.every((token) => cls.includes(token))) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

const textOf = (element: El): string => (typeof element.textContent === 'string' ? element.textContent : '');
/** textOf for an index-unsafe list (`noUncheckedIndexedAccess` friendly). */
const firstText = (list: El[]): string => {
  const first = list[0];
  return first ? textOf(first) : '';
};

/** The control element (second child) of the cc-field whose label text includes `labelPart`. */
function findFieldControl(root: El, labelPart: string): (El & { value: string; oninput?: () => void }) | undefined {
  for (const field of findAll(root, 'cc-field')) {
    const kids = Array.isArray(field.children) ? field.children : [];
    const label = kids[0];
    const span = label && Array.isArray(label.children) ? label.children[0] : undefined;
    if (span && textOf(span).includes(labelPart)) {
      const control = kids[1];
      return control ? (control as El & { value: string; oninput?: () => void }) : undefined;
    }
  }
  return undefined;
}

function findApply(host: El): (El & { onclick: () => void }) | undefined {
  const candidates = findAll(host, 'config-actions').flatMap((row) => (Array.isArray(row.children) ? row.children : []));
  return candidates.find((element) => textOf(element).startsWith('Apply')) as El & { onclick: () => void };
}

/* ---------------------------- tests ---------------------------- */

test('CCD visual editor: single configured master renders resolved values', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const card = blankConfig();
  card.role = 'card';
  postConfigs(stubWindow, [{ masterId: 'm1', masterName: 'Card/A', hasConfig: true, config: card }]);
  const host = document.getElementById('configHost') as El;
  assert.equal(findAll(host, 'config-item').length, 1, 'one editor card');
  assert.equal(findAll(host, 'cc-mixed-chip').length, 0, 'nothing is mixed for a single resolved control set');
  assert.ok(firstText(findAll(host, 'config-name')).includes('Card/A'));
  assert.equal(of(posted, 'component-configs').length, 0, 'no echo messages');
});

test('CCD visual editor: multi-selection renders a mixed chip and apply keeps untouched keys', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const cardA = blankConfig();
  cardA.role = 'card';
  postConfigs(stubWindow, [
    { masterId: 'm1', masterName: 'Card/A', hasConfig: true, config: cardA },
    { masterId: 'm2', masterName: 'Button/B', hasConfig: false, config: null },
  ]);
  const host = document.getElementById('configHost') as El;
  const chips = findAll(host, 'cc-mixed-chip');
  assert.equal(chips.length, 1, 'only the role control is mixed');
  assert.ok(firstText(chips).includes('Card'), 'the mixed chip lists the distinct roles');

  // Apply without any edit: m1 keeps card, m2 (defaults only) is left untouched.
  posted.length = 0;
  const apply = findApply(host) as El & { onclick: () => void };
  assert.ok(apply, 'an Apply button exists');
  apply.onclick();
  const writes = of(posted, 'set-component-config');
  assert.equal(writes.length, 1, 'a defaults-only master is not written');
  assert.deepEqual(
    writes[0]?.payload,
    { masterId: 'm1', config: cardA },
    'untouched keys keep the configured master own values (tag/version are added by the plugin)',
  );

  // Resolving the shared kind applies to BOTH masters on the next apply.
  posted.length = 0;
  const kindSeg = findAll(host, 'segmented')[0] as El;
  const iconBtn = (Array.isArray(kindSeg.children) ? kindSeg.children : [])
    .find((button) => textOf(button) === 'icon') as El & { onclick: () => void };
  assert.ok(iconBtn, 'the kind segmented control offers icon');
  iconBtn.onclick(); // re-renders the shared editor body
  const apply2 = findApply(host) as El & { onclick: () => void };
  assert.ok(apply2, 'apply still present after re-render');
  apply2.onclick();
  const writes2 = of(posted, 'set-component-config');
  assert.equal(writes2.length, 2, 'the resolved kind applies to both masters');
  assert.deepEqual(
    writes2.map((message) => ((message.payload as { config?: Record<string, unknown> }).config ?? {}).kind),
    ['icon', 'icon'],
  );
  assert.deepEqual(
    writes2.map((message) => ((message.payload as { config?: Record<string, unknown> }).config ?? {}).role),
    ['card', null],
    'the untouched role still keeps each master own',
  );
});

test('CCD visual editor: mapping + argument rows stay intact through apply', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const mapped = blankConfig();
  mapped.role = 'chip';
  mapped.mapping = 'com.app.X';
  mapped.mappingArgs = [
    { argument: 'label', source: { kind: 'constant', value: 'Sign In' } },
    { argument: 'icon', source: { kind: 'icon' } },
  ];
  postConfigs(stubWindow, [{ masterId: 'm3', masterName: 'Map/S', hasConfig: true, config: mapped }]);
  const host = document.getElementById('configHost') as El;
  assert.equal(findAll(host, 'cc-argrow').length, 2, 'argument rows rendered for the mapping');
  posted.length = 0;
  const apply = findApply(host) as El & { onclick: () => void };
  apply.onclick(); // no edits: the mapping config round-trips verbatim
  const writes = of(posted, 'set-component-config');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.payload, { masterId: 'm3', config: mapped });
});

test('CCD visual editor: typed constant arguments carry their datatype', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const mapped = blankConfig();
  mapped.mapping = 'com.app.Y';
  mapped.mappingArgs = [
    { argument: 'count', source: { kind: 'constant', value: '2', dataType: 'int' } },
    { argument: 'tint', source: { kind: 'color' } },
  ];
  postConfigs(stubWindow, [{ masterId: 'm14', masterName: 'Typed/A', hasConfig: true, config: mapped }]);
  const host = document.getElementById('configHost') as El;
  const rows = findAll(host, 'cc-argrow');
  assert.equal(rows.length, 2, 'typed rows render like any other argument');
  const selects = rows.map((row) => ((row.children ?? [])[1] ?? {}) as El & { value: string; onchange?: () => void });
  assert.equal(selects[0]?.value, 'typed:int', 'the datatype renders as the selected entry');
  assert.equal(selects[1]?.value, 'color', 'design sources stay bare');
  const labels = (selects[0]?.children ?? []).map((o) => textOf(o));
  assert.deepEqual(
    labels,
    ['constant', '@text', '@icon', '@color', '@content', '@modifier', 'int', 'long', 'float', 'double', 'boolean', 'string', 'char', 'dp', 'sp', 'color', 'object'],
  );
  // Switching the typed row to dp updates placeholder semantics and serialization.
  selects[0]!.value = 'typed:dp';
  selects[0]!.onchange?.();
  const rows2 = findAll(host, 'cc-argrow');
  const valueInput = ((rows2[0]!.children ?? [])[2] ?? {}) as El & { value: string; placeholder: string; oninput?: () => void };
  assert.equal(valueInput.placeholder, '16', 'the dp placeholder guides a dp value');
  valueInput.value = '16';
  valueInput.oninput?.();
  posted.length = 0;
  const apply = findApply(host) as El & { onclick: () => void };
  apply.onclick();
  const writes = of(posted, 'set-component-config');
  const config = (writes[0]?.payload as { config?: { mappingArgs?: { argument: string; source: Record<string, unknown> }[] } }).config;
  assert.deepEqual(config?.mappingArgs?.[0], { argument: 'count', source: { kind: 'constant', value: '16', dataType: 'dp' } });
  assert.deepEqual(config?.mappingArgs?.[1], { argument: 'tint', source: { kind: 'color' } });
});

test('CCD presets: save captures the shown values, list arrives via component-presets, load+apply writes it', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const configured = blankConfig();
  configured.role = 'button';
  postConfigs(stubWindow, [{ masterId: 'm4', masterName: 'Btn/D', hasConfig: true, config: configured }]);

  // Save as preset: reveal the name form and confirm.
  const host = document.getElementById('configHost') as El;
  const saveBtn = findAll(host, 'config-actions').flatMap((row) => (Array.isArray(row.children) ? row.children : []))
    .find((element) => textOf(element).includes('Save as preset')) as El & { onclick: () => void };
  assert.ok(saveBtn, 'Save as preset button exists');
  saveBtn.onclick();
  const nameInput = document.getElementById('presetNameInput') as El;
  (nameInput as { value: string }).value = '  Solid button ';
  const okButton = document.getElementById('presetSaveOk') as El & { onclick: () => void };
  assert.ok(okButton, 'the name form is revealed');
  posted.length = 0;
  okButton.onclick();
  const saves = of(posted, 'save-component-preset');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0]?.payload, {
    name: 'Solid button',
    config: { role: 'button', kind: null, assets: 'auto', implementation: 'auto', mapping: null, note: null, mappingArgs: [] },
  });

  // The plugin answers with the saved list; the bar must reflect it.
  const preset = { name: 'Solid button', config: { ...configured, tag: 'compose-studio', version: 1 } };
  const onmessage = stubWindow.onmessage as (event: unknown) => void;
  onmessage({ data: { pluginMessage: { type: 'component-presets', payload: { presets: [preset] } } } });
  assert.equal(
    textOf(document.getElementById('presetCount') as El),
    '1',
    'the preset count badge updates without an editor re-render',
  );

  // A fresh selection loads a DIFFERENT preset whose values then reach Apply.
  const target = blankConfig();
  target.role = 'chip';
  target.note = 'kept note';
  target.mappingArgs = [{ argument: 'icon', source: { kind: 'icon' } }];
  postConfigs(stubWindow, [{ masterId: 'm5', masterName: 'Chip/E', hasConfig: false, config: null }]);
  const savedList = { name: 'Chip template', config: { ...target, tag: 'compose-studio', version: 1 } };
  onmessage({ data: { pluginMessage: { type: 'component-presets', payload: { presets: [preset, savedList] } } } });
  const select = document.getElementById('presetSelect') as El;
  (select as { value: string }).value = 'Chip template';
  (select as { onchange?: () => void }).onchange?.();
  posted.length = 0;
  const apply = findApply(document.getElementById('configHost') as El) as El & { onclick: () => void };
  assert.ok(apply, 'apply button available after preset load');
  apply.onclick();
  const writes = of(posted, 'set-component-config');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.payload, { masterId: 'm5', config: target });
});

test('CCD presets: delete posts the plugin message and the bar stays usable', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const onmessage = stubWindow.onmessage as (event: unknown) => void;
  postConfigs(stubWindow, []);
  assert.equal(findAll(document.getElementById('configHost') as El, 'config-item').length, 0, 'unset selection renders the empty state');
  const del = document.getElementById('presetDeleteBtn') as El & { disabled: boolean };
  assert.equal(del.disabled, true, 'delete stays disabled without a pick');
  onmessage({ data: { pluginMessage: { type: 'component-presets', payload: { presets: [{ name: 'X', config: blankConfig() as unknown as Record<string, unknown> }] } } } });
  const select = document.getElementById('presetSelect') as El;
  (select as { value: string }).value = 'X';
  (select as { onchange?: () => void }).onchange?.();
  posted.length = 0;
  (del as { onclick?: () => void }).onclick?.();
  const deletions = of(posted, 'delete-component-preset');
  assert.equal(deletions.length, 1);
  assert.deepEqual(deletions[0]?.payload, { name: 'X' });
});

test('CCD presets: the preset bar Save current… button reveals the name form too', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const configured = blankConfig();
  configured.role = 'icon';
  postConfigs(stubWindow, [{ masterId: 'm6', masterName: 'Ic/F', hasConfig: true, config: configured }]);
  const barBtn = document.getElementById('presetSaveBtn') as El & { onclick: () => void };
  assert.ok(barBtn, 'the preset bar carries the Save current… button');
  const saveRow = document.getElementById('presetSaveRow') as El & { style: { display?: string } };
  assert.equal(saveRow.style.display, 'none', 'the name form starts hidden');
  barBtn.onclick();
  assert.notEqual(saveRow.style.display, 'none', 'the name form is revealed from the preset bar');
  const nameInput = document.getElementById('presetNameInput') as El & { value: string };
  assert.equal(nameInput.value, '', 'the name starts empty');
  nameInput.value = 'Bar path';
  const okButton = document.getElementById('presetSaveOk') as El & { onclick: () => void };
  posted.length = 0;
  okButton.onclick();
  const saves = of(posted, 'save-component-preset');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0]?.payload, {
    name: 'Bar path',
    config: { role: 'icon', kind: null, assets: 'auto', implementation: 'auto', mapping: null, note: null, mappingArgs: [] },
  });
  assert.equal(saveRow.style.display, 'none', 'the form closes after a save');
});

test('Plugin UI drops the redundant close button (Figma draws its own)', () => {
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), '../src/ui');
  const html = readFileSync(join(uiDir, 'ui.html'), 'utf8');
  assert.ok(!html.includes('closeBtn'), 'no close button markup or wiring in the UI');
  const main = readFileSync(join(uiDir, '../main.ts'), 'utf8');
  assert.ok(!main.includes('close-plugin'), 'the plugin handler for the removed button is gone too');
  assert.ok(html.includes('data-tab="settings"'), 'the Settings tab is still wired in the markup');
});

test('CCD visual editor: argument rows are reachable only through a resolved mapping', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const card = blankConfig();
  card.role = 'button';
  postConfigs(stubWindow, [{ masterId: 'm7', masterName: 'Btn/G', hasConfig: true, config: card }]);
  const host = document.getElementById('configHost') as El;
  assert.equal(findAll(host, 'cc-argrow').length, 0, 'no rows without a mapping');
  const addBefore = findAll(host, 'secondary').find((b) => textOf(b) === '+ Add argument');
  assert.ok(addBefore, 'the add affordance stays visible');
  assert.equal(addBefore?.disabled, true, 'disabled without a mapping (it used to be clickable and corrupt args state)');

  // Typing a mapping is the gate; then the add button appears and works.
  const mappingInput = findFieldControl(host, 'Mapping (app composable)');
  assert.ok(mappingInput, 'the mapping control exists');
  if (mappingInput) {
    mappingInput.value = 'My.Button';
    mappingInput.oninput?.();
    const add = findAll(host, 'secondary').find((b) => textOf(b) === '+ Add argument');
    assert.ok(add, 'the add button appears once a mapping is set');
    assert.equal(add?.disabled, false, 'and it is enabled after the mapping flip');
    (add as El & { onclick: () => void }).onclick();
    assert.equal(findAll(host, 'cc-argrow').length, 1, 'clicking add renders an editable row');

    // A row left unnamed contributes nothing on Apply (no corrupt empty args).
    posted.length = 0;
    const apply = findApply(host) as El & { onclick: () => void };
    apply.onclick();
    const writes = of(posted, 'set-component-config');
    const written = (writes[0]?.payload as { config?: { mappingArgs?: unknown[]; mapping?: string } } | undefined)?.config;
    assert.ok(written, 'apply posted');
    assert.equal(written?.mappingArgs?.length, 0, 'unnamed rows are dropped from the payload');
    assert.equal(written?.mapping, 'My.Button');
  }
});

test('CCD presets: saving an all-defaults snapshot is refused', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  postConfigs(stubWindow, [{ masterId: 'm8', masterName: 'E/H', hasConfig: false, config: null }]);
  const barBtn = document.getElementById('presetSaveBtn') as El & { onclick: () => void };
  barBtn.onclick();
  const okButton = document.getElementById('presetSaveOk') as El & { onclick: () => void };
  posted.length = 0;
  okButton.onclick();
  assert.equal(
    of(posted, 'save-component-preset').length,
    0,
    'no save message for an all-defaults editor (the form stays open)',
  );
});

test('CCD auto-assign: an empty mapping is seeded with the derived function name and Apply writes it', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  postConfigs(stubWindow, [{ masterId: 'm9', masterName: 'Working Level', hasConfig: false, config: null, suggestedMapping: 'WorkingLevel' }]);
  const host = document.getElementById('configHost') as El;
  const mappingInput = findFieldControl(host, 'Mapping (app composable)');
  assert.ok(mappingInput, 'the mapping control exists');
  assert.equal(mappingInput?.value, 'WorkingLevel', 'the derived name is pre-filled');
  const mappingField = findAll(host, 'cc-field').find((f) => {
    const kids = Array.isArray(f.children) ? f.children : [];
    const label = kids[0];
    const span = label && Array.isArray(label.children) ? label.children[0] : undefined;
    return span && textOf(span).includes('Mapping (app composable');
  });
  assert.ok(mappingField, 'the mapping field renders');
  const mappingKids = mappingField && Array.isArray(mappingField.children) ? mappingField.children : [];
  assert.ok(
    mappingKids.some((c) => textOf(c).includes('Auto-filled from the component name')),
    'a hint explains where the suggestion came from',
  );
  // A mapping resolved by the suggestion unlocks the argument editor too.
  const add = findAll(host, 'secondary').find((b) => textOf(b) === '+ Add argument');
  assert.equal(add?.disabled, false, 'the suggestion counts as a mapping for the argument gate');

  posted.length = 0;
  const apply = findApply(host) as El & { onclick: () => void };
  assert.ok(apply, 'an Apply button exists');
  apply.onclick();
  const writes = of(posted, 'set-component-config');
  assert.equal(writes.length, 1, 'the unconfigured master becomes a write via the suggestion');
  const config = (writes[0]?.payload as { config?: { mapping?: string; role?: string | null } }).config;
  assert.equal(config?.mapping, 'WorkingLevel', 'Apply writes the suggested mapping');
  assert.equal(config?.role, null, 'untouched fields stay at their defaults');
});

test('CCD auto-assign: an existing mapping is never overwritten by the suggestion', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const card = blankConfig();
  card.mapping = 'My.Button';
  postConfigs(stubWindow, [{ masterId: 'm10', masterName: 'Working Level', hasConfig: true, config: card, suggestedMapping: 'WorkingLevel' }]);
  const host = document.getElementById('configHost') as El;
  const mappingInput = findFieldControl(host, 'Mapping (app composable)');
  assert.equal(mappingInput?.value, 'My.Button', 'the explicit mapping wins');
  const mappingField = findAll(host, 'cc-field').find((f) => {
    const kids = Array.isArray(f.children) ? f.children : [];
    const label = kids[0];
    const span = label && Array.isArray(label.children) ? label.children[0] : undefined;
    return span && textOf(span).includes('Mapping (app composable');
  });
  const noHintKids = mappingField && Array.isArray(mappingField.children) ? mappingField.children : [];
  assert.ok(
    !noHintKids.some((c) => textOf(c).includes('Auto-filled')),
    'no auto-filled hint for an explicit mapping',
  );
});

test('CCD auto-assign: multi-selection seeds per-master names and Apply keeps each own', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  postConfigs(stubWindow, [
    { masterId: 'm11', masterName: 'Card/A', hasConfig: false, config: null, suggestedMapping: 'CardA' },
    { masterId: 'm12', masterName: 'Button/B', hasConfig: false, config: null, suggestedMapping: 'ButtonB' },
  ]);
  const host = document.getElementById('configHost') as El;
  const chips = findAll(host, 'cc-mixed-chip');
  assert.equal(chips.length, 1, 'only the mapping control is mixed');
  assert.ok(firstText(chips).includes('CardA'), 'the mixed chip lists the first derived name');
  assert.ok(firstText(chips).includes('ButtonB'), 'the mixed chip lists the other derived name');

  posted.length = 0;
  const apply = findApply(host) as El & { onclick: () => void };
  assert.ok(apply, 'an Apply button exists');
  apply.onclick();
  const writes = of(posted, 'set-component-config');
  assert.equal(writes.length, 2, 'both masters are written with their own suggestion');
  assert.deepEqual(
    writes.map((message) => ((message.payload as { config?: { mapping?: string } }).config ?? {}).mapping),
    ['CardA', 'ButtonB'],
    'each master gets its own derived name',
  );
});

test('CCD preset bar: built-in starters are marked, not deletable, and user presets still delete', () => {
  const { document, stubWindow, posted } = makeDomStub();
  runUiScript(document, stubWindow, posted);
  const builtin = { ...blankConfig(), role: 'button' as const };
  const mine = { ...blankConfig(), role: 'card' as const };
  postConfigs(stubWindow, [{ masterId: 'm13', masterName: 'Chip/Z', hasConfig: false, config: null }], [
    { name: 'Mine', config: mine },
    { name: 'Material Button', config: builtin, builtin: true },
  ]);
  const select = document.getElementById('presetSelect') as El & { value: string; onchange?: () => void };
  const options = Array.isArray(select.children) ? select.children : [];
  const texts = options.map(textOf);
  assert.ok(texts.some((t) => t.startsWith('Mine —')), 'the user preset lists plainly');
  assert.ok(texts.some((t) => t.startsWith('★ Material Button')), 'the built-in is marked with a star');

  // A user preset selects and deletes as before.
  const del = document.getElementById('presetDeleteBtn') as El & { disabled?: boolean; onclick: () => void };
  select.value = 'Mine';
  select.onchange?.();
  assert.equal(del.disabled, false, 'user presets are deletable');
  posted.length = 0;
  del.onclick();
  assert.equal(of(posted, 'delete-component-preset').length, 1, 'the delete message posts for a user preset');

  // A built-in starter loads but cannot be deleted.
  select.value = 'Material Button';
  select.onchange?.();
  assert.equal(del.disabled, true, 'built-ins are not deletable');

  select.value = '';
  select.onchange?.();
  assert.equal(del.disabled, true, 'deselecting gates the button again');
});
