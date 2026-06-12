# codewithads

**The ad-supported fork of [opencode](https://github.com/anomalyco/opencode) — the AI coding agent that sponsors pay for.**

Same agent, same speed, $0/month forever. While the model thinks, the spinner shows a short sponsor message. That's the whole business model.

```
⠹ ✳ Anthropic — Claude: your AI pair programmer.
```

🌐 **[codewithads.com](https://codewithads.com)** — live bid queue, ad inventory, and campaign bidding.

## Install

```sh
curl -fsSL https://codewithads.com/install | bash
```

Or grab a binary from [Releases](https://github.com/griffincockfoster56/codewithads/releases). Then run `codewithads` in any project. Your existing opencode provider auth carries over.

## What's different from opencode

This fork adds an ad engine (`packages/tui/src/context/ads.tsx`) with ten sponsor surfaces — the thinking-spinner takeover, a home-screen banner, block ads in the prompt box and after each reply, a sidebar card, status-bar slots, and more. Campaigns are served by **CPM bid rank** from a live auction: a block buys 1,000 impressions, the highest bid wins the premium placements, clicks bill at 50×, and 30 top AI companies serve as $0 house defaults whenever nobody outbids them.

Everything else is upstream opencode.

## Privacy

The client reports only: which ad IDs were shown, how many times, clicks, and a random per-launch UUID. **Never** your prompts, code, or identity.

Don't want ads? It's still free:

```jsonc
// opencode.json
{ "ads": { "enabled": false } }
```

## Sponsors

Bid on the spinner at [codewithads.com](https://codewithads.com) — minimum $1 CPM, outbid the top to take rank #1.

## Credit & license

Built on [opencode](https://github.com/anomalyco/opencode) by Anomaly. Same [MIT license](LICENSE). All agent capability credit belongs upstream; we just sold the spinner.
