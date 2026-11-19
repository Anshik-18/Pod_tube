# PodNow - Video Podcast Recording App

A beginner-friendly video podcast recording application built with Next.js, WebRTC, and FFmpeg.

## Features

**Studio**
- **Up to 8 people** (host + 7 guests) from one invite link — peer-to-peer mesh, no SFU needed
- Pre-join device check: live HD preview, camera/mic/speaker pickers, mic level meter, speaker test, audio-only fallback when no camera is available
- Local recording of every participant (up to 1080p, 48 kHz audio) — independent of call quality; the live call adapts its bitrate to the room size
- **Screen sharing**, shown live to everyone and recorded as its own track
- Server-synchronized 3-2-1 countdown; late joiners are recorded automatically
- **Crash-safe**: someone who refreshes or crashes mid-recording rejoins as a new segment of their own track (nothing already uploaded is lost)
- Progressive, resilient uploads (5 s chunks saved to disk first, retries with backoff, pauses while offline, manual retry)
- Auto grid, speaker view with filmstrip, pin anyone to the stage, active-speaker highlight, per-person connection quality
- Host controls: ask a guest to mute, remove a guest; live upload status for everyone after recording
- Chat, private notes, markers (`M`), mute/camera shortcuts (`⌘/Ctrl+D`, `⌘/Ctrl+E`)

**Projects**
- Automatic processing: tracks are synchronized on a shared server clock and composited into an auto grid (1–8 people), switching to a screen + camera-sidebar layout while someone shares their screen
- If a guest never finishes uploading, the host can **Process now** with the tracks that arrived
- Live processing progress, readable errors and one-click retry
- Trim (set from the playhead), Draft/Standard/High export quality, re-export at any time
- Downloads: MP4 episode, MP3 audio, and every participant's original **separate track** (cameras, rejoin segments and screen shares)
- Thumbnails, markers on the timeline, notes, search/filter/sort and bulk delete
- Upload an existing video or audio file to create a project

**Platform**
- Schema migrations run automatically on server start (`lib/db/migrate.ts`)
- Local disk or Cloudflare R2/S3 storage; large files stream instead of buffering in memory

## Tech Stack

- **Frontend**: Next.js 14+ (App Router), React, TypeScript, Tailwind CSS
- **Backend**: Next.js API routes
- **Database**: PostgreSQL
- **Real-time**: Socket.io (WebSocket)
- **Storage**: Local filesystem (S3-compatible abstraction layer)
- **Processing**: FFmpeg (spawned directly by the background worker in `lib/worker`)
- **Testing**: Jest, React Testing Library

## Prerequisites

