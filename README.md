# Perp Dojo

A trading dashboard for your Bybit perpetual futures, built from a **read-only** API key and run entirely on your own computer.

It pulls your closed perp trades (USDT/USDC linear and inverse) for exactly the days you choose, caches them locally, and shows three views:

- **Dashboard:**
  - a compact stat row: net P&L, trade win % and day win % (gauges with won/breakeven/lost and green/flat/red counts), profit factor (a ring of gross wins vs. losses), and avg win / avg loss
  - a thin warnings line: the three most serious flags, critical first. It covers overtrading (more than 2 trades in 24h), fees over 10% of winnings, liquidations, revenge trades (reopening within 15 min of a loss), losing streaks, deep drawdown, high leverage, outsized losses and API key expiry. Thresholds are in `WARN` in `public/metrics.js`.
  - a full-width cumulative P&L curve
  - a six-axis trading score with a 0–100 meter
  - a **monthly calendar** of daily P&L with weekly totals; click a day to see its trades
  - account equity, day and trade streaks, and a trading-score radar
  - a 6-month heatmap, this week's P&L, and your best hour
  - performance and risk summaries, and plain-language "what stands out" notes
- **Analytics:** cumulative P&L and drawdown, daily, weekly or monthly P&L, breakdowns by market, long vs short, weekday and hour, and the spread of trade outcomes.
- **Journal:** an entry for any day, with that day's stats and trades, a template, a 1–5 discipline rating and tags. Click a day on the dashboard calendar or heatmap to open its entry. Links like `#journal/2026-10-14` go straight to a day. Entries are kept in this browser's local storage for now, per Bybit account, until cloud storage is set up.
- **Weekly review:** one week (Monday to Sunday) at a time, with:
  - the week's stats against last week and your average week
  - P&L by day, and results by strategy
  - a rules scorecard: no Saturday trades, at most 2 trades a day (and what the extra trades cost), daily loss under 4%, checked in, journaled
  - the week's journal entries, and a weekly reflection box
- **Daily loss limit:** 4% of the equity you started the day with (`WARN.dailyLossPct`). Hitting it brings up a banner and a critical warning, and the Entry wizard says Do not trade. The footer shows today's P&L against the limit.
- **4H close countdown** in the footer. Candles close every 4 hours from 00:00 UTC. It turns amber in the last 30 minutes and orange-red in the last 5.
- **Trades:** a sortable list with CSV export.
- **Exports** (bottom of the sidebar):
  - **Export CSV:** the trades in the current filters, including their strategy labels.
  - **Export PDF review:** a written report, not a copy of the dashboard, for the trades in the current filters. It's A4 portrait, in your current theme, built by `public/report.js`. It contains:
    - a verdict and a plain-English summary of how the period went and why
    - key numbers with what each one means
    - performance over time, and what's working and what isn't (markets, sides, strategies, timing)
    - risk and discipline, including a rules scorecard and what breaking each rule cost
    - trade quality, with your biggest wins and losses
    - 3–5 recommendations, highlights from your journal and weekly reflections, and a month-by-month appendix

    It opens the browser's print dialog; choose *Save as PDF*.

Filter everything by date range (presets, or exact From/To days), market and side.

## Where your data lives

- **In your browser.** Pulled trades are stored in the browser's IndexedDB, and journal entries in its local storage. They autosave there, and reloading, filtering and browsing never touch the server's storage.
- **On the server, only when you click.** **Save to server** uploads one compressed snapshot of your trades and journal: a single Blob write per click, always to the same file. **Load** brings it back, e.g. on a new device, after asking you first. The sidebar shows a dot when you have unsaved changes.
- **The server keeps nothing else.** The API functions only pass requests through to Bybit, one week per call: status, account balance and pull.

## Run it locally

1. **Create a read-only key in Bybit:** Account → API → Create New Key → System-generated API Keys → **Read-Only**. Under Contract, tick Orders and Positions.
2. **Add it to `.env`:**
   ```sh
   cp .env.example .env
   open -e .env        # paste BYBIT_API_KEY and BYBIT_API_SECRET, then save
   ```
3. **Install and start it** (needs Node 22 or newer):
   ```sh
   npm install
   npm start
   ```
4. Open http://localhost:8090, press **Pull data…**, and pick the From and To days.

Locally, **Save to server** writes the snapshot to `data/`. If you set `BLOB_READ_WRITE_TOKEN` in `.env`, it goes to Blob instead.

## Deploy to Vercel

1. Push this repo to GitHub. Keep the repo private.
2. In Vercel, go to **Add New → Project**, import the repo, and pick the **Other** framework preset. No build command is needed: `vercel.json` serves `public/` and runs `api/*.js` as functions.
3. Under **Settings → Environment Variables**, add:
   - `BYBIT_API_KEY` and `BYBIT_API_SECRET`: your read-only key
   - `PERP_PASSWORD`: required, because every API call checks it. The page asks for it once and remembers it in that browser.
   - `BYBIT_BASE_URL`: only for regional accounts
4. Under **Storage**, create or connect a **Blob** store with **Private** access. This adds `BLOB_READ_WRITE_TOKEN`. Until then the app still works, but Save and Load are disabled and everything stays in the browser.
5. Deploy.

