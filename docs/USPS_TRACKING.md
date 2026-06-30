# USPS Auto-Tracking — Analysis & Solution

This document records why the original USPS auto-tracking didn't work, the
options considered, and the solution shipped in v1.5.0.

## 1. Why the original version failed

A multi-agent analysis traced the full path
(`ShippingTracker.refreshUsps → window.rmcardz.refreshTracking → main.cjs
'tracking:refresh' → electron/tracking.cjs → server/db.cjs`). Findings:

- **The wiring was correct** — no field mismatch. A correctly-scraped status
  *would* persist. So the failure was entirely in the scrape layer.
- **Akamai bot wall.** `tools.usps.com/go/TrackConfirmAction` sits behind Akamai
  Bot Manager. The old scraper opened a **fresh, cookie-less hidden window per
  number, 6 at a time**, with only a spoofed User-Agent. That is the worst
  possible signal: cold sessions + parallel burst + UA/Client-Hints mismatch →
  USPS served a "Pardon Our Interruption / Access Denied" challenge page.
- **Fixed `sleep(2200)` then whole-page `innerText`.** The status is rendered by
  client JS after a redirect + XHR; a flat 2.2 s wait usually captured an empty
  shell or the challenge page. Reading the *whole* page also caused false
  positives from footer/help text.
- **Silent failure.** When every page returned no status, the app reported
  **"0 updated of N scanned" with no error** — indistinguishable from "nothing
  changed." This is why it looked like it "did nothing."

**Verdict:** a no-API-key scrape of USPS is *fundamentally fragile*. It can be
made a decent best-effort tool that's honest about failure, but never reliable —
Akamai is designed to defeat exactly this.

## 2. Options considered

| Option | Reliable? | Cost | MID needed? | Verdict |
|--------|-----------|------|-------------|---------|
| Hardened scrape (no key) | Best-effort only | Free | No | Ship as default/fallback |
| **17TRACK API** | **Yes** | Free ≤100/mo, then ~$10/mo | **No** | **Recommended** |
| EasyPost Tracker | Yes | ~$0.03/number | No | Good runner-up |
| AfterShip | Yes | ~$11–39/mo | No | Pricier; API paywalled |
| Official USPS API | n/a | Restricted | **Yes (Whatnot owns it)** | **Not viable** |
| Informed Delivery / email | No | Free | — | Not practical |

The official USPS Tracking API enforces (since Apr 1, 2026) that lookups are tied
to a Mailer ID you're authorized for. Whatnot generates the labels and owns the
MID, so the seller cannot legitimately use it — **track-by-number only.**

## 3. Solution (shipped v1.5.0)

A **pluggable tracking provider**, chosen in Settings → "USPS auto-tracking":

- **17TRACK API (recommended, reliable).** Paste a free Access Key. The app
  registers each number once and polls structured statuses (`server/tracking17.cjs`,
  mapping in `server/tracking17map.cjs`). No scraping, no MID.
- **Auto-read from USPS (default, no key, best-effort).** A hardened scraper
  (`electron/tracking.cjs`): one reused window with a persistent `persist:usps`
  partition (warm cookies), a usps.com warm-up, consistent UA + Accept-Language,
  strictly sequential with jittered delays, **selector-polling** for the real
  status banner (fed alone to `mapStatusText`), explicit **challenge detection**,
  and early stop after repeated challenges.

Both return `{ map, stats:{ scanned, read, blocked, failed } }`, and the UI now
reports **honest results** — "Updated X · read Y/N · Z blocked" — so a blocked
run no longer masquerades as "0 updated." If a keyless run reads 0 statuses, the
UI points the user to add a free 17TRACK key.

### How a user turns on reliable tracking
1. Sign up free at features.17track.net → Settings → Security → **Access Key**.
2. In RM Cardz: **Settings → USPS auto-tracking → 17TRACK API**, paste the key, Save.
3. Click **Auto-update status (USPS)** in Shipping Tracker or Planner.

### Status mapping (17TRACK → app)
`InfoReceived→label_created`, `InTransit→in_transit`, `OutForDelivery→out_for_delivery`,
`Delivered→delivered`, `AvailableForPickup`/`DeliveryFailure`/`Expired`/other
`Exception→exception`, `Exception_*Return*→returned`, `NotFound→` (left untouched).
