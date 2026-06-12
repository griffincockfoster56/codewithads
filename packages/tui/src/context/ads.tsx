import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import type { JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import open from "open"
import { createSimpleContext } from "./helper"
import { useSync } from "./sync"
import { useTheme } from "./theme"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// CloudFront URL from the ad-server stack output (CdnUrl). Users can override
// via `ads.endpoint` or disable via `ads.enabled` in opencode config.
export const DEFAULT_AD_ENDPOINT = "https://d2qtme4egxe0lf.cloudfront.net"

const FEED_REFRESH_MS = 10 * 60 * 1000
const ROTATE_MS = 20 * 1000
const FLUSH_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 5 * 1000
const DEFAULT_MIN_DISPLAY_MS = 5 * 1000

export interface Ad {
  id: string
  sponsor: string
  message: string
  /** Short glyph/emoji rendered ahead of the sponsor name, e.g. "▲". */
  logo?: string
  /** Hex color (#rrggbb) for the sponsor line. Falls back to muted text. */
  color?: string
  url?: string
  weight: number
  /** USD per 1,000 impressions. Rank in the bid queue buys placement. */
  cpmBid?: number
}

interface AdsConfig {
  enabled?: boolean
  endpoint?: string
  min_display_ms?: number
}

function bidOf(ad: Ad): number {
  // $0 house bids are real bids — any paid bid outranks them.
  return typeof ad.cpmBid === "number" && ad.cpmBid >= 0 ? ad.cpmBid : Math.max(ad.weight, 0)
}

/**
 * Priority-queue auction order (kickbacks-style): highest CPM bid first —
 * rank #1 wins the premium placements. Equal bids shuffle each cycle so
 * tied campaigns share their rank fairly.
 */
function auctionOrder(ads: Ad[]): Ad[] {
  const sorted = [...ads].sort((a, b) => bidOf(b) - bidOf(a))
  const out: Ad[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && bidOf(sorted[j]) === bidOf(sorted[i])) j++
    const group = sorted.slice(i, j)
    for (let k = group.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1))
      ;[group[k], group[r]] = [group[r], group[k]]
    }
    out.push(...group)
    i = j
  }
  return out
}

