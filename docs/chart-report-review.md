# Chart and market-report review — 2026-09-08

## Scope and evidence

Reviewed commits `ebbcd48` and `a6bb14e`, their combined current implementation, chart geometry and validation, both interactive and standalone SVG rendering, Markdown grouping and CSS, and the complete user/assistant history in session `1788829855-1046928-1410a70e70d3` under `~/.dext/projects/dextui-workspace-4c7a0e053767006f/sessions/`.

The final assistant message is record 162 in `_latest.jsonl`. Compared it with `~/dextui-workspace/reports/tue-0908-market-brief.md`, the four saved normalized datasets under `reports/runs/0908/`, and their generating Python tools. The session and source report were not rewritten. These are historical snapshots, not refreshed trading data or independently authenticated market prices.

## Code findings and disposition

| Severity | Finding | Disposition |
|---|---|---|
| High | `a6bb14e` accidentally included the concurrent `Block.svelte` import/removal for `looksLikeDiff`, but not the helper export. That commit alone cannot build. | Pending helper and tests committed as `813ee33`; no history rewrite. |
| High | `niceTicks` used repeated floating-point addition with no bound. For domain `[1e16, 1e16 + 2]`, a sub-ULP step never changes the accumulator, freezing the UI. Subnormal steps could produce invalid/empty output. | Bounded index iteration, finite-step fallback and deduplication; worker-thread timeout regression test. |
| High | Fixed domains excluding zero left vertical-bar baselines outside the plot, creating giant rectangles and misplaced labels. | Shared bounded `barTrack` geometry; both endpoints clipped; directional outlier labels tested for positive-only and negative-only domains. |
| Medium | Hbar dragging used a frozen inverse domain but a live rendered domain. Removing a negative value or reducing the maximum changed the axis under the pointer. Ranked rows also moved mid-drag. | Freeze the rendered domain and sort permutation until pointer release; real pointer-capture browser regression. |
| Medium | Standalone `renderChartSVG` silently ignored `domain` and `sort`, and still drew negatives from the left baseline. | Reuse shared domains, zero-anchored tracks, signed rankings, ticks and outlier labels. |
| Medium | Line charts accepted fixed domains but drew unbounded lines and points over surrounding content. | Clip actual line segments to a plot viewport in both renderers; do not flatten out-of-range samples. |
| Medium | A forced 2px fill invented positive bars at zero and let small negative bars cross their zero baseline. | Geometric zero is zero; transparent hit targets preserve editing of zero/tiny interactive bars. |
| Medium | Clipped negative hbar labels jumped back to zero; long positive labels could overflow the SVG. | Keep labels near their endpoints, switch anchor when outside space is insufficient; browser bounding-box regression. |
| Medium | Fixed-domain parsing coerced null, booleans and arrays to numbers; invalid sort options silently disappeared. | Require two finite numeric endpoints with finite positive span and validate sort enumeration. |
| Medium | Initial sort captured only the first prop and generated Svelte warnings. | Derived spec default with a separate user override; zero Svelte warnings. |
| Medium | Final report chart glyphs shrank to about 7.4px at 1440px viewport and 5.3px in a 900px viewport, despite nominal 10px SVG text. | Tape grids respond to the message container, stack below 1000px, and retain at least 500px chart content with local horizontal scrolling. Original non-tape card sizing retained. |
| Low | Numeric currency cells were classified as numbers but signed currency values were not tinted. | Match optional currency prefix in sign detection; browser test. |

## Final report: what was verified

- Eight tables, ten valid chart specs, five table/chart tape groups.
- All five chart pairs have identical dataset IDs and identical source label ordering; independent signed sorting does not break index-based cross-highlighting.
- All 138 plotted values match the intended saved records within displayed rounding. An initial symbol-only lookup falsely selected Binance-Peg DOGE instead of Dogecoin; disambiguating by name resolves it. This illustrates why symbols alone are not safe identities.
- No chart exceeds the 31-category cap. Positive/negative outliers remain labeled; missing AMC seven-day history is omitted rather than fabricated as zero.
- Numeric tint is per cell, not a row-level class. Alternating row backgrounds remain separate; adjacent negative cells can visually resemble a tinted row.
- Replayed the exact final assistant message through the current UI on an isolated mock host. Verified all ten charts, bounded page width, readable tape chart minimum width and responsive stacking at 1440, 900 and 390px; no browser errors.
- The report file is not the same artifact as the final chat: the file has three charts while the chat has ten, narrower tables and additional plotted selections. “Unchanged in data” does not mean a byte-for-byte or complete re-render. The final chat omits the tooling section and some detail/flags.

## Report errors and important omissions

