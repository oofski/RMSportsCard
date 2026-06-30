// =============================================================================
// RM Cardz — Automatic USPS status (no API key)  ·  BEST-EFFORT scraper
// -----------------------------------------------------------------------------
// USPS has no free tracking API for Whatnot-generated labels (the Mailer ID in
// the barcode belongs to Whatnot, not rm_cardz — see spec §7.1). So instead of
// an API we read the SAME public tracking page the "Open in USPS" button uses,
// but headlessly: each tracking number is loaded in a hidden Electron
// BrowserWindow (a real Chromium that runs the page's JS and clears USPS's
// Akamai bot defenses far better than a raw HTTP request can), and we parse the
// status banner out of the rendered DOM and map it to one of our status codes.
//
// This runs in the Electron MAIN process (only it can open windows) and on the
// USER'S machine (the build sandbox blocks tools.usps.com, so this cannot be
// exercised in CI). It is best-effort and HONEST ABOUT FAILURE: anything we
// can't read, that gets challenged by Akamai, or that times out is reported in
// `stats` rather than silently dropped, and is left untouched so the operator
// can still set it manually.
//
// ---------------------------------------------------------------------------
// RED-TEAM HARDENING (why this differs from the old version):
//
//   Old failure mode: a fresh hidden window per number, 6-way concurrency, a
//   fixed sleep, and reading the WHOLE page innerText. Akamai (the _abck /
//   bm_sz sensor on tools.usps.com) saw a cold, parallel, robotic access
//   pattern, served a "Pardon Our Interruption" / "Access Denied" challenge,
//   and `mapStatusText` matched nothing — so the app reported "0 updated" with
//   no idea WHY.
//
//   New approach:
//     * ONE reused BrowserWindow with a persistent partition ('persist:usps')
//       so Akamai's cookies survive across lookups AND app restarts — the
//       session looks "warm" instead of brand new every time.
//     * A consistent human-ish identity: a real desktop-Chrome UA plus an
//       Accept-Language header on every request.
//     * A WARM-UP visit to usps.com first, so the Akamai sensor script has a
//       chance to validate the session before we ask for tracking data.
//     * STRICTLY SEQUENTIAL access (concurrency 1) with a jittered human-ish
//       pause between numbers.
//     * We POLL the page for a real status banner and feed ONLY that short
//       banner text to mapStatusText (never the whole page), and we actively
//       DETECT challenge pages.
//     * If we get challenged twice in a row we STOP early instead of hammering
//       USPS, and we honestly count the un-attempted remainder as "blocked".
// =============================================================================

const { BrowserWindow } = require('electron')
const reference = require('../shared/reference.json')
const { mapStatusText } = require('./uspsStatus.cjs')

// Base tracking URL from the single source of truth. Final URL is:
//   BASE + encodeURIComponent(trackingNumber)
const BASE = reference.uspsTrackBaseUrl

// A normal desktop-Chrome UA; the default Electron UA advertises "Electron",
// which is an instant tell for bot-detection. Module-level constant by request.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// Language header we attach to every request to look like a US English browser.
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9'

// ---- Tunables (kept conservative on purpose) --------------------------------
const WARMUP_URL = 'https://www.usps.com/'
const WARMUP_WAIT_MS = 3500 // let the Akamai sensor validate the warm session
const LOAD_TIMEOUT_MS = 20000 // hard cap on a single loadURL so a hung nav can't stall us
const POLL_INTERVAL_MS = 300 // how often we re-check the page for a banner/challenge
const POLL_TIMEOUT_MS = 15000 // give up reading one page after this long
const JITTER_MIN_MS = 1500 // min human-ish pause between numbers
const JITTER_MAX_MS = 4000 // max human-ish pause between numbers
const MAX_CONSECUTIVE_CHALLENGES = 2 // stop the run after this many challenges in a row

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A randomized, human-ish delay. Math.random is fine here: this is Electron app
// runtime, not a reproducible workflow, and jitter is the whole point.
const jitter = () =>
  JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1))

