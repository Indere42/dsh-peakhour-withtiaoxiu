# dsh-peakhour-withtiaoxiu

English | [中文](README.zh.md)

A DeepSeek API peak/off-peak billing clock for the DSH Web GUI — **调休-aware**, with a policy that
syncs from the official pricing page.

## What it solves

DeepSeek's published rule ([pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/),
wording captured 2026-09):

> Off-peak prices are half of peak prices. Beijing time **Monday to Friday (excluding Chinese public
> holidays)** 9:00-12:00 and 14:00-18:00 are peak hours; every other period, **including weekends and
> public holidays all day**, is off-peak.

That sentence hides two traps, and this plugin's clock exists to get them right:

1. **Peak keys off the weekday, not the government work calendar.** A 调休 makeup workday that lands
   on a weekend is still a weekend, so it bills off-peak the whole day. (2026-09-20 is a Sunday
   designated as a makeup workday → off-peak.)
2. **A public holiday on a weekday skips that day's peak windows entirely.**

## Features

- **One always-visible sidebar row** (under 用量): `峰时/谷时 · countdown` plus the current input
  unit price. Collapses to an icon when the sidebar is collapsed.
- **Click-through policy panel**: the full window table, the current price table (cache hit / miss /
  output, CNY per million tokens), the data source and fetch time, the holiday-calendar years, and a
  manual "sync from the official page" button.
- **Scheduled sync**: the host re-reads the official page and the holiday calendar every
  `syncIntervalMinutes` (default 180). A failed sync keeps the last good policy and says so on the
  panel instead of silently mis-pricing.
- **Free**: a sync fetches one HTML page and up to two small JSON files. No DeepSeek API call, no
  token spent.

## Install

```sh
dsh plugin --profile web add github:<you>/dsh-peakhour-withtiaoxiu
```

Restart `dsh web`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `autoSync` | `true` | Whether the host syncs on a schedule |
| `syncIntervalMinutes` | `180` | Sync period, minutes |
| `pollIntervalSec` | `15` | How often the browser re-reads the state |
| `offpeakMultiplier` | `0.5` | Fallback off-peak multiplier |
| `holidays` | `[]` | Extra statutory-holiday dates (`YYYY-MM-DD`) |
| `workdays` | `[]` | Extra makeup-workday dates (recorded; peak rule keys off the weekday) |
| `override.windows` | — | Replace the peak windows outright |
| `override.models` | — | Patch one model's prices |

## Data sources

- Policy: the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
  (parsed live; falls back to the English mirror, then the on-disk cache, then the built-in snapshot)
- Holidays / 调休: [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) (derived from
  the State Council notices, each file carrying the source notice URL)

## Development

```sh
npm test       # 47+ unit tests: windows, 调休, holidays, official-page parsing, sync-failure fallback
npm run build  # wraps lib/client.source.js into the DSH browser bundle lib/client.js
```

`lib/client.source.js` is the readable ESM source; `lib/client.js` is a build artifact — do not edit
it by hand.

## Known limitations

- The official page is prose, not structured data: the parser works off the current wording, and a
  large rewrite fails loudly (keeping the previous policy) rather than guessing.
- The built-in snapshot is the 2026-09 policy; a first offline boot uses it and labels the source as
  `内置快照` in the panel.
- The browser half never contacts a third-party origin; everything arrives through the host's
  `/api/dsh-peakhour/state`.
