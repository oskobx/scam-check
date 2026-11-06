// The picture your caller sees: one RGBA frame per call to drawFace.
// A friendly, smooth, anti-aliased face. Plain JavaScript, no dependencies.
// The static background (gradient, glow, shield badge) is drawn once; each frame only redraws the face area.
export const WIDTH = 640;
export const HEIGHT = 360;
export const FPS = 20;

const CX = WIDTH / 2, CY = 165, R = 96; // face center and radius (kept central so FaceTime "Fill" cropping is safe)

const SKIN = [255, 214, 145], SKIN_SHADE = [246, 178, 112], EYE = [44, 48, 78], CHEEK = [255, 132, 132];
const MOUTH = [120, 46, 62], TONGUE = [236, 110, 120], WHITE = [255, 255, 255];

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
// Anti-aliased coverage from a signed distance in pixels (negative = inside).
const cover = d => clamp01(0.5 - d);

function blend(px, i, c, a) {
  if (a <= 0) return;
  px[i] = mix(px[i], c[0], a); px[i + 1] = mix(px[i + 1], c[1], a); px[i + 2] = mix(px[i + 2], c[2], a);
}

// Signed distance to an axis-aligned ellipse (good approximation).
function sdEllipse(x, y, rx, ry) {
  if (rx < 0.5 || ry < 0.5) return 1e9;
  const k0 = Math.hypot(x / rx, y / ry);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry));
  return k0 < 1e-6 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1;
}

// ---------- static background, drawn once ----------
const BG = (() => {
  const px = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    const t = y / (HEIGHT - 1);
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      // calm blue -> teal gradient
      let r = mix(46, 34, t), g = mix(86, 128, t), b = mix(150, 146, t);
      // soft glow behind the face
      const glow = Math.exp(-((x - CX) ** 2 + (y - CY) ** 2) / (2 * 150 ** 2)) * 0.35;
      r = mix(r, 210, glow); g = mix(g, 236, glow); b = mix(b, 245, glow);
      // gentle vignette
      const v = 1 - 0.25 * (((x - CX) / WIDTH) ** 2 + ((y - CY) / HEIGHT) ** 2) * 4;
      px[i] = r * v; px[i + 1] = g * v; px[i + 2] = b * v; px[i + 3] = 255;
    }
  }
  // soft shadow under the face
  for (let y = CY + R - 10; y < CY + R + 40; y++) for (let x = CX - R - 20; x < CX + R + 20; x++) {
    const d = ((x - CX) / (R * 0.85)) ** 2 + ((y - (CY + R + 14)) / 14) ** 2;
    blend(px, (y * WIDTH + x) * 4, [10, 30, 50], clamp01(1 - d) * 0.35);
  }
  // shield-with-check badge (supersampled), centered under the face
  const sx = CX, top = 296, w = 34, h = 40, split = top + h * 0.42;
  const inShield = (x, y) => {
    if (y < top || y > top + h) return false;
    if (y < split) return Math.abs(x - sx) < w / 2 - (y < top + 4 ? (top + 4 - y) * 0.8 : 0);
    const k = (y - split) / (top + h - split);
    return Math.abs(x - sx) < (w / 2) * (1 - k ** 1.6);
  };
  const segDist = (x, y, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay, t = clamp01(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy));
    return Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
  };
  const inCheck = (x, y) => Math.min(segDist(x, y, sx - 9, top + 20, sx - 3, top + 27), segDist(x, y, sx - 3, top + 27, sx + 10, top + 12)) < 2.6;
  for (let y = top - 2; y < top + h + 2; y++) for (let x = sx - w / 2 - 2; x < sx + w / 2 + 2; x++) {
    let s = 0, c = 0;
    for (let sy = 0; sy < 4; sy++) for (let sxx = 0; sxx < 4; sxx++) {
      const X = x + (sxx + 0.5) / 4, Y = y + (sy + 0.5) / 4;
      if (inShield(X, Y)) { s++; if (inCheck(X, Y)) c++; }
    }
    const i = (y * WIDTH + x) * 4;
    blend(px, i, [120, 214, 170], s / 16);
    blend(px, i, WHITE, c / 16);
  }
  return px;
})();

// ---------- per-call animation state (each call runs in its own process) ----------
const state = { open: 0, blinkAt: 2.5, gx: 0, gy: 0, gtx: 0, gty: 0, gazeAt: 3 };

/**
 * Draws one frame. `tick` counts frames; `speaking` is true while the agent talks.
 * Returns WIDTH x HEIGHT RGBA pixels.
 */