// -----------------------------------------------------------------------------
// IN-PAGE PROBE
// -----------------------------------------------------------------------------
// This string is injected via executeJavaScript and runs INSIDE the USPS page.
// It is an IIFE that ALWAYS returns a small, JSON-serializable object, one of:
//
//   { state: 'ready',     text: '<short banner text>' }  // a real status banner
//   { state: 'challenge'                              }  // Akamai / human check
//   { state: 'pending'                                }  // not resolved yet, keep waiting
//
// Design rules that keep this safe to inject:
//   * No template literals / no backticks (this is itself embedded in a JS
//     string; we keep it plain so there is zero quoting ambiguity).
//   * Everything is wrapped in try/catch so a weird DOM can never throw across
//     the executeJavaScript boundary (which would reject our promise).
//   * We return only SHORT text (status banner), never whole-page innerText.
// -----------------------------------------------------------------------------
const PROBE_JS = `(function () {
  try {
    // --- 1) Challenge detection -------------------------------------------
    // Akamai's interstitials and USPS's own "verify you are human" pages have
    // recognizable titles / body phrases. Scan the title plus a small slice of
    // body text (NOT the whole page) for known challenge markers.
    var title = (document.title || '').toLowerCase();
    var bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    var probe = (title + ' ' + bodyText.slice(0, 2000)).toLowerCase();
    var challengeMarkers = [
      'access denied',
      'pardon our interruption',
      'verify you are human',
      'are you a human',
      'unusual activity',
      'unusual traffic',
      'reference #18',          // Akamai "Access Denied" reference id prefix
      'request blocked',
      'bot detection',
      'security check',
      'enable javascript and cookies',
      'why did this happen'
    ];
    for (var i = 0; i < challengeMarkers.length; i++) {
      if (probe.indexOf(challengeMarkers[i]) !== -1) {
        return { state: 'challenge' };
      }
    }

    // --- 2) Status banner extraction (collect, don't first-match) ---------
    // The OLD code returned the FIRST node (across all selectors) that was 3..200
    // chars. That broke in-transit pages: USPS leads with a delivery-date / bold
    // "Arriving On Time" HEADLINE while the literal "In Transit" / "Moving Through
    // Network" text sits in the lower-priority detail node — so first-match
    // grabbed an unmappable headline (or, worse, the over-broad [class*="status"]
    // catch-all grabbed page chrome like "Tracking Status"), the mapper returned
    // null, and the shipment was left stuck on "Not Shipped".
    //
    // Fix: COLLECT the trustworthy status nodes and CONCATENATE them headline-
    // first, so the "In Transit" detail always rides along even when the headline
    // is just a delivery date. The broad [class*="status"] catch-all is demoted to
    // a LAST resort (only when the specific selectors yield nothing) so it can no
    // longer hijack the result. The mapper (mapStatusText) already lets terminal
    // states win over in-transit history, so joining is precedence-safe.
    function collect(sel, out) {
      var nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { return; }
      for (var i = 0; i < nodes.length; i++) {
        var raw = (nodes[i] && nodes[i].innerText) ? nodes[i].innerText : '';
        var t = raw.replace(/\\s+/g, ' ').trim();
        if (t && t.length >= 3 && t.length <= 200) out.push(t);
      }
    }

    var parts = [];
    collect('.tb-status', parts);         // canonical bold status / headline
    collect('.tb-status-detail', parts);  // "In Transit ...", "Moving Through Network"
    collect('.delivery_status', parts);
    // Only reach for the broad catch-all + summary containers if the specific
    // status selectors produced nothing at all.
    if (parts.length === 0) {
      collect('[class*="status"]', parts);
      collect('.track-bar-container', parts);
      collect('.status-summary', parts);
      collect('[class*="summary"]', parts);
      collect('[class*="banner"]', parts);
    }

    if (parts.length > 0) {
      // Join with a NEWLINE (not " — "): mapStatusText's delivery-date strip
      // rules match [^\\n.]* and stop at a newline, so a newline keeps each
      // part's strip self-contained. A " — " separator would let an "Expected
      // Delivery ..." headline strip bleed across and eat the "In Transit"
      // detail that follows.
      var joined = parts.join('\\n');
      if (joined.length > 400) joined = joined.slice(0, 400);
      return { state: 'ready', text: joined };
    }

    // Nothing decisive yet — tell the poller to keep waiting.
    return { state: 'pending' };
  } catch (err) {
    // Any unexpected error: report pending so the outer timeout governs us,
    // rather than rejecting the executeJavaScript promise.
    return { state: 'pending' };
  }
})()`

// -----------------------------------------------------------------------------
// Window lifecycle helpers
// -----------------------------------------------------------------------------

