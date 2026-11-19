/**
 * Scene-based episode rendering.
 *
 * People join late, drop out and come back, and share screens. Instead of giving everyone a fixed
 * tile for the whole episode (leaving empty slots), the timeline is cut into scenes; each scene
 * shows the people present at that time in a layout sized for them:
 *
 *   - a late joiner enters the layout when they join;
 *   - someone absent for longer than ABSENCE_GRACE_SEC leaves the layout (the rest reflow) and
 *     returns when they rejoin — their segments (`.partN`) play in their slot;
 *   - a shorter absence keeps their slot (a placeholder card), so a blip doesn't reshuffle everyone;
 *   - while a screen is shared, the scene is the screen with the cameras in a sidebar.
 *
 * Each scene is encoded on its own (video only) and the scenes are concatenated without
 * re-encoding; the audio is mixed once for the whole episode. Every input is decoded only for the
 * scenes it appears in.
 */
import type { TrimSettings, ExportQuality } from '../db/queries/episodes';
import type { VideoEncoder } from './ffmpeg';

export interface SceneInput {
  participantType: string;
  file: string;
  /** Where this track starts on the episode timeline (seconds). */
  offsetSec: number;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  isScreen?: boolean;
  /** Camera tracks with the same group are one person (rejoin segments). Defaults to participantType. */
  group?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Scene {
  /** Episode-timeline seconds (before trimming). */
  start: number;
  end: number;
  /** People shown, in tile order. */
  slots: string[];
  /** Screen share shown in this scene. */
  screen: SceneInput | null;
}

export interface RenderPass {
  args: string[];
  /** Seconds of media this pass produces (for progress). */
  durationSec: number;
}

export interface RenderPlan {
  scenes: Array<Scene & { file: string; frames: number; pass: RenderPass }>;
  audio: RenderPass & { file: string };
  /** concat-demuxer list contents and the final mux pass. */
  concatList: string;
  mux: RenderPass;
  timelineDurationSec: number;
  outputDurationSec: number;
  width: number;
  height: number;
}

export const FPS = 30;
/** Absences up to this long keep the person's slot; longer ones reflow the layout. */
export const ABSENCE_GRACE_SEC = 20;
/** Scenes shorter than this are folded into a neighbour (no flicker between layouts). */
export const MIN_SCENE_SEC = 1.5;
const MAX_CAMERAS = 8;

/** Studio background behind the tiles, and the card shown in an empty slot. */
const BACKGROUND = '0x0e0e11';
const PLACEHOLDER = '0x1c1c22';

export const QUALITY_PRESETS: Record<
  ExportQuality,
  { width: number; height: number; crf: number; preset: string; audioBitrate: string; videoBitrate: string }
> = {
  low: { width: 1280, height: 720, crf: 28, preset: 'veryfast', audioBitrate: '128k', videoBitrate: '2500k' },
  medium: { width: 1920, height: 1080, crf: 23, preset: 'veryfast', audioBitrate: '192k', videoBitrate: '6000k' },
  high: { width: 1920, height: 1080, crf: 18, preset: 'medium', audioBitrate: '256k', videoBitrate: '10000k' },
};

const fmt = (n: number) => n.toFixed(3);
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const snap = (t: number) => Math.round(t * FPS) / FPS;
const EPS = 1e-6;

// ── Layouts ─────────────────────────────────────────────────────────

/**
 * Tile positions for `count` cameras on a width x height canvas: a near-square grid
 * (1, 2 side by side, 2x2, 3x2, 3x3) with the last, partly filled row centered.
 */
export function gridLayout(count: number, width: number, height: number, gap: number): Rect[] {
  if (count <= 0) return [];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = even((width - gap * (cols + 1)) / cols);
  const cellH = even((height - gap * (rows + 1)) / rows);
  const usedH = rows * cellH + (rows - 1) * gap;
  const top = Math.round((height - usedH) / 2);

  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const col = i - row * cols;
    const rowW = inRow * cellW + (inRow - 1) * gap;
    const left = Math.round((width - rowW) / 2);
    rects.push({ x: left + col * (cellW + gap), y: top + row * (cellH + gap), w: cellW, h: cellH });
  }
  return rects;
}

