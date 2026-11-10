export const BRAND = 'Deploi'
/** Lowercase wordmark pieces: the first word white, the second grey. */
export const WORDMARK: [string, string] = ['deploi', 'ai']
export const CONTACT_EMAIL = 'support@getdeploi.com'

/**
 * Who operates Deploi: the one place to change the legal entity or its public location (Terms, Privacy, Support,
 * footer). No street address is published; only the city.
 */
export const LEGAL = {
  entity: 'James Investments and real estate holdings LLC',
  entityType: 'an Ohio limited liability company',
  location: 'Columbus, Ohio, USA',
} as const
