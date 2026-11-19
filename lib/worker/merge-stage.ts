import fs from 'fs/promises';
import path from 'path';
import { ConcatStageResult } from './concat-chunks';
import { SessionTimeline } from './timeline';
import { runFFmpeg, probeMedia, getVideoEncoder } from './ffmpeg';
import { buildRenderPlan, SceneInput } from './scenes';
import type { TrimSettings } from '../db/queries/episodes';
import { baseParticipant, isScreenTrack } from '../participants';

export { gridLayout, screenLayout, QUALITY_PRESETS, planScenes, buildRenderPlan } from './scenes';
export type { SceneInput as MergeInput, Rect, Scene } from './scenes';

export interface MergeStageResult {
  outputFile: string;
  durationMs: number;
  /** Length of the full synchronized timeline before trimming. */
  sourceDurationMs: number;
  width: number;
  height: number;
  fileSizeBytes: number;
  /** How many layout scenes the episode was rendered in. */
  sceneCount: number;
}

/**
 * Place every track on the shared timeline, ordered host first and then by when each person
 * started recording (that's their tile order).
 */
export function timelineInputs(concatResult: ConcatStageResult, timeline: SessionTimeline): SceneInput[] {
  const inputs: SceneInput[] = [];
  for (const [participantType, track] of Object.entries(concatResult.participants)) {
    const t = timeline.participants[participantType];
    inputs.push({
      participantType,
      file: track.outputFile,
      offsetSec: (t?.offsetMs ?? 0) / 1000,
      durationSec: track.media.durationSec ?? (t ? t.durationMs / 1000 : 0),
      hasVideo: track.media.hasVideo,
      hasAudio: track.media.hasAudio,
      isScreen: isScreenTrack(participantType),
      group: baseParticipant(participantType),
    });
  }

  const firstSeen = new Map<string, number>();
  for (const i of inputs) firstSeen.set(i.group!, Math.min(firstSeen.get(i.group!) ?? Infinity, i.offsetSec));
  const rank = (i: SceneInput) => (i.group === 'host' ? -1 : firstSeen.get(i.group!)!);
  inputs.sort((a, b) => rank(a) - rank(b) || (a.group! < b.group! ? -1 : a.group! > b.group! ? 1 : a.offsetSec - b.offsetSec));

  // Offsets are relative to the earliest track; re-base on the tracks we actually have.
  const minOffset = Math.min(...inputs.map((i) => i.offsetSec));
  inputs.forEach((i) => (i.offsetSec -= minOffset));
  return inputs;
}

/**
 * mergeStage
 *
 * Renders episode.mp4: one video pass per layout scene, one audio mix, then a stream-copy
 * concat + mux. Memory stays flat regardless of length or how often people come and go.
 */
export async function mergeStage(
  concatResult: ConcatStageResult,
  timeline: SessionTimeline,
  trim: TrimSettings | null,
  onProgress?: (fraction: number) => void
): Promise<MergeStageResult> {
  const { workingDirectory, jobId } = concatResult;
  const workDir = path.join(workingDirectory, 'render');
  await fs.mkdir(workDir, { recursive: true });
  const outputFile = path.join(workingDirectory, 'episode.mp4');

  const inputs = timelineInputs(concatResult, timeline);
  const firstCamera = inputs.find((i) => !i.isScreen);
  const sourceHeight = firstCamera ? concatResult.participants[firstCamera.participantType]?.media.height ?? null : null;
  const plan = buildRenderPlan(inputs, { workDir, outputFile, trim, sourceHeight, videoEncoder: await getVideoEncoder() });

  console.log(
    `[MergeStage] Job ${jobId}: ${plan.width}x${plan.height}, ${plan.outputDurationSec.toFixed(1)}s in ${plan.scenes.length} scene(s): ` +
      plan.scenes.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s [${s.slots.join(', ')}${s.screen ? ' + screen' : ''}]`).join('; ')
  );

  // Progress: video passes ~85%, audio ~10%, mux ~5%.
  const videoTotal = plan.scenes.reduce((n, s) => n + s.pass.durationSec, 0) || 1;
  let videoDone = 0;
  for (const scene of plan.scenes) {
    const base = videoDone;
    await runFFmpeg(scene.pass.args, {
      durationSec: scene.pass.durationSec,
      label: `scene ${scene.start.toFixed(1)}s`,
      onProgress: (f) => onProgress?.(0.85 * ((base + f * scene.pass.durationSec) / videoTotal)),
    });
    videoDone += scene.pass.durationSec;
  }
  await runFFmpeg(plan.audio.args, {
    durationSec: plan.audio.durationSec,
    label: 'audio mix',
    onProgress: (f) => onProgress?.(0.85 + 0.1 * f),
  });
  await fs.writeFile(path.join(workDir, 'scenes.txt'), plan.concatList);
  await runFFmpeg(plan.mux.args, { durationSec: plan.mux.durationSec, label: 'mux', onProgress: (f) => onProgress?.(0.95 + 0.05 * f) });
  await fs.rm(workDir, { recursive: true, force: true });

  const stat = await fs.stat(outputFile);
  const probed = await probeMedia(outputFile).catch(() => null);

  return {
    outputFile,
    durationMs: Math.round((probed?.durationSec ?? plan.outputDurationSec) * 1000),
    sourceDurationMs: Math.round(plan.timelineDurationSec * 1000),
    width: probed?.width ?? plan.width,
    height: probed?.height ?? plan.height,
    fileSizeBytes: stat.size,
    sceneCount: plan.scenes.length,
  };
}
