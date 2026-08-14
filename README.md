<!-- markdownlint-disable MD033 -->
# HeadcountFilter

**A Tampermonkey userscript that adds company-size filtering to the LinkedIn job feed** — something LinkedIn's own filters don't offer.

![tests](https://img.shields.io/badge/tests-585%20passing-brightgreen) ![version](https://img.shields.io/badge/version-7.69-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

<!-- TODO: replace with a real GIF — panel open, unchecking a size bucket, cards fading out live.
     See "Screenshots" section below for exactly what to capture. -->

## Why this exists

LinkedIn lets you filter jobs by date posted, experience level, remote/on-site — but not by **company size**. If you specifically want early-stage startups (or specifically want to avoid them, or only want enterprise-scale companies), there's no native way to do that. You end up opening every job, checking the company's profile by hand, and closing the ones that don't fit. I built this to automate that for my own job search — it now runs entirely in the background while I browse normally.

## What it does

- **Filter Sizes panel** — a checklist of LinkedIn's 8 size buckets (1–10 employees … 10,001+). Uncheck a bucket to hide its job cards; "only" isolates a single bucket. A live counter shows how many cards on screen are Cached / Hidden / Unclassified.

- **Full feed coverage** — LinkedIn only renders job cards near your current scroll position, so without this, filtering would silently only apply to the handful of cards already in the DOM. The script sweeps the entire list once per page load, then restores your exact scroll position — invisibly, with no visible jump or flash.

- **Auto-Fetch Unclassified Companies** — for companies not yet known, resolves their size anonymously (no logged-in session cookies ever sent), in order: previously-discovered slug → guessed slug variants from the company name → search-engine fallback (Bing → Google → DuckDuckGo). Backs off adaptively if it hits rate-limit responses, and stops itself rather than escalating indefinitely.

- **Passive capture (free)** — while you browse normally — opening a company page, opening a job's detail pane — the script reads the size that's already sitting on the page. No extra requests, and it's the most reliable source: LinkedIn often hides the size field from anonymous lookups but shows it to a real logged-in view.

- **Inline size badges** — every job card in a list shows a compact size badge next to the company name (e.g. "51-200") so the whole feed is scannable at a glance, not just the one job you have open.

- **Re-verify Stale Companies** — company headcounts drift over time (a 201-500 startup today can be 1,000+ a year later); this periodically re-checks classifications older than a configurable threshold instead of letting them go stale forever.

- **Manage cached companies** — a JSON editor over the full cache, plus Export/Import that **merges** rather than overwrites, so restoring a backup can't clobber data the browser has since learned on its own.

- **Rate-limit aware** — Auto-Fetch and Re-verify share a configurable cooldown between runs, which scales up automatically (2x, then 4x) if the previous run actually hit rate-limiting — protecting the account without needing to think about it.

## Screenshots

*(to add before publishing — I don't have browser access to capture these myself)*

- [ ] Panel expanded: size checklist + live Cached/Hidden/Unclassified counter
- [ ] Before/after: same scroll position, unfiltered feed vs. filtered feed
- [ ] A job card showing its inline size badge
- [ ] Short (5-8s) GIF of toggling a size bucket and watching cards filter live — this is the single most effective thing to put at the top of this README

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open Tampermonkey → **Create a new script**.
3. Delete the placeholder content and paste in the full contents of [`headcount-filter.user.js`](./headcount-filter.user.js).
4. Save (Ctrl+S). Visit any `linkedin.com` page — a **"Filter Sizes"** button appears.

## Usage

1. Click **Filter Sizes** to open the panel.
2. Uncheck any size bucket to hide those companies' jobs from the feed (or click **only** on a bucket to isolate it).
3. Click **Auto-Fetch Unclassified Companies** to resolve companies not yet in the cache — safe to leave running in the background; it's cancellable at any time.
4. Everything persists locally (`localStorage`) — the cache only grows the more you browse.

## Under the hood

The interesting engineering problem here isn't the filtering logic — it's that LinkedIn's markup changes without notice, and a userscript with no error reporting or user base to complain will just quietly stop working. Most of the actual effort went into making failures visible and survivable instead of silent:

- **Self-healing extraction** — every DOM read that matters (company name, job title, etc.) goes through a ranked fallback chain of selectors rather than one hardcoded guess, with live hit-rate tracking recording which selector actually won on each read.
- **Zero-dependency diagnostics** — a "Copy Diagnostics" button dumps a full report (feature health per subsystem, selector hit rates, DOM structure snapshots) as plain text. Every bug in this project's history was fixed from one of these reports — no server, no logging backend, no repro environment needed.
- **585-case regression suite, 100% passing** — re-reads the live script source on every run (rather than testing a hand-copied mirror of the logic) so a passing suite always reflects the code as it currently stands, not a stale snapshot.
- **79 shipped versions**, each gated on the full suite passing plus a custom dead-code audit before release — see [`CHANGELOG.md`](./CHANGELOG.md) for the version-by-version history.

## Testing

```bash
npm test
# or, to also syntax-check both files first:
npm run check
```

No external dependencies — the test suite uses only Node's built-in `fs`/`path`.

## License

[MIT](./LICENSE)