/**
 * Create the ONE hidden window we reuse for the whole batch. The persistent
 * partition is what makes Akamai's cookies (_abck / bm_sz) survive across
 * lookups and app restarts, so the session keeps looking "warm".
 */
function createWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // persist: ensures the cookie jar is written to disk and reused next run.
      partition: 'persist:usps',
      // Keep the renderer running full-speed even though it's hidden; otherwise
      // Chromium throttles background timers and the Akamai sensor stalls.
      backgroundThrottling: false,
      // NOTE: intentionally NOT setting `images`/`offscreen` here — those are
      // not valid webPreferences keys and were a mistake in the old version.
    },
  })

  try {
    win.webContents.setAudioMuted(true)
  } catch (_) {
    /* non-fatal */
  }

  // Consistent identity #1: a real Chrome UA (overrides the "Electron" default).
  try {
    win.webContents.setUserAgent(CHROME_UA)
  } catch (_) {
    /* non-fatal */
  }

  // Consistent identity #2: attach Accept-Language (and re-assert the UA) to
  // EVERY outgoing request for this session. Using onBeforeSendHeaders means we
  // don't have to remember per-loadURL extraHeaders and can't accidentally drop
  // the header on sub-resource requests.
  try {
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders || {}
      headers['Accept-Language'] = ACCEPT_LANGUAGE
      // Re-assert UA defensively in case some internal request bypassed it.
      headers['User-Agent'] = CHROME_UA
      callback({ requestHeaders: headers })
    })
  } catch (_) {
    /* non-fatal — UA alone is still set above */
  }

  return win
}

/**
 * Navigate the window to `url`, racing the navigation against a hard timeout so
 * a hung page (or a never-resolving sub-resource) can't stall the batch. We
 * deliberately swallow loadURL rejections: it rejects on benign sub-resource
 * aborts (ERR_ABORTED) even when the main document loaded fine, and we only
 * care about what the in-page probe can see afterward.
 */
async function navigate(win, url) {
  await Promise.race([
    win.loadURL(url).catch(() => {}),
    sleep(LOAD_TIMEOUT_MS),
  ])
}

/**
 * Poll the loaded page for up to POLL_TIMEOUT_MS, running PROBE_JS every
 * POLL_INTERVAL_MS. Resolves to one of:
 *   { state: 'ready', text }  — a banner was found
 *   { state: 'blocked' }      — a challenge/interstitial was detected
 *   { state: 'failed' }       — timed out with no banner and no challenge
 * Never throws.
 */
async function pollForResult(win) {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    // If the window vanished underneath us, bail as a failure rather than throw.
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
      return { state: 'failed' }
    }

    let res = null
    try {
      // `true` => run as a user gesture; harmless and occasionally required by
      // pages that gate behavior on user activation.
      res = await win.webContents.executeJavaScript(PROBE_JS, true)
    } catch (_) {
      // executeJavaScript can reject if a navigation happened mid-eval; treat as
      // "not yet" and let the loop retry until the deadline.
      res = null
    }

    if (res && res.state === 'ready' && typeof res.text === 'string' && res.text.trim()) {
      return { state: 'ready', text: res.text }
    }
    if (res && res.state === 'challenge') {
      return { state: 'blocked' }
    }

    // 'pending' (or a transient null) — wait and try again.
    await sleep(POLL_INTERVAL_MS)
  }

  // Deadline reached without a banner or a challenge.
  return { state: 'failed' }
}

/**
 * Load ONE tracking number and resolve to a normalized outcome:
 *   { state: 'read',    code }  — banner read AND mapped to a status code
 *   { state: 'blocked'       }  — challenge/interstitial detected
 *   { state: 'failed'        }  — timeout, parse-miss, or banner-not-mappable
 * Never throws.
 */
