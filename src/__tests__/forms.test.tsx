import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The forms read the lead target from env at render time; point it at a stub API.
vi.mock('../lib/env', () => ({
  env: { appApiUrl: 'https://app.test', bookingUrl: '', formspreeEndpoint: '', legalEntity: 'Deploi AI', legalReviewed: false },
}))

import { WebsiteForm, websitePayload } from '../components/WebsiteForm'
import { LeadForm } from '../components/LeadForm'

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function fillWebsiteForm() {
  fill('Name', 'Pat Example')
  fill('Work email', 'pat@example-agency.test')
  fill('Practice or agency name', 'Example Home Care')
  fill('Website URL', 'https://example-agency.test')
  fill('Website platform', 'WordPress')
  fill('Main business goal', 'More private-pay inquiries')
  fill('Page 1 to improve', 'Home')
  fill('Page 2 to improve', '   ')
  fill('Requested changes', 'Make the services page clearer')
  fill('Access status', 'need_to_find')
  fill(/Approval contact name/, 'Sam Approver')
  fill(/Approval contact email/, 'sam@example-agency.test')
}

describe('WebsiteForm', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows a validation message and does not post when the URL is not http(s)', async () => {
    render(<MemoryRouter><WebsiteForm /></MemoryRouter>)
    fillWebsiteForm()
    fill('Website URL', 'example-agency.test')
    fireEvent.click(screen.getByRole('button', { name: 'Request website improvements' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/http:\/\/ or https:\/\//)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the platform select', async () => {
    render(<MemoryRouter><WebsiteForm /></MemoryRouter>)
    fillWebsiteForm()
    fill('Website platform', '')
    fireEvent.click(screen.getByRole('button', { name: 'Request website improvements' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/platform/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the mapped payload to the lead API and shows the success state', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'lead_w1' }), { status: 200 }))
    render(<MemoryRouter><WebsiteForm /></MemoryRouter>)
    fillWebsiteForm()
    fireEvent.click(screen.getByRole('button', { name: 'Request website improvements' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Request received.'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/public/lead')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      source: 'site',
      service_interest: 'website_improvement',
      name: 'Pat Example',
      email: 'pat@example-agency.test',
      agency_name: 'Example Home Care',
      website_url: 'https://example-agency.test',
      website_platform: 'WordPress',
      website_goal: 'More private-pay inquiries',
      website_pages: ['Home'],
      website_changes: 'Make the services page clearer',
      access_status: 'need_to_find',
      approval_contact: 'Sam Approver <sam@example-agency.test>',
    })
    expect(body.message).toContain('Approval contact: Sam Approver <sam@example-agency.test>')
    expect(body.website).toBeUndefined() // honeypot untouched
    expect(JSON.stringify(body)).not.toMatch(/password/i)
  })

  it('shows the server error and stays editable when the API fails', async () => {
    fetchMock.mockResolvedValue(new Response('could not save lead', { status: 500 }))
    render(<MemoryRouter><WebsiteForm /></MemoryRouter>)
    fillWebsiteForm()
    fireEvent.click(screen.getByRole('button', { name: 'Request website improvements' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not save lead')
    expect(screen.getByRole('button', { name: 'Request website improvements' })).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('maps FormData without a password key and caps pages at three', () => {
    const fd = new FormData()
    for (const [k, v] of Object.entries({ name: 'A', email: 'a@b.co', agency_name: 'X', website_url: 'https://x.test', website_platform: 'Wix', website_goal: 'g', page_1: 'a', page_2: '', page_3: 'c', website_changes: 'c', access_status: 'unknown' })) fd.set(k, v)
    const p = websitePayload(fd)
    expect(p.website_pages).toEqual(['a', 'c'])
    expect(p.approval_contact).toBeUndefined()
    expect(Object.keys(p).some(k => /password/i.test(k))).toBe(false)
  })
})

describe('LeadForm', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('validates before posting', async () => {
    render(<MemoryRouter><LeadForm source="site" /></MemoryRouter>)
    fill('Name', 'Pat')
    fill('Work email', 'not-an-email')
    fill('Agency or practice', 'Example Home Care')
    fireEvent.click(screen.getByRole('button', { name: 'Request a discovery conversation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid email/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts and confirms', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'lead_1' }), { status: 200 }))
    render(<MemoryRouter><LeadForm source="site" /></MemoryRouter>)
    fill('Name', 'Pat')
    fill('Work email', 'pat@example-agency.test')
    fill('Agency or practice', 'Example Home Care')
    fireEvent.click(screen.getByRole('button', { name: 'Request a discovery conversation' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Got it.'))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ source: 'site', name: 'Pat', agency_name: 'Example Home Care' })
    expect(body.website).toBeUndefined()
  })

  it('shows an error state on a failed post', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    render(<MemoryRouter><LeadForm source="evv-page" cta="Request early access" /></MemoryRouter>)
    fill('Name', 'Pat')
    fill('Work email', 'pat@example-agency.test')
    fill('Agency or practice', 'Example Home Care')
    fireEvent.click(screen.getByRole('button', { name: 'Request early access' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('nope')
  })
})
