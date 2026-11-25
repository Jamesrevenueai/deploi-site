import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServiceBusinesses, { SERVICE_AGENTS } from '../pages/ServiceBusinesses'
import { officeSignupPayload, submitOfficeSignup, officeSignupUrl } from '../lib/office-signup'
import { env } from '../lib/env'

const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f }

describe('service businesses page (behind VITE_OFFICE_SIGNUP)', () => {
  it('is off by default', () => { expect(env.officeSignup).toBe(false) })

  it('explains each agent in plain words, for the trades, property managers and agents, and has a sign-up form', () => {
    const { container } = render(<MemoryRouter><ServiceBusinesses /></MemoryRouter>)
    const text = container.textContent ?? ''
    for (const a of ['Missed Call Agent', 'Booking Agent', 'Crew dispatcher', 'Job invoicer', 'Payment chaser']) expect(text).toContain(a)
    expect(SERVICE_AGENTS.length).toBe(6)
    expect(text).toMatch(/HVAC, construction and landscaping/)
    expect(text).toMatch(/Property managers/)
    expect(text).toMatch(/Real estate and leasing agents/)
    expect(text).not.toMatch(/guarantee|24\/7|live now/i)
    expect(screen.getByRole('form', { name: 'Sign up your business' })).toBeTruthy()
  })

  it('the form refuses missing fields and sends the app contract', async () => {
    expect(officeSignupPayload(fd({ name: 'Pat', email: 'nope', company: 'X', business: 'hvac' }))).toEqual({ error: 'Please enter a valid work email.' })
    expect(officeSignupPayload(fd({ name: 'Pat', email: 'pat@x.example', company: 'X', business: '' }))).toEqual({ error: 'Please choose what kind of business you run.' })
    const p = officeSignupPayload(fd({ name: 'Pat', email: 'pat@x.example', company: 'Cool Air', phone: '+1 (555) 010-4455', business: 'hvac', tools: ['quickbooks', 'outlook'], website: '' }))
    expect(p).toEqual({ name: 'Pat', email: 'pat@x.example', company: 'Cool Air', phone: '+15550104455', business_type: 'home_services', trade: 'hvac', tools: ['outlook', 'quickbooks'], message: undefined, website: '' })
    expect(officeSignupUrl({ appApiUrl: 'https://app.getdeploi.com' })).toBe('https://app.getdeploi.com/api/public/office-signup')
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    await submitOfficeSignup(p as Exclude<typeof p, { error: string }>, { fetchImpl, url: 'https://app.example/api/public/office-signup' })
    expect((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][0]).toBe('https://app.example/api/public/office-signup')
  })

  it('shows the field error in the page', async () => {
    render(<MemoryRouter><ServiceBusinesses /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Sign up my business' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Please enter your name.'))
  })
})