/** Screen-share layout: the screen in a large main area, cameras stacked in a right-hand sidebar. */
export function screenLayout(count: number, width: number, height: number, gap: number): { main: Rect; tiles: Rect[] } {
  if (count === 0) return { main: { x: 0, y: 0, w: width, h: height }, tiles: [] };
  const sidebarW = even(width * (count > 4 ? 0.3 : 0.22));
  const main: Rect = { x: gap, y: gap, w: even(width - sidebarW - gap * 3), h: even(height - gap * 2) };
  const cols = count > 4 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(count / cols));
  const tileW = even((sidebarW - gap * (cols - 1)) / cols);
  const tileH = even(Math.min((tileW * 9) / 16, (height - gap * 2 - gap * (rows - 1)) / rows));
  const usedH = rows * tileH + (rows - 1) * gap;
  const top = Math.round((height - usedH) / 2);
  const left = main.x + main.w + gap;

  const tiles: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    tiles.push({ x: left + col * (tileW + gap), y: top + row * (tileH + gap), w: tileW, h: tileH });
  }
  return { main, tiles };
}

// ── Timeline ────────────────────────────────────────────────────────

type Interval = [number, number];

function mergeIntervals(intervals: Interval[], bridgeGapsUpTo = 0): Interval[] {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= bridgeGapsUpTo + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const groupOf = (i: SceneInput) => i.group ?? i.participantType;
const covers = (intervals: Interval[], a: number, b: number) => intervals.some(([s, e]) => s <= a + EPS && e >= b - EPS);

/**
 * Cut [from, to] into scenes. `inputs` order decides tile order (host first, then by join time).
 */
export function planScenes(inputs: SceneInput[], from: number, to: number): Scene[] {
  const cameras = inputs.filter((i) => !i.isScreen);
  const screens = inputs.filter((i) => i.isScreen && i.hasVideo);
  const groups: string[] = [];
  for (const cam of cameras) if (!groups.includes(groupOf(cam))) groups.push(groupOf(cam));

  // When each person is on screen: their segments, with short absences bridged.
  const visible = new Map<string, Interval[]>();
  for (const g of groups) {
    const segs = cameras.filter((c) => groupOf(c) === g).map((c): Interval => [c.offsetSec, c.offsetSec + c.durationSec]);
    visible.set(g, mergeIntervals(segs, ABSENCE_GRACE_SEC));
  }
  const screenSpans = screens.map((s) => ({ input: s, span: [s.offsetSec, s.offsetSec + s.durationSec] as Interval }));

  const cuts = new Set<number>([from, to]);
  for (const intervals of visible.values()) for (const [a, b] of intervals) [a, b].forEach((t) => t > from && t < to && cuts.add(t));
  for (const { span } of screenSpans) span.forEach((t) => t > from && t < to && cuts.add(t));
  const points = Array.from(cuts).sort((a, b) => a - b);

  let scenes: Scene[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (b - a < EPS) continue;
    const slots = groups.filter((g) => covers(visible.get(g)!, a, b));
    const active = screenSpans.filter(({ span }) => span[0] <= a + EPS && span[1] >= b - EPS);
    const screen = active.length ? active.reduce((x, y) => (y.span[0] > x.span[0] ? y : x)).input : null;
    scenes.push({ start: a, end: b, slots, screen });
  }

  const same = (x: Scene, y: Scene) => x.screen === y.screen && x.slots.join('|') === y.slots.join('|');
  const merge = (list: Scene[]) =>
    list.reduce<Scene[]>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && same(last, s)) last.end = s.end;
      else acc.push({ ...s });
      return acc;
    }, []);

  // Fold scenes too short to read into a neighbour, then re-merge.
  scenes = merge(scenes);
  for (let guard = 0; guard < 1000 && scenes.length > 1; guard++) {
    const idx = scenes.findIndex((s) => s.end - s.start < MIN_SCENE_SEC);
    if (idx === -1) break;
    const target = idx > 0 ? idx - 1 : 1;
    const [lo, hi] = idx < target ? [idx, target] : [target, idx];
    scenes.splice(lo, 2, { ...scenes[target], start: scenes[lo].start, end: scenes[hi].end });
    scenes = merge(scenes);
  }

  // Frame-accurate boundaries, so concatenated scenes don't drift.
  return scenes
    .map((s) => ({ ...s, start: snap(s.start), end: snap(s.end) }))
    .filter((s) => s.end - s.start > EPS);
}

