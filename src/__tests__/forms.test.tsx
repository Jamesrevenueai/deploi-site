import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The form reads the lead target from env at render time; point it at a stub API.
vi.mock('../lib/env', () => ({
  env: { appApiUrl: 'https://app.test', formspreeEndpoint: '', legalEntity: 'Deploi AI', legalReviewed: false },
}))

import { EarlyAccessForm } from '../components/EarlyAccessForm'

const CTA = 'Apply for Early Access'

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function renderForm() {
  return render(<MemoryRouter><EarlyAccessForm /></MemoryRouter>)
}

function fillRequired() {
  fill('Name', 'Pat Example')
  fill('Work email', 'pat@example-store.test')
  fill('Store or company name', 'Example Store')
  fill('Store URL', 'https://example-store.test')
}

describe('EarlyAccessForm', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('renders the fields, pre-checks Shopify, and has no password input', () => {
    const { container } = renderForm()
    expect(screen.getByRole('form', { name: CTA })).toBeInTheDocument()
    expect(screen.getByLabelText('Store URL')).toHaveAttribute('type', 'url')
    expect(screen.getByRole('checkbox', { name: 'Shopify' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /WooCommerce/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Amazon Seller Central/ })).not.toBeChecked()
    expect(screen.getByLabelText(/Approximate number of products/)).toBeInTheDocument()
    expect(screen.getByLabelText(/stock or listing problem/)).toBeInTheDocument()
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(container.querySelector('input[name="website"]')).not.toBeNull() // honeypot kept
    expect(container.textContent).toContain('Never send passwords or API keys through this form.')
  })

  it('rejects a store URL without http(s) and does not post', async () => {
    renderForm()
    fillRequired()
    fill('Store URL', 'example-store.test')
    fireEvent.click(screen.getByRole('button', { name: CTA }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/http:\/\/ or https:\/\//)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires at least one platform and does not post', async () => {
    renderForm()
    fillRequired()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shopify' }))
    fireEvent.click(screen.getByRole('button', { name: CTA }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one platform/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts exactly the payload contract and shows the success state', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'lead_ea1' }), { status: 200 }))
    renderForm()
    fillRequired()
    fireEvent.click(screen.getByRole('checkbox', { name: /WooCommerce/ }))
    fill(/Approximate number of products/, '1000_10000')
    fill(/stock or listing problem/, 'Variants keep selling after they run out')
    fireEvent.click(screen.getByRole('button', { name: CTA }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Application received.'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.test/api/public/lead')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Pat Example',
      email: 'pat@example-store.test',
      agency_name: 'Example Store',
      source: 'site',
      service_interest: 'early_access',
      store_url: 'https://example-store.test',
      platforms: ['shopify', 'woocommerce'],
      catalog_size: '1000_10000',
      message: 'Variants keep selling after they run out',
      website: '',
    })
  })

  it('omits the optional fields when they are left empty', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    renderForm()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: CTA }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(Object.keys(body).sort()).toEqual(['agency_name', 'email', 'name', 'platforms', 'service_interest', 'source', 'store_url', 'website'])
    expect(body.platforms).toEqual(['shopify'])
  })

  it('shows the server error and stays editable when the API fails', async () => {
    fetchMock.mockResolvedValue(new Response('could not save lead', { status: 500 }))
    renderForm()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: CTA }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not save lead')
    expect(screen.getByRole('button', { name: CTA })).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
