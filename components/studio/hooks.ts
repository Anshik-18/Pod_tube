'use client';

import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new Ctor();
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
}

/**
 * Live input level (0..1) of a stream's audio track, sampled ~12 times per second.
 * Used for speaking indicators and the lobby mic meter.
 */
export function useAudioLevel(stream: MediaStream | null, enabled = true): number {
  const [level, setLevel] = useState(0);
  const trackId = stream?.getAudioTracks()[0]?.id;

  useEffect(() => {
    if (!stream || !enabled || !trackId) {
      setLevel(0);
      return;
    }
    const ctx = getAudioContext();
    if (!ctx) return;

    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    let smoothed = 0;
    const interval = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const value = Math.min(1, rms * 4);
      smoothed = value > smoothed ? value : smoothed * 0.75 + value * 0.25;
      setLevel((prev) => (Math.abs(prev - smoothed) > 0.02 ? smoothed : prev));
    }, 80);

    return () => {
      clearInterval(interval);
      source.disconnect();
      analyser.disconnect();
    };
  }, [stream, trackId, enabled]);

  return level;
}

/**
 * Estimate (serverClock - localClock) with a few NTP-style round trips, keeping the sample
 * with the lowest RTT. Lets recordings from different machines share one timeline.
 */
export async function measureClockOffset(socket: Socket, samples = 4): Promise<number> {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const result = await new Promise<{ rtt: number; offset: number } | null>((resolve) => {
      const t0 = Date.now();
      const timer = setTimeout(() => resolve(null), 3000);
      socket.emit('time:sync', null, (serverTime: number) => {
        clearTimeout(timer);
        const t1 = Date.now();
        resolve({ rtt: t1 - t0, offset: serverTime - (t0 + t1) / 2 });
      });
    });
    if (result && (!best || result.rtt < best.rtt)) best = result;
  }
  return best?.offset ?? 0;
}

/** Seconds elapsed since `startedAt` (server ms), ticking once per second. */
export function useElapsed(startedAtServerMs: number | null, clockOffsetMs: number): number {
  const [elapsed, setElapsed] = useState(0);
  const offsetRef = useRef(clockOffsetMs);
  offsetRef.current = clockOffsetMs;

  useEffect(() => {
    if (!startedAtServerMs) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, (Date.now() + offsetRef.current - startedAtServerMs) / 1000));
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [startedAtServerMs]);

  return elapsed;
}
