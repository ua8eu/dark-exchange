'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CircleAlert, LogOut, RefreshCw, Settings2, ShieldCheck, Wallet, X } from 'lucide-react';
import { accountRequest, useDialogFocus, type User } from './auth-modal';
import './account.css';

type Transaction = { id: string; type: 'credit' | 'withdrawal'; amount: number; createdAt: string; status: 'completed' | 'pending'; reference: string; note?: string; address?: string; network?: string };
type WalletData = { balance: number; transactions: Transaction[]; minimumWithdrawal: number; firstWithdrawal: boolean };
type Member = { id: string; email: string; verified: boolean; balance: number; createdAt: string };
type AdminData = { users: Member[]; minimumWithdrawal: number };
const money = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function AccountPanel({ user, initialTab = 'wallet', onClose, onLogout }: { user: User; initialTab?: 'wallet' | 'admin'; onClose: () => void; onLogout: () => void }) {
  const [tab, setTab] = useState<'wallet' | 'admin'>(initialTab === 'admin' && user.role === 'admin' ? 'admin' : 'wallet');
  const [wallet, setWallet] = useState<WalletData>();
  const [admin, setAdmin] = useState<AdminData>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState('ERC20');
  const [amount, setAmount] = useState('');
  const [memberId, setMemberId] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [note, setNote] = useState('');
  const [minimum, setMinimum] = useState('');
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await accountRequest<WalletData>('/api/wallet');
      setWallet(data);
      if (user.role === 'admin') {
        const adminData = await accountRequest<AdminData>('/api/admin');
        setAdmin(adminData); setMinimum(String(adminData.minimumWithdrawal));
        setMemberId(current => current || adminData.users[0]?.id || '');
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load your account.'); }
    finally { setLoading(false); }
  }, [user.role]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function mutate(url: string, body: object, success: string, method = 'POST') {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await accountRequest(url, { method, body: JSON.stringify(body) });
      setMessage(success); await refresh(); return true;
    } catch (err) { setError(err instanceof Error ? err.message : 'Please try again.'); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function withdraw(event: FormEvent) {
    event.preventDefault();
    if (await mutate('/api/wallet/withdraw', { amount: Number(amount), address, network }, 'Simulated withdrawal request created. No real assets will be sent.')) { setAmount(''); setAddress(''); }
  }
  async function credit(event: FormEvent) {
    event.preventDefault();
    if (await mutate('/api/admin/credit', { userId: memberId, amount: Number(creditAmount), note }, 'Test credit recorded. The member’s sandbox balance has been updated.')) { setCreditAmount(''); setNote(''); }
  }
  async function logout() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await accountRequest('/api/auth/logout', { method: 'POST' }); onLogout(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to log out.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const selectedMember = admin?.users.find(member => member.id === memberId);

  return <div className="account-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="account-dialog portfolio-dialog" role="dialog" aria-modal="true" aria-labelledby="portfolio-title" ref={dialogRef} tabIndex={-1}>
      <div className="portfolio-header"><div><div className="account-eyebrow">DARK EXCHANGE ACCOUNT</div><h2 id="portfolio-title">Your portfolio.</h2><p className="account-description">{user.email} <span className="account-verified"><ShieldCheck size={12} />{user.verified ? 'Email verified' : 'Email unverified'}</span></p></div><button type="button" className="account-close" onClick={onClose} aria-label="Close portfolio" data-autofocus><X size={19} /></button></div>
      <div className="portfolio-toolbar"><div className="portfolio-tabs" aria-label="Account section"><button className={tab === 'wallet' ? 'active' : ''} onClick={() => { setTab('wallet'); setError(''); setMessage(''); }}><Wallet size={15} />Wallet</button>{user.role === 'admin' && <button className={tab === 'admin' ? 'active' : ''} onClick={() => { setTab('admin'); setError(''); setMessage(''); }}><Settings2 size={15} />Admin</button>}</div><div className="account-sandbox"><span />Sandbox · no real funds</div></div>
      {error && <div className="account-message error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
      {message && <div className="account-message success" role="status"><Check size={16} /><span>{message}</span></div>}
      {loading && !wallet ? <div className="account-loading">Loading your sandbox account…</div> : tab === 'wallet' ? <>
        <div className="portfolio-balance"><div><div className="account-eyebrow">AVAILABLE SANDBOX BALANCE</div><div className="portfolio-number">{wallet ? money(wallet.balance) : '—'}<span>TEST USDT</span></div><p>Simulated assets. Pending withdrawals are deducted from this balance.</p></div><button type="button" className="account-secondary account-refresh" onClick={() => { setError(''); void refresh(); }} disabled={loading || busy} aria-label="Refresh wallet"><RefreshCw size={16} className={loading ? 'account-spinning' : ''} /></button></div>
        <div className="portfolio-grid"><div className="portfolio-withdraw"><div className="account-section-heading"><h3>Request a withdrawal</h3><ArrowUpRight size={18} /></div><p className="account-caption">Preview a withdrawal using your sandbox balance.</p><form className="account-form" onSubmit={withdraw}>
          <label>Network<select disabled={busy} value={network} onChange={event => setNetwork(event.target.value)}><option value="ERC20">Ethereum (ERC-20)</option><option value="TRC20">Tron (TRC-20)</option><option value="BEP20">BNB Smart Chain (BEP-20)</option><option value="SOL">Solana</option></select></label>
          <label>Wallet address<input name="wallet-address" disabled={busy} value={address} onChange={event => setAddress(event.target.value)} placeholder="20–160 characters, without spaces" required minLength={20} maxLength={160} pattern="\S{20,160}" autoComplete="off" /></label>
          <label>Amount<div className="account-input-wrap"><input type="number" disabled={busy} min="0.01" max="100000000" step="0.01" required placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} /><span className="account-input-unit">TEST USDT</span></div></label>
          <div className="account-withdraw-rule"><CircleAlert size={15} /><span>{!wallet ? 'Load your wallet to view the withdrawal requirements.' : wallet.firstWithdrawal ? <>First withdrawal minimum: <strong>{money(wallet.minimumWithdrawal)} TEST USDT</strong>.</> : 'First withdrawal requirement has been satisfied.'} No additional deposit is required.</span></div>
          <button className="account-primary" type="submit" disabled={busy || !wallet || !user.verified}>{busy ? 'Please wait…' : 'Request simulated withdrawal'}<ArrowRight size={17} /></button>
        </form></div><div className="portfolio-ledger"><div className="account-section-heading"><h3>Activity</h3><span className="account-mini-badge">DEMO LEDGER</span></div><p className="account-caption">Admin test credits and simulated withdrawals.</p>{!wallet?.transactions.length ? <div className="account-empty"><Wallet size={28} /><h4>A clean slate.</h4><p>Your sandbox transactions will appear here.</p></div> : <div className="account-transactions">{wallet.transactions.map(transaction => <div className="account-transaction" key={transaction.id}><div className={`account-transaction-icon ${transaction.type}`} >{transaction.type === 'credit' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</div><div className="account-transaction-info"><strong>{transaction.type === 'credit' ? 'Admin test credit' : 'Simulated withdrawal'}</strong><span>{new Date(transaction.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {transaction.status}</span>{transaction.note && <p>{transaction.note}</p>}<span className="account-reference" title={transaction.reference}>{transaction.reference}</span>{transaction.address && <span className="account-reference" title={transaction.address}>To {transaction.address}</span>}</div><strong className={transaction.type === 'credit' ? 'account-amount-positive' : 'account-amount-negative'}>{transaction.type === 'credit' ? '+' : '−'}{money(transaction.amount)}<span>TEST USDT</span></strong></div>)}</div>}</div></div>
      </> : <div className="portfolio-grid admin-grid"><div><div className="account-section-heading"><h3>Credit a member</h3><ShieldCheck size={18} /></div><p className="account-caption">Add a clearly marked test credit to a sandbox account.</p><form className="account-form" onSubmit={credit}>
        <label>Member<select required disabled={busy} value={memberId} onChange={event => setMemberId(event.target.value)}><option value="" disabled>Select a member</option>{admin?.users.map(member => <option key={member.id} value={member.id}>{member.email}{member.verified ? '' : ' · unverified'}</option>)}</select></label>
        {selectedMember && <div className="account-member-balance"><span>Current sandbox balance</span><strong>{money(selectedMember.balance)} TEST USDT</strong></div>}
        <label>Credit amount<div className="account-input-wrap"><input type="number" disabled={busy} min="0.01" max="100000000" step="0.01" required value={creditAmount} onChange={event => setCreditAmount(event.target.value)} placeholder="0.00" /><span className="account-input-unit">TEST USDT</span></div></label>
        <label>Ledger note<input disabled={busy} value={note} onChange={event => setNote(event.target.value)} maxLength={240} placeholder="e.g. Sandbox account allocation" /></label>
        <button className="account-primary" type="submit" disabled={busy || !memberId}>{busy ? 'Please wait…' : 'Record test credit'}<ArrowRight size={17} /></button>
      </form></div><div><div className="account-section-heading"><h3>Withdrawal settings</h3><Settings2 size={18} /></div><p className="account-caption">The minimum is shown to members before their first simulated withdrawal.</p><form className="account-form" onSubmit={event => { event.preventDefault(); void mutate('/api/admin/settings', { minimumWithdrawal: Number(minimum) }, 'First withdrawal minimum updated.', 'PATCH'); }}><label>First withdrawal minimum<div className="account-input-wrap"><input type="number" disabled={busy} min="0" max="100000000" step="0.01" required value={minimum} onChange={event => setMinimum(event.target.value)} /><span className="account-input-unit">TEST USDT</span></div></label><button type="submit" className="account-secondary" disabled={busy}>Save settings<Check size={15} /></button></form><div className="admin-explainer"><div className="account-mini-badge">SANDBOX ADMIN</div><p>Credits update the internal demo ledger only. They do not represent a blockchain transfer or a real deposit.</p><p>Withdrawal requests never require users to deposit additional funds.</p><span>{admin?.users.length ?? 0} registered members</span></div></div></div>}
      <div className="portfolio-footer"><span>All balances are simulated. No custody of real assets.</span><button type="button" onClick={logout} disabled={busy}><LogOut size={14} />Log out</button></div>
    </div>
  </div>;
}
