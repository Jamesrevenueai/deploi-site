'use client'

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="au-switch" disabled={disabled} onClick={() => onChange(!on)} />
}
