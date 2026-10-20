/**
 * Figma scene-graph fixtures for extractor/generator tests.
 *
 * Mocks a small subset of the Figma Plugin API (structure mirrors
 * src/extract/figma-types.ts) so the whole conversion pipeline runs under
 * Node without the `figma` global.
 */
import { mixedMarkerHelper } from './mixed.ts';

/** Marker standing in for `figma.mixed` in fixtures. */
export const MIXED = mixedMarkerHelper();

type NodeOverrides = Record<string, unknown>;

export type TestNode = NodeOverrides & {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  parent: TestNode | null;
  children?: TestNode[];
};

const solid = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
export function solidPaint(color: { r: number; g: number; b: number; a?: number }): NodeOverrides {
  return { type: 'SOLID', color, visible: true, opacity: color.a ?? 1 };
}

/** Standard FigmaContext for tests (no token table). */
export function testContext(maxNodes = 100) {
  return { mixedMarker: MIXED, maxNodes };
}

export function frameNode(id: string, name: string, overrides: NodeOverrides = {}, children: TestNode[] = []): TestNode {
  return {
    id, name, type: 'FRAME', visible: true,
    x: 0, y: 0, width: 100, height: 80,
    parent: null,
    children,
    layoutMode: 'NONE',
    clipsContent: true,
    cornerRadius: 0,
    opacity: 1,
    ...overrides,
  };
}

export function textNode(id: string, name: string, overrides: NodeOverrides = {}): TestNode {
  return {
    id, name, type: 'TEXT', visible: true,
    x: 0, y: 0, width: 120, height: 20,
    parent: null,
    characters: 'Hello',
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'TOP',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    fontSize: 14,
    fontName: { family: 'Inter', style: 'Regular' },
    fontWeight: 400,
    letterSpacing: { value: 0, unit: 'PIXELS' },
    lineHeight: { value: 20, unit: 'PIXELS' },
    textDecoration: 'NONE',
    textCase: 'ORIGINAL',
    fills: [solidPaint(solid(0, 0, 0))],
    ...overrides,
  };
}

export function rectNode(id: string, name: string, overrides: NodeOverrides = {}): TestNode {
  return {
    id, name, type: 'RECTANGLE', visible: true,
    x: 0, y: 0, width: 40, height: 40,
    parent: null,
    cornerRadius: 0,
    opacity: 1,
    ...overrides,
  };
}

export function vectorNode(id: string, name: string, overrides: NodeOverrides = {}): TestNode {
  return {
    id, name, type: 'VECTOR', visible: true,
    x: 0, y: 0, width: 24, height: 24,
    parent: null,
    cornerRadius: 0,
    opacity: 1,
    ...overrides,
  };
}

export function ellipseNode(id: string, name: string, overrides: NodeOverrides = {}): TestNode {
  return {
    id, name, type: 'ELLIPSE', visible: true,
    x: 0, y: 0, width: 48, height: 48,
    parent: null,
    cornerRadius: 0,
    opacity: 1,
    ...overrides,
  };
}

export function groupNode(id: string, name: string, children: TestNode[], overrides: NodeOverrides = {}): TestNode {
  const group: TestNode = {
    id, name, type: 'GROUP', visible: true,
    x: 0, y: 0, width: 100, height: 100,
    parent: null,
    children,
    opacity: 1,
    cornerRadius: 0,
    ...overrides,
  };
  for (const child of children) child.parent = group;
  return group;
}

export function instanceNode(id: string, name: string, overrides: NodeOverrides = {}, children: TestNode[] = []): TestNode {
  const inst: TestNode = {
    id, name, type: 'INSTANCE', visible: true,
    x: 0, y: 0, width: 200, height: 56,
    parent: null,
    children,
    mainComponent: { name: 'Button', id: 'comp:1' },
    variantProperties: null,
    layoutMode: 'NONE',
    cornerRadius: 0,
    opacity: 1,
    clipsContent: false,
    ...overrides,
  };
  for (const child of children) child.parent = inst;
  return inst;
}

export function componentNode(id: string, name: string, overrides: NodeOverrides = {}, children: TestNode[] = []): TestNode {
  const comp = frameNode(id, name, { type: 'COMPONENT', ...overrides }, children);
  return comp;
}

/** A vertical auto-layout frame with two children. */
export function columnFixture(): TestNode {
  const title = textNode('t1', 'Title', {
    characters: 'Welcome',
    fontName: { family: 'Roboto', style: 'Bold' },
    fontWeight: 700,
    fontSize: 24,
    fills: [solidPaint(solid(0, 0, 0))],
  });
  const body = textNode('t2', 'Body', {
    x: 0, y: 32,
    characters: 'Sign in to continue',
    fontSize: 14,
    fills: [solidPaint(solid(0.4, 0.4, 0.4))],
  });
  const card = frameNode('card', 'Card', {
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16,
    cornerRadius: 12,
    fills: [solidPaint(solid(1, 1, 1))],
  }, [title, body]);
  const root = frameNode('screen', 'LoginScreen', {
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24,
    counterAxisAlignItems: 'CENTER',
    fills: [solidPaint(solid(0.96, 0.96, 0.96))],
    width: 360, height: 640,
  }, [card]);
  return root;
}
