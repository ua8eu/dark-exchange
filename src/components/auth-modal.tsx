'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowRight, Check, CircleAlert, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, X } from 'lucide-react';
import './account.css';

export type User = { id: string; email: string; role: 'user' | 'admin'; verified: boolean };

export function useDialogFocus(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = ref.current;
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';
    const initial = dialog?.querySelector<HTMLElement>('[data-autofocus]') || dialog;
    initial?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter(item => item.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    function containFocus(event: FocusEvent) {
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        (dialog.querySelector<HTMLElement>(selector) || dialog).focus();
      }
    }
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => { document.body.style.overflow = originalOverflow; document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', containFocus); if (previous?.isConnected) previous.focus(); };
  }, [ref]);
}

export async function accountRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, cache: 'no-store', credentials: 'same-origin', headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Something went wrong. Please try again.');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The server returned an unexpected response. Please try again.');
  return result as T;
}

export default function AuthModal({ initialMode = 'register', onClose, onAuthenticated }: { initialMode?: 'login' | 'register'; onClose: () => void; onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [verificationUrl, setVerificationUrl] = useState<string>();
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);

  function changeMode(next: 'login' | 'register') { setMode(next); setError(''); setSuccess(''); setVerificationUrl(undefined); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      if (mode === 'login') {
        const data = await accountRequest<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        onAuthenticated(data.user);
      } else {
        const data = await accountRequest<{ verificationUrl?: string; emailDelivery: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
        setVerificationUrl(data.verificationUrl);
        setSuccess(data.emailDelivery === 'local-preview' ? 'Your account is ready to verify. Open the development inbox preview below.' : 'Check your inbox. We sent a confirmation link to your email address.');
        setPassword(''); setMode('login');
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Please try again.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function resend() {
    if (inFlight.current) return;
    if (!email.trim()) { setError('Enter your email address first.'); return; }
    inFlight.current = true; setBusy(true); setError(''); setSuccess(''); setVerificationUrl(undefined);
    try {
      const data = await accountRequest<{ verificationUrl?: string }>('/api/auth/resend', { method: 'POST', body: JSON.stringify({ email }) });
      if (data.verificationUrl) setVerificationUrl(data.verificationUrl);
      setSuccess(data.verificationUrl ? 'A new verification link is ready in the development inbox preview below.' : 'If this address has an unverified account, we sent a new confirmation link. Please check your inbox.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Please try again.'); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <div className="account-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="account-dialog auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" ref={dialogRef} tabIndex={-1}>
      <button type="button" className="account-close" onClick={onClose} aria-label="Close account dialog"><X size={19} /></button>
      <div className="auth-mark"><ShieldCheck size={25} /></div>
      <div className="account-eyebrow">DARK EXCHANGE ACCOUNT</div>
      <h2 id="auth-title">{mode === 'register' ? 'A world of possibility.' : 'Welcome back.'}</h2>
      <p className="account-description">{mode === 'register' ? 'Create your dark-exchange.com account. Verify your email to explore the sandbox.' : 'Sign in to your dark-exchange.com sandbox account.'}</p>
      <div className="account-mode-tabs" aria-label="Authentication mode">
        <button type="button" disabled={busy} aria-pressed={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => changeMode('register')}>Create account</button>
        <button type="button" disabled={busy} aria-pressed={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')}>Log in</button>
      </div>
      <form onSubmit={submit} className="account-form" aria-busy={busy}>
        <label>Email address<div className="account-input-wrap"><Mail size={17} /><input type="email" name="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} disabled={busy} data-autofocus value={email} onChange={event => { setEmail(event.target.value); setVerificationUrl(undefined); setSuccess(''); }} /></div></label>
        <label>Password<div className="account-input-wrap"><LockKeyhole size={17} /><input name="password" type={visible ? 'text' : 'password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={12} maxLength={128} disabled={busy} placeholder={mode === 'register' ? 'At least 12 characters' : 'Enter your password'} required value={password} onChange={event => setPassword(event.target.value)} /><button type="button" className="account-input-action" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        {error && <div className="account-message error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
        {success && <div className="account-message success" role="status"><Check size={16} /><span>{success}</span></div>}
        {verificationUrl && <a className="account-preview-link" href={verificationUrl}>Development inbox preview · verify email <ArrowRight size={15} /></a>}
        <button className="account-primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Log in'}<ArrowRight size={17} /></button>
      </form>
      <button type="button" className="account-text-button" onClick={resend} disabled={busy}>Resend verification email</button>
      {(success || verificationUrl) && <p className="auth-email-note">Confirmation links expire after 24 hours and can be used once. Check your spam folder if an email has not arrived.</p>}
      <div className="account-sandbox"><span /> Sandbox · no real funds</div>
      <p className="auth-footnote">A demonstration environment. Balances and transactions are simulated.</p>
    </div>
  </div>;
}
