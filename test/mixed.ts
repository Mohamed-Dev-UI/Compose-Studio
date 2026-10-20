/**
 * Shared helper for building the `figma.mixed` stand-in used by fixtures.
 * Split out so most test files only import what they need.
 */
export function mixedMarkerHelper(): symbol {
  return Symbol('mixed');
}
