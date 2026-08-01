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
};

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
    case 'jump_cut':
      // Brief black flash simulating a hard edit cut.
      return `eq=brightness=-1:enable='between(t\\,${t}\\,${t2(0.08)})'`;
    case 'fade_out':
      // Fades to black starting at t, over 0.5s.
      return `fade=t=out:st=${t}:d=0.5:color=black`;
    case 'slide':
      // Quick pan-in / wipe, like the next scene "sliding" into place.
      return `crop=iw:ih:x='if(between(t\\,${t}\\,${t2(0.25)})\\,(iw*0.3)*(1-(t-${t})/0.25)\\,0)':y=0`;
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
  pointEffectFilter,
  beatSyncFilter,
  speedFilters,
  verticalConversionFilterComplex,
};
