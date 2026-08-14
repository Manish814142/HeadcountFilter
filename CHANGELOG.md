# HeadcountFilter — Changelog

Version-by-version history of `headcount-filter.user.js`. For what the script
currently does (and why), see the Features block at the top of the script itself — this file is
history only, kept in sync on every version bump but not needed to understand current behavior.

## v6.3 — fixed two correctness regressions introduced by an untested v6.2 rewrite:
  - generateCandidateSlugs() had silently lost the "drop first word" case (e.g. "PW
    PhysicsWallah" -> "physicswallah"), and its suffix/prefix budget was being spent on
    whichever candidate happened to land at array indices [0]/[1] rather than the actual
    best-guess trimmed name. Restored drop-first-word and made the suffix targets explicit.
  - The slug cache was evicting an already-resolved slug on ANY failure (timeouts, network
    errors, the new authwall check) instead of only on a definitive 404, causing repeated
    full rediscovery storms for slugs that were already correct. Now only evicts on 404.
  - Verified: all three search fallbacks (Bing/Google/DuckDuckGo) return unusable HTML for
    plain anonymous GET requests (JS-only shells / bot-check pages) when tested directly -
    kept as a low-probability bonus, not something the pipeline depends on.

## v6.4 — fixed two real-world failures reported after running the script live:
  - "StepSecurity" (real slug: step-security) never resolved. Root cause: normalizeCompanyName()
    lowercases before any word-boundary logic runs, so "StepSecurity" collapses to the single
    token "stepsecurity" before generateCandidateSlugs() ever sees it - "step-security" could
    never be generated. Fixed by threading the case-preserved display name (not the normalized
    cache key) into the guesser, and splitting camelCase boundaries there.
  - "Exotel" cached a wrong bucket. Root cause: extractSizeFromHtml()'s JSON-LD
    numberOfEmployees strategy and the unscoped generic "N-M employees" regex both read
    numbers that aren't the declared "Company size" bucket (verified live: LinkedIn's public
    anonymous page exposes a "numberOfEmployees" JSON-LD value that doesn't match the real
    size shown to a logged-in viewer, and gates the real bucket behind a sign-in wall for many
    companies). Both strategies removed; only the two signals that require the literal "Company
    size" text/label to be present are trusted now. Wrong data is worse than no data for a
    filter, so companies LinkedIn gates anonymously now fail cleanly instead of guessing.
  - Added passive capture: whenever this script is running on a company's own LinkedIn page
    (which you're only ever on because you clicked through yourself, logged in - no extra
    request), it reads that page's real "Company size" field and caches it. This is the
    reliable path for companies the anonymous guesser can't reach.

