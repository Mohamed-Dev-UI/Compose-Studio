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
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    appendChild(child: El): El {
      if (!Array.isArray(this.children)) this.children = [];
      this.children.push(child);
      return child;
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
