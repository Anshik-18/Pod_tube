'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';

interface DeviceOption {
  deviceId: string;
  label: string;
}

export function SettingsDialog({
  open,
  onClose,
  stream,
  speakerId,
  mirror,
  locked,
  onChangeDevice,
  onChangeSpeaker,
  onToggleMirror,
}: {
  open: boolean;
  onClose: () => void;
  stream: MediaStream | null;
  speakerId: string | null;
  mirror: boolean;
  /** Devices can't change mid-recording: it would end the local recording track. */
  locked: boolean;
  onChangeDevice: (kind: 'video' | 'audio', deviceId: string) => void;
  onChangeSpeaker: (deviceId: string | null) => void;
  onToggleMirror: () => void;
}) {
  const [devices, setDevices] = useState<{ video: DeviceOption[]; audio: DeviceOption[]; output: DeviceOption[] }>({ video: [], audio: [], output: [] });

  useEffect(() => {
    if (!open) return;
    navigator.mediaDevices.enumerateDevices().then((list) => {
      const pick = (kind: MediaDeviceKind, fallback: string) =>
        list.filter((d) => d.kind === kind && d.deviceId).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
      setDevices({ video: pick('videoinput', 'Camera'), audio: pick('audioinput', 'Microphone'), output: pick('audiooutput', 'Speaker') });
    });
  }, [open]);

  const videoTrack = stream?.getVideoTracks()[0];
  const audioTrack = stream?.getAudioTracks()[0];
  const settings = videoTrack?.getSettings();

  return (
    <Modal open={open} onClose={onClose} title="Studio settings">
      <div className="space-y-4">
        {locked && <p className="rounded-lg border border-line bg-surface-3 px-3 py-2 text-xs text-ink-muted">Camera and microphone can’t be changed while recording.</p>}
        <div>
          <label className="label" htmlFor="settings-camera">Camera</label>
          <select id="settings-camera" className="input" disabled={locked} value={settings?.deviceId ?? ''} onChange={(e) => onChangeDevice('video', e.target.value)}>
            {devices.video.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
          {settings?.width && (
            <p className="mt-1 text-xs text-ink-faint">
              Recording at {settings.width}×{settings.height}
              {settings.frameRate ? ` · ${Math.round(settings.frameRate)} fps` : ''}
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="settings-mic">Microphone</label>
          <select id="settings-mic" className="input" disabled={locked} value={audioTrack?.getSettings().deviceId ?? ''} onChange={(e) => onChangeDevice('audio', e.target.value)}>
            {devices.audio.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="settings-speaker">Speaker</label>
          <select id="settings-speaker" className="input" value={speakerId ?? ''} onChange={(e) => onChangeSpeaker(e.target.value || null)}>
            <option value="">System default</option>
            {devices.output.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-line px-3 py-2.5">
          <span>
            <span className="block text-sm">Mirror my video</span>
            <span className="block text-xs text-ink-faint">Only affects your preview, never the recording.</span>
          </span>
          <input type="checkbox" checked={mirror} onChange={onToggleMirror} className="h-4 w-4 accent-[#7c5cff]" />
        </label>
      </div>
    </Modal>
  );
}
