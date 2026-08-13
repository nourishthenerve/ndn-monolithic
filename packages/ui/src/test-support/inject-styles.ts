import { primitiveStylesCss } from '../components/primitive-styles.js';

/** Injects the real shared stylesheet into jsdom's document so `getComputedStyle` in a component test reflects actual class-based rules, not just inline styles. */
export function injectPrimitiveStyles(): void {
  const style = document.createElement('style');
  style.textContent = primitiveStylesCss;
  document.head.appendChild(style);
}
