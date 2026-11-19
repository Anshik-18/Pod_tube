import { spawn } from 'child_process';

export function getFFmpegBin(): string {
  return process.env.FFMPEG_PATH || process.env.FFMPEG_BIN_PATH || 'ffmpeg';
}

export function getFFprobeBin(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const ffmpeg = getFFmpegBin();
  if (ffmpeg !== 'ffmpeg') return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext ?? ''}`);
  return 'ffprobe';
}

const STDERR_TAIL_BYTES = 4000;

export interface RunFFmpegOptions {
  /** Expected output duration, used to turn FFmpeg's out_time into a 0..1 fraction. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
  label?: string;
}

/**
 * Run FFmpeg with an argument array (no shell, so paths with spaces/quotes are safe on every OS).
 * Rejects with the tail of stderr on a non-zero exit.
 */
export function runFFmpeg(args: string[], options: RunFFmpegOptions = {}): Promise<void> {
  const { durationSec, onProgress, label = 'ffmpeg' } = options;
  const fullArgs = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(getFFmpegBin(), fullArgs, { windowsHide: true });
    let stderrTail = '';
    let stdoutBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (!onProgress || !durationSec) return;
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        // out_time_us is microseconds (older builds mislabel it out_time_ms, also microseconds)
        const match = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (match) {
          const seconds = Number(match[1]) / 1_000_000;
          onProgress(Math.max(0, Math.min(1, seconds / durationSec)));
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (err) => reject(new Error(`${label}: failed to start FFmpeg (${err.message})`)));
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(1);
        resolve();
      } else {
        const lastLines = stderrTail.trim().split('\n').slice(-6).join('\n');
        reject(new Error(`${label}: FFmpeg exited with code ${code}\n${lastLines}`));
      }
    });
  });
}

export interface MediaInfo {
  durationSec: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
}

export function probeMedia(filePath: string): Promise<MediaInfo> {
  const args = ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', filePath];

  return new Promise((resolve, reject) => {
    const child = spawn(getFFprobeBin(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => reject(new Error(`ffprobe failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim().slice(-500)}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const streams: Array<{ codec_type: string; width?: number; height?: number; duration?: string }> = info.streams || [];
        const video = streams.find((s) => s.codec_type === 'video');
        const candidates = [info.format?.duration, video?.duration, ...streams.map((s) => s.duration)]
          .map((d) => parseFloat(d))
          .filter((d) => Number.isFinite(d) && d > 0);
        resolve({
          durationSec: candidates.length ? Math.max(...candidates) : null,
          hasVideo: !!video,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          width: video?.width ?? null,
          height: video?.height ?? null,
        });
      } catch (err) {
        reject(new Error(`ffprobe returned unparseable output: ${(err as Error).message}`));
      }
    });
  });
}

export type VideoEncoder = 'libx264' | 'libopenh264';

let encoderPromise: Promise<VideoEncoder> | null = null;

/**
 * The H.264 encoder this FFmpeg build provides. Patent-free distro builds (e.g. Fedora's
 * ffmpeg-free) ship OpenH264 instead of x264, so detect rather than assume.
 */
export function getVideoEncoder(): Promise<VideoEncoder> {
  if (!encoderPromise) {
    encoderPromise = new Promise<VideoEncoder>((resolve) => {
      const child = spawn(getFFmpegBin(), ['-hide_banner', '-encoders'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', () => resolve('libx264'));
      child.on('close', () => {
        if (/\blibx264\b/.test(out)) resolve('libx264');
        else if (/\blibopenh264\b/.test(out)) resolve('libopenh264');
        else resolve('libx264');
      });
    });
  }
  return encoderPromise;
}

export interface VideoPacket {
  pts: number;
  key: boolean;
}

/**
 * Timestamps and keyframe flags of every video packet, read as a stream (a 1-hour track has
 * ~100k packets). Returns [] when the file has no video stream.
 */
export function probeVideoPackets(filePath: string): Promise<VideoPacket[]> {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', filePath];
  return new Promise((resolve, reject) => {
    const child = spawn(getFFprobeBin(), args, { windowsHide: true });
    const packets: VideoPacket[] = [];
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      buffer += c.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const [pts, flags] = line.split(',');
        const value = parseFloat(pts);
        if (Number.isFinite(value)) packets.push({ pts: value, key: (flags ?? '').includes('K') });
      }
    });
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
    child.on('error', (err) => reject(new Error(`ffprobe failed to start: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(packets) : reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`))));
  });
}
