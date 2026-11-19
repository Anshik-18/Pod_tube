'use client';

import { ChevronDown, Keyboard, Lightbulb } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';

const STEPS = [
  { title: '1. Create a Session', body: 'Click “New recording”, name it, and you’ll land in the studio’s device check.' },
  { title: '2. Start Recording', body: 'Press Record. Everyone sees a 3-2-1 countdown and recording starts on every device at once.' },
  { title: '3. Invite Guests', body: 'Use “Invite” to copy the guest link and send it to everyone — up to 8 people per studio. Guests join from their browser, even after recording has started.' },
  { title: '4. Stop & Process', body: 'Press Stop. Each person’s recording finishes uploading, then we render the episode automatically.' },
  { title: '5. Download', body: 'Download the episode as MP4 or MP3, plus each participant’s original track, from the project page.' },
];

const FAQS = [
  {
    q: 'What browsers are supported?',
    a: 'The latest Chrome or Edge on a laptop or desktop gives the best results. Firefox and Safari also work. The studio checks your browser and devices before you join.',
  },
  {
    q: 'Can I record without a guest?',
    a: 'Yes. Start recording on your own; you can share the guest link at any point, and late guests are recorded from the moment they join.',
  },
  {
    q: 'How many people can join a studio?',
    a: 'Up to 8 people on camera: you plus 7 guests, all using the same invite link. Everyone is recorded on their own device, and each person becomes a separate track in the project.',
  },
  {
    q: 'Can I share my screen?',
    a: 'Yes. Use the screen button in the studio. Everyone sees it live, and while recording it is saved as its own track. The exported episode switches to a screen-plus-cameras layout for exactly the time you shared.',
  },
  {
    q: 'What if someone’s connection drops or their browser crashes?',
    a: 'Their recording keeps uploading in the background whenever the connection returns. If their browser closes mid-recording, they can rejoin with the same link: what already uploaded is kept, and they continue in the same spot in the final video. If someone can’t come back, use “Process now” to finish without them.',
  },
  {
    q: 'Can I mute or remove a guest?',
    a: 'Yes. As the host, open People in the studio and use the menu next to a guest to ask them to mute, pin them to the stage, or remove them from the studio.',
  },
  {
    q: 'How long does processing take?',
    a: 'Usually a fraction of the recording length — a 30-minute recording typically takes a few minutes. The project page shows live progress, and you can leave while it runs.',
  },
  {
    q: 'Can I edit my recordings?',
    a: 'You can trim the start and end, choose an export quality, rename the project and add notes. For full editing, download each participant’s separate track.',
  },
  {
    q: 'What if my recording fails?',
    a: 'Uploads retry automatically and pause while you’re offline, so a dropped connection doesn’t lose data — keep the tab open until the upload completes. If processing fails, the project page shows the error and a Retry button.',
  },
  {
    q: 'Can I delete multiple episodes at once?',
    a: 'Yes. On the Projects page click “Select”, choose the projects you want, and delete them together.',
  },
  {
    q: 'How do I change my email or password?',
    a: 'Open Settings from the sidebar to update your name, email or password. Changing your email signs you out.',
  },
];

const FEATURES = [
  { title: 'Real-time Recording', body: 'Up to 1080p video and 48 kHz audio recorded locally on each device.' },
  { title: 'Guest Invitations', body: 'One link for all your guests — no account or download needed.' },
  { title: 'Automatic Processing', body: 'Tracks are synchronized and composited side by side.' },
  { title: 'Trimming & Editing', body: 'Trim the start and end, then re-export in Draft, Standard or High quality.' },
  { title: 'Multiple Formats', body: 'MP4 video, MP3 audio, and every participant’s original track.' },
  { title: 'Search & Filter', body: 'Find projects by title and filter by status.' },
];

const SHORTCUTS = [
  ['M', 'Add a marker while recording'],
  ['⌘/Ctrl + D', 'Mute or unmute your microphone'],
  ['⌘/Ctrl + E', 'Turn your camera on or off'],
];

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Help & Documentation</h1>
        <p className="mt-1 text-sm text-ink-muted">Get answers to common questions and learn how to get studio-quality results with PodNow.</p>
      </div>

      <section>
        <h2 className="mb-4 text-base font-semibold">Quick Start Guide</h2>
        <ol className="grid gap-3 sm:grid-cols-2">
          {STEPS.map((step) => (
            <li key={step.title} className="card p-4 last:sm:col-span-2">
              <h3 className="text-sm font-semibold">{step.title}</h3>
              <p className="mt-1 text-sm text-ink-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="mb-4 text-base font-semibold">Frequently Asked Questions</h2>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {FAQS.map((faq) => (
            <details key={faq.q} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-medium hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                <h3>{faq.q}</h3>
                <ChevronDown className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-open:rotate-180" />
              </summary>
              <p className="px-5 pb-4 text-sm leading-relaxed text-ink-muted">{faq.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-base font-semibold">Key Features</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-4">
              <h3 className="text-sm font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-ink-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Lightbulb className="h-4 w-4 text-brand-light" />
            Tips for Best Results
          </h2>
          <ul className="space-y-2 text-sm text-ink-muted">
            <li>Use a good quality microphone and webcam for better audio/video quality.</li>
            <li>Ensure you have a stable internet connection before starting.</li>
            <li>Wear headphones so the other person’s voice doesn’t echo into your mic.</li>
            <li>Close other apps and browser tabs that use your camera or lots of CPU.</li>
            <li>Keep the studio tab open until your upload reaches 100%.</li>
          </ul>
        </section>
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Keyboard className="h-4 w-4 text-brand-light" />
            Studio shortcuts
          </h2>
          <ul className="space-y-2.5 text-sm">
            {SHORTCUTS.map(([keys, label]) => (
              <li key={keys} className="flex items-center justify-between gap-4">
                <span className="text-ink-muted">{label}</span>
                <kbd className="rounded-md border border-line-strong bg-surface-3 px-2 py-0.5 font-mono text-xs">{keys}</kbd>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Need More Help?</h2>
          <p className="mt-1 text-sm text-ink-muted">Still stuck? Make sure your browser is up to date and that the studio has camera and microphone permission.</p>
        </div>
        <div className="flex gap-2">
          <ButtonLink href="/dashboard" variant="secondary">Back to Dashboard</ButtonLink>
          <ButtonLink href="/sessions/new" variant="record">Start Recording</ButtonLink>
        </div>
      </section>
    </div>
  );
}
