// Re-export the shared reference data (single source of truth) plus a few
// renderer-only lookup helpers for status colors/labels.
import reference from '../../shared/reference.json'

export const SHIPMENT_STATUSES = reference.shipmentStatuses
export const BREAK_STATUSES = reference.breakStatuses
export const USER_ROLES = reference.userRoles
export const NFL_TEAMS = reference.nflTeams
export const TEAMS_PER_BREAK = reference.teamsPerBreak

/** Map a shipment status code -> its display descriptor. */
export const statusByCode = Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s.code, s]))

/** Human label for a break status code. */
export const breakStatusLabel = (code) =>
  (BREAK_STATUSES.find((b) => b.code === code) || { label: code }).label
