/**
 * Image byte-format sniffing: the extension written into an Android project
 * must match the actual bytes, not the requested one. Figma stores images
 * in their native format on import (a JPEG photo stays JPEG even when the
 * fill asks for "PNG bytes"), so stored-byte exports are sniffed while
 * re-rendered rasters know their format up front.
 */

/** Magic-byte detection for the two raster formats Figma/Android care about. */
export function sniffImageExt(bytes: Uint8Array): 'png' | 'jpg' {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG: FF D8 (SOI marker). Anything else that "should" be an image falls
  // back to png as the least surprising default.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  return 'png';
}