// ── Render plan ─────────────────────────────────────────────────────

export function buildRenderPlan(
  inputs: SceneInput[],
  options: { workDir: string; outputFile: string; trim?: TrimSettings | null; sourceHeight?: number | null; videoEncoder?: VideoEncoder }
): RenderPlan {
  const cameras = inputs.filter((i) => !i.isScreen);
  if (cameras.length === 0) throw new Error('Expected at least one participant camera track, got none');
  const groups = new Set(cameras.map(groupOf));
  if (groups.size > MAX_CAMERAS) throw new Error(`Expected at most ${MAX_CAMERAS} participants, got ${groups.size}`);

  const quality = QUALITY_PRESETS[options.trim?.quality ?? 'medium'] ?? QUALITY_PRESETS.medium;
  let { width, height } = quality;
  const screens = inputs.filter((i) => i.isScreen && i.hasVideo);
  // A single 720p webcam gains nothing from a 1080p canvas.
  if (groups.size === 1 && screens.length === 0 && options.sourceHeight && options.sourceHeight <= 720) {
    width = 1280;
    height = 720;
  }

  const timelineDurationSec = Math.max(...inputs.map((i) => i.offsetSec + i.durationSec));
  if (!Number.isFinite(timelineDurationSec) || timelineDurationSec <= 0) throw new Error('Could not determine the recording duration');
  const trimStart = Math.min(Math.max(options.trim?.trimStart ?? 0, 0), timelineDurationSec);
  const requestedEnd = options.trim?.trimEnd ?? 0;
  const trimEnd = requestedEnd > trimStart ? Math.min(requestedEnd, timelineDurationSec) : timelineDurationSec;
  if (trimEnd - trimStart < 0.5) throw new Error('The selected trim range is too short to export');

  const encoder =
    options.videoEncoder === 'libopenh264'
      ? ['-c:v', 'libopenh264', '-b:v', quality.videoBitrate, '-maxrate', quality.videoBitrate, '-g', String(FPS * 2)]
      : ['-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf), '-g', String(FPS * 2)];
  const gap = Math.round(width / 80);

  const scenes = planScenes(inputs, trimStart, trimEnd).map((scene, n) => {
    const frames = Math.max(1, Math.round((scene.end - scene.start) * FPS));
    const file = `${options.workDir}/scene_${String(n).padStart(4, '0')}.ts`;
    return { ...scene, file, frames, pass: buildScenePass(scene, inputs, { width, height, gap, frames, file, encoder }) };
  });
  const outputDurationSec = scenes.reduce((n, s) => n + s.frames / FPS, 0);

  const audioFile = `${options.workDir}/audio.m4a`;
  const audio = { file: audioFile, ...buildAudioPass(inputs, { trimStart, trimEnd, timelineDurationSec, bitrate: quality.audioBitrate, file: audioFile }) };

  const concatList = scenes.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'\nduration ${fmt(s.frames / FPS)}`).join('\n') + '\n';
  const mux: RenderPass = {
    durationSec: outputDurationSec,
    args: [
      '-f', 'concat', '-safe', '0', '-i', `${options.workDir}/scenes.txt`,
      '-i', audioFile,
      '-map', '0:v', '-map', '1:a',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-t', fmt(outputDurationSec),
      options.outputFile,
    ],
  };

  return { scenes, audio, concatList, mux, timelineDurationSec, outputDurationSec, width, height };
}

function buildScenePass(
  scene: Scene,
  inputs: SceneInput[],
  o: { width: number; height: number; gap: number; frames: number; file: string; encoder: string[] }
): RenderPass {
  const dur = o.frames / FPS;
  const { width, height, gap } = o;
  const args: string[] = [];
  const filters: string[] = [];
  let next = 0;

  /** Add an input clipped to this scene; returns its index and how late it starts within the scene. */
  const addInput = (input: SceneInput) => {
    const seek = Math.max(0, scene.start - input.offsetSec);
    const lateBy = Math.max(0, input.offsetSec - scene.start);
    if (seek > 0) args.push('-ss', fmt(seek));
    args.push('-t', fmt(dur - lateBy + 0.5), '-i', input.file);
    return { idx: next++, lateBy };
  };
  const shift = (s: number) => (s > 0 ? `,setpts=PTS+${fmt(s)}/TB` : '');
  const fill = (r: Rect) => `scale=${r.w}:${r.h}:force_original_aspect_ratio=increase,crop=${r.w}:${r.h},setsar=1`;
  const fit = (r: Rect) =>
    `scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2:color=${BACKGROUND},setsar=1`;

  const solo = !scene.screen && scene.slots.length === 1;
  const layout = scene.screen ? screenLayout(scene.slots.length, width, height, gap) : null;
  const rects = layout ? layout.tiles : solo ? [{ x: 0, y: 0, w: width, h: height }] : gridLayout(scene.slots.length, width, height, gap);

  // Canvas with a placeholder card in every slot: visible only while that person has no picture
  // (a short absence, or an audio-only participant).
  const cards = rects.map((r) => `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=${PLACEHOLDER}:t=fill`);
  filters.push(`color=c=${BACKGROUND}:s=${width}x${height}:r=${FPS}:d=${fmt(dur)}${solo ? '' : cards.map((c) => `,${c}`).join('')}[base]`);

  const layers: Array<{ label: string; rect: Rect }> = [];
  if (scene.screen && layout) {
    const { idx, lateBy } = addInput(scene.screen);
    filters.push(`[${idx}:v]${fit(layout.main)}${shift(lateBy)}[scr]`);
    layers.push({ label: 'scr', rect: layout.main });
  }
  scene.slots.forEach((group, slot) => {
    const rect = rects[slot];
    const segments = inputs.filter(
      (i) => !i.isScreen && i.hasVideo && groupOf(i) === group && i.offsetSec < scene.end - EPS && i.offsetSec + i.durationSec > scene.start + EPS
    );
    segments.forEach((seg, k) => {
      const { idx, lateBy } = addInput(seg);
      const label = `p${slot}_${k}`;
      filters.push(`[${idx}:v]${solo ? fit(rect) : fill(rect)}${shift(lateBy)}[${label}]`);
      layers.push({ label, rect });
    });
  });

  let current = 'base';
  layers.forEach((layer, i) => {
    const out = i === layers.length - 1 ? 'vout' : `v${i}`;
    filters.push(`[${current}][${layer.label}]overlay=x=${layer.rect.x}:y=${layer.rect.y}:eof_action=pass[${out}]`);
    current = out;
  });
  if (layers.length === 0) filters.push('[base]null[vout]');

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    ...o.encoder,
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-frames:v', String(o.frames),
    '-f', 'mpegts', o.file
  );
  return { args, durationSec: dur };
}

