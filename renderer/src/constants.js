// Re-export the shared reference data (single source of truth) plus a few
// renderer-only lookup helpers for status colors/labels.
import reference from '../../shared/reference.json'

export const SHIPMENT_STATUSES = reference.shipmentStatuses
export const BREAK_STATUSES = reference.breakStatuses
export const ORDER_STAGES = reference.orderStages
export const USER_ROLES = reference.userRoles
export const NFL_TEAMS = reference.nflTeams
export const TEAMS_PER_BREAK = reference.teamsPerBreak

/** Map a shipment status code -> its display descriptor. */
export const statusByCode = Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s.code, s]))

/** Map an order stage code -> its display descriptor. */
export const stageByCode = Object.fromEntries(ORDER_STAGES.map((s) => [s.code, s]))

/** The linear pipeline stages (excludes the exception/returned side-states). */
export const PIPELINE_STAGES = ORDER_STAGES.filter((s) => ['to_pick', 'put_together', 'sent', 'all_good'].includes(s.code))

/** Human label for a break status code. */
export const breakStatusLabel = (code) =>
  (BREAK_STATUSES.find((b) => b.code === code) || { label: code }).label
