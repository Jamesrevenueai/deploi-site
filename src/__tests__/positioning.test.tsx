import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// legalReviewed is flipped per test through this mutable mock
const envMock = vi.hoisted(() => ({ env: { appApiUrl: '', formspreeEndpoint: '', legalEntity: 'Deploi AI', legalReviewed: false, appUrl: 'https://app.example.test' } }))
vi.mock('../lib/env', () => envMock)

import Home, { PILLARS, PRODUCTS, HOME_TITLE, HOME_DESCRIPTION } from '../pages/Home'
import Legal from '../pages/Legal'
import LegalIndex from '../pages/LegalIndex'
import Signup from '../pages/Signup'
import { Footer } from '../components/Footer'
import { CTA_HREF, CTA_LABEL } from '../components/Button'
import { CORE_MESSAGE } from '../lib/site-config'

beforeEach(() => { envMock.env.legalReviewed = false })

describe('positioning', () => {
  it('leads with the core message and the three things Deploi does', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    expect(HOME_TITLE).toContain('Your business has unfinished work.')
    expect(HOME_DESCRIPTION).toContain(CORE_MESSAGE)
    expect(PILLARS.map(p => p.title)).toEqual(['Finds it', 'Handles it', 'Shows you what got done'])
    for (const p of PILLARS) expect(screen.getByRole('heading', { level: 3, name: p.title })).toBeInTheDocument()
    expect(PRODUCTS.map(p => p.name)).toEqual(['Deploi Office', 'Deploi Commerce'])
  })

  it('the call to action is the paid pilot application', () => {
    expect(CTA_LABEL).toBe('Apply for a paid pilot')
    expect(CTA_HREF).toBe('/#early-access')
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    expect(container.querySelector('#early-access form')).toHaveAccessibleName('Apply for a paid pilot')
    expect(container.textContent).toMatch(/you approve any charge/)
    expect(container.textContent).not.toMatch(/live now|generally available now/i)
  })

  it('signup sends people to the app', () => {
    render(<MemoryRouter><Signup /></MemoryRouter>)
    expect(screen.getByTestId('app-signin')).toHaveAttribute('href', 'https://app.example.test/login')
  })
})

describe('legal pages carry a DRAFT label until review', () => {
  it('shows Draft next to Terms and Privacy in the footer, on the legal index and DRAFT on the pages while unreviewed', () => {
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(container.querySelectorAll('.legal-draft-tag')).toHaveLength(2)
    expect(screen.getByText('Terms of Service')).toHaveAttribute('href', '/terms')
    render(<MemoryRouter><Legal kind="terms" /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent('DRAFT — pending legal review')
    const idx = render(<MemoryRouter><LegalIndex /></MemoryRouter>)
    expect(idx.container.querySelectorAll('.legal-draft-tag')).toHaveLength(2)
  })

  it('drops the labels when VITE_LEGAL_REVIEWED=true', () => {
    envMock.env.legalReviewed = true
    const { container } = render(<MemoryRouter><Footer /><Legal kind="privacy" /><LegalIndex /></MemoryRouter>)
    expect(container.querySelectorAll('.legal-draft-tag')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/DRAFT|pending legal review/)
  })
})
