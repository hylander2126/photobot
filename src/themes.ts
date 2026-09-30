import * as THREE from 'three';

/** Quick-pick presets; any hex colour works as a theme. */
export const PRESETS = {
  White: '#f3f3f1',
  Cream: '#ece0c6',
  Blue: '#2f6bd8',
  Orange: '#f07a1c',
} as const;

export interface MaterialSpec {
  color: THREE.Color;
  roughness: number;
  metalness: number;
}

export interface Palette {
  link: MaterialSpec;
  joint: MaterialSpec;
  accent: MaterialSpec;
}

const SILVER = new THREE.Color('#b9bdc5');
const DARK_ACCENT = new THREE.Color('#2a2d33');
const LIGHT_ACCENT = new THREE.Color('#c9cdd3');

/** Derive the multi-tone material set from a single theme colour. */
export function buildPalette(hex: string): Palette {
  const base = new THREE.Color(hex);
  const hsl = base.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);

  let joint: MaterialSpec;
  if (hsl.l > 0.75) {
    // Light themes: joints become a brushed-metal tint of the base colour.
    joint = { color: base.clone().lerp(SILVER, 0.55), roughness: 0.3, metalness: 0.85 };
  } else {
    // Saturated / dark themes: joints become a lighter, semi-metallic tint.
    const c = new THREE.Color().setHSL(hsl.h, hsl.s * 0.8, Math.min(hsl.l + 0.22, 0.85), THREE.SRGBColorSpace);
    joint = { color: c, roughness: 0.35, metalness: 0.45 };
  }

  // Dark accents disappear on very dark themes, so switch to a light neutral.
  const accent = hsl.l < 0.25 ? LIGHT_ACCENT : DARK_ACCENT;

  return {
    link: { color: base, roughness: 0.72, metalness: 0 },
    joint,
    accent: { color: accent.clone(), roughness: 0.45, metalness: 0.25 },
  };
}
