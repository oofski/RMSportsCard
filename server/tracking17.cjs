// =============================================================================
// 17TRACK tracking provider for RM Cardz (track-by-number; no Mailer ID)
// -----------------------------------------------------------------------------
// This module is the reliable replacement for the old USPS web-scrape, used when
// a user pastes a free 17TRACK API key into settings. The Electron MAIN process
// imports this file and calls `fetch17TrackStatuses(...)`; the renderer never
// touches it. It speaks the 17TRACK v2.4 REST API:
//
//   POST https://api.17track.net/track/v2.4/register      (body: [{number, carrier}])
//   POST https://api.17track.net/track/v2.4/gettrackinfo  (body: [{number}])
//
// Every request carries the user's key in the `17token` header. We batch in
// groups of 40 (a single register/gettrackinfo call's practical max), register
// each batch under USPS (carrier code 21051), then read back the latest status
// and translate it via map17TrackStatus into one of our shipment status codes.
//
// CONTRACT (see fetch17TrackStatuses below) — this function must NEVER throw.
// All errors (no key, auth/rate limits, rejected numbers, parse failures,
// network blips) are folded into the returned `stats` so the caller can render
// a summary without try/catch of its own.
// =============================================================================

const { map17TrackStatus } = require('./tracking17map.cjs')

// --- Constants ---------------------------------------------------------------

// API base; endpoints are appended (e.g. BASE_URL + 'register').
const BASE_URL = 'https://api.17track.net/track/v2.4/'

// 17TRACK's carrier code for USPS. Passed on register so the carrier isn't
// auto-detected (which can be slow/ambiguous for some USPS number formats).
const USPS_CARRIER = 21051

// Max tracking numbers per register/gettrackinfo request.
const BATCH_SIZE = 40

// 17TRACK rejects a re-register of an already-tracked number with this code.
// It is NOT a real error for us — the number is already in their system, which
// is exactly what we want — so we ignore it.
const ALREADY_REGISTERED = -18019979

// --- HTTP helper -------------------------------------------------------------

/**
 * POST a JSON body to a 17TRACK endpoint and return the parsed response.
 *
 * @param {string} endpoint  Path under BASE_URL, e.g. 'register' or 'gettrackinfo'.
 * @param {*}      body      JSON-serializable payload (17TRACK expects an array).
 * @param {string} apiKey    The user's 17TRACK API token.
 * @returns {Promise<{ ok: boolean, status: number, json: any }>}
 *          `ok`/`status` mirror the HTTP response; `json` is the parsed body
 *          (or null if the body wasn't valid JSON). This helper itself does not
 *          throw on non-2xx — it only throws on a true network failure, which
 *          the caller wraps in try/catch.
 */