Things to know:

- **Region:** Bybit refuses requests from US servers, so `vercel.json` pins the functions to Singapore (`sin1`). If your account uses a regional Bybit site, another nearby region may suit better.
- **Key expiry:** Vercel's outgoing IP addresses change, so you can't bind the Bybit key to an IP. Unbound keys expire after 90 days, and the warnings line flags it 14 days ahead.
- **Blob usage:** one write per Save and one read per Load. Nothing else touches Blob.

## Privacy and safety

- The Bybit key is read only by the server functions and never sent to the browser.
- Every API call needs `PERP_PASSWORD`, compared in constant time. Locally the server listens only on `127.0.0.1` and rejects requests from other websites.
- The server checks the key's permissions with Bybit, and **refuses keys that can trade or withdraw**.
- Snapshots are stored privately in Blob, one per Bybit account. `.env` and `data/` are git-ignored.

## How the numbers work

- **Deposits, withdrawals and transfers never affect the stats.** Every number is built from Bybit's Closed P&L records, which hold trades only. Account equity is shown for reference and isn't used in any calculation. The "cumulative P&L" curve starts at $0 and adds up closed trades, not your balance.
- **Hold time**: Closed P&L records only the close, so the app also pulls your fills (`/v5/execution/list`) and replays them per market and side to find when each position opened. Partial closes, scaling in, flips and hedge mode are handled. Fills are fetched from 14 days before the pull range. A position opened earlier than that has no hold time. Hold times feed the "what stands out" notes, e.g. holding losers longer than winners.
- **One trade = one close** in Bybit's Closed P&L. Partial closes count separately.
- **Net P&L** is Bybit's `closedPnl`, which already has opening and closing fees and funding taken off.
- **Funding** per trade isn't returned by this API, so it's worked out as the leftover: price P&L − fees − net P&L.
- **Inverse contracts** settle in coin. Their P&L and fees are converted to USD at the exit price.
- **Return on margin** is net P&L ÷ (position value ÷ leverage).
- **Long vs short**: Bybit reports the side of the *closing* order, so a Sell close is a long. The app double-checks this against the prices and flips its reading if most trades disagree.
- Times are shown in your local time zone.

## Development

```sh
npm test                      # unit tests, plus the real server against a fake Bybit
npm run mock                  # fake Bybit API on :9999 with a year of synthetic trades
PERP_DATA_DIR=/tmp/perp BYBIT_API_KEY=mock-key BYBIT_API_SECRET=mock-secret \
  BYBIT_BASE_URL=http://127.0.0.1:9999 PORT=8091 node server.mjs
```

The fake API checks signatures and the 7-day query window the same way Bybit does. Run it with `MOCK_WRITABLE=1` to simulate a key that can trade, which the app should refuse.

The only dependency is `@vercel/blob`, loaded only when a Blob token is set. Everything else is built in: Node's `fetch`, `crypto` and `http` on the server, and plain HTML, CSS and SVG in the browser.

## Look

There are ten themes. Pick one from the ◐ menu at the bottom of the sidebar; it is remembered. Until you pick, the app follows your system: Dark Polar for dark, Classic Light for light.

| Theme | Mode | Look | Fonts |
|---|---|---|---|
| Dark Polar | dark | Gunmetal with neon accents (the original) | system UI |
| Classic Light | light | Clean, quiet and white | Inter |
| Cream Pastel | light | Warm paper, candy pastels, round corners | Nunito |
| Terminal | dark | Phosphor green on black, scanlines, square corners | JetBrains Mono |
| Atelier | light | Thick ink borders, offset shadows, a yellow hero card | DM Sans with Fraunces headings |
| Dojo Ink | dark | Lacquer brown with gold | Zen Kaku Gothic New with Shippori Mincho headings |
| Glass | dark | Frosted, translucent panes over slowly drifting colour blobs | Sora |
| Synthwave | dark | Neon pink and cyan, glowing titles, a striped sun and a scrolling grid in the sidebar | Space Grotesk with Orbitron headings |
| Broadsheet | light | Newsprint: column rules, a double rule under the title, blackletter masthead, small-caps labels | Newsreader with Playfair Display headings |
| Arcade | dark | An 8-bit fantasy-console palette, chunky pixel borders, a blinking cursor on the current tab | DotGothic16, Press Start 2P headings, VT323 numbers |

Every theme sets the same tokens at the top of `public/style.css`: surfaces, ink, chart chrome, the gain/loss pair, five accents, status colours, fonts and radii. `data-theme` picks the theme and `data-mode` (dark or light) drives the mode-level tweaks. To add a theme, copy a block, then add it to `THEMES` in `public/app.js` and to the map in the inline script in `index.html`. Fonts come from Google Fonts. Offline, each theme falls back to system fonts.
- **Gains and losses** are a blue/cyan and red/rose pair in every theme, each pair checked against that theme's card colour to stay distinguishable for colorblind viewers. They always appear next to a signed number.
- **The other colors** (violet, indigo, amber, orchid, lime) only decorate cards and never encode data.
