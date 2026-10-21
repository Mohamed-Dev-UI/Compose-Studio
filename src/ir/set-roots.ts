/**
 * Component-set roots: reshaping IR documents per the shared
 * `componentSetBehavior` choice.
 *
 * A COMPONENT_SET selected as a conversion root extracts as a plain container
 * (kind COMPONENT) whose children are the variant masters — historically that
 * emitted the set's whole canvas as one frame composable. The shared behavior
 * control (visible on every plugin tab while the selection holds a set)
 * decides what the root becomes instead:
 *
 * - `component` — the set's document is dropped; every master child becomes a
 *   "detached" virtual instance (component set + variant props attached) that
 *   feeds the generator's variant machinery, so the output is just the
 *   component with variant parameters, never the frame.
 * - `frame` — the document stays untouched: the set's canvas emits as a plain
 *   frame composable with all variants inline (the historical behavior).
 * - `frame-of-components` — the document stays; every master child becomes a
 *   self-referencing instance node (no variant props, component name derived
 *   from set + values), so the generator emits one plain composable per
 *   variant and the frame composable calls them in layout order.
 */

import type { ComponentSetBehavior } from '../shared/messages.ts';
import type { IrContainerNode, IrDiagnostic, IrDocument, IrInstanceNode, IrNode } from './ir.ts';
import { pascalCase } from '../util/identifiers.ts';

/**
 * Parses a variant master's name ("Primary=Default, Size=Large") into its
 * variant property assignments. Returns null when the name carries no
 * assignments (plain component names, empty strings).
 */
export function parseVariantProps(name: string): Record<string, string> | null {
  const parts = String(name).split(',');
  const props: Record<string, string> = {};
  for (const raw of parts) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return props && Object.keys(props).length > 0 ? props : null;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!key || !value) return Object.keys(props).length > 0 ? props : null;
    props[key] = value;
  }
  return Object.keys(props).length > 0 ? props : null;
}

/** Plugin-side diagnostic notice produced by a reshape application. */
export type SetRootNotice = {
  level: 'info' | 'warning';
  message: string;
  nodeName?: string;
  nodeKind?: string;
};

/** One component-set root whose document was reshaped (not `frame`). */
export type SetRootApplication = {
  setId: string;
  setName: string;
  behavior: ComponentSetBehavior;
  /** Master node ids that were reshaped (or, for `frame`, kept as content). */
  masterIds: string[];
};

export type SetRootReshape = {
  /** Documents to keep in the conversion (set roots under `frame`). */
  docs: IrDocument[];
  /** Virtual instances for dropped set roots (`component` mode). */
  detached: IrInstanceNode[];
  /** setId -> master ids already coded by the reshape (no re-harvest). */
  coverage: Map<string, Set<string>>;
  /** One entry per reshaped set root, in document order. */
  applied: SetRootApplication[];
  /** Report notices describing what was applied. */
  notices: SetRootNotice[];
  /** Diagnostics of dropped set-root documents (`component` mode), pre-formatted. */
  droppedDiagnostics: IrDiagnostic[];
};

/** True when the IR node is a component-set conversion root. */
function isSetRoot(node: IrNode): node is IrContainerNode {
  return node.type === 'container' && node.ref.fType === 'COMPONENT_SET';
}

/** True when the IR node is a variant master extracted from a set root. */
function isMasterChild(node: IrNode): node is IrContainerNode {
  return node.type === 'container' && node.ref.fType === 'COMPONENT';
}

/** Per-variant composable name: set name + the master's values, Pascal-cased. */
function frameOfComponentsName(setName: string, masterName: string): string {
  const props = parseVariantProps(masterName);
  const values = props ? Object.values(props) : [masterName];
  return setName + values.map((v) => pascalCase(v)).join('');
}

