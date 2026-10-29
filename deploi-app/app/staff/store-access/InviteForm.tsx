'use client'
import { useActionState } from 'react'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Field'
import { createInviteAction, type InviteState } from './actions'

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInviteAction, {})
  return (
    <form action={action} className="card p-5 flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Who it is for" htmlFor="inv-label"><Input id="inv-label" name="label" required maxLength={120} placeholder="Merchant or reviewer" /></Field>
        <Field label="Only this shop (optional)" htmlFor="inv-shop"><Input id="inv-shop" name="shop" placeholder="store.myshopify.com" /></Field>
        <Field label="Valid for (days)" htmlFor="inv-days"><Input id="inv-days" name="days" type="number" min={1} max={180} defaultValue={30} /></Field>
        <Field label="Uses" htmlFor="inv-uses"><Input id="inv-uses" name="max_uses" type="number" min={1} max={100} defaultValue={1} /></Field>
      </div>
      <div><Button size="sm" type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create invite code'}</Button></div>
      {state.error && <p className="text-[14px] text-danger" role="alert">{state.error}</p>}
      {state.code && (
        <div role="status" className="text-[14px]">
          Invite for <strong>{state.label}</strong>: <code className="select-all text-ink">{state.code}</code>
          <div className="text-grey-h text-[13px]">Copy it now. It is stored only as a hash and cannot be shown again.</div>
        </div>
      )}
    </form>
  )
}