export function drawFace(tick, speaking) {
  const t = tick / FPS;
  const px = new Uint8Array(BG); // copy the static background

  // breathing bob, plus a small nod while talking
  const bob = Math.sin(t * 1.7) * 3.5 + (speaking ? Math.sin(t * 6.2) * 1.2 : 0);
  const cy = CY + bob;

  // smooth mouth opening: layered sines give natural, non-repeating speech motion
  const talk = 0.55 + 0.25 * Math.sin(t * 11.3) + 0.15 * Math.sin(t * 17.9 + 1.3) + 0.1 * Math.sin(t * 5.1 + 0.4);
  const target = speaking ? clamp01(talk) : 0;
  state.open += (target - state.open) * 0.35;

  // natural blinks at random intervals
  if (t > state.blinkAt + 0.2) state.blinkAt = t + 2.5 + Math.random() * 3;
  const bp = (t - state.blinkAt) / 0.18;
  const lid = bp >= 0 && bp <= 1 ? 1 - Math.sin(Math.PI * bp) * 0.92 : 1;

  // slow, gentle glances
  if (t > state.gazeAt) { state.gtx = (Math.random() - 0.5) * 8; state.gty = (Math.random() - 0.5) * 4; state.gazeAt = t + 2 + Math.random() * 3; }
  state.gx += (state.gtx - state.gx) * 0.08; state.gy += (state.gty - state.gy) * 0.08;

  const eyeY = cy - 22 + state.gy, eyeDX = 38, eyeRX = 12, eyeRY = 16 * lid;
  const mouthY = cy + 34, open = state.open;

  const x0 = Math.floor(CX - R - 2), x1 = Math.ceil(CX + R + 2);
  const y0 = Math.max(0, Math.floor(cy - R - 2)), y1 = Math.min(HEIGHT, Math.ceil(cy + R + 2));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * WIDTH + x) * 4;
      const dx = x + 0.5 - CX, dy = y + 0.5 - cy;
      const dFace = Math.hypot(dx, dy) - R;
      const aFace = cover(dFace);
      if (aFace <= 0) continue;

      // face with soft top-left light
      const shade = clamp01(0.5 + (dx * 0.35 + dy * 0.65) / (R * 2.2));
      const skin = [mix(SKIN[0], SKIN_SHADE[0], shade), mix(SKIN[1], SKIN_SHADE[1], shade), mix(SKIN[2], SKIN_SHADE[2], shade)];
      blend(px, i, skin, aFace);

      // rosy cheeks (soft edges)
      for (const s of [-1, 1]) {
        const d = Math.hypot(dx - s * 62, dy - 14);
        blend(px, i, CHEEK, clamp01((22 - d) / 12) * 0.32 * aFace);
      }

      // eyes with highlights
      for (const s of [-1, 1]) {
        const ex = x + 0.5 - (CX + s * eyeDX + state.gx), ey = y + 0.5 - eyeY;
        const aEye = cover(sdEllipse(ex, ey, eyeRX, Math.max(1.5, eyeRY)));
        blend(px, i, EYE, aEye);
        if (lid > 0.5) {
          blend(px, i, WHITE, cover(Math.hypot(ex + 4, ey + 6) - 4) * 0.95);
          blend(px, i, WHITE, cover(Math.hypot(ex - 3, ey - 5) - 1.8) * 0.7);
        }
      }

      // mouth: a resting smile that smoothly opens into a "D" shaped talking mouth
      const mx = x + 0.5 - CX, my = y + 0.5 - mouthY;
      // smile arc (stroke)
      const arcR = 34, acy = -26;
      const ad = Math.hypot(mx, my - acy);
      const lower = (my - acy) / (ad + 1e-6);
      const aSmile = lower > 0.62 ? cover(Math.abs(ad - arcR) - 3.2) : 0;
      blend(px, i, MOUTH, aSmile * (1 - clamp01(open * 8)));
      // open mouth
      if (open > 0.02) {
        const ry = 4 + open * 18, rx = 26 + open * 4;
        const dEll = sdEllipse(mx, my - ry * 0.35, rx, ry);
        const dTop = (mouthY - 2) - (y + 0.5); // flat top edge
        const dMouth = Math.max(dEll, dTop);
        const aM = cover(dMouth);
        blend(px, i, MOUTH, aM);
        const dTongue = Math.max(sdEllipse(mx, my - ry * 1.05, rx * 0.6, ry * 0.45), dMouth);
        blend(px, i, TONGUE, cover(dTongue) * 0.9);
      }
    }
  }
  return px;
}
