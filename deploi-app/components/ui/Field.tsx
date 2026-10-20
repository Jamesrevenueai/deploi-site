import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react'

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="input" {...props} /> }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select className="select" {...props} /> }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className="textarea" {...props} /> }