- Node.js 18+ and npm
- PostgreSQL database
- **FFmpeg installed on the system** (see installation instructions below)
- TURN server (for WebRTC NAT traversal, optional for development)

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   
   Create a `.env` file in the root directory with the following variables:
   
   **Required:**
   - `DATABASE_URL` - Your PostgreSQL connection string (you already have this)
   - `JWT_SECRET` - A random secret key for authentication (generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - `STORAGE_TYPE=local` - Use local filesystem storage
   - `STORAGE_LOCAL_DIR=./uploads` - Directory for uploaded files
   
   **Optional:**
   - `FFMPEG_PATH` - Full path to FFmpeg executable (only if not in system PATH)
   - `TURN_SERVER_URL` - TURN server URL (leave empty for development)
   - `TURN_SERVER_USERNAME` - TURN server username
   - `TURN_SERVER_PASSWORD` - TURN server password
   
   See `ENV_SETUP.md` for detailed explanations and setup instructions.
   
   Example `.env`:
   ```bash
   DATABASE_URL=postgresql://user:password@localhost:5432/riverside_clone
   JWT_SECRET=your-generated-secret-key-here
   STORAGE_TYPE=local
   STORAGE_LOCAL_DIR=./uploads
   # TURN server variables (optional)
   # TURN_SERVER_URL=
   # TURN_SERVER_USERNAME=
   # TURN_SERVER_PASSWORD=
   ```

3. **Install FFmpeg**:
   
   **Windows:**
   - Download FFmpeg from https://www.gyan.dev/ffmpeg/builds/
   - Extract to a folder (e.g., `C:\ffmpeg`)
   - Add `C:\ffmpeg\bin` to your system PATH, OR
   - Set `FFMPEG_PATH` in your `.env` file: `FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe`
   
   **macOS:**
   ```bash
   brew install ffmpeg
   ```
   
   **Linux (Ubuntu/Debian):**
   ```bash
   sudo apt update
   sudo apt install ffmpeg
   ```
   
   **Verify installation:**
   ```bash
   ffmpeg -version
   ```
   
   If FFmpeg is not in your PATH, add `FFMPEG_PATH` to your `.env` file with the full path to the executable.

4. **Set up the database**:
   Run the SQL schema file:
   ```bash
   psql -d podnow -f lib/db/schema.sql
   ```
   
   Run migration scripts for new features:
   ```bash
   psql -d podnow -f scripts/add-episode-description-column.sql
   psql -d podnow -f scripts/add-processing-progress-column.sql
   ```
   
   Or use your database tool (pgAdmin, etc.) to run the SQL from `lib/db/schema.sql`.

5. **Start the development server**:
   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:3000`

## Local development (quick start)

```bash
# 1. Postgres in a container (or point DATABASE_URL at any Postgres 14+)
podman run -d --name podnow-pg -e POSTGRES_USER=podnow -e POSTGRES_PASSWORD=podnow -e POSTGRES_DB=podnow \
  -p 5432:5432 -v podnow-pgdata:/var/lib/postgresql/data docker.io/library/postgres:16-alpine
podman exec -i podnow-pg psql -U podnow -d podnow < lib/db/schema.sql

# 2. .env.local (gitignored) overrides .env
DATABASE_URL=postgresql://podnow:podnow@localhost:5432/podnow
STORAGE_TYPE=local
STORAGE_LOCAL_DIR=./uploads

# 3. Run
npm install && npm run dev        # PORT=3100 npm run dev to use another port
```

FFmpeg must be on the PATH. Distro builds without x264 (e.g. Fedora's `ffmpeg-free`) work too: the worker detects the
available H.264 encoder and falls back to OpenH264.

## How multi-person recording works

| Piece | Where |
|---|---|
| Participant ids: `host`, `guest-<key>`, `<id>.screen<n>`, `<id>.part<n>` | `lib/participants.ts` |
| Signaling, room capacity, host controls, recording clock, segment assignment | `lib/websocket/server.ts` |
| Browser mesh (fixed audio / camera / screen transceivers, no renegotiation) | `lib/webrtc/mesh.ts` |
| One local recorder + upload queue + finalize per track | `lib/recording/track-recorder.ts` |
| "Everyone finished?" → start processing (and the host's *Process now*) | `lib/sessions/completion.ts` |
| Scene timeline, layouts, per-scene video + single audio mix (FFmpeg) | `lib/worker/scenes.ts`, `lib/worker/merge-stage.ts` |

Each guest's browser keeps a stable guest key per invite (localStorage), so a refresh continues as the same person.

## Recording reliability & scale

What happens to a recording, end to end, and what it survives:

| Situation | Behaviour |
|---|---|
| Slow uplink / long take | Each 5 s chunk is written to the browser's **IndexedDB (on disk)** first; only the chunk being uploaded is held in memory, so a 1-hour backlog doesn't grow RAM. Uploads run one at a time while recording (the live call keeps its bandwidth) and three at a time after Stop. |
| Network drops | Uploads pause while offline (without spending retries) and resume automatically. |
| Tab crash / closed / refresh | Unsent chunks stay on disk. Reopening the studio link finds them, tells the server to keep that track open, uploads them and finalizes with the timing saved while recording. A rejoin mid-recording continues as a new segment (`.part2`) in the same tile. |
| Chunk lost for good | The worker assembles **around** the gap (the WebM demuxer resyncs at the next cluster, timestamps intact) and drops the few undecodable frames up to the next keyframe. The picture holds and audio is silent for the missing seconds; everything after stays in sync. The project page lists what's missing and where. Only chunk 0 (the codec header) is essential. |
| Phantom uploads | `chunk-confirm` checks the object really exists in storage before marking a chunk uploaded. |
| Everyone stops at once | Exactly one processing job is queued (atomic session transition + unique index). |
| Worker dies mid-job | Jobs without a progress heartbeat for 15 min are requeued. |
| Someone never comes back | A session waiting on uploads with no activity for 10 min is processed with what arrived (the host can also click **Process now**). |

### How people who come and go fit into the episode

Every track is stamped with its start/end in **server time** (each browser measures its clock offset
when it connects), so pieces recorded on different machines — and a person's segments before and after
a rejoin — land at the right moment. Verified with cameras that draw the wall-clock time: all tiles in
the final video agree to within 1–2 frames, across a crash, a rejoin and a late join.

The episode is cut into **scenes** (`lib/worker/scenes.ts`) so the layout follows who is actually there:

| Situation | In the episode |
|---|---|
| Late joiner | Enters the layout when they join — no empty slot before |
| Absent > 20 s (left, crashed and came back later) | Leaves the layout, everyone else reflows; returns in their slot when they rejoin |
| Absent ≤ 20 s (a blip) | Keeps their slot with a placeholder card, so the layout doesn't jump |
| Leaves for good | Removed from the layout at the moment they left |
| Screen share | Screen + camera sidebar for exactly that span |

Scenes shorter than 1.5 s are folded into a neighbour, and boundaries are snapped to whole frames.
Each scene is encoded separately (only the people in it are decoded), the audio is mixed once for the
whole timeline, and scenes are joined with a stream-copy concat — no re-encode, no drift.

**Measured** on a laptop (Ryzen 5 5600H) with two 26-minute 1080p tracks (2.26 GB of chunks, 3 chunks missing):
about 15 min to process from chunks, **~540 MB peak RAM for the whole worker** (Node + FFmpeg; flat over
the whole recording and independent of gap size — it was ~2.1 GB before gap handling was fixed), and peak
scratch disk **1.5× the input** (chunk files are deleted as they're joined). Downloads run 6 in parallel;
outputs over 100 MB go to R2/S3 as multipart uploads (no 5 GB single-PUT limit).

Worker settings:

- `PROCESSING_WORK_DIR` — scratch directory for processing (default: the OS temp dir, or `./.processing`
  if the temp dir is a RAM-backed tmpfs, as on Fedora). Needs ~1.5–3× the recording size free; the
  worker checks free space before starting and fails with a clear message instead of `ENOSPC`.

## Testing

Run tests with:
```bash
npm test
```

Run tests in watch mode:
```bash
npm run test:watch
```

Generate coverage report:
```bash
npm run test:coverage
```

## Project Structure

```
├── app/                    # Next.js App Router
│   ├── (auth)/            # Authentication pages
│   ├── (dashboard)/       # Protected dashboard pages
│   ├── api/               # API routes
│   └── join/              # Guest join page
├── lib/                   # Shared utilities
│   ├── auth/              # Authentication logic
│   ├── db/                # Database queries
│   ├── storage/           # Storage abstraction
│   ├── webrtc/           # WebRTC utilities
│   ├── recording/        # Recording logic
│   ├── upload/            # Upload utilities
│   └── processing/       # FFmpeg processing
├── components/            # React components
├── __tests__/            # Test files
└── memory-bank/          # Project documentation
```

## Usage

1. **Sign up** for an account
2. **Create a session** and share the guest link
3. **Start recording** when both participants are ready
4. **Uploads** happen automatically after recording stops
5. **Process and export** episodes with optional trimming

## Development

- Run `npm run dev` for development
- Run `npm run build` to build for production
- Run `npm start` to start production server
- Run `npm test` to run tests

## Notes

- Raw uploaded media is never auto-deleted until export succeeds
- All job state is persisted in PostgreSQL
- Storage uses logical file references (not absolute paths)
- WebSocket is used for real-time UI updates with HTTP polling fallback
