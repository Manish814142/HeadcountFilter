/*

HeadcountFilter - LinkedIn Job Feed Company Size Filter - Version 7.69

Features (kept in sync with the code whenever a feature is added, changed, or removed — this
describes what the script does NOW; for the history of how it got here, see CHANGELOG.md):

- Company Size Filter panel — a "Filter Sizes" button that expands into a checklist of the 8
  LinkedIn size buckets (1-10 ... 10,001+ employees). Unchecking a bucket hides job cards for
  companies in it; "only" isolates a single bucket. A live counter shows Cached / Hidden /
  Unclassified totals for the cards currently on screen.

- Full-list auto-render (forceRenderAllVisibleCards()) — LinkedIn lazily mounts job cards as the
  user scrolls near them, so "the cards currently on screen" above would otherwise mean only
  whatever happened to already be in the DOM at that moment (reported live: "Unclassified: 1" on
  open, "Unclassified: 9" after manually scrolling down the SAME page). Once per genuinely new
  list view (a fresh page load or pagination change — NOT on every job click within the same
  list, see getListSignature()), it runs several top-to-bottom sweeps (runOneRenderSweep(), each
  stepping down roughly a viewport at a time and waiting for the readable card count to go quiet)
  until a sweep turns up nothing new, then restores exactly where the scroll position was. The
  container itself is found structurally (findScrollableAncestor(), walking up from a real card
  looking for genuine overflow) rather than a guessed class name. The whole operation is invisible:
  the list is faded out for its entire duration and revealed once — including across sweeps — only
  after the scroll position is confirmed settled back where the user left it.

- Hide unclassified until known — optional toggle to hide job cards for companies not yet in the
  cache at all, instead of showing them (unfiltered) by default.

- Auto-Fetch Unclassified Companies — for companies not yet cached, tries to anonymously
  determine their LinkedIn size, in order:
    1. Slug cache lookup — a previously-discovered LinkedIn company-page slug for this name.
    2. Candidate slug guessing (generateCandidateSlugs()) — tries likely LinkedIn slug variants
       derived from the company name (legal-suffix stripping, camelCase splitting, dropped
       first/last word, common suffix/prefix patterns, capped at MAX_CANDIDATE_ATTEMPTS
       requests per company).
    3. Search-engine fallback (Bing, then Google, then DuckDuckGo) to locate the company's
       LinkedIn page when direct guessing fails.
  Every request goes through makeAnonymousRequest(), which sets anonymous: true on
  GM_xmlhttpRequest — no logged-in session cookies are ever sent for these lookups. A result is
  only trusted if verifyPageMatchesCompany() confirms the fetched page's own <title> plausibly
  matches the target company name (catches a guess that landed on a different, real company).
  Companies that fail resolution are remembered (failedCache) and skipped on future runs for
  FAILED_COOLDOWN_MS before being retried, instead of re-attempting every time. Cancellable
  mid-run (the button doubles as Cancel while fetching, checked at three points so a click lands
  within one in-flight request rather than waiting out a full company's guess budget) and
  non-blocking throughout — progress and the final summary appear as inline text under the
  button (setFetchStatus()) instead of a blocking alert() that used to hold up the page.
  Adaptive backoff: an HTTP 429/503 (an explicit rate-limit signal, distinct from a normal 404
  or authwall) doubles the delay used for every subsequent request, capped at
  MAX_BACKOFF_DELAY_MS, and resets to baseline the moment a non-rate-limit outcome is seen. If
  backing off still isn't enough — MAX_CONSECUTIVE_RATE_LIMITS consecutive 429/503s — the whole
  run stops itself rather than continuing to escalate indefinitely, and a company whose only
  failure was a rate-limit response is never put on a 7-day cooldown for it (that failure wasn't
  the company's fault, and it would likely resolve fine on a later run).

- Passive capture (zero extra network requests) — reads a company's real size directly out of
  pages you were already going to view yourself, while logged in:
    - captureCompanyPageIfPresent() — visiting a company's own /company/<slug> page.
    - captureFromJobDetailPane() — opening a job and viewing the "About the company" / inline
      size module in the right-hand detail pane.
  This is the most reliable source of data — LinkedIn frequently hides the "Company size" field
  from anonymous requests but shows it to a real logged-in view. Also re-verifies: an already-
  cached company isn't skipped anymore on a fresh live view — if the current value differs from
  what's cached (sizes drift over months/years), the cache is updated; if it matches, the entry is
  just re-timestamped as confirmed-current. A MANUAL_EDIT entry is the one exception, never
  silently touched by this. Costs nothing extra — it rides on browsing you're already doing. Also
  captures the company's slug (extractCompanySlugFromDetailPane()) whenever one isn't on file yet —
  a company only ever encountered by clicking through jobs used to have no slug at all, making it
  permanently unreachable by anything that needs one (e.g. a future re-verify sweep). Scoped to the
  same two regions already trusted for size extraction, not a blind document-wide search — a
  document can also render an unrelated sidebar with other companies' own /company/ links mixed in.

- Job detail company badge — shows "🏢 X employees | Y on LinkedIn" inline on the right side of
  the company name, right after it ends, on the open job's top card — on the jobs list/search
  layout, the recommended-jobs iframe layout, and a standalone /jobs/view/<id> tab opened on its
  own. Reads the same detail-pane module passive capture uses (scanCompanyInlineInfo(), including
  its findAboutCompanySection() fallback for pages that don't expose the usual container), but is
  purely cosmetic — it never writes to any cache, so it can't affect filtering even if it briefly
  shows stale text during a job switch. Always on. Attaches to whichever header element
  findBadgeHeader() locates — checked in two passes across every accessible document (top document,
  then each iframe): first, a named-selector match anywhere, so a real match in one document (e.g.
  an iframe holding the actual open job) can never lose to a weaker fallback match that happens to
  fire in an earlier document (e.g. a top document holding only the job list); only if no document
  has a named match anywhere does a second pass try the structural rungs, in order:
  findAriaLabelledCompanyLink(), findTopCardCompanyLink(), then findScopedCompanyLink(), same
  per-document order as the named pass. Never a blind, document-wide search for any
  /company/ link — a page also showing a job list has one such link per list card, and an unscoped
  search can grab the wrong one before ever reaching the actual open job's header.
  findAriaLabelledCompanyLink() (v7.63) leads the structural rungs because it selects by IDENTITY
  rather than position: it matches [aria-label^="Company, "] — the page's own accessibility label for
  the employer, observed on four different companies via the v7.62 DOM capture — and returns the
  enclosing /company/ anchor, so the badge renders exactly where it always did. The rung below it
  picks the first /company/ link that isn't in a list card or the about-section, which is document
  ORDER; the same captures showed pages carrying several unrelated employers' links (companies named
  in the job description), where ordering was the only thing keeping the badge on the right one.
  An accessibility label also survives the CSS-module class hashing that killed every named selector
  on that layout.

- Inline card size badges — every job card in a list (search results, recommended, "connections
  hiring", any layout getCardElements() covers) shows a small compact badge next to the company
  name for any company already in the cache (e.g. "10K+", "51-200") — updateCardSizeBadge(),
  driven by the same per-card bucket lookup filterJobListCards() already does to decide
  hide/show, so it costs no extra scanning. Makes the whole list scannable at a glance instead of
  only ever showing size information for the one job you've opened. Attached as a sibling right
  after the exact element getCardInfo() already identified as the company name (not nested inside
  it, since that element is sometimes a link) — one badge per card, kept in sync in place rather
  than recreated every cycle.

- Copy unclassified names — copies the list of not-yet-cached company names in the current view
  to the clipboard.

- Manage cached companies — opens a JSON editor over the full cache (company name -> size
  bucket). Save validates that every value is one of the 8 canonical buckets before accepting an
  edit; Clear All wipes the cache after confirmation. The heading also shows a "Last verified"
  breakdown (formatCacheFreshnessSummary()) — how many entries were confirmed in the last 30 days,
  6 months, a year, longer, or have no timestamp at all (cached before v7.8) — built entirely from
  provenance data already being tracked, so it costs nothing new to show.

- Re-verify Stale Companies — periodically re-checks already-classified companies whose value
  hasn't been confirmed in a while (company sizes drift: a startup at 201-500 today can be
  501-1,000 a year later), so nothing sits silently out of date forever just because nobody happens
  to click through that company's jobs again. Choose "older than 6 months" or "older than 1 year"
  (default) from the dropdown next to the button. Only reaches companies with a KNOWN slug
  (slugCache) — goes straight to the confirmed page, never guesses, so this stays a pure
  verification feature with none of Auto-Fetch's candidate-guessing ambiguity risk; a company only
  ever passively captured with no recorded slug needs one click-through first (v7.28) to become
  reachable. No separate cooldown on which COMPANIES are eligible exists or is needed — re-verifying
  an entry resets its own timestamp, so it can't come up again for a full threshold period regardless
  of how often this is clicked; most days simply find nothing due yet. (A different, cross-RUN
  cooldown — how often the sweep itself may be started at all — does exist; see below.) Shows a
  rough time estimate and how many more companies are due-but-unreachable (no slug yet) before asking
  to confirm. Saves incrementally per company exactly like Auto-Fetch, reuses its exact
  sequential-with-delay pacing and adaptive 429/503 backoff, and refuses to run at the same time as
  Auto-Fetch (both make anonymous requests off the same connection). Tagged with its own distinct
  provenance source (CACHE_SOURCE.REVERIFY_SWEEP) so the history stays honest about how a value was
  last confirmed. A MANUAL_EDIT entry stays permanently excluded — UNLESS an explicit slug override
  has been added for it in Manage Company Pages, which counts as deliberate consent to let it
  participate again; a slug picked up incidentally (e.g. getCardInfo() reading it off a list card,
  which happens with no MANUAL_EDIT protection at all) does not count, only a real override does. On
  its first successful re-check afterward, such an entry graduates to the normal REVERIFY_SWEEP
  source and stops needing this special case at all going forward.

- Cross-run cooldown (Auto-Fetch / Re-verify) — a minimum wait, configurable in the panel (2/5/10
  minutes, 5 default), enforced between the END of one Auto-Fetch or Re-verify run and the START of
  the next — shared between both, since they're mutually exclusive and carry the same connection/IP
  risk. Exists because their per-run adaptive backoff (candidateDelayMs/companyDelayMs/
  consecutiveRateLimitHits) is declared fresh inside each function call — nothing previously stopped
  triggering a brand-new run at full baseline speed the instant one run finished, e.g. clicking
  Auto-Fetch, moving to a new page, and clicking again immediately with no pause at all. Scales with
  what the LAST run actually observed rather than one flat number for every outcome: a clean run uses
  the base value, a run that hit some rate-limiting but recovered uses 2x, and a run that fully
  auto-stopped from sustained rate-limiting (MAX_CONSECUTIVE_RATE_LIMITS) uses 4x — so the one case
  where the script itself already concluded something was wrong gets more protection, not the same
  treatment as an uneventful run. Applies even when the run was cancelled partway through, since by
  the time a click can land, at least one real request has already gone out — a cancelled run isn't a
  zero-footprint run. Persisted to localStorage (not just in-memory), so it survives a page reload or
  a fresh tab, not only continuous browsing within one page's lifetime. Building this also surfaced
  and fixed a related gap: Auto-Fetch previously never checked whether Re-verify was already running
  (only the reverse direction was guarded) — both directions are now symmetric.

- Backup & restore (Export / Import & merge, in the cache manager) — Export downloads the whole
  cache as a dated JSON file (companies, their resolved LinkedIn slugs, and provenance — see
  below). Import reads one back in and MERGES it: new companies are added, anything already
  cached is kept as-is and reported as a conflict rather than silently overwritten, so importing
  another machine's backup can't destroy what this browser already learned. Import accepts both
  the exported file format and a bare {"company": "bucket"} object (what the editor textarea has
  always shown), and rejects a file whole if any entry has an unrecognized size bucket. Matters
  because the cache otherwise lives only in this browser's localStorage — one "clear browsing
  data" and hundreds of passively-captured companies, which Auto-Fetch cannot rebuild, would be
  gone permanently.

- Multi-tab safe storage — every write to the caches re-reads what's actually on disk first and
  merges in anything another tab learned, instead of blindly overwriting with this tab's own copy.
  Each tab loads these maps once at page start and never re-reads them, so with two LinkedIn tabs
  open (passive capture writes in every one of them) whichever tab saved last used to silently erase
  everything the other had captured since. On a genuine conflict — the same company with different
  values in both — the entry with the newer companyCacheMeta timestamp wins, since a more recent
  verification is by definition the better answer. Deliberate deletions still stick: a slug evicted
  by a definitive 404 is excluded from the merge that follows it, and the cache manager's Save /
  Clear All write authoritatively (no merge) so entries the user just removed aren't resurrected.

- Manage Company Pages — a dedicated view (separate from the size cache manager, opened via its
  own button) for the LinkedIn page each cached company resolves to. Lists every cached company's
  current page (an override if one is set, else the auto-discovered slug, else "no page known") and
  its source, so fixing one no longer means exporting the whole cache and diffing it by hand to even
  find which company needs attention. Clicking "Edit" on a row pre-fills the override box below with
  that exact key already typed in — the one genuinely tedious part of the old flow (copying a
  normalized name by hand without a typo) — and Save writes it as a slug override. Both this and the
  size cache manager order companies newest-touched first (getCompanyNamesByRecency(), from
  companyCacheMeta.timestamp) rather than raw insertion order or alphabetically — a batch a run of
  Auto-Fetch or the re-verify sweep just touched surfaces at the top of both, not buried at the
  bottom of one and scattered alphabetically through the other.
  Deliberately still a read-only table with edits going through one shared JSON box, not a fully
  inline-editable grid — the cheaper version of two designs discussed, kept for when the cache is
  small enough that browsing a plain list is enough; worth revisiting only if that stops being true.

- Company page overrides — a manual, human-authored map pinning a company to a specific LinkedIn
  page (normalized name -> slug), edited in Manage Company Pages. Kept separate from the
  auto-discovered slugCache on purpose: that one is machine-managed (auto-filled when missing,
  auto-evicted on a 404), so a hand-typed correction living there would be destroyed by the next
  failed fetch and have to be re-entered. An override always wins, is never touched by any automatic
  path, and is carried through Export/Import. Every consumer reads through getSlugFor() so a
  correction takes effect everywhere at once — Auto-Fetch's first tier, the re-verify sweep, and its
  eligibility/ETA/unreachable counts. Manage Company Pages also lists how many cached companies have
  no known page at all, matching the table below it exactly — every company with no page counts,
  including a MANUAL_EDIT-sourced one (the re-verify sweep would still never reach it regardless of
  slug, but the table shows it either way, and the count has to agree with what's actually on screen
  or it stops being trustworthy).

- Name-collision detection — cache keys are NORMALIZED company names (lowercased, legal suffixes
  stripped, punctuation collapsed), which is what lets "Acme Pvt. Ltd." and "Acme" share one entry.
  The same mechanism can also collapse two genuinely different companies onto one key, and then one
  company's size is silently served for the other — the same class of wrong-data bug as the v6.5
  Handshake incident, reached a different way. Detected for free from data already being read: if
  one normalized key is ever seen pointing at two different real LinkedIn slugs, that's two
  companies sharing a key, not one company written two ways. Reported in Manage Company Pages with
  the names involved, comparing against each company's currently RESOLVED page (override or
  auto-discovered) rather than the raw auto-discovered value directly — a company already fixed by
  an override doesn't keep getting re-flagged just because its now-unused stored slug still disagrees
  with the correct one. Deliberately not auto-"fixed" — the script can't know which company the
  cached size belongs to, so the resolution is a slug override; and renormalizing to make keys unique
  would orphan every existing entry at once.

- Movable, tabbed panel — the panel is dragged by its own button, remembers where it was put
  (plus whether it was left open and which tab was active) across page loads, and validates a
  restored position against the CURRENT viewport, falling back to the default corner rather than
  stranding itself off-screen somewhere it could never be dragged back from. Its controls are
  grouped into three tabs — Filter (the size checkboxes, "only" links, hide-unclassified), Fetch
  (run cooldown, Auto-Fetch, Re-verify and their status lines), and Data (copy unclassified, manage
  cache) — instead of one long scrolling column.

- Cache provenance — every cache entry silently records HOW it was obtained (a real logged-in
  page view, an anonymous auto-fetch — and if so, via which of its three tiers, from the least to
  most trustworthy: a previously-known slug, a blind candidate guess, or a search-engine lookup —
  a manual edit, or an import) and when. Stored separately from companyCache itself (a parallel
  {name: {source, timestamp}} map, not a change to what every existing part of the script reads
  as a plain bucket string), so it costs nothing to every function that already reads the cache.
  Surfaced today as a one-line summary in the cache manager ("Sources: 120 company page · 90 job
  detail · 40 auto-fetch (guessed) · ..."); recorded now specifically so a future feature can
  target re-verification at the riskiest tier (auto-fetch candidate guesses — the exact mechanism
  behind the v6.5 Handshake wrong-company bug) or the oldest entries, instead of everything.

- Cache self-sanitization — on load, strips any cached entry whose value isn't one of the 8
  canonical size buckets (guards against stale/malformed data left over from older versions of
  this script, or a bad manual edit).

- Cross-frame architecture — on some page layouts LinkedIn renders the actual job list inside a
  same-origin iframe. This script only ever runs from the top-level frame (it returns
  immediately if loaded inside an iframe) and reaches into any accessible iframe's DOM itself
  (getSearchDocuments()) rather than running a second, independent copy inside it.

- Feature health tracking — every DOM-touching feature (panel, filtering, company-page capture,
  job-detail capture, the company badge, the full-list scan) reports what actually happened on its
  last attempt via setFeatureHealth(): ok (working normally), fallback (working, but only because
  a primary detection path missed and a fallback caught it — see the badge's five named
  BADGE_HEADER_SELECTORS vs. its two structural fallbacks), idle (nothing to do right now), or
  failed (definitively could not do its job). runCycle() isolates each step through runFeature()
  so one feature throwing can never block a sibling later in the same cycle — previously all five
  shared one try/catch. Two consumers read this: the Data-tab status view below, and the Diagnose
  report. "fallback" is judged per LAYOUT, not per rung (isExpectedBadgeRung()): on the componentkey
  build — hashed class names, no <h1>, confirmed live in v7.5/v7.48 and again in v7.62 — none of
  BADGE_HEADER_SELECTORS can exist at all, so findTopCardCompanyLink() winning there is the mechanism
  v7.48 built for that layout working as intended, not a degradation, and reports ok. On a layout
  where a named selector genuinely could have matched, the same rung still reports fallback. A rung
  that reports a permanent warning is a warning that stops being read.

- Silent-breakage detection — filtering and passive capture are the two features that do their work
  invisibly, and both used to be able to stop working COMPLETELY while reporting themselves healthy:
  runFeature() only ever meant "didn't throw", getCardInfo() returning null makes a card be skipped
  silently (correct — cards genuinely mount before their content hydrates), and the panel's "Cached"
  figure is the whole cache's size rather than this page's. A renamed company-name class would have
  produced no filtering, no card badges, and "Everything working normally". Both now report from
  what they actually ACHIEVED:
    - reportCardYieldHealth() compares job cards FOUND against job cards READ. The signal is
      self-normalizing — the containers found are themselves the proof that cards exist here — so it
      needs no "is this a jobs page?" URL guessing. Sustained zero-yield reports failed; a sustained
      partial yield reports fallback; everything is graced for CARD_YIELD_GRACE_MS first, because
      containers legitimately outrun their content on every page load. A separate probe of
      card-specific ATTRIBUTES (data-occludable-job-id, componentkey) catches the opposite failure:
      job cards demonstrably present while CARD_CONTAINER_SELECTORS matches none of them.
    - detailYieldVerdict() tracks the last DETAIL_YIELD_WINDOW distinct jobs viewed and reports
      failed only when every one of them yielded no readable company info. Deliberately conservative
      — LinkedIn genuinely omits the size field for many real companies, so one empty read is not
      evidence, and an outcome is recorded once per job (on switching away) rather than once per
      retry tick, so a single size-less company can never fill the window by itself.
  All of it is measurement: it sets health strings and touches nothing else, so a mistuned threshold
  can show a spurious warning but can never hide a card or cache a wrong value.
  As of v7.66 everything past panel injection is gated on isJobRelevantPage() — a subtree
  MutationObserver on a busy page (feed, messaging) otherwise dragged a full cycle behind every
  mutation. The gate lives in runCycle rather than in @match because Tampermonkey matches at document
  load and LinkedIn is an SPA: narrowing @match to /jobs/* would mean starting on the feed and
  navigating into jobs never starts the script at all. Here the gate is free to be wrong — the 1s
  poll re-evaluates it, so an SPA navigation resumes everything within a second, and the skipped
  features report 'idle' with a reason rather than passing silently.

- Job-title contradiction guard (v7.66) — the card company rung of last resort picks by POSITION
  (first childless <p> with text), so it fails by choosing the WRONG element rather than none, and a
  wrong pick is written to companyCache under a garbage key. There is no positive semantic anchor for
  the company name on that layout (established v7.65 — the only labelled element is the dismiss
  button, and it labels the job TITLE), but there is a negative one: "the company name is exactly this
  card's own job title" is a flat contradiction, not a heuristic. findCardJobTitle() reads the title
  from the job link's own aria-label (locale-independent) or the dismiss button's English
  "Dismiss <title> job" phrasing, and yields null on anything else — no title means no check, never a
  guess. Exact match only: a substring test would flag the very common "Software Engineer at Acme"
  against a real company called Acme. A contradiction makes getCardInfo() return null rather than
  merely logging, because wrong data is worse than none (v6.4/v6.5) — and an unreadable card counts
  against the filtering yield, so a broad misfire raises the alarm above instead of poisoning the cache.

- Transient company-miss tracking (v7.68, mechanism corrected v7.69) — proves, rather than merely
  explains, that a card's OUTER container can mount before its INNER company element does, and a
  "(no match)" read on such a card is expected to resolve later rather than staying broken.
  extractCardJobId() (the same href/data-attribute/componentkey read getCardInfo() already needed for
  a successful card, now shared with the failure path too) identifies each miss by the card's own job
  ID, and recordTransientCompanyMiss()/recordTransientCompanyResolution() record how long it actually
  took to resolve, or flag it if it never does.
  v7.68's own comment guessed the resolve would land within roughly one poll cycle (a few hundred ms),
  by analogy with v7.19's unrelated container-count finding — the FIRST live data this produced (16
  resolutions at avg 11502ms / max 11503ms, near-identical across every one of them) disproved that
  specific guess outright: the real number sits just under FORCE_RENDER_TIMEOUT_MS (12000ms), and 16
  different cards resolving within 1ms of each other is only explicable as one shared event, not 16
  independent small delays. The real mechanism is that a card can mount as an empty container during a
  force-render sweep and only receive its real content once that sweep's own lazy-loading settles —
  the resolve is tied to the SWEEP finishing, not to the next runCycle poll. The qualitative claim this
  was built to test (transient, not broken) held up; the specific timescale in the original comment did
  not, and is corrected here rather than left standing now that real numbers exist. Reported in the
  Diagnose report directly under the selector hit-rate section it explains — resolutions clustering
  under FORCE_RENDER_TIMEOUT_MS confirm this mechanism; a growing "still pending" or "given up on" count
  would mean a real, sustained problem instead. Purely diagnostic: it reads outcomes that already
  happened and cannot change what gets filtered, cached, or displayed. Bounded so the tracking map can
  never grow without bound across a long scrolling session — a miss still unresolved past
  TRANSIENT_MISS_GIVE_UP_MS (30s, comfortably above the observed ~11.5s norm) is dropped outright, on
  the assumption it scrolled off-screen rather than got permanently stuck.

- Selector attribution — every selector chain in this file is a list of guesses, and recordSelectorHit()
  now records which guess actually fired, per chain (card.company, badge.header), surfaced as hit
  rates in the Diagnose report. A rung dropping from 100% to 0% is the earliest possible signal that
  LinkedIn shipped a markup change — the state that silently preceded the v7.45/v7.48 and v7.58 badge
  incidents. queryWithAttribution() issues the chain as one comma-joined querySelector exactly as
  before and only then asks the winning element which selector it matched: attribution must not alter
  what it measures, and a sequential rewrite WOULD have (comma-joined returns the first match in
  document order, sequential returns the first in selector order — different elements on any card
  carrying both a subtitle class and a /company/ link). Session-only, never persisted.

- Data-tab status view — a passive, always-current summary in the panel's Data tab
  (renderFeatureHealthPanel()), refreshed every cycle. Only ever lists features currently
  fallback or failed; when nothing is flagged it shows one static "Everything working normally"
  line rather than a row per feature, so a healthy panel looks the same at a glance every time.
  Exists specifically to make a silently-degraded fallback path (the exact state that preceded two
  live incidents in one week — see CHANGELOG.md v7.45-v7.48) visible same-day instead of only
  noticeable once it stops working entirely.

- Diagnose button ("🩺 Copy Diagnostics") — an on-demand deep dump (buildDiagnosticReport()) of
  script version, current URL, list signature, the full feature-health state for every tracked
  feature, per-chain selector hit rates (see Selector attribution above) alongside a fresh count of
  what each CARD_CONTAINER_SELECTORS entry and the card-attribute probe match right now, two targeted
  card views — buildCardTextInventory() (every element in the first job card carrying its OWN text,
  with ancestor path, child count and any aria-label) and describeCardCompanyExtraction() (what each
  company rung actually PICKS from that card, plus what getCardInfo() ultimately resolved). Those two
  exist because the card rung's failure mode is selecting the WRONG element rather than none — a
  location or a "Viewed" label cached as a company name — which no hit rate can detect. DOM
  skeletons of the two regions every markup incident so far has hinged on (a job card, and the badge
  header's surrounding region — renderElementSkeleton(): tag names, class names, attribute names and
  values, and each element's DIRECT text only, bounded by depth, siblings-per-level and a hard total
  node budget, so what to REPLACE a broken selector with is answerable from the first report instead
  of needing a throwaway diagnostic shipped first, as v7.5/v7.27/v7.48 each did), and a
  structural probe of the current page (heading counts, which named badge selectors
  matched, /company/ links found and where, what the top-card link resolves to, and any embedded
  JSON payloads found in <code>/<script type="application/json"> elements via
  scanEmbeddedJsonPayloads() — SSR/hydration data LinkedIn may embed directly in the page rather
  than fetching client-side, reported as a COUNT only as of v7.66 (the per-payload structure dump it
  used to print produced one actionable finding in many sessions and ~20 lines of bulk in every
  report, which has to be pasted by hand), still including a one-level unwrap of LinkedIn's "datalet"
  wrapper (a real response double-encoded as a JSON string inside its own `body` field) so the size
  search below can see inside it) repeated for every
  accessible document. Also runs findSizeLikeFields() against every payload found — a direct search
  for any key name that looks like a company-size field (employeeCount/companySize/staffCount/
  numberOfEmployees, case-insensitive) at any depth, reporting the exact key PATH and the value's
  type only, aggregated into a dedicated closing section of the report. Copies straight to the
  clipboard for pasting into a bug report. Deliberately structure-only — counts, booleans, hrefs
  (already-public /company/<slug> URLs), shapes, paths — never page text or real values. Replaces
  most of what used to require a hand-written console snippet and a screenshot. (v7.52-v7.54 also
  added a passive fetch()-interception observer here, aimed at the same eventual goal — reading
  company size from LinkedIn's own JSON instead of scraping HTML/CSS. Removed in v7.60: confirmed
  working technically, but real job/company traffic never once appeared through it despite extensive
  live testing, while carrying real cost — an elevated `unsafeWindow` permission and an early
  `@run-at document-start` load just to support it. Not worth keeping around unused; see
  CHANGELOG.md v7.60 if this is ever worth revisiting.)


Changelog — moved to CHANGELOG.md (in this same folder) as of v7.44, to keep this header focused
on current behavior. That file has the full version-by-version history (v6.3 through v7.43),
kept in sync on every version bump exactly as this block used to be.

*/