function buildAudioPass(
  inputs: SceneInput[],
  o: { trimStart: number; trimEnd: number; timelineDurationSec: number; bitrate: string; file: string }
): RenderPass {
  const sources = inputs.filter((i) => i.hasAudio && i.offsetSec < o.trimEnd && i.offsetSec + i.durationSec > o.trimStart);
  const args: string[] = [];
  const filters: string[] = [];
  const dur = o.trimEnd - o.trimStart;

  if (sources.length === 0) {
    args.push('-f', 'lavfi', '-t', fmt(dur), '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push('[0:a]anull[aout]');
  } else {
    sources.forEach((src, i) => {
      args.push('-i', src.file);
      const delayMs = Math.round(src.offsetSec * 1000);
      filters.push(
        `[${i}:a]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo` +
          (delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : '') +
          `[a${i}]`
      );
    });
    filters.push(
      sources.length === 1
        ? '[a0]anull[mix]'
        : `${sources.map((_, i) => `[a${i}]`).join('')}amix=inputs=${sources.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mix]`
    );
    // Pad to the full timeline (silence where nobody spoke at the end), then cut the trim range.
    filters.push(`[mix]apad=whole_dur=${fmt(o.timelineDurationSec)},atrim=start=${fmt(o.trimStart)}:end=${fmt(o.trimEnd)},asetpts=PTS-STARTPTS[aout]`);
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-vn', '-c:a', 'aac', '-b:a', o.bitrate, '-ar', '48000', '-t', fmt(dur), o.file);
  return { args, durationSec: dur };
}
