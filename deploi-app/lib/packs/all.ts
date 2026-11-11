/**
 * Every agent pack, imported once. Importing a pack registers its event handlers (lib/events), its agents in the
 * pack registry (lib/packs/registry.ts) and its undo kinds (lib/undo). The event jobs (lib/events/agents.ts) and the
 * Shopify embedded gating (lib/shopify/embedded.ts) import this file, so both see the same packs.
 */
import '../commerce/pack'
import './index'