async function postJson(endpoint, body, apiKey) {
  // global fetch (Node 22). No external HTTP dependency by design.
  const res = await fetch(BASE_URL + endpoint, {
    method: 'POST',
    headers: {
      // 17TRACK authenticates via this custom header, not Authorization.
      '17token': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  // Be defensive: a body might be empty or non-JSON (e.g. an HTML error page
  // from an upstream proxy). Never let that bubble up as a throw here.
  let json = null
  try {
    json = await res.json()
  } catch (_e) {
    json = null
  }

  return { ok: res.ok, status: res.status, json }
}

/**
 * Decide whether a response represents an authentication / rate-limit problem,
 * which we classify as "blocked" (the key is bad, expired, or throttled) rather
 * than "failed". Looks at both the HTTP status and 17TRACK's top-level `code`.
 *
 * 17TRACK returns HTTP 200 with an error object even for auth issues, so we
 * can't rely on HTTP status alone.
 *
 * @param {number} httpStatus  HTTP status code.
 * @param {any}    json        Parsed response body (may be null).
 * @returns {boolean}
 */
function isAuthOrRateError(httpStatus, json) {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) return true

  // Top-level code: 0 means OK. Non-zero is some kind of API-level error.
  const code = json && json.code
  if (code == null || code === 0) return false

  // 17TRACK's documented auth/quota error codes. We match on the well-known
  // ones and also treat the textual hint defensively in case codes drift.
  const AUTH_CODES = new Set([
    -18010012, // The 17token is wrong / not provided.
    -18010013, // Account is suspended.
    -18019901, // The account has been deactivated.
    -18019902, // Reached the maximum number of tracking quota.
    -18019903, // Reached the maximum tracking quota for the day.
  ])
  if (AUTH_CODES.has(code)) return true

  const msg = String((json && json.message) || (json && json.data && json.data.errors) || '')
    .toLowerCase()
  if (/token|unauthor|forbidden|quota|rate limit|too many|suspend|deactiv/.test(msg)) {
    return true
  }

  return false
}

// --- Main entry point --------------------------------------------------------

/**
 * Read USPS tracking statuses for a set of shipments via the 17TRACK API.
 *
 * NEVER throws. All failure modes are reported through `stats`.
 *
 * @param {object}   params
 * @param {Array<{trackingNumber?: string}>} params.shipments
 *        Shipment objects; only those with a truthy `.trackingNumber` are read.
 * @param {(p: { done: number, total: number, trackingNumber: string, code: (string|null) }) => void} [params.onProgress]
 *        Optional progress callback, invoked once per tracking number processed.
 * @param {string}   params.apiKey  The user's 17TRACK API token.
 * @returns {Promise<{
 *   map: Object<string, string>,
 *   stats: { scanned: number, read: number, blocked: number, failed: number }
 * }>}
 *   - `map`: trackingNumber -> our status code, for SUCCESSFULLY-read numbers only.
 *   - `stats.scanned`: # of shipments that had a tracking number.
 *   - `stats.read`:    # of numbers we mapped into `map`.
 *   - `stats.blocked`: # of numbers we couldn't read due to auth / rate limits.
 *   - `stats.failed`:  # of numbers rejected by the API, or lost to parse/network errors.
 */
async function fetch17TrackStatuses({ shipments, onProgress, apiKey } = {}) {
  const map = {}
  const stats = { scanned: 0, read: 0, blocked: 0, failed: 0 }

  // Collect the tracking numbers we actually have. Coerce to string and trim so
  // we don't register blank/whitespace junk. De-dupe is intentionally NOT done
  // here so `scanned` reflects the caller's shipment list faithfully; the API
  // tolerates duplicates within a batch.
  const numbers = []
  for (const s of Array.isArray(shipments) ? shipments : []) {
    const tn = s && s.trackingNumber != null ? String(s.trackingNumber).trim() : ''
    if (tn) numbers.push(tn)
  }
  stats.scanned = numbers.length

  // A safe progress emitter — a throwing onProgress must not break a batch run.
  const total = numbers.length
  let done = 0
  const emit = (trackingNumber, code) => {
    done += 1
    if (typeof onProgress === 'function') {
      try {
        onProgress({ done, total, trackingNumber, code })
      } catch (_e) {
        /* swallow: progress reporting is best-effort */
      }
    }
  }

  // No key => we can't talk to 17TRACK at all. Per the contract, treat the whole
  // set as "blocked" (the user simply hasn't configured a key).
  if (!apiKey) {
    stats.blocked = numbers.length
    // Still emit progress so any UI completes its bar.
    for (const tn of numbers) emit(tn, null)
    return { map, stats }
  }

  if (numbers.length === 0) {
    return { map, stats }
  }

  // Process in batches of BATCH_SIZE.
  for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
    const batch = numbers.slice(i, i + BATCH_SIZE)

    try {
      // (a) register — tell 17TRACK to start tracking each number as USPS.
      //     "Already registered" rejections are fine and ignored. We don't even
      //     need to inspect register's accepted/rejected lists for success;
      //     gettrackinfo is the source of truth. But we DO check register for
      //     hard auth/rate errors so we can short-circuit the batch.
      const reg = await postJson(
        'register',
        batch.map((number) => ({ number, carrier: USPS_CARRIER })),
        apiKey
      )

      if (isAuthOrRateError(reg.status, reg.json)) {
        // Key is bad or we're throttled: this batch's numbers are blocked.
        for (const tn of batch) {
          stats.blocked += 1
          emit(tn, null)
        }
        continue
      }

      // (b) gettrackinfo — read back the latest status for each number.
      const info = await postJson(
        'gettrackinfo',
        batch.map((number) => ({ number })),
        apiKey
      )

      if (isAuthOrRateError(info.status, info.json)) {
        for (const tn of batch) {
          stats.blocked += 1
          emit(tn, null)
        }
        continue
      }

      // A non-auth, non-zero top-level code (or unparseable body) means the
      // whole batch's response is unusable — count as failed.
      const topCode = info.json && info.json.code
      if (info.json == null || (topCode != null && topCode !== 0)) {
        for (const tn of batch) {
          stats.failed += 1
          emit(tn, null)
        }
        continue
      }

      // (c) Parse data.accepted (good reads) and data.rejected (bad numbers).
      const data = (info.json && info.json.data) || {}
      const accepted = Array.isArray(data.accepted) ? data.accepted : []
      const rejected = Array.isArray(data.rejected) ? data.rejected : []

      // Build a quick lookup of accepted items by their tracking number so we
      // can attribute results back to the batch order and detect any numbers
      // the API silently dropped.
      const seen = new Set()

      for (const item of accepted) {
        // Defensive optional chaining throughout — the shape varies by version.
        const number = item && item.number != null ? String(item.number) : null
        if (!number) {
          // Can't attribute this to a tracking number; treat as a failed read.
          stats.failed += 1
          continue
        }
        seen.add(number)

        const latest =
          item &&
          item.track_info &&
          item.track_info.latest_status
        const status = latest && latest.status
        const subStatus = latest && latest.sub_status

        const code = map17TrackStatus(status, subStatus)
        if (code) {
          map[number] = code
          stats.read += 1
        }
        // If code is null we simply don't put it in the map (unknown/NotFound);
        // it is neither a read nor a failure — just no actionable status yet.

        emit(number, code || null)
      }

      // Rejected numbers are failures (bad format, unsupported, etc.).
      for (const item of rejected) {
        const number =
          item && item.number != null
            ? String(item.number)
            : null
        stats.failed += 1
        if (number) seen.add(number)
        emit(number || '', null)
      }

      // Any batch number that appeared in neither accepted nor rejected got
      // dropped by the API — account for it as failed and emit progress so the
      // done/total tally stays consistent.
      for (const tn of batch) {
        if (!seen.has(tn)) {
          stats.failed += 1
          emit(tn, null)
        }
      }
    } catch (_e) {
      // True network error (DNS, TLS, socket) for this batch — count as failed.
      for (const tn of batch) {
        stats.failed += 1
        emit(tn, null)
      }
      // Continue to the next batch rather than aborting the whole run.
      continue
    }
  }

  return { map, stats }
}

module.exports = { fetch17TrackStatuses }
