'use client';

import { ToastProvider } from '@/components/ui/Toast';
import { Logo } from '@/components/ui/Logo';

const POINTS = ['Local recording in up to 1080p', 'Progressive uploads — nothing lost to a bad connection', 'Separate tracks for every participant'];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="grid min-h-screen bg-canvas lg:grid-cols-2">
        <div className="flex flex-col px-6 py-8 sm:px-12">
          <Logo />
          <div className="flex flex-1 items-center justify-center py-10">
            <div className="w-full max-w-sm animate-slide-up">{children}</div>
          </div>
        </div>
        <div className="relative hidden overflow-hidden border-l border-line bg-surface lg:block">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(124,92,255,0.25),transparent_60%),radial-gradient(ellipse_at_bottom_left,rgba(239,68,68,0.12),transparent_55%)]" />
          <div className="relative flex h-full flex-col justify-center px-16">
            <div className="mb-10 grid max-w-md grid-cols-2 gap-3">
              {['#7c5cff', '#0ea5e9'].map((color, i) => (
                <div key={color} className="relative aspect-[4/5] overflow-hidden rounded-2xl border border-white/10 bg-surface-3">
                  <div className="absolute inset-0 opacity-60" style={{ background: `radial-gradient(circle at 50% 38%, ${color}, transparent 65%)` }} />
                  <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60" />
                  <span className="absolute bottom-3 left-3 rounded-md bg-black/50 px-2 py-0.5 text-xs text-white">{i === 0 ? 'You' : 'Guest'}</span>
                  {i === 0 && <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md bg-rec px-1.5 py-0.5 text-[11px] font-semibold text-white"><span className="h-1.5 w-1.5 rounded-full bg-white" />REC</span>}
                </div>
              ))}
            </div>
            <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">Studio-quality recordings, from anywhere.</h2>
            <ul className="mt-6 space-y-3 text-sm text-ink-muted">
              {POINTS.map((point) => (
                <li key={point} className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