async function fetchOne(win, trackingNumber) {
  try {
    const url = BASE + encodeURIComponent(trackingNumber)
    await navigate(win, url)

    const result = await pollForResult(win)

    if (result.state === 'blocked') {
      return { state: 'blocked' }
    }
    if (result.state === 'ready') {
      // Feed ONLY the short banner text to the mapper (never whole-page text).
      const code = mapStatusText(result.text)
      if (code) return { state: 'read', code }
      // Banner existed but we couldn't classify it — that's a parse miss.
      return { state: 'failed' }
    }
    // 'failed' from the poller (timeout / window gone).
    return { state: 'failed' }
  } catch (_) {
    // Absolutely nothing from one bad page is allowed to abort the run.
    return { state: 'failed' }
  }
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

/**
 * Best-effort refresh of USPS statuses for a list of shipments.
 *
 * @param {Object}   opts
 * @param {Array}    opts.shipments  - objects each (ideally) with `.trackingNumber`
 * @param {Function} [opts.onProgress] - called per number with
 *                   { done, total, trackingNumber, code, state } where
 *                   state is 'read' | 'blocked' | 'failed'.
 *
 * @returns {Promise<{ map: Object, stats: Object }>}
 *   map:   { [trackingNumber]: statusCode } — ONLY successfully-read statuses.
 *   stats: { scanned, read, blocked, failed }
 *          scanned = # shipments that had a trackingNumber
 *          read    = # mapped successfully
 *          blocked = # Akamai/challenge/rate-limit detections (incl. the
 *                    un-attempted remainder after an early stop)
 *          failed  = # timeouts / parse-misses / other
 *
 * Never throws: any internal error is contained and reflected in stats.
 */
async function scrapeTracking({ shipments, onProgress } = {}) {
  const map = {}
  const stats = { scanned: 0, read: 0, blocked: 0, failed: 0 }

  // Filter to shipments that actually have a tracking number.
  const list = (Array.isArray(shipments) ? shipments : []).filter(
    (s) => s && s.trackingNumber
  )
  stats.scanned = list.length
  const total = list.length

  // Safe progress emitter — a throwing callback must not break the scrape.
  const emit = (payload) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(payload)
      } catch (_) {
        /* ignore consumer errors */
      }
    }
  }

  // Nothing to do.
  if (total === 0) {
    return { map, stats }
  }

  let win = null
  try {
    // --- Create the single reused window ------------------------------------
    win = createWindow()

    // --- WARM UP once so Akamai validates the session before tracking lookups.
    // Failures here are non-fatal; we still try the batch.
    try {
      await navigate(win, WARMUP_URL)
      await sleep(WARMUP_WAIT_MS)
    } catch (_) {
      /* warm-up is best-effort */
    }

    // --- SEQUENTIAL crawl (concurrency 1) -----------------------------------
    let done = 0
    let consecutiveChallenges = 0
    let stopped = false

    for (let i = 0; i < list.length; i++) {
      const sh = list[i]
      const trackingNumber = sh.trackingNumber

      let outcome
      try {
        outcome = await fetchOne(win, trackingNumber)
      } catch (_) {
        outcome = { state: 'failed' }
      }

      done += 1

      if (outcome.state === 'read') {
        map[trackingNumber] = outcome.code
        stats.read += 1
        consecutiveChallenges = 0
        emit({ done, total, trackingNumber, code: outcome.code, state: 'read' })
      } else if (outcome.state === 'blocked') {
        stats.blocked += 1
        consecutiveChallenges += 1
        emit({ done, total, trackingNumber, code: null, state: 'blocked' })

        // Back off entirely after repeated challenges: continuing would just
        // hammer USPS and deepen the block. Stop and account honestly.
        if (consecutiveChallenges >= MAX_CONSECUTIVE_CHALLENGES) {
          stopped = true
          // Count every NOT-attempted remaining shipment as blocked, and report
          // each via onProgress so the UI total stays consistent.
          for (let j = i + 1; j < list.length; j++) {
            const rest = list[j]
            stats.blocked += 1
            done += 1
            emit({
              done,
              total,
              trackingNumber: rest.trackingNumber,
              code: null,
              state: 'blocked',
            })
          }
          break
        }
      } else {
        stats.failed += 1
        consecutiveChallenges = 0
        emit({ done, total, trackingNumber, code: null, state: 'failed' })
      }

      // Human-ish jittered pause between numbers — but not after the last one,
      // and not if we just decided to stop.
      if (!stopped && i < list.length - 1) {
        await sleep(jitter())
      }
    }
  } catch (_) {
    // Catch-all: a failure setting up the window or in the loop scaffolding
    // should still return whatever we gathered, never throw to the caller.
    // (Per-number errors are already contained above.)
  } finally {
    // Destroy the single window exactly once, at the very end.
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch (_) {
      /* ignore */
    }
  }

  return { map, stats }
}

// Re-export mapStatusText for backward compatibility with existing callers/tests.
module.exports = { scrapeTracking, mapStatusText }
