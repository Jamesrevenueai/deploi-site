import Link from 'next/link'
import type { Proof } from '@/lib/app/contract'

/** The proof of a finished piece of work, as a chip linking to the proof itself (the case, the report, the log). */
export function ProofChip({ proof, context }: { proof: Proof; context?: string }) {
  return (
    <Link href={proof.href} className="app-proof" aria-label={context ? `Proof: ${proof.label}, ${context}` : `Proof: ${proof.label}`}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5" /></svg>
      {proof.label}
    </Link>
  )
}