export const { use: useAds, provider: AdsProvider } = createSimpleContext({
  name: "Ads",
  init: () => {
    const sync = useSync()
    // Anonymous, regenerated every TUI launch — used only to estimate unique
    // reach server-side. Never tied to user identity or prompt content.
    const sessionId = crypto.randomUUID()

    const [ads, setAds] = createSignal<Ad[]>([])
    const [current, setCurrent] = createSignal<Ad | undefined>(undefined)
    // Distinct campaigns for simultaneously-visible slots, so adjacent ad
    // slots don't show the same message. picks[0] === current.
    const [picks, setPicks] = createSignal<Ad[]>([])

    let activeSlots = 0
    const pendingImpressions = new Map<string, number>()
    const pendingClicks = new Map<string, number>()

    const config = () => (sync.data.config as { ads?: AdsConfig }).ads
    const endpoint = () => config()?.endpoint ?? DEFAULT_AD_ENDPOINT
    const enabled = () => config()?.enabled !== false && endpoint().length > 0
    const minDisplayMs = () => {
      const value = config()?.min_display_ms
      return typeof value === "number" && value >= 0 ? value : DEFAULT_MIN_DISPLAY_MS
    }

    // Sponsor messages must never degrade the session: every network call is
    // fire-and-forget with a short timeout, and failures leave the UI as-is.
    async function fetchFeed() {
      if (!enabled()) return
      try {
        const url = `${endpoint()}/v1/ads?client=tui&version=${encodeURIComponent(InstallationVersion)}`
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) return
        const body = (await response.json()) as { ads?: Ad[] }
        if (!Array.isArray(body.ads)) return
        setAds(body.ads.filter((ad) => ad && typeof ad.id === "string" && typeof ad.message === "string"))
        if (!current()) rotate()
      } catch {
        // Offline or backend down — keep whatever feed we already have.
      }
    }

    function record(ad: Ad) {
      pendingImpressions.set(ad.id, (pendingImpressions.get(ad.id) ?? 0) + 1)
    }

    function rotate() {
      const chosen = auctionOrder(ads()).slice(0, 4)
      setCurrent(chosen[0])
      setPicks(chosen)
      if (chosen[0] && activeSlots > 0) record(chosen[0])
    }

    async function flush() {
      if (!enabled() || (pendingImpressions.size === 0 && pendingClicks.size === 0)) return
      const events = [
        ...[...pendingImpressions.entries()].map(([adId, count]) => ({ adId, count, type: "impression" })),
        ...[...pendingClicks.entries()].map(([adId, count]) => ({ adId, count, type: "click" })),
      ]
      pendingImpressions.clear()
      pendingClicks.clear()
      try {
        await fetch(`${endpoint()}/v1/impressions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, events }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch {
        // Dropped impressions are acceptable; never retry-storm.
      }
    }

    onMount(() => {
      createEffect(() => {
        if (enabled()) void fetchFeed()
      })
      const timers = [
        setInterval(() => void fetchFeed(), FEED_REFRESH_MS),
        setInterval(rotate, ROTATE_MS),
        setInterval(() => void flush(), FLUSH_MS),
      ]
      onCleanup(() => {
        for (const timer of timers) clearInterval(timer)
        void flush()
      })
    })

    return {
      enabled,
      current,
      picks,
      minDisplayMs,
      /** Open the sponsor's site and report the click (CTR for sponsors). */
      click(ad: Ad | undefined) {
        if (!ad?.url) return
        pendingClicks.set(ad.id, (pendingClicks.get(ad.id) ?? 0) + 1)
        void flush()
        open(ad.url).catch(() => {})
      },
      acquire() {
        activeSlots += 1
        const ad = current()
        if (activeSlots === 1 && ad) record(ad)
        return () => {
          activeSlots = Math.max(0, activeSlots - 1)
        }
      },
    }
  },
})

/**
 * Tracks the sponsor ad to display for one UI slot. Once an ad appears it is
 * pinned for at least `ads.min_display_ms` (default 5s): it neither rotates
 * away nor disappears when `active()` flips off before the minimum elapses.
 *
 * With `sticky`, the slot behaves like print: the first ad pinned never
 * rotates or clears (it stays in scrollback), but it stops counting toward
 * impressions once `active()` ends — sponsors aren't billed for scrollback.
 */
export function useSponsorDisplay(active: () => boolean, opts?: { sticky?: boolean }) {
  const ads = useAds()
  const [shown, setShown] = createSignal<Ad | undefined>(undefined)
  let holdUntil = 0
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let release: (() => void) | undefined

  const clear = () => {
    holdTimer = undefined
    setShown(undefined)
    release?.()
    release = undefined
  }

  createEffect(() => {
    const visible = active() && ads.enabled()
    const current = ads.current()
    const pinned = untrack(shown)
    if (visible && current) {
      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = undefined
      }
      if (!pinned) {
        setShown(current)
        holdUntil = Date.now() + ads.minDisplayMs()
        release = ads.acquire()
      } else if (!opts?.sticky && pinned.id !== current.id && Date.now() >= holdUntil) {
        // Rotation may swap the ad, but only after the pinned one had its
        // guaranteed minimum on screen.
        setShown(current)
        holdUntil = Date.now() + ads.minDisplayMs()
      }
    } else if (!visible && pinned) {
      if (opts?.sticky) {
        // Keep displaying forever, but stop counting impressions.
        release?.()
        release = undefined
      } else if (!holdTimer) {
        const remaining = holdUntil - Date.now()
        if (remaining <= 0) clear()
        else holdTimer = setTimeout(clear, remaining)
      }
    }
  })

  onCleanup(() => {
    if (holdTimer) clearTimeout(holdTimer)
    release?.()
    release = undefined
  })

  return shown
}

export function sponsorLabel(ad: Ad) {
  return `${ad.logo ? ad.logo + " " : ""}${ad.sponsor} — ${ad.message}`
}

export function useSponsorColor(ad: () => Ad | undefined) {
  const { theme } = useTheme()
  return createMemo(() => {
    const hex = ad()?.color
    if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      try {
        return RGBA.fromHex(hex)
      } catch {
        // Malformed color from the feed — fall through to the theme default.
      }
    }
    return theme.textMuted
  })
}

/** Sponsor line rendered next to existing text: logo glyph + colored label. */
export function SponsorBadge(props: { ad: Ad | undefined }) {
  const ads = useAds()
  const color = useSponsorColor(() => props.ad)
  return (
    <Show when={props.ad}>
      <text wrapMode="none" fg={color()} onMouseUp={() => ads.click(props.ad)}>
        {"  " + sponsorLabel(props.ad!)}
      </text>
    </Show>
  )
}

/**
 * String form for surfaces that only accept text (tool pending labels).
 * Shares the same pinning behavior as useSponsorDisplay.
 */
export function useSponsorText(active: () => boolean) {
  const shown = useSponsorDisplay(active)
  return () => {
    const ad = shown()
    if (!ad) return ""
    return `  ·  ${sponsorLabel(ad)}`
  }
}

/**
 * Inline span for embedding inside an existing <text> line (e.g. the
 * "▣ Build · model" footer). Sticky by default: pins one ad per line, print-style.
 */
export function SponsorInlineSpan(props: { sticky?: boolean }) {
  const ad = useSponsorDisplay(
    () => true,
    { sticky: props.sticky !== false },
  )
  const color = useSponsorColor(ad)
  return (
    <Show when={ad()}>
      <span style={{ fg: color() }}>{"  ·  " + sponsorLabel(ad()!)}</span>
    </Show>
  )
}

/** Always-on billboard slot (status bar): shows the live rotation. */
export function SponsorFooterBadge() {
  const ad = useSponsorDisplay(() => true)
  return <SponsorBadge ad={ad()} />
}

/**
 * Numbered billboard for areas with several simultaneously-visible slots:
 * slot 0 mirrors the primary rotation, slots 1-2 show different campaigns.
 */
export function SponsorSlotBadge(props: { slot: number }) {
  const ads = useAds()
  const ad = () => {
    const list = ads.picks()
    return list[props.slot] ?? list[0]
  }
  return <SponsorBadge ad={ad()} />
}

/** Black or white ink, whichever contrasts against the ad's brand color. */
export function contrastInk(ad: Ad | undefined): RGBA {
  const hex = ad?.color
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b
    if (luminance > 145) return RGBA.fromInts(22, 18, 12)
  }
  return RGBA.fromInts(255, 255, 255)
}

/**
 * Large filled banner (home screen) — the premium placement. Brand-color
 * background, contrast-computed ink, animated sparkle.
 */
export function SponsorBanner() {
  const ads = useAds()
  const ad = () => ads.picks()[0]
  const color = useSponsorColor(ad)
  const ink = () => contrastInk(ad())
  return (
    <Show when={ad()}>
      <box
        width="100%"
        backgroundColor={color()}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        gap={1}
        onMouseUp={() => ads.click(ad())}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={ink()}>
            <b>{(ad()!.logo ? ad()!.logo + " " : "") + ad()!.sponsor.toUpperCase()}</b>
          </text>
          <text fg={ink()}>✦ SPONSORED</text>
        </box>
        <text fg={ink()}>{ad()!.message}</text>
        <Show when={ad()!.url}>
          <text fg={ink()}>
            <b>→ {ad()!.url}</b>
          </text>
        </Show>
      </box>
    </Show>
  )
}

/** Inverse chip: brand-color background pill for high-attention inline slots. */
export function SponsorChip(props: { slot: number }) {
  const ads = useAds()
  const ad = () => {
    const list = ads.picks()
    return list[props.slot] ?? list[0]
  }
  const color = useSponsorColor(ad)
  return (
    <Show when={ad()}>
      <text bg={color()} fg={contrastInk(ad())} onMouseUp={() => ads.click(ad())}>
        <b>{" " + sponsorLabel(ad()!) + " "}</b>
      </text>
    </Show>
  )
}

/**
 * Large filled block ad: brand-color background, uppercase sponsor, message,
 * URL. With `sticky`, pins one campaign for this component's lifetime
 * (scrollback print); otherwise follows the live rotation at `slot`.
 * Renders `fallback` when no campaign is available (e.g. ads disabled).
 */
export function SponsorBlock(props: { slot?: number; sticky?: boolean; fallback?: JSX.Element }) {
  const ads = useAds()
  const pinned = props.sticky ? useSponsorDisplay(() => true, { sticky: true }) : undefined
  const ad = () => {
    if (pinned) return pinned()
    const list = ads.picks()
    return list[props.slot ?? 0] ?? list[0]
  }
  const color = useSponsorColor(ad)
  const ink = () => contrastInk(ad())
  return (
    <Show when={ad()} fallback={props.fallback}>
      <box
        width="100%"
        backgroundColor={color()}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        gap={1}
        onMouseUp={() => ads.click(ad())}
      >
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <text fg={ink()}>
            <b>{(ad()!.logo ? ad()!.logo + " " : "") + ad()!.sponsor.toUpperCase()}</b>
          </text>
          <text fg={ink()}>✦ SPONSORED</text>
        </box>
        <text fg={ink()}>{ad()!.message + (ad()!.url ? "  → " + ad()!.url : "")}</text>
      </box>
    </Show>
  )
}

/** Sidebar ad card — replaces the old "Getting started" panel. */
export function SponsorCard() {
  const ads = useAds()
  const ad = () => {
    const list = ads.picks()
    return list[3] ?? list[list.length - 1]
  }
  const color = useSponsorColor(ad)
  const ink = () => contrastInk(ad())
  return (
    <Show when={ad()}>
      <box
        backgroundColor={color()}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
        onMouseUp={() => ads.click(ad())}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={ink()}>
            <b>{(ad()!.logo ? ad()!.logo + " " : "") + ad()!.sponsor}</b>
          </text>
          <text fg={ink()}>ad</text>
        </box>
        <text fg={ink()}>{ad()!.message}</text>
        <Show when={ad()!.url}>
          <text fg={ink()}>
            <b>→ {ad()!.url}</b>
          </text>
        </Show>
      </box>
    </Show>
  )
}