| Severity | Evidence | Correction or limitation |
|---|---|---|
| High | `tools/swing_screen.py:31` computes `(High - Low).tail(14).mean()` and calls it ATR. | This is average daily range, not true range/ATR. True range must include absolute gaps from previous close; Wilder smoothing also differs from a simple mean. The ATR table, chart and ATR-based stop rules cannot be relied on as labeled. Raw OHLC was not retained, so correct historical ATR cannot be reconstructed from the summary JSON. |
| High | SMH is 567.01 and saved MA50 is 573.97; report calls a 50-day reclaim a +5% target. | The saved difference is +1.227%, before fees/slippage, not +5%. A 5% price target would be about 595.36. Friday-high entry levels are not stored in the summary either. |
| High | Source flags are `wash?`, but narrative and final table declare wash trading. “None” becomes “cleanest” or “best risk-adjusted.” | Volume/liquidity is only a heuristic, not evidence proving wash trades or safety. No holder concentration, mint/freeze authority, transfer tax, honeypot/sell simulation, LP control, or contract audit was performed. Market cap/FDV ratios do not establish an unlock calendar. |
| High | Catalyst dates were guessed after a failed BLS parse; PPI was said to follow CPI the next day. Apple timing and FOMC blackout effects were asserted without a verified schedule. | Treat all event timing as unverified. Verify official BLS/Federal Reserve/issuer calendars before using a trading plan. Blackout does not imply rates are driven only by scheduled data. No live calendar verification was performed in this code review. |
| Medium | CNPY is described as violating a no-pools-under-48h rule. Saved age is 51.7h. | It passes that age cutoff but is under one week old; rejection needs a distinct reason. |
| Medium | Saved 52-week metrics use max/min of daily closes. `global_indexes.py` computes YTD from the first current-year close, not the prior year-end close. | Label as trailing-year closing-price range and first-session-to-date change, or recompute from appropriate history. These are not standard intraday 52-week highs/lows or calendar YTD returns. |
| Medium | `auto_adjust=False` Close series drive ETF momentum/MA calculations without retained corporate-action checks. | Distribution/split effects and adjusted-vs-unadjusted return definitions must be checked before comparing ETFs. Date-only `asof` does not establish quote freshness or session completion. |
| Medium | `gt_trending.py` deduplicates by `(chain, symbol)`, not token/pool identity, while `crypto_scan.json` itself contains two different DOGE assets. | Symbol collisions can drop legitimate pools or mix identities. Retain contract and pool IDs; the final report should include chain-specific pool links/addresses, already available in saved data. A pool's age is not the token's age. |
| Medium | GeckoTerminal cap filtering falls back to FDV and then zero when cap is unknown; unknown caps can pass. Buy ratio zero is skipped by a truthiness check. | Distinguish unknown market cap from verified sub-$2B cap and explicitly test `is not None` for flow ratios. Volume and buy counts do not establish dollar net inflow or accumulation. |
| Medium | `gt_trending.py` retains 154 symbol-deduplicated candidates, called “154 pools”; only first-page trending/top-volume endpoints were collected. | Coverage is selected and non-exhaustive, not a market-wide scan. Saved files are normalized summaries, not raw provider responses. |
| Medium | The final report drops DEBIT's `fdv>>mcap` flag, all on-chain 1h changes, source URLs/identities, and the tooling section. | Do not call it an entirely lossless re-render. Preserve those details in a corrected report or explicitly label the chat as a condensed version. |
| Medium | “Risk per day” chart labels average high–low range as risk; targets and stops differ from the common 1.5x/3x rule. A gap is said to cost a third of $100 without calculation. | Range is not a daily loss bound or forecast. Stops do not cap gap/slippage losses. Explain discretionary sizing, avoid unsupported loss estimates, and state whether equity/crypto allocations share the same $100. |
| Medium | BTC dominance is a single snapshot, used to infer alt-season rotation; no funding/liquidations/dominance time series was delivered. | A current share alone is not a trend. “Rotation, not trend,” “accumulation,” and a thematic leadership ranking are hypotheses, not conclusions established by these snapshots. |

A disclaimer does not fix these methodology and provenance issues. The report is useful as a historical watchlist and UI fixture, but is not a verified, execution-ready trading plan. Correcting historical calculations requires OHLC/corporate-action data and source verification, not merely changing displayed numbers.

## Remaining presentation and coverage limits

- The two-column tape intentionally preserves table grouping and stacks charts on the right. Tall paired charts still leave whitespace under a shorter left table; this is not masonry. The reviewer did not silently reorder sections or change approved ordinary card sizing to hide that tradeoff.
- On narrow screens chart content scrolls locally instead of becoming microscopic; wide tables also scroll locally. Long unrestricted units/very large formatted values and dense grouped-bar labels can still overlap; the added bounds tests cover the report and representative signed outliers, not every possible string.
- Native Edge review was requested via the user's `edge_browser` pack. Invocation and doctor check found relay and Windows bridge active, but Windows Edge CDP down. Browser restart was not authorized, so no user-profile Edge navigation occurred. Clean-room `agent-browser` performed the replay/interaction checks and captured screenshots instead. Screenshots were captured, not manually image-inspected by a vision tool in this review.
- The final response was replayed in isolation; a live authenticated full-transcript screen was not inspected. Historical session records were read, not mutated.
- Existing standalone multi-series line/legend parity, arbitrary new-spec replacement of chart edit state, all-keyboard chart editing and extreme numeric overflow beyond the tested tick cases are not claimed fully covered by this patch.

## Reproduction

`npm test` runs the unit suite, existing UI smoke and the new `apps/web/scripts/chart-review-test.sh`. The latter checks fixed-domain bars/line clipping, signed-currency cell tint, clipped label bounds, a real hbar drag with frozen domain/order, linked selection after sorting, and responsive widths. Browser tests visibly skip when `agent-browser` is unavailable.

For an existing Markdown report: `REPORT_FILE=/absolute/report.md REPORT_CHARTS=10 SCREENSHOT_DIR=/tmp/report-shots bash apps/web/scripts/chart-review-test.sh`. The mock's `MOCK_MARKDOWN_FILE` environment option reads only the operator-supplied local fixture. It does not expose filesystem selection to a browser client and does not launch any real model.
