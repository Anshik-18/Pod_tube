import os from 'os';
import fs from 'fs';
import type { ExportQuality } from '../db/queries/episodes';

/**
 * What the processing worker may use, read from the container's limits (cgroup v2), not the
 * host's: inside a container, FFmpeg otherwise sees every host core, starts a thread per core and
 * each thread buffers 1080p frames — enough to get killed on a 512 MB plan.
 *
 * Overrides: PROCESSING_THREADS, PROCESSING_MAX_QUALITY (low | medium | high).
 */
export interface ProcessingResources {
  /** Threads for each FFmpeg decoder, filter graph and encoder. */
  threads: number;
  /** Highest export quality this machine can render (720p on small instances). */
  maxQuality: ExportQuality;
  cpus: number;
  memoryBytes: number | null;
}

const QUALITY_ORDER: ExportQuality[] = ['low', 'medium', 'high'];
/** Below this, 1080p rendering (≈400 MB for FFmpeg alone) doesn't fit next to the app. */
const MIN_MEMORY_FOR_1080P = 1024 * 1024 * 1024;

function readCgroup(file: string): string | null {
  try {
    return fs.readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim();
  } catch {
    return null;
  }
}

export function detectResources(env: NodeJS.ProcessEnv = process.env): ProcessingResources {
  const hostCpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  let cpus = hostCpus;
  const cpuMax = readCgroup('cpu.max'); // "<quota> <period>" or "max <period>"
  if (cpuMax && !cpuMax.startsWith('max')) {
    const [quota, period] = cpuMax.split(/\s+/).map(Number);
    if (quota > 0 && period > 0) cpus = Math.max(1, Math.min(hostCpus, Math.round(quota / period)));
  }

  const memMax = readCgroup('memory.max');
  const memoryBytes = memMax && memMax !== 'max' && Number.isFinite(Number(memMax)) ? Number(memMax) : null;

  const threadsOverride = Number(env.PROCESSING_THREADS);
  const threads = Number.isInteger(threadsOverride) && threadsOverride > 0 ? threadsOverride : Math.max(1, Math.min(cpus, 8));

  const qualityOverride = env.PROCESSING_MAX_QUALITY as ExportQuality | undefined;
  const maxQuality: ExportQuality = QUALITY_ORDER.includes(qualityOverride as ExportQuality)
    ? (qualityOverride as ExportQuality)
    : memoryBytes !== null && memoryBytes < MIN_MEMORY_FOR_1080P
      ? 'low'
      : 'high';

  return { threads, maxQuality, cpus, memoryBytes };
}

/** The requested quality, lowered to what this machine can render. */
export function clampQuality(requested: ExportQuality | undefined, max: ExportQuality): ExportQuality {
  const want = requested ?? 'medium';
  return QUALITY_ORDER.indexOf(want) > QUALITY_ORDER.indexOf(max) ? max : want;
}

let cached: ProcessingResources | null = null;
export function getProcessingResources(): ProcessingResources {
  if (!cached) cached = detectResources();
  return cached;
}
