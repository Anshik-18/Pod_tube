'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { HardDrive, CloudUpload, Layers, Scissors, Link2, Bookmark, ArrowRight, Mic, Video } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { ButtonLink } from '@/components/ui/Button';
import { getAuthToken } from '@/lib/client/api';

const FEATURES = [
  { icon: HardDrive, title: 'Local recording', body: 'Everyone is recorded on their own device in up to 1080p with 48 kHz audio — never the compressed call.' },
  { icon: CloudUpload, title: 'Progressive uploads', body: 'Recordings upload in the background while you talk, and survive dropped connections.' },
  { icon: Layers, title: 'Separate tracks', body: 'Download each participant’s original track alongside a synced, side-by-side episode.' },
  { icon: Link2, title: 'One-click guest links', body: 'Up to 8 people join from their browser. No account, no app, no setup.' },
  { icon: Bookmark, title: 'Markers & chat', body: 'Drop markers on great moments and coordinate in chat without interrupting.' },
  { icon: Scissors, title: 'Trim & export', body: 'Trim the intro and outro and re-export as MP4 or MP3 in the quality you need.' },
];

const STEPS = [
  { title: 'Open a studio', body: 'Name your recording and check your camera and mic.' },
  { title: 'Invite your guests', body: 'Share one link — everyone joins in seconds from any modern browser.' },
  { title: 'Hit record', body: 'A synced countdown starts recording for everyone at once.' },
  { title: 'Download', body: 'Get the finished episode and each person’s separate track.' },
];

export default function Home() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(!!getAuthToken()), []);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Logo />
          <nav className="flex items-center gap-2">
            {signedIn ? (
              <ButtonLink href="/dashboard">Open dashboard</ButtonLink>
            ) : (
              <>
                <ButtonLink href="/login" variant="ghost">Sign in</ButtonLink>
                <ButtonLink href="/signup">Get started</ButtonLink>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_-10%,rgba(124,92,255,0.28),transparent)]" />
          <div className="relative mx-auto max-w-6xl px-5 pb-20 pt-20 text-center sm:pt-28">
            <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface/70 px-3 py-1 text-xs text-ink-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-rec" /> Remote recording studio in your browser
            </span>
            <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
              Studio-quality podcasts, <span className="text-brand-light">recorded from anywhere.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base text-ink-muted sm:text-lg">
              Record remote interviews in full local quality. A bad connection affects the call — never your recording.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ButtonLink href={signedIn ? '/sessions/new' : '/signup'} size="lg" variant="record">
                <span className="h-2.5 w-2.5 rounded-full bg-white" />
                Start recording free
              </ButtonLink>
              <ButtonLink href={signedIn ? '/dashboard' : '/login'} size="lg" variant="secondary">
                {signedIn ? 'Go to dashboard' : 'Sign in'}
                <ArrowRight className="h-4 w-4" />
              </ButtonLink>
            </div>

            {/* Studio preview */}
            <div className="mx-auto mt-16 max-w-4xl rounded-2xl border border-line bg-surface/80 p-3 shadow-elevated">
              <div className="flex items-center justify-between px-2 pb-3">
                <span className="text-xs text-ink-muted">Episode 12 — Interview</span>
                <span className="flex items-center gap-1.5 rounded-md bg-rec/15 px-2 py-0.5 font-mono text-xs font-semibold text-red-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rec" /> 24:18
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { name: 'Alex', color: '#7c5cff', speaking: true },
                  { name: 'Sam', color: '#0ea5e9', speaking: false },
                ].map((p) => (
                  <div key={p.name} className={`relative aspect-video overflow-hidden rounded-xl bg-surface-3 ring-2 ${p.speaking ? 'ring-brand' : 'ring-transparent'}`}>
                    <div className="absolute inset-0" style={{ background: `radial-gradient(circle at 50% 45%, ${p.color}66, transparent 60%)` }} />
                    <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-0.5 text-xs text-white">{p.name}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-center gap-2">
                {[Mic, Video, Bookmark].map((Icon, i) => (
                  <span key={i} className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface-3 text-ink-muted">
                    <Icon className="h-4 w-4" />
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">Everything you need to record great conversations</h2>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <div key={title} className="card p-6">
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-light">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">From invite to episode in four steps</h2>
            <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.title}>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line-strong font-mono text-sm text-ink-muted">{i + 1}</span>
                  <h3 className="mt-4 font-semibold">{step.title}</h3>
                  <p className="mt-1 text-sm text-ink-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto max-w-3xl px-5 py-20 text-center">
            <h2 className="text-3xl font-semibold tracking-tight">Ready to record?</h2>
            <p className="mt-3 text-ink-muted">Open your first studio in under a minute.</p>
            <ButtonLink href={signedIn ? '/sessions/new' : '/signup'} size="lg" className="mt-8">
              {signedIn ? 'New recording' : 'Create your free account'}
            </ButtonLink>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-xs text-ink-faint sm:flex-row">
          <Logo />
          <p>© {new Date().getFullYear()} PodNow. Record locally, sound professional.</p>
          <Link href="/login" className="hover:text-ink">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
