'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api, getAuthToken } from '@/lib/client/api';
import { ChunkUploadQueue } from '@/lib/recording/upload-queue';
import { formatBytes } from '@/lib/client/format';

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;

/** Read a media file's duration in the browser (0 if it can't be decoded here). */
function readDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
    const url = URL.createObjectURL(file);
    const done = (value: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) ? value : 0);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    el.src = url;
  });
}

/**
 * "Upload a file" — turns an existing video/audio file into a project. The file is split into
 * chunks and sent through the same resumable upload + processing pipeline as studio recordings.
 */
export function useUploadRecording() {
  const router = useRouter();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<ChunkUploadQueue | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'finishing' | 'failed'>('idle');

  const start = async (selected: File) => {
    if (selected.size > MAX_FILE_BYTES) {
      showToast('Files larger than 10 GB aren’t supported.', 'error');
      return;
    }
    setFile(selected);
    setProgress(0);
    setStage('uploading');

    try {
      const title = selected.name.replace(/\.[^.]+$/, '').slice(0, 255) || 'Uploaded recording';
      const { session } = await api<{ session: { id: string } }>('/api/sessions', { method: 'POST', json: { title } });
      const durationSec = await readDuration(selected);
      const totalChunks = Math.max(1, Math.ceil(selected.size / CHUNK_SIZE));

      await new Promise<void>((resolve, reject) => {
        const queue = new ChunkUploadQueue({
          sessionId: session.id,
          participantType: 'host',
          authToken: getAuthToken() || '',
          concurrency: 4,
          onProgress: (stats) => setProgress(stats.totalBytes ? Math.round((stats.uploadedBytes / selected.size) * 100) : 0),
          onAllUploadsComplete: () => resolve(),
          onUploadsFailed: () => reject(new Error('Upload failed. Check your connection and try again.')),
        });
        queueRef.current = queue;
        for (let i = 0; i < totalChunks; i++) {
          queue.enqueue(i, selected.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE, selected.type));
        }
        queue.signalRecordingStopped();
      });

      setStage('finishing');
      const endedAt = new Date();
      const startedAt = new Date(endedAt.getTime() - durationSec * 1000);
      const { episodeId } = await api<{ episodeId: string }>('/api/upload/finalize', {
        method: 'POST',
        json: {
          sessionId: session.id,
          participantType: 'host',
          totalChunks,
          recordingStartedAt: startedAt.toISOString(),
          recordingEndedAt: endedAt.toISOString(),
        },
      });
      showToast('Upload complete — processing your project', 'success');
      router.push(`/episodes/${episodeId}`);
    } catch (err) {
      setStage('failed');
      showToast((err as Error).message || 'Upload failed', 'error');
    }
  };

  const open = () => inputRef.current?.click();

  const close = () => {
    queueRef.current?.destroy();
    setStage('idle');
    setFile(null);
  };

  const element = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const selected = e.target.files?.[0];
          e.target.value = '';
          if (selected) start(selected);
        }}
      />
      <Modal
        open={stage !== 'idle'}
        onClose={close}
        dismissible={stage === 'failed'}
        title={stage === 'failed' ? 'Upload failed' : 'Uploading file'}
        description={file ? `${file.name} · ${formatBytes(file.size)}` : undefined}
        footer={
          stage === 'failed' ? (
            <>
              <Button variant="ghost" onClick={close}>Close</Button>
              <Button onClick={() => file && start(file)}>Try again</Button>
            </>
          ) : undefined
        }
      >
        {stage !== 'failed' && (
          <div>
            <div className="mb-2 flex justify-between text-sm">
              <span className="text-ink-muted">{stage === 'finishing' ? 'Finishing up…' : 'Uploading…'}</span>
              <span className="font-medium">{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-4">
              <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${Math.max(progress, 2)}%` }} />
            </div>
            <p className="mt-3 text-xs text-ink-faint">Keep this tab open until the upload finishes.</p>
          </div>
        )}
      </Modal>
    </>
  );

  return { open, element, busy: stage === 'uploading' || stage === 'finishing' };
}

export function UploadIcon() {
  return <Upload className="h-4 w-4" />;
}
