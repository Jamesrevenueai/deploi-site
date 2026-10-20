export const STAGES = ['new','contacted','replied','call_booked','call_held','assessment_sold','build_sold','retainer','lost'] as const
export type Stage = typeof STAGES[number]
export const STAGE_LABEL: Record<Stage, string> = {
  new: 'New', contacted: 'Contacted', replied: 'Replied', call_booked: 'Call booked', call_held: 'Call held',
  assessment_sold: 'Assessment sold', build_sold: 'Build sold', retainer: 'Retainer', lost: 'Lost',
}
export const PROGRAMS = ['PASSPORT', 'OHCW', 'MyCare', 'DODD', 'private-pay'] as const
export const HELD_STAGES: Stage[] = ['call_held', 'assessment_sold', 'build_sold', 'retainer']
export const stageIndex = (s: string) => STAGES.indexOf(s as Stage)
export const isStage = (s: unknown): s is Stage => typeof s === 'string' && STAGES.includes(s as Stage)
/** true when `candidate` is further along the funnel than `current` (lost never counts as "further"). */
export function advances(current: string, candidate: Stage) {
  if (candidate === 'lost') return current !== 'lost'
  if (current === 'lost') return false
  return stageIndex(candidate) > stageIndex(current)
}
