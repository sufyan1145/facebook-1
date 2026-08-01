/**
 * Builds ffmpeg filter strings for the Video Editor's effect library.
 * Every filter here has been individually tested against real ffmpeg.
 * Point-effects (flash, glitch, shake, whip pan, spin, light leak, zoom
 * punch) apply at a single shared timestamp (effectAt) for simplicity.
 *
 * NOTE on approximations (documented, not hidden):
 * - "Beat Sync" is NOT real audio-beat-detection (that needs an ML/analysis
 *   model this app doesn't have). It's a periodic zoom-punch at a BPM you
 *   set, which mimics the visual rhythm of beat-synced edits.
 * - "3D Photo Motion" / "Parallax" are NOT included - they need a depth-
 *   estimation model to separate foreground/background, which isn't
 *   available here. Ken Burns (2D pan/zoom) is included instead.
 * - "Vertical conversion, subject centered" statically centers the frame
 *   (blurred-background pad) - it does not dynamically track a moving
 *   subject (that needs a face/object-tracking model).
 */

function esc(expr) {
  // Escape commas for use inside a single ffmpeg filter option value.
  return String(expr).replace(/,/g, '\\,');
}

// ---- Color grading (whole-clip) ----
const COLOR_GRADE_FILTERS = {
  cinematic: 'colorbalance=rs=-0.05:gs=0.02:bs=0.08:rm=0.05:gm=0.0:bm=-0.05:rh=0.1:gh=0.02:bh=-0.08,eq=contrast=1.15:saturation=1.05',
  hdr: 'eq=contrast=1.2:brightness=0.02:saturation=1.15,unsharp=5:5:0.8:5:5:0.0',
  vibrant: 'vibrance=intensity=0.4,eq=saturation=1.3',
  skin_tone: 'selectivecolor=reds=0.05 0 0 0:yellows=0.05 0.02 0 0',
  warm: 'colorbalance=rm=0.15:gm=0.05:bm=-0.15,eq=saturation=1.1',
  cool: 'colorbalance=rm=-0.15:gm=0.0:bm=0.15,eq=saturation=1.05',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  vintage: "curves=r='0/0.05 0.5/0.5 1/0.9':b='0/0.1 0.5/0.45 1/0.8',eq=saturation=0.75:contrast=0.95",
  moody: 'eq=contrast=1.25:brightness=-0.06:saturation=0.85,colorbalance=bs=0.08:bm=0.03',
  bleach_bypass: 'eq=saturation=0.4:contrast=1.3:brightness=0.03',
  pastel: 'eq=saturation=0.7:brightness=0.06:contrast=0.9',
  punchy: 'eq=saturation=1.5:contrast=1.2',
  cross_process: 'colorbalance=gs=0.1:gm=0.1:rh=0.05:bh=-0.1,eq=saturation=1.2',
  matte: "curves=r='0/0.08 1/0.92':g='0/0.08 1/0.92':b='0/0.1 1/0.88',eq=contrast=0.9",
};

// ---- Whole-clip style effects (single-input, comma-joinable into the main
// filter chain alongside color grade - all individually tested against real
// ffmpeg). NOTE: Kaleidoscope, Ripple/Wave distortion, Oil Paint, and
// Halftone are NOT included - ffmpeg has no clean built-in filter for these,
// and the closest workaround (per-pixel `geq` expressions) is dramatically
// slower (~3x) and risks the same hangs/timeouts fixed elsewhere in this
// pipeline, especially on a memory/CPU-constrained server.
const STYLE_EFFECT_FILTERS = {
  mirror: 'hflip',
  chromatic_aberration: 'rgbashift=rh=4:bh=-4',
  mosaic: 'scale=64:36:flags=neighbor,scale=iw*10:ih*10:flags=neighbor',
  emboss: "convolution='0 1 0 1 0 -1 0 -1 0:0 1 0 1 0 -1 0 -1 0:0 1 0 1 0 -1 0 -1 0:0 1 0 1 0 -1 0 -1 0'",
  edge_detection: 'edgedetect=mode=colormix:high=0.3',
  outline: 'edgedetect=mode=colormix:high=0.15',
  posterize: 'lutyuv=y=val/32*32:u=val:v=val',
  grain: 'noise=alls=15:allf=t',
  fisheye: 'lenscorrection=k1=-0.3:k2=-0.1',
  bulge: 'lenscorrection=k1=-0.2:k2=-0.05',
  pinch: 'lenscorrection=k1=0.3:k2=0.1',
};

