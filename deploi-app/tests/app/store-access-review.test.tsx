// @vitest-environment jsdom
/**
 * The merchant's store-access card in a DOM. In App Store review mode a waiting store sees the review wording
 * (development stores only) and no invite form, because invites do not enable a store during review. In beta
 * the invite and request forms stay as they were.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { REVIEW_PENDING_REASON } from '../../lib/engine/access'

const access = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../../components/store/api', async (orig) => ({
  ...(await orig<typeof import('../../components/store/api')>()),
  storeFetch: async () => ({ ok: true, access: access.value }),
}))
import { StoreAccessCard } from '../../components/store/StoreAccess'

const base = { eligible: false, status: 'pending', basis: null, isDevelopmentStore: false, requestedAt: null, writesPaused: false }

afterEach(() => cleanup())

describe('store access card', () => {
  it('review mode: says the app is in Shopify review, development stores only, and offers no invite code', async () => {
    access.value = { ...base, mode: 'review', reason: REVIEW_PENDING_REASON }
    render(<StoreAccessCard connectionId="c1" canAct />)
    await waitFor(() => expect(screen.getByRole('heading', { name: /Deploi is in Shopify App Store review/ })).toBeTruthy())
    expect(screen.getByText(/changes are enabled on Shopify development stores only/)).toBeTruthy()
    expect(screen.queryByLabelText('Invite code')).toBeNull()
    expect(screen.queryByText(/Deploi is in beta/)).toBeNull()
  })

  it('beta mode: the invite code and request forms are unchanged', async () => {
    access.value = { ...base, mode: 'beta', reason: 'Deploi is in beta.' }
    render(<StoreAccessCard connectionId="c2" canAct />)
    await waitFor(() => expect(screen.getByRole('heading', { name: /Deploi is in beta/ })).toBeTruthy())
    expect(screen.getByLabelText('Invite code')).toBeTruthy()
  })

  it('an enabled development store in review sees no card at all', async () => {
    access.value = { ...base, mode: 'review', eligible: true, status: 'eligible', basis: 'development_store', isDevelopmentStore: true, reason: 'Enabled.' }
    const { container } = render(<StoreAccessCard connectionId="c3" canAct />)
    await new Promise(r => setTimeout(r, 50))
    expect(container.textContent).toBe('')
  })
})
