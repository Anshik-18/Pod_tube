'use client';

/**
 * Durable local copy of recording chunks (IndexedDB, i.e. on disk — not in RAM).
 *
 * Every chunk is written here as soon as MediaRecorder produces it and deleted only after the
 * server has confirmed the upload. So:
 *   - a slow uplink builds a backlog on disk instead of in memory (hour-long takes are GBs);
 *   - a crashed or closed tab loses nothing: when the participant rejoins the studio, the
 *     leftover chunks are found and uploaded.
 *
 * Everything degrades gracefully: if IndexedDB is unavailable (private mode) or full, chunks are
 * kept in memory exactly as before.
 */

const DB_NAME = 'podnow-recordings';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const TRACKS = 'tracks';
/** Local copies of tracks that never finished are kept this long. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredTrack {
  /** `${sessionId}:${trackId}` */
  key: string;
  sessionId: string;
  trackId: string;
  state: 'recording' | 'stopped';
  /** Server-clock ISO timestamps. */
  startedAt?: string;
  endedAt?: string;
  /** Highest chunk index produced so far, and when (server clock, ISO). */
  lastIndex: number;
  lastChunkAt?: string;
  /** Known once recording stopped normally. */
  totalChunks?: number;
  updatedAt: number;
}

interface StoredChunk {
  trackKey: string;
  index: number;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        return resolve(null);
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHUNKS)) {
          const chunks = db.createObjectStore(CHUNKS, { keyPath: ['trackKey', 'index'] });
          chunks.createIndex('byTrack', 'trackKey');
        }
        if (!db.objectStoreNames.contains(TRACKS)) {
          const tracks = db.createObjectStore(TRACKS, { keyPath: 'key' });
          tracks.createIndex('bySession', 'sessionId');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = run(t);
    t.oncomplete = () => resolve(req ? (req as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const trackKey = (sessionId: string, trackId: string) => `${sessionId}:${trackId}`;

export const chunkStore = {
  /** Ask the browser not to evict our data under storage pressure (best effort). */
  async requestPersistence(): Promise<void> {
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Not supported
    }
  },

  /** Save a chunk. Returns false if it couldn't be stored (no IndexedDB, quota full). */
  async putChunk(key: string, index: number, blob: Blob): Promise<boolean> {
    const db = await openDb();
    if (!db) return false;
    try {
      await tx(db, [CHUNKS], 'readwrite', (t) => t.objectStore(CHUNKS).put({ trackKey: key, index, blob } satisfies StoredChunk));
      return true;
    } catch {
      return false;
    }
  },

  async getChunk(key: string, index: number): Promise<Blob | null> {
    const db = await openDb();
    if (!db) return null;
    try {
      const row = await tx<StoredChunk>(db, [CHUNKS], 'readonly', (t) => t.objectStore(CHUNKS).get([key, index]));
      return row?.blob ?? null;
    } catch {
      return null;
    }
  },

  async deleteChunk(key: string, index: number): Promise<void> {
    const db = await openDb();
    if (!db) return;
    await tx(db, [CHUNKS], 'readwrite', (t) => t.objectStore(CHUNKS).delete([key, index])).catch(() => {});
  },

  /** Indices of chunks still stored locally for a track (not yet confirmed by the server). */
  async listChunkIndices(key: string): Promise<number[]> {
    const db = await openDb();
    if (!db) return [];
    try {
      const keys = await tx<IDBValidKey[]>(db, [CHUNKS], 'readonly', (t) =>
        t.objectStore(CHUNKS).index('byTrack').getAllKeys(IDBKeyRange.only(key))
      );
      return (keys ?? []).map((k) => (k as [string, number])[1]).sort((a, b) => a - b);
    } catch {
      return [];
    }
  },

  async putTrack(track: StoredTrack): Promise<void> {
    const db = await openDb();
    if (!db) return;
    await tx(db, [TRACKS], 'readwrite', (t) => t.objectStore(TRACKS).put({ ...track, updatedAt: Date.now() })).catch(() => {});
  },

  async getTrack(key: string): Promise<StoredTrack | null> {
    const db = await openDb();
    if (!db) return null;
    return ((await tx<StoredTrack>(db, [TRACKS], 'readonly', (t) => t.objectStore(TRACKS).get(key)).catch(() => undefined)) ?? null);
  },

  /** The track finalized: forget it and any chunks left behind. */
  async deleteTrack(key: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const indices = await this.listChunkIndices(key);
    await tx(db, [CHUNKS, TRACKS], 'readwrite', (t) => {
      const chunks = t.objectStore(CHUNKS);
      for (const i of indices) chunks.delete([key, i]);
      t.objectStore(TRACKS).delete(key);
    }).catch(() => {});
  },

  async tracksForSession(sessionId: string): Promise<StoredTrack[]> {
    const db = await openDb();
    if (!db) return [];
    try {
      return (await tx<StoredTrack[]>(db, [TRACKS], 'readonly', (t) => t.objectStore(TRACKS).index('bySession').getAll(IDBKeyRange.only(sessionId)))) ?? [];
    } catch {
      return [];
    }
  },

  /** Drop local copies of abandoned tracks from old sessions. */
  async pruneOld(): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
      const all = (await tx<StoredTrack[]>(db, [TRACKS], 'readonly', (t) => t.objectStore(TRACKS).getAll())) ?? [];
      for (const track of all) {
        if (Date.now() - track.updatedAt > MAX_AGE_MS) await this.deleteTrack(track.key);
      }
    } catch {
      // Best effort
    }
  },
};