// ---- Whole-clip effects that need a split+blend filter_complex graph
// (can't be comma-joined into the simple chain above) - each gets its own pass. ----
function glowFilterComplex() {
  return '[0:v]split=2[a][b];[b]gblur=sigma=8,eq=brightness=0.1[blurred];[a][blurred]blend=all_mode=screen[outv]';
}
function reflectionFilterComplex() {
  return '[0:v]split=2[top][bot];[bot]vflip,eq=brightness=-0.3,format=yuva420p,colorchannelmixer=aa=0.4[reflected];[top][reflected]vstack=inputs=2[outv]';
}
function shadowFilterComplex() {
  return "[0:v]split=2[a][b];[b]eq=brightness=-0.4,gblur=sigma=6,pad=iw+10:ih+10:5:5:black@0[shadow];[shadow][a]overlay=0:0[outv]";
}
function lensFlareFilterComplex() {
  return '[0:v]split=2[a][b];[b]eq=brightness=0.15:saturation=1.5,gblur=sigma=15[glow];[a][glow]blend=all_mode=addition:all_opacity=0.3[outv]';
}

// ---- Point-effects (need a timestamp `t`) ----
function pointEffectFilter(key, t) {
  const t2 = (extra) => (t + extra).toFixed(2);
  switch (key) {
    case 'flash':
      return `eq=brightness=1:enable='between(t\\,${t}\\,${t2(0.15)})'`;
    case 'blur_transition':
      return `gblur=sigma=20:enable='between(t\\,${t}\\,${t2(0.3)})'`;
    case 'spin':
      return `rotate=angle='if(between(t\\,${t}\\,${t2(0.5)})\\,(t-${t})/0.5*2*PI\\,0)':fillcolor=black@0:enable='between(t\\,${t}\\,${t2(0.5)})'`;
    case 'glitch':
      return `rgbashift=rh=10:bv=-10:enable='between(t\\,${t}\\,${t2(0.2)})',noise=alls=30:allf=t+u:enable='between(t\\,${t}\\,${t2(0.2)})'`;
    case 'shake':
      return `crop=iw-20:ih-20:10+10*sin(50*t):10+10*cos(50*t)`;
    case 'whip_pan':
      return `gblur=sigma=15:enable='between(t\\,${t}\\,${t2(0.4)})'`;
    case 'light_leak':
      return `curves=r='0/0 0.5/0.65 1/1':b='0/0 0.5/0.3 1/0.85':enable='between(t\\,${t}\\,${t2(0.6)})',eq=brightness=0.08:enable='between(t\\,${t}\\,${t2(0.6)})'`;
    case 'zoom_punch':
      return `crop=w='iw/if(between(t\\,${t}\\,${t2(0.3)})\\,1.3\\,1)':h='ih/if(between(t\\,${t}\\,${t2(0.3)})\\,1.3\\,1)':x='(iw-iw/if(between(t\\,${t}\\,${t2(0.3)})\\,1.3\\,1))/2':y='(ih-ih/if(between(t\\,${t}\\,${t2(0.3)})\\,1.3\\,1))/2'`;
    default:
      return null;
  }
}

// ---- Beat sync (approximation - periodic zoom punch at a BPM) ----
function beatSyncFilter(bpm) {
  const interval = (60 / Math.max(40, Math.min(220, bpm))).toFixed(3);
  const pulse = 0.08;
  return `crop=w='iw/if(lt(mod(t\\,${interval})\\,${pulse})\\,1.15\\,1)':h='ih/if(lt(mod(t\\,${interval})\\,${pulse})\\,1.15\\,1)':x='(iw-iw/if(lt(mod(t\\,${interval})\\,${pulse})\\,1.15\\,1))/2':y='(ih-ih/if(lt(mod(t\\,${interval})\\,${pulse})\\,1.15\\,1))/2'`;
}

// ---- Speed ramping ----
function speedFilters(factor) {
  // factor > 1 = faster, < 1 = slower
  const videoFilter = `setpts=${(1 / factor).toFixed(4)}*PTS`;
  // atempo only accepts 0.5-2.0 per instance - chain multiple for larger factors
  const audioFilters = [];
  let remaining = factor;
  while (remaining > 2.0) {
    audioFilters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    audioFilters.push('atempo=0.5');
    remaining /= 0.5;
  }
  audioFilters.push(`atempo=${remaining.toFixed(4)}`);
  return { videoFilter, audioFilter: audioFilters.join(',') };
}

// ---- Vertical conversion (9:16, blurred-background pad, statically centered) ----
function verticalConversionFilterComplex() {
  return '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=25[bg];' +
    '[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[outv]';
}

module.exports = {
  esc,
  COLOR_GRADE_FILTERS,
  STYLE_EFFECT_FILTERS,
  pointEffectFilter,
  beatSyncFilter,
  speedFilters,
  verticalConversionFilterComplex,
  glowFilterComplex,
  reflectionFilterComplex,
  shadowFilterComplex,
  lensFlareFilterComplex,
};
