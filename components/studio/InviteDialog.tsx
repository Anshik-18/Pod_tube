'use client';

import { useState } from 'react';
import { Check, Copy, Mail } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

export function inviteUrl(inviteToken: string): string {
  return typeof window === 'undefined' ? '' : `${window.location.origin}/join/${inviteToken}`;
}

export function InviteDialog({ open, onClose, inviteToken, title }: { open: boolean; onClose: () => void; inviteToken: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState('');
  const link = inviteUrl(inviteToken);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the field is selectable as a fallback.
    }
  };

  const mailto = () => {
    const subject = encodeURIComponent(`Join me in the studio: ${title}`);
    const body = encodeURIComponent(
      `Hi,\n\nI'd like to invite you to join my recording session "${title}".\n\nJoin here: ${link}\n\nUse Chrome or Edge on a laptop, and wear headphones if you can. No account needed.\n\nSee you soon!`
    );
    window.open(`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`, '_blank');
  };

  return (
    <Modal open={open} onClose={onClose} title="Invite guests" description="Share one link with everyone — up to 8 people per studio. Each person is recorded locally in full quality as a separate track.">
      <div className="space-y-5">
        <div>
          <label className="label" htmlFor="invite-link">Guest link</label>
          <div className="flex gap-2">
            <input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="input font-mono text-xs" />
            <Button onClick={copy} variant={copied ? 'secondary' : 'primary'}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="invite-email">Invite by email</label>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              mailto();
            }}
          >
            <input id="invite-email" type="email" className="input" placeholder="guest@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" variant="secondary">
              <Mail className="h-4 w-4" />
              Compose
            </Button>
          </form>
          <p className="mt-1.5 text-xs text-ink-faint">Opens your email app with the invite pre-filled.</p>
        </div>
      </div>
    </Modal>
  );
}
