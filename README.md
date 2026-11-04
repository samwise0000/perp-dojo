# Perp Dojo

A trading dashboard for your Bybit perpetual futures, built from a **read-only** API key and run entirely on your own computer.

It pulls your closed perp trades (USDT/USDC linear and inverse) for exactly the days you choose, caches them locally, and shows three views:

- **Dashboard:**
  - **a recap of your last trading day**, under the daily check-in: its numbers against your usual day (last 30 days), a rules check (trade limit, daily loss limit, no re-entry within 15 min of a loss, no Saturday trading, checked in, journaled), that day's journal entry and every trade with its tags and notes (click one to replay it), and up to four suggestions for today. It uses every trade, not the current filters. Collapse it and it stays collapsed until the next day's recap.
  - **Trade management** on open positions: the count against the 5-position cap, total risk if every stop is hit (in dollars and % of equity), and notes per position: the NY bias against the position (with it, flipped your way since entry, or against it), where it stands in the scaling plan (next add at +1R or +2R, past +2R, or protected), a nudge to let a trade run once it has lasted 8 hours in profit, a warning if it risks more than the plan's 2%, and on weekends (Friday to Sunday) a reminder to hold runners, or, for a position at +1R or better (or with its stop at or past entry and in profit), a suggestion to consider adding on a pullback, sized to risk 1R to the current stop without moving the stop up. Warnings when you're at the cap or have over 6% of equity at risk. Rules in `public/day-playbook.js`.
  - **Today's playbook**, under the warnings: what the 1-year backtest says about trading this weekday in your local time (Tue–Thu strong, Mon mixed, Fri–Sun weak: half size or skip new setups, hold runners through the weekend), the trading day (8 AM to 4 PM your time: only the 08:00, 12:00 and 16:00 closes, rated Prime / OK / Weak for that weekday, each with a countdown, the next one marked and a "between closes: no new trades" note; Monday to Thursday's late closes take only the 🌃 Late A++ at 00:00 and 04:00 (0.5%), the 🌊 NY fade at 04:00 and the 🌙 Midnight sweep at 00:00 (0.25%) (an A where BTC swept the same way mid NY session), at 0.25% risk, for tracking), a live note while the NY session is open, and a collapsible list of the rules for every day (grades, entry, scaling in, what never to do, sizing). `public/day-playbook.js`.
  - **NY bias**, a pill beside the Dashboard title: bullish when the last New York session closed above its open, bearish when it closed below. While today's session runs (8 AM–5 PM ET) it shows **Pending**, with today's move so far beside it, and the last five sessions (the newest one, which sets the bias, glows). It's BTC over the 8 AM–5 PM ET session. Times are New York wall-clock, so daylight saving is handled; weekends have no session, so Monday uses Friday. Public 15-minute candles, refreshed every minute while the dashboard is open.
  - a compact stat row: net P&L, trade win % and day win % (gauges with won/breakeven/lost and green/flat/red counts), profit factor (a ring of gross wins vs. losses), and avg win / avg loss
  - a thin warnings line: the three most serious flags, critical first. It covers overtrading (more than 2 trades in 24h), fees over 10% of winnings, liquidations, revenge trades (reopening within 15 min of a loss), losing streaks, deep drawdown, high leverage, outsized losses and API key expiry. Thresholds are in `WARN` in `public/metrics.js`.
  - **open positions**, live from Bybit and refreshed every 15 seconds while the dashboard is open: unrealized P&L (and on margin; hidden by default behind an eye toggle that also masks the equity card's unrealized figure), entry → mark, distance to liquidation (amber under 10%, red under 4%), stop-loss with what it loses if hit and how much of today's daily loss limit that uses, take-profit with reward-to-risk, how long it's been open (from the last 7 days of fills), and a **Replay** button that charts it up to now with stop-loss, take-profit and liquidation lines. Positions with no stop-loss, within 4% of liquidation, or whose stop-out would break today's loss limit go into the warnings line. Served by `/api/positions` with the same read-only key.
  - a full-width cumulative P&L curve
  - a six-axis trading score with a 0–100 meter
  - a **monthly calendar** of daily P&L with weekly totals; click a day to see its trades
  - account equity, day and trade streaks, and a trading-score radar
  - a 6-month heatmap, this week's P&L, and your best hour
  - timing highlights, all by when trades were opened: the best 2-hour window to open (with a weekday × hour heatmap and the worst window), P&L by session, and the best average hold time. Each links to its Analytics section.
  - performance and risk summaries, and plain-language "what stands out" notes
- **Analytics:** cumulative P&L and drawdown, daily, weekly or monthly P&L, breakdowns by market and long vs short, and the spread of trade outcomes. Plus:
  - **Timing**, counted by when trades were *opened* (default) or closed: a weekday × hour heatmap of where your entries pay, the best and worst 2-hour windows to open (3+ trades each), results by trading session (Asia 00–07, London 07–12, London + New York 12–16, New York 16–21, late 21–24 UTC), and weekday and hour charts. Open times come from your fills, so a trade opened before the pulled range is left out.
  - **Hold time vs outcome:** P&L by how long positions were held, the **best average hold time** (the hold-time bucket with the highest P&L per trade, among buckets with at least 3 trades or 5% of them), and average hold for winners and losers.
  - **Fees and funding:** price P&L → fees → funding → net, costs as a share of gross winnings, cost per trade, wins erased by costs, and costs by month and by market.
- **Journal:** an entry for any day, with that day's stats and trades, a template, a 1–5 discipline rating and tags. Click a day on the dashboard calendar or heatmap to open its entry. Links like `#journal/2026-10-14` go straight to a day. Entries are kept in this browser's local storage for now, per Bybit account, until cloud storage is set up.
- **Weekly review:** one week (Monday to Sunday) at a time, with:
  - the week's stats against last week and your average week
  - P&L by day, and results by strategy
  - a rules scorecard: no Saturday trades, at most 2 trades a day (and what the extra trades cost), daily loss under 4%, checked in, journaled
  - the week's journal entries, and a weekly reflection box
- **Reports:** the written review for one calendar month, on screen, from every trade in it (filters don't apply).
  - It opens on this month. A "So far this month:" line says which days are covered, how many trades and trading days there are, and when data was last pulled.
  - Pick any earlier month from the list, or step through with ‹ ›, to see its full report. The URL remembers it (`#reports/2026-10`).
  - Each month is compared with the one before. A month still in progress is compared with the same days of last month, so a partial month isn't measured against a whole one.
  - If your pulled data doesn't cover the whole month, the report says so.
  - **Save as PDF** prints the month you're looking at.
- **Daily loss limit:** 4% of the equity you started the day with (`WARN.dailyLossPct`). Hitting it brings up a banner and a critical warning, and the Entry wizard says Do not trade. The footer shows today's P&L against the limit.
- **4H close countdown** in the footer. Candles close every 4 hours from 00:00 UTC. It turns amber in the last 30 minutes and orange-red in the last 5.
- **SFP rules** (used by Signals and the Telegram alerts; `public/sfp.js`, no page code, so the same rules run on the server): a swing high is a 4h candle whose body top is above the body tops of the 3 candles before and after it (the candle right after may tie, since each candle opens at the last close); its level is that body top, live for 90 days (so a level from months back still counts in a hard move). A signal is a later 4h candle that wicks past a level by at least 0.1% (a wick that barely touches a level is ignored and doesn't use the level up) and closes back at or inside it, on a level whose swing is at least 10 candles back (a test of an established range, not a fresh wiggle); one signal lists every level it failed at. A short's level must sit in the top 35% of the range over the 7 days before the signal candle, a long's in the bottom 35%. Each level gives at most one signal. BTC's 4h trend (close vs its 50 EMA; within 1% counts as neutral) is reported with each signal but doesn't filter. Candles are cached in IndexedDB. (An SFP scanner tab with adjustable settings used to sit here; Signals replaced it, and old `#scanner` links open Signals.)
- **Forward test:** your live trades against the plan, from a start date you pick (remembered per browser). Each closed position (partial closes grouped by open time) is matched to the signal it came from: same pair and side, opened from an hour before the signal's 4h close to the end of the next candle. It's scored in R by that signal's stop (net P&L ÷ your first order's size × the signal's entry-to-stop distance), next to what the same signal made in the backtest with the adds, so the gap is execution. Shows progress toward 100 trades on plan, a verdict (too early under 20 trades, then whether your average is clearly below, in line with or above what the plan averaged in the year before the start date), results by grade, discipline (took the 👉 pick on busy closes, added to trades, picks missed, runners held), your cumulative R against the plan's, every trade (off-plan ones faded) and the picks you didn't take; click a row for the signal's chart. `public/forward.js`.
- **Strategy:** the whole 4h swing-failure strategy written out, with diagrams: what a swing failure is (body levels, confirmation, age, range edge, sweep), the trade (entry at the close, stop at the wick, target at the opposing level), how every setup is graded (a decision tree, a condition table and a card per grade with what it means, its backtest numbers and how to trade it), which closes take which grades through the week, risk per grade, the scaling plan, how to manage a trade, the ideas tested and rejected, and the caveats. Rules that live in code (risk, closes, RSI cut-off, sweep settings) are read from it; backtest figures are a dated snapshot. `public/strategy.js`.
- **Signals:** (graded A++, A+, A, B+, B, C++ or C like the alerts, with a gold ★ on A++ in the dashboard cards and the grade in the trade guide) every 4h swing failure on your 63-pair watchlist over the last 90 days, 180 days or year, with the same rules and filters as the Telegram alerts (the Balanced preset, whatever the scanner's settings are), so the site and the bot always agree. Each is scored as a **trade**: entry at the signal candle's close, stop at its wick, target at the opposing level (the most extreme opposite swing body between the swept swing and the signal, i.e. where the move into the sweep started; only swings confirmed by the signal's close count; if none is confirmed yet, the move's most extreme candle body). Whichever is hit first decides it; a candle that touches both counts as the stop. Results are in R, before and after Bybit's standard fees (taker in, maker at the target, taker at the stop). A **With adds / First entry only** switch (remembered per browser) picks how trades are scored: with adds runs the scaling plan (add at +1R and +2R, stops to the entry, then to break-even; `scaledResult` in `sfp.js`), so R:R is what the full plan makes at the target and a trade can also end at the entry (✗, the add's 1R) or at break-even (=); the table, summary cards, dashboard tiles and the trade's chart view all follow it. Sort the table by close time, pair, side, grade, R:R, BTC trend or result. Totals split by BTC trend (aligned, countertrend or neutral, from the last 4h candle before the signal, as the alerts report it) and by side; filter by pair, side or trend. Click one to see the trade on the chart: the level from its swing, the target from its swing, red risk and shaded reward zones to where the trade ended. The dashboard shows the latest three beside your open positions (six when nothing is open), with each one's result in R.
- **SFP alerts on Telegram:** 5 minutes before every 4h close, a heads-up listing each pair that would signal if price held, with how far it is from the line (under 0.3% is flagged a close call), the trade (🛑 stop at the wick so far, 💰 target, R:R), a **grade** with the reason (🏆 A++: with yesterday's NY bias, outside the NY session, and BTC swept the same way on the same candle, 2%; 💎 A+: the same without the BTC sweep but with the pair's 4h RSI(14) stretched the trade's way (under 40 for a long, over 60 for a short), 1% for now; 🥇 A: with the bias outside the session and neither, 1%, or with it plus a BTC sweep during it; 🏆 🌃 Late A++: with the bias while the NY session is open, no BTC sweep, 4h RSI stretched, taken at 00:00 and 04:00 Mon–Thu at 0.5% (+1.69R a trade over the year); 🎖️ 🌊 NY fade: that same setup when it also fades a 2%+ NY session at 04:00, 0.25%, tracked on its own; 🥈 B: with the bias while the NY session is open; 🏅 C++: a C that fades a 2%+ NY session at its last close (the NY fade below), tracking only, with fixed 2R and 3R target prices shown; 🥉 C: against the bias or no bias. Over a 1-year backtest these averaged about +1.0R, +0.4R, 0R and −0.13R a trade; best grade listed first) and BTC's trend, followed by a **chart image** of each setup: the last 90 4h candles, the swept level and the target level from their swing candles, the signal arrow, and the position to the right with Entry, SL and TP. Charts are drawn as SVG and rendered to PNG with resvg (`lib/chart-image.mjs`); if rendering fails, the text still goes out. Just after the close, the result: ✅ confirmed, ❌ closed back beyond the level, or 🆕 a setup that only formed in the last 5 minutes. At the 00:00 close (Mon–Thu), an A where BTC swept the same way gets a 🌙 **Midnight sweep** line: taken at 0.25%, tracking (backtest +2.64R a trade over 7 days). At the 4h close in the last 2 hours of the NY session (04:00 in UTC+8), if BTC has moved 2%+ since the session opened and sits in the outer 20% of its range, setups against that move get a 🌊 **NY fade** line and a note (backtest: about +1R a trade over 32 days, positive in both halves; the same fade mid-session lost; tracking only, no change to grades or size; `nyFadeAt` in `lib/sfp-alert.mjs`). When more than 2 setups the plan would take land on one close, the message says so and marks the 2 to take with 👉 pick (A+ first, then the highest R:R; the playbook allows 2 new trades a close and 5 open). When nothing qualifies, the heads-up is a silent one-liner (😴 No setups, with how many pairs were checked and any that couldn't be read), so a quiet channel never means a stalled bot; the result after the close is only sent when there's something to report. Runs on Vercel, so your Mac can be off. See **SFP alerts on Telegram** below.
- **Trades:** a sortable list with CSV export. Filter by tag: any mistake, any good habit, untagged, or one tag. Click any trade (here, in the Journal or in the recap) to **replay** it and add **notes and tags**: preset good-habit tags (Followed plan, A+ setup…) and mistake tags (FOMO, Revenge, Moved stop…), plus your own. Notes and tags are kept per account in this browser, included in Save to server and in the CSV export, and summarized in Analytics → By tag. The replay is a candle chart from Bybit's public market data with the entry and exit marked, the best and worst price while it was open, and ← → to step through trades. Candles come through `/api/klines` (no key used) and are cached in IndexedDB. The chart is TradingView Lightweight Charts v4.2.3 (Apache 2.0), stored in `public/vendor/`.
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

## SFP alerts on Telegram

The alert job is `/api/sfp-alert`, run by a free outside scheduler twice per 4h candle. It reads only Bybit's public candles (no API key) and uses the same rules as the Signals tab on the default pairs. Set `SFP_PAIRS` to watch other pairs.

It keeps no state: both runs rebuild the candle as it stood 5 minutes before the close from 5-minute candles, so the result message knows what the heads-up said.

1. **Make a bot.** In Telegram, message **@BotFather**, send `/newbot`, and follow the steps. Put the token it gives you in `.env` as `TELEGRAM_BOT_TOKEN=...`.
2. **Connect it.** Send your new bot any message, then run `npm run telegram` in your own terminal. It finds your chat, saves `TELEGRAM_CHAT_ID` and a new random `ALERT_SECRET` to `.env`, and sends a test message. It prints no secrets.

   **To post alerts in a channel instead:** add the bot to the channel as an admin that can post messages, post anything in the channel, then run `npm run telegram -- channel`. That saves the channel as `TELEGRAM_CHAT_ID` and posts the test message there.
3. **Add them to Vercel.** Under **Settings → Environment Variables**, add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `ALERT_SECRET` (copy them from `.env`). Optional:
   - `ALERT_TZ`: show times in your zone, e.g. `Asia/Makassar`. Without it, times are UTC.
   - `APP_URL`: your app's address, e.g. `https://your-app.vercel.app`, for an "Open Signals" link.
   - `SFP_PAIRS`: pairs to watch, e.g. `VVV HYPE AAVE`.

   Then redeploy, so the function picks them up.
4. **Schedule it.** Make a free account at [cron-job.org](https://cron-job.org) and create two jobs. On each, set the time zone to **UTC** and add a header under **Advanced → Headers**: `Authorization` = `Bearer <your ALERT_SECRET>`.
   - **Heads-up:** `https://<your app>/api/sfp-alert?phase=pre`, at minute **55** of hours **3, 7, 11, 15, 19, 23**.
   - **Result:** `https://<your app>/api/sfp-alert?phase=close`, at minute **0** of hours **0, 4, 8, 12, 16, 20**.
5. **Check it.** Use cron-job.org's **Test run** on each job. Adding `&dry=1` to the address returns the message without sending it; `phase=test` sends the "connected" message.

**Or run it from your Mac** instead of Vercel and cron-job.org (use one or the other, or every alert arrives twice):

- `npm run alerts:on` adds a launchd job (the Mac's own scheduler) that runs at minute 55 and minute 0 of every hour while you're logged in and the Mac is awake, and comes back after a restart. Each run works out whether it's a heads-up, a result or nothing; a Mac waking from sleep after a heads-up was due skips it rather than sending it late.
- `npm run alerts:status` shows whether it's on and the last few runs; the full log is `~/Library/Logs/perp-dojo-alerts.log`.
- `npm run alerts:off` removes it.
- `npm run alerts -- pre --dry` prints what a heads-up would say right now, without sending.

A sleeping Mac (lid closed, or idle sleep) misses alerts. To keep it awake while plugged in: System Settings → Battery → Options → "Prevent automatic sleeping when the display is off".

Things to know:

- **Price can move in the last 5 minutes.** A heads-up is "if it closed now". Wait for the ✅ before treating it as a signal.
- **Cost:** two short function runs per 4 hours, each about 45 public candle requests. Well inside Vercel's and Bybit's free limits.
- **Secret:** without the right `ALERT_SECRET` the endpoint answers 401, so nobody else can trigger messages. If it ever leaks, change it in `.env`, Vercel and both cron jobs.

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
| Sakura | light | Hanami at full bloom, holding nothing back: a pink dusk sky with a pale moon, cherry branches swaying in both top corners, glowing paper lanterns swinging, a blizzard of petals and blossoms (some over the cards), gusts that sweep flurries of petals across, petals trailing the cursor, spinning blossom bullets, a brush-script title with a pink shimmer | M PLUS Rounded 1c, Yuji Syuku headings |
| Terminal | dark | Phosphor green on black, scanlines, square corners | JetBrains Mono |
| Atelier | light | Thick ink borders, offset shadows, a yellow hero card | DM Sans with Fraunces headings |
| Dojo Ink | dark | Lacquer brown with gold | Zen Kaku Gothic New with Shippori Mincho headings |
| Glass | dark | Frosted, translucent panes over slowly drifting colour blobs | Sora |
| Synthwave | dark | Neon pink and cyan, glowing titles, a striped sun and a scrolling grid in the sidebar | Space Grotesk with Orbitron headings |
| Broadsheet | light | Newsprint: column rules, a double rule under the title, blackletter masthead, small-caps labels | Newsreader with Playfair Display headings |
| Arcade | dark | An 8-bit fantasy-console palette, chunky pixel borders, a blinking cursor on the current tab | DotGothic16, Press Start 2P headings, VT323 numbers |
| Deep Sea | dark | The abyss at midnight: swaying light rays and glowing plankton, about two dozen fish, sharks, whales, octopuses and jellyfish swimming across behind see-through cards, coral and kelp swaying on the sea floor, bubbles rising (a few drift over the cards too), and a jellyfish in the sidebar | Lexend, Righteous headings |
| Blueprint | dark | White linework on cyanotype blue, a drafting grid, dashed construction lines, "Sheet 1 of 1" under the title | IBM Plex Mono, Architects Daughter headings |
| Waves | light | Calm and zen: a dawn sky with a soft glowing sun and slowly turning rays, four layers of swells rolling along the bottom of the screen at different speeds and gently rising and falling, seagulls gliding across and flapping now and then (most fly over the cards; they never block clicks), see-through cards, a mincho title | Nunito, Shippori Mincho headings |
| Notebook | light | Ruled paper with a red margin, ballpoint ink, hand-drawn card edges, highlighter on the title | Patrick Hand, Caveat headings |
| Comic Book | light | Halftone dots, thick ink outlines with hard shadows, tilted panels, a yellow title with a red drop, and a POW! burst that pops every few seconds | Comic Neue, Bangers headings and numbers |
| Groovy | light | 1973: a mustard-and-rust sunburst rising from the bottom, chunky brown outlines, a triple-shadow Shrikhand title, rainbow stripes down the sidebar | Fredoka, Shrikhand headings |
| Kyoto | light | Japan at dawn: washi cards over a landscape drawn for the app (a snow-capped mountain and a rising sun, a five-storey pagoda on the hills, a vermilion torii, a dojo hall, windswept pines and a cherry tree), mist drifting past, sakura petals falling (a few over the cards), and a red 道 seal after the title | Zen Kaku Gothic New, Shippori Mincho headings |
| Beige Box | light | A 90s desktop: teal background, grey bevelled windows, every card heading a blue title bar with _ □ ×, raised and pressed buttons | Tahoma, Silkscreen title |

Every theme sets the same tokens at the top of `public/style.css`: surfaces, ink, chart chrome, the gain/loss pair, five accents, status colours, fonts and radii. `data-theme` picks the theme and `data-mode` (dark or light) drives the mode-level tweaks. To add a theme, copy a block, then add it to `THEMES` in `public/app.js` and to the map in the inline script in `index.html`. Fonts come from Google Fonts. Offline, each theme falls back to system fonts.
- **Gains and losses** are a blue/cyan and red/rose pair in every theme, each pair checked against that theme's card colour to stay distinguishable for colorblind viewers. They always appear next to a signed number.
- **The other colors** (violet, indigo, amber, orchid, lime) only decorate cards and never encode data.