/** Reshapes one extracted variant-master container into a synthetic instance. */
function masterToInstance(
  master: IrContainerNode,
  setId: string,
  setName: string,
  behavior: Exclude<ComponentSetBehavior, 'frame'>,
): IrInstanceNode {
  const props = parseVariantProps(master.ref.nodeName);
  return {
    type: 'instance',
    id: master.id,
    ref: master.ref,
    index: master.index,
    parent: master.parent,
    idPath: master.idPath,
    geometry: master.geometry,
    absolute: master.absolute,
    background: master.background,
    extraBackgrounds: master.extraBackgrounds,
    border: master.border,
    radius: master.radius,
    opacity: master.opacity,
    clip: master.clip,
    effects: master.effects,
    componentName: behavior === 'component'
      ? master.ref.nodeName
      : frameOfComponentsName(setName, master.ref.nodeName),
    componentKey: master.id,
    // `component` keeps the variant identity for the parameterized component;
    // `frame-of-components` bakes it into the per-variant function name, so
    // the group stays single-master with no variant parameters.
    variantProps: behavior === 'component' ? props : null,
    componentSet: behavior === 'component' ? { id: setId, name: setName } : null,
    // An empty (non-null) snapshot marks the instance as snapshot-backed, so
    // the generator's legacy plain-layout fallback does not skip the group.
    componentProps: behavior === 'component' ? null : {},
    children: master.children,
    layout: master.layout,
    sizing: master.sizing,
  };
}

/**
 * Applies the shared component-set behavior to every set root among the
 * documents. Documents that are not set roots (and set roots under `frame`)
 * pass through untouched.
 */
export function applyComponentSetBehavior(docs: IrDocument[], behavior: ComponentSetBehavior): SetRootReshape {
  const kept: IrDocument[] = [];
  const detached: IrInstanceNode[] = [];
  const coverage = new Map<string, Set<string>>();
  const applied: SetRootApplication[] = [];
  const notices: SetRootNotice[] = [];
  const droppedDiagnostics: IrDiagnostic[] = [];

  for (const doc of docs) {
    if (behavior === 'frame' || !isSetRoot(doc.root)) {
      kept.push(doc);
      continue;
    }
    const setRoot = doc.root;
    const setId = setRoot.id;
    const setName = setRoot.ref.nodeName || setRoot.id;
    const masterIds: string[] = [];
    const strayNames: string[] = [];
    const members: IrInstanceNode[] = [];
    for (const child of setRoot.children) {
      if (isMasterChild(child)) {
        masterIds.push(child.id);
        members.push(masterToInstance(child, setId, setName, behavior));
      } else {
        strayNames.push(child.ref.nodeName);
      }
    }
    if (masterIds.length === 0) {
      // No variant masters inside: nothing to decide; keep the frame.
      kept.push(doc);
      continue;
    }

    const covered = coverage.get(setId) ?? new Set<string>();
    for (const id of masterIds) covered.add(id);
    coverage.set(setId, covered);
    applied.push({ setId, setName, behavior, masterIds });

    if (behavior === 'component') {
      detached.push(...members);
      droppedDiagnostics.push(...doc.diagnostics);
      notices.push({
        level: 'info',
        message: `[COMPONENT-SET-ROOT] Component set '${setName}' is treated as one component with ${masterIds.length} variant${masterIds.length === 1 ? '' : 's'}; its canvas frame is not emitted.`,
        nodeName: setName,
        nodeKind: 'COMPONENT_SET',
      });
      if (strayNames.length > 0) {
        notices.push({
          level: 'warning',
          message: `[COMPONENT-SET-ROOT] Component set '${setName}' holds non-variant content (${strayNames.join(', ')}) that is dropped when the set is treated as one component.`,
          nodeName: setName,
          nodeKind: 'COMPONENT_SET',
        });
      }
    } else {
      setRoot.children = members.length === setRoot.children.length
        ? members
        : setRoot.children.map((child) => (isMasterChild(child) ? members.find((m) => m.id === child.id) ?? child : child));
      notices.push({
        level: 'info',
        message: `[COMPONENT-SET-ROOT] Component set '${setName}' is treated as a frame of components: one composable per variant (${masterIds.length}) plus the frame composable.`,
        nodeName: setName,
        nodeKind: 'COMPONENT_SET',
      });
      kept.push(doc);
    }
  }

  return { docs: kept, detached, coverage, applied, notices, droppedDiagnostics };
}
