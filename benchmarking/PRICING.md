# Dashboard pricing

Open `/benchmarking/ui/pricing.html`, or **Pricing** in the benchmark navigation.
The page combines the current model catalog with saved runs, including older
models that have disappeared from a harness. It refreshes every five minutes
while visible; **Refresh prices** forces both model and pricing discovery.
Run counts are not shown in pricing rows.

## Automatic updates

The read-only report service starts `PricingService` automatically, including
when started by `npm start`. No browser tab or benchmark run is needed. It
checks each source every six hours, retries failures after five minutes, and
refreshes overdue sources on startup. Independent requests have timeouts,
size limits and conditional ETags. No model calls, API keys or paid tokens are
needed. Sources are:

- OpenAI, Claude, Grok and Meta official Markdown pricing tables.
- Gemini's paid Standard tables, including dated introductory-price changes.
- Kimi's literal pricing table data embedded in its official HTML (never executed).
- Prime's live catalog, always separate from direct-provider prices.
- models.dev's structured direct-provider catalog as a labeled fallback.

New model IDs and supported pricing rows are discovered without editing a model
list. Standard and Fast are read separately; no universal Fast multiplier is
assumed. Explicit provider aliases map to their documented models. Subscription
catalogs and all-zero placeholders are excluded. Missing fields stay unknown;
prices from a different hosting route are never substituted.

Validated snapshots persist atomically in ignored
`.mazebench/pricing/catalog.json`. Price changes append observed/effective date
boundaries, so future updates do not reprice earlier recorded responses. Legacy
cumulative-only usage cannot be split by price period and is labeled as using
current rates. Initial discovery
cannot reconstruct unpublished historical rates; estimates identify their
observation date. The report worker reloads this file automatically without
restarting agents. Last working data survives offline use and process restarts.
Malformed data, negative rates, missing table schemas or unexpectedly shrunken
catalogs keep previous prices and produce a visible source warning. A changed
provider schema may require an adapter update; no scraper can promise to handle
arbitrary future formats. Published prices are automatic, unpublished prices
cannot be manufactured.

The pricing page exposes source health, checked times and errors under
**Automatic pricing sources**. **Unpublished** identifies researched
subscription/internal models with no public API rate. **Incomplete** identifies
published rates with missing fields. Prime's null cache price does *not* mean
caching is disabled: existing DeepSeek and Qwen runs report substantial cached
input. Provider-reported complete response costs take precedence over estimates.

`token-pricing.mjs` is the shared, dashboard-only price registry and calculator.
Its bundled rates are an offline fallback. Automatic adapters use rates in this order:
input, cached input, short cache writes, output, extended cache writes. Record
Fast rates and per-request long-context premiums separately. Unknown prices
stay null; zero is reserved for a published free rate. An explicit null route
price never falls back to a different provider. Prime prices come from its
live model catalog and remain separate from direct-provider rates.

The page marks unrecognized rates **Missing** and gaps in input, cached input, cache
writes or output **Incomplete**. **Configured** describes available rates,
not a promise that a subscription was charged that amount. Source links and
check dates make the distinction visible. Proxy prices, if added, must include
an `estimated` explanation naming the source model.

Codex estimates use each deduplicated response's usage, timestamp and speed
history. Input includes cache reads/writes; subtract these before charging
ordinary input. Long-context premiums apply to individual responses, never
the run's combined input. Reasoning tokens already included in output are not
charged again.

The read-only playback/report service on port 8085 also serves token reports.
It can reload dashboard pricing without restarting any process that owns
benchmark runs. The UI falls back to the existing owner API on installations
without this report endpoint. Signed benchmark runtimes and records are not
changed by price updates.

Verify with `node --test tests/benchmark-pricing-refresh.test.mjs tests/benchmark-pricing.test.mjs
tests/benchmark-live-tokens.test.mjs tests/benchmark-token-telemetry.test.mjs`.
