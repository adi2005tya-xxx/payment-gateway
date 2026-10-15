'use client';
import { useState } from 'react';
import { Button, Notice } from './ui';

/** Shows freshly generated recovery codes once; the user must confirm they stored them before continuing. */
export function RecoveryCodesPanel({ codes, onDone, doneLabel = 'Continue' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Gateway recovery codes (each works once)\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gateway-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div>
      <Notice tone="amber">Store them offline (password manager or printed). Anyone with a code and your password can sign in.</Notice>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-3 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button variant="secondary" onClick={download}>Download</Button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes somewhere safe.</label>
      <Button className="mt-4 w-full" disabled={!saved} onClick={onDone}>{doneLabel}</Button>
    </div>
  );
}
