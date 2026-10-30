/** Errors the library raises; the API maps each code to an HTTP status (lib/store/request.ts does the same for engine errors). */
export type LibraryErrorCode = 'upgrade_required' | 'needs_setup' | 'not_found' | 'forbidden' | 'invalid_input' | 'not_wired' | 'conflict' | 'allowance_exhausted'

export class LibraryError extends Error {
  constructor(public code: LibraryErrorCode, message: string, public detail: Record<string, unknown> = {}) { super(message); this.name = 'LibraryError' }
}
export const isLibraryError = (e: unknown): e is LibraryError => e instanceof LibraryError

export const LIBRARY_STATUS: Record<LibraryErrorCode, number> = {
  upgrade_required: 402, needs_setup: 409, not_found: 404, forbidden: 403, invalid_input: 400, not_wired: 501, conflict: 409, allowance_exhausted: 402,
}
