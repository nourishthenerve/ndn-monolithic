// WCAG 2.x relative luminance / contrast ratio (§1.4.3, §1.4.11). Every
// colour token pair in color.ts is checked against this at module-load
// time, so a regressed hex value fails color.test.ts rather than shipping.

function hexToRgb(hex: string): readonly [number, number, number] {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3 ? [...normalized].map((c) => c + c).join('') : normalized;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function channelLuminance(channel8Bit: number): number {
  const normalized = channel8Bit / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two colours, order-independent, range [1, 21]. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lighter = Math.max(relativeLuminance(hexA), relativeLuminance(hexB));
  const darker = Math.min(relativeLuminance(hexA), relativeLuminance(hexB));
  return (lighter + 0.05) / (darker + 0.05);
}
