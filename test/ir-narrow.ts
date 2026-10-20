/**
 * Runtime narrowing helpers for the IR node union in tests.
 *
 * The IR models `unknown` nodes without styling fields, and only
 * container/group/instance nodes carry children, so test code must narrow the
 * union before touching those members. These helpers assert at runtime (so a
 * changed extractor fails loudly) and hand back a precisely typed view.
 */
import assert from 'node:assert/strict';
import type { IrNode, IrStyling } from '../src/ir/ir.ts';

/** Assert the node holds children (container/group/instance) and type it (incl. styling). */
export function withChildren<N extends IrNode>(node: N): N & { children: IrNode[] } & IrStyling {
  assert.equal(
    node.type === 'container' || node.type === 'group' || node.type === 'instance',
    true,
    `node type '${node.type}' has no children`,
  );
  return node as N & { children: IrNode[] } & IrStyling;
}

/** Assert the node carries styling fields (every kind except 'unknown') and type it. */
export function withStyling(node: IrNode): { type: IrNode['type'] } & IrStyling {
  assert.notEqual(node.type, 'unknown', `node '${node.id}' unexpectedly became 'unknown'`);
  return node as { type: IrNode['type'] } & IrStyling;
}