## v6.5 — fixed three more real-world failures reported after running v6.4 live:
  - "Click a job card to record it" wasn't actually working. The v6.4 passive capture only
    fired on a full navigation to /company/`<slug>` - but clicking a job card normally just
    updates the right-hand detail pane inside the same /jobs/... URL, which never matches
    that check. Added captureFromJobDetailPane(), which reads the company size straight out
    of the detail pane's own "X employees | Y on LinkedIn" module. Adapted the settle-window
    approach from a companion badge script that had already found and fixed the real hazard
    here: right after switching jobs, the pane can still show the PREVIOUS job's company data
    for a beat before LinkedIn's SPA re-renders, and caching during that window silently
    attaches the wrong company's size to the new job. Now waits out a settle window after any
    job-id change before trusting anything read from the pane.
  - Cache had accumulated malformed entries ("1 employee", "2-10 employees") that don't match
    any real LinkedIn bucket - leftover from older, buggier extraction logic (now fixed), not
    something the current code can still produce, but nothing was cleaning up what earlier runs
    already wrote. Added a startup pass that strips any cached value that isn't one of the 8
    canonical SIZE_BUCKETS.
  - "Handshake" cached the wrong company's size. Root cause: the candidate guesser has zero
    identity verification - linkedin.com/company/handshake and linkedin.com/company/team-
    handshake are both real, distinct companies, both titled "Handshake | LinkedIn" (confirmed
    live), and the guesser had no way to know it landed on the wrong one since the size it read
    was completely genuine, just for someone else. Added verifyPageMatchesCompany(), which
    checks the fetched page's own `<title>` against the target name before trusting a result -
    this catches a MISMATCHED-name wrong guess, but can't disambiguate two companies that
    share the exact same name (that's what the passive-capture-on-click paths above are for).
  - "PHINIA" never resolved even though a correct slug exists (phiniainc, confirmed live -
    bare "phinia" 404s). The suffix list only ever produced hyphenated variants ("phinia-inc");
    a merged legal-suffix slug was never generated as a candidate at all. Added a small set of
    concatenated (no-hyphen) short-suffix candidates - inc/io/ai/app/hq - tried early.

## v6.6 — fixed a duplicate-panel bug: two "Filter Sizes" ribbons could appear at once, one stuck
  showing "Unclassified: 0" forever until a hard refresh. Root cause: the script had no
  @noframes directive, so Tampermonkey was also injecting a full separate copy of it into any
  linkedin.com iframe on the page (chat widgets, embedded modules, etc.) - each with its own
  independent document that never sees real job cards, hence the permanently-stuck counter.
  Added @noframes so the script only runs in the top-level page, plus a defensive
  removeDuplicatePanels() pass every cycle that enforces "at most one panel" regardless of how
  an extra one got there. Note: @match/@noframes are metadata-block changes - Tampermonkey only
  picks these up when the installed script itself is updated/reinstalled, not on a page refresh.

## v6.7 — the @noframes fix in v6.6 was likely wrong and has been reverted. Reasoning: with
  @noframes, the job list stopped being filtered at all (Hidden/Unclassified stuck at 0, no
  cards hidden) on a page where it previously worked - which only makes sense if the "working"
  ribbon before v6.6 was actually running inside an iframe that has its own document containing
  the real job cards, and @noframes cut the script off from exactly that context, leaving only a
  top-frame instance with no cards to see. That's a materially different theory than v6.6's
  ("iframe copy is a useless duplicate, top frame is the real one") - removeDuplicatePanels()
  alone can't actually produce a same-document duplicate given injectControlPanel()'s existing
  getElementById guard (there's no async gap between the check and the append), so a same-document
  explanation doesn't hold up under closer review; cross-frame is the only mechanism left standing.
  Rather than guess again, added a temporary diagnostic to the panel's counter line - [top/iframe,
  cards:N] - to confirm which frame(s) actually have working card access before changing anything
  else. removeDuplicatePanels() is left in place (harmless no-op whenever a document has only one
  panel, which is the normal case either way).

## v6.8 — the v6.7 diagnostic confirmed it directly: on jobs list pages, the real job cards live in
  an iframe's own document ([iframe, cards:31], fully working); the top-level document has zero
  access to them ([top, cards:0], permanently stuck). Both frames match @match and would each
  show a panel. Fix: each frame now checks, on a jobs list URL, whether IT actually has cards
  before creating a panel - if not, it stays silent instead of showing a second, non-functional
  one (a transient 0-card moment won't remove an already-shown panel, so no flicker). Non-jobs
  pages are unaffected. Diagnostic tag removed from the counter line now that it did its job.

## v6.9 — v6.8's "any card at all" threshold for showing a panel wasn't specific enough: on a fresh
  page load it worked (confirmed - single working panel), but during in-page navigation between
  jobs, two ribbons came back with visibly inconsistent counts/checkbox states, meaning two panels
  were alternating visibility at the same fixed screen position again. Most likely cause: LinkedIn
  sometimes renders a secondary "related/similar jobs" widget using the same card markup in the
  TOP document too, which is enough to trip "any card > 0" and permanently lock in a second panel
  there (once shown, a panel is never un-shown). Fixed by requiring the frame to contain the
  SPECIFIC job currently open (matched via currentJobId from the URL against each card's own job
  id) rather than just any card - a stray related-jobs widget won't happen to contain the exact
  job you clicked; only the real main list will.

## v6.10 — two more reports: the duplicate-panel fix still wasn't fully closed, and clicking an
  unclassified company's job card shows its size via a companion badge script but doesn't get
  cached by this one. For the panel: re-reading frameHasRelevantCards() found a real remaining
  gap - when no currentJobId is in the URL yet (a brief window on a fresh /jobs/search/ load,
  before LinkedIn auto-selects a job), it fell back to the old "any card > 0" check, reopening
  the exact hole v6.9 was built to close. Now it simply waits for a jobId to exist instead of
  guessing from a raw count. For the capture-not-saving issue, four fixes in a row based on
  inference (v6.6-v6.9) is the threshold for gathering real evidence instead of a fifth guess -
  added temporary console logging (DEBUG flag near the top of the script) that reports, per
  frame, the panel-injection decision every time it changes, and for job-detail capture: whether
  a matching card was found for the open job, and what the size-extraction selectors actually
  found. Prefixed "[SizeFilter:TOP]" / "[SizeFilter:IFRAME]" so both frames' logs are
  distinguishable in the console. Remove this block (and its call sites in runCycle and
  captureFromJobDetailPane) once both reports are confirmed fixed.

## v6.11 — architectural change, not another heuristic. Confirmed live (screenshot): two panels
  landing at genuinely different screen heights, each "position: fixed; top: 130px" relative to
  its OWN frame's viewport - proof this was always a real multi-frame situation, and five
  narrower-and-narrower guesses in a row (v6.6-v6.10) at "which frame should own the panel" is
  the threshold for reconsidering the approach rather than shipping a sixth guess. New design:
  the script now does nothing at all when running inside an iframe (hard guard at the very top,
  before any state is even set up) - there is only ever one active instance, so the whole
  "which frame wins" question no longer exists. Instead, getSearchDocuments() lets that one
  top-frame instance reach directly into any accessible same-origin iframe's DOM (linkedin.com
  iframes are same-origin, so this is plain, permitted DOM access - no messaging needed).
  getCardElements(), extractCompanySizeFromDetailPane(), and captureCompanyPageIfPresent() all
  search across the top document plus every accessible iframe now instead of just their own.
  removeDuplicatePanels()/isJobsListUrl()/frameHasRelevantCards() and their runCycle wiring are
  deleted entirely - structurally unnecessary once duplication itself is impossible. Also added
  a MutationObserver on each discovered iframe's body (ensureIframeObservers()), since the
  existing top-document observer can't see mutations happening inside a child document.

## v7.0 — merged in a standalone companion script the user was running alongside this one ("LinkedIn
  Company Info Badge"), which showed "X employees | Y on LinkedIn" on the job detail top card by
  reading the same "About the company" module this script already scrapes for passive capture.
  Rather than a straight port, factored out scanCompanyInlineInfo() as a single shared scraper for
  that module, used by both extractCompanySizeFromDetailPane() (caching) and the new
  syncCompanyBadge() (display) — the two scripts previously carried their own independent copies
  of nearly the same regex/selector logic, which could have silently drifted apart. The badge's
  own stale-data guard (wipe immediately on job switch, withhold only text identical to the
  previous job within BADGE_STALE_GRACE_MS) was kept separate from captureFromJobDetailPane()'s
  settle window rather than unified, since they're solving the same class of problem for different
  stakes: a cache write is worth delaying up to a second to be sure, a disposable live badge is
  not. Also fixed a bug the old two-script setup could never actually hit: the companion script
  only ever ran as an independent copy against its own local `document` (one per frame, same
  mechanism v6.11 removed from this script), so it never needed to worry about which document an
  element was created in. Now that there's only one instance reaching across frames via
  getSearchDocuments(), the badge element has to be created with THAT document's own
  createElement() — inserting a node created in the top document into an iframe's tree throws in
  real browsers. syncCompanyBadge() is called from the existing runCycle(), reusing its
  MutationObserver/poll scheduling instead of running a second, independent one on the same page.
  The standalone companion script can now be removed.

## v7.1 — the v7.0 badge didn't work at all on a standalone /jobs/view/`<id>` page opened in its own
  new tab (rather than clicked from within a list): confirmed live, via a third helper script the
  user built specifically for this case, that none of findBadgeHeader()'s four selectors matched
  anywhere on that page, and the badge fell back to floating at a fixed screen position, visibly
  misaligned from the company name. Fixed by adding the one selector from that helper script this
  script didn't already have (.top-card-layout__first-sub-line), and reordering the selector list
  to try the company-name-only elements before the broader combined "name · location · posted
  time" line — lands the badge next to the name specifically instead of at the end of a longer
  line. Also added findAboutCompanySection() as a third fallback tier in scanCompanyInlineInfo()
  (shared by both caching and the badge): finds the "About the company" heading by its literal
  text and reads its containing `<section>`, for pages where neither the inline-information spans
  nor the [data-view-name="job-details-about-company-module"]/.jobs-company_box containers are
  present. And switched the badge from being inserted as a block-level sibling AFTER the header to
  being appended INSIDE it — puts it inline, on the right side of the company name where the text
  ends, matching what was actually asked for, instead of wrapping onto its own line below.

## v7.2 — v7.1's standalone /jobs/view/`<id>` fix was reported live as still not working: no badge at
  all now, across 4 different real job URLs. Since v7.0 removed the old fixed-position fallback
  entirely (deliberately - showing a misaligned badge was the earlier complaint), a failure now
  looks like "nothing at all" rather than "wrong place", which makes it impossible to tell from a
  screenshot alone whether the problem is (a) no size/count text found anywhere on the page, or
  (b) text found but none of BADGE_HEADER_SELECTORS matched, on this specific page layout. Rather
  than guess a third variant of the selector list blind, added temporary console logging
  (reusing the existing DEBUG flag/dbg() from v6.10) that reports, once per job id per each time
  the "found text?"/"found header?" answer changes: which document the size/count text was found
  in (if any), the actual text found, whether a header matched, and which specific selector
  matched if so. findBadgeHeader() restructured from a chained || into a loop over a named
  BADGE_HEADER_SELECTORS array (identical behavior/order) so the matched selector can be reported.
  Remove this logging once the real cause is confirmed from the console output.

## v7.3 — the v7.2 logging paid off immediately: console output confirmed sizeText/countText WERE
  found correctly ("1001-5000 employees" / "1,820 on LinkedIn", via findAboutCompanySection()),
  but headerFound was false — none of the 5 named selectors matched anywhere on that standalone
  /jobs/view/`<id>` page. A follow-up DOM inspection (user right-clicked the company name and
  shared the Elements panel) showed why a 6th guessed class name would have been pointless: this
  page renders through a build where every class on the top card is an auto-generated CSS-module
  hash ("_2278667d", "_820f8aa", etc.) that changes on every LinkedIn deploy - there's no stable
  class to target at all. The one durable thing on that same element was its href (a real link to
  the company's LinkedIn page). Added 'a[href*="/company/"]' as a 6th, last-resort entry in
  BADGE_HEADER_SELECTORS - the same href-matching pattern this script already trusts elsewhere
  (getCardInfo()'s company-link lookup) - tried only once all 5 named selectors have already
  failed, so it cannot change behavior on any layout where those still match first. Debug logging
  from v7.2 left in place pending live confirmation this actually fixes it.

## v7.4 — reported live: on /jobs/search-results/ (reached via the "your connections are hiring"
  notification - a URL pattern not seen before), the badge works correctly, but the filter panel
  doesn't: Hidden/Unclassified both stay at 0 with real, visible cards on screen and an unchecked
  size bucket that should have hidden at least one of them. That means getCardElements() is
  matching zero cards on this layout - the same class of problem just diagnosed and fixed for the
  badge's header detection in v7.3, but this time in the CORE filtering path, not a cosmetic
  add-on, so it isn't safe to guess a fix blind here. Added the same evidence-gathering approach
  that worked last time instead: temporary debug logging (debugCardDetection(), called from
  getCardElements()) that reports how many cards each of the 5 known container selectors matched,
  alongside a structural count of how many a[href*="/jobs/view/"] / [currentJobId=] anchors exist
  on the page at all - independent of any container class, the same signal that fixed the badge.
  If the named selectors come back at 0 while the anchor count is nonzero, the fix will likely be
  the same shape as v7.3's: derive cards from stable job-link hrefs instead of another guessed
  class name, extended to cover this and any future job-related page layout rather than patching
  one URL pattern at a time. CARD_CONTAINER_SELECTORS extracted as a named constant
  (getCardElements() unchanged in behavior) so both the real lookup and the debug counts share
  one list.

## v7.5 — the debug log confirmed the guess: jobLinkAnchorsFound was 1 for the entire page despite a
  full scrollable list of visible cards, and a follow-up DOM inspection (user right-clicked a card
  and shared the Elements panel) showed why - this layout's cards have no <a href> anywhere at
  all. The whole card is a single <div role="button" componentkey="job-card-component-ref-
  4429550666">, with the company name as a plain, unlinked `<p>`Microsoft`</p>`. Unlike a guessed CSS
  class, componentkey is actually a BETTER signal than what this script relied on before: it's a
  semantic attribute LinkedIn's own code writes the real job id directly into, no href-parsing
  needed. Added '[role="button"][componentkey^="job-card-component-ref-"]' to
  CARD_CONTAINER_SELECTORS (both attributes required together - componentkey alone repeats
  identically on a non-role inner wrapper div, which would otherwise double-match every card).
  getCardInfo() extended with two new fallback paths, both additive - only reached when the
  existing class-based/href-based lookups already found nothing, so already-working layouts are
  structurally unaffected: extractComponentKeyCompanyText() reads the company name as the first
  plain, un-nested `<p>` in the card (the job-title `<p>` always nests a `<span>` for the "Verified job"
  badge, which excludes it - a structural rule, not a class name, so it doesn't rot the way a
  guessed hash class would on LinkedIn's next redeploy); and the job id is read straight from the
  componentkey attribute when no href produced one. This is the same "match on something semantic
  and durable instead of a class name" approach used for the badge fix in v7.3, now applied to
  card detection itself.

## v7.6 — v7.5 confirmed working live, so this is the first release in a while that isn't a bug fix.
  Two things, both about protecting what the script has already built up rather than adding reach:
  - Backup & restore. The cache had grown to ~292 companies with no way out of localStorage
    except select-all-copy from the editor textarea, and no way to combine caches from two
    browsers at all. Much of that data comes from passive capture on pages LinkedIn gates from
    anonymous fetches, so Auto-Fetch genuinely cannot rebuild it - a single "clear browsing data"
    was an unrecoverable loss. Added Export (downloads a dated JSON of companyCache + slugCache)
    and Import & merge. The merge is deliberately non-destructive: an entry already present wins
    over the incoming one and the difference is reported as a conflict, because the main reason
    to import is combining two legitimate caches, and silently overwriting a locally-captured
    (logged-in, reliable) value with an imported one would destroy data with no undo. Import also
    accepts a bare {"company": "bucket"} object so backups made by copy-pasting the textarea
    before this existed still restore, and validates every bucket up front so a partially-bad
    file is rejected whole rather than half-applied. Logic covered by 24 assertions run against
    the shipped functions (round-trip export->import, conflict handling, all rejection paths).
  - Removed the debug instrumentation added in v6.10/v7.2/v7.4, now that every report it was
    added to diagnose is confirmed fixed: the three logging call sites, their Set bookkeeping,
    and debugCardDetection()'s extra per-cycle querySelectorAll passes are all gone. The
    DEBUG/dbg() helper itself is kept but switched off - LinkedIn ships several different job-page
    builds and changes their markup without warning, and this file has needed live per-frame
    diagnostics three separate times now, so the next investigation should be "flip the flag, add
    one line" rather than rebuilding the scaffolding a fourth time. Costs nothing while false.

## v7.7 — first P1 from the prioritized list: inline per-card size badges. Previously the cache was
  only ever used to hide/show cards or to inform the one job you'd clicked into - the size of
  every OTHER cached company on screen was invisible until you opened it. getCardInfo() now
  returns the companyEl it already found while identifying the card (instead of discarding that
  reference), so updateCardSizeBadge() can attach a small compact badge (SIZE_BUCKET_SHORT_LABELS
  - e.g. "10K+", "51-200" - the full bucket strings are too wide for a dense list row) right next
  to it, called once per card from the same filterJobListCards() pass that already looks up each
  card's bucket to decide hide/show, so this adds no extra scanning. Inserted as a sibling right
  after companyEl rather than nested inside it, since companyEl is sometimes an <a href="/company/
  ..."> link and nesting an unrelated badge inside it would silently make the badge part of that
  link's click target. Idempotent per card (checked via a marker class on companyEl's parent, not
  a page-wide id, since every card needs its own): updates the label in place if the cached bucket
  changes, removes the badge if a company somehow becomes uncached, does nothing twice. Covered by
  9 assertions against the shipped function (fresh insert, idempotent re-run, in-place update,
  removal, all 8 buckets mapped, orphan-element safety).

## v7.8 — second P1: cache provenance (source + timestamp per entry). Deliberately NOT a change to
  companyCache's value shape (name -> bucket string) - that shape is read directly in a dozen+
  places (filter checks, categorizeSize comparisons, the JSON editor, the v7.6 backup merge
  conflict check), and turning each value into an object would mean re-verifying every one of
  those sites for a feature that's purely informational. Instead added a parallel
  companyCacheMeta map (name -> {source, timestamp}, own localStorage key, own sanitize pass that
  prunes orphaned entries whose company no longer exists in companyCache) that every existing read
  of companyCache is completely unaffected by. recordCacheMeta() is called from all five places a
  company gets cached: captureCompanyPageIfPresent() and captureFromJobDetailPane() (both tagged
  with their own real, logged-in source), the three internal tiers of autoFetchUnclassifiedCompanies()
  (tracked via a new resolvedVia variable - slug-cache hit, candidate guess, or search fallback,
  tagged separately since they're not equally trustworthy: candidate-guess is the exact mechanism
  behind the v6.5 Handshake wrong-company bug), and the cache manager's Save button (tagged
  manual-edit, but only for entries that actually changed value from before the edit - untouched
  entries keep their prior provenance instead of the whole textarea being stamped on every Save).
  Backup export/import (v7.6) extended to carry it too: a restored/merged company keeps its
  original provenance rather than every import being flatly tagged "imported" - falls back to
  "imported" only when the backup itself has none (a bare {"company":"bucket"} file, or one
  exported before this existed) via a default parameter on mergeBackupIntoCache(), which keeps it
  callable with the pre-v7.8 two-field shape without throwing. Surfaced as a one-line source-count
  summary in the cache manager heading (formatCacheProvenanceSummary()); no other UI yet - this is
  the data laid down for a future "re-verify the riskiest/oldest entries" feature, not that
  feature itself. Covered by 21 assertions against the shipped functions (recording, round-trip
  through export/import with and without existing meta, conflict handling leaves local provenance
  untouched, backward compatibility with the old call shape, and the summary/formatting).

## v7.9 — reported live at 110% browser zoom: the v7.7 inline card badge (10px) was too small to
  read comfortably next to the card's own company-name text. Bumped to 13px/2px 8px padding,
  matching the size already used for the job-detail-pane badge (v7.0) instead of a smaller,
  separately-invented size for the card context.

## v7.10 — user bumped the card badge further by hand (13px -> 15px, padding 2px 8px -> 3px 9px) for
  readability at 110% browser zoom. Pure cosmetic CSS on updateCardSizeBadge()'s badge.style -
  nothing else in that function changed, confirmed with node --check.

## v7.11 — first P2: Auto-Fetch cancel + non-blocking progress. A run over 20+ unclassified
  companies (each up to MAX_CANDIDATE_ATTEMPTS guesses 250ms apart, plus 1.5s between companies)
  could run for minutes with no way to stop it short of closing the tab, ending in a blocking
  alert() that held up the page until dismissed. Added cancelFetchRequested, checked at three
  points: top of the per-company loop, inside the candidate-guess sub-loop (checked before each
  guess, not just once per company - otherwise a cancel click could still sit through up to 20
  more requests), and before the inter-company delay. The Auto-Fetch button now doubles as Cancel
  while a run is active instead of silently no-oping a second click. A company whose processing
  was cut short by a cancel is no longer written to failedCache/cooldown - it wasn't genuinely
  attempted to completion, so it shouldn't be penalized with a week-long retry delay the way an
  actual resolution failure is. The end-of-run alert() is gone entirely, replaced by
  setFetchStatus() - a small text line under the button (AUTO_FETCH_STATUS_ID) that shows live
  progress ("Fetching 5 of 40...") during the run and a final summary after, distinguishing
  "Finished!" from "Cancelled after N of M" - all without ever blocking the tab. Covered by 22
  assertions against the shipped function via a dependency-mocked harness (cancel lands within
  one in-flight request rather than after either a whole company or the full candidate budget,
  cooldown/skip accounting, resolvedVia/CACHE_SOURCE tagging still correct post-refactor, the
  alert()-only-when-nothing-to-fetch path, and that no alert() fires during or after an actual run).

Note (no version bump - process only, this script's runtime behavior is unchanged): second P2,
  a permanent regression suite now lives alongside this file as linkedin-company-size-filter-v6.
  test.js. Every ad-hoc verification script written while building v6.4 through v7.11 was
  throwaway - re-derived from scratch each time a bug needed root-causing, and discarded after.
  The permanent suite instead re-reads THIS file fresh on every run and extracts the real
  function/const source text verbatim (no hand-copying, which is exactly how the v6.2 candidate-
  slug regression shipped silently - a rewrite drifted from what was actually running and nothing
  caught it until production). Covers slug generation (the StepSecurity/PHINIA/PW-PhysicsWallah/
  Refyne/HackerRank regressions), size extraction (pinning the Exotel JSON-LD/unscoped-regex
  removal), verifyPageMatchesCompany (the Handshake collision guard), badge scraping, componentkey
  card detection, the inline card badge, backup/provenance round-trips, and Auto-Fetch
  cancellation - 52 assertions total. Run with `node linkedin-company-size-filter-v6.test.js`, no
  dependencies to install. Sanity-checked against itself: deliberately broke one mapped value live,
  confirmed the suite failed on exactly that assertion, then reverted - proof it's actually
  exercising this file's real code, not a decoupled copy that would happily keep passing forever.

## v7.12 — external suggestion, verified before building: autoFetchUnclassifiedCompanies used a
  FIXED delay (250ms between candidates, 1.5s between companies) no matter what the last request
  actually did - confirmed live in makeAnonymousRequest() that an HTTP 429 fell into the same
  generic `reject(new Error('HTTP ' + status))` path as any other non-200 response, so the calling
  code (a bare `catch (e) {}` at both call sites) couldn't have reacted differently even if it
  wanted to. A real gap, and squarely in this project's founding concern (avoid the anonymous
  fetches getting throttled/blocked). Added isRateLimitSignal() - true only for 429/503, the
  unambiguous rate-limit signals, deliberately NOT authwall/login redirects or plain 404s, which
  v6.3 already established are normal and unrelated to throttling; treating those as rate-limit
  signals would make backoff fire constantly under completely ordinary operation. Every
  makeAnonymousRequest outcome in the main loop now runs through registerRequestOutcome(): a
  429/503 doubles both the candidate and company delay (capped at MAX_BACKOFF_DELAY_MS) and counts
  toward MAX_CONSECUTIVE_RATE_LIMITS, after which the whole run stops itself (reusing the same
  cancelFetchRequested-adjacent machinery from v7.11) instead of continuing to escalate forever;
  anything else - success, or an unrelated failure - resets straight back to baseline. One
  refinement beyond the original suggestion: a company whose ONLY failure was a rate-limit
  response (tracked per-company via wasRateLimitedThisCompany, separate from the global streak) is
  now exempt from the normal 7-day failedCache cooldown - that failure wasn't the company's fault
  and would likely resolve fine once the throttling clears, so cooling it down for a week the same
  as a genuinely-unresolvable company would actively work against the goal. Covered by 8 new
  assertions in the permanent suite (delay doubling verified against actual ms values passed to
  sleep(), reset-on-non-rate-limit-outcome, auto-stop at exactly MAX_CONSECUTIVE_RATE_LIMITS with
  zero cooldown entries created, and confirming a genuine 404 still gets a normal cooldown so this
  refinement doesn't accidentally swallow real failures too) - 60 total.

## v7.13 — reported live with two screenshots of the same page: opening a job list showed
  "Unclassified: 1", scrolling down (no other action) showed "Unclassified: 9". Root cause isn't
  a filtering bug - LinkedIn lazily mounts job cards only as the user scrolls near them, so
  getCardElements() was always accurate for what existed in the DOM, the DOM just didn't have the
  rest of the list yet. A user glancing at the panel right after opening the page would see a
  misleadingly low count and could click Auto-Fetch believing there was little left to do. Added
  forceRenderAllVisibleCards(): finds the list's real scrollable container structurally
  (findScrollableAncestor(), walking up from a known card checking for genuine overflow - the
  same "don't hardcode a container class" approach CARD_CONTAINER_SELECTORS and
  BADGE_HEADER_SELECTORS' last-resort entries already needed after LinkedIn's markup turned out
  different across layouts, v7.3/v7.5), scrolls it to the bottom repeatedly until the card count
  stops growing (two consecutive stable reads, capped at FORCE_RENDER_MAX_STEPS so a list that
  never stabilizes can't scroll forever), then restores the exact original scroll position -
  visible effect should be a brief flicker, not a lasting jump. Runs once per genuinely new list
  view via getListSignature(), which deliberately excludes currentJobId so clicking through
  different jobs within the same already-rendered list never re-triggers it. One assumption this
  relies on, stated plainly: LinkedIn's list APPENDS cards as you scroll rather than unmounting
  ones that scroll out of view - supported by the live report itself (the count only ever grew,
  1 to 9, never dropped as which cards were visible changed), but if some other layout turns out
  to truly virtualize-with-unmount, the fix would still run, just not fully solve it there - a
  fixable, evidence-driven follow-up like every other layout-specific gap in this file's history,
  not a design overhaul. Covered by 6 new assertions (finds the real container while skipping
  non-scrolling wrappers, rejects overflow:auto with negligible actual overflow, no-scrollable-
  ancestor safety, and getListSignature's core promise - same signature across different jobs in
  one list, different signature across pagination or a different page entirely) - 66 total.

## v7.14 — reported live: v7.13 still undercounted (auto-stopped at 2, manual scroll found 5-6 more
  on the same page). Root cause: the "2 consecutive unchanged 150ms polls = done" heuristic
  declared victory while LinkedIn's lazy-load fetch - a real network round trip - was still in
  flight, since 150ms x 2 is often shorter than that fetch actually takes. Replaced with adaptive
  quiet-period detection: instead of counting fixed polls, track how long it's actually been
  since the card count last changed (in real elapsed time via Date.now(), not poll count), and
  only conclude done once that's been genuinely quiet for FORCE_RENDER_QUIET_MS (900ms) -
  automatically adapting to however long the real fetch takes rather than guessing a fixed
  number of polls, with FORCE_RENDER_TIMEOUT_MS (12s) as a hard overall cap so a page that never
  stabilizes still can't hang indefinitely. FORCE_RENDER_STEP_DELAY_MS/FORCE_RENDER_MAX_STEPS
  replaced by FORCE_RENDER_POLL_INTERVAL_MS/FORCE_RENDER_QUIET_MS/FORCE_RENDER_TIMEOUT_MS.
  Added a dedicated permanent-suite test for forceRenderAllVisibleCards() itself using a fake
  clock (const Date = { now: () => fakeClock }, shadowing the real Date within the sandboxed
  module scope - the function calls Date.now() directly, not an injectable parameter) so the
  exact reported bug shape - growth slower than one poll interval - can be reproduced
  deterministically without a real multi-second test run. Building that test also surfaced and
  fixed a real structural bug in the suite runner itself: two suites do internal async work
  (this one and autoFetchUnclassifiedCompanies), and every earlier suite() call site was a bare,
  un-awaited invocation - fine with only ONE async suite at the very end of the file, but adding
  a second one BEFORE it in file order meant they raced, and whichever finished first called
  process.exit() (via finish()) while the other's assertions were still pending, which silently
  never ran - no error, just a suite header with nothing under it. Fixed by making suite() await
  fn()'s return value, having both async suites return their internal IIFE's promise instead of
  firing it and forgetting, and wrapping the whole file's suite sequence in one top-level async
  IIFE with every call site awaited, calling finish() exactly once at the true end. 70 total.

## v7.15 — reported live: even with v7.14's timing fix, force-render still missed companies -
  scrolling to the very top after it finished revealed unclassified ones it hadn't covered.
  Root cause visible directly in the code, no live evidence needed this time:
  forceRenderAllVisibleCards() captured whatever the container's scrollTop happened to be when it
  kicked in and only ever scrolled DOWN from there to the bottom - it never explicitly returned to
  the actual top first. Anything above wherever it happened to start (the page still settling, a
  manual scroll that beat it to the punch, any reason scrollTop wasn't already exactly 0) was
  never in range of the scroll-to-bottom pass at all. Fixed by resetting to scrollTop = 0 and
  letting it settle for one poll interval BEFORE starting the existing scroll-to-bottom-until-
  quiet loop, so the full 0%-100% range is covered instead of wherever-it-started to 100%. Added
  a test that mocks the container starting away from position 0 (matching the live scenario) and
  asserts the very first position the function moves it to is exactly 0, using a scrollTop
  getter/setter that records the full sequence of positions rather than just the final restored
  value - the bug wouldn't have shown up in a snapshot of the end state, only in the sequence.
  71 total.

## v7.16 — reported live yet again: even with v7.15's top-reset fix, force-render still undercounts
  (auto showed 2, full manual scroll showed 4). Three fixes in a row at this exact feature now -
  the threshold this file's own history (v6.6-v6.11's duplicate-panel saga) already established
  for stopping and gathering real evidence instead of shipping a fourth guess. DEBUG flipped back
  on (v7.6 kept the flag/dbg() helper exactly for this - "flip the flag, add one line" instead of
  rebuilding the scaffolding a fourth time) and three logging points added to
  forceRenderAllVisibleCards(): on start (which container was found - tag/class/scrollHeight/
  clientHeight - plus a scan of the page for any "N results" text, testing a user-suggested idea
  that an authoritative expected-count indicator might exist somewhere that could replace the
  scroll-and-guess approach entirely), on every card-count change during the pass (poll number,
  old/new count, elapsed time, container's scrollHeight at that moment), and on conclusion
  (stopped via the quiet window or the hard timeout, final count, elapsed time) - plus the count
  immediately after restoring scrollTop, which would directly reveal true virtualize-with-unmount
  behavior (count dropping back down once scrolled away) if that turns out to be what's actually
  happening, rather than the append-only behavior this feature's design has assumed since v7.13.
  Remove this logging once the real cause is found. Tests updated with `const DEBUG = false` in
  the mock scope so the new `if (DEBUG)`-guarded branches (which reference document/dbg) stay
  inert without needing those mocked, matching this script's own actual default outside an active
  investigation.

## v7.17 — the v7.16 logging paid off immediately: console output showed containerClientHeight: 158
  with initialCardCount/finalCount both stuck at 31 across the entire pass - findScrollableAncestor
  had found a REAL scrollable ancestor, just the wrong one: some small (158px visible height, 4407
  scrollHeight - a ~28x ratio far more consistent with a hidden/truncated content blob than an
  actual list panel) widget sitting between the card and the real list container, which the old
  "return the first match walking up" rule had no way to tell apart from the genuine list.
  Redesigned: findAllScrollableAncestors() now walks the FULL ancestor chain instead of stopping
  at the first hit, and findScrollableAncestor() picks whichever candidate has the largest
  clientHeight - the real list panel should be the biggest visible scrollable region in the
  chain, not a small nested widget. Debug logging (still on, pending live confirmation this is
  the actual fix) extended to report every candidate found - tag/class/scrollHeight/clientHeight
  and which one was chosen - not just the winner, so if "largest wins" turns out to still be
  wrong on some layout, that will be visible immediately in one more log capture instead of
  needing another blind guess. Two new tests reconstruct the live report's exact numbers (a
  158px/4407 small widget alongside an 800px/4000 real panel) and assert the large one wins, plus
  that findAllScrollableAncestors reports both candidates rather than just the first. 73 total.

## v7.18 — v7.17 reported live as still not working, and the new candidate-list logging revealed why
  the fix couldn't have helped: candidateCount: 1 - the SAME small widget as before (189px/4305
  this time) and NOTHING else anywhere in the ancestor chain. "Pick the largest of all matches"
  was solving the wrong problem: the real list panel isn't being out-ranked by a smaller match,
  it isn't matching the overflowY:auto/scroll filter at ALL. Fifth attempt at this exact feature
  now - diagnostics only this round, no behavior change, rather than guess again with still-
  incomplete information. Added debugDumpAncestorChain(): walks the full ancestor chain from the
  card to the page root COMPLETELY UNFILTERED (every element, not just ones already matching the
  overflow check) and reports each one's real computed overflow/overflowY, scrollHeight,
  clientHeight, offsetHeight, and position - so whatever the actual mismatch is (a CSS overflow
  value the current filter doesn't recognize, a JS-driven/virtualized scrolling mechanism with no
  native overflow at all, or something else entirely) is visible directly in the next console
  capture instead of guessed at for a sixth time.

## v7.19 — the v7.18 full-chain dump answered it, and it turned out container-selection was already
  correct: depth-1 in the chain is the one genuinely-overflowing element (overflow-y: auto,
  wrapping the actual card list), exactly what findScrollableAncestor() now picks. The real
  container was right both times - a coincidence of the user's DevTools panel being docked at the
  bottom of the screen explained its oddly small clientHeight (squeezing the whole page's usable
  viewport down), not a detection bug. The actual clue was elsewhere: the card COUNT stayed at
  exactly 31 across two entirely separate captures and never changed once - yet the Unclassified
  total still differed after manual interaction. That's not a rendering gap, it's a content-
  readiness gap: a card's outer container can mount (and get counted by getCardElements()) before
  its inner content - what getCardInfo() actually needs to read a company name - finishes
  rendering. filterJobListCards() silently SKIPS a null-info card entirely (not classified, not
  unclassified, just invisible to the counter), and force-render's quiet-window was only ever
  watching the raw container count, which can go quiet while several cards are still internally
  incomplete. Added countParseableCards() (how many cards getCardInfo() can currently read, not
  how many container elements exist) and switched the quiet-tracked metric to it. Debug logging
  updated to report both counts at every check point, directly confirming or refuting this from
  the next live capture. New test reproduces the exact shape live evidence showed - containers
  finish mounting fast, content gradually catches up afterward one card at a time (each gap well
  under FORCE_RENDER_QUIET_MS, so it can't be mistaken mid-stream for "settled") - and is verified
  as a genuine regression test, not just decoration: literally reverted to container-count
  tracking, confirmed the new assertion fails (frozen at 4 of 5 cards, matching the live symptom
  exactly), then restored the fix and confirmed it passes again. 75 total.

## v7.20 — the v7.19 logging exposed a different, more fundamental problem: finalParseableCount 14
  vs finalContainerCount 32, PERMANENTLY - the quiet window correctly detected "no more change,"
  but that plateau was real and never budged no matter how long it waited. Not a timing problem
  this time; jumping straight to scrollTop = scrollHeight every poll apparently never gave this
  list's virtualization the incremental signal it needs to render the remaining ~18 cards at all,
  no matter how patiently the wait is tuned. Switched to stepping by roughly one viewport height
  (container.clientHeight, floored at FORCE_RENDER_MIN_STEP_PX so a step can't be too small to
  matter) per poll instead of one instant jump to the bottom - much closer to what a real scroll
  gesture actually looks like to whatever virtualization LinkedIn uses here. New test verifies the
  stepping itself (the second recorded scroll position must be one step, not scrollHeight),
  confirmed as a genuine regression test the same way as v7.19's: reverted to the old single-jump
  behavior, confirmed the assertion fails (position jumps straight to 9999 instead of 300), then
  restored the fix and confirmed it passes again. 76 total. DEBUG still on - this is now the third
  distinct root cause found for this one feature (wrong-container, then content-not-ready, now
  wrong-scroll-technique), each real and each fixed with evidence, but still pending final live
  confirmation that the actual full unclassified count now matches a manual scroll.

## v7.21 — user reported a clean, reproducible split: on a fast connection the top-bottom-top sweep
  finds everything; on a slow connection it only fails on a page's FIRST load, and only if that
  load is still slow-loading when the sweep fires - navigating to page 2/3 or back always renders
  correctly, since by then the SPA nav is warm. That pattern pointed at the retry policy, not the
  pass mechanics fixed in v7.17-v7.20: forceRenderAllVisibleCards() treated "we ran a pass for
  this URL" as PERMANENT (lastForcedListSignature locked the URL forever, even across a full
  page's worth of content still loading). Two concrete bugs from that: (1) if
  findScrollableAncestor() returned null because the page hadn't grown a real scroll container yet
  (a fast, cheap, self-correcting case - same as the cards.length === 0 branch right above it), the
  code stamped the lock anyway instead of just retrying next cycle: confirmed by reading the code,
  not by guessing - the cards.length===0 branch and the !container branch handled the identical
  "not ready yet" situation completely differently, one retrying, one locking forever. (2) even
  when a container WAS found and the pass completed, if LinkedIn kept fetching more results
  afterward (normal on a slow connection - gaps between chunks can exceed FORCE_RENDER_QUIET_MS
  without loading actually being done), nothing ever swept the new cards in, since the lock was
  per-URL, not per "is the list still growing". Fixed both: (1) no longer locks on a missing
  container. (2) tracks lastForcedCardCount (how many cards existed when the last pass finished)
  and allows bounded re-passes for the same URL while getCardElements().length keeps growing past
  that, capped at FORCE_RENDER_MAX_PASSES_PER_SIGNATURE (5) so it can't turn into an unbounded loop
  that hijacks the user's own later manual scrolling once the list is genuinely just growing from
  normal use. This is the fourth distinct root cause found for this one feature across v7.17-v7.21
  - each one real, each fixed with direct evidence rather than a guess, but per that same pattern:
  if this round is STILL not enough, the next step should be questioning whether one-shot-scroll-
  sweep-per-page is the right architecture at all (e.g. triggering off network-idle instead of a
  DOM-mutation debounce, or reading the page's own "N results" text as an authoritative target
  count instead of scroll-and-guess), not a fifth narrow patch to this same function. New tests:
  forceRenderAllVisibleCards() no longer locks lastForcedListSignature when no container is found
  yet (verified via revert: fails with "sig" instead of null under the old code); runCycle()'s
  retry decision extracted and tested directly (new URL always retries even with an exhausted
  budget; same URL retries only while cards are still growing AND the budget isn't exhausted;
  steady-state and in-progress passes never re-trigger). 83 total. DEBUG still on pending live
  confirmation.

## v7.22 — user reported v7.21's retry mechanism visibly working live (console log showed three
  passes catching a page up from 14 to 46 to 48 parseable cards, matching container count exactly
  by the third pass) - but flagged a distinct new symptom: the final "scroll back to where the
  user actually was" step got visibly stuck partway roughly half the time, instead of always fully
  returning. Root cause: the restore was a single instant `container.scrollTop = original` write,
  trusted without verification. A scrollTop assignment isn't guaranteed to stick - the browser
  clamps it to whatever scrollHeight the container reports at that instant, and LinkedIn's own
  virtualization can still be reconciling scrollHeight (or independently overriding scrollTop,
  e.g. recycling far-off cards) for a moment right after a big programmatic jump like this sweep.
  Added settleScrollRestore(): re-asserts the target scrollTop and re-checks the DOM's actual value
  for a short bounded window (FORCE_RENDER_RESTORE_SETTLE_POLL_MS/_TIMEOUT_MS - 100ms polls, 800ms
  cap), instead of trusting one write - catches both "assignment got clamped immediately" and
  "something overrode it a moment later" without needing to know which one is actually happening.
  Bounded so a container that genuinely never settles still gives up cleanly rather than hanging.
  New tests simulate a mock container that silently clamps the first two restore attempts to a
  stale value before accepting the real target on the third, and a second case where it never
  releases at all - verifying both the retry-until-it-lands behavior and the bounded give-up.
  Verified by reverting to the old single-write restore and confirming the first new assertion then
  fails (lands at the stale clamp value, not the real target), then restoring the fix. 85 total.

## v7.23 — direct follow-up question to the user resolved the ambiguity in v7.21's "reported working"
  log: asked whether the earlier 3-pass catch-up (14 -> 46 -> 48) happened purely automatically or
  only after manual scrolling. Answer: "in the automation way only 1st log come" - passes 2 and 3
  only ever appeared once the user scrolled themselves. So v7.21's retry NEVER actually fires on
  its own; it just happened to look like it worked because manual scrolling was present in that
  session. Root cause, found by reading the code (not guessing): the growth-gated retry condition
  (getCardElements().length > lastForcedCardCount) is a deadlock. Every pass's own finally block
  restores scrollTop back to the ORIGINAL position once it concludes - for a first-ever page load,
  that's the top. Restoring to the top removes the only thing that would make LinkedIn load more
  in the first place (proximity to the bottom sentinel that its own lazy-load watches) - so card
  count can never grow on its own while parked at the top, so the growth-gated condition can never
  become true by itself. Only the user's own manual scroll (bringing the list back near the bottom)
  was ever satisfying it. The sweep itself is what causes growth; waiting for growth before
  sweeping again was backwards. Fix: added FORCE_RENDER_GUARANTEED_PASSES (2) - the first two
  passes per URL now run unconditionally, regardless of observed growth, covering the exact race in
  the live report (the very first sweep can reach the then-current bottom before a slow network has
  even started responding). Only passes 3 through the full FORCE_RENDER_MAX_PASSES_PER_SIGNATURE
  budget remain growth-gated, so an already-fully-loaded page still only pays for 2 sweeps, not 5.
  Rewrote the runCycle retry-guard tests to match: one pass done + count unchanged now expects a
  retry (the exact previously-reported deadlock scenario); a new pair of tests covers the
  growth-gated behavior resuming correctly once the guaranteed passes are used up. Verified by
  reverting to the old growth-only condition and confirming the deadlock-scenario assertion then
  fails, then restoring the fix. 87 total. This is the fifth distinct fix at this one feature across
  v7.17-v7.23 (container-pick, content-readiness, scroll-technique, one-shot-lock, now this
  deadlock) - each one real and evidence-driven, but per the same standing caveat as v7.21: if this
  is STILL not enough, stop patching this function and reconsider the architecture (e.g. network-
  idle-based triggering, or reading the page's own "N results" text as an authoritative target
  count) rather than attempting a sixth narrow patch.

## v7.24 — user confirmed live: unclassified capture is now 100%. The correctness thread (v7.13-v7.23)
  is closed. Remaining report is purely cosmetic: the visible scroll sweep - especially the
  guaranteed second pass added in v7.23, which usually finds nothing new left to load and so stops
  after only a partial scroll before snapping back - reads as jarring/broken ("goes for the 2nd
  trip and from the half trip either it returns back or stops at the half trip path") even though
  it's working correctly underneath. This is the invisible-scrolling idea raised earlier in this
  thread and deliberately deferred until correctness was solid - it now is. Fades the list
  container to opacity 0 for the duration of every pass (not just the guaranteed second one -
  there's no reason the first pass needs to be visible either) instead of hiding it outright:
  opacity doesn't remove the element from layout or affect getBoundingClientRect(), so
  IntersectionObserver-based lazy-loading (which the whole feature depends on, and which only ever
  looks at geometry, never paint/opacity) keeps working exactly as before - unlike visibility:hidden
  or display:none, which the original discussion flagged as a real risk of breaking the lazy-load
  trigger itself. transition is forced to 'none' so the hide/reveal itself is instant, not an
  animated dim. Revealed only after settleScrollRestore() (v7.22) confirms scrollTop has actually
  landed back at the real original position, so the user only ever sees the list in its correct,
  settled state - never mid-sweep or mid-restore. New test captures the container's opacity during
  an actual poll inside the pass (not just before/after) to prove the hide was in force for the
  real duration, and confirms it's revealed again once fully settled. Verified by reverting the
  restore step and confirming the reveal assertion then fails (opacity stays '0' forever), then
  restoring the fix. 89 total. DEBUG flipped back to false - the thread it was reactivated for
  (v7.16) is now closed; logging code left in place for the next investigation, per usual practice.

## v7.25 — user confirmed v7.24's invisible scrolling works, but spotted the remaining seam precisely:
  on navigating to a new page the panel is hidden while sweep 1 runs, then "for the instance/
  milli-second I see left side panel and then again it goes invisible" before the second pass. Root
  cause, confirmed in the code rather than guessed: v7.21/v7.23 had put the retry loop in runCycle,
  so each retry was a SEPARATE call to forceRenderAllVisibleCards() - and v7.24's hide/reveal is
  scoped to one call, so every pass boundary necessarily revealed the list for however long it took
  runCycle to fire again. Papering over that (deferring the reveal, guessing whether another pass is
  coming) would have meant coupling the reveal to scheduling state; the actual fix is that the retry
  loop never belonged in runCycle to begin with. Moved it inside forceRenderAllVisibleCards():
  extracted the single sweep into runOneRenderSweep() and now loop it there, up to
  FORCE_RENDER_MAX_SWEEPS, stopping once a sweep past FORCE_RENDER_GUARANTEED_SWEEPS turns up no new
  cards. One hide, N sweeps, one reveal - the flicker is structurally impossible now rather than
  merely tuned away. Two further wins fall out of it: (1) consecutive sweeps no longer restore the
  user's scroll position in between, and parking back at the top between attempts is exactly what
  killed the lazy-load stimulus and caused the v7.23 deadlock - so that whole bug class is gone,
  not just fixed; (2) runCycle's trigger collapses back to the plain "new list? sweep it" check it
  was before v7.21, and forcedPassesForCurrentSignature/lastForcedCardCount are deleted outright.
  Also bails out mid-loop if the user navigates to a different list. Constants renamed to match
  their new meaning (FORCE_RENDER_MAX_PASSES_PER_SIGNATURE/FORCE_RENDER_GUARANTEED_PASSES ->
  FORCE_RENDER_MAX_SWEEPS/FORCE_RENDER_GUARANTEED_SWEEPS - they count sweeps within one invocation
  now, not invocations). Tests: the runCycle suite is rewritten down to the four cases the simpler
  trigger actually has, and the multi-sweep behavior moves into the forceRender suite (runs exactly
  the guaranteed sweeps when nothing new appears; keeps sweeping to the hard cap while a list is
  still growing; stays hidden across every observation of the whole multi-sweep run). Both halves
  sanity-checked by revert: forcing a single sweep per invocation fails the three sweep-count
  assertions, and injecting a reveal between sweeps fails all three opacity assertions - so the
  exact reported flicker is now pinned by a test, not just fixed. 91 total.

## v7.26 — user asked how to handle company sizes drifting over time (a startup at 201-500 today can
  be 501-1,000 a year later) and whether the ~412-company cache should get re-verified periodically.
  First two parts of a three-part plan (part 3, a bounded active re-verify sweep for stale entries,
  comes after these two are confirmed live). Found the actual gap by reading the code rather than
  assuming: both captureCompanyPageIfPresent() and captureFromJobDetailPane() had
  `|| companyCache[normalizedName]) return` guards — meaning visiting a company's own real page, or
  opening a job for a company you already have cached, taught the script nothing, no matter how
  obviously live and authoritative the page in front of you was. Fixed both: an already-cached
  company is no longer skipped, just handled differently from a new one — if the freshly-read value
  differs, the cache is updated (source/timestamp both refreshed via recordCacheMeta, which
  naturally upgrades a lower-trust source like an old auto-fetch guess to this live confirmation);
  if it's unchanged, the value is left alone but the timestamp still moves, since "re-confirmed
  today, still X" is exactly what "last verified" should mean, not just "whenever it first got
  cached." A MANUAL_EDIT entry is the one deliberate exception - never touched either way, since
  it's an explicit human decision that might be based on knowledge outside what LinkedIn currently
  shows. captureFromJobDetailPane() needed one extra piece: unlike the company-page path (already
  gated to once-per-URL by lastCapturedPath), nothing previously stopped it from re-scanning the
  pane on every single runCycle tick (~1s) for as long a job stayed open once cached companies
  stopped being skipped - added reverifiedDetailJobId, careful to only latch AFTER a successful
  read so the pre-existing "keep retrying every tick while the pane hasn't rendered yet" behavior
  for a genuinely new company is untouched. Also added summarizeCacheFreshness() /
  formatCacheFreshnessSummary(), a "Last verified" line in the cache manager next to the existing
  "Sources" provenance line - built entirely from companyCacheMeta.timestamp, which has been
  tracked since v7.8, so this needed no new data collection, only a new way to look at data already
  being recorded. captureCompanyPageIfPresent() and captureFromJobDetailPane() had never had
  permanent-suite coverage at all before this (their v7.8 provenance wiring was only ever checked
  ad hoc) - both fully covered now alongside the new freshness-summary tests. 35 new assertions
  across four suites, verified via the usual revert-and-confirm-it-fails pattern on both capture
  functions' re-verify logic. 126 total.

## v7.27 — user flagged a real flaw before point 3 (the re-verify sweep) gets built: it only ever
  reaches companies with a known slug, but captureFromJobDetailPane() (clicking a job) never
  records one - confirmed with clean, isolated test data ("honeywell technologies", resolved via
  Auto-Fetch, got a slug; "altudo", resolved by manually clicking its job, didn't). getCardInfo()
  already has a proven technique for this (grab the list card's own `a[href*="/company/"]`) - but
  captureFromJobDetailPane() already calls getCardInfo() on the matching list card while
  identifying the company, so altudo having no slug means its OWN list card had no such href either
  (the same "different layout, no `<a>` at all" gap this file already knows LinkedIn ships - v7.5's
  componentkey layout). The detail pane is separate DOM from the list card, so it may expose its
  own company link even when the list card doesn't - but rather than guess a selector for markup
  not yet seen live (this file's whole history is what happens when that's skipped), added
  debugFindCompanyLinksInDetailPane(): a pure read-only diagnostic, writes nothing, that reports
  every /company/ link found in the detail pane's document, plus specifically whether one sits
  inside either of the two regions already proven reliable for this exact pane (the inline-info
  spans' area, the "About the company" section - both already trusted for size extraction).
  Logged only for companies that don't already have a slug, so the console stays focused on the
  cases that matter. DEBUG flipped back on for this investigation. No permanent test suite entry -
  matches this file's own precedent (debugDumpAncestorChain from the force-render investigation
  was never given one either) since this is explicitly throwaway code, removed once the real fix
  ships; smoke-tested directly instead (empty DOM -> no crash, a link near the inline-info span ->
  found and reported correctly). Next: user re-tests a slug-less company live with console open,
  reports back what's actually in the detail pane, then the real fix gets built from that evidence.

## v7.28 — the v7.27 diagnostic paid off immediately: live console output for "tech mahindra" showed
  the detail pane's document DOES expose its own /company/tech-mahindra link, independent of the
  list card's - AND surfaced two distinct kinds of real noise in the same capture. One document
  returned by getSearchDocuments() rendered an unrelated "recommended jobs" sidebar carrying SIX
  other companies' real /company/ links (Google, Amazon, Deloitte, JPMorganChase, EY, Tata
  Consultancy Services) - a blind first-match search would have grabbed the wrong company entirely.
  Even within the correct document, an unrelated messaging/admin widget link
  (.../company/15123156/admin/inbox) matched the same href pattern but was a bare numeric ID, not a
  real slug. Both kinds of noise were correctly excluded by scoping the search to the same two
  regions already proven reliable for size extraction (the inline-info spans' area, the "About the
  company" section) - candidates from both regions agreed on "tech-mahindra" with zero false
  positives. Replaced the diagnostic with extractCompanySlugFromDetailPane(), built directly from
  this evidence: walk the inline-info span's ancestor chain for a /company/ link, fall back to the
  about-company section, reject anything purely numeric as a cheap extra safeguard against the
  admin-link shape even if scoping alone doesn't catch it elsewhere. Wired into
  captureFromJobDetailPane(): only attempted when no slug is on file yet (a slug essentially never
  changes once known, so there's nothing to re-verify the way size needs). New tests reproduce both
  exact noise shapes seen live (the six-company sidebar, the numeric admin link) rather than
  hypothetical ones, plus the legitimate-discovery paths and multi-document iteration order.
  Verified by revert: removing the numeric-rejection check fails exactly the one test built for it;
  reverting to an unscoped document-wide search breaks the legitimate-discovery tests, confirming
  they depend on the real scoped implementation rather than passing vacuously. DEBUG flipped back
  off - the investigation it was reactivated for (v7.27) is resolved. 139 total. Point 3 (the
  re-verify sweep) can now reach any company resolved via either passive-capture path, not just
  Auto-Fetch and direct company-page visits.

## v7.29 — user reported live: visiting https://www.linkedin.com/company/victoria's-secret/ stored the
  slug as just "victoria" - truncated at the apostrophe. Root cause: every slug-parsing regex in
  this file used an allowlist of "safe" characters ([a-zA-Z0-9_-]) that didn't anticipate a real
  slug containing an apostrophe - the same class of mistake this file has already been burned by
  elsewhere (guessing what's valid instead of matching structurally, e.g. CARD_CONTAINER_SELECTORS/
  BADGE_HEADER_SELECTORS's history). Found by grepping for the same pattern rather than only fixing
  the one call site reported: it was in FOUR places - getCardInfo() (list card, pre-dates this
  whole investigation, silently truncating since whenever that optimization was first added),
  captureCompanyPageIfPresent() (parsing the current page's own URL), the new v7.28
  extractCompanySlugFromDetailPane(), and extractSlugFromSearchHtml() (the search-fallback engine).
  Fixed the three that parse a real, structured URL (.href/.pathname from an actual DOM/location
  object) by matching up to the next /, ?, or # instead of an allowlist - correct for ANY slug
  content by construction, not an approximation of one. extractSlugFromSearchHtml() got a narrower
  fix (just added the apostrophe to its existing allowlist) since it parses unstructured
  search-result text/HTML rather than a real URL - a fully-negated class there risks swallowing a
  surrounding quote or tag boundary in raw markup. New tests reproduce the exact reported case
  (victoria's-secret) at all four sites, plus first-ever permanent coverage for getCardInfo()'s
  slug extraction and extractSlugFromSearchHtml() (neither had any before). Verified by revert:
  restoring the old allowlist at all four sites fails exactly the four apostrophe-specific
  assertions, nothing else. 151 total.
  Also: an ALREADY-stored bad slug (e.g. from before this fix) won't self-correct - slugCache only
  ever fills in a MISSING entry, by design (a slug essentially never changes once known, so nothing
  re-verifies it the way size does), and Import's merge never overwrites an existing entry either.
  A pre-existing bad value needs a one-time manual clear via localStorage
  (key: linkedin_slug_cache_v1) so it can be freshly re-derived on the next visit/click.

## v7.30 — the re-verify sweep, point 3 of a three-part plan discussed at length before building
  anything (points 1-2 shipped in v7.26; this was deliberately sequenced after both were confirmed
  live). Design settled through several rounds of back-and-forth:
  - Threshold: "older than 6 months" or "older than 1 year" (default), selected from a dropdown -
    a "re-verify everything, even stuff confirmed today" option was deliberately left out, since
    there's nothing to gain from re-checking something just confirmed.
  - Eligibility: known slug required (goes straight to the confirmed page, never guesses - stays a
    pure verification feature, none of Auto-Fetch's candidate-guessing ambiguity risk), MANUAL_EDIT
    entries never touched, no-timestamp-at-all entries (pre-v7.8) always eligible immediately.
  - No separate cooldown/lockout mechanism on the sweep itself - user's own design, better than an
    earlier flat "wait N days between sweeps" idea: re-verifying an entry resets ITS OWN timestamp,
    so it can't come up again for a full threshold period no matter how often this runs. The
    eligibility check IS the throttle; clicking it daily just means most days find 0 companies due.
  - One click processes the WHOLE eligible batch (not a small N requiring repeated clicks) - mirrors
    Auto-Fetch's own proven pattern exactly, reusing its sequential-with-delay pacing and adaptive
    429/503 backoff rather than a separate implementation.
  - Saves incrementally per company, confirmed by reading Auto-Fetch's actual code first rather
    than assuming - closing the tab mid-run keeps whatever already finished.
  - Shows a rough time estimate AND how many more companies are due-but-unreachable (no slug yet)
    before asking to confirm, so the batch size is never silently smaller than expected.
  New CACHE_SOURCE.REVERIFY_SWEEP - distinct from AUTO_FETCH_SLUG_CACHE even though the request
  shape is identical, since this is a genuinely different event (a scheduled re-check, not an
  initial classification) and this file has always kept provenance precise enough to answer "how
  did I actually learn this."
  A 404 on an already-known slug evicts the stale slug (same as Auto-Fetch's tier 1) but leaves the
  cached SIZE value untouched - a fetch failure isn't evidence the last known value is wrong, so a
  transient error can't destroy previously-good data.
  Refuses to run alongside Auto-Fetch (separate flags, separate button, but a mutual-exclusion
  check) - both make sequential anonymous requests off the same connection, and running both at
  once would double the effective request rate this whole file has been built around avoiding.
  Placed in the main panel as a persistent sibling to the Auto-Fetch button, not inside the cache
  manager modal - the modal can be closed mid-run (e.g. after Save/Close), which would detach the
  button's DOM reference and silently break Cancel; the main panel never closes for the run's
  duration, matching Auto-Fetch's own already-proven-reliable placement.
  27 new tests across two suites (eligibility/ETA logic extracted and tested directly; the sweep
  itself mocked in the same style as the existing autoFetchUnclassifiedCompanies suite, reusing the
  real backoff constants and isRateLimitSignal rather than hand-copying them). Verified by revert:
  removing the MANUAL_EDIT/no-slug guards fails exactly the four tests built for them; making the
  404 handler also clear the cached size fails exactly the one test built for that. 178 total.

## v7.31 — user testing v7.30 surfaced real, useful signal (traced from three exported backups rather
  than guessed): a company genuinely missing a slug (deloitte - real pre-existing data, never
  artificially set) correctly excluded itself and got counted separately, exactly as designed;
  millennium/juniper square correctly picked up under a lower threshold once linedata/cisco had
  already been consumed by an earlier run - the feature was working, the test sequencing (two
  thresholds clicked back to back, console setup script re-run mid-sequence) just made two
  DIFFERENT "2 companies" results look like the same one. Also: my own earlier ETA test explanation
  was wrong - I'd set THREE not-yet-due companies in one script and then claimed the wrong one
  would be reported as "next", forgetting the other two were closer. No code changes needed for
  either - both were testing-methodology issues, confirmed by reading the actual exported data
  rather than assuming a bug existed. One real UI change did come out of this: the threshold
  select + button, reported as visually inconsistent with the panel's other uniformly-styled
  full-width buttons (a bare browser-default `<select>` crammed into a row). Restructured to match
  the panel's own established rhythm - a labeled, consistently-styled full-width select stacked
  above a full-width button, same as every other control here, instead of a cramped side-by-side
  row. Also clarified for the user (not a code change): makeAnonymousRequest() uses
  GM_xmlhttpRequest specifically for true cookie-free anonymity, which routes through the
  extension's own context and is invisible in the page's DevTools Network tab by design - the
  status line and before/after timestamp changes are the correct way to confirm a request
  happened, not the Network tab.

## v7.32 — user raised a real gap in v7.30/v7.31's design: nothing stopped triggering a brand-new
  Auto-Fetch/Re-verify run at full baseline speed the instant the previous one finished, e.g.
  clicking Auto-Fetch, moving to the next page, and clicking again immediately with no pause -
  repeated indefinitely across many pages. Confirmed by reading the code rather than assuming: the
  adaptive backoff state (candidateDelayMs/companyDelayMs/consecutiveRateLimitHits) is declared
  fresh with `let` inside EACH call to autoFetchUnclassifiedCompanies()/reverifyStaleCompanies() -
  a run that had just backed all the way off from repeated 429s had no way to tell the next run,
  seconds later on a different page, that anything had happened at all. Design settled through
  several rounds of discussion before building: (1) the cooldown must be measured from the END of
  a run (last request's completion), not from when it was triggered - a start-based timer would
  already be expired before a long run even finished, weakest exactly when a run was heaviest: (2)
  it must count a cancelled run the same as a finished one, since by the time a click can land on
  Cancel, at least one real request has already gone out (cancelFetchRequested/
  cancelReverifyRequested are only checked at the TOP of each loop iteration, after the previous
  request's await has already resolved) - a cancelled run isn't a zero-footprint run; (3) it must
  be shared between Auto-Fetch and Re-verify, not tracked per-feature, for the same reason they're
  already mutually exclusive (both make anonymous requests off the same connection) - otherwise
  finishing one and immediately starting the other at full speed would defeat the whole point; (4)
  rather than one flat number for every outcome, it scales by what the run actually observed
  (RUN_COOLDOWN_TIER_MULTIPLIER: clean=1x, saw-some-rate-limiting-but-recovered=2x,
  fully-auto-stopped-from-MAX_CONSECUTIVE_RATE_LIMITS=4x) - using registerRequestOutcome-equivalent
  tracking that both functions already compute live (sawAnyRateLimitThisRun, new; rateLimitedStop,
  already existed) rather than discarding that signal once the run ends. Implemented as
  getRunCooldownRemainingMs()/recordAnonymousRunFinished()/formatRunCooldownMessage(), guarding the
  top of both functions (after their existing re-entrancy/mutual-exclusion checks, before any real
  work starts) and called once at the end of both regardless of how they exited (finished,
  cancelled, or rate-limit auto-stopped alike). lastAnonymousRunState persists to localStorage (not
  just an in-memory variable), so it survives a page reload or a fresh tab, not only continuous
  browsing within one page's lifetime. Base cooldown length (2/5/10 minutes, 5 default) is
  user-configurable via a new dropdown in the main panel, styled consistently with the rest of the
  panel's controls. Building this surfaced a second, related gap while reading the mutual-exclusion
  code closely: reverifyStaleCompanies() already refused to start while Auto-Fetch was running, but
  autoFetchUnclassifiedCompanies() never checked the reverse - Auto-Fetch could be started while a
  re-verify sweep was already mid-run, silently doubling the anonymous request rate the whole
  mutual-exclusion mechanism exists to prevent. Fixed to be symmetric. 25 new assertions: a pure
  logic suite pins the exact multiplier math (1x/2x/4x) and message formatting (rounds up to whole
  minutes, tier-appropriate explanation text) directly; the existing Auto-Fetch and Re-verify mocked
  suites are extended to verify the guards actually block/allow a real run at the right times and
  that the correct tier gets recorded for a clean run, a recovered rate-limit, and a full
  auto-stop. Verified by revert: zeroing out the tier multipliers fails exactly the two math tests
  built for them; removing the new symmetric guard fails exactly the four tests built for it (two
  guard tests plus two that had a design flaw of their own, described below); making the
  end-of-run stamp skip cancelled runs fails exactly the one test built for that. That revert check
  also caught a real mistake in two of my own new tests before they shipped: they used a company
  with no slug on file, so "zero requests were made" passed trivially (there was nothing to request
  regardless of whether either guard existed) rather than actually proving the guard fired - caught
  by getting FEWER failures than expected on the first revert pass, not more; fixed by giving that
  company a real slug so a request genuinely would have fired had the guard not stopped it, then
  re-confirmed the same revert now fails exactly those two tests too. 203 total.

## v7.33 — user reported live (three screenshots): the job-detail company badge shows correctly on the
  "recommended" collections layout (/jobs/collections/recommended/) but not on regular
  /jobs/search/ result pages, across two different companies/searches on that layout. This is the
  same class of gap as v7.1-v7.3 (a working selector on one LinkedIn build, absent on another) -
  but unlike a screenshot alone can settle, there are two structurally different possible causes:
  (a) scanCompanyInlineInfo() finds no size/count text at all on this layout, which would ALSO
  silently break captureFromJobDetailPane()'s caching/re-verify there, not just the cosmetic badge
  - a much bigger deal than it looks; or (b) the text IS found fine but findBadgeHeader() can't
  locate a header element to attach to - purely cosmetic, same shape as the v7.1-v7.3 saga on a
  different layout. Rather than guess a selector blind a fourth time on this exact feature, added
  dbgBadgeOnce() to syncCompanyBadge() - reports, once per job id (not every ~1s poll, so a page
  that's still rendering doesn't spam identical "not found yet" lines), which of the two branches
  is actually happening: whether scanCompanyInlineInfo found anything at all, and independently,
  whether findBadgeHeader found a header and via which selector. DEBUG flipped back on for this
  investigation (off since v7.27). No behavior change and no permanent test entry for the
  diagnostic itself, matching this file's own precedent for throwaway investigation code (e.g.
  v7.27's debugFindCompanyLinksInDetailPane) - existing 203 assertions unaffected, syncCompanyBadge
  was never itself under direct test (only stubbed as a no-op dependency elsewhere). Next: user
  re-tests on a regular /jobs/search/ page with console open, reports the `[badge]` line back, then
  the real fix gets built from that evidence.

## v7.34 — the v7.33 diagnostic paid off immediately: live console output for a Flexiple job showed
  text:true (sizeText="51-200 employees", countText="80 on LinkedIn" - scanCompanyInlineInfo working
  correctly) AND header:true, selector="a[href*=\"/company/\"]" (the v7.3 last-resort fallback) - yet
  no badge was visible next to "Flexiple" in the detail pane. That combination only makes sense one
  way: findBadgeHeader() genuinely found AN element via that selector, just not the right one -
  confirmed by reading the code, not guessed: on a page where all five named selectors miss (yet
  another LinkedIn layout variant, same class of gap as v7.1-v7.3 on a different one), the fallback
  was `doc.querySelector('a[href*="/company/"]')` - completely UNSCOPED, searching the whole
  document. A page showing a job list alongside the detail pane has one such link per list card
  (getCardInfo() already relies on exactly that fact elsewhere in this file), and those sit earlier
  in document order than the detail pane itself - the fallback was very likely grabbing the wrong
  company's link, or a decoy elsewhere on the page, not the current job's own. Root cause resolved:
  case (b) from v7.33's two-branch question (cosmetic-only), not case (a) - captureFromJobDetailPane
  was never actually affected, only the badge's own header lookup.
  Fixed by reusing this file's own existing solution to the identical "which /company/ link is
  really THIS job's own, not some other one on the page" problem: extractCompanySlugFromDetailPane()
  (v7.28) already solved this exact question for slug extraction, scoped to the same two regions
  already trusted for size extraction (the inline-info span's ancestor chain, the about-company
  section). Factored its region-scoping logic out into a new shared findScopedCompanyLink(doc) -
  used by both extractCompanySlugFromDetailPane() (behavior unchanged) and findBadgeHeader()'s new
  fallback - rather than hand-writing a second, independent copy of the same scoping and risking it
  silently drifting from the first (the exact class of mistake v7.0's scanCompanyInlineInfo()
  extraction was already built to avoid). BADGE_HEADER_SELECTORS' generic 'a[href*="/company/"]'
  entry removed; findBadgeHeader() now tries the five named selectors first (unchanged, document-
  wide - those class names aren't known to appear in list cards), then falls back to
  findScopedCompanyLink() only once all five have missed.
  The v7.33 diagnostic (dbgBadgeOnce, badgeDebugLastSignature) removed now that it did its job -
  same as v7.27's debugFindCompanyLinksInDetailPane, throwaway code once the real fix ships. DEBUG
  flipped back off.
  6 new assertions: reproduces the exact reported live shape directly (all named selectors miss, a
  decoy /company/ link exists elsewhere in the document - e.g. a list card's own link - and must
  never be used as the header), plus the legitimate scoped-discovery paths (inline-info span
  ancestor chain, about-company section fallback) and the trusted-region link winning even when an
  unscoped decoy also exists on the same page. extractCompanySlugFromDetailPane()'s existing suite
  extended to extract the newly-shared findScopedCompanyLink() for real instead of relying on its
  logic being inlined, so it keeps exercising the real region-scoping code end to end. Verified by
  revert: restoring the old unscoped 'a[href*="/company/"]' entry to BADGE_HEADER_SELECTORS and the
  old document-wide-only findBadgeHeader() fails exactly the five new findBadgeHeader tests, nothing
  else - the sixth ("nothing found anywhere -> null") still passes under both old and new code, as
  expected, since neither version invents an answer when there's genuinely nothing to find. 209
  total.
## v7.35 — reviewed 10 other LinkedIn job-search userscripts from Greasy Fork at the user's request
  (read in full from their raw sources, not the rendered page) and implemented the five ideas worth
  taking. One of them turned out to be a real, pre-existing bug in THIS script rather than an
  enhancement:
  - Multi-tab data loss (the actual bug). saveCache/saveSlugCache/saveCacheMeta were each a blind
    `localStorage.setItem(KEY, JSON.stringify(inMemoryMap))`. Every tab loads these maps once at page
    start and never re-reads them, so with two LinkedIn tabs open - entirely normal, and passive
    capture writes in EVERY one of them on every job click - whichever tab saved last silently
    erased everything the other had learned since. This is the same mechanism behind the "my
    localStorage edit got reverted" behaviour hit twice while debugging a bad slug by hand earlier;
    it was diagnosed correctly at the time as an in-memory-vs-stored race but only ever worked
    around manually, never fixed. Technique taken from LinkedIn Jobs Curator's saveAppliedLog():
    re-read what's on disk immediately before writing, fold in what's missing, write the union.
    Two details the naive version gets wrong, both handled: (1) deliberate deletions - a slug
    evicted by a definitive 404 would be instantly resurrected by the very next merge, making
    eviction a silent no-op, so those sites pass excludeName; (2) the cache manager's Save and Clear
    All are authoritative by intent (merge:false), since merging there would pull back exactly the
    entries the user just deleted. On a genuine value conflict the newer companyCacheMeta.timestamp
    wins - which is what provenance was for.
  - Company page overrides (slugOverrides + getSlugFor). Idea from Company Insights' COMPANY_MAPPINGS
    alias table. v7.29 already documented that a wrong stored slug "needs a one-time manual clear via
    localStorage" - that hole is now closed properly with an in-UI editor. Deliberately a separate
    map from slugCache rather than just making that one editable: slugCache is machine-managed
    (auto-filled, auto-evicted on 404), so a hand-typed correction stored there would be destroyed by
    the next failed fetch. Overrides always win, are never auto-touched, and ride through
    Export/Import (non-destructively, same rule as everything else - a local correction is never
    replaced by an incoming one). All five consumers now read getSlugFor() instead of slugCache
    directly, so one correction fixes Auto-Fetch, the sweep, and the eligibility/ETA/unreachable
    counts together.
  - Name-collision detection. Jobs Curator guards its company matching with word-boundary regexes so
    "Flex" can't match "Flexible". This file doesn't substring-match (lookups are exact on a
    normalized key), so the equivalent risk here is the normalization itself: two different companies
    collapsing onto one key, after which one's size is silently served for the other. Detected with
    data already being read - one key seen pointing at two different real LinkedIn slugs is two
    companies, not one - and surfaced in the cache manager. NOT auto-resolved: the script cannot know
    which company the cached size belongs to (a slug override is the fix), and renormalizing to make
    keys unique would orphan the entire existing cache in one go.
  - Movable/collapsible/persisted panel. Idea from Company Insights, including its off-screen guard.
    The panel had been pinned to a hardcoded top:130px/right:20px since v6.x, which lands underneath
    other extensions' fixed sidebars (visible in the user's own screenshots, behind Simplify's).
    Drag by the button; position, collapsed state and active tab persist. A saved position is only
    restored if it still fits the CURRENT viewport - a position saved on a wide monitor would
    otherwise strand the panel somewhere it could never be dragged back from on a laptop. Includes a
    2px slop threshold so a slightly-shaky click still toggles the menu instead of registering as a
    drag.
  - Tabbed panel (idea from LinkedIn Auto-Apply). The panel had grown to 8 checkboxes + 2 dropdowns
    + 4 buttons + 2 status lines in one column; now grouped as Filter / Fetch / Data. Purely
    re-parenting - every control and its wiring is byte-identical, only which container it's
    appended to changed.
  Also reviewed and deliberately NOT taken: 573788 (Ahmed Naukri) POSTs every job viewed - company,
  title, salary, JD text, and scraped recruiter names/emails/phones - to a Google Apps Script
  endpoint owned by its author; and two scripts @require remote libraries that execute with full
  script privileges. Neither pattern belongs here.
  30 new assertions across three suites: mergeStoredIntoMemory driven against a fake localStorage
  standing in for another tab's writes (adoption, both conflict directions, excludeName, malformed-
  value rejection, slug additivity); getSlugFor/recordSlugObservation (override precedence, the
  collision shape, and that re-observing a known collision doesn't re-persist on every cycle, since
  getCardInfo runs per-card per-pass); and resolvePanelPosition's viewport guard. Existing suites
  extended with the new collaborators, extracted for real rather than stubbed wherever the new
  behaviour is part of what they cover. Verified by revert, each independently: disabling the merge
  fails exactly the 6 merge tests; flipping getSlugFor's precedence fails exactly the 1 override
  test; disabling collision recording fails exactly its 3; removing the viewport bounds check fails
  exactly its 3 - nothing else in any case. Building these also caught a flaw in two of my own new
  tests before they shipped: they asserted on `mod.companyCacheMeta.google.source`, which THREW
  rather than failing cleanly under the revert, hiding the other failures behind a stack trace -
  fixed to fail as assertions. 239 total.

## v7.36 — user pushed back on v7.35's override editor, correctly: an empty JSON box gives no way to
  tell WHICH companies actually need one without exporting the cache and diffing companyCache
  against slugCache by hand. Added getCompaniesMissingSlug() (excludes MANUAL_EDIT entries on
  purpose - isReverifyEligible() skips those unconditionally regardless of slug, so adding one would
  unlock nothing) and a "Missing a page: N" line in the cache manager heading with a one-click "copy
  names" link, same clipboard pattern as the existing "Copy unclassified names" button, just scoped
  to "has a size but no known page" instead of "has no size at all". 5 new assertions (known-slug
  exclusion, override counts the same as an auto-discovered slug, MANUAL_EDIT exclusion, sort order,
  empty-cache safety). Verified by revert: removing the MANUAL_EDIT guard fails exactly the one test
  built for it, nothing else. 244 total.

## v7.37 — user asked directly, walking through a real override they'd just set ("ey" -> "ernstandyoung",
  correcting a wrong auto-discovered "ey-studio"): does an override actually win over slugCache
  everywhere, and is that the whole flow? Confirmed getSlugFor()'s precedence is correct and
  unconditional - but verifying it by actually running the real functions (not just reading them)
  surfaced a genuine bug in recordSlugObservation(), the v7.35 collision detector: it compared a new
  observation against raw slugCache[name] rather than the resolved getSlugFor(name). Once an
  override exists, every write site guards `if (!getSlugFor(name))` before touching slugCache, so
  that raw value is permanently frozen at whatever it was BEFORE the override - for "ey", forever
  "ey-studio". Comparing against it directly meant visiting the real, already-corrected company page
  again would keep re-flagging "ey" as a name conflict indefinitely, even though it was already fully
  resolved - confirmed live by actually executing recordSlugObservation('ey', 'ernstandyoung') against
  the real exported data before writing anything, not assumed.
  Fixed by comparing against getSlugFor(normalizedName) instead - agrees with what's actually being
  used (whether that's from an override or slugCache) -> not a collision; disagrees -> still flagged,
  since an override resolving ONE pairing doesn't mean the key can't ALSO be catching some other,
  unrelated company via a third slug. The recorded pair also now shows the RESOLVED value alongside
  the new one instead of the stale, permanently-unused slugCache value, so the cache manager's list
  reflects what's actually in effect. Two existing test suites (captureCompanyPageIfPresent, which
  calls recordSlugObservation directly) needed getSlugFor extracted for real alongside it - caught
  immediately by a ReferenceError on the first test run, not a silent gap.
  2 new assertions pin the exact reported shape (an observation matching the override is not flagged;
  a genuinely different third slug still is, and records the resolved value, not the stale one).
  Verified by revert: restoring the old raw-slugCache comparison fails exactly those two tests plus
  the "nothing gets recorded" companion assertion, nothing else. 248 total.

## v7.38 — user proposed the design directly, walking through exactly why the v7.35 override box was
  hard to use: to fix "ey"'s wrong slug they had to already know its exact normalized key by heart
  and separately go find the real LinkedIn slug themselves, with zero on-screen reference for either
  - a blank JSON box, no visibility into what was even being corrected. Proposed splitting slug
  management out of the size cache manager into its own view showing company name + current page
  together, so editing is "click the row, fix the value" instead of "recall the key, hand-type it
  blind."
  Agreed with the diagnosis and the split; changed one thing in the design before building: editing
  must still write through slugOverrides, never slugCache directly - slugCache stays machine
  territory (auto-filled, auto-evicted on a 404) specifically so an override is safe to leave in
  place indefinitely, and a table that "shows the current value, let's you edit it" could easily have
  blurred into editing slugCache itself if not built carefully.
  Discussed two implementation depths before starting: a cheap read-only table (browse only; clicking
  a row pre-fills the existing JSON box with that company's key already typed in) versus a fully
  inline-editable grid with search/filter, given the cache can run to 100-250+ rows once slug-only
  entries are counted. Agreed on the cheap version, explicitly deferring the inline-editable one
  until the cache size actually makes a plain scrollable list impractical - not a lesser version
  shipped by default, a scoped decision.
  Built openSlugManager(), reachable from a new "Manage Company Pages" button in the Data tab: one
  row per cached company (Company | current resolved page via getSlugFor() | source: override/auto/
  none), an "Edit" link per row that pre-fills the shared override JSON box (merging into whatever's
  already queued there, so several corrections can be typed before one Save), and the same
  slug-format validation the old inline editor had. Moved wholesale out of openCacheManager(): the
  "Company page overrides" toggle/textarea, the "Missing a page" count + copy-names link, and Name
  conflicts - none of those are about SIZES, all three are about which LinkedIn page a company
  resolves to, so all three belong in the new manager, not the size one. openCacheManager()'s heading
  now points to where they moved. Export/Import/Clear All stay exactly where they were - those
  already operate on the whole payload (companyCache + slugCache + companyCacheMeta + slugOverrides
  together via buildBackupPayload/mergeBackupIntoCache), splitting slug data out of the cache manager
  doesn't change what a backup contains.
  Added esc() (missing until now) for the row table's innerHTML - company names come from LinkedIn's
  own page text, not something this script controls, so interpolating one into markup needed real
  escaping rather than the trust every other UI construction function here can take for granted by
  using textContent/innerText instead.
  Neither openCacheManager() nor the new openSlugManager() have ever been under direct test (pure DOM
  construction, consistent with how every other UI-building function in this file is treated) - this
  was a structural move of existing, already-tested logic (the override validation, getSlugFor,
  getCompaniesMissingSlug, formatNameCollisionSummary) into a new container, not new logic needing
  new coverage for the move itself. 5 new assertions for esc() specifically (the one genuinely new
  function): the four HTML-special characters, plain text passing through unchanged, null/undefined
  both coercing to empty string rather than the literal text "null"/"undefined", and numeric input
  coercing to its string form. Verified by revert: a stub that skips the character replacement fails
  exactly the one test built for that, nothing else. 253 total.

## v7.39 — user reported live, having just used both new managers: after Auto-Fetch classifies a batch
  of companies, the size manager's textarea followed companyCache's raw insertion order, so the fresh
  batch landed at the very BOTTOM, requiring a scroll to the end to review it - while the slug
  manager's table sorted alphabetically, scattering that same batch across the list instead. Checking
  a run just meant scrolling one view and hunting the other.
  Fixed by giving both views ONE shared ordering instead of two different accidental ones: newest-
  touched first, built from companyCacheMeta.timestamp - data already tracked since v7.8, so this
  needed no new collection, only a different way to read what's already there. Deliberately "touched"
  rather than "first added": a company re-confirmed by the re-verify sweep or a passive revisit is
  exactly as relevant to review right now as a brand-new one, and the timestamp already means "last
  confirmed," not "first seen," so sorting by it does the right thing for both cases without needing
  to track them separately. An entry with no timestamp at all (pre-v7.8 data) sorts last, the same
  "oldest/unknown" treatment summarizeCacheFreshness() already gives it elsewhere.
  getCompanyNamesByRecency(cache, meta) factored out as one shared function rather than writing the
  sort twice and risking the two views drifting apart again (the exact reason they'd drifted into two
  DIFFERENT orderings in the first place, never having shared logic to begin with). Wired into both:
  openCacheManager's textarea is now built from a freshly-ordered copy of companyCache (rebuilt on
  every open AND after a successful Import, which previously reverted to raw insertion order until
  the manager was closed and reopened); openSlugManager's table replaced its `.sort()` alphabetical
  call with the same function. getCompaniesMissingSlug()'s clipboard list deliberately left
  alphabetical - it's copied out to paste elsewhere, not browsed in place, so recency ordering
  wouldn't change anything useful there.
  4 new assertions: newest-first ordering with distinct timestamps, an entry with no meta at all
  sorting last, an entry WITH meta but no numeric timestamp field getting the same "last" treatment
  as no meta (not crashing or sorting as if timestamp 0 meant something), and empty-cache safety.
  Verified by revert: replacing the real function with a plain alphabetical `.sort()` fails exactly
  the three ordering-dependent tests, not the empty-cache one - which is exactly right, since an
  empty list is trivially "sorted" under either implementation. 257 total.

## v7.40 — user asked what "getCompaniesMissingSlug()'s clipboard-copy list" in the previous explanation
  actually referred to - answering precisely (rather than describing it from memory) meant checking
  the live code, which surfaced a real regression: copyMissingSlugNames() (v7.36) used to be wired to
  a clickable "copy names" link, but the v7.38 move of the "Missing a page" row from openCacheManager
  into the new openSlugManager only carried over the plain count TEXT via an innerHTML string,
  silently dropping the actual link and its click handler. copyMissingSlugNames() has existed since
  v7.36 with nothing in the UI able to call it since v7.38 shipped - confirmed by grepping for every
  call site and finding none. Neither openCacheManager() nor openSlugManager() have ever been under
  direct test (pure DOM construction, this file's standing practice for every UI-building function),
  so nothing caught this beyond actually reading the live DOM output, which is exactly what answering
  the user's question required doing anyway.
  Fixed by rebuilding the row as a real DOM element (not more innerHTML) with the link and its
  addEventListener restored, same shape it had before the move - moved out of the heading's innerHTML
  block and appended as its own row, mirroring the original openCacheManager implementation exactly.
  No test suite changes: the underlying functions (copyMissingSlugNames, getCompaniesMissingSlug)
  were already covered and untouched - this was purely reconnecting an already-correct function to
  the DOM, verified by grep (the call site now exists) and manual confirmation it's the only thing
  that changed. 257 total, unchanged.

## v7.41 — user reported live, with a screenshot: "Missing a page: 1" at the top of Manage Company
  Pages, but two rows visibly showing "no page known" in the table directly below it (ethos,
  amazon web services aws). Root cause: getCompaniesMissingSlug() (v7.36) deliberately excluded
  MANUAL_EDIT-sourced companies from the count - reasonable in isolation, since isReverifyEligible()
  skips those regardless of slug, so a slug added for "ethos" wouldn't help the sweep reach it - but
  the table it sits above (built from the same companyCache keys) has no such filter and lists every
  company regardless of source. Two different definitions of "missing" in one view: the count
  answered "how many would help the re-verify sweep," the table answered "which companies have no
  page, period," and nothing reconciled them.
  User's own framing settled it: "i think it should show total number of companies to edit" - agreed,
  since the table is used for more than feeding the sweep (general data completeness), and a count
  that requires understanding a hidden business rule to reconcile with what's visibly on screen isn't
  doing its job. Reversed the exclusion: getCompaniesMissingSlug() now returns every companyCache key
  with no resolved page, full stop - matches the table exactly, no exceptions. The original reasoning
  about the sweep wasn't wrong, it was just answering a narrower question than what this view is
  actually for.
  Existing test inverted rather than just deleted: "a MANUAL_EDIT entry is excluded..." became "a
  MANUAL_EDIT entry with no page IS listed, matching the (unfiltered) table" - same scenario, opposite
  expected result, so the suite continues to pin the CURRENT intended behavior rather than losing
  coverage of this exact case. Verified by revert: restoring the old MANUAL_EDIT filter fails exactly
  that one inverted test, nothing else. 257 total, unchanged (a behavior reversal, not new logic).

## v7.42 — user asked a genuine follow-up to v7.41: now that a MANUAL_EDIT company can get a real page
  via an override, shouldn't it eventually re-verify too, the same as everything else? Agreed it's a
  valid case - the original "MANUAL_EDIT is permanently excluded, full stop" rule (v7.26/v7.30)
  correctly protects a deliberate human correction from being silently overwritten by an automated
  re-check, but once the user has ALSO supplied a real page for it, that protection has already done
  its job; the person had to consciously decide the value was worth protecting AND separately supply
  a page for it before this can ever matter.
  Checked something before agreeing to the direct version of the idea (an override unconditionally
  unlocking it): whether a MANUAL_EDIT company could get a slug through any path OTHER than a
  deliberate override. It can - getCardInfo() (the list-card scanner) has NO MANUAL_EDIT guard at
  all, unlike captureCompanyPageIfPresent()/captureFromJobDetailPane() which both return early for
  one - so a MANUAL_EDIT company can pick up an incidental slugCache entry just from its job card
  being scrolled past, zero deliberate action involved. Gating eligibility on getSlugFor() (override
  OR auto-discovered) rather than specifically on slugOverrides would have silently unlocked
  re-verify for entries the user never actually consented to touching again - exactly the kind of
  hidden-consent bug this feature exists to prevent in the first place.
  Fixed by gating specifically on slugOverrides: a MANUAL_EDIT entry stays locked unless an explicit
  override exists for it - adding one (looking up the real page, typing it into Manage Company Pages)
  IS the deliberate consent; an incidental slugCache entry is not. Factored into a shared
  isManualEditLockedOut(name), used by isReverifyEligible/getReverifyNextEtaMs/
  countReverifyMissingSlug - the same three-function duplication risk v7.41 had already been burned
  by once this session, not repeated a second time. On its first successful re-check, an unlocked
  entry's provenance naturally graduates from MANUAL_EDIT to REVERIFY_SWEEP via the existing
  recordCacheMeta() call (no special-casing needed for this) - it's no longer an unconfirmed manual
  correction, it's now independently confirmed data, and stops needing the lock-out check on every
  future cycle.
  9 new assertions: an unlocked (overridden) MANUAL_EDIT entry becomes an eligible candidate past
  threshold; the exact incidental-slug nuance (a slugCache entry with no override does NOT unlock,
  proven directly rather than assumed); a locked-out entry correctly stays out of "missing slug"
  too (getting a random slug wouldn't help it either, so counting it there would mislead); an
  unlocked-but-not-yet-due entry still contributes to the ETA like any normal candidate; and,
  end-to-end through the real sweep function (not just the eligibility check in isolation), an
  unlocked entry is actually requested, updated, and graduates its source tag. Verified by revert,
  twice over: removing the override check entirely fails the 4 tests that depend on unlocking
  actually working; gating on getSlugFor() instead of slugOverrides specifically fails a different 4,
  including the original "MANUAL_EDIT is never eligible" baseline test from v7.30 - confirming the
  suite would have caught the exact hidden-consent mistake being guarded against, not just the
  feature's happy path. 263 total.

## v7.43 — stabilization pass before marking this version stable: a full line-by-line read of the whole
  file looking for existing defects rather than adding anything. One real, user-visible bug found and
  two latent failure modes closed. Also confirmed by static analysis that every function called in
  the file is actually defined (no dead call sites), and re-read the areas changed most recently
  (v7.35-v7.42) since those had the least soak time.
  - BUG (real, reproduced): a dragged panel snapped back to the top-left corner on every page load.
    Root cause: injectControlPanel() called setActiveTab() - which persists panel state - BEFORE
    appending the container to document.body. A detached element has no layout box, so its
    getBoundingClientRect() returns all zeros, and persistPanelState() faithfully wrote left:0,
    top:0 over the user's real saved position on every single load. Reproduced deterministically
    against the real resolvePanelPosition() before writing any fix (restore 900,400 -> persist 0,0 ->
    next load reads 0,0), rather than inferred from reading alone. Fixed at the root by attaching the
    container first and applying saved state afterwards, AND defensively by extracting
    computePanelPositionToPersist(), which refuses to write a position while the container is
    detached - so no future caller can reintroduce this by persisting at the wrong moment. Worth
    noting the guard ALONE would have masked the bug into "position never updates"; the ordering fix
    is what actually makes it correct, the guard is only the backstop.
  - HARDENING: forcingRenderInProgress was set true several statements BEFORE the try block, with
    style writes and the whole DEBUG diagnostic block in between. A throw in any of them would have
    left the flag stuck true and permanently disabled force-render for the rest of the session, with
    no recovery short of a reload. Moved the flag to immediately before the try, and moved the style
    writes + DEBUG block inside it. This matters more than the raw probability suggests: this file's
    history shows DEBUG gets flipped on for live investigations regularly (v6.10, v7.2, v7.4, v7.16,
    v7.27, v7.33), and that block calls into document.body.textContent, findAllScrollableAncestors
    and debugDumpAncestorChain - exactly the moment a throw would be least welcome.
  - HARDENING: the finally block awaited settleScrollRestore() as its FIRST statement, before
    restoring opacity. Since the container is faded to opacity 0 for the duration of a sweep, a throw
    there would skip every remaining line and leave the user's job list permanently invisible - the
    single worst failure this feature can produce. Now wrapped in its own try/catch that logs and
    falls through to the reveal regardless.
  Explicitly reviewed and deliberately NOT changed: saveFailedCache() still doesn't multi-tab-merge
  (failedCache is rebuildable cooldown state - losing an entry only means retrying a company sooner,
  unlike the caches v7.35 protects); captureFromJobDetailPane() still can't capture on a standalone
  /jobs/view/`<id>` page (it identifies the company via list cards, which don't exist there - a
  documented design tradeoff, and the badge itself still works on those pages); Clear All still
  leaves slugCache/slugOverrides/nameCollisions intact (it's scoped to sizes, as its confirm text
  says).
  4 new assertions on computePanelPositionToPersist (attached+moved persists the real rounded rect;
  detached+moved returns null so nothing is overwritten; never-moved returns explicit nulls so the
  panel keeps following the default corner on resize; never-moved+detached doesn't crash). Verified
  by revert: removing the isConnected guard fails exactly the one detached test, nothing else. The
  two hardening changes have no new tests - both are control-flow restructurings whose only
  observable effect is under a throw that can't be provoked through the existing mocked harness, so
  they're flagged here as hardening rather than claimed as tested behaviour. 267 total.

## v7.44 — moved this changelog out of the script into CHANGELOG.md. Reasoning: the header
  comment (Features + this Changelog) had grown to ~1,250 lines and ~40% of the file's total
  size — dead weight on every full-file read that doesn't need version history to answer a
  question about current behavior. The Features block above stays in the script: unlike the
  changelog, it carries load-bearing design rationale (the several "deliberately NOT changed"
  notes, tradeoffs considered and rejected) that's actually needed when reasoning about the
  code, not just a historical record. No functional code changed; only the header comment was
  split and the version bumped in its three usual places (header, @version, button label).

## v7.45 — two bugs reported live, both isolated to `/jobs/search-results/` (the route reached via
  notification/recommendation links) and absent on `/jobs/search/`:
  - FIX (double flicker on every job click): `getListSignature()` only ever excluded
    `currentJobId` from its "which list is this" comparison. `/jobs/search-results/` URLs also
    carry LinkedIn's own per-click tracking correlation params — `eBP`, `refId`, `trackingId`,
    `originToLandingJobPostings` — regenerated on every single job click, which used to register
    as "a different list" and re-trigger a full `forceRenderAllVisibleCards()` hide/reveal pass
    (the double flicker was two such passes back-to-back: the initial navigation, then LinkedIn
    settling the tracking params a moment later). Added all four to the exclusion set via a new
    `VOLATILE_TRACKING_PARAMS` list, and switched the implementation from regex-chaining to
    `URLSearchParams` (removing more than one param via chained regex replacement gets awkward
    fast once leftover `&`/`?` cleanup is involved).
  - FIX (badge landing at the bottom instead of beside the company name): on
    `/jobs/search-results/`, all five named `BADGE_HEADER_SELECTORS` miss (yet another LinkedIn
    top-card layout variant), so `findBadgeHeader()` fell straight through to
    `findScopedCompanyLink()` — whose two regions (the inline-info span, the "About the company"
    section) are BOTH intentionally scoped near the bottom of the pane, with nothing in between
    that actually targets the top card. Added `findTopCardCompanyLink()`: since the job title is
    reliably an `<h1>` (the same signal `captureCompanyPageIfPresent()` already trusts for
    company-page identity), it walks a bounded number of levels up from the `<h1>` — the same
    depth-limited-ancestor-walk technique `findScopedCompanyLink()` already uses from the
    inline-info span — looking for the job's own `/company/` link near its title. Tried after the
    named selectors but before the bottom-scoped fallback. This is a structural, class-name-
    independent guess (the same category of technique `findAboutCompanySection()` already uses by
    matching literal heading text instead of a class) rather than a confirmed fix — it wasn't
    possible to inspect the live `/jobs/search-results/` markup directly, so if the badge still
    lands wrong there, that's the next thing to report back on.
  7 new tests: 3 for `getListSignature` (same signature across job clicks despite `eBP`/`refId`/
  `trackingId`/`originToLandingJobPostings` all changing; a real filter/keyword change still
  produces a different signature), 4 for `findBadgeHeader`/`findTopCardCompanyLink` (an h1-scoped
  link is used and reported correctly; it wins priority over the bottom-scoped regions when both
  are present; no `<h1>` on the page doesn't crash). 274 total.

## v7.46 — the v7.45 flicker fix was reported live as incomplete: still flickering on
  `/jobs/search-results/`, but this time reproduced specifically on PAGINATION (page 1 -> page 2 ->
  back to page 1), not same-page job clicks.
  - FIX: `getListSignature()`'s v7.45 switch to `URLSearchParams` fixed WHICH query keys survive
    into the signature, but `.toString()` still serializes the surviving keys in whatever order
    they happened to appear in `location.search` — the old regex-based version had this exact same
    order-dependence (it only ever removed one param in place), so it was never actually fixed,
    just not yet exposed by a case that triggered it. If LinkedIn's client ever renders an
    optimistic URL during a transition and then settles into a final one with the same params in a
    different order, two identical lists would compare as different signatures purely from
    ordering. Added `params.sort()` before serializing, removing that whole class of risk
    regardless of whether reordering is confirmed as the exact live mechanism — two query strings
    with the same params, any order, now always produce the same signature.
  - DIAGNOSTIC: added a `DEBUG`-gated log at the exact point `runCycle()` decides to force-render
    (`from`/`to` signature strings), so if the flicker persists after this, the next report can
    come with real evidence (which param actually differed) instead of another guess.
  - Badge-placement bug (company size showing at the bottom "About the company" section instead of
    beside the name at the top) also reported still unresolved — the v7.45 `findTopCardCompanyLink()`
    h1-based guess didn't find anything live on the affected layout. Not re-guessed a third time
    (two structural attempts have now missed); a live diagnostic snippet was handed to the user
    instead, to get the actual top-card markup on that route before touching the code again.
  4 new tests: order-independence (same params, different order -> same signature); the exact three
  live-reported pagination URLs, confirming page 2 is still correctly treated as a different list
  from page 1 both ways (start=25 vs no-start, and vs start=0) — proving the sort fixes ordering
  without silently swallowing real navigation. Also fixed the `runCycle` force-render-trigger suite,
  which broke when the new `if (DEBUG) dbg(...)` line was added without `DEBUG`/`dbg` mocked in that
  suite's setup (same convention already used elsewhere in the file). 277 total.

## v7.47 — the v7.46 diagnostic log paid off: reported live with DEBUG on, the actual evidence showed
  `getListSignature()` flip-flopping between two values — "...start=25", then briefly no `start` at
  all, then back to "...start=25" — across two `runCycle()` calls from a single ORDINARY JOB CLICK on
  `/jobs/search-results/`, not a real pagination change. Neither v7.45 (volatile-param stripping) nor
  v7.46 (order-independence) could have caught this: the param wasn't renamed or reordered, it was
  genuinely, if briefly, absent — most likely an artifact of how LinkedIn's client reconciles the URL
  for the newly-selected job. Both edges of the flip differed from whatever `lastForcedListSignature`
  was at that instant, so the old instantaneous comparison fired `forceRenderAllVisibleCards()` on
  BOTH edges — the double flicker, now traced to its actual source instead of inferred.
  - FIX: a candidate signature must now stay unchanged across real elapsed time
    (`LIST_SIGNATURE_SETTLE_MS = 400`) before it's trusted as a genuine navigation — the same
    "don't act until it's stopped changing" idea `captureFromJobDetailPane()` already uses via
    `DETAIL_PANE_SETTLE_MS`. A transient value that flips back before the window elapses never gets
    the chance to fire; a value that genuinely persists (real pagination, a real filter change) still
    fires, just delayed by at most one settle window — negligible next to the sweep itself, which
    already takes 900ms-12s.
  - The badge-placement bug remains open: the `h1`-based fallback added in v7.45 was confirmed via a
    live diagnostic to find no `<h1>` at all on the affected `/jobs/search-results/` layout (`h1
    found: false`), so it never had a chance to run. A second diagnostic (scanning for
    `[class*="job-title"]`/`[class*="top-card"]`/`[role="heading"]`) was handed to the user to get
    real markup instead of guessing a third selector blind.
  9 new/replaced tests, rewritten with a fake clock so the settle window can be crossed
  deterministically: a fresh signature is NOT swept on first sight, nor a moment before the window
  elapses, but IS once it holds for the full window; the exact live-reported flip-flop (A -> B ->
  A, never settling) produces zero sweeps and leaves `lastForcedListSignature` untouched; a real,
  persistent pagination change is still caught, just after settling. 282 total.

## v7.48 — the badge-placement bug (company size still landing in the bottom "About the company"
  section instead of beside the name at the top, on `/jobs/search-results/`) was reported still
  broken after v7.45's `<h1>`-based fallback. Two live diagnostics settled why, definitively:
  `document.querySelector('h1')` returned `null` outright on the affected layout — no `<h1>`
  anywhere in the document — and a follow-up scan for ANY heading tag/`role="heading"` or any
  element with `"job-title"`/`"top-card"` in its class also came back completely empty. That
  layout's own headings carry hashed, auto-generated class names (e.g. `"_20e55808 b0593cae
  fdf81ae8 ..."`) instead of LinkedIn's usual `job-details-jobs-unified-top-card__*` BEM naming —
  a different frontend build for this flow, where no tag-name or class-name guess could ever have
  worked, not a selector needing a tweak.
  - FIX: dropped both class names and tag names as anchors. `findTopCardCompanyLink()` now scans
    every `/company/` link in the document in source order and returns the first one that is
    NEITHER inside a list card (`getCardElements()` already tracks those precisely — the same set
    `getCardInfo()` relies on) NOR inside the "About the company" section
    (`findAboutCompanySection()`, unchanged). Confirmed live on the WORKING layout that this
    ordering assumption holds: the top-card's own company-name element appears well before the
    about-company heading in document order. Excluding both regions explicitly (not just relying on
    ordering) means this can never coincide with the old wrong-position fallback even if some future
    layout breaks the ordering assumption.
  - The diagnostic selector string returned by `findBadgeHeader()` for this rung was also corrected
    — it still said "(top-card, near h1)" from the v7.45 approach even though h1 is no longer
    involved; now "(top-card, first non-list/non-about)".
  - DIAGNOSTIC: added a `DEBUG`-gated log, in `syncCompanyBadge()`, of which `findBadgeHeader()` rung
    actually fired — logged once per distinct selector (not once per tick) so a live report can name
    the exact rung instead of needing another round-trip diagnostic.
  Test suite reworked to match: the old `<h1>`-based mocks (`doc.querySelector('h1')`) are gone;
  `findTopCardCompanyLink` is now tested via a `querySelectorAll('a[href*="/company/"]')` mock with
  region-tagged links and `contains()`-based exclusion mocks for both list cards and the
  about-section, including order-independence (the about-section link excluded even when it
  appears FIRST in document order) and an integration check that it wins priority inside
  `findBadgeHeader()` itself. 285 total.

## v7.49 — both bugs fixed this week (v7.45-v7.48) were previously invisible: a fallback chain
  coming up empty, or a step throwing, produced nothing but a `console.error` line nobody was
  looking at — the user only ever found out by noticing a missing badge, days later. Requested
  directly, alongside three other stability items, after asking for an RCA on why two features
  broke in the same week and what could make that cheaper to catch next time.
  - ADDED: shared feature-health tracking (`setFeatureHealth()`/`featureHealth`) — a small, narrow
    status vocabulary (`ok` / `fallback` / `idle` / `failed`) that `syncCompanyBadge()` and
    `forceRenderAllVisibleCards()` now report into at every meaningful outcome, not just on
    failure. `badge` specifically distinguishes `ok` (a named `BADGE_HEADER_SELECTORS` match) from
    `fallback` (either of `findBadgeHeader()`'s two fallback rungs caught it) — `fallback` is
    exactly the state that silently preceded both incidents this week, so it's now a first-class,
    visible outcome rather than indistinguishable from `ok`. This is infrastructure only in this
    version — nothing reads `featureHealth` yet; the Data-tab status view and Diagnose report that
    consume it are v7.50/v7.51.
  - FIX (real bug, found while building this): `forceRenderAllVisibleCards()` is `async` with no
    internal `catch` (by design — its `finally` block must always run first to restore the list's
    opacity/scroll position). Called fire-and-forget from `runCycle()` with neither `await` nor
    `.catch()`, a throw inside its `try` became an unhandled promise rejection — invisible to
    `runCycle()`'s own try/catch, which had already returned by the time the rejection happened.
    Now chained with `.catch()`, which both records the failure and eliminates a real (if rare)
    unhandled-rejection gap that predates this version.
  - CHANGED: `runCycle()`'s five steps (panel, filtering, company capture, detail capture, badge)
    no longer share one try/catch. Previously a throw in an early step skipped every step after it
    for that cycle — recoverable a moment later since the next cycle starts over from the top, but
    still an unnecessary delay for features with no dependency on the one that failed. Each step
    now runs through a new `runFeature(id, fn)` wrapper that isolates its own throw and records it,
    without blocking siblings later in the same cycle. Order is unchanged — core filtering still
    runs ahead of the purely cosmetic badge.
  - Also introduced `SCRIPT_VERSION` as the one place the version string lives in executable code —
    previously duplicated by hand in `button.innerText` alone; a diagnostic report needing it too
    (v7.51) would have made that a third hand-synced copy.
  6 new tests: `forceRenderAllVisibleCards` reports `ok` once a pass completes; and — the direct
  proof of the fault-isolation fix — with filtering forced to throw, `runCycle()` still runs
  companyCapture and detailCapture afterward in the same cycle (would have stayed at 0 calls each
  under the old shared try/catch), the panel step before it is still recorded `ok`, and the
  failure is attributed to `filtering` specifically rather than swallowed. 291 total.

## v7.50 — the second of the four stability items requested alongside v7.49: a passive status view
  in the panel's Data tab, reading the `featureHealth` infrastructure v7.49 built but nothing yet
  consumed. Point is the same one made explicit at the time: a `fallback` state is exactly what
  silently preceded both incidents fixed the same week, so it should be something you can glance at
  and notice, not something that only shows up in a `DEBUG` log nobody has open.
  - ADDED: `buildFeatureHealthSummary()` / `renderFeatureHealthPanel()` — a small text block under a
    new "Feature health" divider at the bottom of the Data tab, rendered via the same
    `setTextIfChanged()` used by the existing Cached/Hidden/Unclassified counter. Deliberately
    narrow: only ever lists features currently `failed` or `fallback`; `ok`/`idle`/no-report-yet all
    collapse to one static "✅ Everything working normally" line. A feature that's simply never had
    a chance to run yet (page just loaded) reads identically to one running perfectly — neither is a
    problem, so neither should look like one.
  - Wired into `runCycle()` as the very last thing every cycle does, unconditionally and in its own
    try/catch — it must reflect whatever the five steps above it just reported, including from a
    step that threw, and a bug in the rendering itself must never be able to affect anything above
    it (it's the last line in the function either way, but the isolation is explicit, not incidental).
  7 new tests: a dedicated suite for `buildFeatureHealthSummary()` covering the "nothing to report
  yet", "all ok", "idle is not a problem", single-fallback, single-failure, detail-less-failure (no
  dangling empty parens), and multi-problem-ordered-by-FEATURE_HEALTH_IDS-not-insertion-order cases;
  plus one addition to the `runCycle` suite confirming the panel still renders on the cycle where a
  step threw. 299 total.

## v7.51 — the third of the four stability items requested alongside v7.49: a one-click diagnostic
  dump. The actual bottleneck across all of v7.45-v7.48 wasn't figuring out the fix — it was the
  round-trip cost of gathering evidence: open DevTools, paste a hand-written console snippet,
  screenshot the result, report back, wait for the next guess based on that. Every one of those
  snippets was reconstructing roughly the same facts (which selectors matched, what the document
  looked like, which `/company/` links existed and where) from scratch each time.
  - ADDED: `buildDiagnosticReport()` — a text report combining script version, current URL, list
    signature, and a generated timestamp; the full `featureHealth` state for every tracked feature
    (not just problems — this is the on-demand deep dump, unlike v7.50's passive summary which only
    ever shows what's currently flagged); and a structural probe repeated for every document
    `getSearchDocuments()` finds (top document plus any accessible iframe): heading counts, which of
    the five named `BADGE_HEADER_SELECTORS` matched and which didn't, whether an about-company
    section was found, every `/company/` link found (capped at 10 per document — already-public
    `/company/<slug>` URLs, not page content), and what `findTopCardCompanyLink()` actually resolves
    to. A selector that happens to be invalid in some odd document context is caught per-selector,
    same as the equivalent guard already used for the "N results" scan elsewhere — one bad selector
    reports as not-matched, it doesn't take down the rest of that document's section.
  - ADDED: a "🩺 Copy Diagnostics" button in the Data tab, right under the v7.50 status view —
    `copyDiagnosticReport()` copies the report to the clipboard via the same
    `navigator.clipboard.writeText()...catch(console.error)` pattern `copyUnclassifiedNames()`
    already uses, so a report can be pasted directly into a bug report instead of being manually
    reconstructed.
  - Deliberately structure-only, same stance the rest of this script already takes on not reading
    more than a feature needs: counts, booleans, and hrefs, never arbitrary page text.
  19 new tests covering the header fields, both branches of feature-health reporting (a feature with
  a real status vs. one with no report yet), per-document heading/selector/link reporting across a
  multi-document (iframe) scenario, the 10-link cap, a null top-card resolution reporting "none" (not
  a crash), and the invalid-selector guard leaving the rest of that document's section intact. 318
  total.

## v7.52 — the fourth and last of the stability items requested alongside v7.49-v7.51, and the one
  flagged at the time as the deeper structural lever: badge placement and force-render triggering
  (the two bugs fixed this same week) both broke because they depend on rendered HTML/CSS, which
  LinkedIn changes far more often than the JSON field names its own frontend depends on internally.
  Reading that JSON directly — the same Voyager/GraphQL API calls LinkedIn's own React app already
  makes for its own rendering — would sidestep this whole class of bug structurally, rather than
  patching each new layout variant as it's found.
  - ADDED, PHASE 1 ONLY: `installVoyagerObserver()` passively observes `fetch()` responses whose URL
    matches `/voyager/api/.*(job|company|organization)/i` and, only when `DEBUG` is on, logs their
    SHAPE — key names and value types via the new `summarizeJsonShape()`, depth-capped at 5 levels
    and 40 keys per object, arrays summarized from their first element only — never the actual
    values. Deliberately does not read or cache anything from these responses yet: nobody working on
    this project has ever seen a real one (no standing LinkedIn access to inspect them ahead of
    time — see this file's anonymous-only design elsewhere), so writing extraction logic now would
    mean guessing field names blind, the exact mistake already paid for once with DOM selectors
    (CHANGELOG.md v7.1-v7.48). Same evidence-first approach applies here: flip DEBUG on, browse
    normally, filter the console for "voyager:", and real field names become visible from what
    LinkedIn's own frontend actually reads. Extraction is phase 2, once that evidence exists.
  - Patches `unsafeWindow.fetch`, not `window.fetch` — Tampermonkey's default sandbox gives this
    script its own isolated `window`, which LinkedIn's own React/GraphQL client never touches;
    observing the page's real traffic needs the real page's `fetch`. Added `@grant unsafeWindow` for
    it, falling back to plain `window` if `unsafeWindow` isn't available in whatever userscript
    manager is running this. Only installed in the top frame (same guard as everything else in this
    file); a same-origin iframe would need its own patch to observe its own JS context's fetch calls
    — not done here, since it would reintroduce exactly the multi-frame complexity v6.11 deliberately
    removed, and phase 1 doesn't yet know whether it's even needed there. XHR is also not patched —
    if DEBUG logging shows nothing despite active browsing, that's itself evidence LinkedIn is using
    XHR for these specific calls, worth a fast, cheap, evidence-driven follow-up rather than guessed
    at preemptively.
  - The wrapper is an unconditional passthrough by construction: the real `fetch` always runs via
    `.apply(this, args)`, preserving its own `this` binding, and its exact return value goes straight
    back to the caller. Observation only ever reads a `.clone()` of the response, and every
    observation step is isolated in its own try/catch so a malformed response, an install-time
    failure, or anything else about this instrumentation can never affect, delay, or throw into the
    real request — this script's core filtering has zero dependency on any of this working.
  21 new tests: `summarizeJsonShape()`'s type-only reporting (including `null` vs `typeof null`'s
  well-known `"object"` quirk), first-element-only array summarization, and both caps (5 levels deep,
  40 keys wide); which object gets patched under both `unsafeWindow` availability branches; the
  passthrough guarantees (real fetch always called, exactly once, with `this`/arguments preserved,
  returning a real promise) independent of `DEBUG`; the `DEBUG`/URL-pattern gate in both directions
  (off entirely, and on but non-matching); a full observed-and-logged case asserting the reported
  shape contains no real values; and a malformed response body being skipped silently rather than
  logged or thrown. 339 total.

## v7.53 — reported live: `DEBUG` on, browsed multiple pages, clicked multiple jobs, filtered the
  console for `"voyager:"` — nothing appeared at all. That single result is consistent with at least
  three different causes, and there was no way to tell which from it alone: LinkedIn genuinely not
  using `fetch()` for these calls (already a documented possibility); `VOYAGER_URL_PATTERN`'s
  job/company/organization assumption not matching what LinkedIn's real GraphQL URLs look like; or
  this script's `@run-at document-end` patching `unsafeWindow.fetch` too late — if LinkedIn's own
  bundle already captured a direct reference to the native function before that point, a later
  property reassignment can't retroactively affect calls made through that already-captured
  reference. The third one would mean restructuring when this entire script starts running, not
  just the Voyager piece — too big a change to make on an unconfirmed guess, so this ships narrower,
  cheaper diagnostics first to find out which cause it actually is, same discipline that fixed both
  bugs earlier this week instead of guessing a second time.
  - ADDED: an unconditional install-confirmation log (`"voyager: observer installed, patched
    unsafeWindow.fetch"` or `"...window.fetch"`) the instant `installVoyagerObserver()` succeeds —
    the first line that should appear under a `"voyager:"` filter on page load, so "the patch never
    ran" now looks visibly different from "the patch ran but never saw matching traffic," which
    previously looked identical (nothing).
  - ADDED: a second, broader observation tier — `VOYAGER_ANY_URL_PATTERN` (`/\/voyager\/api\//i`,
    dropping the job/company/organization requirement entirely) logs method + URL for literally
    every `/voyager/api/` call, synchronously at call time, before the response even arrives. Kept
    deliberately cheap: no `.clone()`/`.text()`/`JSON.parse()`, just the URL already in hand — so if
    LinkedIn's real traffic doesn't look like what `VOYAGER_URL_PATTERN` assumed, this tier still
    reveals the real shape of things instead of showing nothing.
  - The existing narrow shape-dump tier (`VOYAGER_URL_PATTERN`, full response body parsed and
    summarized) is unchanged — still fires independently for its own subset of matches.
  Confirmed live in the report that prompted this: the badge/health features (v7.49-v7.51) are
  working correctly in production (a screenshot showed the badge rendering fine, and a Diagnose
  report showed a real `fallback` case being caught and handled exactly as designed) — this version
  is purely about getting better evidence for the still-open Voyager question, nothing else changed.
  12 new/updated tests: the install-confirmation log firing exactly once and only with `DEBUG` on;
  the broad tier catching a `/voyager/api/` URL the narrow tier correctly excludes; a URL with no
  `/voyager/api/` segment at all being invisible to both tiers; a matching URL being seen at BOTH
  tiers simultaneously (broad tier reporting method+URL, narrow tier reporting the full shape); and
  the broad tier still firing for a response whose body turns out unparseable, proving it never
  depends on the body at all. 345 total.

## v7.54 — the v7.53 diagnostics paid off immediately: reported live, the install-confirmation log
  fired every time (`installVoyagerObserver()` itself was never the problem), but not one
  `/voyager/api/` call — not even at the broad tier, which needs no URL pattern match beyond that
  substring — was ever seen across a full session of browsing multiple pages and clicking multiple
  jobs. That rules out "just an unlucky miss" and rules out the narrow-pattern-was-wrong hypothesis
  too (the broad tier would have caught anything). What's left: this script's `@run-at document-end`
  runs after LinkedIn's own app bundle has almost certainly already initialized and captured its own
  direct reference to `fetch` (`const f = window.fetch` or similar, a common bundler/GraphQL-client
  pattern) — every call made through that already-captured reference bypasses a property patch
  applied afterward, permanently, for the entire session, not just the first request. Consistent
  with the evidence: zero matches even after clicking through many jobs well after initial page load.
  - FIX: switched `@run-at` from `document-end` to `document-start` — the standard fix for exactly
    this class of problem (the same technique ad blockers and request interceptors generally rely
    on), so this script's fetch patch installs before the page's own scripts get a chance to run and
    capture anything.
  - document-start does NOT guarantee `document.body` exists yet, unlike document-end which always
    saw a fully-parsed document. The bottom "Scheduling" section (the top-level MutationObserver,
    iframe-observer polling, and the very first `runCycle()` call — the only place in the whole file
    that touches `document.body` at the top level) is now wrapped in `startScheduling()` and gated:
    runs immediately, synchronously, if `document.body` already exists (the same instant path
    document-end always took), otherwise deferred to a one-time `DOMContentLoaded` listener. No
    behavior change for the timing every page previously exercised — only earlier availability on
    pages where body genuinely isn't ready yet, which is the entire point.
  - `installVoyagerObserver()` needed no change — it was already the first executable statement
    after the top-of-file iframe guard (everything between them is definitions only), so moving
    `@run-at` earlier automatically moved it earlier too.
  Not independently unit-testable — this is entirely about top-level IIFE execution timing/ordering,
  which the extraction-based test harness (built to test individual function LOGIC, not real
  top-level script execution) has no way to exercise; verification is necessarily live, on the real
  page. All 345 existing tests still pass unchanged, confirming no extracted function's own logic
  was touched by this change.

## v7.55 — the v7.54 timing fix was confirmed working live: real `/voyager/api/` traffic was finally
  observed. But every call actually seen while clicking through jobs was `voyagerMessagingGraphQL`
  (background inbox polling) — never anything job- or company-related, not even once, despite the
  broad tier needing no pattern match beyond the URL containing that substring at all. That's
  evidence in its own right: job/company data for cards already in the list most likely isn't
  arriving via a live `fetch()` call per click. Consistent with another standing observation that
  had no explanation until now — the badge has always appeared instantly on click, with no visible
  loading gap. The likely explanation is that LinkedIn server-renders the initial job list (and
  probably the first job's detail) directly into the page's HTML — a common SSR-hydration pattern of
  embedding a JSON payload in a `<code>` or `<script type="application/json">` element that the
  page's own JS reads in-place instead of re-fetching.
  - ADDED: `scanEmbeddedJsonPayloads()` — scans `<code>` and `<script type="application/json">`
    elements for anything that parses as JSON and reports it as shape only via the existing
    `summarizeJsonShape()` (unchanged, reused as-is). No network patching, no `unsafeWindow`, no
    timing dependence at all — pure DOM read, the same category of technique this script has used
    everywhere else, unlike the Voyager observer's more invasive approach.
  - Wired into the existing Diagnose report (`buildDiagnosticReport()`) rather than a new console-log
    mechanism — reuses the already-built, already-tested on-demand tool from v7.51 instead of growing
    a second parallel diagnostic path. Reports the true count found per document, plus tag/id/shape
    for the first 5 (same cap-the-detail-not-the-count pattern already used for `/company/` links).
  8 new tests: zero candidates reporting cleanly; only genuinely-parseable JSON counted (a malformed
  `<code>` block and an unrelated `<script>` tag both correctly excluded from the count); tag+id
  reported for a real payload, and a payload with no `id` attribute rendering without a dangling
  `id=""`; the reported shape containing only types, never real values; and the 5-item detail cap
  applied on top of an accurate uncapped total count. 353 total.

## v7.56 — reported live: 16 real embedded JSON payloads found on `/jobs/search/` (zero on
  `/jobs/search-results/`, one more confirmation those two routes are genuinely different builds,
  consistent with everything else this file has learned about them). But the first 5 — the only ones
  the v7.55 cap showed — turned out to be an i18n message bundle, feature-flag entitlements, and
  profile data. Not what this feature needs, presumably sitting among the other 11, invisible at that
  cap. Separately, one of the visible ones (`datalet-bpr-guid-*`) revealed LinkedIn's own wrapper
  pattern: the element is real JSON, but its own `body` field is a JSON STRING holding the actual
  response, double-encoded — `summarizeJsonShape()` alone only ever reported `"body":"string"` and
  had nothing more to say, regardless of what was actually inside.
  - Raised the detail cap in `buildDiagnosticReport()` from 5 to 30 (comfortably above the 16
    observed) so a page like this one shows everything instead of only the first few, which turned
    out to be exactly the wrong few. The total count reported was never capped, only the detail dump.
  - ADDED: `scanEmbeddedJsonPayloads()` now also detects the datalet-wrapper shape specifically (a
    parsed object with a string `body` field) and attempts `JSON.parse()` on that string too,
    reporting its shape alongside the wrapper's own as `bodyShape`. Deliberately narrow — targets
    exactly the known wrapper shape just confirmed live, not a generic "try to parse every string in
    the tree," which would be slower and prone to false-parsing a value that merely looks numeric or
    quoted.
  4 new tests: a datalet-style wrapper reporting both its own outer shape and the unwrapped body
  shape side by side; a `body` field that's a string but isn't itself valid JSON being skipped
  silently rather than crashing the scan; a payload with no `body` field at all never showing a body
  line; and the cap boundary re-verified at its new value (31 payloads in, 30 detailed, count still
  accurate at 31). 357 total.

## v7.57 — reported live: of the 8 real (non-wrapper) payloads found on `/jobs/search/`, one —
  `jobCardPrefetchQueries` -> `prefetchJobPostingCard`, LinkedIn's own name for prefetched job card
  data — is clearly the right neighborhood, but `summarizeJsonShape()`'s depth cap (5) truncated to
  `"prefetchJobPostingCard":"object"` right at the field that actually matters, one level short of
  anything useful. Separately, none of the 8 `datalet-*` wrappers' v7.56 body-unwrap ever produced a
  `bodyShape` — their `body` field is most likely empty/non-JSON request metadata, not a second copy
  of the real data, which already lives directly in their non-wrapper twin.
  - ADDED: `findSizeLikeFields()` — rather than widen the general shape cap (which would bloat all 16
    payloads' output, most of them irrelevant: i18n bundles, nav data, feature flags, profile data),
    this searches each payload's REAL parsed content directly for any key name matching
    `employeeCount|companySize|staffCount|staffingCompanySize|headcount|numberOfEmployees` (case-
    insensitive — `numberOfEmployees` specifically because that was LinkedIn's own public JSON-LD
    field name for this, confirmed live and documented back in CHANGELOG.md v6.4), at any depth, and
    reports exactly where it lives — the full key path — plus the value's TYPE only, same
    never-leak-real-values stance as `summarizeJsonShape()` throughout. Depth-bounded (15) and
    result-capped (20 per payload) for safety on pathological input; runs against both a payload's
    main content and its unwrapped `body` (when v7.56's unwrap succeeded).
  - `buildDiagnosticReport()` now aggregates every match found across every payload in every
    document into one new closing section, "Company-size-like fields found across all embedded
    payloads" — a single place to look instead of scanning 16 per-payload shape dumps by eye for
    something that might not be there.
  - FIX, found while extracting this for tests: `scanEmbeddedJsonPayloads()`'s single try/catch
    wrapped both `JSON.parse(text)` (expected to fail routinely — plenty of `<code>` tags aren't data
    payloads) AND all the processing after it. A bug in the processing step would have been silently
    swallowed and misreported as "not JSON, skip" instead of failing visibly — exactly what happened
    when the test's extraction initially omitted `findSizeLikeFields()`, a `ReferenceError` that
    vanished into the wrong catch block instead of failing loudly. Split into two try/catches scoped
    to what each is actually meant to catch; a genuine processing failure now logs to console instead
    of silently dropping that payload.
  6 new tests: a nested match found regardless of depth with its exact path reported, and the actual
  value (51/200 in the test) confirmed absent from that reported line; a match inside an unwrapped
  `body` correctly labeled as coming from the body layer; multiple distinct naming styles
  (`numberOfEmployees`/`staffCount`/`headCount`) all matched case-insensitively in one payload; the
  "None found." summary line and section header both present when nothing matches. 363 total.

## v7.58 — reported live via a Diagnose report, not a symptom report — the structural probe itself
  surfaced a real correctness bug the Voyager/embedded-payload investigation was chasing evidence for
  anyway. On a `/jobs/search/` layout where the actually-open job's detail pane rendered inside the
  iframe (a named `BADGE_HEADER_SELECTORS` match there, real `h1`) while the top document held only
  the job LIST (all five named selectors missing, no real detail content), `top-card company link
  resolves to:` showed a job LIST card's own link (Amazon, the first company in an unrelated list) —
  not the actually-open job's company. Root cause: `findBadgeHeader()`'s single loop checked BOTH
  named selectors AND the fallback for each document before moving to the next, so the top document's
  weak fallback match won and returned immediately, before the loop ever reached the iframe where a
  real named-selector match was sitting the whole time. A fallback match in an earlier document
  should never outrank a named match in a later one — this is the same class of wrong-company bug as
  the v6.5 Handshake incident referenced at the top of this file, reached a different way.
  - FIX: split into two passes. Pass 1 checks every document for a named-selector match FIRST, before
    any document's fallback is even considered, so document order can no longer let a weak match in
    an earlier document pre-empt a strong match in a later one. Pass 2 (fallback) only runs if no
    document had a named match anywhere, in the same per-document priority order as before. No
    behavior change for the common single-relevant-document case every existing test already covered.
  - The Voyager/embedded-payload investigation (v7.52-v7.57) is paused here, not abandoned mid-fix:
    the same `/jobs/search/` route showed 16 embedded payloads in one session and zero in the next,
    and the Voyager fetch observer never once saw job/company traffic despite confirmed-working
    interception. Two independent structural leads, both inconsistent across real sessions, is itself
    a real finding — building extraction on a data source that isn't reliably present would be a
    WORSE foundation than the current DOM-based approach, not a better one. The diagnostics built
    along the way (feature health, the Diagnose report, both observer tiers) stay — they're what
    surfaced this real bug in the first place — but phase 2 (actual field extraction) isn't the next
    step until a more consistent signal turns up.
  3 new tests: the exact reported shape (earlier document fallback-only, later document named-match)
  now resolves to the later document's match, correctly labeled as a named-selector match rather than
  a fallback; and a sanity check that with no named match anywhere, the first document's fallback
  still wins, unchanged from before the restructuring. 366 total.

## v7.59 — documentation only, no functional change (test count unchanged at 366). Recorded a real
  finding from the paused Voyager investigation before it could get lost: `findSizeLikeFields()`
  landed a genuine hit, twice, on separate live `/jobs/search/` sessions —
  `$.meta.microSchema.types.com.linkedin.voyager.dash.deco.launchpad.
  OrganizationTopCardForEntityFollow.fields.employeeCount` — confirming `employeeCount` is a real
  field LinkedIn's own internal schema tracks for an organization "top card" component. Still a
  schema declaration inside a component-recipe payload with empty `elements`, not an actual data
  instance with a value, and the payload carrying it was frequently absent even on a fully-healthy
  page (badge matched via a named selector) in the same v7.58 testing round that confirmed this — so
  the "paused" conclusion from v7.58 stands. Noted in a code comment next to
  `SIZE_LIKE_FIELD_NAME_PATTERN` as the confirmed real field/component name to start from, should a
  more reliable delivery mechanism (e.g. an authenticated same-origin request to a Voyager REST
  endpoint, which historically accepts a `decorationId` query param referencing exactly this kind of
  fully-qualified type name) ever get investigated later, instead of re-discovering it from scratch.

## v7.60 — asked directly: if the Voyager network-interception mechanism doesn't work, why keep the
  code? Fair question, answered by removing it rather than defending it. Split the investigation's
  leftovers into two categories and treated them differently instead of a blanket keep-or-cut:
  - REMOVED (proven not useful, real ongoing cost, not reused by anything else): `installVoyagerObserver()`
    and its `observedFetch` wrapper, `VOYAGER_URL_PATTERN`/`VOYAGER_ANY_URL_PATTERN`, the
    `@grant unsafeWindow` permission, and the `@run-at document-start` timing change (reverted to
    `document-end`) — that whole mechanism existed ONLY to support patching `fetch` early enough to
    see it. Confirmed working technically (real traffic was observed after the v7.54 timing fix) but
    never once saw job/company data despite extensive live testing across many sessions — carrying a
    real permission and an early-execution footprint for zero payoff. The bottom-of-file scheduling
    section, deferred to `DOMContentLoaded` in v7.54 only because `document-start` didn't guarantee
    `document.body` existed, is back to its simple unconditional form now that `document-end`
    (which always guarantees it) is back.
  - KEPT (genuinely useful independent of Voyager, zero risk, not what's being questioned): `summarizeJsonShape()`,
    `scanEmbeddedJsonPayloads()`, `findSizeLikeFields()`, `SIZE_LIKE_FIELD_NAME_PATTERN`, and the
    "embedded JSON payloads" / "Company-size-like fields" sections of the Diagnose report. These are
    a pure DOM read (no permissions, no monkey-patching, no timing dependence) — part of the general
    diagnostic toolkit now (same category as everything else Copy Diagnostics reports), and the exact
    thing that found the real `employeeCount` field name recorded in v7.59. Removing working,
    zero-cost, already-tested code just because the ADJACENT network-interception approach didn't pan
    out would have thrown away the one part of this investigation that actually delivered something.
  19 tests removed (the `installVoyagerObserver`-specific suite: passthrough guarantees, DEBUG/URL
  gating, which-object-patched); `summarizeJsonShape()`'s own 8 tests survive as their own smaller,
  focused suite. 347 total (down from 366, entirely accounted for by the removed suite — no other
  coverage lost).


## v7.61 — asked the broader question this time: what actually makes this script hard to break, so it
  doesn't end up like the abandoned LinkedIn userscripts on GitHub that quietly stopped working and
  nobody noticed? Reading the file end-to-end for that turned up a concrete hole rather than a
  hypothetical one — the script could break COMPLETELY and still report "✅ Everything working
  normally":
  - `filterJobListCards()` skips a card whose company name can't be read (`if (!info) return;` —
    correct on its own, cards genuinely mount before their content hydrates, see v7.19).
  - `runFeature()` reports 'ok' for anything that doesn't THROW, and this path throws nothing.
  - `updateCounterDisplay()`'s first figure is `Object.keys(companyCache).length` — the WHOLE cache,
    not this page — so it keeps showing a healthy-looking number regardless.
  So a renamed company-name class would have produced: no filtering, no card badges,
  "Cached: 847 | Hidden: 0 | Unclassified: 0", and a green health panel — indistinguishable from a
  page that genuinely has nothing to filter. That is precisely the shape of failure that leaves a
  script dead for weeks. Note the asymmetry it comes from: the badge broke four times in v7.1-v7.58
  and was reported within a day EVERY time because it's visible; filtering and passive capture are
  invisible, so they'd have gone unreported indefinitely.
  - ADDED `reportCardYieldHealth()` — compares job cards FOUND against job cards READ, and reports
    'filtering' health from that instead of from absence-of-throw. Sustained zero yield -> failed;
    sustained partial (<50%) -> fallback; both graced for `CARD_YIELD_GRACE_MS` (5s) first, since
    containers legitimately outrun their content on every page load and an alarm that fires during
    normal hydration would train the panel to be ignored — strictly worse than no alarm. The signal
    is deliberately self-normalizing (the containers found ARE the proof cards exist here), so it
    needs no "is this a jobs page?" URL heuristic, the guessy kind of check that generates false
    positives.
  - ADDED a probe for the opposite failure — `CARD_PROBE_SELECTOR` counts card-specific ATTRIBUTES
    (`data-occludable-job-id`, `componentkey^=job-card-component-ref-`); if those are present in
    quantity while `CARD_CONTAINER_SELECTORS` matches nothing, the container chain itself is what
    broke. An earlier draft also counted `a[href*="/jobs/view/"]` and that was cut before shipping:
    a "similar jobs" sidebar carries those links on pages with no list at all, which would have
    raised a false ❌ on a perfectly healthy page.
  - ADDED `detailYieldVerdict()` / `recordDetailReadOutcome()` — the same treatment for the second
    invisible feature. Passive capture is how the cache grows from ordinary browsing, and its failure
    mode is total silence: `if (!size) return;` is correct for a pane that hasn't rendered, and
    identical to "the About-the-company selectors stopped matching". Tracks the last
    `DETAIL_YIELD_WINDOW` (10) DISTINCT jobs; reports failed only if every one came back empty.
    Conservative on purpose — LinkedIn genuinely omits the size field for plenty of real companies,
    so one empty read is not evidence. The bookkeeping subtlety that drove the design: a failed read
    RETRIES every tick for as long as that job stays open, so recording at the point of failure would
    have let ONE ordinary size-less company fill the whole window within seconds. An outcome is
    recorded once per job, on switching away, and only for jobs that actually reached extraction —
    a job skipped for MANUAL_EDIT, or never matched to a company, is not a failed read.
  - ADDED selector attribution (`recordSelectorHit()`, `queryWithAttribution()`, `formatSelectorStats()`)
    and a "Selector hit rates" section in the Diagnose report. Every selector chain here is a list of
    guesses and nothing recorded which guess fired; a rung going from 100% to 0% is the earliest
    possible signal that LinkedIn shipped a markup change — exactly the silent state that preceded
    v7.45/v7.48 and v7.58. Wired into `getCardInfo()`'s company-name chain and `findBadgeHeader()`,
    with `CARD_CONTAINER_SELECTORS` counted on demand inside `buildDiagnosticReport()` only (never
    per cycle — `getCardElements()` already runs several times a cycle and that's the one genuinely
    hot path). Session-only, deliberately not persisted: a stale count carried across sessions would
    mislead in exactly the situation this exists to clarify.
  - The attribution design point worth recording: `queryWithAttribution()` issues the chain as ONE
    comma-joined `querySelector` exactly as the hand-written code did, and only then asks the winning
    element which selector it matched. Splitting the chain into sequential tries — the obvious way to
    make attribution easy — would have silently changed the result, because comma-joined returns the
    first match in DOCUMENT order while sequential returns the first in SELECTOR order. Those are
    different elements on any card carrying both an `.artdeco-entity-lockup__subtitle` and a
    `/company/` link, which would have moved where `getCardInfo()` reads its text and where the
    inline card badge attaches. A measurement must not alter the thing it measures.
  - `findBadgeHeader()` keeps its own sequential loop rather than being routed through
    `queryWithAttribution()` — that chain IS genuinely sequential by design (v7.1 ordered it
    narrowest-first so the badge lands beside the company name, not after a combined "company ·
    location · posted" line). It just reports at each exit instead.
  - FIX found by its own new test: `cardYieldDegradedSince` used `0` as both a real timestamp and the
    "not currently degraded" sentinel, so a `now` of 0 could never start the grace timer. `Date.now()`
    is never 0 in a browser, so this was correct only by accident; switched to an explicit `null`
    sentinel with an `=== null` check, correct for any input.
  Scope note: this is measurement only — everything added sets health strings and reads the DOM. It
  writes nothing to any cache and changes nothing shown on the page, so a mistuned threshold can show
  a spurious warning but cannot hide a card or record a wrong size. Deliberately NOT done for now
  (and why): structural/text-anchored fallback rungs for the chains that only have class names —
  worth doing, but it means guessing at markup neither of us has seen, and knowing FAST beats
  guessing EARLY; user-editable selector overrides; and a real-HTML fixture corpus to replace the
  synthetic DOM the suite currently uses.
  60 tests added: selector attribution (14 — including the explicit guarantee that exactly one
  comma-joined querySelector is issued, never one per selector), the card-yield state machine (17 —
  weighted toward the false-positive cases, since an alarm's whole value is being trusted when it
  fires), the detail-yield window (10), its integration through the real `captureFromJobDetailPane()`
  (10 — proving a single job can't fill the window, a MANUAL_EDIT skip isn't a failure, and an
  already-read job isn't double-counted), and the new Diagnose sections (9). 407 total.

## v7.62 — v7.61's new instrumentation immediately earned its keep in both directions: the first live
  reports it produced contained one false alarm to fix and one confirmed-correct diagnosis.
  - FIX (reported live): a PERMANENT "⚠️ Company size badge" on /jobs/search-results/ while the badge
    itself was working perfectly. The health call was `!BADGE_HEADER_SELECTORS.includes(selector)` —
    "any rung that isn't a named selector is a degradation" — and that premise is simply false on the
    componentkey layout. The Diagnose report settled it in one glance: `h1=0`, all five named
    selectors `false`, and `25 [role="button"][componentkey^="job-card-component-ref-"]` with every
    class-based container at `0`. That is the build v7.5 and v7.48 both hit (hashed class names like
    "_20e55808 b0593cae fdf81ae8", no job-title heading of any kind), where NONE of
    BADGE_HEADER_SELECTORS can ever match — so `findTopCardCompanyLink()` winning isn't a primary path
    missing, it's the mechanism v7.48 built for exactly this layout doing its job. The warning could
    therefore never clear, and a permanently-on warning is one you stop reading — the same standard
    that got `a[href*="/jobs/view/"]` cut from the card probe in v7.61, applied to itself.
    Fixed with `isExpectedBadgeRung()` / `isComponentKeyLayout()`: the question is no longer "which
    rung won" but "was a better rung even AVAILABLE on this layout". Deliberately narrow — it exempts
    exactly one rung on one layout. The scoped rung sits below the top-card rung in findBadgeHeader(),
    so reaching it means the top-card rung missed too and it still reports fallback; a total miss
    still reports failed via findBadgeHeader() returning null; and on the BEM layout (/jobs/search/,
    where the named selector was confirmed at 100% in the same round of reports) a drop to the
    structural rung is still a genuine degradation and still warns.
  - CONFIRMED WORKING (no change needed): on /jobs/search-results/, `card.company` reads
    `8356 (100%) <p> fallback (componentkey layout)` while List filtering reports `ok`. That is
    correct on both counts — v7.5 established this layout has no `<a>` on a card at all, so the `<p>`
    rung is the ONLY thing that can work there, and filtering health is judged on YIELD rather than on
    which rung won, so a 100%-fallback chain that is reading every card correctly reports healthy.
    Had v7.61 tied filtering health to rung identity instead, this would have been a second false
    alarm. Worth recording as a design choice that was tested by reality rather than by intent.
  - ADDED DOM skeleton capture (`renderElementSkeleton()`, `describeElementSkeleton()`,
    `directTextOf()`) and two new Diagnose sections: the first job card, and the badge header's
    surrounding region (walked from two levels up, since a replacement selector nearly always has to
    name an ancestor rather than the matched node alone). Motivation is concrete rather than
    speculative: every markup incident in this project — v7.5, v7.27, v7.48 — needed a throwaway
    diagnostic written, shipped, run, and removed BEFORE the real fix could even be attempted, a full
    round-trip each time, because counts and booleans prove which chain broke but never say what to
    replace it with. Reports tag names, class names, attribute names/values, and each element's
    DIRECT text only — never a parent's whole subtree collapsed into one blob, which is precisely
    what makes "which element actually holds the company name?" unanswerable from an ordinary dump.
    Attribute names matter most here: `componentkey`, `data-occludable-job-id`, `role`, `aria-*`
    survive the class-name hashing that keeps breaking the class-based rungs, so they are what a
    replacement selector should be built from.
    Bounded on all three axes — depth (4), siblings per level (6), and a hard total-node budget (60)
    with explicit truncation notes rather than silent cutoff. The total budget is the load-bearing one:
    depth and sibling caps alone still permit a combinatorial blow-up that would turn a bug report
    into a page dump. Text, class and attribute values are individually capped too, and the capture is
    scoped to a job card and the badge header's region — both of which this report already exposes in
    full via /company/ hrefs; nothing here reaches messaging, connections or profile areas.
  - NOT DONE, by explicit decision: user-editable selector overrides (the P3 idea floated in v7.61's
    planning). Rejected on the grounds that the person who fixes this script reads DevTools and hands
    the markup over directly, so a self-service selector editor would add real UI surface and a way to
    corrupt a working config while removing no actual round-trip. The DOM skeleton above is the same
    idea aimed at the person who actually does the fixing. Structural fallback rungs (P2) stay
    deferred but are no longer blocked on guesswork — the skeleton capture is what will supply the
    real markup they need to be written against instead of invented.
  40 tests added: the layout-aware rung classification (8 — pinning BOTH directions, quiet where the
  structural rung is intended and still loud where a better rung genuinely missed, plus the narrowness
  of the exemption), the skeleton walker (21 — weighted heavily toward the caps, since an unbounded
  walk is the failure mode that matters), and the two new Diagnose sections (11). 447 total.

## v7.63 — the first version whose changes were designed from CAPTURED markup rather than from a guess
  about what LinkedIn ships. v7.62's DOM skeleton was added specifically so P2 (structural rungs)
  wouldn't have to be invented; four live /jobs/search-results/ captures — four different companies,
  identical structure every time — supplied the evidence, and it turned out to contain both a better
  anchor than anything this file had, and proof that the capture tool's own caps were mistuned.
  - ADDED findAriaLabelledCompanyLink() (P2), now the FIRST structural rung in findBadgeHeader()'s
    fallback pass, above findTopCardCompanyLink(). Every capture showed the same shape:
      <a href=".../company/bitgo/..." componentkey="auto-binding-…">
        <div componentkey="auto-binding-…" aria-label="Company, BitGo.">
    aria-label is categorically better than what it sits above. findTopCardCompanyLink() picks the
    first /company/ link that isn't in a list card or the about-section — DOCUMENT ORDER, which is
    positional, not identity-bearing. The same captures showed exactly why that's a live risk rather
    than a theoretical one: one page carried /company/cgi/, /company/bell/ and /company/servicenow/
    links (companies named in the job description) alongside the real employer's, and ordering was the
    only thing keeping the badge on the right company — the same class of wrong-company bug that
    v6.5's Handshake incident was. A link the page itself labels "Company, <name>" is the employer by
    declaration. It also survives what keeps breaking everything else here: an accessibility attribute
    is untouched by the CSS-module class hashing confirmed in v7.48 and again in these captures (every
    class on that layout is now a hash like "_033a7091 fe2263dc"), and it's not something a company
    under accessibility-compliance obligations quietly deletes.
    Returns the ANCHOR, not the labelled div — deliberately the same element findTopCardCompanyLink()
    would have returned, so this changes only HOW the badge's host is found, never where the badge
    renders. Carries the identical list-card and about-section exclusions, so it can only ever be more
    selective than the rung it sits above, never less. Listed in BADGE_ALWAYS_EXPECTED_RUNGS, i.e.
    expected on every layout rather than only the componentkey one (v7.62's exemption): unlike the
    top-card rung, it isn't a degraded path anywhere — it's stronger than the class names it sits
    behind, so it winning is a good outcome, not something to warn about.
  - FIX (found by the tool reporting on itself): three of v7.62's DOM-skeleton caps were wrong, and
    the first real capture showed each one.
      depth 4 -> 7          the componentkey card's <p> elements — the ones actually holding the
                            company name, the single thing a card-level rung needs — sat BELOW the
                            cap. The capture could not answer the question it was added to answer.
      attr value 40 -> 100  truncated the two most load-bearing values in the whole dump:
                            href="…linkedin.com/company/bitgo/l" (slug lost) and
                            aria-label="Company, BCE Global Tech - A Bell Canada" (cut mid-name).
      nodes 60 -> 120       needed to reach the extra depth without the budget binding first.
  - ADDED isPresentationalSubtree(): the walk was descending <figure aria-hidden="true"> -> <svg> ->
    <path d="M14 12a2 2 0 1 1-2-2…">, spending the node budget on decoration while the company name
    sat unreached further down the card. Both rules are semantic rather than a tag blocklist —
    aria-hidden="true" is the DOM's own declaration that a subtree carries no meaningful content, and
    an <svg>'s children are drawing instructions by definition. Neither can contain a company name, so
    neither is worth a node of a budget that exists to reach one. The element itself is still reported
    and the skip is stated on its own line, never silent.
  - P4 STARTED: the suite's first fixture transcribed from REAL captured markup (observedTopCard(),
    hashed class names and all) instead of a shape invented to suit the test, plus a minimal fixture
    DOM (fx(), fxMatches()) supporting tag names, .class, and [attr]/[attr=]/[attr^=]/[attr*=] — and
    deliberately nothing more, so it throws on any selector form a real browser would reject rather
    than quietly accepting it. This matters because every other DOM mock in this file encodes what the
    author BELIEVED LinkedIn ships, which is the assumption that has been wrong four separate times
    here (v7.1, v7.5, v7.33, v7.48). The decisive test is the one that runs both rungs against a page
    where a description-mentioned company renders first: the document-order rung returns
    /company/servicenow/ (wrong), the aria-label rung returns the real employer.
  - STILL NOT WRITABLE: a structural rung for card.company, which remains 100% dependent on
    findComponentKeyCompanyElement()'s "first childless <p>" — the most fragile single path in this
    file, and dangerous specifically because it fails by picking the WRONG element (a wrong company
    name cached) rather than by picking none. The captures don't reach it: those <p>s sat below the
    old depth cap. That's precisely what the cap fix above unblocks, so the next capture from this
    layout should contain what's needed. Not guessed at in the meantime.
  29 tests added: the aria-label rung against real observed markup (13, including the wrong-company
  demonstration and the end-to-end rung-order pin through findBadgeHeader), the presentational-subtree
  skip and retuned caps (10), and the always-expected classification (3, pinning that the two
  structural rungs are genuinely treated differently rather than collapsed together). 476 total.

## v7.64 — v7.63's depth-cap raise (4 -> 7) STILL didn't reach the componentkey card's company name;
  the live capture stopped one level short, at `<div class="c4936755" data-display-contents="true">
  … 1 child element(s), depth cap reached`. Raising the cap a third time would have been guessing at
  how deep "deep enough" is. The actual problem is that a blind depth-first walk spends its budget on
  wrapper divs, and this layout is almost entirely wrapper divs — eight of them between the card root
  and any content. Replaced the hope of a deeper dump with two views that answer the question directly.
  - ADDED buildCardTextInventory() — every element in the first job card carrying its OWN direct text,
    with its ancestor path, any aria-label, and its CHILD COUNT. The child count is the point: it's the
    exact predicate findComponentKeyCompanyElement() selects on ("first childless <p> with text"), so
    one glance says which element that rung lands on and whether anything better sits nearby. Costs a
    fraction of the output a depth-9 structural dump needs, and doesn't depend on guessing a depth.
  - ADDED describeCardCompanyExtraction() — not what the card looks like, but what each rung actually
    PICKS from it: whether the named chain matched, which element the <p> fallback landed on, and what
    getCardInfo() ultimately resolved to. This is the one that matters most, because card.company's
    failure mode is the dangerous kind: it fails by selecting the WRONG element — caching "Viewed" or
    "India (Remote)" as a company name — not by selecting none. A 100% hit rate looks identical in both
    cases; only seeing the picked element distinguishes them. (The captures so far show this rung
    carrying 100% of card reads on that layout, with filtering yield healthy, so it IS working today —
    but nothing in the report could have proven that until now.)
  - CHANGED skeleton depth 7 -> 9 and node budget 120 -> 160. Kept as the structural view, but no
    longer the mechanism the card question depends on.
  - CONFIRMED LIVE, v7.63's P2 rung: badge.header now reads 100%
    `a[href*="/company/"] (via [aria-label^="Company, "])` across three different companies, and the
    decisive case occurred naturally — the BCE page carried /company/cgi/, /company/bell/,
    /company/servicenow/ and /company/servicenow-community/ links alongside the employer's, and the
    rung still resolved to bceglobaltech. That is the wrong-company scenario the v7.63 fixture
    simulates, happening in the wild and being handled correctly.
  - Test-fixture DOM (v7.63's fx()) gained three capabilities, each forced by a real call shape rather
    than added speculatively: selector LISTS ("a, b, c" — how the card company chain is issued, and a
    fixture that couldn't express it would be unable to test the very call shape the real code
    depends on), textContent (own text plus descendants', because findComponentKeyCompanyElement reads
    it and its predicate only means what it means if this matches the DOM), and a selector-list
    splitter that tracks bracket depth and quotes — a naive .split(',') tore [aria-label^="Company, "]
    in half. The "throw on anything unsupported" design is what surfaced all three immediately instead
    of silently mis-parsing them.
  16 tests added, all in the new card-diagnostics suite: the inventory reaching text a depth-limited
  walk could not, its path/child-count/aria-label reporting, its cap, and the extraction trace —
  including the case that matters most, where a chrome <p> ("Viewed") renders before the company's and
  the report shows both the wrong pick and the bad value it produced. 492 total.

## v7.65 — reported with a /jobs/search/ capture and the observation that the last few versions had
  been shaped almost entirely around /jobs/search-results/. Correct, and it had already produced a
  defect on the under-tested route.
  - FIX: describeCardCompanyExtraction() reported `named chain matched: <div> text=""` on the BEM
    layout, where the chain was in fact working perfectly. It read directTextOf(), but
    .artdeco-entity-lockup__subtitle is a WRAPPER whose text sits in a child <span>
    (`<div class="artdeco-entity-lockup__subtitle"><span dir="ltr">Supersei.ai</span>`). directTextOf()
    is right for the text inventory — whose entire job is saying which element OWNS text — and wrong
    here, where the question is what the rung will actually read, and getCardInfo() reads
    .textContent. A diagnostic reporting a healthy path as empty is worse than no diagnostic: it
    invites a "fix" to something that isn't broken.
  - CHANGED: the trace now covers the first CARD_EXTRACTION_TRACE_MAX (6) cards instead of only the
    first. The same capture reported card.company at 74% named / 14% <p> fallback / 12% no-match, and
    a first-card-only trace can show exactly one of three outcomes — a mix is invisible to it by
    construction. Also fixed to mirror getCardInfo()'s real order: the <p> fallback is consulted ONLY
    when the named chain missed, rather than both being run and reported unconditionally, which would
    have described a path the real code never takes.
  - DROPPED, deliberately: the planned structural rung for card.company (the natural follow-up to
    v7.63's aria-label rung for the badge). The text inventory settled the question by answering it in
    the negative — on the componentkey layout the only labelled element on a card is the dismiss
    button's aria-label="Dismiss <job title> job" (the TITLE, not the company), and the wrapper classes
    are hashed utilities repeating across unrelated elements (c1ccab5e sits on both the company's
    wrapper div and the location <p>). There is no semantic anchor for the company name on that card.
    Every remaining candidate was a guess: a blocklist of chrome strings ("Viewed"/"Promoted"/"Easy
    Apply" — locale-dependent and open-ended) or a cross-check against the dismiss title (narrow,
    catching one failure mode). Both would add new failure modes to a path that resolves correctly on
    every card captured so far — coverforce, wenger watson, supersei ai all correct. Shipping a shaky
    replacement for something that works is a net loss, and the diagnostics from v7.61-v7.65 already
    solve the part that was genuinely missing: if this rung breaks, it is now loud and immediately
    diagnosable rather than silent. Recorded next to CARD_COMPANY_SELECTORS so the question isn't
    re-opened from scratch later.
  - CONFIRMED on both routes from the same round of captures: badge ok on /jobs/search-results/ (via
    the v7.63 aria-label rung) AND ok on /jobs/search/ (via .job-details-jobs-unified-top-card__company-name,
    untouched — the new rung sits below the named pass and never competes with it); filtering ok on
    both; company correctly resolved on both.
  15 tests added, and the card-diagnostics suite now covers BOTH layouts explicitly rather than one —
  a BEM card fixture transcribed from the live capture (including the wrapper-with-child-span shape
  that caused the regression), the componentkey path, the ordering guarantee that a named match means
  the fallback is never reported, the mixed-outcome case that motivated going per-card, and the trace
  cap. 507 total.

## v7.66 — P1 through P3 in one pass, plus one defect the work surfaced on the way in.
  - FIX (found while implementing P1): CARD_COMPANY_FALLBACK_LABEL read
    `<p> fallback (componentkey layout)`. That label asserted a LAYOUT rather than describing a RUNG,
    and the assertion was demonstrably false — a /jobs/search/ capture showed it firing on 14% of card
    reads on a page where the componentkey container matched ZERO elements. The mislabel is part of
    why that 14% looked mysterious: the report was naming a cause instead of stating what the rung
    does, which is "take the first childless <p> that has text" — something any layout can satisfy.
    Now `<p> fallback (first childless <p> with text)`. A diagnostic label should describe the
    mechanism; a wrong explanation baked into it costs more than no explanation at all.
  - P1: describeCardCompanyExtraction() now scans past its trace cap for the first card taking a rung
    not already shown, and appends up to CARD_TRACE_EXTRA_RUNGS (2) such entries. The live capture
    split 74% named / 14% fallback / 12% no-match while its first six cards all took the SAME rung —
    so the report showed a uniform picture of a page that demonstrably was not uniform, and the
    minority rungs stayed unexplained purely because of where they sat in the list. A uniform
    remainder now says so explicitly ("all resolve through a rung already shown above") rather than
    leaving an untraced count that always looks like it might be hiding the interesting case.
  - P1b: removed the per-payload JSON structure dump from the Diagnose report, and with it
    summarizeJsonShape(), which became dead. Same reasoning that removed the Voyager network half in
    v7.60: across many sessions it produced exactly ONE actionable finding (the `employeeCount` field
    name, recorded next to SIZE_LIKE_FIELD_NAME_PATTERN in v7.59) and nothing since, while adding ~20
    lines to every report — and these reports are pasted into a conversation by hand, so unread bulk
    is a recurring cost, not a neutral one. What survives is the payload COUNT (proof the scan ran)
    and the aggregated size-field section (the part that would ever be acted on). The "datalet" body
    unwrap survives too: it was never the noisy part, and it is what lets findSizeLikeFields see
    inside the wrapper.
  - P2 (@match): kept broad, and the gate moved into runCycle() instead — isJobRelevantPage().
    Narrowing @match to /jobs/* was considered and rejected: Tampermonkey matches at DOCUMENT LOAD and
    LinkedIn is an SPA, so starting on the feed and navigating into jobs would then never start the
    script at all. The real cost was never the match, it was a subtree MutationObserver on a busy page
    (feed, messaging) dragging a full cycle behind every mutation. In runCycle the gate is free to be
    wrong — the 1s poll re-evaluates it, so an SPA navigation resumes everything within a second with
    no reload. Panel injection stays ungated (idempotent, cheap, and hiding it would be a visible
    change nobody asked for); the skipped features report 'idle' with the reason "not a jobs or
    company page" rather than passing silently, so the Data tab and Diagnose stay truthful about why
    nothing is happening.
  - P2 (cache bound): implemented as MEASUREMENT, not eviction, and that is the substantive decision
    here rather than a shortcut. Cache entries are earned one page view at a time over months;
    deleting them to solve a storage problem that measurement says does not exist would be the worst
    trade in this file. localStorage allows roughly 5MB per origin — at the observed entry sizes that
    is six figures of companies. describeCacheFootprint() reports companies, slugs and approximate KB
    in the Diagnose header, with the number put in context rather than left to be worried about. If it
    ever does approach the limit, the report will have been saying so for a long time first, and a
    deletion policy can then be a decision rather than a guess.
  - P3: the job-title contradiction guard. The <p> rung picks by POSITION, so it fails by choosing the
    WRONG element rather than none — and a wrong pick is written to companyCache under a garbage key.
    v7.65 established there is no positive semantic anchor for the company name on that layout, but
    there IS a negative one: the card labels its own job title, so "the company name is exactly the
    job title" is a contradiction rather than a heuristic. findCardJobTitle() reads it from the job
    link's own aria-label (locale-independent) or the dismiss button's English "Dismiss <title> job"
    phrasing, and returns null on anything else — no title means no check, never a guess, so a
    non-English UI simply gets no guard rather than a wrong one. Exact match only: a substring test
    would flag the very common "Software Engineer at Acme" title against a real company called Acme,
    turning a safeguard into a source of dropped cards. A contradiction makes getCardInfo() return
    null rather than merely logging, following this file's oldest rule (v6.4/v6.5) that wrong data is
    worse than none — an unreadable card is a state the rest of the file already handles, and it
    counts against the v7.61 filtering yield, so a broad misfire raises the alarm instead of silently
    poisoning the cache. The rejection count is reported in Diagnose; zero is the expected reading.
  - Also added: `npm test` / `npm run test:size-filter` / `npm run check:size-filter` in package.json
    (the last runs `node --check` on both files and then the suite). Verified empirically that the
    suite exits 1 on failure and 0 on pass and that the code propagates through npm, so these are safe
    for automation. A pre-commit hook was NOT added: these files are untracked, so a hook could never
    fire for them, and it would fire on unrelated commits elsewhere in the directory instead.
  Test count 507 -> 554. The 8 summarizeJsonShape tests were removed with the function; the payload
  and datalet tests were rewritten to assert the dump is genuinely GONE rather than merely shortened
  (and that the unwrap still feeds the size search); 55 added across the new gate, cache footprint,
  title guard, rung-mix tracing, and the label change. 554 total.

## v7.67 — reported live: the job-title-contradiction rejection count (v7.66) sat unlabeled right
  after the container-selector list in the Diagnose report, which made it read as if it were one more
  container count rather than what it actually is. Given its own "-- Job-title contradiction guard --"
  header. Also clarified in conversation, not code: the JSON-payload dump trim (v7.66) only removes
  lines when payloads are actually FOUND — a report with 0 payloads (the common case on
  /jobs/search-results/) shows no length change from it, which is expected, not a regression. The
  report has in fact gotten longer overall across v7.61-v7.66 as diagnostic sections were added faster
  than the one piece of bloat was trimmed; that trade was made deliberately for the value the new
  sections provide, but it should have been stated plainly instead of leading with "shorter."
  2 tests added, pinning the new section header and that the count line sits under it rather than
  under the container-selector one. 556 total.

## v7.68 — closes out the last open item from the stability push: whether card.company's "(no match)"
  share (8-14% of reads in live captures on the BEM layout) is transient hydration lag, as v7.19's own
  comment predicted for a different symptom, or a real sustained problem. Proves it instead of arguing
  for it.
  - ADDED extractCardJobId() — the exact href/data-attribute/componentkey read getCardInfo() already
    performed on its SUCCESS path, factored out and now ALSO run on the failure path. Before this, a
    card that failed to resolve a company had no identity extracted at all, which is exactly why the
    question could only ever be explained, not proven: a miss and its later resolution had no shared
    key to prove they were the same card.
  - ADDED recordTransientCompanyMiss() / recordTransientCompanyResolution() / formatTransientMissSummary()
    — tracks each miss by job ID and records how long it actually took to resolve on a later cycle, or
    flags it if it never does. Reported in a new Diagnose section directly under the selector hit-rate
    section it explains. Purely diagnostic: reads outcomes that already happened, changes nothing about
    what gets filtered, cached, or displayed.
  - FIX, found by this feature's own test before it ever shipped: `if (!pendingCompanyMisses[jobId])`
    treats a legitimate timestamp of 0 as "not yet set" (0 is falsy) and overwrites the real first-miss
    time on every subsequent miss of the same card — silently breaking the "measure from the FIRST
    miss" guarantee the whole mechanism exists to provide. Same class of bug as cardYieldDegradedSince
    in v7.61; same fix, an explicit `=== undefined` check. Also gave formatTransientMissSummary() a
    `now = Date.now()` parameter (it previously read the clock inline), matching the testability
    pattern reportCardYieldHealth and detailYieldVerdict already use elsewhere in this file — without
    it, a fake-timestamped miss compared against real wall-clock time in a test reads as decades old
    and gets pruned before the test can observe anything.
  - Bounded two ways so the tracking map can never grow without bound across a long scrolling session:
    TRANSIENT_MISS_STALE_MS (5s) is the line between "still loading, unremarkable" and "taking longer
    than expected" in the report; TRANSIENT_MISS_GIVE_UP_MS (30s) drops a pending entry outright —
    almost certainly scrolled off-screen, not stuck — and counts it separately rather than either
    inflating "still pending" forever or silently vanishing.
  - Simplification alongside: getCardInfo()'s own jobId extraction (previously an inline copy of the
    same three rungs) now calls the shared extractCardJobId() instead — removes a second copy of logic
    that only existed because the failure path had no reason to compute an identity before this.
  29 tests added: extractCardJobId's four identity rungs and their priority order (6), the miss/resolve
  bookkeeping in isolation — including the falsy-zero regression this same suite caught (13), and the
  integration proof through the REAL getCardInfo() — a card that misses then resolves on a later call,
  correlated by identity, plus the negative case that a different card resolving never clears an
  unrelated one's pending miss (8), plus the new Diagnose section (2). 585 total.

## v7.69 — v7.68's own instrumentation was live for one day and immediately disproved the specific
  claim its comment made, while confirming the broader one. Corrected against real data rather than
  left standing.
  - CORRECTED: v7.68's comment guessed a "(no match)" card would resolve within roughly one poll
    cycle (a few hundred ms), by loose analogy with an unrelated v7.19 finding about container COUNTS.
    The first live Diagnose report this feature ever produced showed 16 resolutions at avg 11502ms /
    max 11503ms — essentially identical across all 16, which cannot be 16 independent short delays; it
    is one shared event. That number sits just under FORCE_RENDER_TIMEOUT_MS (12000ms). The real
    mechanism: a card can mount as an empty container mid-sweep and only receive its real company text
    once that SWEEP's own lazy-loading settles — tied to forceRenderAllVisibleCards() finishing, not
    to the next runCycle poll. The qualitative claim this feature was built to test (transient, not a
    real break) held up exactly as intended; the specific timescale in the original comment did not,
    and every place that stated it — the feature-list header, the inline implementation comment, and
    the Diagnose report's own wording ("resolved on a later cycle... if these numbers stay small") —
    is corrected here. The report section itself is renamed from "(hydration-lag check)" to
    "(sweep-settle check)" and now names FORCE_RENDER_TIMEOUT_MS explicitly as the expected baseline
    instead of an unstated "small", so a future report is judged against a real number, not a guess.
  - No behavior or threshold change: TRANSIENT_MISS_STALE_MS (5s) and TRANSIENT_MISS_GIVE_UP_MS (30s)
    already classified the live data correctly under the OLD comment's wrong mental model — 30s
    comfortably exceeds the real ~11.5s norm, and the "given up on" / "still pending" language was
    already a trend-to-watch, not a verdict. Only the STORY being told about a correct, working
    mechanism was wrong, not the mechanism or its guards.
  - Filtering health read 'ok' throughout every report this appeared in, and every resolved card's
    company name/size was correct — this was never a functional problem, only an inaccurate comment
    about a real, harmless, and now correctly explained delay.
  2 tests updated to match the corrected report wording ("resolved once pending" in place of "resolved
  on a later cycle"); no new test coverage needed since the underlying bookkeeping was already correct
  and already covered — only the prose around it was wrong. 585 total (unchanged from v7.68).
