/**
 * The store API side of embedded-app gating (lib/shopify/embedded.ts). A request authenticated with a
 * Shopify session token comes from inside the Shopify admin, so it may use only what the embedded app
 * shows; anything hidden answers 404 exactly as if it did not exist. Requests from the Deploi web app
 * (session cookie) are never affected.
 */
import type { Actor } from '../engine/actor'
import { HttpError } from './request'
import { isEmbeddedFeatureReady, isEmbeddedTemplate, isShopifyLibraryAgent, type EmbeddedFeatureKey } from '../shopify/embedded'

export const fromShopifyAdmin = (actor: Actor) => actor.kind === 'shopify_user'

const hidden = () => new HttpError(404, 'not_found', 'not found')

/** Refuse a hidden feature to a Shopify session (404). */
export function assertEmbeddedFeature(actor: Actor, key: EmbeddedFeatureKey) {
  if (fromShopifyAdmin(actor) && !isEmbeddedFeatureReady(key)) throw hidden()
}

/** Refuse a library agent that is not shown inside Shopify (404). */
export function assertEmbeddedLibraryAgent(actor: Actor, key: string) {
  if (!fromShopifyAdmin(actor)) return
  assertEmbeddedFeature(actor, 'team')
  if (!isShopifyLibraryAgent(key)) throw hidden()
}

/** Refuse an engine template that is not offered inside Shopify (404). */
export function assertEmbeddedTemplate(actor: Actor, key: string) {
  if (fromShopifyAdmin(actor) && !isEmbeddedTemplate(key)) throw hidden()
}

/** Templates to list for this actor. */
export function templatesFor<T extends { key: string }>(actor: Actor, all: readonly T[]): T[] {
  return fromShopifyAdmin(actor) ? all.filter(t => isEmbeddedTemplate(t.key)) : [...all]
}

/** A feature that exists only for hidden templates (purchase orders, competitor checks): 404 for a Shopify session. */
export function assertNotEmbedded(actor: Actor) {
  if (fromShopifyAdmin(actor)) throw hidden()
}