// ==UserScript==
// @name         HeadcountFilter — LinkedIn Job Feed Company Size Filter
// @namespace    http://tampermonkey.net/
// @version      7.69
// @description  Filters job feed cards by cached company size; auto-fetches unclassified companies anonymously without using your logged-in cookies.
// @author       Manish
// @match        *://*.linkedin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      www.linkedin.com
// @connect      linkedin.com
// @connect      *.linkedin.com
// @connect      www.bing.com
// @connect      bing.com
// @connect      *.bing.com
// @connect      html.duckduckgo.com
// @connect      duckduckgo.com
// @connect      *.duckduckgo.com
// @connect      www.google.com
// @connect      google.com
// @connect      *.google.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // v6.11: architectural change — this script now does NOTHING at all when it's running inside
    // an iframe. Five iterations (v6.6-v6.10) tried to have every matching frame independently
    // guess "am I the one that should show the panel," each guess a little narrower than the
    // last, each still leaving a gap (confirmed live: two panels landing at genuinely different
    // screen heights, each "position: fixed; top: 130px" relative to its OWN frame's viewport —
    // proof this was always a real multi-frame situation, not a single bug to patch away). Rather
    // than guess again, only the top frame runs anything now; see getSearchDocuments() below for
    // how it reaches into the iframe that actually holds the job cards (same-origin linkedin.com,
    // so direct DOM access works) instead of relying on a second, independently-injected copy of
    // this whole script running inside it.
    if (window.top !== window.self) return;

    // --- Config & Storage Keys -------------------------------------------
    // v7.49: single source of truth for the version string — button.innerText and the diagnostic
    // report both need it, and it was already manually duplicated across the header comment and
    // the @version tag above; a third/fourth hand-typed copy is exactly how those drift.
    const SCRIPT_VERSION = '7.69';
    const UI_PANEL_ID = 'linkedin-size-filter-panel';
    const AUTO_FETCH_STATUS_ID = 'linkedin-size-filter-fetch-status';
    const REVERIFY_STATUS_ID = 'linkedin-size-filter-reverify-status';
    const BADGE_ID = 'linkedin-size-filter-company-badge';
    const FEATURE_HEALTH_PANEL_ID = 'linkedin-size-filter-health-panel';
    const BADGE_STALE_GRACE_MS = 4000;
    const CACHE_KEY = 'linkedin_company_size_cache_v3';
    const SLUG_CACHE_KEY = 'linkedin_slug_cache_v1';
    // v7.35: manual, human-authored slug corrections. Deliberately a SEPARATE map from slugCache
    // rather than just letting people edit that one: slugCache is machine-managed (auto-filled when
    // missing, auto-evicted on a definitive 404), so a hand-typed correction living there would be
    // silently destroyed by the next 404 and have to be re-entered. An override always wins and is
    // never touched by any automatic path.
    const SLUG_OVERRIDES_KEY = 'linkedin_slug_overrides_v1';
    // v7.35: see recordSlugObservation() for what this detects and why it matters.
    const NAME_COLLISIONS_KEY = 'linkedin_name_collisions_v1';
    const PANEL_STATE_KEY = 'linkedin_size_filter_panel_state_v1';
    const PREFS_KEY = 'linkedin_size_filter_prefs_v3';
    const HIDE_UNCACHED_KEY = 'linkedin_hide_uncached_v3';
    const FAILED_CACHE_KEY = 'linkedin_failed_company_cache_v1';
    const FAILED_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const CACHE_META_KEY = 'linkedin_company_cache_meta_v1';
    // v7.32: see RUN_COOLDOWN_OPTIONS below for why these exist.
    const RUN_COOLDOWN_STATE_KEY = 'linkedin_size_filter_run_cooldown_state_v1';
    const RUN_COOLDOWN_MINUTES_KEY = 'linkedin_size_filter_run_cooldown_minutes_v1';

    // v7.8: how a companyCache entry was obtained — not equally trustworthy. company-page /
    // job-detail-pane come from a real logged-in view of the actual page; auto-fetch-slug-cache
    // and auto-fetch-search-fallback still verify the fetched page's title against the target
    // name; auto-fetch-candidate-guess is the riskiest of the three (a blind guess that happened
    // to 200 and pass title verification) — this is exactly the shape of the v6.5 Handshake bug,
    // where a guess landed on a real, differently-owned company sharing the target's name.
    const CACHE_SOURCE = {
        COMPANY_PAGE: 'company-page',
        JOB_DETAIL_PANE: 'job-detail-pane',
        AUTO_FETCH_SLUG_CACHE: 'auto-fetch-slug-cache',
        AUTO_FETCH_CANDIDATE_GUESS: 'auto-fetch-candidate-guess',
        AUTO_FETCH_SEARCH_FALLBACK: 'auto-fetch-search-fallback',
        MANUAL_EDIT: 'manual-edit',
        IMPORTED: 'imported',
        // v7.30: distinct from AUTO_FETCH_SLUG_CACHE even though the underlying request is
        // identical (known slug -> fetch -> verify) - this is a genuinely different EVENT (a
        // scheduled re-check of an already-classified entry, not an initial classification), and
        // this file has always kept provenance precise enough to answer "how did I actually learn
        // this" rather than collapsing distinct events into one bucket.
        REVERIFY_SWEEP: 'reverify-sweep'
    };

    const SIZE_BUCKETS = [
        '1-10 employees',
        '11-50 employees',
        '51-200 employees',
        '201-500 employees',
        '501-1,000 employees',
        '1,001-5,000 employees',
        '5,001-10,000 employees',
        '10,001+ employees'
    ];

    const RUN_DEBOUNCE_MS = 200;
    const RUN_POLL_FALLBACK_MS = 1000;
    // v7.13: LinkedIn lazily renders job list cards as the user scrolls near them — the counter
    // and Auto-Fetch were only ever seeing whatever's currently mounted, not the true total on the
    // page.
    // v7.14: reported live — the v7.13 fix still undercounted (auto-stopped at 2, manual scroll
    // found 5-6 more). Root cause: "2 consecutive unchanged 150ms polls" declared victory while
    // LinkedIn's actual lazy-load fetch (a real network round trip) was still in flight, since
    // 150ms x 2 is often shorter than that fetch takes. FORCE_RENDER_POLL_INTERVAL_MS is how often
    // to re-check the count (and re-issue the scroll jump — harmless no-op if already at the
    // bottom); FORCE_RENDER_QUIET_MS is how long the count must stay UNCHANGED, in real elapsed
    // time, before concluding loading has genuinely finished, replacing the old fixed-poll-count
    // heuristic with one that adapts to however long the fetch actually takes.
    // FORCE_RENDER_TIMEOUT_MS is the hard overall cap so a page that never stabilizes can't hang.
    const FORCE_RENDER_POLL_INTERVAL_MS = 200;
    const FORCE_RENDER_QUIET_MS = 900;
    const FORCE_RENDER_TIMEOUT_MS = 12000;
    // v7.20: reported live — even after correctly finding the real container AND correctly
    // waiting for card CONTENT (not just containers) to settle, the pass still permanently
    // plateaus well short of the true total (confirmed: finalParseableCount 14 vs
    // finalContainerCount 32, never catching up no matter how long the quiet window waits).
    // Jumping straight to scrollTop = scrollHeight every poll apparently doesn't give this list's
    // virtualization the same incremental signal a real scroll gesture would. Floor for how far
    // each step advances — container.clientHeight is used as the actual step size (roughly one
    // viewport at a time, mimicking a real scroll), with this as a minimum in case clientHeight is
    // ever tiny/zero, so a step can never be too small to make real progress.
    const FORCE_RENDER_MIN_STEP_PX = 150;
    // Hard cap on sweeps within a single force-render run, so a page whose card count somehow never
    // stops growing can't sweep forever and hijack the user's own scrolling.
    const FORCE_RENDER_MAX_SWEEPS = 5;
    // v7.25: how many sweeps always run before the "did anything new appear?" check is allowed to
    // stop the loop. Two is the minimum that can detect "the first sweep reached the then-current
    // bottom before a slow network had even started responding" — the exact race behind the
    // v7.13-v7.23 undercounting saga. Note this is a count of sweeps WITHIN one invocation, not of
    // separate invocations: v7.21/v7.23 put the retry loop in runCycle, so each retry was its own
    // call to forceRenderAllVisibleCards(), and each call hid and then revealed the list — which
    // the user saw as a flicker between passes ("for the instance/milli-second I see left side
    // panel and then again it goes invisible"). Sweeping inside one invocation fixes that (one
    // hide, one reveal for the whole operation) AND removes the v7.23 deadlock class outright,
    // since consecutive sweeps no longer restore the user's scroll position in between — parking
    // back at the top between attempts was what killed the lazy-load stimulus in the first place.
    const FORCE_RENDER_GUARANTEED_SWEEPS = 2;
    // v7.22: reported live — the final "scroll back to where the user actually was" step visibly
    // got stuck partway roughly half the time. A single instant scrollTop assignment isn't
    // guaranteed to stick: the browser clamps it to whatever scrollHeight the container reports
    // at that instant, and LinkedIn's own virtualization can still be reconciling scrollHeight (or
    // overriding scrollTop itself, e.g. recycling far-off cards) for a moment after a big
    // programmatic jump like our sweep. Re-asserting the target and re-checking a few times over a
    // short bounded window catches both cases without needing to know which one is happening.
    const FORCE_RENDER_RESTORE_SETTLE_POLL_MS = 100;
    const FORCE_RENDER_RESTORE_SETTLE_TIMEOUT_MS = 800;
    const LEGAL_SUFFIX_PATTERN = /\b(pvt\.?|private|limited|ltd\.?|llc|inc\.?|corp\.?|corporation|co\.?|company|gmbh|fzco)\b/gi;

    // Cap blind slug guesses per company to prevent rate limiting
    const MAX_CANDIDATE_ATTEMPTS = 20;

    // v7.12: adaptive backoff for Auto-Fetch. Previously every delay was fixed regardless of what
    // the last request actually did — a real HTTP 429 (rate limited) got treated identically to a
    // normal 404, and the run just kept going at the same pace. These are the base/floor delays
    // (doubled on each rate-limit signal, reset to these the moment a non-rate-limit outcome is
    // seen); BASE_CANDIDATE_DELAY_MS/BASE_COMPANY_DELAY_MS intentionally match the fixed values
    // this replaces, so normal (non-throttled) runs behave exactly as before.
    const BASE_CANDIDATE_DELAY_MS = 250;
    const BASE_COMPANY_DELAY_MS = 1500;
    const MAX_BACKOFF_DELAY_MS = 30000;
    // How many consecutive rate-limit signals to tolerate (each doubling the delay) before giving
    // up on the whole run rather than continuing to hammer an endpoint that has explicitly asked
    // to be backed off from.
    const MAX_CONSECUTIVE_RATE_LIMITS = 4;

    // HTTP 429 (Too Many Requests) and 503 (Service Unavailable, commonly used for throttling
    // too) are unambiguous rate-limit signals from the server. Deliberately NOT authwall/login
    // redirects or plain 404s here — those are already understood elsewhere in this file (see
    // v6.3) as normal, expected outcomes unrelated to throttling, not something backing off helps
    // with; treating them as rate-limit signals would make the backoff fire constantly under
    // completely normal operation instead of only when actually being throttled.
    function isRateLimitSignal(error) {
        return !!error && (error.message === 'HTTP 429' || error.message === 'HTTP 503');
    }

    // v7.32: reported live — chaining Auto-Fetch/Re-verify across page navigations with no pause
    // (click, move to next page, click again) never gave the per-run backoff above a chance to
    // matter, because candidateDelayMs/companyDelayMs/consecutiveRateLimitHits are declared fresh
    // inside EACH call to autoFetchUnclassifiedCompanies()/reverifyStaleCompanies() — a run that
    // just backed all the way off from repeated 429s has no way to tell the NEXT run (triggered
    // seconds later on a different page) that anything happened at all. This is a separate,
    // macro-level cooldown between the END of one run and the START of the next, independent of
    // page navigation — enforced by a real elapsed-time check instead of left to the user to
    // remember. Scales with what the LAST run actually observed rather than a single flat number
    // for every outcome: a run that finished clean poses less ongoing risk than one that had to
    // fully stop itself after hitting MAX_CONSECUTIVE_RATE_LIMITS, and treating both the same would
    // under-protect the one case where the script itself already concluded something was wrong.
    const RUN_COOLDOWN_OPTIONS = [
        { label: '2 minutes', minutes: 2 },
        { label: '5 minutes', minutes: 5 },
        { label: '10 minutes', minutes: 10 }
    ];
    const DEFAULT_RUN_COOLDOWN_MINUTES = 5;
    const RUN_COOLDOWN_TIER_MULTIPLIER = { clean: 1, rateLimited: 2, autoStopped: 4 };

    // Words that should never be queried as standalone company slugs
    const JUNK_SLUGS = new Set([
        'pvt', 'private', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'corp', 'corporation',
        'co', 'company', 'group', 'services', 'solutions', 'technologies', 'technology', 'gmbh',
        'fzco', 'the', 'and', 'for', 'with', 'from', 'app', 'ai', 'io', 'hq', 'com', 'org', 'net'
    ]);

    // Reserved path slugs in search engines that are not company slugs
    const RESERVED_SLUGS = new Set([
        'company', 'jobs', 'about', 'careers', 'life', 'people', 'posts',
        'login', 'signup', 'setup', 'search', 'school', 'showcase', 'feed', 'checkpoint', 'authwall'
    ]);

    // --- State -----------------------------------------------------------
    let userPreferences = loadJson(PREFS_KEY, defaultPreferences());
    let companyCache = loadJson(CACHE_KEY, {});
    let slugCache = loadJson(SLUG_CACHE_KEY, {});
    let slugOverrides = loadJson(SLUG_OVERRIDES_KEY, {});
    let nameCollisions = loadJson(NAME_COLLISIONS_KEY, {});
    let failedCache = loadJson(FAILED_CACHE_KEY, {});
    // v7.8: { normalizedName: { source, timestamp } } — deliberately a SEPARATE map, not a change
    // to companyCache's value shape. companyCache[name] is read as a plain bucket string in a
    // dozen+ places (filter checks, categorizeSize comparisons, the JSON editor, the v7.6 backup
    // merge conflict check); changing that shape to an object would mean touching and re-verifying
    // every one of those sites for one feature. A parallel map keyed the same way gets the same
    // information without any of that risk — every existing read of companyCache keeps working
    // completely unmodified.
    let companyCacheMeta = loadJson(CACHE_META_KEY, {});
    let hideUncached = localStorage.getItem(HIDE_UNCACHED_KEY) === 'true';
    let isFetchingUnclassified = false;
    let cancelFetchRequested = false;
    // v7.30: separate flags from Auto-Fetch's above, deliberately — the two are mutually exclusive
    // (both make sequential anonymous requests off the same IP; running both at once would double
    // the effective request rate this whole file has been built around avoiding), but they're
    // conceptually different operations with different buttons/status lines, so sharing one flag
    // pair would make it ambiguous which operation a click was cancelling.
    let isReverifying = false;
    let cancelReverifyRequested = false;
    // v7.32: the user-chosen base cooldown length, and the outcome of whichever run (Auto-Fetch OR
    // Re-verify) finished most recently — shared between both, since they're mutually exclusive and
    // carry the same connection/IP risk. lastAnonymousRunState is { finishedAt, tier } or null (null
    // = no run has ever finished in this browser yet, so there's nothing to wait on).
    let runCooldownMinutes = Number(localStorage.getItem(RUN_COOLDOWN_MINUTES_KEY)) || DEFAULT_RUN_COOLDOWN_MINUTES;
    let lastAnonymousRunState = loadJson(RUN_COOLDOWN_STATE_KEY, null);
    const checkboxRefs = {};
    const lastRenderedText = {};

    // v6.5: strip any cached entries whose value isn't one of the 8 canonical SIZE_BUCKETS —
    // leftover malformed data from earlier extraction bugs (e.g. raw "1 employee" / "2-10
    // employees" text that was never a real LinkedIn size bucket). These entries silently never
    // matched any filter checkbox and couldn't be caught except by manually opening "Manage
    // cached companies", so this self-heals on load instead.
    (function sanitizeCompanyCache() {
        let removedCount = 0;
        for (const name of Object.keys(companyCache)) {
            if (!SIZE_BUCKETS.includes(companyCache[name])) {
                delete companyCache[name];
                removedCount++;
            }
        }
        if (removedCount > 0) {
            console.warn(`[Size Filter] Removed ${removedCount} cached compan${removedCount === 1 ? 'y' : 'ies'} with an unrecognized size bucket.`);
            saveCache();
        }
    })();

    // v7.8: prune meta entries whose company no longer exists in companyCache (e.g. removed by
    // the sanitization pass just above, Clear All from an older version, or a manual edit that
    // deleted a key) — otherwise companyCacheMeta grows stale entries forever with nothing to
    // ever clean them up.
    (function sanitizeCacheMeta() {
        let removedCount = 0;
        for (const name of Object.keys(companyCacheMeta)) {
            if (companyCache[name] === undefined) {
                delete companyCacheMeta[name];
                removedCount++;
            }
        }
        if (removedCount > 0) saveCacheMeta();
    })();

    function defaultPreferences() {
        const defaults = {};
        SIZE_BUCKETS.forEach((bucket) => { defaults[bucket] = true; });
        return defaults;
    }

    function loadJson(key, fallback) {
        const saved = localStorage.getItem(key);
        if (!saved) return fallback;
        try {
            return JSON.parse(saved);
        } catch (err) {
            console.warn(`[Size Filter] Corrupt data for ${key}, resetting.`, err);
            return fallback;
        }
    }

    function savePreferences() {
        localStorage.setItem(PREFS_KEY, JSON.stringify(userPreferences));
    }

    // v7.35: every save used to be a blind `localStorage.setItem(KEY, JSON.stringify(inMemoryMap))`.
    // Each tab loads its own copy of these maps once, at page start, and never re-reads them — so
    // with two LinkedIn tabs open (entirely normal), whichever tab saved LAST silently erased
    // everything the other one had learned since. Not hypothetical: passive capture writes on every
    // job you click, in every open tab, and this is the same mechanism behind the "my localStorage
    // edit got reverted" behaviour seen while debugging a bad slug by hand.
    //
    // Fix (technique borrowed from LinkedIn Jobs Curator's saveAppliedLog): re-read what's actually
    // on disk immediately before writing, fold in anything another tab added that we don't have,
    // then write the union. `excludeName` exists because some deletions are deliberate — evicting a
    // 404'd slug would otherwise be instantly resurrected from the stored copy on the very next
    // merge, making eviction a no-op.
    //
    // Conflict rule for a company present in BOTH with DIFFERENT values: the entry whose
    // companyCacheMeta.timestamp is newer wins. That's the whole point of tracking provenance — a
    // more recent verification is by definition the better answer, whichever tab made it.
    function mergeStoredIntoMemory(excludeName) {
        const storedCompanies = loadJson(CACHE_KEY, {});
        const storedMeta = loadJson(CACHE_META_KEY, {});
        const storedSlugs = loadJson(SLUG_CACHE_KEY, {});
        const tsOf = (meta) => (meta && typeof meta.timestamp === 'number') ? meta.timestamp : 0;

        for (const [name, bucket] of Object.entries(storedCompanies)) {
            if (name === excludeName) continue;
            // Same guard sanitizeCompanyCache() applies on load — never adopt a malformed value
            // from another tab that happens to be running an older version of this script.
            if (!SIZE_BUCKETS.includes(bucket)) continue;
            const ourBucket = companyCache[name];
            if (ourBucket === undefined) {
                companyCache[name] = bucket;
                if (storedMeta[name]) companyCacheMeta[name] = storedMeta[name];
            } else if (tsOf(storedMeta[name]) > tsOf(companyCacheMeta[name])) {
                // Newer verification wins — including when the value is unchanged, so "last
                // verified" reflects the most recent confirmation across all tabs rather than
                // going backwards to whenever this tab happened to load.
                companyCache[name] = bucket;
                companyCacheMeta[name] = storedMeta[name];
            }
        }
        // Provenance for a company we already had but have no meta for (e.g. cached before v7.8).
        for (const [name, meta] of Object.entries(storedMeta)) {
            if (name === excludeName) continue;
            if (companyCache[name] !== undefined && !companyCacheMeta[name]) companyCacheMeta[name] = meta;
        }
        // Slugs are additive only: a company's slug essentially never changes once known, so
        // there's no conflict to resolve — whoever discovered it first is right.
        for (const [name, slug] of Object.entries(storedSlugs)) {
            if (name === excludeName) continue;
            if (slugCache[name] === undefined) slugCache[name] = slug;
        }
    }

    // `merge` is opt-out rather than opt-in: every incremental writer (passive capture, Auto-Fetch,
    // the re-verify sweep, import) is purely additive and must not clobber another tab. The only
    // callers that pass merge:false are the cache manager's Save and Clear All, where the user's
    // explicit intent IS to replace/empty the whole map — merging there would resurrect exactly the
    // entries they just deleted.
    function saveCache({ merge = true, excludeName } = {}) {
        if (merge) mergeStoredIntoMemory(excludeName);
        localStorage.setItem(CACHE_KEY, JSON.stringify(companyCache));
    }

    function saveSlugCache({ merge = true, excludeName } = {}) {
        if (merge) mergeStoredIntoMemory(excludeName);
        localStorage.setItem(SLUG_CACHE_KEY, JSON.stringify(slugCache));
    }

    function saveFailedCache() {
        localStorage.setItem(FAILED_CACHE_KEY, JSON.stringify(failedCache));
    }

    function saveSlugOverrides() {
        localStorage.setItem(SLUG_OVERRIDES_KEY, JSON.stringify(slugOverrides));
    }

    // v7.35: the single source of truth for "which LinkedIn page belongs to this company".
    // A manual override always wins over whatever the automatic paths discovered — that's the
    // entire point of it. Every consumer (Auto-Fetch tier 1, the re-verify sweep and its
    // eligibility/ETA checks) goes through here rather than reading slugCache directly, so a
    // correction takes effect everywhere at once instead of only in whichever place got updated.
    function getSlugFor(normalizedName) {
        return slugOverrides[normalizedName] || slugCache[normalizedName];
    }

    function saveNameCollisions() {
        localStorage.setItem(NAME_COLLISIONS_KEY, JSON.stringify(nameCollisions));
    }

    // v7.35: every cache key here is a NORMALIZED company name — lowercased, legal suffixes
    // stripped, punctuation collapsed (see normalizeCompanyName). That is deliberate and load-
    // bearing: it's what lets "Acme Pvt. Ltd." on one card and "Acme" on another share one entry.
    // But it also means two genuinely DIFFERENT companies can collapse onto the same key, and when
    // they do, one company's size is silently served for the other — the same class of wrong-data
    // bug as the v6.5 Handshake incident, just reached by a different route.
    //
    // The tell is observable and needs no extra requests: if the same normalized key is seen
    // pointing at two different real LinkedIn slugs, it isn't one company written two ways, it's
    // two companies sharing a key. Recorded here, surfaced in the cache manager, and resolvable by
    // the user with a slug override — deliberately NOT auto-"fixed", because the script cannot know
    // which of the two the cached size actually belongs to. Renormalizing to make keys unique isn't
    // an option either: it would orphan every existing entry in the cache at once.
    //
    // v7.37: compares against getSlugFor() (the RESOLVED slug), not raw slugCache, directly — a
    // company with an override in place has slugCache permanently frozen at whatever it was before
    // (every write site guards `if (!getSlugFor(name))`, so it can never be updated again), so
    // comparing against that stale value would falsely re-flag an already-fixed company as a
    // "collision" every single time its real, correct page is visited again. Comparing against the
    // resolved value instead means: agrees with what's actually being used -> not a collision;
    // disagrees (a genuine THIRD slug showing up) -> still flagged, since that's still worth
    // surfacing even for a company that already has an override for a different pairing.
    function recordSlugObservation(normalizedName, observedSlug) {
        if (!normalizedName || !observedSlug) return false;
        const known = getSlugFor(normalizedName);
        if (!known || known === observedSlug) return false;
        const seen = Array.isArray(nameCollisions[normalizedName]) ? nameCollisions[normalizedName] : [];
        const merged = seen.slice();
        for (const slug of [known, observedSlug]) {
            if (!merged.includes(slug)) merged.push(slug);
        }
        if (merged.length === seen.length) return true; // already recorded, nothing new to persist
        nameCollisions[normalizedName] = merged;
        saveNameCollisions();
        return true;
    }

    function countNameCollisions() {
        return Object.keys(nameCollisions).filter((n) => (nameCollisions[n] || []).length > 1).length;
    }

    function formatNameCollisionSummary() {
        const names = Object.keys(nameCollisions).filter((n) => (nameCollisions[n] || []).length > 1);
        if (names.length === 0) return 'none detected';
        const preview = names.slice(0, 3).join(', ');
        return `${names.length} name${names.length === 1 ? '' : 's'} seen pointing at more than one company page (${preview}${names.length > 3 ? ', …' : ''}) — set a slug override to pin the right one`;
    }

    function saveCacheMeta({ merge = true, excludeName } = {}) {
        if (merge) mergeStoredIntoMemory(excludeName);
        localStorage.setItem(CACHE_META_KEY, JSON.stringify(companyCacheMeta));
    }

    // Mutates companyCacheMeta only — callers are responsible for calling saveCacheMeta()
    // afterward, same "mutate then explicitly persist" pattern as companyCache/saveCache()
    // elsewhere in this file, rather than a write-through setter that would hit localStorage once
    // per entry during a bulk operation like a multi-company manual edit.
    function recordCacheMeta(normalizedName, source) {
        companyCacheMeta[normalizedName] = { source, timestamp: Date.now() };
    }

    function saveHideUncached() {
        localStorage.setItem(HIDE_UNCACHED_KEY, String(hideUncached));
    }

    function saveRunCooldownMinutes() {
        localStorage.setItem(RUN_COOLDOWN_MINUTES_KEY, String(runCooldownMinutes));
    }

    // Called once at the end of every Auto-Fetch/Re-verify run — finished, cancelled, or stopped by
    // the in-run rate-limit auto-stop all count, since all three mean real requests already went
    // out (cancelling doesn't undo the request that was already in flight when it landed). Only the
    // "nothing to do" early-exit alerts skip this, since those never sent a single request.
    function recordAnonymousRunFinished(tier) {
        lastAnonymousRunState = { finishedAt: Date.now(), tier };
        localStorage.setItem(RUN_COOLDOWN_STATE_KEY, JSON.stringify(lastAnonymousRunState));
    }

    // 0 if a new run may start right now, otherwise how many ms are still left to wait.
    function getRunCooldownRemainingMs(now) {
        // return 0; // DEV: uncomment to disable the cross-run cooldown entirely for testing.
        if (!lastAnonymousRunState || !lastAnonymousRunState.finishedAt) return 0;
        const multiplier = RUN_COOLDOWN_TIER_MULTIPLIER[lastAnonymousRunState.tier] || 1;
        const requiredMs = runCooldownMinutes * 60 * 1000 * multiplier;
        return Math.max(0, requiredMs - (now - lastAnonymousRunState.finishedAt));
    }

    function formatRunCooldownMessage(remainingMs) {
        const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
        const tier = lastAnonymousRunState && lastAnonymousRunState.tier;
        const tierNote = tier === 'autoStopped'
            ? ' (longer than usual — the last run hit repeated rate-limit responses.)'
            : tier === 'rateLimited'
                ? ' (a bit longer than usual — the last run saw some rate-limit responses.)'
                : '';
        return `Please wait ${minutes} more minute${minutes === 1 ? '' : 's'} before running Auto-Fetch or Re-verify again — they share one connection, and running them back-to-back with no gap is what risks LinkedIn rate-limiting or blocking it.${tierNote}`;
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // --- Debug Instrumentation -------------------------------------------
    // v7.6: all call sites removed now that the layout bugs they were added for (v6.10, v7.2,
    // v7.4) are confirmed fixed. The helper itself is deliberately kept, switched off: LinkedIn
    // ships several different job-page builds and quietly changes their markup, and this file has
    // needed live per-frame diagnostics three separate times to root-cause that. Keeping it means
    // the next investigation is "flip this flag and add one dbg() line" instead of rebuilding the
    // flag/prefix scaffolding again. Costs nothing while false.
    // v7.16: flipped back on — three fixes in a row at the force-render feature (v7.13/v7.14/
    // v7.15) and it's still undercounting live.
    // v7.24: flipped back off — user confirmed live capture is 100%, closing the thread this was
    // reactivated for. Left in place (see the comment above) for whenever the next investigation
    // needs it.
    // v7.27: flipped back on to investigate whether the job-detail pane exposes its own
    // /company/<slug> link independent of the list card's - confirmed live and the real fix
    // shipped (see extractCompanySlugFromDetailPane()'s comment). Flipped back off again.
    // v7.33: flipped back on to investigate the badge missing on regular /jobs/search/ pages —
    // the temporary diagnostic (dbgBadgeOnce, since removed) confirmed the cause and the real fix
    // shipped in v7.34 (see findBadgeHeader()'s comment). Flipped back off again.
    const DEBUG = false;
    const FRAME_TAG = (window.top === window.self) ? 'TOP' : 'IFRAME';
    function dbg(...args) {
        if (DEBUG) console.log(`[SizeFilter:${FRAME_TAG}]`, ...args);
    }

    // --- Feature health tracking -------------------------------------------
    // v7.49: every feature below used to fail the same way — silently. A selector chain coming up
    // empty, or a thrown error inside one step of runCycle(), produced no visible signal at all;
    // the only way to notice was the user spotting a missing badge (see the badge-placement
    // incident this same week, CHANGELOG.md v7.45-v7.48) or a console error nobody was looking at.
    // This is a small, shared place for every feature to report what it actually did on its last
    // attempt, read by two consumers: the passive Data-tab status view (only surfaces problems) and
    // the on-demand Diagnose report (dumps everything, for pasting back when something looks wrong).
    //
    // Status vocabulary, deliberately narrow:
    //   'ok'       - working via its normal/primary path.
    //   'fallback' - working, but only because a primary path missed and a fallback caught it. Not
    //                broken, but worth surfacing — this is exactly the state that silently preceded
    //                both bugs fixed this week (a fallback that itself later stopped working).
    //   'idle'     - nothing to do right now (no job open, page still loading, etc.) — not a
    //                problem, just not applicable at this instant.
    //   'failed'   - definitively could not do its job this cycle.
    const FEATURE_HEALTH_IDS = ['panel', 'filtering', 'companyCapture', 'detailCapture', 'badge', 'forceRender'];
    const FEATURE_HEALTH_LABELS = {
        panel: 'Control panel',
        filtering: 'List filtering',
        companyCapture: 'Company-page capture',
        detailCapture: 'Job-detail capture',
        badge: 'Company size badge',
        forceRender: 'Full-list scan'
    };
    const featureHealth = {};
    function setFeatureHealth(id, status, detail) {
        featureHealth[id] = { status, detail: detail || '', at: Date.now() };
    }

    // v7.49: replaces runCycle()'s single shared try/catch — previously, one feature throwing
    // skipped every feature listed after it for that cycle (harmless in practice since the next
    // cycle starts over from the top, but still an unnecessary delay for unrelated features), and
    // there was no record of WHICH feature failed or why beyond a console.error line nobody would
    // see unless they already had DevTools open. `reportOkOnSuccess` is off for features (badge,
    // forceRender) that report their own finer-grained status ('ok' vs 'fallback' vs 'idle')
    // internally — this wrapper only ever adds a 'failed' outcome for those, never overwrites a
    // more specific one with a bare 'ok'.
    function runFeature(id, fn, { reportOkOnSuccess = true } = {}) {
        try {
            fn();
            if (reportOkOnSuccess) setFeatureHealth(id, 'ok');
        } catch (err) {
            setFeatureHealth(id, 'failed', err && err.message ? err.message : String(err));
            console.error(`[Size Filter] ${id} failed:`, err);
        }
    }

    // --- Selector attribution ----------------------------------------------
    // v7.61: every selector chain in this file is a list of guesses, and until now nothing recorded
    // WHICH guess actually fired. That mattered twice this week alone: v7.45/v7.48's badge bug was
    // "a named selector silently stopped matching and a fallback quietly took over", and v7.58's was
    // "a fallback in one document out-ranked a named match in another" — both invisible until a human
    // noticed something looked off on the page. A rung's hit count going from 100% to 0% is the
    // earliest possible signal that LinkedIn shipped a markup change, and it costs one integer
    // increment to know.
    //
    // Session-only, deliberately not persisted: these numbers describe what is happening on the page
    // in front of you right now, and a stale count carried over from a previous session would be
    // actively misleading in exactly the situation this exists to clarify.
    const selectorStats = {};
    function recordSelectorHit(chainId, selectorLabel) {
        const chain = selectorStats[chainId] || (selectorStats[chainId] = {});
        chain[selectorLabel] = (chain[selectorLabel] || 0) + 1;
    }

    // Runs the chain EXACTLY as a hand-written querySelector would — one comma-joined query — and
    // only then asks the winning element which selector it matched. This ordering is not incidental:
    // querySelector with a comma-joined list returns the first match in DOCUMENT order, whereas
    // trying each selector in turn returns the first match in SELECTOR order. Those are different
    // elements on any card carrying both (e.g. an `.artdeco-entity-lockup__subtitle` and a
    // `/company/` link, whichever sits first in the DOM), so restructuring this into a sequential
    // loop to make attribution easier would silently change which element getCardInfo() reads its
    // text from and which one the inline card badge attaches to. Attribution is a measurement; it
    // must not alter what it measures.
    //
    // An element can satisfy more than one selector in the list — attributed to the first match in
    // ARRAY order, so the label is stable rather than depending on internal matching order.
    // Records nothing when the chain misses entirely: a caller with its own fallback rung (see
    // getCardInfo()) needs to report that rung's outcome instead, and a chain that recorded both a
    // '(no match)' and its fallback's hit would double-count every single call.
    function queryWithAttribution(chainId, root, selectors) {
        const el = root.querySelector(selectors.join(', '));
        if (!el) return null;
        const matched = selectors.find((selector) => el.matches(selector)) || '(unknown)';
        recordSelectorHit(chainId, matched);
        return { el, selector: matched };
    }

    // Percentages, not just raw counts: `card.company` is sampled once per card per getCardInfo()
    // call (several times a cycle) while `badge.header` is sampled roughly once a cycle, so their
    // absolute magnitudes aren't comparable and only the split within a chain carries meaning.
    function formatSelectorStats() {
        const chainIds = Object.keys(selectorStats).sort();
        if (chainIds.length === 0) return '(no selector activity recorded yet)';
        const lines = [];
        chainIds.forEach((chainId) => {
            const chain = selectorStats[chainId];
            const total = Object.keys(chain).reduce((sum, label) => sum + chain[label], 0);
            lines.push(`${chainId}:`);
            Object.keys(chain)
                .sort((a, b) => (chain[b] - chain[a]) || a.localeCompare(b))
                .forEach((label) => {
                    const pct = total ? Math.round((chain[label] / total) * 100) : 0;
                    lines.push(`  ${chain[label]} (${pct}%)  ${label}`);
                });
        });
        return lines.join('\n');
    }

    // Computed on demand (Diagnose only), never per cycle — unlike the chains above, this one needs
    // a separate querySelectorAll per selector, and getCardElements() already runs several times per
    // cycle. The container chain is also the least likely of the three to break outright: two of its
    // six entries are attribute-based (li[data-occludable-job-id], the componentkey one) and so
    // survive the class-name hashing that v7.48 confirmed LinkedIn is rolling out.
    function probeCardContainerSelectors() {
        const counts = {};
        CARD_CONTAINER_SELECTORS.forEach((selector) => {
            let n = 0;
            for (const doc of getSearchDocuments()) {
                try { n += doc.querySelectorAll(selector).length; } catch (e) { /* not valid here, skip */ }
            }
            counts[selector] = n;
        });
        return counts;
    }

    // v7.52-v7.54 added a passive fetch()-interception observer here (installVoyagerObserver()),
    // aimed at reading company size from LinkedIn's own JSON instead of scraping HTML/CSS — the
    // same eventual goal as the diagnostics below. Removed in v7.60: confirmed working technically
    // (real traffic was observed once the v7.54 document-start timing fix landed), but real
    // job/company data never once appeared through it across extensive live testing, only
    // unrelated background traffic (messaging polling) — while it carried real, ongoing cost: an
    // elevated `unsafeWindow` permission and an early `@run-at document-start` load, neither of
    // which anything else in this file needs. Not worth keeping unused. See CHANGELOG.md v7.52-v7.60
    // for the full investigation.
    //
    // v7.66: summarizeJsonShape() lived here until this version — a shape-only JSON describer (key
    // names and value types, never values) that fed a per-payload structure dump in the Diagnose
    // report. Removed for exactly the reason the network-interception half was: across many sessions
    // it produced ONE actionable finding (the `employeeCount` field name, now recorded next to
    // SIZE_LIKE_FIELD_NAME_PATTERN) and nothing afterwards, while adding ~20 lines to every report
    // that has to be pasted into a conversation by hand. findSizeLikeFields() — the part that would
    // actually matter if a size field ever did appear — is unaffected and still runs on every
    // payload, including inside the unwrapped "datalet" body.

    // --- Anonymous No-Cookie HTTP Requests -------------------------------
    function makeAnonymousRequest(url) {
        return new Promise((resolve, reject) => {
            const http = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : (typeof GM !== 'undefined' ? GM.xmlHttpRequest : null);

            if (http) {
                http({
                    method: "GET",
                    url: url,
                    anonymous: true, // STRICTLY OMITS ALL LOGGED-IN COOKIES (li_at, JSESSIONID, etc.)
                    nocache: true,   // Prevent returning cached authenticated responses
                    timeout: 10000,
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Cache-Control": "no-cache, no-store",
                        "Pragma": "no-cache"
                    },
                    onload: function (res) {
                        const finalUrl = res.finalUrl || '';
                        if (finalUrl.includes('/authwall') || finalUrl.includes('/login') || finalUrl.includes('/signup') || finalUrl.includes('/checkpoint') || finalUrl.includes('/404')) {
                            reject(new Error('Redirected to authwall/login/404'));
                            return;
                        }
                        if (res.status === 200) {
                            const text = res.responseText || '';
                            if (text.includes('authwall') || text.includes('<title>LinkedIn: Log In or Sign Up') || text.includes('id="join-form"')) {
                                reject(new Error('Authwall page returned'));
                                return;
                            }
                            resolve(text);
                        } else {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    },
                    onerror: function (err) { reject(new Error('Network error')); },
                    ontimeout: function () { reject(new Error('Timeout')); }
                });
            } else {
                fetch(url, { credentials: 'omit', cache: 'no-store' })
                    .then((r) => {
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        if (r.redirected && (r.url.includes('/authwall') || r.url.includes('/login') || r.url.includes('/signup'))) {
                            throw new Error('Redirected to authwall');
                        }
                        return r.text();
                    })
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    // --- Slug Generator & Variant Engine --------------------------------
    function toSlug(company) {
        if (!company) return "";
        let str = company.trim();
        if (str.includes("linkedin.com/company/")) {
            str = str.split("linkedin.com/company/")[1].split("/")[0].split("?")[0];
        }
        return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    }

    function generateCandidateSlugs(rawName) {
        if (!rawName) return [];
        const baseSlug = toSlug(rawName);
        if (!baseSlug) return [];

        const cleanedName = rawName
            .toLowerCase()
            .replace(LEGAL_SUFFIX_PATTERN, '')
            .trim();
        const cleanedSlug = toSlug(cleanedName);

        // v6.4: split camelCase boundaries (e.g. "StepSecurity" -> "Step Security") on the
        // case-preserved input. This must happen here, on rawName as passed in — by the time a
        // name is lowercased for the cache key that boundary is gone for good, and a slug like
        // "step-security" could never be derived from the merged "stepsecurity" string. Requires
        // the caller to pass the case-preserved display name, not the normalized cache key.
        const camelSplitName = rawName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        const camelSplitSlug = camelSplitName !== rawName
            ? toSlug(camelSplitName.toLowerCase().replace(LEGAL_SUFFIX_PATTERN, '').trim())
            : null;

        const candidates = [];
        const pushIfValid = (s) => { if (s && !JUNK_SLUGS.has(s)) candidates.push(s); };

        // Priority 1: Cleaned slug (stripped of Pvt Ltd, LLC, Inc, etc.)
        pushIfValid(cleanedSlug);

        // Priority 2: Base slug (unstripped)
        if (baseSlug !== cleanedSlug) pushIfValid(baseSlug);

        // Priority 2b: camelCase-split slug — tried early since it's cheap and, when it applies,
        // frequently the real answer (LinkedIn slugs are usually hyphenated between real words).
        if (camelSplitSlug && camelSplitSlug !== cleanedSlug) pushIfValid(camelSplitSlug);

        // Priority 2c: v6.5 — a handful of short legal/brand suffixes concatenated directly with
        // no hyphen (e.g. "PHINIA" -> "phiniainc", real slug, confirmed live; "phinia" bare 404s).
        // Unlike the main suffix list below (always hyphenated), these specific ones are commonly
        // written merged in practice, so they're tried as direct candidates instead of only via
        // the hyphenated suffix loop further down.
        for (const suf of ["inc", "io", "ai", "app", "hq"]) {
            pushIfValid(`${cleanedSlug}${suf}`);
        }

        // Priority 3: drop-first-word / drop-last-word / bare-first-word variants.
        // v6.3: restores the "drop first word" case (e.g. "PW PhysicsWallah" -> "physicswallah")
        // that v6.2 silently lost — it only kept "first word alone" and "drop last word", so a
        // leading acronym/brand prefix like "PW" could never be stripped, and the correct slug
        // was never generated as a candidate at all.
        const rawWords = rawName.trim().split(/\s+/);
        let withoutFirstSlug = null, withoutLastSlug = null, firstWordSlug = null;
        if (rawWords.length > 1) {
            withoutFirstSlug = toSlug(rawWords.slice(1).join(' '));
            withoutLastSlug = toSlug(rawWords.slice(0, -1).join(' '));
            firstWordSlug = rawWords[0].length >= 3 ? toSlug(rawWords[0]) : null;
            pushIfValid(withoutFirstSlug);
            pushIfValid(withoutLastSlug);
            pushIfValid(firstWordSlug);
        }

        // Target bases for appending suffixes/prefixes. v6.3: use the named trimmed variants
        // directly instead of positional candidates[0]/candidates[1] — that indexing accidentally
        // picked firstWordSlug ("pw") over withoutFirstSlug/withoutLastSlug (the actually-likely
        // real slug bases) whenever a firstWordSlug got pushed, so the suffix budget (~17-20 of
        // the 20 attempts) was spent on the wrong base almost every time.
        const targetBases = Array.from(new Set(
            [cleanedSlug, camelSplitSlug, withoutFirstSlug, withoutLastSlug].filter((s) => s && !JUNK_SLUGS.has(s))
        ));
        const suffixes = [
            "-india", "-official", "-hq", "-ai", "-io", "-app", "-tech", "-technologies",
            "-solutions", "-software", "-labs", "-studio", "-ventures", "-group", "-global",
            "-digital", "-media", "-systems", "-services", "-inc", "-ltd", "-pvt-ltd"
        ];

        for (const target of targetBases) {
            for (const suf of suffixes) {
                const variant = `${target}${suf}`;
                candidates.push(variant);
            }
        }

        const prefixes = ["get-", "get", "try-", "join-", "weare-", "weare", "the-", "official-"];
        for (const target of targetBases) {
            for (const pre of prefixes) {
                candidates.push(`${pre}${target}`);
            }
        }

        for (const target of targetBases) {
            if (target.includes("-")) {
                candidates.push(target.replace(/-/g, ""));
            }
        }

        const unique = [];
        const seen = new Set();
        for (const s of candidates) {
            if (s && !seen.has(s) && !JUNK_SLUGS.has(s) && s.length >= 2) {
                seen.add(s);
                unique.push(s);
            }
        }

        return unique;
    }

    // Extracts LinkedIn company slug from search engine results HTML
    function extractSlugFromSearchHtml(html) {
        if (!html) return null;
        // v7.29: same truncation risk as getCardInfo()'s matching fix ("victoria's-secret" ->
        // "victoria"), but this parses unstructured search-result text/HTML rather than a real
        // URL object, so a fully-negated character class is riskier here (could swallow a
        // surrounding quote/tag boundary in raw markup) - widened narrowly to add the one concrete
        // character now known to appear in real slugs (apostrophe) instead. The split-based
        // refinement just below already re-derives the precise slug on /, ?, and # regardless.
        const matches = html.match(/(?:linkedin\.com\/company\/|linkedin\.com%2Fcompany%2F)([a-zA-Z0-9_'-]+)/gi);
        if (!matches) return null;
        for (const m of matches) {
            const raw = decodeURIComponent(m);
            const parts = raw.split("/company/");
            if (parts.length > 1) {
                const slug = parts[1].split('/')[0].split('?')[0].split('#')[0].toLowerCase().trim();
                if (slug && !RESERVED_SLUGS.has(slug) && slug.length >= 2) {
                    return slug;
                }
            }
        }
        return null;
    }

    async function searchLinkedInSlugInBrowser(companyName) {
        const cleanName = companyName.replace(LEGAL_SUFFIX_PATTERN, '').trim();
        const queries = [
            `site:linkedin.com/company "${cleanName}"`,
            `site:linkedin.com/company ${cleanName}`
        ];

        for (const query of queries) {
            const q = encodeURIComponent(query);

            // Engine 1: Bing Search (Reliable, high delivery rate)
            try {
                const html = await makeAnonymousRequest(`https://www.bing.com/search?q=${q}`);
                const slug = extractSlugFromSearchHtml(html);
                if (slug) return slug;
            } catch (e) { }

            // Engine 2: Google Search
            try {
                const html = await makeAnonymousRequest(`https://www.google.com/search?q=${q}`);
                const slug = extractSlugFromSearchHtml(html);
                if (slug) return slug;
            } catch (e) { }

            // Engine 3: DuckDuckGo HTML
            try {
                const html = await makeAnonymousRequest(`https://html.duckduckgo.com/html/?q=${q}`);
                const slug = extractSlugFromSearchHtml(html);
                if (slug) return slug;
            } catch (e) { }
        }
        return null;
    }

    // --- HTML Parsing & Categorization ----------------------------------
    function categorizeSize(rawText) {
        if (!rawText) return null;
        const text = rawText.replace(/\s+/g, ' ').replace(/,/g, '').trim();
        if (text.match(/10\s*00[01]\s*\+/i) || text.match(/10\s*00[01]\s*or\s*more/i) || text.includes('10001+') || text.includes('10000+')) {
            return '10,001+ employees';
        }
        if (text.match(/5001\s*[-–]\s*10000/i)) return '5,001-10,000 employees';
        if (text.match(/1001\s*[-–]\s*5000/i)) return '1,001-5,000 employees';
        if (text.match(/501\s*[-–]\s*1000/i)) return '501-1,000 employees';
        if (text.match(/201\s*[-–]\s*500/i)) return '201-500 employees';
        if (text.match(/51\s*[-–]\s*200/i)) return '51-200 employees';
        if (text.match(/11\s*[-–]\s*50/i)) return '11-50 employees';
        if (text.match(/\b1\s*[-–]\s*10\b/i)) return '1-10 employees';
        return null;
    }

    function extractSizeFromHtml(html) {
        if (!html) return null;

        // Strategy 1: data-test-id="about-us__size"
        const sizeBlockMatch = html.match(/data-test-id=["']about-us__size["'][\s\S]*?<\/dd>/i);
        if (sizeBlockMatch) {
            const ddMatch = sizeBlockMatch[0].match(/<dd[^>]*>([\s\S]*?)<\/dd>/i);
            if (ddMatch) {
                const cleanVal = ddMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                const cat = categorizeSize(cleanVal);
                if (cat) return cat;
            }
        }

        // Strategy 2: "Company size" label in HTML / meta
        const sizeLabelMatch = html.match(/Company\s*size[\s\S]{0,300}?([\d,]+\s*[-–]?\s*[\d,]*\+?\s*employees)/i);
        if (sizeLabelMatch) {
            const cat = categorizeSize(sizeLabelMatch[1]);
            if (cat) return cat;
        }

        // v6.4: JSON-LD "numberOfEmployees" and the unscoped "N-M employees" regex were removed
        // here. Verified live against real LinkedIn pages: numberOfEmployees does NOT reliably
        // match the declared "Company size" bucket (e.g. it read 747 for a company whose real,
        // logged-in-visible bucket is "1,001-5,000"), and the unscoped regex has no way to tell
        // the target company's own size apart from a number sitting anywhere else on the page
        // (sidebar "Similar pages" cards, etc.) — that's how a wrong bucket got cached for a real
        // company. Both strategies above require the literal "Company size" text/label to be
        // present, which is a real correctness guarantee; the two removed ones aren't. When
        // neither finds it (LinkedIn gates the field behind a sign-in wall for many companies),
        // this now returns null — a clean "unclassified" — instead of a wrong bucket. The passive
        // capture on real company-page visits (captureCompanyPageIfPresent) is the intended way
        // to fill those in, from data you were already looking at while logged in.
        return null;
    }

    // v6.5: guards against a name COLLISION, not a bad signal — the candidate guesser can land
    // on a real, different company that happens to own the guessed slug (confirmed live: both
    // linkedin.com/company/handshake and /company/team-handshake are genuine, distinct companies
    // both titled "Handshake | LinkedIn", and only the second is the recruiting platform you're
    // after). extractSizeFromHtml has no way to know it fetched the wrong page since the size it
    // found is perfectly real — just for someone else. This checks the fetched page's own <title>
    // against the target company name before the result is trusted anywhere it's used.
    // NOTE: this only catches a MISMATCHED name (candidate landed on a differently-named company).
    // Two real companies sharing the exact same display name — like the Handshake case above —
    // can't be told apart by name text alone; that's what captureCompanyPageIfPresent /
    // captureFromJobDetailPane exist for, since a manual click resolves the ambiguity for free.
    function verifyPageMatchesCompany(html, normalizedTargetName) {
        if (!normalizedTargetName) return true;
        const titleMatch = html && html.match(/<title>([^<]*)<\/title>/i);
        if (!titleMatch) return true; // no title to check against — don't block on missing data
        const pageTitle = titleMatch[1].replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
        const pageNormalized = normalizeCompanyName(pageTitle);
        if (!pageNormalized) return true;
        if (pageNormalized === normalizedTargetName) return true;
        return pageNormalized.includes(normalizedTargetName) || normalizedTargetName.includes(pageNormalized);
    }

    // Case-preserved company text (cache keys stay lowercase/merged for stable dedup — this is
    // only for feeding the slug guesser, which needs to see "StepSecurity" before it's collapsed
    // to "stepsecurity" in order to ever guess the real "step-security" slug).
    function extractDisplayName(text) {
        if (!text) return '';
        const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || '';
        return firstLine
            .replace(/·.*$/, '')
            .replace(/\bviewed\b/gi, '')
            .replace(/\bpromoted\b/gi, '')
            .trim();
    }

    function normalizeCompanyName(text) {
        const displayName = extractDisplayName(text);
        if (!displayName) return '';
        return displayName
            .toLowerCase()
            .replace(LEGAL_SUFFIX_PATTERN, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // --- Feed Card Handling ----------------------------------------------
    // v6.11: reaches into any same-origin iframe on the page alongside the top document itself.
    // Cross-origin iframes throw on .contentDocument access — caught and skipped, degrading to
    // "just the top document" exactly like before this change, so this can't make anything worse.
    function getSearchDocuments() {
        const docs = [document];
        document.querySelectorAll('iframe').forEach((frame) => {
            try {
                if (frame.contentDocument && frame.contentDocument.body) docs.push(frame.contentDocument);
            } catch (e) { /* cross-origin — inaccessible, skip */ }
        });
        return docs;
    }

    const CARD_CONTAINER_SELECTORS = [
        '.jobs-search-results__list-item',
        '.job-card-container',
        '.jobs-search-results-list__list-item',
        '.scaffold-layout__list-item',
        'li[data-occludable-job-id]',
        // v7.5: /jobs/search-results/ (reached via the "connections are hiring" notification)
        // confirmed live via DOM inspection to use an entirely different card component: no BEM
        // class, no <a href> anywhere on the card at all — the whole card is a
        // <div role="button" componentkey="job-card-component-ref-<jobId>">. That componentkey
        // attribute repeats identically on an inner wrapper div too (without role="button"), so
        // both attributes are required together to match only the outer card once, not twice.
        '[role="button"][componentkey^="job-card-component-ref-"]'
    ];

    // v7.61: lifted verbatim out of getCardInfo()'s inline comma-joined querySelector string, in the
    // same order (order is load-bearing — see queryWithAttribution()). Note the shape of the risk
    // here: four class names, all of which the hashed-class build v7.48 confirmed live would break,
    // plus one href-based rung that v7.5 confirmed is absent entirely on the componentkey layout.
    // That leaves findComponentKeyCompanyElement()'s "first childless <p>" as the sole load-bearing
    // rung on that layout — the most fragile single path in this file, and the reason attribution
    // starts here rather than anywhere else.
    //
    // v7.65: a structural rung for THIS chain — the natural follow-up to v7.63's aria-label rung for
    // the badge — was investigated against real captured markup and DELIBERATELY NOT BUILT. The card
    // text inventory (buildCardTextInventory()) settled it: on the componentkey layout the only
    // labelled element on a card is the dismiss button's aria-label="Dismiss <job title> job" — the
    // TITLE, not the company — and the wrapper classes are hashed utilities that repeat across
    // unrelated elements (c1ccab5e sits on both the company's wrapper div AND the location <p>).
    // There is no semantic anchor for the company name on that card, so every candidate was a guess:
    // a blocklist of chrome strings ("Viewed"/"Promoted"/"Easy Apply" — locale-dependent and
    // open-ended), or a cross-check against the dismiss title (narrow, catching one failure mode).
    // Both would add new failure modes to a path that resolves correctly on every card captured so
    // far. A shaky replacement for something that works is worse than leaving it alone. If this rung
    // ever does break, the v7.61-v7.65 diagnostics now make it loud and immediately diagnosable —
    // which was the part actually missing, not the rung itself.
    const CARD_COMPANY_SELECTORS = [
        '.job-card-container__primary-description',
        '.artdeco-entity-lockup__subtitle',
        '.job-card-container__company-name',
        '.job-card-list__company-name',
        'a[href*="/company/"]'
    ];
    // v7.66: was '<p> fallback (componentkey layout)'. That label asserted a layout rather than
    // describing a rung, and the assertion turned out to be false: a /jobs/search/ capture showed it
    // firing on 14% of card reads on a page where the componentkey container matched ZERO elements.
    // The mislabel is part of why that 14% looked mysterious — the report was naming a cause instead
    // of stating what the rung actually does, which is "take the first childless <p> that has text",
    // something any layout can satisfy. A diagnostic label should describe the mechanism; explaining
    // it is the reader's job, and a wrong explanation baked into the label costs more than no
    // explanation at all.
    const CARD_COMPANY_FALLBACK_LABEL = '<p> fallback (first childless <p> with text)';

    function getCardElements() {
        const all = [];
        for (const doc of getSearchDocuments()) {
            doc.querySelectorAll(CARD_CONTAINER_SELECTORS.join(', ')).forEach((el) => all.push(el));
        }
        return all;
    }

    // v7.13: walks up from a known card element to find its actual scrollable container —
    // structural, not a guessed class name, for the same reason CARD_CONTAINER_SELECTORS' last
    // entry and BADGE_HEADER_SELECTORS' last entry both ended up needing to be: LinkedIn ships
    // multiple different rendering builds and a specific container class from one layout has
    // already been observed not to exist at all on another (v7.3, v7.5).
    // v7.17: reported live with debug data — the first-match version below found a real
    // scrollable ancestor, just the WRONG one: a small (158px clientHeight) widget sitting between
    // the card and the actual list panel, whose card count never changed across the whole scroll
    // pass (a huge scrollHeight/clientHeight ratio, more consistent with some hidden/truncated
    // content blob than an actual visible list). Now collects EVERY matching ancestor walking the
    // full chain and picks the one with the largest clientHeight — the real list panel should be
    // the biggest visible scrollable region in the chain, not a small nested widget.
    function findAllScrollableAncestors(el) {
        const win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win) return [];
        const candidates = [];
        let node = el.parentElement;
        while (node) {
            const style = win.getComputedStyle(node);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 20) {
                candidates.push(node);
            }
            node = node.parentElement;
        }
        return candidates;
    }

    function findScrollableAncestor(el) {
        const candidates = findAllScrollableAncestors(el);
        if (candidates.length === 0) return null;
        return candidates.reduce((best, node) => (node.clientHeight > best.clientHeight ? node : best));
    }

    // v7.18: temporary, debug-only. v7.17's "pick the largest of all overflowY:auto/scroll
    // candidates" fix reportedly found candidateCount: 1 — the SAME small widget as before, and
    // nothing else — meaning the real list panel isn't matching the overflowY:auto/scroll filter
    // at all, not that it was being out-ranked by a smaller match. Dumps the FULL ancestor chain
    // completely unfiltered (every element from the card to the page root, with its real computed
    // overflow/overflowY and dimensions) so the actual mismatch is visible directly instead of
    // guessed at — e.g. a value like "overlay"/"clip" that the current filter doesn't recognize,
    // or a genuinely different scrolling mechanism (virtualized/transform-based) entirely.
    function debugDumpAncestorChain(el) {
        const win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win) return [];
        const chain = [];
        let node = el.parentElement;
        let depth = 0;
        while (node && depth < 25) {
            const style = win.getComputedStyle(node);
            chain.push({
                depth, tag: node.tagName, class: String(node.className || '').slice(0, 50),
                scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, offsetHeight: node.offsetHeight,
                overflow: style.overflow, overflowY: style.overflowY, position: style.position
            });
            node = node.parentElement;
            depth++;
        }
        return chain;
    }

    // A signature for "which list is this," deliberately excluding currentJobId — that param
    // changes on every single job click, but clicking a different job within the same list
    // doesn't change the list itself, and re-triggering a full scroll-and-restore on every click
    // would be exactly the kind of disruptive behavior this feature needs to avoid.
    //
    // v7.45: reported live — a double flicker (hide/reveal, twice) on every single job click, but
    // only on /jobs/search-results/ (the route reached via notification/recommendation links, e.g.
    // "?eBP=...&refId=...&trackingId=..."), never on /jobs/search/. That route's URL carries
    // LinkedIn's own per-click tracking correlation params alongside currentJobId — eBP, refId,
    // trackingId, originToLandingJobPostings — and only currentJobId was being excluded here. Each
    // click regenerates at least one of them, so the signature changed on every click exactly like
    // an unstripped currentJobId would have, re-triggering a full forceRenderAllVisibleCards() pass
    // (the double flicker was two such passes in quick succession: the initial navigation, then
    // LinkedIn settling the tracking params a moment later). None of these describe which list is
    // showing, only which specific click/impression sent you here, so they now get the same
    // treatment as currentJobId. Switched from regex-chaining (fragile once removing more than one
    // param — leftover "&" cleanup gets awkward) to URLSearchParams.
    //
    // v7.46: reported live — flicker persisted on /jobs/search-results/ even after v7.45, this time
    // reproduced specifically on PAGINATION (page 1 -> page 2 -> back to page 1), not job clicks
    // within one page. v7.45's URLSearchParams switch fixed which keys survive into the signature,
    // but its .toString() still serializes the SURVIVING keys in whatever order they happened to
    // appear in location.search — the old regex-based version had this exact same property (it only
    // ever removed one param in place, never reordered anything), so this was never actually
    // fixed, just not yet triggered by a case that exposed it. If LinkedIn's client renders an
    // optimistic URL during a page transition and then settles into a final one with its query
    // params in a different (but semantically identical) order — plausible, unconfirmed — two
    // genuinely-the-same list would compare as different signatures purely from param order,
    // re-triggering another force-render pass. Sorting the surviving keys before joining removes
    // this whole class of risk regardless of whether that's confirmed as the exact mechanism here:
    // two query strings with the same params (any order) now always produce the same signature.
    const VOLATILE_TRACKING_PARAMS = ['currentJobId', 'eBP', 'refId', 'trackingId', 'originToLandingJobPostings'];
    function getListSignature() {
        const params = new URLSearchParams(location.search);
        VOLATILE_TRACKING_PARAMS.forEach((key) => params.delete(key));
        params.sort();
        const qs = params.toString();
        return location.pathname + (qs ? `?${qs}` : '');
    }

    // v7.5: componentkey-based cards (see CARD_CONTAINER_SELECTORS above) have no known class and
    // no company-page link anywhere in the card, so neither companyEl nor linkEl below can find
    // anything on them. Confirmed via DOM inspection: the job-title <p> always nests a <span> (for
    // the "Verified job" badge), while the company name and location that follow it are always
    // plain, un-nested <p> text — company name is the first such plain paragraph, location the
    // second. This is a structural rule, not a class name, so it doesn't rot the way a guessed
    // hash class would the next time LinkedIn redeploys this component.
    function findComponentKeyCompanyElement(card) {
        const simpleParagraphs = Array.from(card.querySelectorAll('p')).filter(
            (p) => p.children.length === 0 && p.textContent.trim().length > 0
        );
        return simpleParagraphs[0] || null;
    }

    // v7.66 (P3). The <p> fallback picks by POSITION — the first childless <p> with text — so its
    // failure mode is the dangerous one: it fails by selecting the WRONG element (a job title, a
    // location, a "Viewed" chip) rather than by selecting nothing, and a wrong pick gets written to
    // companyCache under a garbage key. There is no positive semantic anchor for the company name on
    // that layout (established in v7.65, which is why no new rung was built), but there IS a
    // NEGATIVE one: the card labels its own job title, so "the company name is exactly the job
    // title" is a flat contradiction rather than a heuristic.
    //
    // Both sources below are exact-match only, and both fail closed — no title found means no check,
    // never a guess. The first is locale-independent (the job link labels itself). The second parses
    // the dismiss button's English "Dismiss <title> job" phrasing and simply doesn't match on other
    // locales, which costs nothing: the check is a bonus safeguard, never something relied on.
    const CARD_DISMISS_LABEL_PATTERN = /^Dismiss\s+(.+?)\s+job$/i;
    function findCardJobTitle(card) {
        const jobLink = card.querySelector('a[href*="/jobs/view/"][aria-label]');
        if (jobLink) {
            const label = (jobLink.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (label) return label;
        }
        const buttons = card.querySelectorAll('button[aria-label]');
        for (const button of buttons) {
            const match = (button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().match(CARD_DISMISS_LABEL_PATTERN);
            if (match && match[1]) return match[1];
        }
        return null;
    }

    // Exact match only. A substring test would flag the very common "Software Engineer at Acme"
    // title shape against a real company called Acme — turning a safeguard into a source of dropped
    // cards, which is precisely the outcome it exists to prevent.
    let cardTitleContradictions = 0;
    function isJobTitleNotCompany(card, companyText) {
        const company = (companyText || '').replace(/\s+/g, ' ').trim();
        if (!company) return false;
        const title = findCardJobTitle(card);
        if (!title) return false;
        return title.toLowerCase() === company.toLowerCase();
    }

    // v7.68: extracted verbatim from getCardInfo()'s own success path (same three rungs, same
    // priority order) so the SAME identity read can also run on the failure path below — previously
    // a card that failed to resolve a company had no identity extracted at all, which is exactly why
    // "does a (no match) card resolve on the next cycle" could only ever be explained, not proven: a
    // miss and its later resolution had no shared key to prove they were the same card.
    function extractCardJobId(card) {
        const linkEl = card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]');
        const href = linkEl ? (linkEl.href || '') : '';
        const hrefMatch = href.match(/\/jobs\/view\/(\d+)/) || href.match(/currentJobId=(\d+)/);
        if (hrefMatch) return hrefMatch[1];
        if (card.dataset && card.dataset.occludableJobId) return card.dataset.occludableJobId;
        const componentKeyMatch = (card.getAttribute('componentkey') || '').match(/job-card-component-ref-(\d+)/);
        return componentKeyMatch ? componentKeyMatch[1] : null;
    }

    // v7.68 — proves, rather than explains, that card.company's "(no match)" share is a card whose
    // OUTER container mounted before its INNER company element did, missing until it resolves rather
    // than staying broken. Tracks each miss by the card's own job ID (free — extractCardJobId() runs
    // on the failure path either way now) and records how long it actually took to resolve, or flags
    // it if it never does. This is diagnostic-only: it reads outcomes that already happened, and
    // cannot change what gets filtered, cached, or displayed.
    //
    // v7.69 — the mechanism, corrected against real data. The original comment guessed a resolve
    // within roughly one poll cycle (a few hundred ms), by loose analogy with v7.19's unrelated
    // container-COUNT finding. The first live report this produced showed 16 resolutions at
    // avg 11502ms / max 11503ms — essentially identical across every one of them, which cannot be 16
    // independent short delays; it's one shared event. That number sits just under
    // FORCE_RENDER_TIMEOUT_MS (12000ms below), so the real mechanism is a card mounting as an empty
    // container mid-sweep and only receiving real content once that SWEEP's own lazy-loading settles
    // — tied to forceRenderAllVisibleCards() finishing, not to the next runCycle poll. The qualitative
    // claim (transient, not broken) held up; the specific number in the original comment didn't, and
    // is corrected here now that real numbers exist rather than left standing.
    //
    // Bounded two ways: TRANSIENT_MISS_STALE_MS is the line between "still loading, unremarkable" and
    // "taking longer than expected" in the report — deliberately kept BELOW the observed ~11.5s norm
    // (a pending entry sitting past it mid-sweep is normal, not evidence of a break; the report's own
    // language says "worth a second look if this keeps growing", a trend to watch, not a verdict).
    // TRANSIENT_MISS_GIVE_UP_MS is when a pending entry is dropped outright — comfortably above the
    // observed norm, on the assumption it scrolled off-screen and is never coming back for another
    // read, not stuck — so the tracking map can never grow without bound across a long session.
    const TRANSIENT_MISS_STALE_MS = 5000;
    const TRANSIENT_MISS_GIVE_UP_MS = 30000;
    const pendingCompanyMisses = {}; // jobId -> first-missed timestamp
    let transientMissResolvedCount = 0;
    let transientMissResolvedTotalMs = 0;
    let transientMissResolvedMaxMs = 0;
    let transientMissGaveUpCount = 0;

    // Shared by the miss path (keeps the map bounded) and the report (keeps "still pending" from
    // counting entries that were really abandoned minutes ago).
    function pruneStaleCompanyMisses(now) {
        Object.keys(pendingCompanyMisses).forEach((jobId) => {
            if (now - pendingCompanyMisses[jobId] > TRANSIENT_MISS_GIVE_UP_MS) {
                delete pendingCompanyMisses[jobId];
                transientMissGaveUpCount++;
            }
        });
    }

    function recordTransientCompanyMiss(jobId, now = Date.now()) {
        if (!jobId) return; // no identity, nothing to correlate across cycles
        pruneStaleCompanyMisses(now);
        // v7.68 fix, caught by this feature's own test: `!pendingCompanyMisses[jobId]` treats a
        // legitimate timestamp of 0 as "not yet set" (0 is falsy) and overwrites the real first-miss
        // time on every subsequent miss of the same card — silently breaking the "measure from the
        // FIRST miss" guarantee this whole mechanism exists to provide. Same class of bug as
        // cardYieldDegradedSince in v7.61; same fix, an explicit `=== undefined` check.
        if (pendingCompanyMisses[jobId] === undefined) pendingCompanyMisses[jobId] = now;
    }

    function recordTransientCompanyResolution(jobId, now = Date.now()) {
        const firstMissedAt = pendingCompanyMisses[jobId];
        if (firstMissedAt === undefined) return; // resolved on first sighting — nothing to prove
        delete pendingCompanyMisses[jobId];
        const elapsed = now - firstMissedAt;
        transientMissResolvedCount++;
        transientMissResolvedTotalMs += elapsed;
        if (elapsed > transientMissResolvedMaxMs) transientMissResolvedMaxMs = elapsed;
    }

    // `now` defaults to Date.now() like every other testable time-check in this file
    // (reportCardYieldHealth, detailYieldVerdict's window) — takes a parameter rather than reading
    // the clock inline so it can be driven by a fake clock in tests, not real wall time.
    function formatTransientMissSummary(now = Date.now()) {
        pruneStaleCompanyMisses(now);
        const stillPending = Object.keys(pendingCompanyMisses).length;
        if (transientMissResolvedCount === 0 && stillPending === 0 && transientMissGaveUpCount === 0) {
            return '(no transient misses observed yet this session)';
        }
        const stale = Object.keys(pendingCompanyMisses)
            .filter((jobId) => now - pendingCompanyMisses[jobId] > TRANSIENT_MISS_STALE_MS).length;
        const avgMs = transientMissResolvedCount ? Math.round(transientMissResolvedTotalMs / transientMissResolvedCount) : 0;
        // v7.69: "on a later cycle"/"stay small" replaced — live data showed resolves clustering just
        // under FORCE_RENDER_TIMEOUT_MS (a force-render sweep settling), not the next runCycle poll,
        // so the report now names the actual baseline instead of an unstated "small".
        return `${transientMissResolvedCount} resolved once pending (avg ${avgMs}ms, max ${transientMissResolvedMaxMs}ms)` +
            ` — expected to cluster under FORCE_RENDER_TIMEOUT_MS (${FORCE_RENDER_TIMEOUT_MS}ms, a sweep settling); consistently far above it would mean something else is going on\n` +
            `  ${stillPending} still pending right now (${stale} past ${TRANSIENT_MISS_STALE_MS}ms — worth a second look if this keeps growing)\n` +
            `  ${transientMissGaveUpCount} given up on (pending past ${TRANSIENT_MISS_GIVE_UP_MS}ms — almost certainly scrolled away, not stuck)`;
    }

    function getCardInfo(card) {
        // v7.7: companyEl is now returned to the caller (not just read here and discarded) so
        // updateCardSizeBadge() can attach the inline per-card size badge to the exact element
        // this function already identified as "the company name" — reusing this lookup instead of
        // re-querying the card with a second, possibly-differently-scoped selector search.
        // v7.61: extracted from the inline comma-joined string it used to be, so the rungs can be
        // named individually in the Diagnose report. queryWithAttribution() still issues exactly one
        // comma-joined querySelector — see its comment for why sequential tries would pick a
        // different element here.
        const located = queryWithAttribution('card.company', card, CARD_COMPANY_SELECTORS);
        let companyEl = located ? located.el : null;
        if (!companyEl) {
            companyEl = findComponentKeyCompanyElement(card);
            recordSelectorHit('card.company', companyEl ? CARD_COMPANY_FALLBACK_LABEL : '(no match)');
        }
        if (!companyEl) {
            // v7.68: the only new line this rejection path gets — proves rather than merely explains
            // whether this specific card resolves on a later cycle. See recordTransientCompanyMiss().
            recordTransientCompanyMiss(extractCardJobId(card));
            return null;
        }
        const companyText = companyEl.textContent;
        // v7.66: reject rather than merely report. This codebase's oldest rule (v6.4/v6.5) is that
        // wrong data is worse than no data — a bad name here doesn't just mis-render one card, it
        // gets written to companyCache under a garbage key. An unreadable card is the safe failure:
        // it's already a state the rest of the file handles, and it counts against the filtering
        // yield, so if this ever started firing broadly it would raise the v7.61 alarm instead of
        // silently poisoning the cache.
        if (isJobTitleNotCompany(card, companyText)) {
            cardTitleContradictions++;
            return null;
        }
        if (!companyText) return null;

        // v7.68: uses the shared extractCardJobId() now instead of a second inline copy of the same
        // three rungs — the miss path above needs identical logic, and two independent copies is
        // exactly the kind of drift risk this file has been burned by before.
        const jobId = extractCardJobId(card);
        recordTransientCompanyResolution(jobId);

        const displayName = extractDisplayName(companyText);
        const normalizedName = normalizeCompanyName(companyText);
        if (!normalizedName || !jobId) return null;

        // Optimization: extract company slug directly from company link if present in DOM
        const companyLink = card.querySelector('a[href*="/company/"]');
        if (companyLink && companyLink.href) {
            // v7.29: reported live — "victoria's-secret" truncated to "victoria". A real LinkedIn
            // slug can contain characters like apostrophes that an allowlist of "safe" characters
            // won't anticipate (the same class of mistake this file has already been burned by
            // elsewhere - guessing at what's valid instead of matching structurally). A URL path
            // segment is bounded by the next /, ?, or # by definition, so matching "everything up
            // to that" is correct for ANY slug content, not an approximation of one.
            const slugMatch = companyLink.href.match(/\/company\/([^/?#]+)/);
            if (slugMatch && slugMatch[1] && !RESERVED_SLUGS.has(slugMatch[1].toLowerCase())) {
                const domSlug = slugMatch[1].toLowerCase();
                // v7.35: a disagreement between what's on file and what this card says means the
                // normalized key is shared by two different companies — record it rather than
                // letting one silently win. See recordSlugObservation().
                recordSlugObservation(normalizedName, domSlug);
                // An override means a human already answered this — don't re-derive.
                if (!getSlugFor(normalizedName)) {
                    slugCache[normalizedName] = domSlug;
                    saveSlugCache();
                }
            }
        }

        return { normalizedName, displayName, jobId, element: card, companyEl };
    }

    // v7.7: compact labels for the inline per-card badge — the full bucket strings ("10,001+
    // employees") are fine in the panel checklist but too wide to sit next to a company name in a
    // dense list row. Falls back to the bucket string itself for any value not in this map (should
    // never happen for a value that passed SIZE_BUCKETS validation, but keeps this from silently
    // showing nothing if the map and SIZE_BUCKETS ever drift).
    const SIZE_BUCKET_SHORT_LABELS = {
        '1-10 employees': '1-10',
        '11-50 employees': '11-50',
        '51-200 employees': '51-200',
        '201-500 employees': '201-500',
        '501-1,000 employees': '501-1K',
        '1,001-5,000 employees': '1K-5K',
        '5,001-10,000 employees': '5K-10K',
        '10,001+ employees': '10K+'
    };
    const CARD_BADGE_CLASS = 'linkedin-size-filter-card-badge';

    // Inserted as a sibling right after companyEl (not nested inside it) — companyEl is sometimes
    // an <a href="/company/..."> link, and nesting an unrelated badge inside a link tag would make
    // it part of that link's click target for no reason. Scoped to companyEl's own parent (not a
    // page-wide id) since this runs once per card and every card needs its own badge.
    function updateCardSizeBadge(companyEl, bucket) {
        if (!companyEl || !companyEl.parentNode) return;
        const parent = companyEl.parentNode;
        const existing = Array.from(parent.children).find(
            (el) => el.classList && el.classList.contains(CARD_BADGE_CLASS)
        );

        if (!bucket) {
            // Not expected in normal use (caches don't un-cache themselves), but if it ever
            // happens, don't leave a stale badge showing a size that's no longer recorded.
            if (existing) existing.remove();
            return;
        }

        const label = SIZE_BUCKET_SHORT_LABELS[bucket] || bucket;
        if (existing) {
            if (existing.textContent !== label) existing.textContent = label;
            return;
        }

        const doc = companyEl.ownerDocument || document;
        const badge = doc.createElement('span');
        badge.className = CARD_BADGE_CLASS;
        badge.style.cssText = `
            display: inline-block; background-color: #0f766e; color: #ffffff;
            font-size: 15px; font-weight: 700; padding: 3px 9px; border-radius: 8px;
            margin-left: 6px; vertical-align: middle; line-height: 1.5; white-space: nowrap;
        `;
        badge.textContent = label;
        parent.insertBefore(badge, companyEl.nextSibling);
    }

    function filterJobListCards() {
        const countedJobIds = new Set();
        let hiddenCount = 0;
        let uncachedCount = 0;
        // v7.61: hoisted out of the forEach so the container count is available to
        // reportCardYieldHealth() below. Same elements, same order, same single call as before.
        const cards = getCardElements();
        let parsedCount = 0;

        cards.forEach((card) => {
            const info = getCardInfo(card);
            if (!info) return;
            parsedCount++;

            const firstTimeSeeingJob = !countedJobIds.has(info.jobId);
            countedJobIds.add(info.jobId);

            const bucket = companyCache[info.normalizedName];
            updateCardSizeBadge(info.companyEl, bucket);

            if (!bucket) {
                if (firstTimeSeeingJob) uncachedCount++;
                card.style.display = hideUncached ? 'none' : (card.style.display === 'none' ? '' : card.style.display);
                return;
            }

            const isVisible = userPreferences[bucket] !== false;
            if (isVisible) {
                if (card.style.display === 'none') card.style.display = '';
            } else {
                if (card.style.display !== 'none') {
                    card.style.display = 'none';
                }
                if (firstTimeSeeingJob) hiddenCount++;
            }
        });

        updateCounterDisplay(Object.keys(companyCache).length, hiddenCount, uncachedCount);
        reportCardYieldHealth(cards.length, parsedCount);
    }

    // v7.61: filtering was the one load-bearing feature that could break COMPLETELY while reporting
    // itself perfectly healthy. The chain: getCardInfo() returning null makes filterJobListCards()
    // skip that card silently (`if (!info) return;` above — deliberate, cards legitimately mount
    // before their content hydrates); runFeature() reports 'ok' for anything that doesn't THROW; and
    // updateCounterDisplay()'s first number is the whole cache's size, not this page's. So a renamed
    // company-name class would have produced: no filtering, no card badges, "Cached: 847 | Hidden: 0
    // | Unclassified: 0", and "✅ Everything working normally" in the Data tab. Indistinguishable
    // from a page that genuinely has nothing to filter — which is exactly how a userscript ends up
    // quietly dead for weeks while its owner assumes it's fine.
    //
    // The signal is deliberately self-normalizing: it compares cards FOUND against cards READ, so it
    // needs no "is this a jobs page?" URL heuristic (the guessy kind of check that generates false
    // alarms). The containers we found are themselves the proof that job cards exist here.
    //
    // Everything here is measurement only — it sets a health string and touches nothing else. A
    // mistuned threshold can show a spurious ⚠️; it cannot hide a card or write a wrong size.
    const CARD_YIELD_GRACE_MS = 5000;
    const CARD_YIELD_MIN_RATIO = 0.5;
    // Deliberately card-SPECIFIC attributes only. An earlier draft also counted
    // `a[href*="/jobs/view/"]`, which a "similar jobs" sidebar carries on pages with no list at all —
    // that would have raised a false ❌ on a perfectly healthy page, the single worst outcome for a
    // feature whose entire value is being trusted when it fires.
    const CARD_PROBE_SELECTOR = '[data-occludable-job-id], [componentkey^="job-card-component-ref-"]';
    const CARD_PROBE_MIN = 3;
    // null, not 0, as the "not currently degraded" sentinel: 0 is a legitimate timestamp value and
    // using it as the sentinel would make the grace timer silently never start for it. Date.now() is
    // never 0 in practice, so this was correct only by accident — an explicit null is correct by design.
    let cardYieldDegradedSince = null;

    function countOrphanJobSignals() {
        let n = 0;
        for (const doc of getSearchDocuments()) {
            try { n += doc.querySelectorAll(CARD_PROBE_SELECTOR).length; } catch (e) { /* skip */ }
        }
        return n;
    }

    // `now` is a parameter purely so the grace-period state machine is testable without sleeping.
    function reportCardYieldHealth(found, parsed, now = Date.now()) {
        if (found === 0) {
            // Nothing matched CARD_CONTAINER_SELECTORS. Usually that just means "no job list on this
            // page" — but if the card-specific attributes above are present in quantity, cards ARE
            // here and it's the container chain itself that stopped matching them.
            const orphans = countOrphanJobSignals();
            if (orphans < CARD_PROBE_MIN) {
                cardYieldDegradedSince = null;
                setFeatureHealth('filtering', 'idle');
                return;
            }
            if (cardYieldDegradedSince === null) cardYieldDegradedSince = now;
            if (now - cardYieldDegradedSince < CARD_YIELD_GRACE_MS) {
                setFeatureHealth('filtering', 'idle');
                return;
            }
            setFeatureHealth('filtering', 'failed',
                `${orphans} job-card markers on the page but no card matched — container selectors may have changed`);
            return;
        }

        if (parsed > 0 && (parsed / found) >= CARD_YIELD_MIN_RATIO) {
            cardYieldDegradedSince = null;
            setFeatureHealth('filtering', 'ok');
            return;
        }

        // Degraded — but a card's outer container genuinely mounts before its inner content (v7.19),
        // so this state is NORMAL for a moment on every page load. Only a state that persists past
        // the grace window is worth reporting; anything shorter would train you to ignore the panel.
        if (cardYieldDegradedSince === null) cardYieldDegradedSince = now;
        if (now - cardYieldDegradedSince < CARD_YIELD_GRACE_MS) {
            setFeatureHealth('filtering', 'idle');
            return;
        }
        if (parsed === 0) {
            setFeatureHealth('filtering', 'failed',
                `${found} job cards found, none readable — company-name selectors may have changed`);
        } else {
            setFeatureHealth('filtering', 'fallback',
                `${found} job cards found, only ${parsed} readable`);
        }
    }

    // v7.19: a card's outer container can mount before its inner content (company name text)
    // finishes rendering — getCardInfo() returns null for a card until that content exists, and
    // filterJobListCards() silently SKIPS a null-info card entirely (not counted as classified or
    // unclassified, just invisible to the counter). forceRenderAllVisibleCards() was tracking
    // getCardElements().length (raw container count) as its "are we done yet" signal, which can
    // go quiet while several of those containers are still internally incomplete — confirmed live:
    // the container count stayed at exactly 31 across two separate captures, yet the Unclassified
    // total still changed after manual interaction gave the remaining cards time to hydrate.
    // Counts how many cards are actually USABLE right now, not just how many container elements
    // exist, so "quiet" means "stopped gaining readable cards," the thing that actually matters
    // for the counter to be accurate.
    function countParseableCards() {
        let n = 0;
        for (const card of getCardElements()) {
            if (getCardInfo(card)) n++;
        }
        return n;
    }

    function collectUncachedCards() {
        const seen = new Set();
        const uncached = [];
        getCardElements().forEach((card) => {
            const info = getCardInfo(card);
            if (!info) return;
            if (companyCache[info.normalizedName]) return;
            if (seen.has(info.normalizedName)) return;
            seen.add(info.normalizedName);
            uncached.push(info);
        });
        return uncached;
    }

    // --- Passive Company-Page Capture ------------------------------------
    // v6.4: whenever this script is running on a company's own LinkedIn page — which only ever
    // happens because you navigated there yourself while logged in, e.g. clicking through from a
    // job card — read the real "Company size" field straight out of that page's own DOM and cache
    // it. Zero extra requests (the page is already loaded), and it's the one path that can recover
    // data for companies LinkedIn gates behind a sign-in wall for anonymous fetches.
    let lastCapturedPath = null;
    function captureCompanyPageIfPresent() {
        // v7.29: see getCardInfo()'s matching comment — a real slug can contain characters (e.g.
        // an apostrophe: "victoria's-secret") that an allowlist won't anticipate. Matches up to the
        // next path separator instead, which is correct for any slug content by construction.
        const slugMatch = location.pathname.match(/^\/company\/([^/?#]+)\/?/);
        if (!slugMatch) return;
        const slug = slugMatch[1].toLowerCase();
        if (RESERVED_SLUGS.has(slug)) return;

        // Re-check once per URL change rather than every runCycle tick — extractSizeFromHtml
        // serializes the whole document, which isn't free to redo every 200ms-1s.
        if (lastCapturedPath === location.pathname) return;

        let nameEl = null;
        let sourceDoc = document;
        for (const doc of getSearchDocuments()) {
            const h1 = doc.querySelector('h1');
            if (h1) { nameEl = h1; sourceDoc = doc; break; }
        }
        if (!nameEl) return;
        const normalizedName = normalizeCompanyName(nameEl.textContent);
        if (!normalizedName) return;

        // v7.26: this USED to stop here whenever the company was already cached — meaning visiting
        // a company's own real page, the most authoritative source this file has, taught it
        // nothing if that company happened to already be classified, no matter how out of date.
        // Company sizes drift (a startup can cross a bucket within a year); a live view like this
        // one is exactly the moment to quietly reconcile that, at zero extra network cost since
        // you're already here. Never touches a MANUAL_EDIT entry — that's an explicit human
        // decision, possibly based on knowledge outside what LinkedIn currently shows, and an
        // automated re-read should never silently override it.
        const existingMeta = companyCacheMeta[normalizedName];
        if (existingMeta && existingMeta.source === CACHE_SOURCE.MANUAL_EDIT) {
            lastCapturedPath = location.pathname;
            return;
        }

        const size = extractSizeFromHtml(sourceDoc.documentElement.outerHTML);
        if (!size) return; // page hasn't finished rendering yet, or size isn't shown here — try again next tick

        lastCapturedPath = location.pathname;
        if (companyCache[normalizedName] !== size) {
            companyCache[normalizedName] = size;
            saveCache();
        }
        // v7.35: the URL you're actually on is ground truth, so this stays unconditional (it
        // self-heals a wrong stored slug) — but a disagreement is still worth recording, since on a
        // shared normalized key it means two different companies are colliding.
        recordSlugObservation(normalizedName, slug);
        if (!slugOverrides[normalizedName]) slugCache[normalizedName] = slug;
        // Re-confirmed as of now regardless of whether the value changed — "last verified" should
        // reflect that this was independently checked today, not just whenever it first got cached.
        recordCacheMeta(normalizedName, CACHE_SOURCE.COMPANY_PAGE);
        delete failedCache[normalizedName];
        saveSlugCache();
        saveCacheMeta();
        saveFailedCache();
        filterJobListCards();
    }

    // v6.5: the capture above only fires on a full navigation to /company/<slug> — but clicking a
    // job card normally just updates the right-hand detail pane inside the SAME /jobs/... URL, and
    // that pane frequently shows the company's size + connection count inline (the actual thing
    // that wasn't getting captured). Approach adapted from a companion script that already solved
    // the tricky part of this: after switching jobs, LinkedIn's SPA can show the PREVIOUS job's
    // company data for a beat before re-rendering, and reading during that window would cache the
    // wrong company's size under the new job's name. Fixed the same way — wait out a settle window
    // after any job-id change before trusting anything read from the pane.
    const DETAIL_PANE_SETTLE_MS = 1000;
    let lastSeenDetailJobId = null;
    let detailPaneSettleAt = 0;
    // v7.26: tracks which jobId's settled view has already been read once, SEPARATELY from
    // lastSeenDetailJobId (which only tracks whether we're still in the initial settle window).
    // Needed once re-verify is allowed to run against already-cached companies too: without this,
    // re-reading the pane would happen on every single runCycle tick (~every 1s) for as long as
    // that job stays open, instead of once per view.
    let reverifiedDetailJobId = null;

    // v7.61: the second invisible feature (see reportCardYieldHealth() for the first). Passive
    // capture is how the cache actually grows from normal browsing, and its failure mode is total
    // silence: `if (!size) return;` below is correct behaviour for a pane that hasn't rendered yet,
    // but it reads identically to "the About-the-company selectors no longer match anything." The
    // script would simply stop learning new companies, forever, with nothing anywhere saying so.
    //
    // Guarded conservatively, because a single null is not evidence: LinkedIn genuinely omits the
    // size field for plenty of real companies. Only a full window of consecutive DISTINCT jobs that
    // all came back empty is worth reporting — one success anywhere in the window clears it.
    const DETAIL_YIELD_WINDOW = 10;
    const detailReadOutcomes = [];
    // Tracked separately from lastSeenDetailJobId/reverifiedDetailJobId so an outcome is recorded
    // once per job rather than once per tick: a failed read RETRIES every cycle for as long as that
    // job stays open, so recording at the point of failure would fill the whole window from a single
    // job and fire a false alarm within seconds. `attempted` is only set once extraction was actually
    // reached — a job skipped for MANUAL_EDIT, or never matched to a company, is not a failed read
    // and must not count as one.
    let detailAttemptedJobId = null;
    let detailSucceededJobId = null;

    function recordDetailReadOutcome(success) {
        detailReadOutcomes.push(!!success);
        while (detailReadOutcomes.length > DETAIL_YIELD_WINDOW) detailReadOutcomes.shift();
    }

    // Returns the detail string for a stalled state, or null when there's nothing to report.
    function detailYieldVerdict() {
        if (detailReadOutcomes.length < DETAIL_YIELD_WINDOW) return null;
        if (detailReadOutcomes.some(Boolean)) return null;
        return `last ${DETAIL_YIELD_WINDOW} jobs viewed all had unreadable company info — About-the-company selectors may have changed`;
    }

    function getCurrentJobIdFromUrl() {
        const url = location.href;
        const collectionMatch = url.match(/currentJobId=(\d+)/);
        if (collectionMatch) return collectionMatch[1];
        const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
        if (viewMatch) return viewMatch[1];
        return null;
    }

    // v7.0: shared low-level scraper for the job-detail "About the company" module — reads both
    // the size text and the "Y on LinkedIn" connection-count text from a single document. Used by
    // extractCompanySizeFromDetailPane() (for caching a size bucket) AND syncCompanyBadge() (for
    // the human-readable badge), so the two can't silently drift apart the next time LinkedIn
    // tweaks this markup — there used to be two independent copies of this scrape, one per script.
    // v7.1: more resilient fallback for locating the "About the company" module — matches on the
    // literal heading text instead of a specific CSS class, so it survives LinkedIn renaming
    // [data-view-name="job-details-about-company-module"] / .jobs-company_box (confirmed live: a
    // standalone /jobs/view/<id> page opened in a new tab exposed neither of those, nor any of the
    // known top-card header selectors — the only thing still present was the "About the company"
    // heading itself).
    function findAboutCompanySection(doc) {
        const candidates = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, span, strong');
        for (const el of candidates) {
            if (el.children.length > 0) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (text === 'about the company') {
                return el.closest('section') || (el.parentElement && el.parentElement.parentElement) || el.parentElement;
            }
        }
        return null;
    }

    function scanCompanyInlineInfo(doc) {
        let sizeText = '';
        let countText = '';

        doc.querySelectorAll('span.jobs-company__inline-information').forEach((span) => {
            const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
            if (/employees/i.test(text)) sizeText = text;
            else if (/on\s*linkedin/i.test(text)) countText = text;
        });

        if (!sizeText || !countText) {
            const companyModule =
                doc.querySelector('[data-view-name="job-details-about-company-module"]') ||
                doc.querySelector('.jobs-company_box');
            if (companyModule) {
                const rawText = (companyModule.textContent || '').replace(/\s+/g, ' ').trim();
                const sizeMatch = rawText.match(/([\d,]+\+?\s*[-–]?\s*[\d,]*\s*employees)/i);
                const countMatch = rawText.match(/([\d,]+)\s*on\s*linkedin/i);
                if (sizeMatch && !sizeText) sizeText = sizeMatch[1];
                if (countMatch && !countText) countText = `${countMatch[1]} on LinkedIn`;
            }
        }

        // v7.1: neither signal above requires the literal "Company size"/"about-company" text
        // (unlike extractSizeFromHtml's stricter anonymous-fetch parsing) — both are already
        // scoped to a specific, identified module (the inline-info spans, or the about-company
        // container), the same trust level as this section-based fallback below, just found a
        // different way when those two containers aren't present.
        if (!sizeText || !countText) {
            const aboutSection = findAboutCompanySection(doc);
            if (aboutSection) {
                const rawText = (aboutSection.textContent || '').replace(/\s+/g, ' ').trim();
                const sizeMatch = rawText.match(/([\d,]+\+?\s*[-–]?\s*[\d,]*\s*employees)/i);
                const countMatch = rawText.match(/([\d,]+)\s*on\s*linkedin/i);
                if (sizeMatch && !sizeText) sizeText = sizeMatch[1];
                if (countMatch && !countText) countText = `${countMatch[1]} on LinkedIn`;
            }
        }

        return { sizeText, countText };
    }

    function extractCompanySizeFromDetailPane() {
        for (const doc of getSearchDocuments()) {
            const { sizeText } = scanCompanyInlineInfo(doc);
            if (sizeText) return categorizeSize(sizeText);
        }
        return null;
    }

    // v7.27: captureFromJobDetailPane() never recorded a slug, so a company only ever encountered
    // by clicking through jobs (never visiting its own /company/ page, never resolved by
    // Auto-Fetch) had no way to become eligible for the planned re-verify sweep — confirmed with
    // clean isolated test data: "honeywell technologies" (auto-fetch) got a slug, "altudo" (clicked
    // manually) didn't. getCardInfo() already has a proven technique for this (grab the card's own
    // `a[href*="/company/"]`) - but that's scoped to the LIST card, and captureFromJobDetailPane()
    // already calls getCardInfo() on the matching list card while identifying the company, so a
    // company still missing a slug means its OWN list card genuinely had no such href either (same
    // "different layout, no <a> at all" gap this file already knows LinkedIn ships, e.g. v7.5's
    // componentkey layout).
    //
    // Rather than guess a selector for markup not yet seen live, a temporary read-only diagnostic
    // shipped first (v7.27, since removed) and confirmed live: the detail pane's document DOES
    // expose its own /company/<slug> link, independent of the list card's - but a broad, unscoped
    // search is unsafe. Live evidence showed two distinct kinds of noise: (1) getSearchDocuments()
    // can return a document that ALSO renders an unrelated "recommended jobs" sidebar widget with
    // several OTHER companies' /company/ links mixed in - a blind first-match would grab the wrong
    // company entirely; (2) even within the correct document, an unrelated messaging/admin widget
    // link (/company/15123156/admin/inbox) matches the same href pattern but is a bare numeric ID,
    // not a real slug. Scoping to the same two regions already proven reliable for size extraction
    // (the inline-info spans' area, the "About the company" section) excluded both kinds of noise
    // correctly in the live evidence; rejecting a purely-numeric result is kept as a cheap extra
    // safeguard in case that junk pattern ever shows up somewhere the scoping doesn't catch.
    // v7.33: factored out of extractCompanySlugFromDetailPane() below — findBadgeHeader() (see its
    // own comment further down) turned out to need the exact same "which /company/ link is really
    // THIS job's own, not some other one elsewhere on the page" answer, and this file's own history
    // (v7.0's scanCompanyInlineInfo extraction) already established that two independent copies of
    // the same scoping logic risk silently drifting apart — one shared function instead of a second
    // hand-written copy.
    function findScopedCompanyLink(doc) {
        const infoSpan = doc.querySelector('span.jobs-company__inline-information');
        if (infoSpan) {
            let node = infoSpan;
            for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
                const found = node.querySelector && node.querySelector('a[href*="/company/"]');
                if (found && found.href) return found;
            }
        }
        const aboutSection = findAboutCompanySection(doc);
        if (aboutSection) {
            const found = aboutSection.querySelector('a[href*="/company/"]');
            if (found && found.href) return found;
        }
        return null;
    }

    function extractCompanySlugFromDetailPane() {
        for (const doc of getSearchDocuments()) {
            const link = findScopedCompanyLink(doc);
            if (!link) continue;

            // v7.29: see getCardInfo()'s matching comment — same fix, same reason
            // ("victoria's-secret" truncating to "victoria" under the old allowlist).
            const slugMatch = link.href.match(/\/company\/([^/?#]+)/);
            if (!slugMatch || !slugMatch[1]) continue;
            const slug = slugMatch[1].toLowerCase();
            if (RESERVED_SLUGS.has(slug) || /^\d+$/.test(slug)) continue; // numeric junk, e.g. .../company/15123156/admin/inbox
            return slug;
        }
        return null;
    }

    function captureFromJobDetailPane() {
        // v7.61: set FIRST, so the stall verdict survives every early return below (this function
        // returns early on most ticks by design — no job open, still settling, already read). A
        // successful read overwrites it with 'ok' at the bottom.
        const stallDetail = detailYieldVerdict();
        setFeatureHealth('detailCapture', stallDetail ? 'failed' : 'idle', stallDetail || '');

        const jobId = getCurrentJobIdFromUrl();
        if (!jobId) return;

        if (jobId !== lastSeenDetailJobId) {
            // v7.61: the outgoing job reached extraction but never produced a size — record that
            // once, now that we're leaving it, rather than on every retry tick while it was open.
            if (detailAttemptedJobId && detailAttemptedJobId !== detailSucceededJobId) {
                recordDetailReadOutcome(false);
            }
            detailAttemptedJobId = null;
            lastSeenDetailJobId = jobId;
            detailPaneSettleAt = Date.now() + DETAIL_PANE_SETTLE_MS;
            return; // just switched jobs — the pane may still hold the previous job's data
        }
        if (Date.now() < detailPaneSettleAt) return; // still within the settle window
        if (jobId === reverifiedDetailJobId) return; // already read this settled view once

        // Identify which company this job belongs to via the already-scanned list cards, rather
        // than trying to scrape a company name out of the detail pane itself (fewer new selectors
        // to get wrong, and it's the same identity source the rest of the script already trusts).
        let normalizedName = null;
        for (const card of getCardElements()) {
            const info = getCardInfo(card);
            if (info && info.jobId === jobId) { normalizedName = info.normalizedName; break; }
        }
        if (!normalizedName) return;

        // v7.26: this USED to stop here (`|| companyCache[normalizedName]`) whenever the company
        // was already cached — so clicking through to the exact company you have a stale value for
        // taught the script nothing, no matter how obviously live and authoritative the pane in
        // front of you was. See captureCompanyPageIfPresent()'s matching comment for the full
        // reasoning; same MANUAL_EDIT protection applies here.
        const existingMeta = companyCacheMeta[normalizedName];
        if (existingMeta && existingMeta.source === CACHE_SOURCE.MANUAL_EDIT) {
            reverifiedDetailJobId = jobId; // a manual edit is never touched — nothing more to check
            return;
        }

        const size = extractCompanySizeFromDetailPane();
        detailAttemptedJobId = jobId; // v7.61: got as far as actually reading the pane for this job
        if (!size) return; // pane not rendered yet — keep retrying next tick until it is

        detailSucceededJobId = jobId;
        recordDetailReadOutcome(true);
        setFeatureHealth('detailCapture', 'ok');
        reverifiedDetailJobId = jobId; // got a real read either way — done with this settled view

        if (companyCache[normalizedName] !== size) {
            companyCache[normalizedName] = size;
            saveCache();
        }
        // v7.27: only worth trying if nothing's on file yet — the list card's own optimization
        // (getCardInfo(), called above while identifying normalizedName) already gets first crack
        // at it, and a company's real slug essentially never changes once known, so there's nothing
        // to re-verify here the way size needs to be.
        if (!getSlugFor(normalizedName)) { // v7.35: see getCardInfo()'s matching guard
            const slug = extractCompanySlugFromDetailPane();
            if (slug) {
                slugCache[normalizedName] = slug;
                saveSlugCache();
            }
        }
        // Re-confirmed as of now regardless of whether the value changed — see the matching
        // comment in captureCompanyPageIfPresent().
        recordCacheMeta(normalizedName, CACHE_SOURCE.JOB_DETAIL_PANE);
        delete failedCache[normalizedName];
        saveCacheMeta();
        saveFailedCache();
        filterJobListCards();
    }

    // --- Job Detail Company Badge -----------------------------------------
    // v7.0: ported from a standalone companion script ("LinkedIn Company Info Badge") the user
    // was running alongside this one, so this script now covers both jobs and that companion
    // script can be retired. Shows "🏢 X employees | Y on LinkedIn" directly on the job's top
    // card. Purely cosmetic — reads the same detail-pane module captureFromJobDetailPane() uses
    // for caching, but never writes to companyCache/slugCache itself, so nothing it does can ever
    // corrupt filtering data even if it briefly displays something wrong.
    //
    // Its stale-data guard is deliberately its own, separate from captureFromJobDetailPane()'s
    // DETAIL_PANE_SETTLE_MS hard wait: that settle window exists to protect a CACHE WRITE (worth
    // delaying up to a second to be sure), whereas the badge is a live, disposable display where
    // showing fresh data promptly matters more — so instead of a blanket delay, it wipes the
    // badge immediately on job switch and only withholds a freshly-read value that's identical to
    // the previous job's text within BADGE_STALE_GRACE_MS (the specific symptom of React not
    // having re-rendered yet), showing anything else right away.
    //
    // Unlike the companion script (which only ever ran against its own single local `document`,
    // one independent copy per frame), this badge must search every document from
    // getSearchDocuments() and create its element with THAT document's own createElement() — a
    // node created in the top document cannot be inserted into an iframe's document tree (throws
    // in real browsers), a bug the old two-script setup could never hit since each frame ran its
    // own isolated copy.
    let badgeLastSeenJobId = null;
    let badgeLastDisplayedText = null;
    let badgePreviousText = null;
    let badgeSwitchTimestamp = 0;
    // v7.48: DEBUG-only — logged once per DISTINCT selector (not once per tick, which would spam
    // every ~200ms-1s while a job stays open) so a live report can say exactly which rung of
    // findBadgeHeader() actually fired, the same kind of evidence that pinned down v7.45's and
    // v7.48's own root causes.
    let badgeLastLoggedSelector = null;

    // v7.1: reordered to try the company-name-only elements before the broader combined
    // "company · location · posted time" line, and added .top-card-layout__first-sub-line — the
    // standalone /jobs/view/<id> page (opened via "open in new tab") was found live to expose
    // none of the previous four selectors at all. Trying the narrowest match first also means
    // showCompanyBadge()'s inline appendChild lands right after the company name specifically,
    // not at the end of a whole multi-part line.
    const BADGE_HEADER_SELECTORS = [
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name',
        '.top-card-layout__first-sub-line',
        '.job-details-jobs-unified-top-card__primary-description',
        '.jobs-unified-top-card__primary-description'
    ];

    // v7.33: the v7.3 last-resort fallback used to live in BADGE_HEADER_SELECTORS above as a plain
    // 'a[href*="/company/"]' entry, searched document-wide via the same doc.querySelector() loop as
    // the named selectors — confirmed live (a temporary diagnostic, since removed) this was unsafe:
    // on a page where all five named selectors miss, an UNSCOPED querySelector for it can match some
    // OTHER /company/ link before ever reaching the current job's own detail-pane header. Every job card
    // in the list also carries its own /company/ link (getCardInfo() already relies on exactly
    // that), and those sit earlier in document order than the detail pane — the log showed
    // header:true with a real selector match, yet no badge was visible where expected, because the
    // element found genuinely wasn't the current job's header. Now scoped to findScopedCompanyLink()
    // (v7.28's extractCompanySlugFromDetailPane() region-scoping, factored out and reused here) —
    // the same two regions already proven reliable for "which /company/ link is really this job's
    // own", instead of the whole document.
    //
    // v7.45: reported live — on /jobs/search-results/ (the route reached via notification/
    // recommendation links) the badge was rendering correctly, but down in the "About the company"
    // section at the BOTTOM of the pane instead of beside the company name at the top, where it
    // shows correctly on /jobs/search/. Root cause: all five named BADGE_HEADER_SELECTORS missed on
    // that route's top-card markup (yet another LinkedIn layout variant — the same class of problem
    // v7.1-v7.33 kept hitting), so findBadgeHeader() fell straight through to
    // findScopedCompanyLink(), whose two regions (the inline-info span, the about-company section)
    // are BOTH intentionally scoped near the bottom-of-pane company info, not the top card — there
    // was no rung in between that actually targets the top. v7.45 tried an <h1>-based rung: walk a
    // bounded number of ancestor levels up from the job title's <h1> looking for a /company/ link
    // nearby (the same depth-limited-walk technique findScopedCompanyLink() already uses).
    //
    // v7.48: reported live and confirmed via two diagnostics that v7.45's premise was simply wrong
    // for this layout — NOT a selector needing a small tweak, a genuinely different rendering path.
    // First diagnostic: `document.querySelector('h1')` returned null outright — no <h1> anywhere on
    // the page, so the v7.45 rung never even got a chance to run. Second diagnostic (scanning for
    // any heading tag/role=heading, and separately for any class containing "job-title" or
    // "top-card"): still nothing for the job title specifically, AND the page's other headings
    // ("About the job", "About the company", etc.) carry hashed/auto-generated class names
    // (e.g. "_20e55808 b0593cae fdf81ae8 ...") instead of LinkedIn's usual BEM-style
    // "job-details-jobs-unified-top-card__*" naming seen on every other layout this file has ever
    // hit — a different frontend build for this flow, where no tag name or class-name guess can work
    // even in principle, because there's nothing stable to guess.
    //
    // Dropped both class names and tag names as anchors entirely. What's true on every layout
    // regardless of naming: the detail pane's own /company/ link renders BEFORE the "About the
    // company" section's link in document order (confirmed on the working layout: the top-card
    // company-name element appears well before the about-company heading in the diagnostic dump),
    // and it's never inside one of the LIST's own card containers (getCardElements() already knows
    // exactly which elements those are — the same set getCardInfo() relies on for the list side).
    // So: scan every /company/ link in the document in source order, skip anything inside a list
    // card or inside the about-company section (using the same two exclusions rather than just one,
    // so this can never coincide with the OLD wrong-position fallback even if some future layout
    // breaks the ordering assumption), and take the first survivor. Still not verified live — if
    // this also lands wrong, DEBUG will show exactly which href it picked and why.
    function findTopCardCompanyLink(doc) {
        const aboutSection = findAboutCompanySection(doc);
        const cards = getCardElements();
        const links = doc.querySelectorAll('a[href*="/company/"]');
        for (const link of links) {
            if (aboutSection && aboutSection.contains(link)) continue;
            if (cards.some((card) => card.contains(link))) continue;
            return link;
        }
        return null;
    }

    // v7.58: reported live via a Diagnose report — on a /jobs/search/ layout where the actual open
    // job's detail pane rendered inside the iframe (h1 present, a named selector matched there) while
    // the top document held only the job LIST (no real detail content at all), the OLD per-document
    // loop below committed to the top document's WEAK fallback match — the first job card's own
    // /company/ link (Amazon), completely unrelated to the actually-open job — before ever reaching
    // the iframe, where a real named-selector match was sitting the whole time. A fallback match in
    // an earlier document must never outrank a named match in a later one; the badge showing the
    // wrong company entirely is a correctness bug, not a cosmetic one — the same class this project
    // has been burned by before (the v6.5 Handshake incident, referenced at the top of this file).
    // Restructured into two passes: every document is checked for a NAMED selector match first,
    // before any document's fallback is even considered — so document order can no longer let a
    // weak match in doc[0] pre-empt a strong match in doc[1]. Only if NO document has a named match
    // anywhere does the fallback pass run, in the same per-document priority order as before.
    // v7.61: records which rung won (see recordSelectorHit()). Unlike getCardInfo()'s chain, this one
    // is genuinely sequential BY DESIGN — v7.1 deliberately ordered it narrowest-match-first so the
    // badge lands beside the company name rather than at the end of a combined "company · location ·
    // posted" line — so it keeps its own loop and simply reports at each exit, rather than being
    // routed through queryWithAttribution(). Same measurement, no change to which element wins.
    // v7.63 (P2) — the first structural rung written from REAL captured markup rather than guessed at.
    // v7.62's DOM skeleton returned this shape on every one of four different companies:
    //
    //   <a href="https://www.linkedin.com/company/bitgo/..." componentkey="auto-binding-...">
    //     <div componentkey="auto-binding-..." aria-label="Company, BitGo.">
    //
    // aria-label is the strongest anchor this file has ever had for the badge, and categorically
    // better than what it replaces at the top of the fallback pass. findTopCardCompanyLink() picks by
    // DOCUMENT ORDER — the first /company/ link that isn't inside a list card or the about-section —
    // which is positional, not identity-bearing. The same captures show why that's a live risk rather
    // than a theoretical one: one page carried /company/cgi/, /company/bell/ and /company/servicenow/
    // links alongside the real employer's, and ordering was the only thing keeping the badge on the
    // right company. A link the page itself labels "Company, <name>" is the employer by declaration.
    //
    // It also survives what keeps breaking everything else here: aria-label is an accessibility
    // attribute, so it's untouched by the CSS-module class hashing confirmed in v7.48 and again in
    // v7.62 (every class on that layout is now a hash like "_033a7091 fe2263dc"), and it's the kind of
    // attribute a company under accessibility-compliance obligations does not quietly delete.
    //
    // Returns the ANCHOR, not the labelled div — deliberately the same element findTopCardCompanyLink()
    // would have returned, so this changes only HOW the badge's host is found, never where the badge
    // renders. Carries the identical list-card and about-section exclusions, so it can only ever be
    // more selective than the rung it sits above, never less.
    const COMPANY_ARIA_LABEL_SELECTOR = '[aria-label^="Company, "]';
    const BADGE_ARIA_LABEL_LINK_LABEL = 'a[href*="/company/"] (via [aria-label^="Company, "])';
    function findAriaLabelledCompanyLink(doc) {
        const aboutSection = findAboutCompanySection(doc);
        const cards = getCardElements();
        const labelled = doc.querySelectorAll(COMPANY_ARIA_LABEL_SELECTOR);
        for (const el of labelled) {
            const link = el.closest ? el.closest('a[href*="/company/"]') : null;
            if (!link) continue;
            if (aboutSection && aboutSection.contains(link)) continue;
            if (cards.some((card) => card.contains(link))) continue;
            return link;
        }
        return null;
    }

    const BADGE_TOP_CARD_LINK_LABEL = 'a[href*="/company/"] (top-card, first non-list/non-about)';

    function findBadgeHeader() {
        const docs = getSearchDocuments();
        for (const doc of docs) {
            for (const selector of BADGE_HEADER_SELECTORS) {
                const header = doc.querySelector(selector);
                if (header) { recordSelectorHit('badge.header', selector); return { doc, header, selector }; }
            }
        }
        for (const doc of docs) {
            // v7.63: above findTopCardCompanyLink() because it selects by IDENTITY (the page's own
            // "Company, <name>" label) rather than by document position — see its comment. Same
            // exclusions, so it can only ever be the more selective of the two.
            const labelledLink = findAriaLabelledCompanyLink(doc);
            if (labelledLink) {
                const selector = BADGE_ARIA_LABEL_LINK_LABEL;
                recordSelectorHit('badge.header', selector);
                return { doc, header: labelledLink, selector };
            }
            const topLink = findTopCardCompanyLink(doc);
            if (topLink) {
                const selector = BADGE_TOP_CARD_LINK_LABEL;
                recordSelectorHit('badge.header', selector);
                return { doc, header: topLink, selector };
            }
            const scopedLink = findScopedCompanyLink(doc);
            if (scopedLink) {
                const selector = 'a[href*="/company/"] (scoped)';
                recordSelectorHit('badge.header', selector);
                return { doc, header: scopedLink, selector };
            }
        }
        recordSelectorHit('badge.header', '(no match)');
        return null;
    }

    // v7.62: reported live — the Data tab showed a permanent "⚠️ Company size badge" on
    // /jobs/search-results/ while the badge itself was working perfectly. The health call was
    // `!BADGE_HEADER_SELECTORS.includes(selector)`, i.e. "anything that isn't a named selector is a
    // degradation". That premise is wrong on this layout, and the Diagnose report proved it: h1=0,
    // all five named selectors false, and cards matching ONLY the componentkey container. This is
    // the build v7.5 and v7.48 both hit — hashed class names ("_20e55808 b0593cae fdf81ae8"), no
    // job-title heading of any kind. None of BADGE_HEADER_SELECTORS can EVER match here, so
    // findTopCardCompanyLink() winning isn't a primary path missing; it's the mechanism v7.48 built
    // FOR this exact layout doing its job. The warning could therefore never clear, and a warning
    // that is permanently on is one you stop reading — the same reason the card probe deliberately
    // excludes `a[href*="/jobs/view/"]` (v7.61).
    //
    // Not silenced, though: on the BEM layout (/jobs/search/, where a named selector really does
    // match — confirmed at 100% in the same round of reports) a drop to the structural rung IS a
    // genuine degradation and still reports fallback. So the question isn't "which rung won" but
    // "was a better rung even available on this layout". Note this only ever downgrades a warning to
    // ok for one specific rung on one specific layout — a total miss still reports failed via
    // findBadgeHeader() returning null, so a real break here cannot be masked by it.
    const COMPONENT_KEY_CARD_ATTR_SELECTOR = '[componentkey^="job-card-component-ref-"]';
    function isComponentKeyLayout() {
        for (const doc of getSearchDocuments()) {
            try {
                if (doc.querySelector(COMPONENT_KEY_CARD_ATTR_SELECTOR)) return true;
            } catch (e) { /* inaccessible document — skip */ }
        }
        return false;
    }

    // v7.63: the aria-label rung is listed here unconditionally, unlike the top-card rung below it.
    // That's the deliberate difference — the top-card rung is exempted only on the layout where no
    // named selector can exist, because on any OTHER layout reaching it means a named selector that
    // could have matched didn't (a real degradation). The aria-label rung isn't a degraded path
    // anywhere: it's a stronger, identity-based anchor than the class names it sits behind, so it
    // winning on any layout is a good outcome, not a warning. Reaching the SCOPED rung still warns
    // everywhere — that one means both structural rungs above it missed too.
    const BADGE_ALWAYS_EXPECTED_RUNGS = [BADGE_ARIA_LABEL_LINK_LABEL];
    function isExpectedBadgeRung(selector) {
        if (BADGE_HEADER_SELECTORS.includes(selector)) return true;
        if (BADGE_ALWAYS_EXPECTED_RUNGS.includes(selector)) return true;
        return selector === BADGE_TOP_CARD_LINK_LABEL && isComponentKeyLayout();
    }

    function removeCompanyBadge() {
        for (const doc of getSearchDocuments()) {
            const badge = doc.getElementById(BADGE_ID);
            if (badge) badge.remove();
        }
    }

    function showCompanyBadge(doc, header, text) {
        let badge = doc.getElementById(BADGE_ID);
        if (badge) {
            if (badge.textContent !== text) badge.textContent = text;
            return;
        }
        badge = doc.createElement('div');
        badge.id = BADGE_ID;
        // v7.1: appended INSIDE the header element (right after its existing text) instead of as
        // a block-level sibling after it — lands inline, on the right side of the company name,
        // where it ends, instead of wrapping onto its own line below.
        badge.style.cssText = `
            background-color: #059669; color: #ffffff; font-size: 13px; font-weight: 700;
            padding: 4px 10px; border-radius: 6px; margin-left: 10px;
            display: inline-block; vertical-align: middle;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2); line-height: 1.4;
        `;
        badge.textContent = text;
        header.appendChild(badge);
    }

    function syncCompanyBadge() {
        const currentJobId = getCurrentJobIdFromUrl();

        if (currentJobId !== badgeLastSeenJobId) {
            removeCompanyBadge();
            badgePreviousText = badgeLastDisplayedText;
            badgeLastDisplayedText = null;
            badgeSwitchTimestamp = Date.now();
            badgeLastSeenJobId = currentJobId;
        }

        if (!currentJobId) {
            setFeatureHealth('badge', 'idle', 'no job open');
            return;
        }

        let sizeText = '', countText = '';
        for (const doc of getSearchDocuments()) {
            const info = scanCompanyInlineInfo(doc);
            if (info.sizeText || info.countText) {
                sizeText = info.sizeText;
                countText = info.countText;
                break;
            }
        }
        if (!sizeText && !countText) {
            setFeatureHealth('badge', 'idle', 'waiting for company data to render');
            return; // nothing rendered yet — try again next tick
        }

        const text = sizeText && countText ? `${sizeText}  |  ${countText}` : (sizeText || countText);

        const looksStale = text === badgePreviousText && (Date.now() - badgeSwitchTimestamp) < BADGE_STALE_GRACE_MS;
        if (looksStale) return; // previous status still accurate — this is a debounce, not a new attempt

        // v7.49: this is the one outcome that's a genuine problem — there's text to show and
        // nowhere to put it. Every other early return above is either "nothing to do yet" (idle)
        // or "already showing the right thing" (no-op), neither of which should ever read as broken.
        const located = findBadgeHeader();
        if (!located) {
            setFeatureHealth('badge', 'failed', 'no header or company link found for this page layout');
            return;
        }
        if (DEBUG && located.selector !== badgeLastLoggedSelector) {
            badgeLastLoggedSelector = located.selector;
            dbg('badge: header located via', located.selector, 'href:', located.header && located.header.href);
        }
        setFeatureHealth('badge', isExpectedBadgeRung(located.selector) ? 'ok' : 'fallback', located.selector);
        showCompanyBadge(located.doc, located.header, `🏢 ${text}`);
        badgeLastDisplayedText = text;
    }

    // --- DOM skeleton capture ---------------------------------------------
    // v7.62: every diagnostic added so far reports counts and booleans — enough to prove WHICH chain
    // broke, never enough to write the replacement. That gap has been filled by hand every time
    // (v7.5, v7.27, v7.48 each needed a temporary throwaway diagnostic shipped, run, and removed
    // before the real fix could even be attempted), which costs a full round-trip per incident. This
    // dumps the actual structure of the two regions that matter — a job card, and whatever the badge
    // anchored to — so the next markup change can be answered from the first report instead of the
    // second.
    //
    // Structure, not content: element text is capped at DOM_SKELETON_TEXT_CAP and only DIRECT text
    // nodes are read (never a parent's whole subtree collapsed into one blob), attribute values are
    // truncated, and the walk is bounded on all three axes — depth, siblings per level, and a hard
    // total-node budget — so this can't turn a bug report into a page dump. Scoped to a job card and
    // the badge header's immediate region, both of which contain job/company text that this report
    // already exposes in full via /company/ hrefs; nothing here reaches messaging, connections, or
    // profile areas.
    // v7.63: all four caps retuned against the first real captures this produced (v7.62's own output,
    // which is exactly what it was built to enable). Every change below fixes an observed defect,
    // not a hypothetical one:
    //   depth 4 -> 7        the componentkey card's <p> elements — the ones actually holding the
    //                       company name, the single thing the card rung needs — sat BELOW the cap,
    //                       so the capture couldn't answer the question it was added to answer.
    //   attr value 40 -> 100 truncated the two most load-bearing values in the whole dump:
    //                       href="...linkedin.com/company/bitgo/l" (slug lost) and
    //                       aria-label="Company, BCE Global Tech - A Bell Canada" (cut mid-name).
    //   nodes 60 -> 120     needed to reach the extra depth without the budget binding first.
    // v7.64: 7 -> 9. The live capture stopped one level short of the componentkey card's content
    // ("<div class=\"c4936755\" data-display-contents=\"true\"> … 1 child element(s), depth cap
    // reached"). Raised once more, but this is no longer the mechanism relied on to answer the card
    // question — see buildCardTextInventory(), which doesn't depend on guessing a sufficient depth.
    const DOM_SKELETON_MAX_DEPTH = 9;
    const DOM_SKELETON_MAX_CHILDREN = 6;
    const DOM_SKELETON_MAX_NODES = 160;
    const DOM_SKELETON_TEXT_CAP = 60;
    const DOM_SKELETON_CLASS_CAP = 90;
    const DOM_SKELETON_ATTR_VALUE_CAP = 100;

    // v7.63: the budget was being spent walking icon internals — the real capture showed a job card
    // descending <figure aria-hidden="true"> -> <svg> -> <path d="M14 12a2 2 0 1 1-2-2...">, burning
    // nodes on decoration while the company name sat unreached further down. Both rules below are
    // semantic rather than a tag blocklist: aria-hidden="true" is the DOM's own declaration that a
    // subtree carries no meaningful content, and an <svg>'s children are drawing instructions by
    // definition. Neither can ever contain a company name, so neither is worth a single node of a
    // budget that exists to reach one. The element itself is still reported — only its interior is
    // skipped, and the line says so.
    function isPresentationalSubtree(el) {
        if (el.tagName && el.tagName.toLowerCase() === 'svg') return true;
        return !!(el.getAttribute && el.getAttribute('aria-hidden') === 'true');
    }

    // Direct child text nodes only. An element's full textContent would fold every descendant's text
    // into the parent, which is exactly what makes "which element actually holds the company name?"
    // unanswerable from a dump — the thing this exists to answer.
    function directTextOf(el) {
        let text = '';
        const nodes = el.childNodes || [];
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].nodeType === 3) text += nodes[i].nodeValue || '';
        }
        return text.replace(/\s+/g, ' ').trim();
    }

    function describeElementSkeleton(el, depth, budget) {
        if (!el || !el.tagName || budget.left <= 0) return [];
        budget.left--;

        const tag = el.tagName.toLowerCase();
        const rawClass = (typeof el.className === 'string') ? el.className.trim() : '';
        const cls = rawClass ? ` class="${rawClass.slice(0, DOM_SKELETON_CLASS_CAP)}"` : '';
        // Attribute NAMES are often the whole answer on this codebase's problem layouts (componentkey,
        // data-occludable-job-id, role, aria-*) — they survive the class-name hashing that keeps
        // breaking the class-based rungs, so they're what a replacement selector should be built from.
        const attrs = [];
        const names = el.getAttributeNames ? el.getAttributeNames() : [];
        for (let i = 0; i < names.length && attrs.length < 10; i++) {
            const name = names[i];
            if (name === 'class' || name === 'style') continue;
            const value = String(el.getAttribute(name) || '');
            attrs.push(`${name}="${value.slice(0, DOM_SKELETON_ATTR_VALUE_CAP)}"`);
        }
        const ownText = directTextOf(el).slice(0, DOM_SKELETON_TEXT_CAP);
        const pad = '  '.repeat(depth);
        const lines = [`${pad}<${tag}>${cls}${attrs.length ? ' ' + attrs.join(' ') : ''}${ownText ? ` text="${ownText}"` : ''}`];

        const children = el.children ? Array.from(el.children) : [];
        if (children.length && isPresentationalSubtree(el)) {
            lines.push(`${pad}  … ${children.length} child element(s), presentational subtree not walked`);
            return lines;
        }
        if (depth >= DOM_SKELETON_MAX_DEPTH) {
            if (children.length) lines.push(`${pad}  … ${children.length} child element(s), depth cap reached`);
            return lines;
        }
        children.slice(0, DOM_SKELETON_MAX_CHILDREN).forEach((child) => {
            describeElementSkeleton(child, depth + 1, budget).forEach((line) => lines.push(line));
        });
        if (children.length > DOM_SKELETON_MAX_CHILDREN) {
            lines.push(`${pad}  … ${children.length - DOM_SKELETON_MAX_CHILDREN} more sibling(s) not shown`);
        }
        return lines;
    }

    function renderElementSkeleton(el) {
        if (!el) return '(nothing to describe)';
        const budget = { left: DOM_SKELETON_MAX_NODES };
        const lines = describeElementSkeleton(el, 0, budget);
        if (budget.left <= 0) lines.push(`  … node budget (${DOM_SKELETON_MAX_NODES}) exhausted, output truncated`);
        return lines.join('\n');
    }

    // v7.64: the structural skeleton above was raised to depth 7 in v7.63 and STILL didn't reach the
    // componentkey card's company name — the live capture showed it stopping at
    // `<div class="c4936755" data-display-contents="true"> … 1 child element(s), depth cap reached`
    // with the actual content one level below. Raising the cap a third time is guessing at how deep
    // "deep enough" is; the real problem is that a blind depth-first walk spends its budget on
    // wrapper divs, and this layout is almost entirely wrapper divs.
    //
    // This is the targeted view instead: every element in the card that carries its OWN text, with
    // the ancestor path and — critically — its child count, because that is the exact predicate
    // findComponentKeyCompanyElement() selects on ("first childless <p> with text"). One glance says
    // which element that rung lands on and whether anything better is available, in a fraction of the
    // output a deeper dump would need.
    const CARD_TEXT_INVENTORY_MAX = 30;
    function buildCardTextInventory(card) {
        const out = [];
        (function walk(el, path) {
            if (!el || !el.tagName || out.length >= CARD_TEXT_INVENTORY_MAX) return;
            if (isPresentationalSubtree(el)) return;
            const tag = el.tagName.toLowerCase();
            const here = path ? `${path}>${tag}` : tag;
            const text = directTextOf(el);
            if (text) {
                const firstClass = (typeof el.className === 'string' && el.className.trim())
                    ? `.${el.className.trim().split(/\s+/)[0]}` : '';
                const childCount = el.children ? el.children.length : 0;
                const label = el.getAttribute && el.getAttribute('aria-label');
                out.push(`  ${here}${firstClass} children=${childCount}` +
                    `${label ? ` aria-label="${String(label).slice(0, DOM_SKELETON_ATTR_VALUE_CAP)}"` : ''}` +
                    ` text="${text.slice(0, DOM_SKELETON_TEXT_CAP)}"`);
            }
            const kids = el.children ? Array.from(el.children) : [];
            kids.forEach((child) => walk(child, here));
        })(card, '');
        if (!out.length) return '  (no text-bearing elements found in this card)';
        return out.join('\n');
    }

    // v7.64: the most direct question there is — not "what does the card look like" but "what does
    // each rung actually PICK from it". That rung's failure mode is the dangerous one: it fails by
    // selecting the WRONG element (caching a location or a "Viewed" label as a company name) rather
    // than by selecting none, so "is it working?" cannot be answered from hit rates alone.
    //
    // v7.65, two fixes, both surfaced by testing on /jobs/search/ (the BEM layout) after v7.64 had
    // been shaped almost entirely around /jobs/search-results/:
    //   1. It reported `named chain matched: <div> text=""` on a layout where the chain was working
    //      perfectly. It was reading directTextOf(), but .artdeco-entity-lockup__subtitle is a
    //      WRAPPER whose text sits in a child <span>. directTextOf() is right for the inventory
    //      above (whose whole job is saying which element owns text) and wrong here, where the
    //      question is what the rung will actually read — and getCardInfo() reads .textContent.
    //   2. It only ever traced the FIRST card, so it could not account for a MIX. The same BEM
    //      capture reported card.company at 74% named / 14% <p> fallback / 12% no-match, and a
    //      first-card-only trace can show exactly one of those three. Now traces several cards, which
    //      is what makes a mix legible at all.
    const CARD_EXTRACTION_TRACE_MAX = 6;
    // How many "first card using a rung not yet shown" entries may be appended past the cap above.
    // Two is enough to expose a three-way split (the observed 74/14/12 case) without unbounding the
    // section — the point is proving a mix EXISTS and naming its rungs, not enumerating every card.
    const CARD_TRACE_EXTRA_RUNGS = 2;

    function cardTextOf(el) {
        return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim().slice(0, DOM_SKELETON_TEXT_CAP);
    }

    // Which rung a single card resolves through, computed the way getCardInfo() itself would: the
    // named chain first, and the <p> fallback consulted ONLY when the named chain missed. Running
    // both unconditionally would report a fallback "pick" the real code never looks at.
    function traceOneCard(card) {
        const named = card.querySelector(CARD_COMPANY_SELECTORS.join(', '));
        const fallback = named ? null : findComponentKeyCompanyElement(card);
        const via = named
            ? (CARD_COMPANY_SELECTORS.find((s) => named.matches(s)) || '(unknown)')
            : (fallback ? CARD_COMPANY_FALLBACK_LABEL : 'nothing matched');
        return { via, picked: named || fallback };
    }

    function formatCardTrace(index, card, note) {
        const tag = card && card.tagName ? card.tagName.toLowerCase() : '?';
        const { via, picked } = traceOneCard(card);
        const info = getCardInfo(card);
        return `  [${index}]${note || ''} <${tag}> via=${via}` +
            ` picked="${cardTextOf(picked)}"` +
            ` resolved=${info ? `"${info.normalizedName}"` : 'null (unreadable — counts against the filtering yield)'}`;
    }

    function describeCardCompanyExtraction(cards) {
        if (!cards || !cards.length) return '  (no job cards on this page)';
        const lines = [];
        const traced = cards.slice(0, CARD_EXTRACTION_TRACE_MAX);
        traced.forEach((card, i) => lines.push(formatCardTrace(i, card)));

        // v7.66: the first N cards are not guaranteed to contain the interesting one. A live
        // /jobs/search/ capture reported card.company split 74% named / 14% <p> fallback / 12%
        // no-match, and the first six cards all took the same rung — so the report showed a uniform
        // picture of a page that demonstrably was not uniform, and the minority rungs stayed
        // unexplained purely because of where they happened to sit in the list. Scanning the
        // remainder for the first card taking a DIFFERENT rung than the ones already shown makes a
        // mix visible regardless of ordering, which is the whole point of tracing at all.
        const shownRungs = new Set(traced.map((card) => traceOneCard(card).via));
        const extras = [];
        for (let i = CARD_EXTRACTION_TRACE_MAX; i < cards.length && extras.length < CARD_TRACE_EXTRA_RUNGS; i++) {
            const { via } = traceOneCard(cards[i]);
            if (shownRungs.has(via)) continue;
            shownRungs.add(via);
            extras.push(formatCardTrace(i, cards[i], ' (first card using a different rung)'));
        }

        const untraced = cards.length - traced.length - extras.length;
        if (untraced > 0) {
            // The "all resolve through a rung already shown" clause is the reassuring half of this
            // section: without it, an untraced remainder always looks like it might be hiding the
            // interesting case, which is exactly the doubt that left the 74/14/12 split unexplained.
            lines.push(`  … ${untraced} more card(s) not traced` +
                (extras.length === 0 ? ' (all resolve through a rung already shown above)' : ''));
        }
        extras.forEach((line) => lines.push(line));
        return lines.join('\n');
    }

    // v7.51: on-demand deep dump — the Diagnose button's payload. Every fix reported this same week
    // followed the same shape: something looked broken, the only way to find out why was pasting a
    // hand-written console snippet and reporting back what came out, then waiting on the next guess
    // based on that (see CHANGELOG.md v7.45-v7.48). This is the same kind of structural probe (which
    // selectors matched, what document order looked like, which /company/ links existed and where),
    // built in once instead of reinvented per incident, and available without knowing to ask for it.
    // Deliberately sticks to structure — counts, booleans, hrefs (already-public /company/<slug>
    // URLs) — never page text/content, matching this script's existing stance elsewhere of reading
    // no more than a feature actually needs.
    // v7.55: reported live — with the v7.54 timing fix confirmed working (real /voyager/api/ traffic
    // was finally observed), the calls actually seen while clicking through jobs were all
    // voyagerMessagingGraphQL (background inbox polling), never anything job/company-related, even
    // once. That's evidence in its own right: it suggests job/company data for cards already in the
    // list isn't arriving via a live fetch() call per click at all, consistent with the badge always
    // appearing instantly with no visible loading gap. The likely explanation is that LinkedIn
    // server-renders the initial job list (and probably the first job's detail) directly into the
    // page's HTML for speed/SEO — a common SSR-hydration pattern of embedding a JSON payload in a
    // <code> or <script type="application/json"> element, which the page's own JS then reads
    // in-place instead of re-fetching. Checking for that is DOM-only (no network patching, no
    // unsafeWindow, no timing dependence at all) and reuses summarizeJsonShape() unchanged.
    // v7.56: reported live — 16 real payloads found on /jobs/search/ (zero on /jobs/search-results/,
    // one more confirmation those are genuinely different builds), but the first 5 (all this
    // reported before the cap below was raised) turned out to be i18n message bundles, feature-flag
    // entitlements, and profile data — not job/company data, which is presumably among the other 11.
    // Separately, LinkedIn's own "datalet-*" wrapper elements hold the REAL response double-encoded:
    // the wrapper is real JSON, but its own `body` field is a JSON STRING of the actual response,
    // so summarizeJsonShape() alone only ever reported `"body":"string"` and stopped there — the
    // wrapper's outer shape looks identical whether the real response is trivial or exactly what
    // this feature needs. One extra, targeted unwrap for this specific known shape (not a generic
    // "try to JSON.parse every string in the tree", which would be both slow and prone to false
    // matches on values that just happen to look numeric or quoted).
    // v7.57: reported live — of the 8 real (non-wrapper) payloads on /jobs/search/, one
    // (`jobCardPrefetchQueries` -> `prefetchJobPostingCard`) is clearly LinkedIn's own name for
    // prefetched job card data, but summarizeJsonShape()'s depth cap (5) truncated to just
    // `"prefetchJobPostingCard":"object"` right at the field that actually matters — one level short
    // of anything useful. Raising the general cap would bloat all 16 payloads' shapes, most of which
    // are irrelevant (i18n bundles, nav data, feature flags). More direct instead: search each
    // payload's real parsed content (not the depth-capped shape) for any KEY NAME that looks like a
    // company-size field, and report exactly where it lives — the path, and the value's TYPE only,
    // same never-leak-real-values stance as summarizeJsonShape(). This answers the actual question
    // ("is this data present anywhere, and where") directly, rather than hoping the right field
    // happens to survive the general shape cap.
    //
    // v7.59: confirmed live, worth recording even though phase 2 (extraction) is paused as of v7.58 —
    // a real hit landed twice, on separate /jobs/search/ sessions:
    //   $.meta.microSchema.types.com.linkedin.voyager.dash.deco.launchpad.
    //     OrganizationTopCardForEntityFollow.fields.employeeCount
    // This confirms `employeeCount` is a genuine field LinkedIn's own internal type/schema system
    // tracks for an organization "top card" component — but it's a SCHEMA declaration inside a
    // component-recipe payload whose own `elements` were empty in every capture, not an actual data
    // instance with a real value; and even on a fully-healthy page (badge matched via a named
    // selector, not the fallback) this specific payload was frequently just absent entirely, same
    // inconsistency as everything else in this investigation. Not pursued further for now, but if a
    // more reliable data-delivery mechanism ever gets investigated (e.g. an authenticated same-origin
    // request to a Voyager REST endpoint, which historically accepts a `decorationId` query param
    // referencing exactly this kind of fully-qualified type name), this is the real, confirmed field
    // and component name to start from instead of guessing one blind.
    const SIZE_LIKE_FIELD_NAME_PATTERN = /employeeCount|companySize|staffCount|staffingCompanySize|headcount|numberOfEmployees/i;
    function findSizeLikeFields(value, path, results, depth) {
        if (depth >= 15 || results.length >= 20 || value === null || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.slice(0, 5).forEach((item, i) => findSizeLikeFields(item, `${path}[${i}]`, results, depth + 1));
            return;
        }
        Object.keys(value).forEach((key) => {
            if (results.length >= 20) return;
            const childPath = `${path}.${key}`;
            if (SIZE_LIKE_FIELD_NAME_PATTERN.test(key)) {
                results.push({ path: childPath, type: Array.isArray(value[key]) ? 'array' : typeof value[key] });
            }
            findSizeLikeFields(value[key], childPath, results, depth + 1);
        });
    }

    function scanEmbeddedJsonPayloads(doc) {
        const results = [];
        Array.from(doc.querySelectorAll('code, script[type="application/json"]')).forEach((el) => {
            const text = el.textContent;
            if (!text || text.length < 2) return;
            // v7.57: split from one try/catch into two, scoped separately — JSON.parse failing here
            // is routine (plenty of <code> tags on a page aren't data payloads) and should be a
            // silent skip, but a bug in the PROCESSING below (summarizeJsonShape/findSizeLikeFields)
            // is not routine and was previously being caught by this same block and misreported as
            // "not JSON" — found via the test suite's own extraction hitting exactly this case
            // (a missing helper threw a ReferenceError that silently vanished as a skipped payload
            // instead of failing loudly). A processing bug should be visible, not indistinguishable
            // from an ordinary non-JSON <code> tag.
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                return; // not JSON — routine, not an error
            }
            try {
                // v7.66: `shape`/`bodyShape` (summarizeJsonShape) removed. They were ~20 lines per
                // report of JSON structure that produced exactly ONE actionable finding across many
                // sessions — the `employeeCount` field name, recorded in a comment next to
                // SIZE_LIKE_FIELD_NAME_PATTERN back in v7.59 — and nothing since. Every report has to
                // be pasted into a conversation by hand, so unread bulk is a real recurring cost, not
                // a neutral one. The body UNWRAP stays: it isn't the noisy part, and it's what lets
                // findSizeLikeFields see inside LinkedIn's "datalet" wrapper, which is the one thing
                // here that would still be worth knowing about if it ever hit.
                const entry = { tag: el.tagName.toLowerCase(), id: el.id || null, length: text.length };
                let bodyParsed = null;
                if (parsed && typeof parsed === 'object' && typeof parsed.body === 'string') {
                    try {
                        bodyParsed = JSON.parse(parsed.body);
                    } catch (e) { /* body isn't JSON either — nothing more to unwrap */ }
                }
                const sizeLikeFields = [];
                findSizeLikeFields(parsed, '$', sizeLikeFields, 0);
                if (bodyParsed !== null) findSizeLikeFields(bodyParsed, '$.body', sizeLikeFields, 0);
                if (sizeLikeFields.length > 0) entry.sizeLikeFields = sizeLikeFields;
                results.push(entry);
            } catch (e) {
                console.error('[Size Filter] scanEmbeddedJsonPayloads: processing a parsed payload failed unexpectedly:', e);
            }
        });
        return results;
    }

    // v7.66 (P2). The cache has no eviction and deliberately still doesn't: entries are earned one
    // page view at a time over months, and silently deleting them to solve a storage problem that
    // measurement says doesn't exist would be the worst trade in this file. localStorage allows
    // roughly 5MB per origin; at the sizes below that is six figures of companies. So this reports
    // the number rather than acting on it — if it ever does approach the limit, the report will have
    // been saying so for a long time first, and a deletion policy can then be a decision rather than
    // a guess. Approximate by construction (UTF-16 storage, JSON overhead) — an order of magnitude is
    // all that's needed to answer "is this anywhere near a problem".
    const CACHE_SIZE_WARN_ENTRIES = 20000;
    function describeCacheFootprint() {
        const companies = Object.keys(companyCache).length;
        const slugs = Object.keys(slugCache).length;
        let bytes = 0;
        try {
            bytes = JSON.stringify(companyCache).length + JSON.stringify(slugCache).length +
                JSON.stringify(companyCacheMeta).length;
        } catch (e) { bytes = -1; }
        const kb = bytes < 0 ? 'unmeasurable' : `${Math.round(bytes / 1024)} KB`;
        const note = companies >= CACHE_SIZE_WARN_ENTRIES
            ? ' — approaching the point where localStorage limits are worth thinking about'
            : ' (localStorage allows roughly 5MB per origin, so this is not close to a limit)';
        return `${companies} companies, ${slugs} slugs, ~${kb} of localStorage${note}`;
    }

    function buildDiagnosticReport() {
        const lines = [];
        lines.push('LinkedIn Company Size Filter — Diagnostic Report');
        lines.push(`Script version: ${SCRIPT_VERSION}`);
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push(`URL: ${location.href}`);
        lines.push(`List signature: ${getListSignature()}`);
        lines.push(`Job-relevant page: ${isJobRelevantPage()}`);
        lines.push(`Cache footprint: ${describeCacheFootprint()}`);
        lines.push('');
        lines.push('-- Feature health --');
        FEATURE_HEALTH_IDS.forEach((id) => {
            const h = featureHealth[id];
            if (!h) { lines.push(`${FEATURE_HEALTH_LABELS[id]}: no report yet`); return; }
            const age = `${Math.round((Date.now() - h.at) / 1000)}s ago`;
            lines.push(`${FEATURE_HEALTH_LABELS[id]}: ${h.status}${h.detail ? ' — ' + h.detail : ''} (${age})`);
        });
        lines.push('');
        // v7.61: the point of this section is the SPLIT within each chain, not the totals. A rung
        // sitting at 100% is what "working normally" looks like; the same rung at 0% with a fallback
        // carrying the traffic is LinkedIn having shipped a markup change, visible here as a one-line
        // diff instead of something to be inferred from the DOM dump further down.
        lines.push('-- Selector hit rates (this session) --');
        lines.push(formatSelectorStats());
        lines.push('');
        // v7.68, corrected v7.69: directly explains the "(no match)" share the section above reports
        // for card.company — whether it's a card resolving once its force-render sweep settles (real
        // data: resolves cluster just under FORCE_RENDER_TIMEOUT_MS) or a real, sustained miss (a
        // growing "still pending" or "given up on" count).
        lines.push('-- card.company transient misses (sweep-settle check) --');
        lines.push(formatTransientMissSummary());
        lines.push('');
        lines.push('-- Card container selectors (matched right now) --');
        const containerCounts = probeCardContainerSelectors();
        Object.keys(containerCounts).forEach((selector) => {
            lines.push(`  ${containerCounts[selector]}  ${selector}`);
        });
        lines.push(`  ${countOrphanJobSignals()}  (probe) ${CARD_PROBE_SELECTOR}`);
        lines.push('');
        // v7.66 (P3), own section — this was reported live as sitting unlabeled inside the container-
        // selector list above, which made it read as if it were one of those counts rather than what
        // it actually is: how many cards the job-title contradiction guard has rejected. A non-zero
        // count means the company rung picked a job title on some card and the pick was thrown away
        // rather than cached. Zero is the expected reading; anything else means the positional <p>
        // rung has started landing wrong.
        lines.push('-- Job-title contradiction guard --');
        lines.push(`  ${cardTitleContradictions}  cards rejected this session (company text == the card's own job title)`);
        lines.push('');
        // v7.62: the two regions every markup incident so far has turned out to hinge on. Placed
        // before the structural probe because when a chain IS broken, this is the section that says
        // what to replace it with — the rest says only that something needs replacing.
        const allCards = getCardElements();
        const firstCard = allCards[0] || null;
        // v7.64: these two come FIRST because they answer the actual question — which element holds
        // the company name, and which one each rung picks — where the structural dump below only
        // shows the shape it's buried in.
        lines.push('-- Job card: text-bearing elements (first card) --');
        lines.push(firstCard ? buildCardTextInventory(firstCard) : '  (no job card on this page)');
        lines.push('');
        lines.push(`-- Job card: what each company rung actually picks (first ${CARD_EXTRACTION_TRACE_MAX} cards) --`);
        lines.push(describeCardCompanyExtraction(allCards));
        lines.push('');
        lines.push('-- DOM skeleton: first job card --');
        lines.push(renderElementSkeleton(firstCard));
        lines.push('');
        lines.push('-- DOM skeleton: badge header region --');
        const badgeLocated = findBadgeHeader();
        if (!badgeLocated) {
            lines.push('(no header located on this page)');
        } else {
            lines.push(`resolved via: ${badgeLocated.selector}`);
            lines.push(`classified as: ${isExpectedBadgeRung(badgeLocated.selector) ? 'expected for this layout' : 'fallback (a better rung exists on this layout but missed)'}`);
            lines.push(`componentkey layout detected: ${isComponentKeyLayout()}`);
            // Two levels up, so the anchor's surrounding container is visible — a replacement
            // selector almost always needs to name an ancestor, not just the matched node itself.
            const header = badgeLocated.header;
            const region = (header.parentElement && header.parentElement.parentElement) || header.parentElement || header;
            lines.push(renderElementSkeleton(region));
        }
        lines.push('');
        lines.push('-- Structural probe --');
        lines.push(`Job cards found (all documents): ${getCardElements().length}`);
        const allSizeLikeFields = [];
        getSearchDocuments().forEach((doc, i) => {
            const docLabel = i === 0 ? 'top document' : `iframe #${i}`;
            lines.push(`[${docLabel}]`);
            lines.push(`  h1=${doc.querySelectorAll('h1').length} h2=${doc.querySelectorAll('h2').length}`);
            BADGE_HEADER_SELECTORS.forEach((sel) => {
                let found = false;
                try { found = !!doc.querySelector(sel); } catch (e) { /* not valid in this context, skip */ }
                lines.push(`  selector matched=${found}: ${sel}`);
            });
            lines.push(`  about-company section found: ${!!findAboutCompanySection(doc)}`);
            const links = Array.from(doc.querySelectorAll('a[href*="/company/"]'));
            lines.push(`  /company/ links found: ${links.length}`);
            links.slice(0, 10).forEach((a, idx) => lines.push(`    [${idx}] ${a.href}`));
            const topLink = findTopCardCompanyLink(doc);
            lines.push(`  top-card company link resolves to: ${topLink ? topLink.href : 'none'}`);
            const payloads = scanEmbeddedJsonPayloads(doc);
            lines.push(`  embedded JSON payloads found (<code>/<script type="application/json">): ${payloads.length}`);
            // v7.66: the per-payload shape dump is gone (see scanEmbeddedJsonPayloads). Payloads are
            // still fully scanned — only their STRUCTURE is no longer printed. What survives is the
            // count above and the aggregated size-field section below, which is the part that would
            // actually matter if it ever found something.
            payloads.forEach((p, idx) => {
                (p.sizeLikeFields || []).forEach((f) => {
                    allSizeLikeFields.push({ doc: docLabel, payloadId: p.id || `${p.tag}#${idx}`, path: f.path, type: f.type });
                });
            });
        });
        lines.push('');
        lines.push('-- Company-size-like fields found across all embedded payloads --');
        if (allSizeLikeFields.length === 0) {
            lines.push('None found.');
        } else {
            allSizeLikeFields.forEach((f) => lines.push(`  [${f.doc} / ${f.payloadId}] ${f.path} (${f.type})`));
        }
        return lines.join('\n');
    }

    function copyDiagnosticReport() {
        navigator.clipboard.writeText(buildDiagnosticReport())
            .then(() => alert('Diagnostic report copied to clipboard — paste it directly into the chat.'))
            .catch((err) => console.error('[Size Filter] Clipboard copy failed:', err));
    }

    function copyUnclassifiedNames() {
        const names = collectUncachedCards().map((info) => info.normalizedName);
        if (names.length === 0) {
            alert('Nothing unclassified in the current view.');
            return;
        }
        navigator.clipboard.writeText(names.join('\n'))
            .then(() => alert(`Copied ${names.length} unclassified company name(s) to clipboard.`))
            .catch((err) => console.error('[Size Filter] Clipboard copy failed:', err));
    }

    // v7.39: reported live — both management views used an ordering that put freshly-added
    // companies wherever was least convenient: openCacheManager's textarea followed companyCache's
    // raw insertion order (a batch Auto-Fetch just classified landed at the very BOTTOM, requiring a
    // scroll to the end), while openSlugManager's table sorted alphabetically (the same fresh batch
    // scattered across the list, requiring a hunt). Both now share one ordering — newest-touched
    // first — built from companyCacheMeta.timestamp, data already tracked since v7.8, so this needed
    // no new collection, only a different way to read what's already there. "Touched" deliberately
    // includes re-verification, not just first-time addition — a company confirmed again by the
    // re-verify sweep or a passive revisit is exactly as relevant to review right now as a brand-new
    // one, and the timestamp already means "last confirmed," not "first seen." An entry with no
    // timestamp at all (pre-v7.8 data) sorts last, the same "oldest/unknown" treatment
    // summarizeCacheFreshness() already gives it elsewhere.
    function getCompanyNamesByRecency(cache, meta) {
        const tsOf = (name) => (meta[name] && typeof meta[name].timestamp === 'number') ? meta[name].timestamp : 0;
        return Object.keys(cache).sort((a, b) => tsOf(b) - tsOf(a));
    }

    // v7.36: reported live — the only way to know which cached companies still had no known page
    // (and could benefit from a manual override) was to export the JSON and diff companyCache
    // against slugCache by hand.
    //
    // v7.41: originally excluded MANUAL_EDIT entries here (isReverifyEligible() skips them
    // unconditionally regardless of slug, so a slug added for one wouldn't help the re-verify sweep
    // reach it) — reversed after being reported live: the openSlugManager table this count sits
    // above has no such filter and lists every company regardless of source, so a MANUAL_EDIT
    // company with no page ("ethos") was visibly sitting in the table while silently excluded from
    // the count above it — two different definitions of "missing" in the same view, undermining the
    // one thing a summary count is for (matching what's actually on screen). The table is used for
    // more than feeding the sweep — general data completeness — so "no page, full stop" is the more
    // useful definition here even though the original reasoning about the sweep was itself correct.
    function getCompaniesMissingSlug() {
        return Object.keys(companyCache).filter((name) => !getSlugFor(name)).sort();
    }

    function copyMissingSlugNames() {
        const names = getCompaniesMissingSlug();
        if (names.length === 0) {
            alert('Every cached company (that could use one) already has a known page.');
            return;
        }
        navigator.clipboard.writeText(names.join('\n'))
            .then(() => alert(`Copied ${names.length} company name(s) with no known page to clipboard.\n\nPaste one as the key in "Company page overrides" once you've looked up its real linkedin.com/company/<slug>.`))
            .catch((err) => console.error('[Size Filter] Clipboard copy failed:', err));
    }

    // --- Automated Anonymous Company Fetcher ----------------------------
    // v7.11: cancellable, non-blocking. isFetchingUnclassified already guarded re-entrancy, but a
    // run of 20+ unclassified companies (each up to MAX_CANDIDATE_ATTEMPTS guesses, 250ms apart,
    // plus 1.5s between companies) can run for minutes with no way to stop it short of closing the
    // tab, and used to end in a blocking alert() that held up the page until dismissed. Checked at
    // three points — top of the per-company loop, and inside both the candidate-guess sub-loop and
    // right before the inter-company delay — so a cancel request lands within one in-flight
    // request rather than waiting out whatever's left of the current company's guess budget.
    //
    // v7.12: adaptive backoff. Every delay used to be fixed regardless of outcome — a real HTTP
    // 429 got the same 250ms/1.5s pause as a normal 404, so a run that started tripping LinkedIn's
    // (or a search engine's) rate limiting would just keep hammering it at the same pace. Each
    // makeAnonymousRequest outcome is now fed through registerRequestOutcome(): a 429/503 doubles
    // the delay (capped at MAX_BACKOFF_DELAY_MS) and counts toward MAX_CONSECUTIVE_RATE_LIMITS,
    // after which the whole run stops itself rather than continuing to escalate forever; anything
    // else (success OR an unrelated failure like 404/authwall/timeout, none of which indicate
    // throttling — see v6.3) resets straight back to the base delay.
    async function autoFetchUnclassifiedCompanies(autoBtn) {
        if (isFetchingUnclassified) return;
        // v7.32: previously only reverifyStaleCompanies() checked the OTHER flag — Auto-Fetch could
        // be started while a re-verify sweep was already mid-run, silently doubling the anonymous
        // request rate the mutual-exclusion check exists to prevent. Made symmetric.
        if (isReverifying) {
            alert('Re-verify is currently running — wait for it to finish before starting Auto-Fetch (both make anonymous requests off the same connection).');
            return;
        }
        const cooldownRemainingMs = getRunCooldownRemainingMs(Date.now());
        if (cooldownRemainingMs > 0) {
            alert(formatRunCooldownMessage(cooldownRemainingMs));
            return;
        }

        const unclassifiedEntries = collectUncachedCards();

        if (unclassifiedEntries.length === 0) {
            alert('No unclassified companies found in current view.');
            return;
        }

        isFetchingUnclassified = true;
        cancelFetchRequested = false;
        let successCount = 0;
        let skippedCount = 0;
        let processedCount = 0;

        let candidateDelayMs = BASE_CANDIDATE_DELAY_MS;
        let companyDelayMs = BASE_COMPANY_DELAY_MS;
        let consecutiveRateLimitHits = 0;
        let rateLimitedStop = false;
        // v7.32: unlike consecutiveRateLimitHits (reset to 0 by any non-rate-limit outcome, so it
        // only reflects the CURRENT streak), this tracks whether the run saw a rate-limit signal AT
        // ALL, even one that later recovered — the signal the cooldown tier below needs.
        let sawAnyRateLimitThisRun = false;

        for (let i = 0; i < unclassifiedEntries.length; i++) {
            if (cancelFetchRequested || rateLimitedStop) break;

            // Declared fresh per company (registerRequestOutcome closes over both this AND the
            // persistent backoff state above) so a company that failed ONLY because of a 429 can
            // be told apart from one that genuinely couldn't be resolved — a rate-limit failure
            // isn't the company's fault and would very likely succeed on a later run once
            // whatever's throttling this clears, so it shouldn't eat a 7-day cooldown either.
            let wasRateLimitedThisCompany = false;
            function registerRequestOutcome(error) {
                if (isRateLimitSignal(error)) {
                    wasRateLimitedThisCompany = true;
                    sawAnyRateLimitThisRun = true;
                    consecutiveRateLimitHits++;
                    candidateDelayMs = Math.min(candidateDelayMs * 2, MAX_BACKOFF_DELAY_MS);
                    companyDelayMs = Math.min(companyDelayMs * 2, MAX_BACKOFF_DELAY_MS);
                    if (consecutiveRateLimitHits >= MAX_CONSECUTIVE_RATE_LIMITS) rateLimitedStop = true;
                } else {
                    consecutiveRateLimitHits = 0;
                    candidateDelayMs = BASE_CANDIDATE_DELAY_MS;
                    companyDelayMs = BASE_COMPANY_DELAY_MS;
                }
            }

            const rawName = unclassifiedEntries[i].normalizedName;
            // Case-preserved text for slug guessing (see generateCandidateSlugs' camelCase-split
            // handling) — rawName is the lowercase/merged cache key, not useful for guessing.
            const guessName = unclassifiedEntries[i].displayName || rawName;
            processedCount = i + 1;
            autoBtn.innerText = `⏹ Cancel (${i + 1}/${unclassifiedEntries.length})`;
            setFetchStatus(consecutiveRateLimitHits > 0
                ? `Fetching ${i + 1} of ${unclassifiedEntries.length} — rate-limited, backed off to ${(companyDelayMs / 1000).toFixed(1)}s between companies...`
                : `Fetching ${i + 1} of ${unclassifiedEntries.length} — ${successCount} classified so far.`);

            const failedAt = failedCache[rawName];
            if (failedAt && (Date.now() - failedAt) < FAILED_COOLDOWN_MS) {
                skippedCount++;
                continue;
            }

            let companySize = null;
            let resolvedSlug = null;
            let resolvedVia = null;

            // 1. Check Slug Cache (populated by DOM or previous runs)
            const knownSlug = getSlugFor(rawName); // v7.35: manual override wins over slugCache
            if (knownSlug) {
                try {
                    const html = await makeAnonymousRequest(`https://www.linkedin.com/company/${knownSlug}`);
                    registerRequestOutcome(null);
                    const size = extractSizeFromHtml(html);
                    if (size && verifyPageMatchesCompany(html, rawName)) {
                        companySize = size;
                        resolvedSlug = knownSlug;
                        resolvedVia = CACHE_SOURCE.AUTO_FETCH_SLUG_CACHE;
                    }
                    // v6.3: a 200 response with no extractable size doesn't prove the slug is
                    // wrong (could be a temporary layout/parsing miss) — leave it cached and just
                    // fall through to re-derive the size below via the same slug.
                } catch (e) {
                    registerRequestOutcome(e);
                    // v6.3: only evict on a definitive 404 (slug renamed/removed). Timeouts,
                    // network errors, and authwall hits are transient — evicting on those forced
                    // a full 20-guess rediscovery storm on every hiccup for a slug that was
                    // already correctly resolved.
                    if (e.message === 'HTTP 404') {
                        delete slugCache[rawName];
                        // v7.35: excluded from the merge — without this the stored copy would
                        // immediately put the dead slug back and the eviction would do nothing.
                        saveSlugCache({ excludeName: rawName });
                    }
                }
            }

            // 2. Candidate Variants Engine (capped at MAX_CANDIDATE_ATTEMPTS)
            if (!companySize && !cancelFetchRequested && !rateLimitedStop) {
                const candidates = generateCandidateSlugs(guessName).slice(0, MAX_CANDIDATE_ATTEMPTS);
                for (const candidate of candidates) {
                    if (cancelFetchRequested || rateLimitedStop) break;
                    try {
                        const html = await makeAnonymousRequest(`https://www.linkedin.com/company/${candidate}`);
                        registerRequestOutcome(null);
                        const size = extractSizeFromHtml(html);
                        if (size && verifyPageMatchesCompany(html, rawName)) {
                            companySize = size;
                            resolvedSlug = candidate;
                            resolvedVia = CACHE_SOURCE.AUTO_FETCH_CANDIDATE_GUESS;
                            break;
                        }
                    } catch (e) {
                        registerRequestOutcome(e);
                    }
                    await sleep(candidateDelayMs);
                }
            }

            // 3. Search Fallback Engine (Bing -> Google -> DuckDuckGo)
            if (!companySize && !cancelFetchRequested && !rateLimitedStop) {
                const searchedSlug = await searchLinkedInSlugInBrowser(guessName);
                if (searchedSlug) {
                    try {
                        const html = await makeAnonymousRequest(`https://www.linkedin.com/company/${searchedSlug}`);
                        registerRequestOutcome(null);
                        const size = extractSizeFromHtml(html);
                        if (size && verifyPageMatchesCompany(html, rawName)) {
                            companySize = size;
                            resolvedSlug = searchedSlug;
                            resolvedVia = CACHE_SOURCE.AUTO_FETCH_SEARCH_FALLBACK;
                        }
                    } catch (e) {
                        registerRequestOutcome(e);
                    }
                }
            }

            // Save Result if Found
            if (companySize && resolvedSlug) {
                companyCache[rawName] = companySize;
                slugCache[rawName] = resolvedSlug;
                recordCacheMeta(rawName, resolvedVia);
                delete failedCache[rawName];
                saveCache();
                saveSlugCache();
                saveCacheMeta();
                saveFailedCache();
                filterJobListCards(); // Live update feed
                successCount++;
            } else if (!cancelFetchRequested && !rateLimitedStop && !wasRateLimitedThisCompany) {
                // A company abandoned mid-cancel, mid-rate-limit-stop, or that hit a 429/503 on
                // its own request hasn't genuinely failed — it just wasn't finished, or failed for
                // a reason that has nothing to do with whether it's actually resolvable. Don't put
                // it on a week-long cooldown for something that was never really attempted to a
                // real conclusion.
                failedCache[rawName] = Date.now();
                saveFailedCache();
            }

            // Delay between companies
            if (i < unclassifiedEntries.length - 1 && !cancelFetchRequested && !rateLimitedStop) {
                await sleep(companyDelayMs);
            }
        }

        isFetchingUnclassified = false;
        recordAnonymousRunFinished(rateLimitedStop ? 'autoStopped' : (sawAnyRateLimitThisRun ? 'rateLimited' : 'clean'));
        const wasCancelled = cancelFetchRequested;
        cancelFetchRequested = false;
        autoBtn.innerText = '⚡ Auto-Fetch Unclassified Companies';
        const attempted = processedCount - skippedCount;
        const skippedNote = skippedCount > 0 ? ` ${skippedCount} skipped (cooldown).` : '';
        const headline = rateLimitedStop
            ? `Stopped after ${processedCount} of ${unclassifiedEntries.length} — repeated rate-limit responses. Try again later.`
            : wasCancelled
                ? `Cancelled after ${processedCount} of ${unclassifiedEntries.length}.`
                : 'Finished!';
        setFetchStatus(`${headline} Classified ${successCount} of ${attempted} attempted.${skippedNote}`);
    }

    // v7.30: the re-verify sweep itself. Much simpler than Auto-Fetch's pipeline — there's no
    // identity ambiguity to resolve (the slug is already known and trusted), so this is just tier 1
    // of that pipeline (fetch the known page, verify, extract) run in a loop, reusing the exact
    // same anonymous-request primitives, adaptive backoff, and sequential-with-delay pacing this
    // whole file is built around for the same anonymity reasons. Saves incrementally per company
    // (not batched to the end) so a closed tab mid-run keeps whatever finished, exactly like
    // Auto-Fetch already does.
    async function reverifyStaleCompanies(btn, selectEl, thresholdDays) {
        if (isFetchingUnclassified) {
            alert('Auto-Fetch is currently running — wait for it to finish before starting a re-verify sweep (both make anonymous requests off the same connection).');
            return;
        }
        if (isReverifying) return;
        const cooldownRemainingMs = getRunCooldownRemainingMs(Date.now());
        if (cooldownRemainingMs > 0) {
            alert(formatRunCooldownMessage(cooldownRemainingMs));
            return;
        }

        const candidates = getReverifyCandidates(thresholdDays);
        if (candidates.length === 0) {
            const etaMs = getReverifyNextEtaMs(thresholdDays);
            if (etaMs === null) {
                alert('No companies are eligible for re-verification yet — nothing both meets the age threshold and has a known page to re-check.');
            } else {
                const days = Math.max(1, Math.ceil(etaMs / FRESHNESS_DAY_MS));
                alert(`No companies are due for re-verification yet. The next one becomes eligible in about ${days} day${days === 1 ? '' : 's'}.`);
            }
            return;
        }

        // Rough ETA range for the confirm prompt — low end assumes no rate-limiting at all (base
        // delay throughout), high end assumes a few rounds of backoff along the way. Genuinely a
        // range, not a promise — the adaptive backoff means the real time depends entirely on how
        // LinkedIn responds during the run.
        const etaLowMin = Math.max(1, Math.round((candidates.length * BASE_COMPANY_DELAY_MS) / 60000));
        const etaHighMin = Math.max(etaLowMin, Math.round((candidates.length * BASE_COMPANY_DELAY_MS * 3) / 60000));
        const missingSlugCount = countReverifyMissingSlug(thresholdDays);
        const missingSlugNote = missingSlugCount > 0
            ? `\n\n${missingSlugCount} more compan${missingSlugCount === 1 ? 'y is' : 'ies are'} also due but ${missingSlugCount === 1 ? "doesn't" : "don't"} have a known page yet — clicking through one of ${missingSlugCount === 1 ? 'its' : 'their'} jobs first will make ${missingSlugCount === 1 ? 'it' : 'them'} reachable next time.`
            : '';
        const confirmed = confirm(
            `This will re-check ${candidates.length} compan${candidates.length === 1 ? 'y' : 'ies'} via ${candidates.length === 1 ? 'its' : 'their'} known page${candidates.length === 1 ? '' : 's'} — roughly ${etaLowMin}-${etaHighMin} minute${etaHighMin === 1 ? '' : 's'} depending on rate limiting. Keep this tab open until it finishes.${missingSlugNote}\n\nContinue?`
        );
        if (!confirmed) return;

        isReverifying = true;
        cancelReverifyRequested = false;
        if (selectEl) selectEl.disabled = true;
        let changedCount = 0, unchangedCount = 0, failedCount = 0, processedCount = 0;

        let companyDelayMs = BASE_COMPANY_DELAY_MS;
        let consecutiveRateLimitHits = 0;
        let rateLimitedStop = false;
        // v7.32: see the matching flag in autoFetchUnclassifiedCompanies() — tracks whether the run
        // saw a rate-limit signal at all, not just the current streak, for the cooldown tier below.
        let sawAnyRateLimitThisRun = false;

        for (let i = 0; i < candidates.length; i++) {
            if (cancelReverifyRequested || rateLimitedStop) break;

            const rawName = candidates[i];
            const slug = getSlugFor(rawName);
            processedCount = i + 1;
            btn.innerText = `⏹ Cancel Re-verify (${i + 1}/${candidates.length})`;
            setReverifyStatus(consecutiveRateLimitHits > 0
                ? `Re-verifying ${i + 1} of ${candidates.length} — rate-limited, backed off to ${(companyDelayMs / 1000).toFixed(1)}s between companies...`
                : `Re-verifying ${i + 1} of ${candidates.length} — ${changedCount} changed, ${unchangedCount} confirmed so far.`);

            try {
                const html = await makeAnonymousRequest(`https://www.linkedin.com/company/${slug}`);
                consecutiveRateLimitHits = 0;
                companyDelayMs = BASE_COMPANY_DELAY_MS;
                const size = extractSizeFromHtml(html);
                if (size && verifyPageMatchesCompany(html, rawName)) {
                    if (companyCache[rawName] !== size) {
                        companyCache[rawName] = size;
                        saveCache();
                        changedCount++;
                    } else {
                        unchangedCount++;
                    }
                    // Re-confirmed as of now regardless of whether the value changed — same
                    // reasoning as the passive re-verify paths (v7.26).
                    recordCacheMeta(rawName, CACHE_SOURCE.REVERIFY_SWEEP);
                    saveCacheMeta();
                    filterJobListCards();
                } else {
                    failedCount++;
                }
            } catch (e) {
                if (isRateLimitSignal(e)) {
                    sawAnyRateLimitThisRun = true;
                    consecutiveRateLimitHits++;
                    companyDelayMs = Math.min(companyDelayMs * 2, MAX_BACKOFF_DELAY_MS);
                    if (consecutiveRateLimitHits >= MAX_CONSECUTIVE_RATE_LIMITS) rateLimitedStop = true;
                } else {
                    consecutiveRateLimitHits = 0;
                    companyDelayMs = BASE_COMPANY_DELAY_MS;
                    // Same handling as Auto-Fetch's tier 1 — a definitive 404 means the page is
                    // genuinely gone/renamed, so the stale slug shouldn't keep being reused. The
                    // cached SIZE value is left untouched either way: a transient failure here is
                    // not evidence the last known value is wrong, so there's nothing to destroy.
                    if (e.message === 'HTTP 404') {
                        delete slugCache[rawName];
                        saveSlugCache({ excludeName: rawName }); // v7.35: see Auto-Fetch tier 1
                    }
                }
                failedCount++;
            }

            if (i < candidates.length - 1 && !cancelReverifyRequested && !rateLimitedStop) {
                await sleep(companyDelayMs);
            }
        }

        isReverifying = false;
        recordAnonymousRunFinished(rateLimitedStop ? 'autoStopped' : (sawAnyRateLimitThisRun ? 'rateLimited' : 'clean'));
        const wasCancelled = cancelReverifyRequested;
        cancelReverifyRequested = false;
        if (selectEl) selectEl.disabled = false;
        btn.innerText = '🔄 Re-verify Stale Companies';
        const headline = rateLimitedStop
            ? `Stopped after ${processedCount} of ${candidates.length} — repeated rate-limit responses. Try again later.`
            : wasCancelled
                ? `Cancelled after ${processedCount} of ${candidates.length}.`
                : 'Finished!';
        setReverifyStatus(`${headline} ${changedCount} changed, ${unchangedCount} confirmed unchanged, ${failedCount} couldn't be re-checked.`);
    }

    // --- Cache Backup & Restore -------------------------------------------
    // v7.6: the accumulated cache IS the value of this script — hundreds of companies built up
    // over weeks of browsing, much of it from passive capture on pages LinkedIn gates from
    // anonymous fetches, which Auto-Fetch cannot rebuild. It lived in localStorage and nowhere
    // else: one "clear browsing data", profile reset, or new machine and it was gone for good.
    const BACKUP_TYPE = 'linkedin-size-filter-backup';
    const BACKUP_VERSION = 1;

    function buildBackupPayload() {
        return {
            type: BACKUP_TYPE,
            version: BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            companyCache,
            // Worth carrying: a resolved slug is what lets a future lookup skip straight to the
            // right company page instead of re-running up to MAX_CANDIDATE_ATTEMPTS guesses.
            slugCache,
            // v7.8: without this, a restored cache would have no record of which entries came
            // from a reliable logged-in view versus a blind candidate guess — exactly the
            // distinction provenance exists to preserve, so it has to survive a round trip too.
            companyCacheMeta,
            // v7.35: hand-authored corrections are the most expensive data here per entry — someone
            // had to notice a wrong mapping and look up the right one. Losing those on a restore
            // would be worse than losing an auto-discovered slug, which rediscovers itself for free.
            slugOverrides
        };
    }

    // Accepts either a full envelope from buildBackupPayload(), or a bare
    // { "company name": "bucket" } object — the latter because the cache manager has always shown
    // exactly that shape in its textarea, so a backup someone made by copy-pasting it before this
    // feature existed still restores cleanly. Throws on anything unusable, and validates every
    // bucket up front so a partially-bad file is rejected whole rather than half-applied.
    function parseBackupPayload(rawText) {
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (err) {
            throw new Error('Not valid JSON.');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Expected a JSON object.');
        }

        const isEnvelope = parsed.type === BACKUP_TYPE || !!parsed.companyCache;
        const companies = isEnvelope ? parsed.companyCache : parsed;
        const rawSlugs = isEnvelope ? parsed.slugCache : null;
        const rawMeta = isEnvelope ? parsed.companyCacheMeta : null;
        const rawOverrides = isEnvelope ? parsed.slugOverrides : null;

        if (!companies || typeof companies !== 'object' || Array.isArray(companies)) {
            throw new Error('No company cache found in this file.');
        }
        const invalid = Object.entries(companies).filter(([, bucket]) => !SIZE_BUCKETS.includes(bucket));
        if (invalid.length > 0) {
            const preview = invalid.slice(0, 5).map(([name, bucket]) => `"${name}": "${bucket}"`).join('\n');
            throw new Error(`${invalid.length} entr${invalid.length === 1 ? 'y has' : 'ies have'} an unrecognized size bucket:\n${preview}${invalid.length > 5 ? '\n…' : ''}`);
        }

        const slugs = (rawSlugs && typeof rawSlugs === 'object' && !Array.isArray(rawSlugs)) ? rawSlugs : {};
        // Absent entirely for a bare-map backup or one exported before v7.8 — that's fine, it just
        // means the merge below falls back to tagging those companies "imported" instead of
        // carrying over their original provenance.
        const meta = (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) ? rawMeta : {};
        // Absent in any backup written before v7.35 — an empty map merges to a no-op, so older
        // files keep restoring exactly as before.
        const overrides = (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) ? rawOverrides : {};
        return { companies, slugs, meta, overrides };
    }

    // Non-destructive on purpose: an entry already here wins over the incoming one. The main
    // reason to import is merging another machine's cache into this one, where both sides are
    // legitimate — silently overwriting what's already here (possibly captured more recently, and
    // from a logged-in view rather than an anonymous guess) would destroy data with no undo.
    // Conflicts are counted and reported instead, so a deliberate overwrite can still be done by
    // hand in the editor.
    function mergeBackupIntoCache({ companies, slugs, meta = {}, overrides = {} }) {
        let added = 0, conflicts = 0, slugsAdded = 0, overridesAdded = 0, metaChanged = false;
        for (const [name, bucket] of Object.entries(companies)) {
            if (companyCache[name] === undefined) {
                companyCache[name] = bucket;
                added++;
                // Existing local provenance (there shouldn't be any for a name that wasn't in
                // companyCache, but a stale orphaned entry is possible) always wins; otherwise
                // carry the backup's original provenance if it has one, or fall back to tagging
                // this "imported" so the entry is never left with no provenance at all.
                if (companyCacheMeta[name] === undefined) {
                    companyCacheMeta[name] = meta[name] || { source: CACHE_SOURCE.IMPORTED, timestamp: Date.now() };
                    metaChanged = true;
                }
            } else if (companyCache[name] !== bucket) {
                conflicts++;
            }
        }
        for (const [name, slug] of Object.entries(slugs)) {
            if (slugCache[name] === undefined) {
                slugCache[name] = slug;
                slugsAdded++;
            }
        }
        // v7.35: same non-destructive rule as everything else here — a correction already made in
        // THIS browser is never replaced by an incoming one.
        for (const [name, slug] of Object.entries(overrides)) {
            if (slugOverrides[name] === undefined) {
                slugOverrides[name] = slug;
                overridesAdded++;
            }
        }
        if (added > 0) saveCache();
        if (slugsAdded > 0) saveSlugCache();
        if (metaChanged) saveCacheMeta();
        if (overridesAdded > 0) saveSlugOverrides();
        return { added, conflicts, slugsAdded, overridesAdded };
    }

    function downloadBackupFile() {
        const stamp = new Date().toISOString().slice(0, 10);
        const blob = new Blob([JSON.stringify(buildBackupPayload(), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `linkedin-size-filter-backup-${stamp}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000); // let the download start before invalidating
    }

    // --- UI Construction ------------------------------------------------
    // v7.38: company names come from LinkedIn's own page text, not something this script controls —
    // needed anywhere a name/slug gets interpolated into innerHTML (the slug manager's row table)
    // rather than assigned as textContent, so a company name containing HTML-special characters
    // can't affect the markup around it.
    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function setTextIfChanged(el, text) {
        if (!el) return;
        if (lastRenderedText[el.id] === text) return;
        lastRenderedText[el.id] = text;
        el.innerText = text;
    }

    // v7.11: replaces the old blocking alert() at the end of a run — progress and the final
    // summary both land here instead, so a multi-minute Auto-Fetch run never forces the tab to
    // wait for an OK click to keep using the page.
    function setFetchStatus(text) {
        setTextIfChanged(document.getElementById(AUTO_FETCH_STATUS_ID), text);
    }

    function setReverifyStatus(text) {
        setTextIfChanged(document.getElementById(REVERIFY_STATUS_ID), text);
    }

    function updateCounterDisplay(cachedTotal, hiddenTotal, uncachedTotal) {
        const counterEl = document.getElementById('size-filter-counter-info');
        if (counterEl) {
            setTextIfChanged(counterEl, `Cached: ${cachedTotal} | Hidden: ${hiddenTotal} | Unclassified: ${uncachedTotal}`);
        }
    }

    // v7.50: only ever lists 'fallback'/'failed' — 'ok' and 'idle' are both "nothing to see here"
    // and would just be noise on every single glance. A feature with no entry at all yet (page just
    // loaded, hasn't had a chance to run once) is treated the same as fine, not flagged as broken.
    function buildFeatureHealthSummary() {
        const problems = FEATURE_HEALTH_IDS
            .map((id) => [id, featureHealth[id]])
            .filter(([, h]) => h && (h.status === 'failed' || h.status === 'fallback'));
        if (problems.length === 0) return '✅ Everything working normally';
        return problems.map(([id, h]) => {
            const icon = h.status === 'failed' ? '❌' : '⚠️';
            const detail = h.detail ? ` (${h.detail})` : '';
            return `${icon} ${FEATURE_HEALTH_LABELS[id]}${detail}`;
        }).join('\n');
    }

    function renderFeatureHealthPanel() {
        setTextIfChanged(document.getElementById(FEATURE_HEALTH_PANEL_ID), buildFeatureHealthSummary());
    }

    function refreshCheckboxStates() {
        SIZE_BUCKETS.forEach((bucket) => {
            if (checkboxRefs[bucket]) setCheckboxVisual(checkboxRefs[bucket], userPreferences[bucket] !== false);
        });
    }

    function createCustomCheckbox(checked) {
        const box = document.createElement('span');
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(checked));
        box.style.cssText = `
            display: inline-flex; align-items: center; justify-content: center;
            width: 16px; height: 16px; min-width: 16px; border: 2px solid #0f766e;
            border-radius: 3px; margin-right: 8px; cursor: pointer;
            background-color: ${checked ? '#0f766e' : '#ffffff'}; flex-shrink: 0; box-sizing: border-box;
        `;
        box.innerHTML = checked ? '<span style="color:#ffffff;font-size:11px;line-height:1;">✓</span>' : '';
        return box;
    }

    function setCheckboxVisual(box, checked) {
        box.setAttribute('aria-checked', String(checked));
        box.style.backgroundColor = checked ? '#0f766e' : '#ffffff';
        box.innerHTML = checked ? '<span style="color:#ffffff;font-size:11px;line-height:1;">✓</span>' : '';
    }

    // v7.8: short, human-readable labels for CACHE_SOURCE values — used only for display (the
    // provenance summary line below), never compared against for logic.
    const CACHE_SOURCE_LABELS = {
        [CACHE_SOURCE.COMPANY_PAGE]: 'company page',
        [CACHE_SOURCE.JOB_DETAIL_PANE]: 'job detail',
        [CACHE_SOURCE.AUTO_FETCH_SLUG_CACHE]: 'auto-fetch (known slug)',
        [CACHE_SOURCE.AUTO_FETCH_CANDIDATE_GUESS]: 'auto-fetch (guessed)',
        [CACHE_SOURCE.AUTO_FETCH_SEARCH_FALLBACK]: 'auto-fetch (search)',
        [CACHE_SOURCE.MANUAL_EDIT]: 'manual edit',
        [CACHE_SOURCE.IMPORTED]: 'imported',
        [CACHE_SOURCE.REVERIFY_SWEEP]: 're-verify sweep'
    };

    // Counts every cached company by provenance source, "unknown" for anything cached before this
    // feature existed (no meta entry at all) — never blocks or filters on this, purely informational.
    function summarizeCacheProvenance() {
        const counts = {};
        for (const name of Object.keys(companyCache)) {
            const source = companyCacheMeta[name] ? companyCacheMeta[name].source : 'unknown';
            counts[source] = (counts[source] || 0) + 1;
        }
        return counts;
    }

    function formatCacheProvenanceSummary() {
        const counts = summarizeCacheProvenance();
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([source, count]) => `${count} ${CACHE_SOURCE_LABELS[source] || source}`)
            .join(' · ');
    }

    // v7.26: company sizes drift over time (a startup at 201-500 today can easily be 501-1,000 a
    // year later) but nothing ever re-checked an already-cached value — see
    // captureCompanyPageIfPresent()/captureFromJobDetailPane()'s comments. Before adding any active
    // re-fetching, first make the age of what's already cached visible, using the same
    // companyCacheMeta.timestamp this file has tracked since v7.8 — this needed no new data
    // collection, only a new way to look at data already being recorded. Fixed chronological order
    // (not sorted by count like formatCacheProvenanceSummary — age buckets have an inherent order a
    // reader expects, provenance sources don't). "unknown" covers entries with no meta at all
    // (cached before v7.8, or historically imported without a source timestamp).
    const FRESHNESS_BUCKET_ORDER = ['last 30 days', 'last 6 months', 'last year', 'over a year', 'unknown age'];
    const FRESHNESS_DAY_MS = 24 * 60 * 60 * 1000;

    function summarizeCacheFreshness() {
        const now = Date.now();
        const counts = {};
        for (const name of Object.keys(companyCache)) {
            const meta = companyCacheMeta[name];
            if (!meta || typeof meta.timestamp !== 'number') {
                counts['unknown age'] = (counts['unknown age'] || 0) + 1;
                continue;
            }
            const ageDays = (now - meta.timestamp) / FRESHNESS_DAY_MS;
            const bucket = ageDays <= 30 ? 'last 30 days' : ageDays <= 182 ? 'last 6 months' : ageDays <= 365 ? 'last year' : 'over a year';
            counts[bucket] = (counts[bucket] || 0) + 1;
        }
        return counts;
    }

    function formatCacheFreshnessSummary() {
        const counts = summarizeCacheFreshness();
        return FRESHNESS_BUCKET_ORDER
            .filter((bucket) => counts[bucket] > 0)
            .map((bucket) => `${counts[bucket]} ${bucket}`)
            .join(' · ');
    }

    // v7.30: re-verify sweep — periodically re-checks already-classified companies that have gone
    // stale, so a size drift (e.g. a startup growing from 201-500 to 501-1,000 over a year) doesn't
    // sit uncorrected forever just because nobody happens to click through that company's jobs
    // again. Deliberately scoped to companies with a KNOWN slug only (slugCache) - going straight
    // to a confirmed page, never guessing, keeps this a pure verification feature with none of
    // Auto-Fetch's candidate-guessing ambiguity risk. A company only ever encountered via passive
    // capture with no recorded slug (e.g. the pre-v7.28 Google/Altudo gap) simply isn't reachable
    // here yet - it needs one more click-through first (v7.28) to become eligible.
    //
    // No separate cooldown/lockout on the sweep itself is needed - the per-company due date IS the
    // throttle. Once a company is re-verified its timestamp resets, so it can't come up again for a
    // full threshold period no matter how many times this runs. Clicking it daily just means most
    // days find nothing due yet.
    const REVERIFY_THRESHOLD_OPTIONS = [
        { label: '6 months', days: 182 },
        { label: '1 year', days: 365 }
    ];
    const REVERIFY_DEFAULT_THRESHOLD_DAYS = 365;

    // v7.42: reported live — once a MANUAL_EDIT company gets a real page filled in via an override,
    // shouldn't it start participating in re-verify like everything else? Yes, but specifically
    // gated on slugOverrides, not just any slug: getCardInfo() (unlike the two passive-capture
    // functions) has NO MANUAL_EDIT guard at all and can populate slugCache for one incidentally,
    // just from its job card being scrolled past — not a deliberate decision, and not something
    // that should be read as consent to auto-check a value corrected by hand. Adding an override is
    // different: the user went into Manage Company Pages, looked up the real page, and typed it in
    // specifically — that effort IS the consent this feature needs before it can safely touch a
    // manual correction again. Shared by isReverifyEligible/getReverifyNextEtaMs/
    // countReverifyMissingSlug so this exact rule can't drift into three slightly different copies
    // the way getCompaniesMissingSlug's count and the Company Pages table's own filtering already
    // once did (v7.41).
    function isManualEditLockedOut(name) {
        const meta = companyCacheMeta[name];
        return !!(meta && meta.source === CACHE_SOURCE.MANUAL_EDIT && !slugOverrides[name]);
    }

    // A company is a candidate once it's gone at least thresholdDays without being confirmed AND
    // has a known slug AND isn't locked out as an unconfirmed MANUAL_EDIT (see
    // isManualEditLockedOut() above). No timestamp at all (pre-v7.8 / historically imported) counts
    // as infinitely old, so it's always eligible immediately.
    function isReverifyEligible(name, thresholdMs, now) {
        if (isManualEditLockedOut(name)) return false;
        if (!getSlugFor(name)) return false;
        const meta = companyCacheMeta[name];
        const age = meta && typeof meta.timestamp === 'number' ? now - meta.timestamp : Infinity;
        return age >= thresholdMs;
    }

    // Oldest-first, so a cancelled or rate-limited-out run still made progress on the most overdue
    // entries first rather than an arbitrary subset.
    function getReverifyCandidates(thresholdDays) {
        const now = Date.now();
        const thresholdMs = thresholdDays * FRESHNESS_DAY_MS;
        return Object.keys(companyCache)
            .filter((name) => isReverifyEligible(name, thresholdMs, now))
            .sort((a, b) => {
                const ageOf = (name) => {
                    const meta = companyCacheMeta[name];
                    return meta && typeof meta.timestamp === 'number' ? now - meta.timestamp : Infinity;
                };
                return ageOf(b) - ageOf(a);
            });
    }

    // How long until the NEXT company becomes eligible, for when nothing is due right now — "0
    // candidates" would otherwise look identical whether nothing will ever be due (empty/all-manual
    // cache) or something's just 3 days away. null means genuinely nothing pending at all.
    function getReverifyNextEtaMs(thresholdDays) {
        const now = Date.now();
        const thresholdMs = thresholdDays * FRESHNESS_DAY_MS;
        let minRemaining = null;
        for (const name of Object.keys(companyCache)) {
            const meta = companyCacheMeta[name];
            if (isManualEditLockedOut(name)) continue;
            if (!getSlugFor(name)) continue;
            if (!meta || typeof meta.timestamp !== 'number') continue; // already eligible — wouldn't reach here with 0 candidates
            const remaining = thresholdMs - (now - meta.timestamp);
            if (remaining > 0 && (minRemaining === null || remaining < minRemaining)) minRemaining = remaining;
        }
        return minRemaining;
    }

    // Companies that ARE due but have no known slug — can't be reached by the sweep at all yet.
    // Surfaced before starting so the count isn't silently smaller than the user might expect.
    function countReverifyMissingSlug(thresholdDays) {
        const now = Date.now();
        const thresholdMs = thresholdDays * FRESHNESS_DAY_MS;
        let count = 0;
        for (const name of Object.keys(companyCache)) {
            const meta = companyCacheMeta[name];
            if (isManualEditLockedOut(name)) continue;
            if (getSlugFor(name)) continue;
            const age = meta && typeof meta.timestamp === 'number' ? now - meta.timestamp : Infinity;
            if (age >= thresholdMs) count++;
        }
        return count;
    }

    // v7.35: the panel was nailed to a hardcoded `top: 130px; right: 20px` since v6.x. That spot is
    // not always free — reported live, it lands underneath other job-search extensions' own fixed
    // sidebars (Simplify's, in the user's screenshots), and there was no way to move it. Now
    // draggable by its header, collapsible, and remembered across page loads.
    //
    // Restoring a saved position needs one guard, borrowed from LinkedIn Company Insights: a
    // position saved on a wide monitor can be entirely off-screen on a laptop, which would strand
    // the panel somewhere unreachable with no way to drag it back. Anything that doesn't fit the
    // CURRENT viewport is discarded in favour of the default corner rather than restored blindly.
    function loadPanelState() {
        const saved = loadJson(PANEL_STATE_KEY, null);
        if (!saved || typeof saved !== 'object') return null;
        const { left, top, collapsed, tab } = saved;
        if (typeof left !== 'number' || typeof top !== 'number') {
            return { left: null, top: null, collapsed: !!collapsed, tab };
        }
        return { left, top, collapsed: !!collapsed, tab };
    }

    // Exported shape is deliberately "what's usable", not "what was stored" — callers shouldn't
    // have to re-run the viewport check themselves.
    function resolvePanelPosition(saved, viewportWidth, viewportHeight, panelWidth, panelHeight) {
        if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return null;
        const maxLeft = viewportWidth - panelWidth;
        const maxTop = viewportHeight - panelHeight;
        if (saved.left < 0 || saved.top < 0 || saved.left > maxLeft || saved.top > maxTop) return null;
        return { left: saved.left, top: saved.top };
    }

    function savePanelState(state) {
        localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
    }

    // v7.43: decides what position (if any) is safe to write back. Extracted from
    // persistPanelState()'s body specifically so the detached-element case below is testable —
    // it was a real, reproducible bug, not a hypothetical.
    //
    // Returns { left, top } to persist, or null meaning "don't write anything right now".
    //
    // The bug: injectControlPanel() called setActiveTab() — which persists — BEFORE appending the
    // container to document.body. A detached element's getBoundingClientRect() is all zeros, so a
    // panel the user had dragged somewhere got its good saved position overwritten with (0,0) on
    // every single page load, and reappeared jammed into the top-left corner. The call order is
    // also fixed below, but this guard means no future caller can reintroduce it by persisting at
    // the wrong moment.
    function computePanelPositionToPersist(container, rect) {
        // Never moved — persist an explicit null so the panel keeps following the default
        // right-anchored corner on window resize instead of being frozen into absolute pixels.
        if (container.dataset.moved !== '1') return { left: null, top: null };
        if (!container.isConnected) return null; // no layout box yet; rect would be a fake (0,0)
        return { left: Math.round(rect.left), top: Math.round(rect.top) };
    }

    function openCacheManager() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483647;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: #ffffff; border-radius: 10px; padding: 16px;
            width: 480px; max-width: 90vw; max-height: 80vh;
            display: flex; flex-direction: column; gap: 10px;
        `;

        const heading = document.createElement('div');
        heading.innerHTML = `
            <strong>Cached Companies</strong><br>
            <span style="font-size:11px;color:#64748b;">Edit the JSON directly, then Save. Keys are normalized company names.<br>
            Export writes a backup file (companies + resolved slugs); Import merges one back in without overwriting what's already here.<br>
            LinkedIn page / slug editing has moved to "Manage Company Pages".</span><br>
            <span style="font-size:10px;color:#94a3b8;">Sources: ${formatCacheProvenanceSummary()}</span><br>
            <span style="font-size:10px;color:#94a3b8;">Last verified: ${formatCacheFreshnessSummary()}</span>
        `;

        // v7.39: newest-touched first (see getCompanyNamesByRecency's comment) — rebuilt as a
        // fresh object in that order since JSON.stringify/object key order both just follow
        // whatever order a plain object's keys were actually set in.
        function buildOrderedCacheView() {
            const ordered = {};
            for (const name of getCompanyNamesByRecency(companyCache, companyCacheMeta)) ordered[name] = companyCache[name];
            return ordered;
        }

        const textarea = document.createElement('textarea');
        textarea.value = JSON.stringify(buildOrderedCacheView(), null, 2);
        textarea.style.cssText = `
            flex: 1; min-height: 320px; font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 12px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; resize: vertical;
        `;

        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: space-between; align-items: center;';
        const leftGroup = document.createElement('div');
        leftGroup.style.cssText = 'display: flex; gap: 8px;';
        const rightGroup = document.createElement('div');
        rightGroup.style.cssText = 'display: flex; gap: 8px;';

        function makeButton(label, bg) {
            const btn = document.createElement('button');
            btn.innerText = label;
            btn.style.cssText = `
                background-color: ${bg}; color: #ffffff; border: none;
                padding: 8px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;
            `;
            return btn;
        }

        const clearBtn = makeButton('Clear All', '#dc2626');
        clearBtn.addEventListener('click', () => {
            if (!confirm('Delete all cached companies? This cannot be undone.')) return;
            companyCache = {};
            companyCacheMeta = {};
            // v7.35: authoritative — the user explicitly asked to empty this. Merging would pull
            // every entry straight back in from another tab's stored copy.
            saveCache({ merge: false });
            saveCacheMeta({ merge: false });
            filterJobListCards();
            overlay.remove();
        });

        const closeBtn = makeButton('Close', '#64748b');
        closeBtn.addEventListener('click', () => overlay.remove());

        const saveBtn = makeButton('Save', '#0f766e');
        saveBtn.addEventListener('click', () => {
            try {
                const parsed = JSON.parse(textarea.value);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Must be a JSON object of "company name": "bucket" pairs.');
                }
                const invalidEntries = Object.entries(parsed).filter(([, bucket]) => !SIZE_BUCKETS.includes(bucket));
                if (invalidEntries.length > 0) {
                    const preview = invalidEntries.slice(0, 5).map(([name, bucket]) => `"${name}": "${bucket}"`).join('\n');
                    throw new Error(`${invalidEntries.length} entr${invalidEntries.length === 1 ? 'y has' : 'ies have'} a bucket that doesn't match any known size range:\n${preview}${invalidEntries.length > 5 ? '\n…' : ''}`);
                }
                // v7.8: record provenance for anything this edit actually changed (new key, or an
                // existing key given a different bucket) BEFORE the swap, comparing against the
                // cache as it stood before this Save — untouched entries keep their prior
                // provenance rather than every entry in the textarea being stamped "manual-edit"
                // just because the box was open.
                for (const [name, bucket] of Object.entries(parsed)) {
                    if (companyCache[name] !== bucket) recordCacheMeta(name, CACHE_SOURCE.MANUAL_EDIT);
                }
                for (const name of Object.keys(companyCacheMeta)) {
                    if (!(name in parsed)) delete companyCacheMeta[name];
                }
                companyCache = parsed;
                // v7.35: authoritative — the textarea IS the intended full contents, including any
                // entries the user deliberately deleted from it.
                saveCache({ merge: false });
                saveCacheMeta({ merge: false });
                filterJobListCards();
                overlay.remove();
            } catch (err) {
                alert(`Couldn't save — ${err.message}`);
            }
        });

        const exportBtn = makeButton('⬇ Export', '#0369a1');
        exportBtn.addEventListener('click', () => {
            try {
                downloadBackupFile();
            } catch (err) {
                alert(`Couldn't export — ${err.message}`);
            }
        });

        // A hidden file input rather than a visible one, so the row keeps a consistent look and
        // the button label can say what actually happens (merge, not replace).
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const result = mergeBackupIntoCache(parseBackupPayload(String(reader.result)));
                    textarea.value = JSON.stringify(buildOrderedCacheView(), null, 2);
                    filterJobListCards();
                    const conflictNote = result.conflicts > 0
                        ? `\n${result.conflicts} kept as-is (already cached with a different size).`
                        : '';
                    const slugNote = result.slugsAdded > 0 ? `\n${result.slugsAdded} company slug(s) also merged.` : '';
                    const overrideNote = result.overridesAdded > 0 ? `\n${result.overridesAdded} manual slug override(s) also merged.` : '';
                    alert(`Imported. ${result.added} new compan${result.added === 1 ? 'y' : 'ies'} added.${conflictNote}${slugNote}${overrideNote}`);
                } catch (err) {
                    alert(`Couldn't import — ${err.message}`);
                }
                fileInput.value = ''; // let the same file be picked again after a failed attempt
            };
            reader.onerror = () => alert("Couldn't import — the file could not be read.");
            reader.readAsText(file);
        });

        const importBtn = makeButton('⬆ Import & merge', '#0369a1');
        importBtn.addEventListener('click', () => fileInput.click());

        leftGroup.appendChild(exportBtn);
        leftGroup.appendChild(importBtn);
        rightGroup.appendChild(clearBtn);
        rightGroup.appendChild(closeBtn);
        rightGroup.appendChild(saveBtn);
        buttonRow.appendChild(leftGroup);
        buttonRow.appendChild(rightGroup);
        box.appendChild(fileInput);
        box.appendChild(heading);
        box.appendChild(textarea);
        box.appendChild(buttonRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // v7.38: split out of openCacheManager() at the user's request — editing a slug override meant
    // an empty JSON box with zero visibility into what you were actually correcting: you had to
    // already know the exact normalized key and, separately, go find the real slug yourself with no
    // on-screen reference for either. This shows every cached company's CURRENT resolved page
    // (override if set, else auto-discovered, else "—") in one browsable list, and clicking "Edit"
    // on a row pre-fills the JSON box below with that exact key already typed in — the one thing
    // that was genuinely tedious about the old flow (copying the key by hand without a typo).
    //
    // Deliberately still writes through the SAME override mechanism as before, not a new one: a row
    // being "resolved" from slugCache never means the table is editing slugCache directly. slugCache
    // stays machine territory (auto-filled, auto-evicted on a 404); every edit here still lands in
    // slugOverrides, which is the one thing that's never touched by an automatic path. Keeping that
    // boundary is what makes an override safe to leave in place indefinitely.
    //
    // "Cheap" version by design (explicit agreement, not an oversight): the table is read-only and
    // browsing only, edits still go through one shared JSON box rather than being inline-editable
    // per row. A full inline-editable table with search/filter is a real, larger rebuild — worth
    // doing if this cache grows enough that scrolling a list of ~100-250 rows stops being practical,
    // but not before it's actually needed.
    function openSlugManager() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483647;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: #ffffff; border-radius: 10px; padding: 16px;
            width: 520px; max-width: 90vw; max-height: 85vh;
            display: flex; flex-direction: column; gap: 10px;
        `;

        const heading = document.createElement('div');
        heading.innerHTML = `
            <strong>Company Pages</strong><br>
            <span style="font-size:11px;color:#64748b;">Which LinkedIn page each cached company resolves to. Click "Edit" on a row to
            correct one, or add a brand new entry directly in the box below, then Save.</span><br>
            <span style="font-size:10px;color:${countNameCollisions() > 0 ? '#b45309' : '#94a3b8'};">Name conflicts: ${formatNameCollisionSummary()}</span>
        `;

        // v7.40: reported live — this row used to be a real DOM element with a clickable "copy
        // names" link (wired to copyMissingSlugNames(), v7.36), but the v7.38 move into this modal
        // only carried over the plain count text via the innerHTML block above, dropping the link
        // entirely — copyMissingSlugNames() has existed since v7.36 with nothing in the UI able to
        // call it since v7.38. Rebuilt as its own row, same as before the move.
        const missingSlugRow = document.createElement('div');
        const missingSlugCount = getCompaniesMissingSlug().length;
        missingSlugRow.style.cssText = `font-size:10px; color:${missingSlugCount > 0 ? '#b45309' : '#94a3b8'}; margin-top: -6px;`;
        const missingSlugLabel = document.createElement('span');
        missingSlugLabel.textContent = `Missing a page: ${missingSlugCount}`;
        missingSlugRow.appendChild(missingSlugLabel);
        if (missingSlugCount > 0) {
            missingSlugRow.appendChild(document.createTextNode(' — '));
            const missingSlugLink = document.createElement('a');
            missingSlugLink.href = '#';
            missingSlugLink.textContent = 'copy names';
            missingSlugLink.style.cssText = 'color:#0f766e; text-decoration:underline;';
            missingSlugLink.addEventListener('click', (e) => {
                e.preventDefault();
                copyMissingSlugNames();
            });
            missingSlugRow.appendChild(missingSlugLink);
        }

        const overrideArea = document.createElement('textarea');
        overrideArea.value = JSON.stringify(slugOverrides, null, 2);
        overrideArea.style.cssText = `
            min-height: 120px; font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 12px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; resize: vertical;
        `;
        const overrideHelp = document.createElement('span');
        overrideHelp.style.cssText = 'font-size:10px;color:#64748b;';
        overrideHelp.innerHTML = 'Keys are normalized company names (same as the row list below); values are the slug from ' +
            'linkedin.com/company/&lt;slug&gt;, e.g. <code>{"victoria s secret": "victoria\'s-secret"}</code>. ' +
            'An override always wins over the auto-discovered page and is never removed automatically.';

        // Pre-fills the override box with this one company's key (and its current override value,
        // if any) already typed in — merges into whatever's already in the box rather than replacing
        // it, so several rows can be queued up before a single Save.
        function loadOverrideDraft(name, currentValue) {
            let draft;
            try {
                draft = JSON.parse(overrideArea.value || '{}');
                if (!draft || typeof draft !== 'object' || Array.isArray(draft)) draft = {};
            } catch (e) {
                draft = {};
            }
            draft[name] = currentValue || '';
            overrideArea.value = JSON.stringify(draft, null, 2);
            overrideArea.focus();
        }

        const tableWrap = document.createElement('div');
        tableWrap.style.cssText = 'flex: 1; min-height: 200px; max-height: 320px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px;';
        const names = getCompanyNamesByRecency(companyCache, companyCacheMeta); // v7.39: newest-touched first, same ordering as the size manager
        if (names.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 12px; font-size: 12px; color: #94a3b8;';
            empty.textContent = 'No cached companies yet.';
            tableWrap.appendChild(empty);
        } else {
            const table = document.createElement('table');
            table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11px;';
            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr style="position: sticky; top: 0; background: #f8fafc;">
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">Company</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">Current page</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">Source</th>
                    <th style="border-bottom:1px solid #e2e8f0;"></th>
                </tr>
            `;
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            names.forEach((name) => {
                const resolved = getSlugFor(name);
                const source = slugOverrides[name] ? 'override' : (slugCache[name] ? 'auto' : '—');
                const row = document.createElement('tr');
                row.style.cssText = 'border-bottom: 1px solid #f1f5f9;';
                row.innerHTML = `
                    <td style="padding:5px 8px; word-break: break-word;">${esc(name)}</td>
                    <td style="padding:5px 8px; color:${resolved ? '#1e293b' : '#b45309'}; word-break: break-word;">${resolved ? esc(resolved) : 'no page known'}</td>
                    <td style="padding:5px 8px; color:#64748b;">${source}</td>
                `;
                const editCell = document.createElement('td');
                editCell.style.cssText = 'padding:5px 8px; text-align:right;';
                const editLink = document.createElement('a');
                editLink.href = '#';
                editLink.textContent = 'Edit';
                editLink.style.cssText = 'color:#0f766e; text-decoration:underline; white-space:nowrap;';
                editLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    loadOverrideDraft(name, slugOverrides[name] || '');
                });
                editCell.appendChild(editLink);
                row.appendChild(editCell);
                tbody.appendChild(row);
            });
            table.appendChild(tbody);
            tableWrap.appendChild(table);
        }

        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        function makeSlugButton(label, bg) {
            const btn = document.createElement('button');
            btn.innerText = label;
            btn.style.cssText = `
                background-color: ${bg}; color: #ffffff; border: none;
                padding: 8px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;
            `;
            return btn;
        }

        const closeBtn = makeSlugButton('Close', '#64748b');
        closeBtn.addEventListener('click', () => overlay.remove());

        const saveBtn = makeSlugButton('Save', '#0f766e');
        saveBtn.addEventListener('click', () => {
            try {
                const parsedOverrides = JSON.parse(overrideArea.value || '{}');
                if (!parsedOverrides || typeof parsedOverrides !== 'object' || Array.isArray(parsedOverrides)) {
                    throw new Error('Must be a JSON object of "company name": "slug" pairs.');
                }
                const badOverrides = Object.entries(parsedOverrides)
                    .filter(([, slug]) => typeof slug !== 'string' || !slug.trim() || /[\s/?#]/.test(slug));
                if (badOverrides.length > 0) {
                    throw new Error(`${badOverrides.length} value(s) don't look like a LinkedIn page slug (no spaces or / ? # — just the part after /company/):\n${badOverrides.slice(0, 5).map(([n, v]) => `"${n}": "${v}"`).join('\n')}`);
                }
                slugOverrides = parsedOverrides;
                saveSlugOverrides();
                overlay.remove();
            } catch (err) {
                alert(`Couldn't save — ${err.message}`);
            }
        });

        buttonRow.appendChild(closeBtn);
        buttonRow.appendChild(saveBtn);

        box.appendChild(heading);
        box.appendChild(missingSlugRow);
        box.appendChild(tableWrap);
        box.appendChild(overrideHelp);
        box.appendChild(overrideArea);
        box.appendChild(buttonRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    function injectControlPanel() {
        if (document.getElementById(UI_PANEL_ID)) return;

        const savedPanelState = loadPanelState();

        const container = document.createElement('div');
        container.id = UI_PANEL_ID;
        container.style.cssText = `
            position: fixed; top: 130px; right: 20px; z-index: 2147483647;
            font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto;
        `;

        const button = document.createElement('button');
        button.innerText = `\u{1F3E2} Filter Sizes \u2699\uFE0F v${SCRIPT_VERSION}`;
        button.style.cssText = `
            background-color: #0f766e; color: #ffffff; border: none;
            padding: 8px 14px; border-radius: 20px; font-size: 13px;
            font-weight: 700; cursor: grab; box-shadow: 0 2px 6px rgba(0,0,0,0.25);
            user-select: none;
        `;

        const menu = document.createElement('div');
        menu.style.cssText = `
            display: none; position: absolute; right: 0; top: 38px;
            background: #ffffff; border: 1px solid #cbd5e1; padding: 12px;
            border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            width: 260px; color: #1e293b;
        `;

        const title = document.createElement('div');
        title.innerHTML = `
            <strong>Company Size Filter</strong><br>
            <span style="font-size:10px;color:#64748b;">Uncheck to hide, or click "only" to isolate one</span><br>
            <span id="size-filter-counter-info" style="font-size:11px;color:#0f766e;font-weight:bold;">Cached: 0 | Hidden: 0 | Unclassified: 0</span>
        `;
        title.style.marginBottom = '8px';
        menu.appendChild(title);

        // v7.35: the panel had grown to 8 checkboxes + 2 dropdowns + 4 buttons + 2 status lines in
        // one scrolling column. Grouped into three tabs so only one concern is on screen at a time.
        // Each tab is a plain container appended to in the same order as before — the controls
        // themselves and their wiring are untouched, only which parent they land in.
        const tabBar = document.createElement('div');
        tabBar.style.cssText = 'display:flex; gap:4px; border-bottom:1px solid #e2e8f0; margin-bottom:10px;';
        const tabPanes = {};
        const tabButtons = {};
        const TAB_IDS = ['Filter', 'Fetch', 'Data'];
        let activeTab = TAB_IDS.includes(savedPanelState && savedPanelState.tab) ? savedPanelState.tab : 'Filter';

        function setActiveTab(name) {
            activeTab = name;
            TAB_IDS.forEach((id) => {
                const isOn = id === name;
                tabPanes[id].style.display = isOn ? 'block' : 'none';
                tabButtons[id].style.cssText = `
                    flex:1; background:none; border:none; cursor:pointer; padding:6px 4px;
                    font-size:11px; font-weight:700; color:${isOn ? '#0f766e' : '#94a3b8'};
                    border-bottom:2px solid ${isOn ? '#0f766e' : 'transparent'};
                `;
            });
            persistPanelState();
        }

        TAB_IDS.forEach((id) => {
            const btn = document.createElement('button');
            btn.innerText = id;
            btn.addEventListener('click', () => setActiveTab(id));
            tabButtons[id] = btn;
            tabBar.appendChild(btn);
            const pane = document.createElement('div');
            tabPanes[id] = pane;
        });
        menu.appendChild(tabBar);
        TAB_IDS.forEach((id) => menu.appendChild(tabPanes[id]));
        const filterPane = tabPanes.Filter;
        const fetchPane = tabPanes.Fetch;
        const dataPane = tabPanes.Data;

        SIZE_BUCKETS.forEach((bucket) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; font-size: 12px; margin-bottom: 6px;';

            const label = document.createElement('div');
            label.style.cssText = 'display: flex; align-items: center; cursor: pointer; flex: 1;';
            const checkbox = createCustomCheckbox(userPreferences[bucket] !== false);
            checkboxRefs[bucket] = checkbox;

            label.addEventListener('click', () => {
                const newState = !(userPreferences[bucket] !== false);
                userPreferences[bucket] = newState;
                savePreferences();
                setCheckboxVisual(checkbox, newState);
                filterJobListCards();
            });

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(bucket));

            const onlyLink = document.createElement('a');
            onlyLink.textContent = 'only';
            onlyLink.href = '#';
            onlyLink.style.cssText = 'font-size:10px;color:#0f766e;text-decoration:underline;cursor:pointer;margin-left:6px;';
            onlyLink.addEventListener('click', (e) => {
                e.preventDefault();
                SIZE_BUCKETS.forEach((b) => { userPreferences[b] = (b === bucket); });
                savePreferences();
                refreshCheckboxStates();
                filterJobListCards();
            });

            row.appendChild(label);
            row.appendChild(onlyLink);
            filterPane.appendChild(row);
        });

        const divider = document.createElement('hr');
        divider.style.cssText = 'border: none; border-top: 1px solid #e2e8f0; margin: 10px 0;';
        filterPane.appendChild(divider);

        const hideRow = document.createElement('div');
        hideRow.style.cssText = 'display:flex; align-items:center; font-size:12px; cursor:pointer; margin-bottom: 10px;';
        const hideCheckbox = createCustomCheckbox(hideUncached);
        hideRow.addEventListener('click', () => {
            hideUncached = !hideUncached;
            saveHideUncached();
            setCheckboxVisual(hideCheckbox, hideUncached);
            filterJobListCards();
        });
        hideRow.appendChild(hideCheckbox);
        hideRow.appendChild(document.createTextNode('Hide unclassified until known'));
        filterPane.appendChild(hideRow);

        // v7.32: one shared control for both buttons below — Auto-Fetch and Re-verify are already
        // mutually exclusive and carry the same connection/IP risk, so a single cooldown length
        // governs whichever of them just ran. See getRunCooldownRemainingMs() for the enforcement;
        // this only sets the base value it scales from.
        const cooldownGroup = document.createElement('div');
        cooldownGroup.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;';

        const cooldownLabel = document.createElement('label');
        cooldownLabel.innerText = 'Minimum wait between Auto-Fetch/Re-verify runs:';
        cooldownLabel.style.cssText = 'font-size: 10px; font-weight: 600; color: #64748b; padding-left: 2px;';

        const cooldownSelect = document.createElement('select');
        cooldownSelect.style.cssText = `
            width: 100%; background-color: #f8fafc; color: #334155;
            border: 1px solid #cbd5e1; padding: 6px 8px; border-radius: 6px;
            font-size: 12px; font-weight: 600; cursor: pointer;
        `;
        cooldownSelect.disabled = isFetchingUnclassified || isReverifying;
        RUN_COOLDOWN_OPTIONS.forEach((opt) => {
            const optEl = document.createElement('option');
            optEl.value = String(opt.minutes);
            optEl.innerText = opt.label;
            if (opt.minutes === runCooldownMinutes) optEl.selected = true;
            cooldownSelect.appendChild(optEl);
        });
        cooldownSelect.addEventListener('change', () => {
            runCooldownMinutes = Number(cooldownSelect.value);
            saveRunCooldownMinutes();
        });

        cooldownGroup.appendChild(cooldownLabel);
        cooldownGroup.appendChild(cooldownSelect);
        fetchPane.appendChild(cooldownGroup);

        const autoBtn = document.createElement('button');
        autoBtn.innerText = '⚡ Auto-Fetch Unclassified Companies';
        autoBtn.style.cssText = `
            width: 100%; background-color: #0f766e; color: #ffffff;
            border: none; padding: 8px; border-radius: 6px;
            font-size: 12px; font-weight: 700; cursor: pointer; margin-bottom: 8px;
        `;
        // v7.11: same button doubles as Cancel while a run is in progress — clicking it mid-run
        // requests cancellation instead of starting a second, redundant fetch (isFetchingUnclassified
        // already blocked that, but silently ignoring the click gave no feedback that anything
        // happened).
        autoBtn.addEventListener('click', () => {
            if (isFetchingUnclassified) {
                cancelFetchRequested = true;
                autoBtn.innerText = '⏳ Cancelling...';
            } else {
                autoFetchUnclassifiedCompanies(autoBtn);
            }
        });
        fetchPane.appendChild(autoBtn);

        const fetchStatus = document.createElement('div');
        fetchStatus.id = AUTO_FETCH_STATUS_ID;
        fetchStatus.style.cssText = 'font-size: 10px; color: #64748b; margin: -4px 0 8px 2px; min-height: 12px;';
        fetchPane.appendChild(fetchStatus);

        // v7.30: re-verify sweep — sibling to Auto-Fetch above (that one classifies NEW companies;
        // this one re-checks EXISTING ones that have gone stale). Given its own persistent
        // button/status pair in the main panel rather than tucked inside the cache manager modal,
        // deliberately — the modal can be closed mid-run (e.g. after Save/Close), which would
        // detach this button's DOM reference and make Cancel silently stop working; the main panel
        // never closes for the run's duration, matching Auto-Fetch's already-proven-reliable
        // pattern exactly.
        // v7.31: reported live — the select+button crammed into one row looked visually
        // inconsistent next to the panel's other full-width, uniformly-styled buttons (a bare
        // browser-default <select> stood out against the deliberately-styled ones). Restructured
        // to match the panel's own established rhythm instead: a labeled, full-width select
        // (styled consistently with the buttons around it — same radius, same font, same spacing),
        // stacked above a full-width button, exactly like every other control in this panel.
        const reverifyGroup = document.createElement('div');
        reverifyGroup.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;';

        const reverifyLabel = document.createElement('label');
        reverifyLabel.innerText = 'Re-verify companies not confirmed in the last:';
        reverifyLabel.style.cssText = 'font-size: 10px; font-weight: 600; color: #64748b; padding-left: 2px;';

        const reverifySelect = document.createElement('select');
        reverifySelect.style.cssText = `
            width: 100%; background-color: #f8fafc; color: #334155;
            border: 1px solid #cbd5e1; padding: 6px 8px; border-radius: 6px;
            font-size: 12px; font-weight: 600; cursor: pointer;
        `;
        REVERIFY_THRESHOLD_OPTIONS.forEach((opt) => {
            const optEl = document.createElement('option');
            optEl.value = String(opt.days);
            optEl.innerText = opt.label;
            if (opt.days === REVERIFY_DEFAULT_THRESHOLD_DAYS) optEl.selected = true;
            reverifySelect.appendChild(optEl);
        });

        const reverifyBtn = document.createElement('button');
        // Reflects an already-in-progress run correctly if the panel is re-rendered mid-run
        // (injectControlPanel() only actually runs once per page, but this stays correct in case
        // that ever changes) rather than showing the idle label while a background run continues.
        reverifyBtn.innerText = isReverifying ? '⏹ Cancel Re-verify (running…)' : '🔄 Re-verify Stale Companies';
        reverifySelect.disabled = isReverifying;
        reverifyBtn.style.cssText = `
            width: 100%; background-color: #7c3aed; color: #ffffff; border: none;
            padding: 8px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;
        `;
        reverifyBtn.addEventListener('click', () => {
            if (isReverifying) {
                cancelReverifyRequested = true;
                reverifyBtn.innerText = '⏳ Cancelling...';
            } else {
                reverifyStaleCompanies(reverifyBtn, reverifySelect, Number(reverifySelect.value));
            }
        });

        reverifyGroup.appendChild(reverifyLabel);
        reverifyGroup.appendChild(reverifySelect);
        reverifyGroup.appendChild(reverifyBtn);
        fetchPane.appendChild(reverifyGroup);

        const reverifyStatus = document.createElement('div');
        reverifyStatus.id = REVERIFY_STATUS_ID;
        reverifyStatus.style.cssText = 'font-size: 10px; color: #64748b; margin: -4px 0 8px 2px; min-height: 12px;';
        fetchPane.appendChild(reverifyStatus);

        const copyBtn = document.createElement('button');
        copyBtn.innerText = '📋 Copy unclassified names';
        copyBtn.style.cssText = `
            width: 100%; background-color: #2563eb; color: #ffffff;
            border: none; padding: 8px; border-radius: 6px;
            font-size: 12px; font-weight: 700; cursor: pointer; margin-bottom: 8px;
        `;
        copyBtn.addEventListener('click', copyUnclassifiedNames);
        dataPane.appendChild(copyBtn);

        const manageBtn = document.createElement('button');
        manageBtn.innerText = '🗂️ Manage cached companies';
        manageBtn.style.cssText = `
            width: 100%; background-color: #475569; color: #ffffff;
            border: none; padding: 8px; border-radius: 6px;
            font-size: 12px; font-weight: 700; cursor: pointer; margin-bottom: 8px;
        `;
        manageBtn.addEventListener('click', openCacheManager);
        dataPane.appendChild(manageBtn);

        const slugManagerBtn = document.createElement('button');
        slugManagerBtn.innerText = '🔗 Manage Company Pages';
        slugManagerBtn.style.cssText = `
            width: 100%; background-color: #475569; color: #ffffff;
            border: none; padding: 8px; border-radius: 6px;
            font-size: 12px; font-weight: 700; cursor: pointer;
        `;
        slugManagerBtn.addEventListener('click', openSlugManager);
        dataPane.appendChild(slugManagerBtn);

        // v7.50: passive status view — see FEATURE_HEALTH_IDS's comment. Deliberately terse (plain
        // text via setTextIfChanged(), not a styled row per feature): the point is to be glanced at
        // and ignored when everything's fine, not to become its own dashboard.
        const healthDivider = document.createElement('hr');
        healthDivider.style.cssText = 'border: none; border-top: 1px solid #e2e8f0; margin: 10px 0 6px;';
        dataPane.appendChild(healthDivider);

        const healthLabel = document.createElement('div');
        healthLabel.innerText = 'Feature health';
        healthLabel.style.cssText = 'font-size:10px; font-weight:700; color:#64748b; margin-bottom:4px;';
        dataPane.appendChild(healthLabel);

        const healthPanel = document.createElement('div');
        healthPanel.id = FEATURE_HEALTH_PANEL_ID;
        healthPanel.style.cssText = 'font-size:11px; color:#334155; line-height:1.6; white-space:pre-line; margin-bottom:8px;';
        healthPanel.innerText = 'Checking…';
        dataPane.appendChild(healthPanel);

        // v7.51: one-click deep dump for whatever the summary above just flagged (or anything else
        // worth a second look) — see buildDiagnosticReport()'s comment for why this exists.
        const diagnoseBtn = document.createElement('button');
        diagnoseBtn.innerText = '🩺 Copy Diagnostics';
        diagnoseBtn.style.cssText = `
            width: 100%; background-color: #0891b2; color: #ffffff;
            border: none; padding: 8px; border-radius: 6px;
            font-size: 12px; font-weight: 700; cursor: pointer;
        `;
        diagnoseBtn.addEventListener('click', copyDiagnosticReport);
        dataPane.appendChild(diagnoseBtn);

        // ---- v7.35: drag, collapse, and remember where it was put --------------------
        function persistPanelState() {
            // v7.43: see computePanelPositionToPersist() — null means "not safe to write now"
            // (container still detached, so its rect is a meaningless 0,0 that would clobber a
            // real saved position).
            const pos = computePanelPositionToPersist(container, container.getBoundingClientRect());
            if (!pos) return;
            savePanelState({
                left: pos.left,
                top: pos.top,
                collapsed: menu.style.display === 'none',
                tab: activeTab
            });
        }

        let dragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;
        let dragMoved = false;

        button.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const rect = container.getBoundingClientRect();
            dragging = true;
            dragMoved = false;
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            button.style.cursor = 'grabbing';
            e.preventDefault(); // stop the browser starting a text/element drag instead
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            // A few pixels of slop so a slightly-shaky click still counts as a click, not a drag —
            // otherwise opening the menu becomes unreliable for anyone without a steady hand.
            if (Math.abs(e.clientX - (dragOffsetX + container.getBoundingClientRect().left)) > 2 ||
                Math.abs(e.clientY - (dragOffsetY + container.getBoundingClientRect().top)) > 2) {
                dragMoved = true;
            }
            const w = container.offsetWidth;
            const h = container.offsetHeight;
            const left = Math.max(0, Math.min(window.innerWidth - w, e.clientX - dragOffsetX));
            const top = Math.max(0, Math.min(window.innerHeight - h, e.clientY - dragOffsetY));
            container.style.left = `${left}px`;
            container.style.top = `${top}px`;
            container.style.right = 'auto';
            container.dataset.moved = '1';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            button.style.cursor = 'grab';
            if (dragMoved) persistPanelState();
        });

        button.addEventListener('click', () => {
            if (dragMoved) { dragMoved = false; return; } // that was a drag, not a click
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
            persistPanelState();
        });

        // v7.43: attach FIRST, then apply saved state. setActiveTab() persists, and persisting
        // while the container is still detached is exactly what overwrote a dragged position with
        // (0,0) on every page load — a detached element has no layout box, so its rect reads as all
        // zeros. computePanelPositionToPersist() now refuses to write in that state regardless, but
        // doing the work in the right order is the actual fix; the guard is the backstop.
        container.appendChild(button);
        container.appendChild(menu);
        document.body.appendChild(container);

        // Restore saved position/collapse/tab, but only a position that still fits THIS viewport —
        // see resolvePanelPosition()'s comment.
        const restored = resolvePanelPosition(savedPanelState, window.innerWidth, window.innerHeight, 280, 120);
        if (restored) {
            container.style.left = `${restored.left}px`;
            container.style.top = `${restored.top}px`;
            container.style.right = 'auto';
            container.dataset.moved = '1';
        }
        menu.style.display = (savedPanelState && savedPanelState.collapsed === false) ? 'block' : 'none';
        setActiveTab(activeTab);
    }

    // v7.13: reported live — opening a job list page shows "Unclassified: 1", scrolling down
    // reveals "Unclassified: 9" on the SAME page, because LinkedIn only mounts cards near the
    // current scroll position; getCardElements() was always accurate for what's in the DOM, the
    // DOM just didn't have the rest yet. Scrolls the list's real container to the bottom
    // repeatedly until the card count stops growing (two consecutive stable reads), then restores
    // exactly where the user was — the visible effect should be a brief scroll flicker, not a
    // lasting jump. Assumes LinkedIn's list APPENDS cards as you scroll rather than un-mounting
    // ones that scroll out of view (supported by the live report: the count only ever grew, 1 to
    // 9, never dropped as the visible cards changed) — if that assumption turns out wrong for some
    // layout, the symptom would be an undercount that doesn't match this reasoning, which is a
    // fixable, evidence-driven follow-up like everything else in this file's history.
    let lastForcedListSignature = null;
    let forcingRenderInProgress = false;

    // v7.47: reported live with DEBUG on — the exact firing evidence showed getListSignature()
    // flip-flopping between two values on a single ordinary job click on /jobs/search-results/ (NOT
    // a real pagination change): "...start=25" -> "..." (no start param at all) -> back to
    // "...start=25", two runCycle() calls apart. Neither v7.45 (volatile-param stripping) nor v7.46
    // (order-independence) could catch this — the param wasn't renamed or reordered, it was
    // genuinely, if briefly, ABSENT from location.search before LinkedIn's client re-added it, most
    // likely an artifact of how it reconciles the URL for the newly-selected job. Each of those two
    // real (if transient) values got compared against lastForcedListSignature and both looked like a
    // new list, firing forceRenderAllVisibleCards() twice — the double flicker. Comparing the settled
    // MutationObserver/poll snapshot to a settle window: a candidate value must stay unchanged across
    // real time (not just one runCycle call) before it's trusted as a genuine navigation, the same
    // "don't act on a value until it's stopped changing" idea captureFromJobDetailPane() already
    // uses via DETAIL_PANE_SETTLE_MS. Genuine navigation (pagination, a different search) stays put
    // once it happens, so it clears the window on the next check same as before; a value that's just
    // passing through on its way back to what it already was never gets the chance.
    const LIST_SIGNATURE_SETTLE_MS = 400;
    let pendingListSignature = null;
    let pendingListSignatureSince = 0;

    // v7.22: see FORCE_RENDER_RESTORE_SETTLE_POLL_MS's comment — a single scrollTop assignment
    // isn't guaranteed to stick, so this re-asserts the target for a short bounded window,
    // re-checking the DOM's actual scrollTop each time rather than trusting one write.
    async function settleScrollRestore(container, targetScrollTop) {
        const deadline = Date.now() + FORCE_RENDER_RESTORE_SETTLE_TIMEOUT_MS;
        let attempts = 0;
        for (;;) {
            container.scrollTop = targetScrollTop;
            attempts++;
            if (Math.abs(container.scrollTop - targetScrollTop) < 1) {
                if (DEBUG && attempts > 1) dbg('force-render: scroll restore needed retries to settle', { attempts, targetScrollTop, landedAt: container.scrollTop });
                return;
            }
            if (Date.now() >= deadline) {
                if (DEBUG) dbg('force-render: scroll restore never fully settled', { attempts, targetScrollTop, landedAt: container.scrollTop });
                return;
            }
            await sleep(FORCE_RENDER_RESTORE_SETTLE_POLL_MS);
        }
    }

    // v7.25: one top-to-bottom sweep, extracted verbatim from what used to be the whole body of
    // forceRenderAllVisibleCards()'s try block, so that function can now run several of these
    // back-to-back inside a single hide/reveal. Caller owns hiding, scroll restoration and the
    // decision to sweep again; this only does the scroll-and-wait.
    async function runOneRenderSweep(container, sweepNum) {
        // v7.15: reported live — force-render was only ever covering "wherever the container
        // happened to be scrolled to when this ran" down to the bottom, not the true top of
        // the list. Whatever's above the container's scrollTop AT THE MOMENT this kicked in
        // (which was never guaranteed to be 0 — the page could still be settling, or a manual
        // scroll could have already happened before this ran) never got force-rendered at
        // all. Explicitly reset to the top and let it settle before starting the
        // scroll-to-bottom pass, so the full 0%-100% range is covered, not just
        // wherever-we-started to 100%.
        container.scrollTop = 0;
        await sleep(FORCE_RENDER_POLL_INTERVAL_MS);

        const startedAt = Date.now();
        // v7.19: tracks countParseableCards() (how many cards getCardInfo() can actually read
        // right now), not getCardElements().length (how many container elements exist) — see
        // countParseableCards()'s comment. A container can mount before its own inner content
        // does, so the raw count can go quiet while cards are still internally incomplete.
        let lastCount = countParseableCards();
        let lastChangeAt = Date.now();
        let pollNum = 0;
        let stoppedVia = 'timeout';

        while (Date.now() - startedAt < FORCE_RENDER_TIMEOUT_MS) {
            // v7.20: step by roughly one viewport height instead of jumping straight to the
            // bottom — see FORCE_RENDER_MIN_STEP_PX's comment. Harmless no-op once already at
            // (or past) the bottom, same as the old jump-to-max did.
            const step = Math.max(container.clientHeight, FORCE_RENDER_MIN_STEP_PX);
            container.scrollTop = Math.min(container.scrollTop + step, container.scrollHeight);
            await sleep(FORCE_RENDER_POLL_INTERVAL_MS);
            pollNum++;
            const currentCount = countParseableCards();
            if (currentCount !== lastCount) {
                if (DEBUG) dbg('force-render: parseable count changed', { sweep: sweepNum, poll: pollNum, from: lastCount, to: currentCount, totalContainers: getCardElements().length, elapsedMs: Date.now() - startedAt, scrollTop: container.scrollTop, containerScrollHeight: container.scrollHeight });
                lastCount = currentCount;
                lastChangeAt = Date.now();
            }
            if (Date.now() - lastChangeAt >= FORCE_RENDER_QUIET_MS) { stoppedVia = 'quiet'; break; } // genuinely quiet, not just between polls
        }
        if (DEBUG) dbg('force-render: sweep concluded', { sweep: sweepNum, stoppedVia, polls: pollNum, finalParseableCount: countParseableCards(), finalContainerCount: getCardElements().length, elapsedMs: Date.now() - startedAt });
    }

    async function forceRenderAllVisibleCards() {
        if (forcingRenderInProgress) return;
        const cards = getCardElements();
        if (cards.length === 0) { // nothing rendered yet at all — retry next cycle
            setFeatureHealth('forceRender', 'idle', 'no cards mounted yet');
            return;
        }

        const container = findScrollableAncestor(cards[0]);
        if (!container) { // not scrollable yet (page likely still loading) — retry next cycle, don't lock
            setFeatureHealth('forceRender', 'idle', 'scrollable container not found yet');
            return;
        }

        const signature = getListSignature();
        lastForcedListSignature = signature;

        // v7.43: every original is captured, and the re-entrancy flag set, BEFORE the try — but
        // nothing that can throw happens between here and it. Previously the style writes and the
        // DEBUG block sat between `forcingRenderInProgress = true` and the try, so a throw in any of
        // them would have left the flag stuck true and permanently disabled force-render for the
        // rest of the session, with no way to recover short of a reload.
        const originalScrollTop = container.scrollTop;
        const originalScrollBehavior = container.style.scrollBehavior;
        // v7.24: reported live — now that force-render captures 100% of unclassified companies,
        // the visible whoosh-down-then-snap-back (especially the guaranteed second pass, which
        // often finds nothing new and stops after only a partial scroll) reads as jarring/broken
        // even though it's working correctly. Fades the container out for the duration of the pass
        // instead of hiding it outright: opacity doesn't remove the element from layout or affect
        // getBoundingClientRect(), so IntersectionObserver-based lazy-loading (which only ever
        // looks at geometry, never paint/opacity) keeps working exactly as before — unlike
        // visibility:hidden or display:none, which the original design discussion flagged as a
        // real risk of breaking the lazy-load trigger this whole feature depends on. Restored only
        // once settleScrollRestore() confirms scrollTop actually landed back at the real original
        // position, so the user only ever sees the list in its correct, settled state — never
        // mid-sweep or mid-restore.
        const originalOpacity = container.style.opacity;
        const originalTransition = container.style.transition;

        forcingRenderInProgress = true;

        try {
            container.style.scrollBehavior = 'auto'; // instant, so each step doesn't overlap an animation
            container.style.transition = 'none'; // the fade itself must be instant, not an animated dim
            container.style.opacity = '0';

            // v7.16: temporary — three fixes in a row (v7.13/v7.14/v7.15) at this same feature and
            // it's STILL undercounting live (reported: auto shows 2, full manual scroll shows 4).
            // Rather than guess a fourth time, log exactly what container was found and how the count
            // actually evolved during the pass, so the real cause (wrong container? quiet window
            // still too short for this page? a second card source outside this container's scroll
            // range entirely?) can be read directly instead of guessed at. Also scans for any
            // "N results"-style text on the page — worth checking whether an authoritative expected
            // count exists that could replace the scroll-and-guess approach entirely, per a user
            // suggestion. Remove this whole block once the real cause is confirmed.
            if (DEBUG) {
                const resultsTextMatch = document.body.textContent.match(/\b(\d{1,4})\s+results?\b/i);
                // v7.17: report EVERY candidate ancestor, not just the one that won — if "largest
                // clientHeight" turns out to still be the wrong pick on some layout, this is what
                // will show it immediately instead of needing yet another round of logging.
                const allCandidates = findAllScrollableAncestors(cards[0]).map((node) => ({
                    tag: node.tagName, class: String(node.className || '').slice(0, 60),
                    scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
                    isChosen: node === container
                }));
                dbg('force-render: starting', {
                    containerTag: container.tagName, containerClass: String(container.className || '').slice(0, 80),
                    containerScrollHeight: container.scrollHeight, containerClientHeight: container.clientHeight,
                    originalScrollTop, initialCardCount: cards.length,
                    pageResultsTextFound: resultsTextMatch ? resultsTextMatch[0] : null,
                    candidateCount: allCandidates.length, allCandidates
                });
                // v7.18: full unfiltered chain — see debugDumpAncestorChain()'s comment. Logged as its
                // own line (not nested in the object above) so it's easy to expand/copy separately in
                // the console.
                dbg('force-render: FULL ancestor chain (unfiltered)', debugDumpAncestorChain(cards[0]));
            }

            // v7.25: all sweeps happen inside this ONE invocation, between a single hide and a
            // single reveal — see FORCE_RENDER_GUARANTEED_SWEEPS's comment for why the retry loop
            // moved in here from runCycle. Deliberately does NOT restore the user's scroll position
            // between sweeps: parking back at the top is what killed the lazy-load stimulus and
            // caused the v7.23 deadlock, so the restore happens exactly once, in the finally below.
            for (let sweep = 1; sweep <= FORCE_RENDER_MAX_SWEEPS; sweep++) {
                const countBefore = countParseableCards();
                await runOneRenderSweep(container, sweep);
                const countAfter = countParseableCards();
                // User navigated to a different list mid-sweep — stop working on a page they left.
                if (getListSignature() !== signature) {
                    if (DEBUG) dbg('force-render: list changed mid-sweep, abandoning', { sweep });
                    break;
                }
                if (sweep >= FORCE_RENDER_GUARANTEED_SWEEPS && countAfter === countBefore) {
                    if (DEBUG) dbg('force-render: all sweeps done', { sweeps: sweep, finalParseableCount: countAfter });
                    break;
                }
            }
        } finally {
            // v7.43: bounded in its own try — settleScrollRestore touches a DOM node that an SPA
            // navigation may have swapped out mid-sweep. If it ever threw, every line below would
            // be skipped and the job list would stay at opacity 0 permanently: the single worst
            // failure this feature can produce, and entirely preventable.
            try {
                await settleScrollRestore(container, originalScrollTop);
            } catch (e) {
                console.error('[Size Filter] scroll restore failed; revealing list anyway:', e);
            }
            container.style.opacity = originalOpacity; // reveal only once truly back at rest
            container.style.transition = originalTransition;
            container.style.scrollBehavior = originalScrollBehavior;
            forcingRenderInProgress = false;
            filterJobListCards(); // reflect the now-complete card set immediately
            // v7.49: runs even if the try above threw — a subsequent throw during unwind (there
            // isn't one on this path today) would still leave this as the last word, which is fine:
            // the .catch() on the caller's fire-and-forget call below overwrites it with 'failed'
            // once the rejection actually propagates, same ordering as a normal finally-then-rethrow.
            setFeatureHealth('forceRender', 'ok');
            if (DEBUG) dbg('force-render: restored scrollTop', originalScrollTop, 'actual landed scrollTop', container.scrollTop, 'final parseable/container count after restore', countParseableCards(), getCardElements().length);
        }
    }

    // --- Scheduling ------------------------------------------------------
    // v6.11: the whole "which frame should show the panel" family of guesswork (v6.6-v6.10 —
    // removeDuplicatePanels/isJobsListUrl/frameHasRelevantCards) is gone. It's structurally
    // impossible for two panels to exist now: this file returns immediately in any iframe (see
    // the guard at the very top), so injectControlPanel()'s own "already exists, skip" check is
    // sufficient again — there is only ever one script instance running anywhere on the page.
    // v7.49: each step used to share one try/catch — a throw in an early step (e.g. panel
    // injection) skipped every step after it for that cycle, including completely unrelated ones
    // like the badge. Harmless in practice (the next cycle starts over from the top a moment
    // later), but it meant one broken feature could delay a sibling's recovery, and there was no
    // record of which feature failed. Each step is now isolated: a throw in one never blocks the
    // ones after it in the same cycle, and runFeature() records what happened for the Data-tab
    // status view and the Diagnose report. Order is unchanged from before — core filtering still
    // runs ahead of the purely cosmetic badge.
    // v7.66: `@match *://*.linkedin.com/*` is deliberately kept broad — narrowing it to /jobs/* was
    // considered and rejected, because Tampermonkey matches at DOCUMENT LOAD and LinkedIn is a SPA:
    // starting on the feed and navigating into jobs would then never start the script at all. The
    // real cost of the broad match isn't the match, it's that a subtree MutationObserver on a busy
    // page (feed, messaging) fires constantly and drags a full runCycle behind it. So the gate goes
    // here instead of in the metadata block, where it's free to be wrong: a URL check costs nothing,
    // and the 1s poll re-evaluates it, so an SPA navigation into /jobs resumes everything within a
    // second with no reload. Panel injection stays ungated — it's idempotent, cheap, and hiding it
    // would be a visible behaviour change nobody asked for.
    function isJobRelevantPage() {
        const path = location.pathname;
        return path.indexOf('/jobs') === 0 || path.indexOf('/company/') === 0;
    }

    function runCycle() {
        runFeature('panel', injectControlPanel);
        if (!isJobRelevantPage()) {
            // Not a page any of the remaining features can act on. Reported as idle rather than
            // skipped silently, so the Data tab and the Diagnose report both stay truthful about why
            // nothing is happening — "not applicable here" is exactly what 'idle' means.
            ['filtering', 'companyCapture', 'detailCapture', 'badge', 'forceRender']
                .forEach((id) => setFeatureHealth(id, 'idle', 'not a jobs or company page'));
            try { renderFeatureHealthPanel(); } catch (err) { console.error('[Size Filter] renderFeatureHealthPanel failed:', err); }
            return;
        }
        // v7.61: filtering and detailCapture joined badge in reporting their own status. A bare 'ok'
        // from this wrapper only ever meant "didn't throw", which both of them can do perfectly while
        // silently accomplishing nothing — see reportCardYieldHealth() and detailYieldVerdict().
        runFeature('filtering', filterJobListCards, { reportOkOnSuccess: false });
        runFeature('companyCapture', captureCompanyPageIfPresent);
        runFeature('detailCapture', captureFromJobDetailPane, { reportOkOnSuccess: false });
        runFeature('badge', syncCompanyBadge, { reportOkOnSuccess: false }); // reports its own finer-grained status internally

        // v7.25: back to a simple "new list? sweep it" trigger. All retrying now happens inside
        // forceRenderAllVisibleCards() itself, which is both what fixes the visible flicker
        // between passes and what makes the retry logic correct — see
        // FORCE_RENDER_GUARANTEED_SWEEPS's comment.
        // v7.47: "new list?" is no longer answered from a single instantaneous read — see
        // LIST_SIGNATURE_SETTLE_MS's comment. A candidate has to stay unchanged across real
        // elapsed time before it's trusted.
        try {
            const currentSignature = getListSignature();
            if (currentSignature !== pendingListSignature) {
                pendingListSignature = currentSignature;
                pendingListSignatureSince = Date.now();
            }
            const signatureSettled = (Date.now() - pendingListSignatureSince) >= LIST_SIGNATURE_SETTLE_MS;
            if (!forcingRenderInProgress && signatureSettled && currentSignature !== lastForcedListSignature) {
                // v7.46: DEBUG-only — logged BEFORE the call so the old/new signature strings are on
                // record even if forceRenderAllVisibleCards() itself never gets far enough to log
                // anything (e.g. cards.length === 0 yet). Diffing "from"/"to" character-by-character
                // is the fastest way to confirm or rule out a real content change (a new "start=",
                // etc.) vs a spurious one (param reordering, an untracked volatile param) if this
                // still fires more often than expected.
                if (DEBUG) dbg('runCycle: list signature changed, triggering force-render', { from: lastForcedListSignature, to: currentSignature });
                // v7.49: fire-and-forget, but no longer uncaught — forceRenderAllVisibleCards() is
                // async with no internal catch of its own (by design: its finally block must always
                // run first), so a throw inside its try became an unhandled promise rejection that
                // runCycle's own try/catch could never see (it had already returned by the time the
                // rejection happened). This .catch() is the only thing that ever observed it.
                forceRenderAllVisibleCards().catch((err) => {
                    setFeatureHealth('forceRender', 'failed', err && err.message ? err.message : String(err));
                    console.error('[Size Filter] force-render failed:', err);
                });
            }
        } catch (err) {
            setFeatureHealth('forceRender', 'failed', err && err.message ? err.message : String(err));
            console.error('[Size Filter] runCycle (force-render trigger) failed:', err);
        }

        // v7.50: last, unconditionally — reflects whatever every step above JUST reported,
        // including the one that may have thrown. Not routed through runFeature() itself: it's the
        // consumer of feature health, not a feature with its own health worth tracking.
        try {
            renderFeatureHealthPanel();
        } catch (err) {
            console.error('[Size Filter] renderFeatureHealthPanel failed:', err);
        }
    }

    let debounceHandle = null;
    function scheduleRun(mutations) {
        if (mutations && mutations.length > 0) {
            const panel = document.getElementById(UI_PANEL_ID);
            const allInsidePanel = panel && mutations.every((m) => panel.contains(m.target));
            if (allInsidePanel) return;
        }
        clearTimeout(debounceHandle);
        debounceHandle = setTimeout(runCycle, RUN_DEBOUNCE_MS);
    }

    // v6.11: the top-level MutationObserver started below only sees mutations in the top document —
    // an iframe's own DOM changes (e.g. more job cards rendering in as you scroll) are invisible to
    // it even though getSearchDocuments() can now read that iframe's content on demand. Attaches
    // an equivalent observer directly to each accessible iframe's body as they're found, so those
    // changes get picked up as promptly as the top document's own. observedIframeDocs stops the
    // same iframe document from being wired up twice across repeated runCycle calls.
    const observedIframeDocs = new WeakSet();
    function ensureIframeObservers() {
        document.querySelectorAll('iframe').forEach((frame) => {
            try {
                const doc = frame.contentDocument;
                if (doc && doc.body && !observedIframeDocs.has(doc)) {
                    observedIframeDocs.add(doc);
                    new MutationObserver(scheduleRun).observe(doc.body, { childList: true, subtree: true });
                }
            } catch (e) { /* cross-origin — inaccessible, skip */ }
        });
    }

    // v7.54 briefly deferred everything below to DOMContentLoaded, needed only because that version
    // moved this script to `@run-at document-start` (for a fetch()-interception observer that was
    // later removed in v7.60 — see its comment near the top of this file). Back on `@run-at
    // document-end` as of v7.60, `document.body` is always guaranteed to exist by the time this
    // runs, so the deferral is gone too — nothing else in this file needs earlier-than-document-end
    // timing.
    const observer = new MutationObserver(scheduleRun);
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(ensureIframeObservers, RUN_POLL_FALLBACK_MS);
    ensureIframeObservers();

    setInterval(runCycle, RUN_POLL_FALLBACK_MS);
    runCycle();
})();
