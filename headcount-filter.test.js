#!/usr/bin/env node
'use strict';

// Permanent regression suite for headcount-filter.user.js.
//
// The script itself is a single Tampermonkey IIFE with no module boundaries — everything closes
// over shared state (companyCache, localStorage, document). This suite doesn't hand-copy logic
// out of it (that's exactly how the v6.2 candidate-slug regression shipped silently — a rewrite
// drifted from what was actually running, and nothing caught it until it broke live). Instead it
// re-reads the CURRENT script file on every run and extracts the real function/const source text
// verbatim, so a test failure here always reflects the code as it stands right now, not a stale
// snapshot of what it used to be.
//
// Run: node headcount-filter.test.js
// No dependencies beyond Node itself — deliberately no test framework, so this never needs
// `npm install` before it can catch something.

const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'headcount-filter.user.js');
const SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');

// --- Extraction -----------------------------------------------------------

function extractFunction(name, src) {
    let idx = src.indexOf(`function ${name}(`);
    if (idx === -1) throw new Error(`extractFunction: "function ${name}(" not found`);
    // Back up over "async " if present, so the extracted text keeps its real signature.
    const asyncIdx = src.lastIndexOf('async ', idx);
    if (asyncIdx !== -1 && src.slice(asyncIdx + 6, idx).trim() === '') idx = asyncIdx;

    const parenStart = src.indexOf('(', idx);
    let depth = 0, bodyStart = -1;
    for (let j = parenStart; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
            depth--;
            if (depth === 0) { bodyStart = src.indexOf('{', j); break; }
        }
    }
    if (bodyStart === -1) throw new Error(`extractFunction: could not find body start for ${name}`);
    depth = 0;
    for (let k = bodyStart; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') {
            depth--;
            if (depth === 0) return src.slice(idx, k + 1);
        }
    }
    throw new Error(`extractFunction: unterminated body for ${name}`);
}

function extractConst(name, src) {
    const marker = `const ${name} = `;
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error(`extractConst: "${marker}" not found`);
    const afterEq = idx + marker.length;
    const opener = src[afterEq];
    if (opener === '{' || opener === '[') {
        const closer = opener === '{' ? '}' : ']';
        let depth = 0;
        for (let k = afterEq; k < src.length; k++) {
            if (src[k] === opener) depth++;
            else if (src[k] === closer) {
                depth--;
                if (depth === 0) {
                    let end = k + 1;
                    if (src[end] === ';') end++;
                    return src.slice(idx, end);
                }
            }
        }
        throw new Error(`extractConst: unterminated ${name}`);
    }
    // Simple value: regex literal, `new Set([...])`, string, number, etc. — read to the
    // semicolon that ends the statement (first semicolon at paren-depth 0).
    let simpleDepth = 0;
    for (let k = afterEq; k < src.length; k++) {
        if (src[k] === '(' || src[k] === '[') simpleDepth++;
        else if (src[k] === ')' || src[k] === ']') simpleDepth--;
        else if (src[k] === ';' && simpleDepth === 0) return src.slice(idx, k + 1);
    }
    throw new Error(`extractConst: could not find end of ${name}`);
}

function extractDeclaration(name, src) {
    if (src.includes(`function ${name}(`)) return extractFunction(name, src);
    if (src.includes(`const ${name} = `)) return extractConst(name, src);
    throw new Error(`extractDeclaration: no function or const named "${name}" found in source`);
}

// Builds an isolated CommonJS module from a list of real declarations pulled out of the script,
// plus any mock scaffolding (localStorage stubs, dependency mocks) needed for them to run outside
// a browser. `extraSetup` code runs BEFORE the extracted declarations, in the same scope, so the
// extracted functions' free variables (e.g. companyCache, saveCache) resolve to the mocks.
function buildModule(names, extraSetup) {
    const parts = names.map((n) => extractDeclaration(n, SRC));
    const body = `${extraSetup || ''}\n\n${parts.join('\n\n')}\n\nmodule.exports = { ${names.join(', ')} };\n`;
    const m = { exports: {} };
    try {
        new Function('module', 'exports', 'require', body)(m, m.exports, require);
    } catch (err) {
        throw new Error(`buildModule([${names.join(', ')}]) failed to evaluate: ${err.message}`);
    }
    return m.exports;
}

// --- Tiny assertion runner -------------------------------------------------

let pass = 0, fail = 0, currentSuite = '';
const failures = [];

// Awaits fn()'s return value if it's a promise. This matters: two suites contain internal async
// work (forceRenderAllVisibleCards, autoFetchUnclassifiedCompanies), and without every suite call
// site being awaited in file order, those async blocks race against each other and whichever
// happens to finish first calls process.exit() (via finish(), at the bottom of this file) while
// the other's assertions are still pending — they silently never run, no error, just a suite
// header with nothing under it. Every suite() call below must be awaited for this to be safe.
async function suite(name, fn) {
    currentSuite = name;
    console.log(`\n=== ${name} ===`);
    await fn();
}

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log(`  PASS  ${label}`);
    } else {
        fail++;
        failures.push(`[${currentSuite}] ${label}`);
        console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    }
}

function checkTrue(label, actual) { check(label, !!actual, true); }

function checkThrows(label, fn, messageFragment) {
    try {
        fn();
        fail++;
        failures.push(`[${currentSuite}] ${label}`);
        console.log(`  FAIL  ${label} — expected a throw, got none`);
    } catch (err) {
        if (!messageFragment || err.message.includes(messageFragment)) {
            pass++;
            console.log(`  PASS  ${label} (${err.message.split('\n')[0]})`);
        } else {
            fail++;
            failures.push(`[${currentSuite}] ${label}`);
            console.log(`  FAIL  ${label}\n        expected message containing "${messageFragment}"\n        actual   "${err.message}"`);
        }
    }
}

// All suites run inside one top-level async IIFE so every `await suite(...)` below actually
// sequences them in file order — see suite()'s comment above for why that's required, not
// optional, once more than one suite does async work internally.
(async () => {

// ===========================================================================
// Suite: slug generation — the historically fragile part of this file (v6.2's silent regression,
// then StepSecurity/PHINIA/PW-PhysicsWallah/Refyne/HackerRank fixes across v6.3-v6.5).
// ===========================================================================
await suite('generateCandidateSlugs — historical regression coverage', () => {
    const m = buildModule(['toSlug', 'generateCandidateSlugs', 'LEGAL_SUFFIX_PATTERN', 'JUNK_SLUGS'], '');

    const cases = [
        ['PHINIA', 'phiniainc'],                          // v6.5: concatenated short-suffix candidates
        ['StepSecurity', 'step-security'],                 // v6.4: camelCase split before lowercasing
        ['PW PhysicsWallah', 'physicswallah'],              // v6.3: drop-first-word restored
        ['Refyne India Pvt Ltd', 'refyne'],                 // v6.3: legal-suffix stripping
        ['HackerRank', 'hackerrank']
    ];
    for (const [name, expectedSlug] of cases) {
        const candidates = m.generateCandidateSlugs(name).slice(0, 20);
        checkTrue(`"${name}" generates "${expectedSlug}" within top 20 candidates`, candidates.includes(expectedSlug));
    }

    check('empty input returns no candidates', m.generateCandidateSlugs(''), []);
    check('empty input returns no candidates (null)', m.generateCandidateSlugs(null), []);
});

// ===========================================================================
// Suite: size extraction & categorization — v6.4 deliberately removed the JSON-LD and unscoped
// regex strategies after they cached a wrong bucket for a real company (Exotel). This suite pins
// that removal: it must stay gone.
// ===========================================================================
await suite('extractSizeFromHtml / categorizeSize', () => {
    const m = buildModule(['categorizeSize', 'extractSizeFromHtml'], '');

    check('data-test-id="about-us__size" strategy',
        m.extractSizeFromHtml('<dt>Company size</dt><dd data-test-id="about-us__size">1,001-5,000 employees</dd>'),
        '1,001-5,000 employees');

    check('"Company size" label strategy',
        m.extractSizeFromHtml('Company size 501-1,000 employees'),
        '501-1,000 employees');

    check('10,001+ bucket recognized',
        m.categorizeSize('10,001+ employees'), '10,001+ employees');

    // v6.4: the Exotel regression. JSON-LD numberOfEmployees and an unscoped "N-M employees"
    // regex both read numbers unrelated to the real declared bucket — must NOT be trusted.
    check('JSON-LD numberOfEmployees is NOT trusted (must stay removed)',
        m.extractSizeFromHtml('<script type="application/ld+json">{"numberOfEmployees":{"value":747}}</script>'),
        null);
    check('an unscoped stray "N-M employees" elsewhere on the page is NOT trusted',
        m.extractSizeFromHtml('<div>Similar pages: TinyCo 11-50 employees</div>'),
        null);
    check('no size data at all returns null, not a guess', m.extractSizeFromHtml('<div>nothing relevant here</div>'), null);
});

// ===========================================================================
// Suite: extractSlugFromSearchHtml (v7.29, first-ever coverage) — the search-fallback engine's
// (Bing/Google/DuckDuckGo) slug parser. Same apostrophe-truncation bug as getCardInfo() and the
// other DOM-based extractors ("victoria's-secret" -> "victoria"), fixed narrowly here (widened the
// allowlist to include apostrophes, not switched to a fully-negated class) since this parses
// unstructured search-result text/HTML, not a real URL object - see the fix's own comment.
// ===========================================================================
await suite('extractSlugFromSearchHtml', () => {
    const m = buildModule(['extractSlugFromSearchHtml', 'RESERVED_SLUGS'], '');

    check('a real slug containing an apostrophe is captured whole, not truncated at it',
        m.extractSlugFromSearchHtml('<a href="https://www.linkedin.com/company/victoria\'s-secret/">Victoria\'s Secret | LinkedIn</a>'),
        "victoria's-secret");

    check('an ordinary slug with no special characters still works exactly as before',
        m.extractSlugFromSearchHtml('<a href="https://www.linkedin.com/company/tech-mahindra/">Tech Mahindra</a>'),
        'tech-mahindra');

    check('URL-encoded form (%2F) still decodes and parses correctly',
        m.extractSlugFromSearchHtml('linkedin.com%2Fcompany%2Fhandshake%2Fabout'),
        'handshake');

    check('no LinkedIn company link anywhere in the HTML -> null, not a crash',
        m.extractSlugFromSearchHtml('<div>no relevant links here</div>'), null);

    check('empty input -> null', m.extractSlugFromSearchHtml(''), null);
});

// ===========================================================================
// Suite: verifyPageMatchesCompany — the Handshake collision guard (v6.5). Documented limitation:
// catches a MISMATCHED name, cannot disambiguate two real companies sharing the same name.
// ===========================================================================
await suite('verifyPageMatchesCompany', () => {
    const m = buildModule(['verifyPageMatchesCompany', 'extractDisplayName', 'normalizeCompanyName', 'LEGAL_SUFFIX_PATTERN'], '');
    const target = m.normalizeCompanyName('Handshake');

    checkTrue('same-name page passes (documented limitation: cannot disambiguate a true collision)',
        m.verifyPageMatchesCompany('<title>Handshake | LinkedIn</title>', target));
    check('a differently-named page is rejected',
        m.verifyPageMatchesCompany('<title>Some Totally Different Corp | LinkedIn</title>', target), false);
    checkTrue('substring match passes (e.g. "Exotel" target vs "Exotel Techcom" page)',
        m.verifyPageMatchesCompany('<title>Exotel | LinkedIn</title>', m.normalizeCompanyName('Exotel Techcom Private Limited')));
    checkTrue('missing <title> entirely does not block (nothing to check against)',
        m.verifyPageMatchesCompany('<div>no title tag here</div>', target));
});

// ===========================================================================
// Suite: badge data scraping — scanCompanyInlineInfo's three fallback tiers (spans, about-company
// module, and v7.1's findAboutCompanySection() text-based fallback for CSS-module-hashed pages).
// ===========================================================================
await suite('scanCompanyInlineInfo / findAboutCompanySection', () => {
    const m = buildModule(['scanCompanyInlineInfo', 'findAboutCompanySection'], '');

    function makeDoc(spanTexts, moduleText) {
        return {
            querySelectorAll(sel) {
                if (sel === 'span.jobs-company__inline-information') return spanTexts.map((t) => ({ textContent: t }));
                return [];
            },
            querySelector(sel) {
                if (sel === '[data-view-name="job-details-about-company-module"]' || sel === '.jobs-company_box') {
                    return moduleText != null ? { textContent: moduleText } : null;
                }
                return null;
            }
        };
    }

    check('tier 1: inline spans, real values from a live TCS card',
        m.scanCompanyInlineInfo(makeDoc(['10,001+ employees', '721,918 on LinkedIn'], null)),
        { sizeText: '10,001+ employees', countText: '721,918 on LinkedIn' });

    check('tier 1: span order does not matter',
        m.scanCompanyInlineInfo(makeDoc(['721,918 on LinkedIn', '10,001+ employees'], null)),
        { sizeText: '10,001+ employees', countText: '721,918 on LinkedIn' });

    check('tier 2: falls back to the about-company-module text blob when no spans exist',
        m.scanCompanyInlineInfo(makeDoc([], 'About the company Tata Consultancy Services 10,001+ employees 721,918 on LinkedIn')),
        { sizeText: '10,001+ employees', countText: '721,918 on LinkedIn' });

    check('nothing rendered yet -> both empty, not a crash',
        m.scanCompanyInlineInfo(makeDoc([], null)), { sizeText: '', countText: '' });
});

// ===========================================================================
// Suite: captureCompanyPageIfPresent — passive re-verify (v7.26). User's own question exposed the
// gap directly: both this and captureFromJobDetailPane used to bail out the instant a company was
// ALREADY cached, so visiting the company's own live page — the most authoritative source this
// file has — taught it nothing if the value happened to be stale. Company sizes drift (a startup
// can cross a bucket within a year); a live view is exactly the moment to reconcile that, for free,
// since the request already happened for browsing reasons. extractSizeFromHtml is mocked directly
// (its own correctness is covered by its own suite) so these tests are only about the decision made
// with whatever it returns: overwrite on drift, leave alone but re-timestamp when unchanged, never
// touch a MANUAL_EDIT entry.
// ===========================================================================
await suite('captureCompanyPageIfPresent — passive re-verify', () => {
    function run({ normalizedName = 'blackline', existingBucket, existingMeta, liveSize, path = '/company/blackline/', existingSlug, slugOverride }) {
        const setup = `
            ${extractDeclaration('CACHE_SOURCE', SRC)}
            let fakeClock = 5000;
            const Date = { now: () => fakeClock };
            let location = { pathname: ${JSON.stringify(path)} };
            const document = {}; // default sourceDoc fallback; getSearchDocuments always supplies a real one below
            const RESERVED_SLUGS = new Set();
            function getSearchDocuments() {
                return [{ querySelector: () => ({ textContent: 'BlackLine' }), documentElement: { outerHTML: '<html></html>' } }];
            }
            function normalizeCompanyName() { return ${JSON.stringify(normalizedName)}; }
            let extractCalls = 0;
            function extractSizeFromHtml() { extractCalls++; return ${liveSize === undefined ? 'null' : JSON.stringify(liveSize)}; }
            let companyCache = ${existingBucket !== undefined ? JSON.stringify({ [normalizedName]: existingBucket }) : '{}'};
            let slugCache = ${JSON.stringify(existingSlug ? { [normalizedName]: existingSlug } : {})};
            let slugOverrides = ${JSON.stringify(slugOverride ? { [normalizedName]: slugOverride } : {})};
            let nameCollisions = {};
            let companyCacheMeta = ${existingMeta ? JSON.stringify({ [normalizedName]: existingMeta }) : '{}'};
            let failedCache = { ${JSON.stringify(normalizedName)}: 1 };
            let lastCapturedPath = null;
            let saveCacheCalls = 0, saveSlugCacheCalls = 0, saveCacheMetaCalls = 0, saveFailedCacheCalls = 0, filterCalls = 0;
            function saveCache() { saveCacheCalls++; }
            function saveSlugCache() { saveSlugCacheCalls++; }
            function saveCacheMeta() { saveCacheMetaCalls++; }
            function saveFailedCache() { saveFailedCacheCalls++; }
            function saveNameCollisions() {}
            function filterJobListCards() { filterCalls++; }
        `;
        // v7.35: recordSlugObservation is extracted for real, not stubbed — the collision-detection
        // behaviour on this path is part of what these tests now cover. v7.37: recordSlugObservation
        // now calls getSlugFor() internally, so that has to be extracted for real too.
        const recordFn = extractDeclaration('recordCacheMeta', SRC);
        const slugForFn = extractDeclaration('getSlugFor', SRC);
        const obsFn = extractDeclaration('recordSlugObservation', SRC);
        const fn = extractDeclaration('captureCompanyPageIfPresent', SRC);
        const body = `${setup}\n\n${recordFn}\n\n${slugForFn}\n\n${obsFn}\n\n${fn}\n\nmodule.exports = { captureCompanyPageIfPresent,
            get companyCache() { return companyCache; }, get companyCacheMeta() { return companyCacheMeta; },
            get failedCache() { return failedCache; }, get extractCalls() { return extractCalls; },
            get saveCacheCalls() { return saveCacheCalls; }, get saveCacheMetaCalls() { return saveCacheMetaCalls; },
            get filterCalls() { return filterCalls; }, get slugCache() { return slugCache; },
            get nameCollisions() { return nameCollisions; } };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    {
        const mod = run({ liveSize: '1,001-5,000 employees' });
        mod.captureCompanyPageIfPresent();
        check('not yet cached — still captures normally (baseline unchanged)', mod.companyCache.blackline, '1,001-5,000 employees');
        check('tagged with the right source', mod.companyCacheMeta.blackline.source, 'company-page');
        check('failed-cooldown entry cleared', mod.failedCache.blackline, undefined);
        mod.captureCompanyPageIfPresent(); // same path again
        check('still gated to once per path (existing v6.x behavior)', mod.extractCalls, 1);
    }

    {
        const mod = run({
            existingBucket: '501-1,000 employees', liveSize: '501-1,000 employees',
            existingMeta: { source: 'company-page', timestamp: 111 }
        });
        mod.captureCompanyPageIfPresent();
        check('already cached, live value UNCHANGED — value stays the same', mod.companyCache.blackline, '501-1,000 employees');
        check('but re-confirmed with a fresh timestamp ("last verified" must move)', mod.companyCacheMeta.blackline.timestamp !== 111, true);
        check('no pointless cache rewrite for an unchanged value', mod.saveCacheCalls, 0);
        check('meta IS re-saved (that\'s the whole point)', mod.saveCacheMetaCalls, 1);
    }

    {
        const mod = run({ existingBucket: '201-500 employees', liveSize: '501-1,000 employees' });
        mod.captureCompanyPageIfPresent();
        check('already cached, live value DRIFTED — cache is updated to the current value', mod.companyCache.blackline, '501-1,000 employees');
        check('the actual rewrite happens', mod.saveCacheCalls, 1);
    }

    {
        const mod = run({
            existingBucket: '11-50 employees', liveSize: '10,001+ employees',
            existingMeta: { source: 'manual-edit', timestamp: 555 }
        });
        mod.captureCompanyPageIfPresent();
        check('a MANUAL_EDIT entry is NEVER overwritten, no matter how different the live page reads',
            mod.companyCache.blackline, '11-50 employees');
        check('its provenance is left completely untouched too', mod.companyCacheMeta.blackline, { source: 'manual-edit', timestamp: 555 });
        check('never even bothers reading the page for a value it would never use', mod.extractCalls, 0);
    }

    {
        const mod = run({ liveSize: undefined }); // page hasn't rendered the size yet
        mod.captureCompanyPageIfPresent();
        check('page not rendered yet — nothing captured, no crash', mod.companyCache.blackline, undefined);
        check('no saves fired for a no-op', mod.saveCacheCalls + mod.saveCacheMetaCalls, 0);
    }

    // v7.29: reported live — visiting https://www.linkedin.com/company/victoria's-secret/ stored
    // the slug as just "victoria", truncated at the apostrophe by the old character allowlist.
    {
        const mod = run({ normalizedName: 'victoriassecret', liveSize: '5,001-10,000 employees', path: "/company/victoria's-secret/" });
        mod.captureCompanyPageIfPresent();
        check('the real slug (with its apostrophe intact) is captured from the page URL, not truncated',
            mod.slugCache.victoriassecret, "victoria's-secret");
    }
});

// ===========================================================================
// Suite: captureFromJobDetailPane — passive re-verify (v7.26). Same fix as above, applied to the
// job-detail pane path, plus one extra wrinkle: unlike captureCompanyPageIfPresent (already gated
// to once per path by lastCapturedPath), this function used to have NO equivalent gate once
// settled — re-verifying an already-cached company would otherwise re-scan the pane on every single
// runCycle tick (~every 1s) for as long as that job stays open. reverifiedDetailJobId closes that
// gap without breaking the pre-existing "keep retrying every tick while the pane hasn't rendered
// yet" behavior for a NOT-yet-cached company.
// ===========================================================================
await suite('captureFromJobDetailPane — passive re-verify', () => {
    function run({ normalizedName = 'blackline', jobId = '4001', existingBucket, existingMeta, liveSize, existingSlug, discoveredSlug, slugOverride }) {
        const setup = `
            ${extractDeclaration('CACHE_SOURCE', SRC)}
            const DEBUG = false;
            let fakeClock = 0;
            const Date = { now: () => fakeClock };
            function advanceClock(ms) { fakeClock += ms; }
            // v7.61: mutable so a test can simulate clicking through to a DIFFERENT job, which is what
            // the yield window counts. It was a const while every scenario here concerned one job.
            let JOB_ID = ${JSON.stringify(jobId)};
            function setJobId(id) { JOB_ID = id; }
            function getCurrentJobIdFromUrl() { return JOB_ID; }
            function getCardElements() { return [{ __id: 0 }]; }
            function getCardInfo() { return { jobId: JOB_ID, normalizedName: ${JSON.stringify(normalizedName)} }; }
            let extractCalls = 0;
            function extractCompanySizeFromDetailPane() { extractCalls++; return ${liveSize === undefined ? 'null' : JSON.stringify(liveSize)}; }
            // v7.27: mocked directly (its own DOM-scoping logic is covered by the dedicated suite
            // below) — this suite is only about the DECISION to call it and what happens with its
            // result, matching how extractCompanySizeFromDetailPane is already mocked above.
            let slugExtractCalls = 0;
            function extractCompanySlugFromDetailPane() { slugExtractCalls++; return ${discoveredSlug === undefined ? 'null' : JSON.stringify(discoveredSlug)}; }
            let companyCache = ${existingBucket !== undefined ? JSON.stringify({ [normalizedName]: existingBucket }) : '{}'};
            let companyCacheMeta = ${existingMeta ? JSON.stringify({ [normalizedName]: existingMeta }) : '{}'};
            let slugCache = ${existingSlug !== undefined ? JSON.stringify({ [normalizedName]: existingSlug }) : '{}'};
            let slugOverrides = ${JSON.stringify(slugOverride ? { [normalizedName]: slugOverride } : {})};
            let failedCache = { ${JSON.stringify(normalizedName)}: 1 };
            let lastSeenDetailJobId = null;
            let detailPaneSettleAt = 0;
            let reverifiedDetailJobId = null;
            // v7.61: the yield-tracking state. Not mocked out — the real recordDetailReadOutcome /
            // detailYieldVerdict are extracted below so this suite proves the new bookkeeping didn't
            // disturb any of the existing capture behaviour it's been guarding since v6.5.
            let detailAttemptedJobId = null;
            let detailSucceededJobId = null;
            let saveCacheCalls = 0, saveCacheMetaCalls = 0, saveFailedCacheCalls = 0, saveSlugCacheCalls = 0, filterCalls = 0;
            function saveCache() { saveCacheCalls++; }
            function saveCacheMeta() { saveCacheMetaCalls++; }
            function saveFailedCache() { saveFailedCacheCalls++; }
            function saveSlugCache() { saveSlugCacheCalls++; }
            function filterJobListCards() { filterCalls++; }
        `;
        const settleConst = extractDeclaration('DETAIL_PANE_SETTLE_MS', SRC);
        const recordFn = extractDeclaration('recordCacheMeta', SRC);
        // v7.35: extracted for real so the override guard is genuinely exercised here.
        const slugForFn = extractDeclaration('getSlugFor', SRC);
        const fn = extractDeclaration('captureFromJobDetailPane', SRC);
        const yieldDeps = ['featureHealth', 'setFeatureHealth', 'DETAIL_YIELD_WINDOW', 'detailReadOutcomes',
            'recordDetailReadOutcome', 'detailYieldVerdict'].map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${settleConst}\n\n${yieldDeps}\n\n${recordFn}\n\n${slugForFn}\n\n${fn}\n\nmodule.exports = { captureFromJobDetailPane, advanceClock, setJobId, DETAIL_YIELD_WINDOW,
            get featureHealth() { return featureHealth; }, get detailReadOutcomes() { return detailReadOutcomes; },
            get companyCache() { return companyCache; }, get companyCacheMeta() { return companyCacheMeta; },
            get slugCache() { return slugCache; }, get slugExtractCalls() { return slugExtractCalls; },
            get saveSlugCacheCalls() { return saveSlugCacheCalls; },
            get failedCache() { return failedCache; }, get extractCalls() { return extractCalls; },
            get saveCacheCalls() { return saveCacheCalls; }, get saveCacheMetaCalls() { return saveCacheMetaCalls; },
            get filterCalls() { return filterCalls; } };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    // Every scenario needs to get PAST the settle window first — first call just registers the
    // jobId and starts the clock (v6.5 behavior, unchanged); advancing past DETAIL_PANE_SETTLE_MS
    // and calling again is what actually processes it.
    function settledCapture(mod) {
        mod.captureFromJobDetailPane();
        mod.advanceClock(2000);
        mod.captureFromJobDetailPane();
    }

    {
        const mod = run({ liveSize: '1,001-5,000 employees' });
        settledCapture(mod);
        check('not yet cached — still captures normally (baseline unchanged)', mod.companyCache.blackline, '1,001-5,000 employees');
        check('tagged with the right source', mod.companyCacheMeta.blackline.source, 'job-detail-pane');
        check('failed-cooldown entry cleared', mod.failedCache.blackline, undefined);
    }

    {
        const mod = run({
            existingBucket: '501-1,000 employees', liveSize: '501-1,000 employees',
            existingMeta: { source: 'job-detail-pane', timestamp: 111 }
        });
        settledCapture(mod);
        check('already cached, live value UNCHANGED — value stays the same', mod.companyCache.blackline, '501-1,000 employees');
        check('but re-confirmed with a fresh timestamp', mod.companyCacheMeta.blackline.timestamp !== 111, true);
        check('no pointless cache rewrite for an unchanged value', mod.saveCacheCalls, 0);
        check('meta IS re-saved', mod.saveCacheMetaCalls, 1);
    }

    {
        const mod = run({ existingBucket: '201-500 employees', liveSize: '501-1,000 employees' });
        settledCapture(mod);
        check('already cached, live value DRIFTED — cache updates to the current value', mod.companyCache.blackline, '501-1,000 employees');
        check('the actual rewrite happens', mod.saveCacheCalls, 1);
    }

    {
        const mod = run({
            existingBucket: '11-50 employees', liveSize: '10,001+ employees',
            existingMeta: { source: 'manual-edit', timestamp: 555 }
        });
        settledCapture(mod);
        check('a MANUAL_EDIT entry is NEVER overwritten via the detail pane either', mod.companyCache.blackline, '11-50 employees');
        check('its provenance is left completely untouched too', mod.companyCacheMeta.blackline, { source: 'manual-edit', timestamp: 555 });
        check('never even bothers reading the pane for a value it would never use', mod.extractCalls, 0);
    }

    {
        // The new gap this version closes: without reverifiedDetailJobId, sitting on the SAME job
        // for a while would re-scan the pane every single tick for no reason once already handled.
        const mod = run({ existingBucket: '201-500 employees', liveSize: '501-1,000 employees' });
        settledCapture(mod);
        check('sanity: the settled capture above did one real read', mod.extractCalls, 1);
        mod.captureFromJobDetailPane(); // still the same job, still settled — nothing new happened
        check('once handled, does not re-scan on every subsequent tick while lingering on the same job', mod.extractCalls, 1);
    }

    {
        // The pre-existing behavior that must NOT regress: while the pane genuinely hasn't
        // rendered a size yet, it should keep trying every tick, not give up after one miss.
        const mod = run({ liveSize: undefined });
        settledCapture(mod);
        check('sanity: first real attempt found nothing yet', mod.companyCache.blackline, undefined);
        mod.captureFromJobDetailPane(); // same job, still settled, pane STILL not rendered
        check('keeps retrying every tick until the pane actually renders (no false "handled" latch)', mod.extractCalls, 2);
    }

    // v7.27: user flagged the real flaw — this function used to never record a slug at all, so a
    // company only ever encountered by clicking through jobs could never become eligible for the
    // planned re-verify sweep (confirmed live: "honeywell technologies" via Auto-Fetch got a slug,
    // "altudo" via manual click didn't).
    {
        const mod = run({ liveSize: '5,001-10,000 employees', discoveredSlug: 'blackline' });
        settledCapture(mod);
        check('no slug on file yet, one is discoverable — gets captured', mod.slugCache.blackline, 'blackline');
        check('slug cache is actually persisted', mod.saveSlugCacheCalls, 1);
    }

    {
        const mod = run({ liveSize: '5,001-10,000 employees', discoveredSlug: undefined });
        settledCapture(mod);
        check('no slug on file, none discoverable in the pane either — stays empty, no crash', mod.slugCache.blackline, undefined);
        check('no pointless save for a no-op', mod.saveSlugCacheCalls, 0);
    }

    {
        // A company's real slug essentially never changes once known — unlike size, there's
        // nothing to "re-verify" here, so this should be pure upside with zero added cost for the
        // (very common) case of a company that already has one.
        const mod = run({ liveSize: '5,001-10,000 employees', existingSlug: 'blackline-inc', discoveredSlug: 'something-else' });
        settledCapture(mod);
        check('a slug already on file is left exactly as-is, never overwritten', mod.slugCache.blackline, 'blackline-inc');
        check('does not even bother extracting when nothing is needed', mod.slugExtractCalls, 0);
    }

    // v7.61 — the yield window's bookkeeping, exercised through the REAL capture function rather
    // than by calling recordDetailReadOutcome() directly. The failure this guards against is
    // specific: a size-less job keeps retrying every tick for as long as it stays open, so recording
    // at the point of failure would let ONE ordinary company (LinkedIn genuinely omits the size
    // field for plenty of them) fill the whole window within seconds and raise a false alarm.
    {
        const mod = run({ liveSize: undefined }); // pane never yields a size for this job
        mod.captureFromJobDetailPane();
        mod.advanceClock(2000);
        for (let i = 0; i < 25; i++) mod.captureFromJobDetailPane(); // 25 retry ticks on the SAME job
        check('a job that keeps failing records NOTHING while it is still open, however many ticks pass',
            mod.detailReadOutcomes.length, 0);
        check('and stays idle rather than alarming off a single unread job', mod.featureHealth.detailCapture.status, 'idle');

        mod.setJobId('4002'); // click through to a different job
        mod.captureFromJobDetailPane();
        check('exactly one failure is recorded, once, when we finally move off that job',
            mod.detailReadOutcomes, [false]);
    }

    {
        const mod = run({ liveSize: '51-200 employees' });
        settledCapture(mod);
        check('a successful read records exactly one success', mod.detailReadOutcomes, [true]);
        check('and reports ok, not the idle it was set to on entry', mod.featureHealth.detailCapture.status, 'ok');
        mod.captureFromJobDetailPane(); // further ticks on the same, already-read job
        check('re-ticking an already-read job does not record it a second time', mod.detailReadOutcomes, [true]);
    }

    {
        const mod = run({ liveSize: '51-200 employees', existingMeta: { source: 'manual-edit', at: 1 } });
        settledCapture(mod);
        mod.setJobId('4002');
        mod.captureFromJobDetailPane();
        check('a job deliberately SKIPPED for MANUAL_EDIT is not a failed read and never counts as one',
            mod.detailReadOutcomes, []);
    }

    {
        // A full window of distinct jobs that each genuinely failed — the real signal.
        const mod = run({ liveSize: undefined });
        for (let i = 0; i < mod.DETAIL_YIELD_WINDOW; i++) {
            mod.setJobId(`50${i}`);
            mod.captureFromJobDetailPane();   // registers the switch (and banks the previous failure)
            mod.advanceClock(2000);
            mod.captureFromJobDetailPane();   // settled — attempts the read, fails
        }
        mod.setJobId('9999');
        mod.captureFromJobDetailPane();       // banks the last one, completing the window
        check('the window is only complete once the final job is banked, and not one job sooner',
            mod.detailReadOutcomes.length, mod.DETAIL_YIELD_WINDOW);
        // The verdict is read at function entry, so it reflects the window as it stood at the START
        // of that call — the tenth failure was banked during it. The next cycle (~1s later in the
        // real script) is the one that surfaces it, which is immaterial for a condition that took ten
        // job clicks to establish.
        mod.captureFromJobDetailPane();
        check('a full window of DISTINCT failing jobs is what it takes to alarm',
            mod.featureHealth.detailCapture.status, 'failed');
        check('and the detail names the About-the-company module as the likely cause',
            /About-the-company selectors may have changed$/.test(mod.featureHealth.detailCapture.detail), true);
    }
});

// ===========================================================================
// Suite: extractCompanySlugFromDetailPane (v7.27) — built from live evidence gathered via a
// temporary diagnostic (since removed): a document returned by getSearchDocuments() can ALSO
// render an unrelated "recommended jobs" sidebar with several OTHER companies' /company/ links
// mixed in, and even within the correct document, an unrelated messaging/admin widget link
// (.../company/15123156/admin/inbox) matches the same href pattern but is a bare numeric ID, not a
// real slug. These tests reproduce both exact shapes of noise seen live, not hypothetical ones.
// ===========================================================================
await suite('extractCompanySlugFromDetailPane — scoped to the trusted regions only', () => {
    function makeLink(href, text) {
        return { href, textContent: text, querySelector: () => null, querySelectorAll: () => [] };
    }
    // A minimal DOM node: querySelector searches its own registered "descendant" link (if any);
    // parentElement chains upward for the ancestor-walk. Good enough to reproduce the real shapes
    // observed live without needing a full DOM implementation.
    function makeNode(descendantLink, parent) {
        const node = {
            parentElement: parent || null,
            querySelector(sel) { return sel.indexOf('/company/') !== -1 ? descendantLink : null; }
        };
        return node;
    }

    function run({ infoSpanAncestorLink, aboutSectionLink, decoyLinks = [], docCount = 1, matchingDocIndex = 0 }) {
        const setup = `
            ${extractDeclaration('RESERVED_SLUGS', SRC)}
            const docs = [];
            for (let i = 0; i < ${docCount}; i++) {
                if (i === ${matchingDocIndex}) {
                    docs.push({
                        querySelector(sel) {
                            if (sel === 'span.jobs-company__inline-information') return ${infoSpanAncestorLink ? 'infoSpanNode' : 'null'};
                            return null;
                        }
                    });
                } else {
                    // A DIFFERENT, unrelated document — e.g. the top-level page's own "recommended
                    // jobs" sidebar, which live evidence showed can carry several OTHER companies'
                    // real /company/ links. Must be ignored entirely, not just deprioritized.
                    docs.push({
                        querySelectorAll(sel) { return sel.indexOf('/company/') !== -1 ? ${JSON.stringify(decoyLinks)}.map((h) => ({ href: h })) : []; },
                        querySelector() { return null; }
                    });
                }
            }
            function getSearchDocuments() { return docs; }
            ${infoSpanAncestorLink ? `const leafLink = ${JSON.stringify(infoSpanAncestorLink)};
            const infoSpanNode = { parentElement: { parentElement: { querySelector(sel) { return sel.indexOf('/company/') !== -1 ? { href: leafLink } : null; } } } };` : ''}
            function findAboutCompanySection() { return ${aboutSectionLink ? `{ querySelector(sel) { return sel.indexOf('/company/') !== -1 ? { href: ${JSON.stringify(aboutSectionLink)} } : null; } }` : 'null'}; }
        `;
        // v7.33: findScopedCompanyLink was factored out of extractCompanySlugFromDetailPane() (now
        // also reused by findBadgeHeader()'s scoped fallback) — extracted here for real alongside it
        // rather than mocked, so this suite still exercises the real region-scoping logic end to end.
        return buildModule(['findScopedCompanyLink', 'extractCompanySlugFromDetailPane'], setup);
    }

    {
        const m = run({ infoSpanAncestorLink: 'https://www.linkedin.com/company/tech-mahindra/life/' });
        check('finds a real slug via the inline-info span\'s ancestor chain', m.extractCompanySlugFromDetailPane(), 'tech-mahindra');
    }

    {
        const m = run({ aboutSectionLink: 'https://www.linkedin.com/company/altudo/' });
        check('falls back to the about-company section when the inline-info region has nothing', m.extractCompanySlugFromDetailPane(), 'altudo');
    }

    // v7.29: reported live — a real slug containing an apostrophe ("victoria's-secret") was
    // truncated to "victoria" by the old character allowlist. Fixed by matching up to the next
    // path separator instead of guessing which characters are "safe".
    {
        const m = run({ infoSpanAncestorLink: "https://www.linkedin.com/company/victoria's-secret/life/" });
        check('a real slug containing an apostrophe is captured whole, not truncated at it',
            m.extractCompanySlugFromDetailPane(), "victoria's-secret");
    }

    {
        // The exact live shape: a document with SIX other companies' real /company/ links (a
        // sidebar widget), but none of them inside either trusted region.
        const m = run({
            decoyLinks: [
                'https://www.linkedin.com/company/google/life/', 'https://www.linkedin.com/company/amazon/life/',
                'https://www.linkedin.com/company/deloitte/life/', 'https://www.linkedin.com/company/jpmorganchase/life/',
                'https://www.linkedin.com/company/ernstandyoung/life/', 'https://www.linkedin.com/company/tata-consultancy-services/life/'
            ]
        });
        check('a document full of OTHER companies\' links (unscoped noise) never gets picked up', m.extractCompanySlugFromDetailPane(), null);
    }

    {
        // The exact live shape: a numeric messaging/admin link that matches the href pattern but
        // isn't a real slug, sitting OUTSIDE the trusted regions (same as observed live).
        const m = run({ decoyLinks: ['https://www.linkedin.com/company/15123156/admin/inbox'] });
        check('a numeric junk ID outside the trusted regions is never picked up', m.extractCompanySlugFromDetailPane(), null);
    }

    {
        // Defense in depth: even if a numeric junk value somehow sat INSIDE a trusted region, it
        // must still be rejected, not just excluded by scoping alone.
        const m = run({ aboutSectionLink: 'https://www.linkedin.com/company/15123156/admin/inbox' });
        check('a numeric junk ID is rejected even when it IS inside a trusted region', m.extractCompanySlugFromDetailPane(), null);
    }

    {
        const m = run({});
        check('nothing found anywhere -> null, not a crash', m.extractCompanySlugFromDetailPane(), null);
    }

    {
        // Mirrors the real getSearchDocuments() order: the wrong document (noise) comes first, the
        // real detail-pane document (with the actual answer) comes second - exactly the order seen
        // live. Must not stop at the first document just because it had links.
        const m = run({
            docCount: 2, matchingDocIndex: 1,
            aboutSectionLink: 'https://www.linkedin.com/company/tech-mahindra/life/'
        });
        // matchingDocIndex only affects doc[1]; doc[0] is the decoy — give it some noise too.
        check('keeps checking subsequent documents when an earlier one has noise but no real match',
            m.extractCompanySlugFromDetailPane(), 'tech-mahindra');
    }
});

// ===========================================================================
// Suite: findBadgeHeader — scoped fallback (v7.33) — reported live: on a page where all five named
// BADGE_HEADER_SELECTORS miss (yet another LinkedIn layout variant), the OLD unscoped
// 'a[href*="/company/"]' fallback could match some OTHER /company/ link on the page — e.g. from a
// job card in the list, which getCardInfo() already proves every card carries — before ever
// reaching the current job's own detail-pane header. Confirmed via a diagnostic (dbgBadgeOnce)
// showing header:true with a real selector match, yet no badge visible where expected. Now scoped
// to findScopedCompanyLink() (v7.28's region-scoping, factored out and reused here).
// ===========================================================================
await suite('findBadgeHeader — scoped fallback only, not document-wide', () => {
    function build({ infoSpanAncestorLink, aboutSectionLink, decoyGlobalLink } = {}) {
        const setup = `
            const doc = {
                querySelector(sel) {
                    // The exact selector the OLD, unscoped code queried the whole document with
                    // directly. Checked FIRST and independently of anything else, so this test stays
                    // meaningful even if BADGE_HEADER_SELECTORS itself changes shape later — it's
                    // pinning "findBadgeHeader() must never issue this exact unscoped query", not
                    // "this string isn't in some array".
                    if (sel === 'a[href*="/company/"]') return ${decoyGlobalLink ? JSON.stringify({ href: decoyGlobalLink }) : 'null'};
                    if (sel === 'span.jobs-company__inline-information') return ${infoSpanAncestorLink ? 'infoSpanNode' : 'null'};
                    return null; // simulates all five named header selectors missing (the reported layout)
                },
                // v7.48: findTopCardCompanyLink now runs BEFORE findScopedCompanyLink and scans via
                // querySelectorAll, not querySelector — kept empty here so it always misses and falls
                // through to findScopedCompanyLink unchanged, exactly like these tests already assume.
                // findTopCardCompanyLink's own logic is covered separately below.
                querySelectorAll(sel) { return sel === 'a[href*="/company/"]' ? [] : []; }
            };
            function getSearchDocuments() { return [doc]; }
            function getCardElements() { return []; }
            ${infoSpanAncestorLink ? `const infoSpanNode = { parentElement: { parentElement: { querySelector(sel) { return sel.indexOf('/company/') !== -1 ? { href: ${JSON.stringify(infoSpanAncestorLink)} } : null; } } } };` : ''}
            function findAboutCompanySection() { return ${aboutSectionLink ? `{ querySelector(sel) { return sel.indexOf('/company/') !== -1 ? { href: ${JSON.stringify(aboutSectionLink)} } : null; }, contains() { return false; } }` : 'null'}; }
        `;
        // v7.61: selectorStats/recordSelectorHit extracted for real rather than stubbed, so these
        // tests also pin that attribution never changes WHICH header wins — only records it.
        return buildModule(['selectorStats', 'recordSelectorHit', 'BADGE_HEADER_SELECTORS', 'BADGE_TOP_CARD_LINK_LABEL',
            'COMPANY_ARIA_LABEL_SELECTOR', 'BADGE_ARIA_LABEL_LINK_LABEL', 'findAriaLabelledCompanyLink',
            'findScopedCompanyLink', 'findTopCardCompanyLink', 'findBadgeHeader'], setup);
    }

    // The exact reported live shape: all named selectors miss, a decoy /company/ link exists
    // elsewhere in the document (e.g. a list card's own link) — must never be used as the header.
    {
        const m = build({ decoyGlobalLink: 'https://www.linkedin.com/company/some-other-company/' });
        check('a decoy /company/ link OUTSIDE the trusted regions is never used as the header', m.findBadgeHeader(), null);
    }

    {
        const m = build({ infoSpanAncestorLink: 'https://www.linkedin.com/company/flexiple/' });
        const result = m.findBadgeHeader();
        check('a link inside the inline-info span\'s ancestor chain IS used as the header', result && result.header.href, 'https://www.linkedin.com/company/flexiple/');
        check('reports the scoped-fallback selector for diagnostics', result && result.selector, 'a[href*="/company/"] (scoped)');
    }

    {
        const m = build({ aboutSectionLink: 'https://www.linkedin.com/company/altudo/' });
        const result = m.findBadgeHeader();
        check('falls back to the about-company section when the inline-info region has nothing', result && result.header.href, 'https://www.linkedin.com/company/altudo/');
    }

    // The trusted-region link wins even when an unscoped decoy ALSO exists on the same page —
    // proves the scoping itself, not just an absence of decoys to get confused by.
    {
        const m = build({
            infoSpanAncestorLink: 'https://www.linkedin.com/company/flexiple/',
            decoyGlobalLink: 'https://www.linkedin.com/company/some-other-company/'
        });
        const result = m.findBadgeHeader();
        check('the trusted-region link wins even when an unscoped decoy also exists on the page', result && result.header.href, 'https://www.linkedin.com/company/flexiple/');
    }

    check('nothing found anywhere -> null, not a crash', build({}).findBadgeHeader(), null);
});

// ===========================================================================
// Suite: findTopCardCompanyLink — document-order + list/about exclusion (v7.48). v7.45's <h1>-based
// rung was reported live as still broken; two follow-up diagnostics (run directly on the affected
// page) proved WHY: no <h1> anywhere in the document, and no element at all with "job-title" or
// "top-card" in its class — that layout's headings carry hashed/auto-generated class names instead
// of LinkedIn's usual BEM naming, so no tag or class guess could ever have worked there. This drops
// both kinds of guess: the detail pane's own /company/ link is identified purely by NOT being inside
// a list card (getCardElements() already tracks those precisely) and NOT being inside the
// about-company section, taking the first survivor in document order.
// ===========================================================================
await suite('findTopCardCompanyLink — document-order + list/about exclusion', () => {
    // Links are tagged with a `region` id; a container's contains() just checks that tag — a cheap
    // stand-in for real DOM ancestor containment that keeps these tests readable. buildModule()'s own
    // export list only takes declaration NAMES pulled from the real source, so `doc` (a setup-local
    // mock, not something extractDeclaration can find) is exported via an explicit module body here
    // instead of going through buildModule().
    function link(href, region) { return { href, region }; }
    function buildWithDoc(opts) {
        const { links, cardRegions = [], aboutRegion = null } = opts;
        const setup = `
            function link(href, region) { return { href, region }; }
            const ALL_LINKS = ${JSON.stringify(links)};
            const doc = { querySelectorAll(sel) { return sel === 'a[href*="/company/"]' ? ALL_LINKS : []; } };
            const CARD_REGIONS = ${JSON.stringify(cardRegions)};
            function getCardElements() { return CARD_REGIONS.map((r) => ({ contains(l) { return !!l && l.region === r; } })); }
            const ABOUT_REGION = ${JSON.stringify(aboutRegion)};
            function findAboutCompanySection() { return ABOUT_REGION ? { contains(l) { return !!l && l.region === ABOUT_REGION; } } : null; }
        `;
        const fn = extractDeclaration('findTopCardCompanyLink', SRC);
        const body = `${setup}\n\n${fn}\n\nmodule.exports = { findTopCardCompanyLink, doc };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    check('no /company/ links anywhere -> null, not a crash', (() => { const m = buildWithDoc({ links: [] }); return m.findTopCardCompanyLink(m.doc); })(), null);

    // The realistic document-order shape confirmed live: list cards' own links come first (the list
    // panel), then the detail pane's top-card link, then the about-company section's link.
    {
        const links = [link('https://www.linkedin.com/company/card-co/', 'card0'), link('https://www.linkedin.com/company/topcard-co/', null), link('https://www.linkedin.com/company/about-co/', 'about')];
        const m = buildWithDoc({ links, cardRegions: ['card0'], aboutRegion: 'about' });
        check('skips list-card links and the about-section link, landing on the one in between',
            m.findTopCardCompanyLink(m.doc).href, 'https://www.linkedin.com/company/topcard-co/');
    }

    // Order independence: the about-section link must be excluded even if it happens to appear
    // BEFORE the real top-card link in document order — proves it's excluded by region, not by
    // "whichever came last wins".
    {
        const links = [link('https://www.linkedin.com/company/about-co/', 'about'), link('https://www.linkedin.com/company/topcard-co/', null)];
        const m = buildWithDoc({ links, aboutRegion: 'about' });
        check('the about-section link is excluded even when it appears FIRST in document order',
            m.findTopCardCompanyLink(m.doc).href, 'https://www.linkedin.com/company/topcard-co/');
    }

    // Multiple list cards, none of which should ever be picked.
    {
        const links = [link('https://www.linkedin.com/company/card-a/', 'card0'), link('https://www.linkedin.com/company/card-b/', 'card1'), link('https://www.linkedin.com/company/topcard-co/', null)];
        const m = buildWithDoc({ links, cardRegions: ['card0', 'card1'] });
        check('every list card is excluded, not just the first one', m.findTopCardCompanyLink(m.doc).href, 'https://www.linkedin.com/company/topcard-co/');
    }

    // Only card/about links exist (e.g. the detail pane itself has no /company/ link at all, or
    // hasn't rendered yet) — must not fall back to a wrong region, just report nothing found.
    {
        const links = [link('https://www.linkedin.com/company/card-a/', 'card0'), link('https://www.linkedin.com/company/about-co/', 'about')];
        const m = buildWithDoc({ links, cardRegions: ['card0'], aboutRegion: 'about' });
        check('no valid candidate survives exclusion -> null, never falls back to an excluded region',
            m.findTopCardCompanyLink(m.doc), null);
    }

    // Integration: findTopCardCompanyLink must win priority over the bottom-scoped
    // findScopedCompanyLink() fallback inside findBadgeHeader() itself when both would find
    // something — the whole point is landing the badge at the top, not just landing it somewhere.
    {
        const setup = `
            function link(href, region) { return { href, region }; }
            const ALL_LINKS = [link('https://www.linkedin.com/company/topcard-co/', null), link('https://www.linkedin.com/company/about-co/', 'about')];
            const doc = {
                querySelector(sel) {
                    if (sel === 'span.jobs-company__inline-information') return null;
                    return null; // all five named header selectors miss
                },
                querySelectorAll(sel) { return sel === 'a[href*="/company/"]' ? ALL_LINKS : []; }
            };
            function getSearchDocuments() { return [doc]; }
            function getCardElements() { return []; }
            function findAboutCompanySection() { return { contains(l) { return !!l && l.region === 'about'; }, querySelector(sel) { return sel.indexOf('/company/') !== -1 ? { href: 'https://www.linkedin.com/company/about-co/' } : null; } }; }
        `;
        const m = buildModule(['selectorStats', 'recordSelectorHit', 'BADGE_HEADER_SELECTORS', 'BADGE_TOP_CARD_LINK_LABEL',
            'COMPANY_ARIA_LABEL_SELECTOR', 'BADGE_ARIA_LABEL_LINK_LABEL', 'findAriaLabelledCompanyLink',
            'findScopedCompanyLink', 'findTopCardCompanyLink', 'findBadgeHeader'], setup);
        const result = m.findBadgeHeader();
        check('findTopCardCompanyLink wins over the bottom-scoped fallback inside findBadgeHeader()',
            result && result.header.href, 'https://www.linkedin.com/company/topcard-co/');
        check('reports the top-card selector for diagnostics', result && result.selector, 'a[href*="/company/"] (top-card, first non-list/non-about)');
    }

    // v7.58: reported live — a layout where the top document holds only the job LIST (no real detail
    // content, all five named selectors miss) while the actual open job's detail pane renders inside
    // an iframe (a named selector DOES match there). The old single-pass-per-document loop committed
    // to the top document's weak fallback match — the first job card's own /company/ link, completely
    // unrelated to the open job — before ever reaching the iframe's real match. A named match in a
    // LATER document must win over a fallback match in an EARLIER one.
    {
        const setup = `
            const docA = {
                querySelector() { return null; }, // top document: all five named selectors miss
                querySelectorAll(sel) { return sel === 'a[href*="/company/"]' ? [{ href: 'https://www.linkedin.com/company/wrong-list-co/' }] : []; }
            };
            const docB = {
                // iframe: the real open job's detail pane, a named selector matches
                querySelector(sel) { return sel === '.job-details-jobs-unified-top-card__company-name' ? { href: 'https://www.linkedin.com/company/right-co/' } : null; },
                querySelectorAll() { return []; }
            };
            function getSearchDocuments() { return [docA, docB]; }
            function getCardElements() { return []; }
            function findAboutCompanySection() { return null; }
        `;
        const m = buildModule(['selectorStats', 'recordSelectorHit', 'BADGE_HEADER_SELECTORS', 'BADGE_TOP_CARD_LINK_LABEL',
            'COMPANY_ARIA_LABEL_SELECTOR', 'BADGE_ARIA_LABEL_LINK_LABEL', 'findAriaLabelledCompanyLink',
            'findScopedCompanyLink', 'findTopCardCompanyLink', 'findBadgeHeader'], setup);
        const result = m.findBadgeHeader();
        check('a named match in a LATER document wins over a fallback match in an EARLIER document',
            result && result.header.href, 'https://www.linkedin.com/company/right-co/');
        check('reports it as a real named-selector match, not the fallback', result && result.selector, '.job-details-jobs-unified-top-card__company-name');
    }

    // Sanity check on the same restructuring: when NEITHER document has a named match, the fallback
    // pass still runs in the original per-document priority order (first document's fallback wins) —
    // proves the two-pass split didn't silently change behavior for the case every existing test above
    // already covers with a single document.
    {
        const setup = `
            const docA = {
                querySelector() { return null; },
                querySelectorAll(sel) { return sel === 'a[href*="/company/"]' ? [{ href: 'https://www.linkedin.com/company/first-doc-fallback/' }] : []; }
            };
            const docB = {
                querySelector() { return null; },
                querySelectorAll(sel) { return sel === 'a[href*="/company/"]' ? [{ href: 'https://www.linkedin.com/company/second-doc-fallback/' }] : []; }
            };
            function getSearchDocuments() { return [docA, docB]; }
            function getCardElements() { return []; }
            function findAboutCompanySection() { return null; }
        `;
        const m = buildModule(['selectorStats', 'recordSelectorHit', 'BADGE_HEADER_SELECTORS', 'BADGE_TOP_CARD_LINK_LABEL',
            'COMPANY_ARIA_LABEL_SELECTOR', 'BADGE_ARIA_LABEL_LINK_LABEL', 'findAriaLabelledCompanyLink',
            'findScopedCompanyLink', 'findTopCardCompanyLink', 'findBadgeHeader'], setup);
        const result = m.findBadgeHeader();
        check('with no named match anywhere, the first document\'s fallback still wins, as before',
            result && result.header.href, 'https://www.linkedin.com/company/first-doc-fallback/');
    }
});

// ===========================================================================
// Suite: summarizeCacheFreshness / formatCacheFreshnessSummary (v7.26) — the "Last verified" line
// in the cache manager, built entirely from companyCacheMeta.timestamp (tracked since v7.8). No
// new data collection, only a new way to look at data already being recorded.
// ===========================================================================
await suite('summarizeCacheFreshness / formatCacheFreshnessSummary', () => {
    function run({ companyCache, companyCacheMeta, now }) {
        const setup = `
            let companyCache = ${JSON.stringify(companyCache)};
            let companyCacheMeta = ${JSON.stringify(companyCacheMeta)};
            const Date = { now: () => ${now} };
        `;
        return buildModule(['FRESHNESS_BUCKET_ORDER', 'FRESHNESS_DAY_MS', 'summarizeCacheFreshness', 'formatCacheFreshnessSummary'], setup);
    }

    const DAY = 24 * 60 * 60 * 1000;
    const now = 1000 * DAY;

    {
        const m = run({
            companyCache: { fresh: 'x', midage: 'x', old: 'x', ancient: 'x', noMeta: 'x' },
            companyCacheMeta: {
                fresh: { source: 'company-page', timestamp: now - 5 * DAY },
                midage: { source: 'company-page', timestamp: now - 90 * DAY },
                old: { source: 'company-page', timestamp: now - 300 * DAY },
                ancient: { source: 'company-page', timestamp: now - 900 * DAY }
                // 'noMeta' deliberately has no meta entry at all — pre-v7.8 or historically-imported.
            },
            now
        });
        check('buckets each entry by real elapsed age', m.summarizeCacheFreshness(),
            { 'last 30 days': 1, 'last 6 months': 1, 'last year': 1, 'over a year': 1, 'unknown age': 1 });
        check('formats in fixed chronological order, NOT sorted by count (unlike the provenance summary)',
            m.formatCacheFreshnessSummary(),
            '1 last 30 days · 1 last 6 months · 1 last year · 1 over a year · 1 unknown age');
    }

    {
        // Boundary check: exactly 30 days old still counts as "last 30 days", one tick past does not.
        const m = run({
            companyCache: { onBoundary: 'x', justPast: 'x' },
            companyCacheMeta: {
                onBoundary: { source: 'company-page', timestamp: now - 30 * DAY },
                justPast: { source: 'company-page', timestamp: now - 30 * DAY - 1 }
            },
            now
        });
        check('30-day boundary is inclusive', m.summarizeCacheFreshness(), { 'last 30 days': 1, 'last 6 months': 1 });
    }

    {
        const m = run({ companyCache: {}, companyCacheMeta: {}, now });
        check('empty cache -> empty summary, not a crash', m.formatCacheFreshnessSummary(), '');
    }
});

// ===========================================================================
// Suite: force-render helpers (v7.13) — LinkedIn lazily mounts job cards as the user scrolls,
// so the counter/Auto-Fetch used to only see whatever happened to already be in the DOM.
// ===========================================================================
await suite('findScrollableAncestor / getListSignature', () => {
    const setup = `let location = { pathname: '/jobs/collections/recommended/', search: '' };`;
    const m = buildModule(['findAllScrollableAncestors', 'findScrollableAncestor', 'VOLATILE_TRACKING_PARAMS', 'getListSignature'], setup);

    // One shared getComputedStyle, like a real browser — it inspects whichever node it's called
    // with. A per-node fake (returning a fixed answer regardless of the node argument) was tried
    // first and silently broke the whole chain-walk, since findScrollableAncestor calls it with a
    // DIFFERENT node on each loop iteration but only ever sees whatever card.ownerDocument's own
    // fake happened to be bound to.
    const sharedWin = { getComputedStyle: (node) => ({ overflowY: node.__overflowY }) };
    const sharedDoc = { defaultView: sharedWin };
    function makeStyledEl(overflowY, scrollHeight, clientHeight, parent) {
        return { __overflowY: overflowY, parentElement: parent || null, scrollHeight, clientHeight, ownerDocument: sharedDoc };
    }

    // A realistic ancestor chain: card -> plain wrapper divs -> the actual scrollable list
    // container -> more plain wrappers up to the root. Mirrors the structural approach already
    // used for BADGE_HEADER_SELECTORS/CARD_CONTAINER_SELECTORS' last-resort entries — walk the
    // real DOM for a semantic signal, don't hardcode a container class LinkedIn could rename.
    const root = makeStyledEl('visible', 3000, 3000, null);
    const scrollContainer = makeStyledEl('auto', 5000, 800, root); // real scrollable: overflow:auto AND scrollHeight >> clientHeight
    const wrapper2 = makeStyledEl('visible', 400, 400, scrollContainer);
    const wrapper1 = makeStyledEl('visible', 200, 200, wrapper2);
    const card = { ownerDocument: sharedDoc, parentElement: wrapper1 };

    check('finds the real scrollable ancestor, skipping non-scrolling wrappers above it', m.findScrollableAncestor(card), scrollContainer);

    const noScrollChain = makeStyledEl('visible', 100, 100, null);
    const cardWithNoScrollableAncestor = { ownerDocument: sharedDoc, parentElement: noScrollChain };
    check('no scrollable ancestor anywhere -> null, not a crash', m.findScrollableAncestor(cardWithNoScrollableAncestor), null);

    const falseScroll = makeStyledEl('auto', 105, 100, null); // overflow:auto but barely any real overflow (<20px)
    const cardWithFalseScroll = { ownerDocument: sharedDoc, parentElement: falseScroll };
    check('overflow:auto with negligible actual overflow is not treated as the real scroll container', m.findScrollableAncestor(cardWithFalseScroll), null);

    // v7.17: reported live — a small (158px clientHeight) unrelated scrollable widget sat between
    // the card and the real list panel and was picked as the FIRST match, which never actually
    // held the job list (its card count never changed across a full scroll pass). Real ancestor
    // chain from that report, reconstructed: card -> small inner scrollable widget (matches the
    // old "first match" rule) -> ... -> the actual big list panel (also matches, much larger) ->
    // root. Must return the LARGE one, not the small one closer to the card.
    const bigRealListPanel = makeStyledEl('auto', 4000, 800, null); // the real list: big, visible
    const smallUnrelatedWidget = makeStyledEl('auto', 4407, 158, bigRealListPanel); // matches "live" report's exact numbers
    const cardNearSmallWidgetFirst = { ownerDocument: sharedDoc, parentElement: smallUnrelatedWidget };
    check('multiple scrollable ancestors: picks the LARGEST (real list panel), not the first/closest (small widget)',
        m.findScrollableAncestor(cardNearSmallWidgetFirst), bigRealListPanel);

    check('findAllScrollableAncestors reports every match, not just the winner',
        m.findAllScrollableAncestors(cardNearSmallWidgetFirst).length, 2);

    function signatureFor(pathname, search) {
        const mod = buildModule(['findAllScrollableAncestors', 'findScrollableAncestor', 'VOLATILE_TRACKING_PARAMS', 'getListSignature'], `let location = { pathname: ${JSON.stringify(pathname)}, search: ${JSON.stringify(search)} };`);
        return mod.getListSignature();
    }

    check('same list, different job clicked -> same signature (currentJobId excluded)',
        signatureFor('/jobs/collections/recommended/', '?currentJobId=4436793968&discover=recommended'),
        signatureFor('/jobs/collections/recommended/', '?currentJobId=4442450307&discover=recommended'));

    checkTrue('a genuinely different page (pagination "start=") produces a different signature',
        signatureFor('/jobs/collections/recommended/', '?start=0') !== signatureFor('/jobs/collections/recommended/', '?start=120'));

    checkTrue('a different pathname produces a different signature',
        signatureFor('/jobs/search-results/', '') !== signatureFor('/jobs/collections/recommended/', ''));

    // v7.45: reported live — a double flicker on every job click, but only on
    // /jobs/search-results/ (reached via notification/recommendation links), never on
    // /jobs/search/. That route's URL carries LinkedIn's own per-click tracking correlation params
    // (eBP, refId, trackingId, originToLandingJobPostings) alongside currentJobId, regenerated on
    // every click — each one used to register as a "different list" and re-trigger a full
    // forceRenderAllVisibleCards() hide/reveal pass.
    check('same list, different job clicked on /jobs/search-results/ -> same signature despite eBP/refId/trackingId changing',
        signatureFor('/jobs/search-results/', '?currentJobId=4410305501&eBP=CwEAAAGf8IkxBFkg&refId=cuGq0y3r&trackingId=%2Bif09SRt&keywords=node.js&origin=PREFERENCES_LANDING&geoId=105214831'),
        signatureFor('/jobs/search-results/', '?currentJobId=4427793451&eBP=BUDGET_EXHAUSTED_JOB&refId=OocgG%2Fc%2B&trackingId=gDU2U2YL&keywords=node.js&origin=PREFERENCES_LANDING&geoId=105214831'));

    checkTrue('originToLandingJobPostings changing alone does not change the signature either',
        signatureFor('/jobs/search-results/', '?currentJobId=1&originToLandingJobPostings=4443244330%2C4437705461') ===
        signatureFor('/jobs/search-results/', '?currentJobId=2&originToLandingJobPostings=4350752081'));

    checkTrue('a real filter/search change on /jobs/search-results/ still produces a different signature',
        signatureFor('/jobs/search-results/', '?keywords=node.js&geoId=105214831') !==
        signatureFor('/jobs/search-results/', '?keywords=python&geoId=105214831'));

    // v7.46: reported live — flicker persisted after v7.45, this time on PAGINATION (page 1 -> page
    // 2 -> back to page 1) rather than same-page job clicks. v7.45's URLSearchParams switch fixed
    // WHICH keys survive but still serialized the survivors in whatever order location.search
    // happened to have them in — if LinkedIn's client ever renders an optimistic URL and then
    // settles into a final one with the same params in a different order, two identical lists would
    // have compared as different signatures. Sorting removes that regardless of the exact trigger.
    checkTrue('the same params in a different order produce the SAME signature (order-independence)',
        signatureFor('/jobs/search-results/', '?keywords=Backend%20Engineer&origin=QUALIFICATION_LANDING&geoId=90009633') ===
        signatureFor('/jobs/search-results/', '?geoId=90009633&origin=QUALIFICATION_LANDING&keywords=Backend%20Engineer'));

    // The exact three URLs reported live, as a regression check: real pagination (start absent -> 25
    // -> 0) must still register as genuinely different lists after the sort fix above — the sort
    // only needs to neutralize param ORDER, not param VALUES, and shouldn't accidentally start
    // treating real navigation as a no-op.
    const page1Initial = signatureFor('/jobs/search-results/', '?currentJobId=4426375691&eBP=NOT_ELIGIBLE_FOR_CHARGING&refId=4y1uaUJILG%2BgKNyuAXFy%2Bw%3D%3D&trackingId=T3SypaFq26y5Ilg4HbKafg%3D%3D&showHowYouFit=HOW_YOU_FIT&keywords=Backend%20Engineer&origin=QUALIFICATION_LANDING&originToLandingJobPostings=4446857025%2C4443280475%2C4443244330%2C4448150778&geoId=90009633');
    const page2 = signatureFor('/jobs/search-results/', '?currentJobId=4430138723&eBP=BUDGET_EXHAUSTED_JOB&refId=rxA7g7ktyi%2B9HbzL9jqeZQ%3D%3D&trackingId=YJzUXM8MMvh%2Ftu28X63QOQ%3D%3D&showHowYouFit=HOW_YOU_FIT&keywords=Backend%20Engineer&origin=QUALIFICATION_LANDING&start=25&geoId=90009633');
    const page1Again = signatureFor('/jobs/search-results/', '?currentJobId=4402566521&eBP=NOT_ELIGIBLE_FOR_CHARGING&refId=mIIazUHsrJfBc%2Fvag9fGOQ%3D%3D&trackingId=QrSKdUFaR9b5FnCN1CMU0w%3D%3D&showHowYouFit=HOW_YOU_FIT&keywords=Backend%20Engineer&origin=QUALIFICATION_LANDING&start=0&geoId=90009633');
    checkTrue('page 2 is a genuinely different list from page 1 (start=25 vs no start)', page2 !== page1Initial);
    checkTrue('page 2 is a genuinely different list from page 1 reached the other way too (start=25 vs start=0)', page2 !== page1Again);
});

// ===========================================================================
// Suite: forceRenderAllVisibleCards (v7.14) — reported live that v7.13 undercounted (auto-stopped
// at 2, manual scroll found 5-6 more). Root cause: 2 consecutive 150ms-apart polls with no change
// declared victory while LinkedIn's real network fetch was still in flight. Uses a fake clock (the
// tested function calls Date.now() directly) so this reproduces the exact bug shape — growth
// slower than a single poll interval — deterministically, without a real multi-second test run.
// ===========================================================================
await suite('forceRenderAllVisibleCards — adaptive quiet-period detection', () => {
    const constants = ['FORCE_RENDER_POLL_INTERVAL_MS', 'FORCE_RENDER_QUIET_MS', 'FORCE_RENDER_TIMEOUT_MS', 'FORCE_RENDER_MIN_STEP_PX', 'FORCE_RENDER_RESTORE_SETTLE_POLL_MS', 'FORCE_RENDER_RESTORE_SETTLE_TIMEOUT_MS', 'FORCE_RENDER_MAX_SWEEPS', 'FORCE_RENDER_GUARANTEED_SWEEPS']
        .map((n) => extractDeclaration(n, SRC)).join('\n');
    // Real numeric values, so the assertions below can reason about expected poll counts instead
    // of hardcoding numbers that would silently go stale if the constants are ever retuned.
    const { FORCE_RENDER_POLL_INTERVAL_MS, FORCE_RENDER_QUIET_MS, FORCE_RENDER_MAX_SWEEPS, FORCE_RENDER_GUARANTEED_SWEEPS } =
        buildModule(['FORCE_RENDER_POLL_INTERVAL_MS', 'FORCE_RENDER_QUIET_MS', 'FORCE_RENDER_MAX_SWEEPS', 'FORCE_RENDER_GUARANTEED_SWEEPS'], '');

    // parseableCatchupEveryNPolls: v7.19 scenario — a card's container can mount before its inner
    // content (company name) finishes rendering. undefined/0 means no lag: parseable count always
    // matches container count immediately (the default for tests not specifically about this). A
    // positive value means parseable count trails container count, gaining at most 1 every that-
    // many polls — GRADUAL, evenly-spaced catch-up (not a single delayed jump), so each individual
    // gap stays well under FORCE_RENDER_QUIET_MS and can't fool the quiet-window into concluding
    // early on a long silent plateau (a single-jump-after-a-pause design was tried first and
    // turned out to do exactly that — the plateau itself looked indistinguishable from "settled").
    function run({ growEveryNPolls, capAt, startAt = 1, parseableCatchupEveryNPolls = 0, restoreClampAttempts = 0 }) {
        const setup = `
            ${constants}
            // v7.16: the real function now guards its debug logging with "if (DEBUG) ...",
            // referencing document.body.textContent and dbg() inside that guard — kept false here
            // (matching this script's own shipped default outside active investigations) so those
            // branches stay inert and don't need document/dbg mocked at all.
            const DEBUG = false;
            let fakeClock = 0;
            const Date = { now: () => fakeClock };
            let sleepCallCount = 0;
            let mockCardCount = ${startAt};
            let mockParseableCount = ${startAt};
            let pollsSinceLastParseableGain = 0;
            // v7.24: captures the container's opacity the first time we're mid-pass (any sleep
            // call only ever happens after the pass has hidden the container and before it's been
            // revealed again) — proves the hide actually took effect DURING the sweep, not just
            // that it got set and unset around it without ever being visibly in force.
            let opacitySeenDuringPass = null;
            // v7.25: EVERY distinct opacity observed mid-run. The reported flicker was the list
            // becoming briefly visible BETWEEN passes, which a first-observation-only check can't
            // see — if any sweep boundary reveals the list, an undefined (revealed) entry shows up
            // here alongside the '0'.
            const opacitiesSeenDuringRun = new Set();
            async function sleep(ms) {
                fakeClock += ms;
                sleepCallCount++;
                if (opacitySeenDuringPass === null) opacitySeenDuringPass = mockContainer.style.opacity;
                opacitiesSeenDuringRun.add(mockContainer.style.opacity);
                if (sleepCallCount % ${growEveryNPolls} === 0 && mockCardCount < ${capAt}) mockCardCount++;
                if (${parseableCatchupEveryNPolls} === 0) {
                    mockParseableCount = mockCardCount; // no lag: content is always ready the instant a container mounts
                } else {
                    pollsSinceLastParseableGain++;
                    if (pollsSinceLastParseableGain >= ${parseableCatchupEveryNPolls} && mockParseableCount < mockCardCount) {
                        mockParseableCount++;
                        pollsSinceLastParseableGain = 0;
                    }
                }
                return Promise.resolve();
            }
            // Real, distinguishable objects (not .fill(0)) — countParseableCards() calls
            // getCardInfo() per card, which needs something to inspect per card.
            function getCardElements() { return Array.from({ length: mockCardCount }, (_, i) => ({ __id: i })); }
            function getCardInfo(card) { return card.__id < mockParseableCount ? { normalizedName: 'card' + card.__id } : null; }
            // scrollTop is a getter/setter that records every value assigned, not a plain field —
            // needed to verify v7.15's "reset to top FIRST" fix, which only shows up as a specific
            // early entry in the sequence of positions the function moves the container through,
            // not as any single final snapshot.
            let scrollTopHistory = [];
            let _scrollTop = 777; // simulates the container NOT already being at the top when force-render kicks in
            const RESTORE_TARGET = 777;
            // v7.22: simulates a browser/virtualization clamp — the first N times something tries
            // to set scrollTop back to the real original position, it silently lands short (500)
            // instead, as if scrollHeight/virtualization hadn't caught up yet. Only the sweep's
            // own top-reset (0) and step values are exempt (they're never equal to RESTORE_TARGET).
            let restoreClampAttemptsRemaining = ${restoreClampAttempts};
            const mockContainer = {
                get scrollTop() { return _scrollTop; },
                set scrollTop(v) {
                    if (v === RESTORE_TARGET && restoreClampAttemptsRemaining > 0) {
                        restoreClampAttemptsRemaining--;
                        _scrollTop = 500;
                    } else {
                        _scrollTop = v;
                    }
                    scrollTopHistory.push(_scrollTop);
                },
                scrollHeight: 9999, clientHeight: 300, style: {}
            };
            function findScrollableAncestor() { return mockContainer; }
            function getListSignature() { return 'sig'; }
            let lastForcedListSignature = null;
            let forcingRenderInProgress = false;
            let lastForcedCardCount = -1;
            let forcedPassesForCurrentSignature = 0;
            let filterJobListCardsCallCount = 0;
            function filterJobListCards() { filterJobListCardsCallCount++; }
            // v7.49: forceRenderAllVisibleCards() now reports its own outcome via setFeatureHealth()
            // (idle/ok/failed) — inert here since this suite isn't testing that reporting itself.
            const featureHealthCalls = [];
            function setFeatureHealth(id, status, detail) { featureHealthCalls.push({ id, status, detail }); }
        `;
        const settleFn = extractDeclaration('settleScrollRestore', SRC);
        const sweepFn = extractDeclaration('runOneRenderSweep', SRC);
        const fn = extractDeclaration('forceRenderAllVisibleCards', SRC);
        const countFn = extractDeclaration('countParseableCards', SRC);
        const body = `${setup}\n\n${countFn}\n\n${settleFn}\n\n${sweepFn}\n\n${fn}\n\nmodule.exports = { forceRenderAllVisibleCards,
            get mockCardCount() { return mockCardCount; }, get mockParseableCount() { return mockParseableCount; },
            get sleepCallCount() { return sleepCallCount; },
            get filterJobListCardsCallCount() { return filterJobListCardsCallCount; }, mockContainer,
            get scrollTopHistory() { return scrollTopHistory; },
            get opacitySeenDuringPass() { return opacitySeenDuringPass; },
            get opacitiesSeenDuringRun() { return Array.from(opacitiesSeenDuringRun); },
            get featureHealthCalls() { return featureHealthCalls; },
            // Each sweep starts by resetting to the very top, so counting 0s in the position
            // history is a direct, structural count of how many sweeps actually ran (the mock's
            // starting/restore position is 777, so 0 never appears for any other reason).
            get sweepCount() { return scrollTopHistory.filter((v) => v === 0).length; } };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    return (async () => {
        // The exact reported shape: growth slower than one poll interval (every 3 polls here vs.
        // FORCE_RENDER_POLL_INTERVAL_MS apart), capped at 6. A naive "N stable polls" check with
        // a small N would stop partway through; the real fix must wait out the full quiet window.
        {
            const mod = run({ growEveryNPolls: 3, capAt: 6 });
            await mod.forceRenderAllVisibleCards();
            check('waits out the full quiet period instead of stopping at an intermediate count', mod.mockCardCount, 6);
            check('scroll position restored to where the user actually was', mod.mockContainer.scrollTop, 777);
            check('filterJobListCards() called once the real final count is known', mod.filterJobListCardsCallCount, 1);
            // v7.15: reported live — the container wasn't necessarily at the top when force-render
            // kicked in (mocked here starting at 777, not 0), and the old version only ever
            // scrolled DOWN from wherever it happened to start, missing everything above that
            // point. The very first position it moves the container to must be 0.
            check('resets to the very top FIRST, before scrolling down to force-render the rest', mod.scrollTopHistory[0], 0);
            // v7.20: reported live — finalParseableCount permanently plateaued at 14 of 32 real
            // cards no matter how long the quiet window waited, with a single scrollTop = 9999
            // jump every poll. Now steps by roughly one viewport (clientHeight, mocked at 300)
            // instead, so a virtualized list gets the same kind of incremental scroll signal a
            // real scroll gesture gives it. The second recorded position (right after the top
            // reset) must be one step, NOT a jump straight to scrollHeight.
            check('scrolls in viewport-sized steps, not one jump straight to the bottom', mod.scrollTopHistory[1], 300);
            // v7.24: reported live — the visible scroll sweep (especially the guaranteed second
            // pass, which usually finds nothing new and stops after only a partial scroll) reads
            // as jarring even though it's working correctly. Container must be hidden (opacity 0)
            // for the actual duration of the pass, not just momentarily toggled, and revealed again
            // once it's back at rest. Verified by reverting to no opacity handling at all and
            // confirming both assertions then fail (opacitySeenDuringPass stays undefined, the
            // style object never gets an opacity property), then restoring the fix.
            check('container is hidden (opacity 0) for the actual duration of the pass', mod.opacitySeenDuringPass, '0');
            check('container is revealed again once fully settled back at rest', mod.mockContainer.style.opacity, undefined);
            // v7.25: reported live — the list flickered visible for a moment BETWEEN passes, because
            // each pass was its own invocation that independently hid and revealed it. Every sweep
            // now happens inside ONE invocation, so opacity must be '0' at every single observation
            // across the whole multi-sweep run — never anything else, not even briefly at a sweep
            // boundary. Verified by reverting to runCycle-driven retries and confirming this fails.
            check('never becomes visible mid-run, including between sweeps (the flicker fix)', mod.opacitiesSeenDuringRun, ['0']);
            // v7.49: a completed pass (even one that found nothing new) reports 'ok', not silence —
            // the whole point of feature-health tracking is that this is now observable without DEBUG.
            check('reports ok to feature health once the pass completes', mod.featureHealthCalls.some((c) => c.id === 'forceRender' && c.status === 'ok'), true);
        }

        // Nothing to load at all (already fully rendered) — each sweep should conclude in roughly
        // FORCE_RENDER_QUIET_MS worth of polling, not spin until the (much longer) hard timeout.
        // v7.25: expects exactly FORCE_RENDER_GUARANTEED_SWEEPS sweeps' worth — the guaranteed
        // second sweep still runs (that's what catches a slow network that hadn't responded yet
        // during the first), but nothing beyond it, since nothing new appeared.
        {
            const mod = run({ growEveryNPolls: 999999, capAt: 1, startAt: 1 });
            await mod.forceRenderAllVisibleCards();
            // +1 per sweep for the v7.15 top-reset settle sleep, which always happens once before
            // that sweep's quiet-window polling loop even begins.
            const perSweep = 1 + Math.ceil(FORCE_RENDER_QUIET_MS / FORCE_RENDER_POLL_INTERVAL_MS);
            check('an already-fully-rendered list stops after ~one quiet window per sweep, not the hard timeout',
                mod.sleepCallCount, perSweep * FORCE_RENDER_GUARANTEED_SWEEPS);
            check('runs exactly the guaranteed sweeps when nothing new ever appears', mod.sweepCount, FORCE_RENDER_GUARANTEED_SWEEPS);
        }

        // v7.25: the whole point of the guaranteed second sweep — a list that is STILL growing when
        // the first sweep's quiet window expires must keep getting swept, up to the hard cap.
        // growEveryNPolls: 1 with a high cap keeps it growing continuously, so the "did anything
        // new appear?" check never stops the loop and it runs the full FORCE_RENDER_MAX_SWEEPS.
        {
            const mod = run({ growEveryNPolls: 1, capAt: 9999, startAt: 1 });
            await mod.forceRenderAllVisibleCards();
            check('a continuously-growing list keeps sweeping up to the hard cap, never unbounded', mod.sweepCount, FORCE_RENDER_MAX_SWEEPS);
            check('still hidden the entire time across all those sweeps', mod.opacitiesSeenDuringRun, ['0']);
            check('and still restores the user\'s real scroll position at the very end', mod.mockContainer.scrollTop, 777);
        }

        // v7.19: reported live (twice, with full ancestor-chain evidence both times) — the
        // container count reached its final value (31) almost immediately and never changed
        // again across the whole pass, yet the Unclassified total still changed after manual
        // interaction. Reproduces that exact shape: all 5 containers mount by poll 4 (fast), but
        // their inner content (what getCardInfo() needs) keeps gradually catching up afterward,
        // one card every 3 polls (600ms - individually well under FORCE_RENDER_QUIET_MS, so it
        // can't be mistaken for "settled" mid-stream), not finishing until poll 12 - well after
        // container-count tracking would already have gone quiet (~poll 9: container-stable-at-
        // poll-4 + the ~5-poll quiet tail) and called filterJobListCards() with content still
        // incomplete. Verified by literally reverting to container-count tracking and confirming
        // this specific assertion then fails (mockParseableCount frozen at 4, not 5 - the mock's
        // own sleep-driven progression stops the instant the function's loop stops polling), then
        // restoring the real fix and confirming it passes again.
        {
            const mod = run({ growEveryNPolls: 1, capAt: 5, parseableCatchupEveryNPolls: 3 });
            await mod.forceRenderAllVisibleCards();
            check('waited for CONTENT (parseable count), not just containers, to stop changing',
                mod.mockParseableCount, 5);
            check('container count also fully reached (sanity check on the mock itself)', mod.mockCardCount, 5);
        }

        // v7.22: reported live — the final "scroll back to where the user actually was" step
        // visibly got stuck partway roughly half the time. Simulates a container whose scrollTop
        // assignment gets silently clamped to a stale value (500) the first two times something
        // tries to set it back to the real target (777), as if scrollHeight/virtualization hadn't
        // caught up yet — only accepting the assignment from the third attempt onward.
        // settleScrollRestore() must notice the mismatch and keep re-asserting until it actually
        // lands, not fire-and-forget a single write. Verified by reverting to a plain single
        // `container.scrollTop = originalScrollTop;` and confirming this assertion then fails
        // (lands at 500, not 777), then restoring the fix.
        {
            const mod = run({ growEveryNPolls: 999999, capAt: 1, startAt: 1, restoreClampAttempts: 2 });
            await mod.forceRenderAllVisibleCards();
            check('scroll restore retries until it actually lands on the real target, not a stale clamp',
                mod.mockContainer.scrollTop, 777);
        }

        // Same idea, but the clamp never releases within the settle window — must give up cleanly
        // (bounded) instead of hanging forever waiting for a browser state that never arrives.
        {
            const mod = run({ growEveryNPolls: 999999, capAt: 1, startAt: 1, restoreClampAttempts: 999 });
            await mod.forceRenderAllVisibleCards();
            check('gives up after the bounded settle window instead of hanging forever', mod.mockContainer.scrollTop, 500);
        }

        // v7.21: reported live — on a slow connection, the auto scroll sweep fired "as soon as I
        // open the tab, without waiting for the page to load". One contributing bug: when no
        // scrollable container exists yet (page still loading — cards are mounted but haven't
        // grown past their own clientHeight), the old code stamped lastForcedListSignature anyway,
        // permanently locking that URL out of ever getting a real pass once the page actually
        // finished loading. Verified by reverting to the old "lock on !container" line and
        // confirming this assertion then fails (lastForcedListSignature becomes 'sig' instead of
        // staying null), then restoring the fix.
        {
            const setup = `
                ${constants}
                const DEBUG = false;
                let fakeClock = 0;
                const Date = { now: () => fakeClock };
                async function sleep(ms) { fakeClock += ms; return Promise.resolve(); }
                function getCardElements() { return [{ __id: 0 }]; } // something mounted...
                function getCardInfo() { return null; }
                function findScrollableAncestor() { return null; } // ...but not scrollable yet
                function getListSignature() { return 'sig'; }
                let lastForcedListSignature = null;
                let forcingRenderInProgress = false;
                function filterJobListCards() {}
                function setFeatureHealth() {}
            `;
            const fn = extractDeclaration('forceRenderAllVisibleCards', SRC);
            const countFn = extractDeclaration('countParseableCards', SRC);
            const sweepFn = extractDeclaration('runOneRenderSweep', SRC);
            const settleFn = extractDeclaration('settleScrollRestore', SRC);
            const body = `${setup}\n\n${countFn}\n\n${settleFn}\n\n${sweepFn}\n\n${fn}\n\nmodule.exports = { forceRenderAllVisibleCards,
                get lastForcedListSignature() { return lastForcedListSignature; },
                get forcingRenderInProgress() { return forcingRenderInProgress; } };\n`;
            const modWrapper = { exports: {} };
            new Function('module', 'exports', 'require', body)(modWrapper, modWrapper.exports, require);
            const mod = modWrapper.exports;
            await mod.forceRenderAllVisibleCards();
            check('no scrollable container yet does NOT lock the URL forever — must retry next cycle',
                mod.lastForcedListSignature, null);
            check('and leaves no in-progress flag stuck behind to block that retry', mod.forcingRenderInProgress, false);
        }
    })();
});

// ===========================================================================
// Suite: runCycle's force-render trigger (v7.25). v7.21/v7.23 put a retry loop HERE, spread across
// separate runCycle invocations — which the user then saw as a flicker, since each invocation hid
// and revealed the list independently ("for the instance/milli-second I see left side panel and
// then again it goes invisible"). That loop now lives inside forceRenderAllVisibleCards() (covered
// by the multi-sweep tests in the suite above), leaving this as a plain "new list? sweep it"
// trigger again. These tests pin that simplicity down: the invocation-level retry state
// (forcedPassesForCurrentSignature/lastForcedCardCount) is gone, and nothing should reintroduce a
// reason to call the sweep twice for one list. Extracts runCycle() verbatim; its five other
// side-effecting calls are stubbed to no-ops and forceRenderAllVisibleCards is a spy, since the
// sweep's own internals are covered above — this suite is only about the DECISION to call it.
// ===========================================================================
// v7.47: reported live with DEBUG on — the actual firing evidence showed getListSignature()
// flip-flopping between two values (with "start=25", then briefly without "start" at all, then back
// to "start=25") across two runCycle() calls from a single ordinary job click — NOT a real
// pagination change. Neither v7.45 nor v7.46 could have caught this: the param wasn't renamed or
// reordered, it was genuinely, if briefly, absent. Both edges of the flip differed from whatever
// lastForcedListSignature was at that moment, so the old instantaneous comparison fired twice. Fixed
// with a settle window: a candidate signature must stay unchanged across real elapsed time (fake
// clock here) before it's trusted, mirroring captureFromJobDetailPane()'s DETAIL_PANE_SETTLE_MS.
// Uses a fake clock (the tested function calls Date.now() directly) so the settle window can be
// crossed deterministically, without a real multi-hundred-ms test run.
await suite('runCycle — force-render trigger (with settle window)', () => {
    function build({ lastSignature = null, forcingInProgress = false, throwFromFiltering = false, pathname} = {}) {
        const setup = `
            // v7.46: runCycle now logs "if (DEBUG) dbg(...)" right before the force-render call —
            // kept false here, same convention as the other suites, so that branch stays inert.
            const DEBUG = false;
            function dbg() {}
            let forceRenderCallCount = 0;
            let panelCallCount = 0, filterCallCount = 0, companyCaptureCallCount = 0, detailCaptureCallCount = 0;
            function injectControlPanel() { panelCallCount++; }
            function filterJobListCards() {
                filterCallCount++;
                if (${JSON.stringify(!!throwFromFiltering)}) throw new Error('filtering exploded');
            }
            function captureCompanyPageIfPresent() { companyCaptureCallCount++; }
            function captureFromJobDetailPane() { detailCaptureCallCount++; }
            function syncCompanyBadge() {}
            // v7.66: runCycle now gates everything past the panel on the page being job-relevant.
            // Driven by a real location.pathname so the REAL isJobRelevantPage (extracted below) is
            // what decides, rather than a stub that could drift from it.
            const location = { pathname: ${JSON.stringify(pathname || '/jobs/search/')} };
            function setPathname(p) { location.pathname = p; }
            // Mirrors the real function's own actual synchronous behavior: lastForcedListSignature is
            // set to the signature it was called with BEFORE any await, right at the top — reproducing
            // that here (not just counting calls) is what makes the multi-cycle scenarios below
            // meaningful, since runCycle()'s own re-trigger check depends on that side effect.
            function forceRenderAllVisibleCards() { forceRenderCallCount++; lastForcedListSignature = liveSignature; return Promise.resolve(); }
            let liveSignature = null;
            function getListSignature() { return liveSignature; }
            let lastForcedListSignature = ${JSON.stringify(lastSignature)};
            let forcingRenderInProgress = ${forcingInProgress};
            let pendingListSignature = null;
            let pendingListSignatureSince = 0;
            let fakeClock = 0;
            const Date = { now: () => fakeClock };
            // v7.49: runCycle() now isolates each step through runFeature(), which itself reports to
            // setFeatureHealth() — both extracted verbatim below (same "real source, not a hand copy"
            // rule as everything else in this file) rather than re-implemented here.
            const featureHealthCalls = [];
            function setFeatureHealth(id, status, detail) { featureHealthCalls.push({ id, status, detail }); }
            // v7.50: runCycle() also renders the Data-tab status view, unconditionally, last. A
            // no-op stub here (not extracted from source — the render itself, DOM and all, is out of
            // scope for a suite about the trigger DECISION) with a call counter so the "runs exactly
            // once per cycle, even when an earlier step throws" guarantee is still checked somewhere.
            let renderHealthPanelCallCount = 0;
            function renderFeatureHealthPanel() { renderHealthPanelCallCount++; }
        `;
        const settleConst = extractDeclaration('LIST_SIGNATURE_SETTLE_MS', SRC);
        const runFeatureFn = extractDeclaration('runFeature', SRC);
        const gateFn = extractDeclaration('isJobRelevantPage', SRC);
        const fn = extractDeclaration('runCycle', SRC);
        const body = `${setup}\n\n${settleConst}\n\n${runFeatureFn}\n\n${gateFn}\n\n${fn}\n\nmodule.exports = {
            runCycle,
            get forceRenderCallCount() { return forceRenderCallCount; },
            get lastForcedListSignature() { return lastForcedListSignature; },
            get panelCallCount() { return panelCallCount; },
            get filterCallCount() { return filterCallCount; },
            get companyCaptureCallCount() { return companyCaptureCallCount; },
            get detailCaptureCallCount() { return detailCaptureCallCount; },
            get featureHealthCalls() { return featureHealthCalls; },
            get renderHealthPanelCallCount() { return renderHealthPanelCallCount; },
            setSignature(sig) { liveSignature = sig; },
            setClock(t) { fakeClock = t; },
            setPathname,
            LIST_SIGNATURE_SETTLE_MS
        };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    {
        const mod = build({ lastSignature: 'old-url' });
        const settle = mod.LIST_SIGNATURE_SETTLE_MS;
        mod.setSignature('new-url');
        mod.setClock(0);
        mod.runCycle();
        check('a newly-navigated-to list is not swept on the very first sighting (not yet settled)', mod.forceRenderCallCount, 0);
        mod.setClock(settle - 1);
        mod.runCycle();
        check('...nor a moment before the settle window elapses', mod.forceRenderCallCount, 0);
        mod.setClock(settle);
        mod.runCycle();
        check('...but IS swept once the same signature has held for the full settle window', mod.forceRenderCallCount, 1);
    }
    {
        const mod = build({ lastSignature: null });
        const settle = mod.LIST_SIGNATURE_SETTLE_MS;
        mod.setSignature('sig');
        mod.setClock(0);
        mod.runCycle();
        mod.setClock(settle);
        mod.runCycle();
        check('the very first list of the session (no previous signature) gets swept once settled', mod.forceRenderCallCount, 1);
    }
    // The sweep marks the signature as done up front, so every subsequent cycle on the same list is
    // a no-op. This is what keeps a fully-swept page from being re-swept on every mutation/poll —
    // the repeat sweeping that IS wanted all happens inside the one invocation now.
    {
        const mod = build({ lastSignature: 'sig' });
        mod.setSignature('sig');
        mod.setClock(10000);
        mod.runCycle();
        check('an already-swept list is never re-swept from here (all retrying is internal now)', mod.forceRenderCallCount, 0);
    }

    // v7.66 (P2): everything past panel injection is gated on the page being job-relevant, so a
    // subtree MutationObserver firing constantly on the feed or messaging no longer drags a full
    // cycle behind it.
    {
        const mod = build({ lastSignature: 'old-url', pathname: '/messaging/thread/123/' });
        mod.setSignature('new-url');
        mod.setClock(mod.LIST_SIGNATURE_SETTLE_MS * 4);
        mod.runCycle();
        check('on a non-jobs page the panel is still injected — hiding it would be an unasked-for change', mod.panelCallCount, 1);
        check('but list filtering does not run', mod.filterCallCount, 0);
        check('nor company-page capture', mod.companyCaptureCallCount, 0);
        check('nor job-detail capture', mod.detailCaptureCallCount, 0);
        check('and no force-render is triggered, however settled the signature looks', mod.forceRenderCallCount, 0);
        const statuses = mod.featureHealthCalls.filter((c) => c.id === 'filtering');
        check('the skip is reported as idle rather than passing silently', statuses[statuses.length - 1].status, 'idle');
        check('with a reason, so the Data tab and Diagnose both stay truthful about WHY nothing ran',
            statuses[statuses.length - 1].detail, 'not a jobs or company page');
        check('and the status panel is still rendered on the gated path', mod.renderHealthPanelCallCount, 1);
    }
    {
        // The same cycle on a jobs page must be entirely unaffected — the gate is an early return,
        // not a behaviour change to the path it guards.
        const mod = build({ lastSignature: 'old-url', pathname: '/jobs/search/' });
        mod.setSignature('new-url');
        mod.setClock(0);
        mod.runCycle();
        mod.setClock(mod.LIST_SIGNATURE_SETTLE_MS);
        mod.runCycle();
        check('on a jobs page filtering runs as before', mod.filterCallCount, 2);
        check('and the force-render trigger still fires once settled', mod.forceRenderCallCount, 1);
    }
    {
        // The gate is re-evaluated every cycle, which is what makes narrowing @match unnecessary:
        // an SPA navigation into /jobs resumes everything on the next poll, with no reload.
        const mod = build({ lastSignature: 'sig', pathname: '/feed/' });
        mod.setSignature('sig');
        mod.setClock(10000);
        mod.runCycle();
        check('gated while on the feed', mod.filterCallCount, 0);
        mod.setPathname('/jobs/search/');
        mod.runCycle();
        check('and resumes on the very next cycle after an SPA navigation into jobs', mod.filterCallCount, 1);
    }
    {
        const mod = build({ lastSignature: 'old-url', forcingInProgress: true });
        const settle = mod.LIST_SIGNATURE_SETTLE_MS;
        mod.setSignature('new-url');
        mod.setClock(0);
        mod.runCycle();
        mod.setClock(settle);
        mod.runCycle();
        check('a sweep already in progress is never re-entered, even on a brand-new settled list', mod.forceRenderCallCount, 0);
    }

    // The exact live-reported shape: a settled list ("...start=25") briefly flips to a transient
    // value ("...no start") for one runCycle() tick, then flips straight back — never staying put
    // for the settle window at any point. Must produce ZERO force-render calls, not two.
    {
        const mod = build({ lastSignature: 'jobs?start=25' });
        const settle = mod.LIST_SIGNATURE_SETTLE_MS;
        mod.setSignature('jobs?start=25');
        mod.setClock(0);
        mod.runCycle(); // already equal to lastForcedListSignature — inert regardless of settling
        mod.setSignature('jobs'); // "start" transiently vanishes
        mod.setClock(50);
        mod.runCycle(); // brand-new pending value, far short of the settle window
        mod.setSignature('jobs?start=25'); // flips back before ever settling
        mod.setClock(100);
        mod.runCycle();
        mod.setClock(100 + settle); // even after waiting out the window on the flipped-back value...
        mod.runCycle();
        check('a same-tick flip-flop back to the already-current list never triggers a sweep',
            mod.forceRenderCallCount, 0);
        check('lastForcedListSignature is left exactly as it was, not bounced through the transient value',
            mod.lastForcedListSignature, 'jobs?start=25');
    }

    // A genuine, PERSISTENT navigation (real pagination, not a transient flip) must still be caught
    // — the settle window delays it slightly, it must never suppress it outright.
    {
        const mod = build({ lastSignature: 'jobs?start=0' });
        const settle = mod.LIST_SIGNATURE_SETTLE_MS;
        mod.setSignature('jobs?start=25');
        mod.setClock(0);
        mod.runCycle();
        mod.setClock(settle);
        mod.runCycle();
        check('a real, persistent pagination change is still swept once settled', mod.forceRenderCallCount, 1);
    }

    // v7.49: per-feature fault isolation. Previously all five steps shared one try/catch — a throw
    // in filtering (the second step) would have skipped companyCapture/detailCapture/badge entirely
    // for that cycle, even though none of them depend on filtering having succeeded. Proven by
    // reverting to the old single try/catch and confirming these two assertions then fail (both
    // call counts stay 0), then restoring the fix.
    {
        const mod = build({ throwFromFiltering: true });
        mod.setSignature('sig');
        mod.runCycle();
        check('panel still runs before the throwing step', mod.panelCallCount, 1);
        check('a throw in filtering does not block companyCapture from running later in the same cycle', mod.companyCaptureCallCount, 1);
        check('...nor detailCapture', mod.detailCaptureCallCount, 1);
        check('the failure is recorded against filtering specifically, not silently swallowed', mod.featureHealthCalls.some((c) => c.id === 'filtering' && c.status === 'failed'), true);
        check('panel is still recorded as ok despite a LATER step throwing', mod.featureHealthCalls.some((c) => c.id === 'panel' && c.status === 'ok'), true);
        check('the Data-tab status view still renders even when a step threw', mod.renderHealthPanelCallCount, 1);
    }
});

// ===========================================================================
// Suite: buildFeatureHealthSummary (v7.50) — the Data-tab status view's formatting logic. Only
// 'failed'/'fallback' should ever surface; 'ok'/'idle'/no-entry-yet must all collapse to the same
// "nothing to see" line, since the whole point is that a glance at a healthy panel should look
// exactly as boring every time, not vary with which features happen to be idle at that instant.
// ===========================================================================
await suite('buildFeatureHealthSummary — Data-tab status view formatting', () => {
    function build() {
        const ids = extractDeclaration('FEATURE_HEALTH_IDS', SRC);
        const labels = extractDeclaration('FEATURE_HEALTH_LABELS', SRC);
        const health = extractDeclaration('featureHealth', SRC);
        const fn = extractDeclaration('buildFeatureHealthSummary', SRC);
        const body = `${ids}\n\n${labels}\n\n${health}\n\n${fn}\n\nmodule.exports = { buildFeatureHealthSummary, featureHealth, FEATURE_HEALTH_IDS };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    {
        const mod = build();
        check('no reports at all yet -> everything-normal line', mod.buildFeatureHealthSummary(), '✅ Everything working normally');
    }
    {
        const mod = build();
        mod.FEATURE_HEALTH_IDS.forEach((id) => { mod.featureHealth[id] = { status: 'ok', detail: '', at: 0 }; });
        check('all ok -> everything-normal line, not one row per feature', mod.buildFeatureHealthSummary(), '✅ Everything working normally');
    }
    {
        const mod = build();
        mod.featureHealth.badge = { status: 'idle', detail: 'no job open', at: 0 };
        mod.featureHealth.forceRender = { status: 'idle', detail: '', at: 0 };
        check('idle is not a problem either -> everything-normal line', mod.buildFeatureHealthSummary(), '✅ Everything working normally');
    }
    {
        const mod = build();
        mod.featureHealth.badge = { status: 'fallback', detail: 'a[href*="/company/"] (top-card, first non-list/non-about)', at: 0 };
        check('a fallback in use is surfaced with a warning icon and its detail',
            mod.buildFeatureHealthSummary(), '⚠️ Company size badge (a[href*="/company/"] (top-card, first non-list/non-about))');
    }
    {
        const mod = build();
        mod.featureHealth.forceRender = { status: 'failed', detail: 'container not found', at: 0 };
        check('a genuine failure is surfaced with an error icon and its detail',
            mod.buildFeatureHealthSummary(), '❌ Full-list scan (container not found)');
    }
    {
        const mod = build();
        mod.featureHealth.panel = { status: 'failed', detail: '', at: 0 };
        check('a detail-less failure has no dangling empty parens', mod.buildFeatureHealthSummary(), '❌ Control panel');
    }
    {
        const mod = build();
        // Deliberately set in reverse of FEATURE_HEALTH_IDS's own order, to prove the output order
        // follows the fixed id list, not insertion/object-key order (which JS objects don't even
        // guarantee for non-integer keys, but is easy to accidentally rely on regardless).
        mod.featureHealth.badge = { status: 'failed', detail: '', at: 0 };
        mod.featureHealth.panel = { status: 'fallback', detail: '', at: 0 };
        check('multiple problems are listed in FEATURE_HEALTH_IDS order, one per line',
            mod.buildFeatureHealthSummary(), '⚠️ Control panel\n❌ Company size badge');
    }
});

// ===========================================================================
// Suite: buildDiagnosticReport (v7.51) — the Diagnose button's payload. Not testing exact string
// equality for the whole report (too brittle — would break on every unrelated wording tweak);
// instead pins the specific facts that actually matter for debugging a live report with this: the
// header identifies WHAT was running and WHERE, feature health reports every tracked feature
// (including ones with nothing to report yet, distinguishably from ones that are fine), and the
// structural probe covers every document, respects the 10-link cap, and never crashes on a selector
// that happens to be invalid in some odd document context.
// ===========================================================================
await suite('buildDiagnosticReport — Diagnose button payload', () => {
    function build({ health = {}, docs, selectorStats = {}, badgeHeaderSelector = null, withCard = false }) {
        const badgeSelectors = extractDeclaration('BADGE_HEADER_SELECTORS', SRC);
        const healthIds = extractDeclaration('FEATURE_HEALTH_IDS', SRC);
        const healthLabels = extractDeclaration('FEATURE_HEALTH_LABELS', SRC);
        const setup = `
            const SCRIPT_VERSION = '7.51-test';
            const location = { href: 'https://www.linkedin.com/jobs/search-results/?start=25', pathname: '/jobs/search-results/' };
            // v7.66: the new report header lines.
            const companyCache = { acme: '51-200 employees', globex: '10,001+ employees' };
            const slugCache = { acme: 'acme-inc' };
            const companyCacheMeta = {};
            let cardTitleContradictions = 0;
            const pendingCompanyMisses = {};
            let transientMissResolvedCount = 0, transientMissResolvedTotalMs = 0,
                transientMissResolvedMaxMs = 0, transientMissGaveUpCount = 0;
            function getListSignature() { return '/jobs/search-results/?start=25'; }
            const featureHealth = ${JSON.stringify(health)};
            // v7.61: declared here (rather than extracting the real empty \`const selectorStats = {}\`)
            // purely so a run can be seeded with hit counts — formatSelectorStats() itself is the real
            // one, extracted below. recordSelectorHit's own accumulation is covered in its own suite.
            const selectorStats = ${JSON.stringify(selectorStats)};
            // v7.62: a minimal element good enough for the DOM-skeleton walker — direct text nodes
            // (never a collapsed subtree), real attribute enumeration, and a children/parentElement
            // chain. Deliberately not a DOM library: the walker only touches these six things, and
            // pinning exactly which six is part of what these tests are for.
            function makeFakeEl(tag, className, attrs, text, children) {
                const el = {
                    tagName: tag.toUpperCase(),
                    className: className || '',
                    children: children || [],
                    parentElement: null,
                    getAttributeNames() { return Object.keys(attrs || {}); },
                    getAttribute(n) { return (attrs || {})[n]; },
                    childNodes: text ? [{ nodeType: 3, nodeValue: text }] : []
                };
                (children || []).forEach((c) => { c.parentElement = el; });
                return el;
            }
            // v7.64: built with the shared fx() fixture DOM (which supports querySelector/closest)
            // rather than the local makeFakeEl, because describeCardCompanyExtraction() queries the
            // card. Passed in from outside since fx() lives in the test file's scope, not the eval's.
            const CARD_EL = arguments[3] || null;
            // getCardInfo has its own dedicated suite; mocked here like findBadgeHeader and
            // findAboutCompanySection, since this suite is about the REPORT's composition.
            function getCardInfo(card) { return card ? { normalizedName: 'nike', jobId: '4441354802' } : null; }
            // v7.65: real fixture elements rather than Array.fill(0) — describeCardCompanyExtraction
            // queries every card it traces, so a placeholder has to be queryable.
            const PLACEHOLDER_CARDS = arguments[4] || [];
            function getCardElements() { return CARD_EL ? [CARD_EL] : PLACEHOLDER_CARDS; }
            ${badgeHeaderSelector ? `
            const BADGE_HEADER_EL = makeFakeEl('a', 'company-name', { href: 'https://www.linkedin.com/company/nike/life/' }, 'Nike', []);
            const BADGE_MID = makeFakeEl('div', 'mid', {}, '', [BADGE_HEADER_EL]);
            const BADGE_REGION = makeFakeEl('section', 'top-card-region', { 'data-view-name': 'top-card' }, '', [BADGE_MID]);
            function findBadgeHeader() { return { doc: DOCS[0], header: BADGE_HEADER_EL, selector: ${JSON.stringify(badgeHeaderSelector)} }; }`
        : 'function findBadgeHeader() { return null; }'}
            function getSearchDocuments() { return DOCS; }
            function findAboutCompanySection(doc) { return doc.__aboutFound ? { __about: true } : null; }
            function findTopCardCompanyLink(doc) { return doc.__topLinkHref ? { href: doc.__topLinkHref } : null; }
            const DOCS = ${JSON.stringify((docs || []).map((d) => ({
                h1: d.h1 || 0, h2: d.h2 || 0, matchedSelectors: d.matchedSelectors || [],
                links: d.links || [], __aboutFound: !!d.aboutFound, __topLinkHref: d.topLinkHref || null,
                invalidSelectorThrows: !!d.invalidSelectorThrows,
                payloadElements: d.payloadElements || []
            })))}.map((spec) => ({
                __aboutFound: spec.__aboutFound, __topLinkHref: spec.__topLinkHref,
                querySelectorAll(sel) {
                    if (sel === 'h1') return new Array(spec.h1).fill(0);
                    if (sel === 'h2') return new Array(spec.h2).fill(0);
                    if (sel === 'a[href*="/company/"]') return spec.links.map((href) => ({ href }));
                    if (sel === 'code, script[type="application/json"]') {
                        return spec.payloadElements.map((p) => ({ tagName: p.tag.toUpperCase(), id: p.id || '', textContent: p.text }));
                    }
                    return [];
                },
                querySelector(sel) {
                    if (spec.invalidSelectorThrows) throw new Error('not a valid selector in this context');
                    return spec.matchedSelectors.includes(sel) ? {} : null;
                }
            }));
        `;
        const sizePattern = extractDeclaration('SIZE_LIKE_FIELD_NAME_PATTERN', SRC);
        const findSizeFn = extractDeclaration('findSizeLikeFields', SRC);
        const scanFn = extractDeclaration('scanEmbeddedJsonPayloads', SRC);
        const fn = extractDeclaration('buildDiagnosticReport', SRC);
        const attribution = ['isJobRelevantPage', 'CACHE_SIZE_WARN_ENTRIES', 'describeCacheFootprint',
            'TRANSIENT_MISS_STALE_MS', 'TRANSIENT_MISS_GIVE_UP_MS', 'pruneStaleCompanyMisses',
            'FORCE_RENDER_TIMEOUT_MS', 'formatTransientMissSummary',
            'CARD_CONTAINER_SELECTORS', 'CARD_PROBE_SELECTOR', 'formatSelectorStats',
            'probeCardContainerSelectors', 'countOrphanJobSignals',
            // v7.62: the DOM-skeleton section and the layout-aware badge classification.
            'DOM_SKELETON_MAX_DEPTH', 'DOM_SKELETON_MAX_CHILDREN', 'DOM_SKELETON_MAX_NODES',
            'DOM_SKELETON_TEXT_CAP', 'DOM_SKELETON_CLASS_CAP', 'DOM_SKELETON_ATTR_VALUE_CAP',
            'directTextOf', 'isPresentationalSubtree', 'describeElementSkeleton', 'renderElementSkeleton',
            'CARD_TEXT_INVENTORY_MAX', 'CARD_EXTRACTION_TRACE_MAX', 'cardTextOf',
            'buildCardTextInventory', 'describeCardCompanyExtraction',
            'CARD_COMPANY_SELECTORS', 'CARD_COMPANY_FALLBACK_LABEL', 'CARD_TRACE_EXTRA_RUNGS',
            'traceOneCard', 'formatCardTrace', 'findComponentKeyCompanyElement',
            'COMPONENT_KEY_CARD_ATTR_SELECTOR', 'isComponentKeyLayout', 'BADGE_ARIA_LABEL_LINK_LABEL',
            'BADGE_ALWAYS_EXPECTED_RUNGS', 'isExpectedBadgeRung',
            'BADGE_TOP_CARD_LINK_LABEL'].map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${badgeSelectors}\n\n${healthIds}\n\n${healthLabels}\n\n${attribution}\n\n${sizePattern}\n\n${findSizeFn}\n\n${scanFn}\n\n${fn}\n\nmodule.exports = { buildDiagnosticReport, BADGE_HEADER_SELECTORS, CARD_CONTAINER_SELECTORS };\n`;
        const mod = { exports: {} };
        const cardEl = withCard ? fx('div', { class: 'card-outer', role: 'button', componentkey: 'job-card-component-ref-4441354802' }, [
            fx('p', { class: '_20e55808 b0593cae', __text: 'Nike' }, []),
            fx('p', { class: 'hashed-two', __text: 'Bengaluru, Karnataka, India' }, [])
        ]) : null;
        const placeholderCount = (docs || []).reduce((n, d) => n + (d.cardCount || 0), 0);
        const placeholders = Array.from({ length: placeholderCount }, () => fx('div', { class: 'placeholder-card' }, []));
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require, cardEl, placeholders);
        return mod.exports;
    }

    {
        const mod = build({ docs: [{ cardCount: 7 }] });
        const report = mod.buildDiagnosticReport();
        const lines = report.split('\n');
        check('identifies the script version', lines.includes('Script version: 7.51-test'), true);
        check('identifies the current URL', lines.includes('URL: https://www.linkedin.com/jobs/search-results/?start=25'), true);
        check('includes the current list signature', lines.includes('List signature: /jobs/search-results/?start=25'), true);
        check('includes an ISO-shaped generated timestamp', lines.some((l) => /^Generated: \d{4}-\d{2}-\d{2}T/.test(l)), true);
        check('reports the total job card count', lines.includes('Job cards found (all documents): 7'), true);
    }
    {
        const now = Date.now();
        const mod = build({
            health: { badge: { status: 'fallback', detail: 'a[href*="/company/"] (top-card, first non-list/non-about)', at: now } },
            docs: [{}]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('a feature with a real report shows its status and detail',
            lines.some((l) => l.startsWith('Company size badge: fallback — a[href*="/company/"] (top-card, first non-list/non-about) (')), true);
        check('a feature with no report yet says so explicitly, not blank or "undefined"',
            lines.includes('Control panel: no report yet'), true);
    }
    // v7.61: the selector-hit-rate section — the part that turns "something looks wrong" into a
    // one-line diff against how the same chains read when everything was working.
    {
        const mod = build({
            docs: [{}],
            selectorStats: {
                'card.company': { '.artdeco-entity-lockup__subtitle': 0, '(no match)': 25 },
                'badge.header': { '.job-details-jobs-unified-top-card__company-name': 31 }
            }
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('the report carries a selector hit-rate section', lines.includes('-- Selector hit rates (this session) --'), true);
        check('a chain that has stopped matching shows as such, with its share of the chain',
            lines.includes('  25 (100%)  (no match)'), true);
        check('a dead rung is still listed at zero rather than omitted — the 0 IS the signal',
            lines.includes('  0 (0%)  .artdeco-entity-lockup__subtitle'), true);
        check('each chain is named so rungs are attributable to the right lookup', lines.includes('card.company:'), true);
        check('a healthy chain reads as a single rung at 100%',
            lines.includes('  31 (100%)  .job-details-jobs-unified-top-card__company-name'), true);
        // v7.68: the transient-miss section sits directly below the hit-rate one it explains.
        check('the report carries the transient-miss section directly under the hit rates it explains',
            lines.includes('-- card.company transient misses (sweep-settle check) --'), true);
        check('with no activity yet it says so plainly', lines.includes('(no transient misses observed yet this session)'), true);
    }
    {
        const mod = build({ docs: [{}] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('with no activity recorded the section says so rather than looking like a broken empty block',
            lines.includes('(no selector activity recorded yet)'), true);
        check('the container-selector section is computed fresh on every Diagnose press',
            lines.includes('-- Card container selectors (matched right now) --'), true);
        check('every container selector is listed, including the ones matching nothing here',
            mod.CARD_CONTAINER_SELECTORS.every((sel) => lines.includes(`  0  ${sel}`)), true);
        check('and the independent job-card-marker probe is reported alongside them, so a zero on both is distinguishable from a zero on one',
            lines.some((l) => l.startsWith('  0  (probe) ')), true);
        // v7.67: reported live — the rejection count used to sit unlabeled right after the container-
        // selector list, which made it read as if it were one more container count rather than what
        // it actually is. It now gets its own header, pinned here so it can't drift back.
        check('the job-title contradiction count gets its OWN section, not tacked onto container selectors',
            lines.includes('-- Job-title contradiction guard --'), true);
        const guardHeaderIdx = lines.indexOf('-- Job-title contradiction guard --');
        check('and its count line sits under that header, not under the container-selector one',
            lines[guardHeaderIdx + 1].indexOf('cards rejected this session') !== -1, true);
    }
    // v7.62: the DOM-skeleton sections — what makes the NEXT markup change answerable from the first
    // report rather than the second.
    {
        const mod = build({
            docs: [{ matchedSelectors: ['[componentkey^="job-card-component-ref-"]'] }],
            withCard: true,
            badgeHeaderSelector: 'a[href*="/company/"] (top-card, first non-list/non-about)'
        });
        const report = mod.buildDiagnosticReport();
        const lines = report.split('\n');
        // v7.65: the two card sections that answer "which element holds the company name" and "what
        // does each rung pick", pinned at report level so their wiring can't silently drop out.
        check('the report carries the card text inventory', lines.includes('-- Job card: text-bearing elements (first card) --'), true);
        check('which names the element holding the company text', report.indexOf('p.hashed-two children=0 text="Bengaluru, Karnataka, India"') !== -1, true);
        check('the report carries the per-card rung trace', lines.some((l) => l.indexOf('-- Job card: what each company rung actually picks (first ') === 0), true);
        check('and the trace reports what the chain resolved to, not an empty string', report.indexOf('resolved="nike"') !== -1, true);
        check('the report carries a job-card skeleton section', lines.includes('-- DOM skeleton: first job card --'), true);
        check('the card skeleton names the attribute a replacement selector would be built from',
            report.indexOf('componentkey="job-card-component-ref-4441354802"') !== -1, true);
        check('and shows which child element holds the company name', report.indexOf('text="Nike"') !== -1, true);
        check('the report carries a badge-header skeleton section', lines.includes('-- DOM skeleton: badge header region --'), true);
        check('which states the rung that resolved it', lines.includes('resolved via: a[href*="/company/"] (top-card, first non-list/non-about)'), true);
        check('the reported componentkey page classifies that rung as expected, NOT as a degradation',
            lines.includes('classified as: expected for this layout'), true);
        check('and records the layout finding that drove the classification',
            lines.includes('componentkey layout detected: true'), true);
        check('the header region is walked from an ancestor, so surrounding structure is visible rather than the matched node alone',
            report.indexOf('data-view-name="top-card"') !== -1, true);
    }
    {
        // Same rung, ordinary BEM layout — must still read as a degradation.
        const mod = build({
            docs: [{}],
            badgeHeaderSelector: 'a[href*="/company/"] (top-card, first non-list/non-about)'
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('on a non-componentkey page the same rung is still called out as a fallback',
            lines.includes('classified as: fallback (a better rung exists on this layout but missed)'), true);
        check('with the layout finding recorded alongside it', lines.includes('componentkey layout detected: false'), true);
    }
    {
        const mod = build({ docs: [{}] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('no header located is stated explicitly rather than leaving an empty section',
            lines.includes('(no header located on this page)'), true);
        check('and no card present is likewise stated, not blank', lines.includes('(nothing to describe)'), true);
    }
    {
        const mod = build({ docs: [{ h1: 1, h2: 3, matchedSelectors: ['.job-details-jobs-unified-top-card__company-name'] }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('reports heading counts for the top document', lines.includes('  h1=1 h2=3'), true);
        check('reports which named badge selector matched', lines.includes('  selector matched=true: .job-details-jobs-unified-top-card__company-name'), true);
        check('reports the other named selectors as not matched, not just omitted',
            lines.includes('  selector matched=false: .jobs-unified-top-card__company-name'), true);
    }
    {
        const mod = build({ docs: [{}, { h1: 0 }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('labels the top document distinctly from an iframe', lines.includes('[top document]'), true);
        check('labels a second document as an iframe, numbered', lines.includes('[iframe #1]'), true);
    }
    {
        const manyLinks = Array.from({ length: 12 }, (_, i) => `https://www.linkedin.com/company/co-${i}/`);
        const mod = build({ docs: [{ links: manyLinks, topLinkHref: manyLinks[0] }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('reports the true total link count, not capped', lines.includes('  /company/ links found: 12'), true);
        check('lists the first 10 links', lines.includes(`    [9] ${manyLinks[9]}`), true);
        check('caps the listed links at 10, does not dump every one', lines.some((l) => l.startsWith('    [10] ')), false);
        check('still reports the resolved top-card link separately from the raw list', lines.includes(`  top-card company link resolves to: ${manyLinks[0]}`), true);
    }
    {
        const mod = build({ docs: [{ topLinkHref: null }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('no resolvable top-card link reports "none", not null/undefined/a crash', lines.includes('  top-card company link resolves to: none'), true);
    }
    {
        // A selector that happens to be invalid in some odd document context (e.g. a foreign/XML
        // document) must not take down the whole report — every other document's section, and
        // every other line for the SAME document, still has to render.
        const mod = build({ docs: [{ h1: 2, invalidSelectorThrows: true }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('an invalid selector in this context is reported as not-matched, not a thrown error', lines.includes('  selector matched=false: .job-details-jobs-unified-top-card__company-name'), true);
        check('the rest of that document\'s section still renders despite the selector error', lines.includes('  h1=2 h2=0'), true);
    }

    // --- v7.55: embedded JSON payload scan (SSR/hydration data already in the DOM) --------------
    {
        const mod = build({ docs: [{}] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('no candidate elements at all -> reports zero found, not a crash', lines.includes('  embedded JSON payloads found (<code>/<script type="application/json">): 0'), true);
    }
    {
        const mod = build({
            docs: [{ payloadElements: [
                { tag: 'code', id: 'datalet-bpr-guid-123', text: JSON.stringify({ data: { name: 'Acme', employeeCount: 500 } }) },
                { tag: 'code', id: '', text: 'not valid json at all {{{' },
                { tag: 'script', id: 'unrelated', text: '<not even trying to be json>' }
            ] }]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('counts only the elements that actually parse as JSON, not every candidate scanned',
            lines.includes('  embedded JSON payloads found (<code>/<script type="application/json">): 1'), true);
        // v7.66: the per-payload structure dump was removed. What must survive is the COUNT (proof
        // the scan ran and how much it saw) and the aggregated size-field section further down — the
        // only part that would ever be acted on. These assert the dump is genuinely gone rather than
        // merely shortened, since "still there but quieter" was not the goal.
        check('no per-payload structure line survives', lines.some((l) => l.trim().indexOf('shape:') === 0), false);
        check('and no per-payload identity line either — the count above is what carries the information',
            lines.some((l) => l.includes('<code id="datalet-bpr-guid-123">')), false);
        check('the payload is still SCANNED though — its size-like field is reported',
            lines.some((l) => l.includes('employeeCount')), true);
    }
    {
        // The count must stay honest at volume even with no per-payload output: it is now the only
        // evidence in the report that the scan happened at all.
        const payloadElements = Array.from({ length: 31 }, (_, i) => ({ tag: 'code', id: `p${i}`, text: JSON.stringify({ n: i }) }));
        const mod = build({ docs: [{ payloadElements }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('reports the true total payload count, uncapped', lines.includes('  embedded JSON payloads found (<code>/<script type="application/json">): 31'), true);
        check('and adds no per-payload lines at all, however many there are',
            lines.some((l) => l.includes('id="p29"') || l.includes('id="p0"')), false);
    }

    // --- v7.56: unwrapping LinkedIn's "datalet" wrapper shape (real response double-encoded as a
    // JSON string inside its own `body` field) ---------------------------------------------------
    {
        const mod = build({
            docs: [{ payloadElements: [{
                tag: 'code', id: 'datalet-bpr-guid-69387',
                text: JSON.stringify({ request: '/voyager/api/x', status: 200, method: 'GET', headers: { 'x-li-uuid': 'abc' },
                    body: JSON.stringify({ data: { companyName: 'Acme', employeeCountRange: { start: 51, end: 200 } } }) })
            }] }]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        // v7.66: the shape lines are gone, but the UNWRAP itself is not — it is what lets
        // findSizeLikeFields see inside the wrapper, which is the only reason it ever mattered.
        check('no shape line survives for the wrapper', lines.some((l) => l.trim().indexOf('shape:') === 0), false);
        check('but the body is still unwrapped and searched — a size field INSIDE it is reported',
            lines.some((l) => l.includes('$.body') && l.includes('employeeCountRange')), true);
    }
    {
        const mod = build({
            docs: [{ payloadElements: [{ tag: 'code', id: 'datalet-something', text: JSON.stringify({ body: 'not json inside here' }) }] }]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('a body field that is a string but not valid JSON itself is skipped silently, not crashed on',
            lines.some((l) => l.trim().startsWith('body shape:')), false);
    }
    {
        const mod = build({ docs: [{ payloadElements: [{ tag: 'code', id: 'plain', text: JSON.stringify({ data: { x: 1 } }) }] }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('a payload with no body field at all never shows a body shape line', lines.some((l) => l.trim().startsWith('body shape:')), false);
    }

    // --- v7.57: findSizeLikeFields — the direct "is company-size data present anywhere" search ---
    {
        const mod = build({ docs: [{ payloadElements: [{ tag: 'code', id: 'nothing-relevant', text: JSON.stringify({ data: { title: 'x', keywords: 'y' } }) }] }] });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('no matching field anywhere -> the summary says so explicitly', lines.includes('None found.'), true);
        check('the summary section header is present even when empty',
            lines.includes('-- Company-size-like fields found across all embedded payloads --'), true);
    }
    {
        const mod = build({
            docs: [{ payloadElements: [{
                tag: 'code', id: 'bpr-guid-1',
                text: JSON.stringify({ data: { jobCardPrefetchQueries: [{ prefetchJobPostingCard: { company: { employeeCountRange: { start: 51, end: 200 } } } }] } })
            }] }]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        const summaryLine = '  [top document / bpr-guid-1] $.data.jobCardPrefetchQueries[0].prefetchJobPostingCard.company.employeeCountRange (object)';
        check('a nested matching field is found regardless of depth, with its full path', lines.includes(summaryLine), true);
        // Checked against the summary line specifically (not the whole report, which also has an
        // unrelated char-count line that could coincidentally contain "51" or "200") — this line by
        // construction only ever carries doc/payloadId/path/type, never a value.
        check('the value ITSELF (51/200) never appears in the summary line — path and type only',
            summaryLine.includes('51') || summaryLine.includes('200'), false);
    }
    {
        // Matches inside an unwrapped datalet body must be found too, not just the outer wrapper —
        // labeled with a $.body-prefixed path so it's clear which layer it came from.
        const mod = build({
            docs: [{ payloadElements: [{
                tag: 'code', id: 'datalet-bpr-guid-2',
                text: JSON.stringify({ request: '/x', status: 200, method: 'GET', headers: {},
                    body: JSON.stringify({ companySize: '10,001+' }) })
            }] }]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('a match inside the unwrapped body is found and labeled as coming from the body',
            lines.includes('  [top document / datalet-bpr-guid-2] $.body.companySize (string)'), true);
    }
    {
        // Case-insensitive, and matches more than one known naming style in the same payload.
        const mod = build({
            docs: [{ payloadElements: [{ tag: 'code', id: 'multi', text: JSON.stringify({ numberOfEmployees: 500, staffCount: 500, headCount: 500 }) }] }]
        });
        const lines = mod.buildDiagnosticReport().split('\n');
        check('matches are case-insensitive and every distinct known naming style is reported',
            ['$.numberOfEmployees', '$.staffCount', '$.headCount'].every((p) => lines.some((l) => l.includes(p))), true);
    }
});



// ===========================================================================
// Suite: getCardInfo — slug extraction (v7.29). Reported live: "victoria's-secret" (the real
// LinkedIn slug, from https://www.linkedin.com/company/victoria's-secret/) was truncated to just
// "victoria" and stored that way in slugCache. Root cause: the extraction regex used an allowlist
// of "safe" characters that didn't include apostrophes - the same class of mistake this file has
// already been burned by (guessing what's valid instead of matching structurally). Fixed by
// matching up to the next path separator instead, which this suite verifies directly - not testing
// all of getCardInfo()'s other responsibilities (name/jobId detection are covered elsewhere),
// purely the slug bug and its fix.
// ===========================================================================
// ===========================================================================
// v7.63 (P4) — the first fixture in this suite built from REAL captured markup instead of a shape
// invented to suit the test. Transcribed from v7.62's DOM-skeleton output on live
// /jobs/search-results/ pages (four different companies, identical structure every time), hashed
// class names and all. That matters: every other DOM mock here encodes what the author BELIEVED
// LinkedIn ships, which is exactly the assumption that has been wrong four separate times in this
// project's history (v7.1, v7.5, v7.33, v7.48). This one encodes what LinkedIn was observed shipping.
// ===========================================================================

// A minimal DOM: tag names plus [attr], [attr=], [attr^=] and [attr*=] predicates. Deliberately not a
// CSS engine — it supports exactly the selector forms the functions under test actually issue, and
// nothing more, so it can't quietly pass a selector a real browser would reject.
// v7.64: selector LISTS ("a, b, c"), because that's how the card company chain is issued — one
// comma-joined querySelector, deliberately (see queryWithAttribution). A fixture that couldn't
// express that would be unable to test the very call shape the real code depends on.
// Splits at commas that are genuinely selector separators — not the one inside
// [aria-label^="Company, "], which a naive .split(',') tears in half. Tracks bracket depth and
// quotes, exactly as a real selector parser must.
function fxSplitSelectorList(sel) {
    const parts = [];
    let depth = 0, quote = null, current = '';
    for (const ch of String(sel)) {
        if (quote) { current += ch; if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function fxMatches(el, sel) {
    const parts = fxSplitSelectorList(sel);
    if (parts.length > 1) return parts.some((p) => fxMatchesOne(el, p));
    return fxMatchesOne(el, parts[0] || sel);
}

function fxMatchesOne(el, sel) {
    const m = String(sel).trim().match(/^([a-zA-Z]*)((?:\.[\w-]+|\[[^\]]+\])*)$/);
    if (!m) throw new Error(`fixture DOM: unsupported selector "${sel}"`);
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    const tokens = m[2] ? (m[2].match(/\.[\w-]+|\[[^\]]+\]/g) || []) : [];
    return tokens.every((token) => {
        if (token[0] === '.') {
            return String(el.className || '').split(/\s+/).indexOf(token.slice(1)) !== -1;
        }
        const pm = token.slice(1, -1).match(/^([\w-]+)(?:(\^=|\*=|=)"?([^"]*)"?)?$/);
        if (!pm) throw new Error(`fixture DOM: unsupported predicate "${token}"`);
        const actual = el.getAttribute(pm[1]);
        if (actual === null) return false;
        if (!pm[2]) return true;
        if (pm[2] === '=') return actual === pm[3];
        if (pm[2] === '^=') return actual.indexOf(pm[3]) === 0;
        return actual.indexOf(pm[3]) !== -1;
    });
}

function fx(tag, attrs, children) {
    const own = attrs || {};
    const kids = children || [];
    const el = {
        tagName: tag.toUpperCase(),
        className: own.class || '',
        href: own.href,
        children: kids,
        childNodes: own.__text ? [{ nodeType: 3, nodeValue: own.__text }] : [],
        parentElement: null,
        getAttribute(n) { return Object.prototype.hasOwnProperty.call(own, n) ? own[n] : null; },
        getAttributeNames() { return Object.keys(own).filter((k) => k !== '__text'); },
        // v7.68: mirrors the browser's real data-* -> camelCase mapping, forced by extractCardJobId()
        // reading card.dataset.occludableJobId — the real BEM cards captured live carry
        // data-occludable-job-id, and a fixture that couldn't express it couldn't test that rung.
        get dataset() {
            const ds = {};
            Object.keys(own).forEach((k) => {
                if (k.indexOf('data-') !== 0) return;
                const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                ds[camel] = own[k];
            });
            return ds;
        },
        matches(sel) { return fxMatches(el, sel); },
        descendants() {
            const out = [];
            kids.forEach((k) => { out.push(k); k.descendants().forEach((d) => out.push(d)); });
            return out;
        },
        contains(other) { return other === el || el.descendants().indexOf(other) !== -1; },
        closest(sel) {
            let node = el;
            while (node) { if (fxMatches(node, sel)) return node; node = node.parentElement; }
            return null;
        },
        querySelectorAll(sel) { return el.descendants().filter((d) => fxMatches(d, sel)); },
        querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
        // Own text plus every descendant's, like the real thing — findComponentKeyCompanyElement
        // reads textContent, and its whole predicate ("childless <p> with text") only means what it
        // means if this behaves the way the DOM's does.
        get textContent() {
            return (own.__text || '') + kids.map((k) => k.textContent).join('');
        }
    };
    kids.forEach((k) => { k.parentElement = el; });
    return el;
}

// The observed top card, verbatim in structure. The two attributes that matter are real: the
// employer link carries componentkey="auto-binding-…" and wraps a div the page labels
// aria-label="Company, <name>." Everything else is the hashed-class noise it actually ships with.
function observedTopCard(companySlug, companyName) {
    return fx('div', { class: 'c64c6a20 _1e2b41af _2c11ca63 ba6c7319 _90f3dce0 b6dcba19 _48a6224d' }, [
        fx('div', { class: 'c4936755 _48a6224d', 'data-display-contents': 'true' }, [
            fx('a', {
                class: '_218a869c a56de063 _832a4ea2 cff06760 c2c0d206 _229e5957 a0892dc4',
                tabindex: '0',
                href: `https://www.linkedin.com/company/${companySlug}/life/`,
                componentkey: 'auto-binding-8a47f877-1b6f-4ac3-8a6e-136'
            }, [
                fx('div', {
                    class: '_381952ee c64c6a20 _1e2b41af _9f98f6fd ba6c7319 _90f3dce0',
                    componentkey: 'auto-binding-8a47f877-1b6f-4ac3-8a6e-136',
                    'aria-label': `Company, ${companyName}.`
                }, [
                    fx('figure', { class: '_95f3c4d1 _674c1f87', 'aria-hidden': 'true' }, []),
                    fx('p', { class: 'a1519b12 _9c1c6037 _01c779b9', __text: companyName }, [])
                ])
            ])
        ])
    ]);
}

await suite('findAriaLabelledCompanyLink (P2) — identity beats document position', () => {
    function build({ root, cards = [], aboutSection = null }) {
        const setup = `
            const ROOT = arguments[3];
            const CARDS = arguments[4];
            const ABOUT = arguments[5];
            function getCardElements() { return CARDS; }
            function findAboutCompanySection() { return ABOUT; }
            function getSearchDocuments() { return [ROOT]; }
        `;
        const decls = ['COMPANY_ARIA_LABEL_SELECTOR', 'findAriaLabelledCompanyLink', 'findTopCardCompanyLink']
            .map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${decls}\n\nmodule.exports = { findAriaLabelledCompanyLink, findTopCardCompanyLink };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require, root, cards, aboutSection);
        return mod.exports;
    }

    {
        const root = observedTopCard('bitgo', 'BitGo');
        const m = build({ root });
        const found = m.findAriaLabelledCompanyLink(root);
        check('finds the employer link on the real observed markup', !!found, true);
        check('and it is the one carrying the real slug', found.href, 'https://www.linkedin.com/company/bitgo/life/');
        check('returns the ANCHOR, not the labelled div — so the badge still renders exactly where it did',
            found.tagName, 'A');
        // Identity, not deep-equality: these fixture nodes carry parentElement back-references, so a
        // structural compare would recurse forever. Identity is the stronger claim here anyway.
        check('which is the SAME element the existing document-order rung resolves to on a clean page',
            found === m.findTopCardCompanyLink(root), true);
    }

    {
        // The reported risk, made concrete. A live capture showed /company/cgi/, /company/bell/ and
        // /company/servicenow/ sitting on the page alongside the real employer's link. Here one of
        // them renders FIRST, which is all it takes for a document-order rung to pick the wrong
        // company — the exact class of wrong-company bug this project was burned by in v6.5.
        const real = observedTopCard('bceglobaltech', 'BCE Global Tech');
        const page = fx('div', {}, [
            fx('a', { href: 'https://www.linkedin.com/company/servicenow/' }, []),
            fx('a', { href: 'https://www.linkedin.com/company/bell/' }, []),
            real
        ]);
        const m = build({ root: page });
        check('document order alone picks a company mentioned in the description — the wrong one',
            m.findTopCardCompanyLink(page).href, 'https://www.linkedin.com/company/servicenow/');
        check('the aria-label rung picks the actual employer regardless of where it sits in the DOM',
            m.findAriaLabelledCompanyLink(page).href, 'https://www.linkedin.com/company/bceglobaltech/life/');
    }

    {
        // Same exclusions as the rung it sits above — it must never be able to match a LIST card's
        // own link, which every card carries (getCardInfo relies on exactly that).
        const cardInner = observedTopCard('some-listed-co', 'Some Listed Co');
        const card = fx('div', { role: 'button', componentkey: 'job-card-component-ref-1' }, [cardInner]);
        const page = fx('div', {}, [card]);
        const m = build({ root: page, cards: [card] });
        check('a labelled link inside a list card is excluded, exactly like the rung below it',
            m.findAriaLabelledCompanyLink(page) === null, true);
    }

    {
        const about = observedTopCard('about-co', 'About Co');
        const page = fx('div', {}, [about]);
        const m = build({ root: page, aboutSection: about });
        check('a labelled link inside the about-company section is excluded too',
            m.findAriaLabelledCompanyLink(page) === null, true);
    }

    {
        const page = fx('div', {}, [fx('a', { href: 'https://www.linkedin.com/company/plain/' }, [])]);
        const m = build({ root: page });
        check('no aria-label anywhere -> null, so findBadgeHeader falls through to the next rung unchanged',
            m.findAriaLabelledCompanyLink(page) === null, true);
    }

    {
        // A labelled element that isn't inside a company link at all (e.g. a section heading) must be
        // skipped rather than returned or crashed on.
        const page = fx('div', {}, [
            fx('div', { 'aria-label': 'Company, Orphan Label.' }, []),
            observedTopCard('real-co', 'Real Co')
        ]);
        const m = build({ root: page });
        check('a labelled element with no enclosing company link is skipped, and scanning continues',
            m.findAriaLabelledCompanyLink(page).href, 'https://www.linkedin.com/company/real-co/life/');
    }

    {
        const page = fx('div', {}, [fx('div', { 'aria-label': 'Companies you may know' }, [])]);
        const m = build({ root: page });
        check('the prefix is anchored — "Companies you may know" is not "Company, "',
            m.findAriaLabelledCompanyLink(page) === null, true);
    }

    // Through the real findBadgeHeader(), against the real observed markup, so the RUNG ORDER is
    // pinned end-to-end rather than each rung only being correct in isolation.
    {
        function buildChain(root, cards) {
            const setup = `
                const ROOT = arguments[3];
                const CARDS = arguments[4];
                function getCardElements() { return CARDS; }
                function findAboutCompanySection() { return null; }
                function getSearchDocuments() { return [ROOT]; }
            `;
            const decls = ['selectorStats', 'recordSelectorHit', 'BADGE_HEADER_SELECTORS',
                'COMPANY_ARIA_LABEL_SELECTOR', 'BADGE_ARIA_LABEL_LINK_LABEL', 'BADGE_TOP_CARD_LINK_LABEL',
                'findAriaLabelledCompanyLink', 'findScopedCompanyLink', 'findTopCardCompanyLink', 'findBadgeHeader']
                .map((n) => extractDeclaration(n, SRC)).join('\n\n');
            const body = `${setup}\n\n${decls}\n\nmodule.exports = { findBadgeHeader, selectorStats, BADGE_ARIA_LABEL_LINK_LABEL };\n`;
            const mod = { exports: {} };
            new Function('module', 'exports', 'require', body)(mod, mod.exports, require, root, cards || []);
            return mod.exports;
        }

        const page = fx('div', {}, [
            fx('a', { href: 'https://www.linkedin.com/company/servicenow/' }, []),
            observedTopCard('bitgo', 'BitGo')
        ]);
        const m = buildChain(page);
        const located = m.findBadgeHeader();
        check('on the real observed markup findBadgeHeader resolves via the aria-label rung',
            located.selector, m.BADGE_ARIA_LABEL_LINK_LABEL);
        check('landing on the real employer, not the first /company/ link in the document',
            located.header.href, 'https://www.linkedin.com/company/bitgo/life/');
        check('and the rung that won is recorded for the hit-rate report',
            m.selectorStats['badge.header'][m.BADGE_ARIA_LABEL_LINK_LABEL], 1);
    }

    {
        // A named selector must still outrank it — the whole first pass of findBadgeHeader runs before
        // any structural rung is considered, and v7.63 must not have disturbed that.
        function buildChain(root) {
            const setup = `
                const ROOT = arguments[3];
                function getCardElements() { return []; }
                function findAboutCompanySection() { return null; }
                function getSearchDocuments() { return [ROOT]; }
            `;
            const decls = ['selectorStats', 'recordSelectorHit', 'BADGE_HEADER_SELECTORS',
                'COMPANY_ARIA_LABEL_SELECTOR', 'BADGE_ARIA_LABEL_LINK_LABEL', 'BADGE_TOP_CARD_LINK_LABEL',
                'findAriaLabelledCompanyLink', 'findScopedCompanyLink', 'findTopCardCompanyLink', 'findBadgeHeader']
                .map((n) => extractDeclaration(n, SRC)).join('\n\n');
            const body = `${setup}\n\n${decls}\n\nmodule.exports = { findBadgeHeader };\n`;
            const mod = { exports: {} };
            new Function('module', 'exports', 'require', body)(mod, mod.exports, require, root);
            return mod.exports;
        }
        const page = fx('div', {}, [
            fx('span', { class: 'job-details-jobs-unified-top-card__company-name', __text: 'Named' }, []),
            observedTopCard('bitgo', 'BitGo')
        ]);
        check('a named selector still wins over both structural rungs, unchanged from v7.62',
            buildChain(page).findBadgeHeader().selector, '.job-details-jobs-unified-top-card__company-name');
    }
});

// v7.66 (P2). @match stays broad on purpose — Tampermonkey matches at DOCUMENT LOAD and LinkedIn is
// an SPA, so narrowing it to /jobs/* would mean starting on the feed and navigating into jobs never
// starts the script at all. The gate therefore lives in runCycle, where being wrong is free: the 1s
// poll re-evaluates it, so an SPA navigation resumes everything within a second with no reload.
await suite('isJobRelevantPage (P2) — gating the work, not the @match', () => {
    function at(pathname) {
        return buildModule(['isJobRelevantPage'], `const location = { pathname: ${JSON.stringify(pathname)} };`)
            .isJobRelevantPage();
    }

    check('the jobs search list is relevant', at('/jobs/search/'), true);
    check('so is the notification-reached results route', at('/jobs/search-results/'), true);
    check('so is a standalone job page', at('/jobs/view/4440711789/'), true);
    check('so is the jobs home', at('/jobs/'), true);
    check('a company page is relevant — passive capture reads its size field', at('/company/supersei-ai/life/'), true);
    check('the feed is not', at('/feed/'), false);
    check('messaging is not — the busiest page for a subtree observer, and the main reason to gate',
        at('/messaging/thread/123/'), false);
    check('a profile is not', at('/in/someone/'), false);
    check('notifications are not', at('/notifications/'), false);
    check('the root is not', at('/'), false);
    // Anchored at position 0, so a path that merely CONTAINS the word can't switch the script on.
    check('a path that only mentions jobs later does not count', at('/feed/update/urn:li:jobs/'), false);
    check('nor one that mentions company later', at('/in/someone/company/'), false);
});

// v7.66 (P2). Reporting rather than evicting, deliberately: entries are earned one page view at a
// time over months, and deleting them to solve a storage problem that measurement says doesn't exist
// would be the worst trade in this file.
await suite('describeCacheFootprint (P2) — measure, do not evict', () => {
    function build(companies, slugs) {
        const setup = `
            const companyCache = ${JSON.stringify(companies)};
            const slugCache = ${JSON.stringify(slugs)};
            const companyCacheMeta = {};
        `;
        return buildModule(['CACHE_SIZE_WARN_ENTRIES', 'describeCacheFootprint'], setup);
    }

    {
        const m = build({ acme: '51-200 employees', globex: '10,001+ employees' }, { acme: 'acme-inc' });
        const out = m.describeCacheFootprint();
        check('counts companies', out.indexOf('2 companies') === 0, true);
        check('and slugs separately', out.indexOf('1 slugs') !== -1, true);
        check('reports an approximate footprint in KB', /~\d+ KB of localStorage/.test(out), true);
        check('and puts the number in context rather than leaving it to be worried about',
            out.indexOf('not close to a limit') !== -1, true);
    }

    {
        const many = {};
        for (let i = 0; i < 25000; i++) many['co' + i] = '51-200 employees';
        const m = build(many, {});
        check('past the threshold the framing changes to a heads-up',
            m.describeCacheFootprint().indexOf('approaching the point where localStorage limits') !== -1, true);
        check('but it is still only a statement — nothing here removes an entry',
            Object.keys(many).length, 25000);
    }

    {
        const m = build({}, {});
        check('an empty cache reports cleanly rather than dividing by nothing',
            m.describeCacheFootprint().indexOf('0 companies, 0 slugs') === 0, true);
    }
});

// v7.66 (P3). The <p> rung picks by POSITION, so it fails by choosing the WRONG element rather than
// none — and a wrong pick is written to companyCache under a garbage key. v7.65 established there is
// no positive semantic anchor for the company name on that layout, but there IS a negative one: the
// card labels its own job title, so "the company name is exactly the job title" is a contradiction
// rather than a heuristic. Exact-match only, and both title sources fail closed.
await suite('job-title contradiction guard (P3) — a negative anchor where no positive one exists', () => {
    const m = buildModule(['CARD_DISMISS_LABEL_PATTERN', 'findCardJobTitle', 'isJobTitleNotCompany'],
        'let cardTitleContradictions = 0;');

    function card({ jobLinkLabel, dismissLabel } = {}) {
        const links = jobLinkLabel === undefined ? [] : [fx('a', {
            href: '/jobs/view/123/', 'aria-label': jobLinkLabel
        }, [])];
        const buttons = dismissLabel === undefined ? [] : [fx('button', { 'aria-label': dismissLabel }, [])];
        return fx('div', {}, [...links, ...buttons]);
    }

    {
        check('reads the title from the job link, which labels itself — locale-independent',
            m.findCardJobTitle(card({ jobLinkLabel: 'Back End Developer' })), 'Back End Developer');
    }
    {
        check('falls back to the dismiss button\'s "Dismiss <title> job" phrasing',
            m.findCardJobTitle(card({ dismissLabel: 'Dismiss Software Engineer - Backend job' })), 'Software Engineer - Backend');
    }
    {
        check('a non-English dismiss label simply yields no title — the guard goes quiet, it does not guess',
            m.findCardJobTitle(card({ dismissLabel: 'Descartar la oferta de Ingeniero de Software' })), null);
        check('and an unrelated button label is not mistaken for one',
            m.findCardJobTitle(card({ dismissLabel: 'More options' })), null);
    }
    {
        check('the job link wins over the dismiss button when both exist',
            m.findCardJobTitle(card({ jobLinkLabel: 'Back End Developer', dismissLabel: 'Dismiss Something Else job' })),
            'Back End Developer');
    }
    {
        check('no title anywhere -> null, and therefore no check at all', m.findCardJobTitle(card()), null);
    }

    {
        const c = card({ jobLinkLabel: 'Back End Developer' });
        check('an ordinary company name is untouched — the guard must be inert almost always',
            m.isJobTitleNotCompany(c, 'Supersei.ai'), false);
        check('picking the job title verbatim IS flagged', m.isJobTitleNotCompany(c, 'Back End Developer'), true);
        check('case and whitespace differences do not let it slip through',
            m.isJobTitleNotCompany(c, '  back end   DEVELOPER '), true);
    }
    {
        // The reason it is exact-match rather than substring: "Software Engineer at Acme" is an
        // extremely common title shape, and a substring test would flag it against a real company
        // called Acme — turning a safeguard into a source of dropped cards.
        const c = card({ jobLinkLabel: 'Software Engineer at Acme' });
        check('a company whose name merely APPEARS in the title is not flagged', m.isJobTitleNotCompany(c, 'Acme'), false);
        const c2 = card({ jobLinkLabel: 'Engineer' });
        check('nor is a title that is a substring of the company name', m.isJobTitleNotCompany(c2, 'Engineering Partners Ltd'), false);
    }
    {
        const c = card({ jobLinkLabel: 'Back End Developer' });
        check('empty company text is not flagged — that is the no-match case, handled elsewhere',
            m.isJobTitleNotCompany(c, ''), false);
        check('nor is whitespace-only text', m.isJobTitleNotCompany(c, '   '), false);
        check('and a card with no title cannot flag anything, whatever the company text',
            m.isJobTitleNotCompany(card(), 'Back End Developer'), false);
    }
});

// v7.68. Proves rather than explains the v7.19-style hydration-lag hypothesis: that a card's OUTER
// container can mount before its INNER company element does, missing for exactly one cycle before
// resolving normally. Before this, a miss and its later resolution had no shared identity to prove
// they were the same card — extractCardJobId() now runs on the failure path too, for free, since the
// success path already needed the identical read.
await suite('extractCardJobId — the identity a miss needs before it can be proven transient', () => {
    const m = buildModule(['extractCardJobId']);

    check('reads a /jobs/view/<id> href', m.extractCardJobId(fx('div', {}, [fx('a', { href: '/jobs/view/4441354802/?x=1' }, [])])), '4441354802');
    check('reads a currentJobId= href', m.extractCardJobId(fx('div', {}, [fx('a', { href: '/jobs/collections/?currentJobId=4441354802' }, [])])), '4441354802');
    check('falls back to data-occludable-job-id when no matching link exists',
        m.extractCardJobId(fx('div', { 'data-occludable-job-id': '4441354802' }, [])), '4441354802');
    check('falls back to the componentkey attribute last',
        m.extractCardJobId(fx('div', { componentkey: 'job-card-component-ref-4441354802' }, [])), '4441354802');
    check('an href takes priority over a componentkey on the same card — matches getCardInfo\'s own original priority order',
        m.extractCardJobId(fx('div', { componentkey: 'job-card-component-ref-999' }, [fx('a', { href: '/jobs/view/4441354802/' }, [])])),
        '4441354802');
    check('nothing identifiable -> null, not a crash', m.extractCardJobId(fx('div', {}, [])), null);
});

await suite('transient company-miss tracking (P1, closing the loop) — proof, not explanation', () => {
    function build() {
        return buildModule(['TRANSIENT_MISS_STALE_MS', 'TRANSIENT_MISS_GIVE_UP_MS',
            'pendingCompanyMisses', 'recordTransientCompanyMiss', 'recordTransientCompanyResolution',
            'pruneStaleCompanyMisses', 'FORCE_RENDER_TIMEOUT_MS', 'formatTransientMissSummary'],
            'let transientMissResolvedCount = 0, transientMissResolvedTotalMs = 0, ' +
            'transientMissResolvedMaxMs = 0, transientMissGaveUpCount = 0;');
    }

    {
        const m = build();
        check('nothing observed yet reads as such, not as an empty or zeroed block',
            m.formatTransientMissSummary(), '(no transient misses observed yet this session)');
    }

    {
        // The central proof: a card that misses at t=0 and is seen again, successfully, one cycle
        // later (t=800ms — RUN_POLL_FALLBACK_MS order of magnitude) records that resolution with the
        // correct elapsed time. This is the exact shape the hydration-lag hypothesis predicts.
        const m = build();
        m.recordTransientCompanyMiss('job1', 0);
        m.recordTransientCompanyResolution('job1', 800);
        check('a miss followed by a resolution is recorded, with the real elapsed time',
            m.formatTransientMissSummary().indexOf('1 resolved once pending (avg 800ms, max 800ms)'), 0);
        check('and it is no longer pending once resolved', Object.keys(m.pendingCompanyMisses).length, 0);
    }

    {
        // A card resolved on its FIRST sighting never missed at all — recordTransientCompanyResolution
        // is called unconditionally on every successful read, so this proves it is correctly a no-op
        // for the overwhelming majority case, not just for ones that were tracked.
        const m = build();
        m.recordTransientCompanyResolution('never-missed', 1000);
        check('a resolution with no prior miss is not counted — there is nothing to prove for it',
            m.formatTransientMissSummary(), '(no transient misses observed yet this session)');
    }

    {
        // Repeated misses on the SAME card before it resolves must not reset the clock — the elapsed
        // time has to measure from the FIRST miss, or every number this proves anything with is wrong.
        const m = build();
        m.recordTransientCompanyMiss('job1', 0);
        m.recordTransientCompanyMiss('job1', 200); // still missing, same card, same cycle boundary
        m.recordTransientCompanyMiss('job1', 400);
        m.recordTransientCompanyResolution('job1', 1000);
        check('elapsed time is measured from the FIRST miss, not the most recent one',
            m.formatTransientMissSummary().indexOf('avg 1000ms') !== -1, true);
    }

    {
        // Averaging and the max across several different cards, the numbers a real report would show.
        const m = build();
        m.recordTransientCompanyMiss('a', 0);
        m.recordTransientCompanyResolution('a', 200);
        m.recordTransientCompanyMiss('b', 0);
        m.recordTransientCompanyResolution('b', 1000);
        const out = m.formatTransientMissSummary();
        check('averages across multiple resolved misses', out.indexOf('avg 600ms') !== -1, true);
        check('and reports the true max, not the average', out.indexOf('max 1000ms') !== -1, true);
    }

    {
        // v7.68: found by this exact test — formatTransientMissSummary(now) takes an explicit clock,
        // the same testability pattern reportCardYieldHealth and detailYieldVerdict already use in
        // this file, rather than reading Date.now() inline. Without it, a fake-timestamped miss (0)
        // compared against REAL wall-clock time reads as decades old and is pruned as abandoned
        // before this test can even observe it as "pending".
        const m = build();
        m.recordTransientCompanyMiss('job1', 0);
        const out = m.formatTransientMissSummary(500); // read one short interval later, still pending
        check('a miss that has not resolved YET is reported as pending', out.indexOf('1 still pending') !== -1, true);
        check('but not yet flagged as stale — this is the normal, unremarkable state', out.indexOf('(0 past') !== -1, true);
    }

    {
        check('recordTransientCompanyMiss on an unidentifiable card is a safe no-op',
            (() => { const m = build(); m.recordTransientCompanyMiss(null, 0); return Object.keys(m.pendingCompanyMisses).length; })(), 0);
    }

    {
        // Past TRANSIENT_MISS_GIVE_UP_MS: dropped outright and counted separately, so the tracking map
        // can never grow without bound across a long scrolling session, and a permanently-abandoned
        // card is distinguished in the report from one that is still being watched.
        const m = build();
        m.recordTransientCompanyMiss('job1', 0);
        m.recordTransientCompanyMiss('job2', m.TRANSIENT_MISS_GIVE_UP_MS + 1000); // triggers the prune
        const out = m.formatTransientMissSummary(m.TRANSIENT_MISS_GIVE_UP_MS + 1000);
        check('a miss abandoned past the give-up window is pruned from pending', out.indexOf('1 given up on') !== -1, true);
        check('and the map itself shrinks — job1 is gone, only the newer job2 remains',
            Object.keys(m.pendingCompanyMisses), ['job2']);
    }

    {
        // Repeated misses on the SAME card must not repeatedly reset the give-up clock either —
        // proving the v7.68 falsy-zero fix holds even when the first miss legitimately happened at
        // clock time 0, the exact value that exposed the original bug.
        const m = build();
        m.recordTransientCompanyMiss('job1', 0);
        m.recordTransientCompanyMiss('job1', 100);
        m.recordTransientCompanyMiss('job1', 200);
        check('the tracked first-miss time is still the ORIGINAL one, not the most recent re-miss',
            m.pendingCompanyMisses.job1, 0);
    }

    {
        // pruneStaleCompanyMisses runs at REPORT time too, not only on the next miss — otherwise a
        // long-abandoned entry could sit in "still pending" indefinitely if misses happened to stop.
        const m = build();
        m.recordTransientCompanyMiss('job1', 0);
        m.formatTransientMissSummary(m.TRANSIENT_MISS_GIVE_UP_MS + 5000);
        check('an entry stale enough to give up on is pruned by reading the report alone, no new miss needed',
            Object.keys(m.pendingCompanyMisses).length, 0);
    }
});

// v7.64. Two targeted views replacing the hope that a deeper blind dump would eventually contain the
// answer. The card rung's failure mode is what makes this worth building: findComponentKeyCompanyElement()
// picks the first CHILDLESS <p> with text, so it fails by selecting the WRONG element — caching a
// location or a "Viewed" label as a company name — not by selecting none. Hit rates can't detect that;
// only seeing what it picked can.
await suite('card diagnostics (buildCardTextInventory / describeCardCompanyExtraction)', () => {
    function build(card) {
        const setup = `
            const CARD = arguments[3];
            function getCardInfo(c) { return c && c.__info ? c.__info : null; }
        `;
        const decls = ['DOM_SKELETON_TEXT_CAP', 'DOM_SKELETON_ATTR_VALUE_CAP', 'CARD_TEXT_INVENTORY_MAX',
            'CARD_EXTRACTION_TRACE_MAX', 'CARD_TRACE_EXTRA_RUNGS', 'CARD_COMPANY_SELECTORS',
            'CARD_COMPANY_FALLBACK_LABEL', 'directTextOf', 'cardTextOf', 'isPresentationalSubtree',
            'findComponentKeyCompanyElement', 'traceOneCard', 'formatCardTrace',
            'buildCardTextInventory', 'describeCardCompanyExtraction']
            .map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${decls}\n\nmodule.exports = { buildCardTextInventory, describeCardCompanyExtraction,
            CARD_TEXT_INVENTORY_MAX, CARD_EXTRACTION_TRACE_MAX, CARD_TRACE_EXTRA_RUNGS, CARD_COMPANY_FALLBACK_LABEL };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require, card);
        return mod.exports;
    }

    // The real componentkey card's nesting, transcribed from the live capture: wrapper divs all the
    // way down, with the content only at the bottom. This is exactly the shape that defeated a
    // depth-limited walk twice.
    function deepCard(leaves) {
        let node = fx('div', { class: 'c1ccab5e' }, leaves);
        for (let i = 0; i < 6; i++) node = fx('div', { class: `wrap-${i}` }, [node]);
        const card = fx('div', { class: '_033a7091', role: 'button', componentkey: 'job-card-component-ref-4350752081' }, [
            fx('figure', { class: '_95f3c4d1', 'aria-hidden': 'true' }, [fx('svg', {}, [fx('path', { d: 'M14' }, [])])]),
            node
        ]);
        return card;
    }

    {
        const card = deepCard([
            fx('p', { class: 'title-cls' }, [fx('span', { __text: 'Software Engineer - Backend' }, [])]),
            fx('p', { class: 'a1519b12', __text: 'CoverForce' }, []),
            fx('p', { class: 'loc-cls', __text: 'India (Remote)' }, [])
        ]);
        const inv = build(card).buildCardTextInventory(card);
        check('reaches text that a depth-limited structural walk could not', inv.indexOf('text="CoverForce"') !== -1, true);
        check('reports the ancestor path, so a replacement selector can be written against it',
            /div>div>div>div>div>div>div>div>p\.a1519b12/.test(inv), true);
        check('reports the CHILD COUNT — the exact predicate findComponentKeyCompanyElement selects on',
            inv.indexOf('p.a1519b12 children=0 text="CoverForce"') !== -1, true);
        check('a <p> that merely WRAPS a span shows no direct text of its own, which is why the title rung skips it',
            inv.indexOf('text="Software Engineer - Backend"') !== -1, true);
        check('and the wrapping <p> is reported as having children, distinguishing it from the company one',
            /p\.title-cls children=1/.test(inv) === false, true);
        check('presentational subtrees are skipped here too, so icons never crowd out content',
            inv.indexOf('<path>') === -1, true);
    }

    {
        const inv = build(null).buildCardTextInventory(fx('div', {}, []));
        check('a card with no text at all says so rather than emitting an empty block',
            inv, '  (no text-bearing elements found in this card)');
    }

    {
        const leaves = Array.from({ length: 60 }, (_, i) => fx('p', { class: `p${i}`, __text: `t${i}` }, []));
        const m = build(null);
        const inv = m.buildCardTextInventory(deepCard(leaves));
        check('the inventory is capped, so one dense card cannot flood the report',
            inv.split('\n').length <= m.CARD_TEXT_INVENTORY_MAX, true);
    }

    {
        const el = fx('div', { 'aria-label': 'Dismiss Software Engineer - Backend job', __text: 'x' }, []);
        const inv = build(null).buildCardTextInventory(fx('div', {}, [el]));
        check('an aria-label is surfaced alongside the text — the live card exposes the job title that way',
            inv.indexOf('aria-label="Dismiss Software Engineer - Backend job"') !== -1, true);
    }

    // describeCardCompanyExtraction — v7.65. Covers BOTH layouts deliberately: v7.64's version was
    // shaped around /jobs/search-results/ alone and reported `text=""` on /jobs/search/, where the
    // chain was in fact working perfectly. Under-testing one route is exactly what produced that.

    // The BEM card, transcribed from the live /jobs/search/ capture. The decisive detail is that
    // .artdeco-entity-lockup__subtitle is a WRAPPER whose text lives in a child <span> — the shape
    // that made the old directTextOf()-based trace report an empty string.
    function bemCard(company, title, jobId) {
        return fx('li', { class: 'scaffold-layout__list-item', 'data-occludable-job-id': jobId }, [
            fx('div', { class: 'job-card-container' }, [
                fx('div', { class: 'artdeco-entity-lockup__content' }, [
                    fx('div', { class: 'artdeco-entity-lockup__title' }, [
                        fx('a', { href: `/jobs/view/${jobId}/`, 'aria-label': title }, [
                            fx('span', {}, [fx('strong', { __text: title }, [])])
                        ])
                    ]),
                    fx('div', { class: 'artdeco-entity-lockup__subtitle' }, [
                        fx('span', { dir: 'ltr', __text: company }, [])
                    ])
                ])
            ])
        ]);
    }

    {
        const card = bemCard('Supersei.ai', 'Back End Developer', '4440711789');
        card.__info = { normalizedName: 'supersei ai', jobId: '4440711789' };
        const out = build(card).describeCardCompanyExtraction([card]);
        check('BEM layout: names the rung that matched', out.indexOf('via=.artdeco-entity-lockup__subtitle') !== -1, true);
        check('BEM layout: shows the company text the rung will actually READ — the v7.64 regression was an empty string here',
            out.indexOf('picked="Supersei.ai"') !== -1, true);
        check('BEM layout: and what the chain resolved to', out.indexOf('resolved="supersei ai"') !== -1, true);
        check('BEM layout: reports the element type it traced', out.indexOf('[0] <li>') !== -1, true);
    }

    {
        const card = deepCard([
            fx('p', { class: 'title-cls' }, [fx('span', { __text: 'Software Engineer' }, [])]),
            fx('p', { class: 'a1519b12', __text: 'CoverForce' }, [])
        ]);
        card.__info = { normalizedName: 'coverforce', jobId: '4350752081' };
        const m = build(card);
        const out = m.describeCardCompanyExtraction([card]);
        check('componentkey layout: falls through to the <p> rung and names it by MECHANISM, not by an assumed layout',
            out.indexOf(`via=${m.CARD_COMPANY_FALLBACK_LABEL}`) !== -1, true);
        check('and that label describes what the rung does rather than asserting where it runs',
            m.CARD_COMPANY_FALLBACK_LABEL.indexOf('componentkey') === -1, true);
        check('componentkey layout: shows which element it landed on', out.indexOf('picked="CoverForce"') !== -1, true);
        check('componentkey layout: and what the chain resolved to', out.indexOf('resolved="coverforce"') !== -1, true);
    }

    {
        // The <p> fallback must be consulted ONLY when the named chain missed — mirroring
        // getCardInfo's real order. Reporting a fallback "pick" the real code never looked at would
        // make the trace describe a path that does not exist.
        const card = bemCard('Supersei.ai', 'Back End Developer', '1');
        card.__info = { normalizedName: 'supersei ai', jobId: '1' };
        const out = build(card).describeCardCompanyExtraction([card]);
        check('a named match means the fallback is never reported as having picked anything',
            out.indexOf('<p> fallback (componentkey layout)') === -1, true);
    }

    {
        // The dangerous failure, made visible. If a childless <p> holding chrome renders before the
        // company's, the rung silently caches the wrong thing — the trace shows that directly.
        const card = deepCard([
            fx('p', { class: 'chrome', __text: 'Viewed' }, []),
            fx('p', { class: 'a1519b12', __text: 'CoverForce' }, [])
        ]);
        card.__info = { normalizedName: 'viewed', jobId: '99' };
        const out = build(card).describeCardCompanyExtraction([card]);
        check('a wrong pick is stated plainly instead of being invisible behind a healthy hit rate',
            out.indexOf('picked="Viewed"') !== -1, true);
        check('and the bad value it produced is shown next to it', out.indexOf('resolved="viewed"') !== -1, true);
    }

    {
        const card = deepCard([]);
        card.__info = null;
        const out = build(card).describeCardCompanyExtraction([card]);
        check('a card nothing can read reports nothing matched', out.indexOf('via=nothing matched') !== -1, true);
        check('and is called out as counting against the filtering yield',
            out.indexOf('resolved=null (unreadable — counts against the filtering yield)') !== -1, true);
    }

    {
        // The reason this became per-card in v7.65: a first-card-only trace can show exactly one
        // outcome, and the live BEM capture reported a MIX (74% named / 14% fallback / 12% none).
        const good = bemCard('Supersei.ai', 'Back End Developer', '1');
        good.__info = { normalizedName: 'supersei ai', jobId: '1' };
        const empty = deepCard([]);
        empty.__info = null;
        const out = build(null).describeCardCompanyExtraction([good, empty, good]);
        check('traces several cards, so a MIX of outcomes is legible rather than hidden behind card 0',
            out.split('\n').length, 3);
        check('the differing outcomes are visible side by side',
            out.indexOf('[1] <div> via=nothing matched') !== -1, true);
    }

    // v7.66 (P1). The first N cards are not guaranteed to contain the interesting one. The live
    // /jobs/search/ capture split 74% named / 14% <p> fallback / 12% no-match while its first six
    // cards all took the SAME rung — so the report showed a uniform picture of a page that
    // demonstrably was not uniform, and the minority rungs went unexplained purely because of where
    // they sat in the list. These pin that a mix is now surfaced regardless of ordering.
    {
        const named = () => { const c = bemCard('Supersei.ai', 'Back End Developer', '1'); c.__info = { normalizedName: 'supersei ai', jobId: '1' }; return c; };
        const fallback = () => {
            const c = deepCard([fx('p', { class: 'a1519b12', __text: 'CoverForce' }, [])]);
            c.__info = { normalizedName: 'coverforce', jobId: '2' };
            return c;
        };
        // Ten named cards, then one that takes a different rung — invisible to a first-6-only trace.
        const cards = [...Array.from({ length: 10 }, named), fallback()];
        const out = build(null).describeCardCompanyExtraction(cards);
        check('a minority rung buried past the trace cap is surfaced anyway',
            out.indexOf('(first card using a different rung)') !== -1, true);
        check('and it is the right card — the one whose rung differs', out.indexOf('picked="CoverForce"') !== -1, true);
        check('reported at its real index, not renumbered', out.indexOf('[10] (first card using a different rung)') !== -1, true);
    }

    {
        // The reassuring case: when the remainder genuinely is uniform, say so, rather than leaving
        // an untraced count that always looks like it might be hiding something.
        const named = () => { const c = bemCard('Supersei.ai', 'Back End Developer', '1'); c.__info = { normalizedName: 'supersei ai', jobId: '1' }; return c; };
        const out = build(null).describeCardCompanyExtraction(Array.from({ length: 12 }, named));
        check('a uniform remainder is stated as such, closing the doubt instead of leaving it open',
            out.indexOf('all resolve through a rung already shown above') !== -1, true);
        check('and no different-rung entry is invented when there is none',
            out.indexOf('(first card using a different rung)') === -1, true);
    }

    {
        const cards = Array.from({ length: 20 }, () => { const c = deepCard([]); c.__info = null; return c; });
        const m = build(null);
        const out = m.describeCardCompanyExtraction(cards);
        check('the trace is capped so a long list cannot flood the report',
            out.split('\n').length, m.CARD_EXTRACTION_TRACE_MAX + 1);
        check('and says how many it left out rather than truncating silently',
            out.indexOf(`… ${20 - m.CARD_EXTRACTION_TRACE_MAX} more card(s) not traced`) !== -1, true);
    }

    {
        check('no cards at all is stated, not crashed on',
            build(null).describeCardCompanyExtraction([]), '  (no job cards on this page)');
        check('and a null card list is handled the same way',
            build(null).describeCardCompanyExtraction(null), '  (no job cards on this page)');
    }
});

// v7.62. Reported live: a permanent "⚠️ Company size badge" on /jobs/search-results/ while the badge
// itself worked correctly. The old rule was "any rung that isn't a named selector is a degradation",
// which is false on the componentkey layout — the Diagnose report showed h1=0, all five named
// selectors false, and cards matching ONLY the componentkey container, i.e. the v7.5/v7.48 build
// where no class-name selector can exist at all. These tests pin BOTH directions: quiet where the
// structural rung is the intended mechanism, still loud where a better rung really did miss.
await suite('isExpectedBadgeRung / isComponentKeyLayout — a permanent warning is a warning nobody reads', () => {
    function build({ componentKeyPresent }) {
        const setup = `
            function getSearchDocuments() {
                return [{ querySelector(sel) { return ${componentKeyPresent} && sel.indexOf('componentkey') !== -1 ? {} : null; } }];
            }
        `;
        return buildModule(['BADGE_HEADER_SELECTORS', 'BADGE_TOP_CARD_LINK_LABEL',
            'COMPONENT_KEY_CARD_ATTR_SELECTOR', 'isComponentKeyLayout', 'BADGE_ARIA_LABEL_LINK_LABEL', 'BADGE_ALWAYS_EXPECTED_RUNGS', 'isExpectedBadgeRung'], setup);
    }

    {
        const m = build({ componentKeyPresent: false });
        check('a named selector is always expected, on any layout',
            m.isExpectedBadgeRung('.job-details-jobs-unified-top-card__company-name'), true);
        check('the layout probe correctly reports a NON-componentkey page', m.isComponentKeyLayout(), false);
        check('on the BEM layout the structural rung still reports as a fallback — a named rung was available and missed',
            m.isExpectedBadgeRung(m.BADGE_TOP_CARD_LINK_LABEL), false);
    }

    {
        // The exact reported page shape.
        const m = build({ componentKeyPresent: true });
        check('the layout probe detects the componentkey build', m.isComponentKeyLayout(), true);
        check('on that layout the top-card link is the EXPECTED mechanism (v7.48 built it for this), not a degradation',
            m.isExpectedBadgeRung(m.BADGE_TOP_CARD_LINK_LABEL), true);
        check('a named selector would still be expected there too, had one matched',
            m.isExpectedBadgeRung(m.BADGE_HEADER_SELECTORS[0]), true);
    }

    {
        // v7.63: the aria-label rung is expected on EVERY layout, unlike the top-card rung. It isn't a
        // degraded path anywhere — it's a stronger anchor than the class names it sits behind, so it
        // winning is a good outcome rather than something to warn about.
        const bem = build({ componentKeyPresent: false });
        check('the aria-label rung is expected on the BEM layout, where the top-card rung would warn',
            bem.isExpectedBadgeRung(bem.BADGE_ARIA_LABEL_LINK_LABEL), true);
        const ck = build({ componentKeyPresent: true });
        check('and on the componentkey layout too', ck.isExpectedBadgeRung(ck.BADGE_ARIA_LABEL_LINK_LABEL), true);
        check('the two rungs are genuinely treated differently on the BEM layout, not collapsed together',
            bem.isExpectedBadgeRung(bem.BADGE_TOP_CARD_LINK_LABEL), false);
    }

    {
        // The narrowness of the exemption is the point: it must not become "nothing is ever a
        // fallback on this layout". The scoped rung sits BELOW the top-card rung in findBadgeHeader,
        // so reaching it means the top-card rung missed too — that is still worth surfacing.
        const m = build({ componentKeyPresent: true });
        check('the exemption covers exactly one rung — the scoped fallback is still reported as a fallback',
            m.isExpectedBadgeRung('a[href*="/company/"] (scoped)'), false);
        check('and an unrecognised rung label is never silently treated as expected',
            m.isExpectedBadgeRung('something-invented'), false);
    }
});

// v7.62. Structure without content. Every markup incident in this project so far (v7.5, v7.27, v7.48)
// needed a throwaway diagnostic shipped, run, and removed before the real fix could be attempted —
// a full round-trip each time, because counts and booleans prove WHICH chain broke but never say
// what to replace it with. The caps are the load-bearing part of these tests: an unbounded walk
// would turn a bug report into a page dump.
await suite('DOM skeleton capture — enough structure to write the replacement selector', () => {
    const m = buildModule(['DOM_SKELETON_MAX_DEPTH', 'DOM_SKELETON_MAX_CHILDREN', 'DOM_SKELETON_MAX_NODES',
        'DOM_SKELETON_TEXT_CAP', 'DOM_SKELETON_CLASS_CAP', 'DOM_SKELETON_ATTR_VALUE_CAP',
        'directTextOf', 'isPresentationalSubtree', 'describeElementSkeleton', 'renderElementSkeleton']);

    // Duck-typed to exactly the six things the walker touches, so these tests also pin that surface.
    function el(tag, className, attrs, text, children) {
        const node = {
            tagName: tag.toUpperCase(),
            className: className || '',
            children: children || [],
            parentElement: null,
            getAttributeNames() { return Object.keys(attrs || {}); },
            getAttribute(n) { return (attrs || {})[n]; },
            childNodes: text ? [{ nodeType: 3, nodeValue: text }] : []
        };
        (children || []).forEach((c) => { c.parentElement = node; });
        return node;
    }

    {
        const node = el('p', '', {}, '  Nike   \n  Bengaluru ');
        check('direct text is collapsed and trimmed', m.directTextOf(node), 'Nike Bengaluru');
    }

    {
        // The whole reason textContent is not used: it folds every descendant into the parent, which
        // makes "which element actually holds the company name?" — the question this exists to
        // answer — unanswerable from the dump.
        const child = el('span', '', {}, 'Software Engineer');
        const parent = { tagName: 'DIV', className: '', children: [child], childNodes: [child], getAttributeNames: () => [], getAttribute: () => null };
        check('a parent whose text lives only in a child reports NO direct text of its own',
            m.directTextOf(parent), '');
    }

    {
        // The reported componentkey card, as the report would render it.
        const card = el('div', 'card-outer', { role: 'button', componentkey: 'job-card-component-ref-4441354802' }, '', [
            el('p', '_20e55808 b0593cae', {}, 'Nike'),
            el('p', 'hashed-two', {}, 'Bengaluru, Karnataka, India')
        ]);
        const out = m.renderElementSkeleton(card).split('\n');
        check('the root element reports its tag', out[0].indexOf('<div>'), 0);
        check('attribute NAMES and values are shown — they survive class hashing, so a replacement selector is built from them',
            out[0].indexOf('componentkey="job-card-component-ref-4441354802"') !== -1, true);
        check('hashed class names are shown verbatim, which is itself the evidence of the migration',
            out[1].indexOf('class="_20e55808 b0593cae"') !== -1, true);
        check('each child is indented under its parent, so nesting is readable', out[1].indexOf('  <p>'), 0);
        check('and each child carries its own direct text, identifying which one holds the company name',
            out[1].indexOf('text="Nike"') !== -1, true);
        check('class and style are excluded from the attribute list (class is already rendered separately)',
            out[0].indexOf('style=') === -1, true);
    }

    {
        const long = 'x'.repeat(500);
        const node = el('div', long, { 'data-thing': long }, long);
        const out = m.renderElementSkeleton(node);
        check('element text is capped', out.indexOf(`text="${'x'.repeat(m.DOM_SKELETON_TEXT_CAP)}"`) !== -1, true);
        check('class is capped', out.indexOf(`class="${'x'.repeat(m.DOM_SKELETON_CLASS_CAP)}"`) !== -1, true);
        check('attribute values are capped', out.indexOf(`data-thing="${'x'.repeat(m.DOM_SKELETON_ATTR_VALUE_CAP)}"`) !== -1, true);
    }

    {
        // Depth: a chain longer than the cap must stop and SAY it stopped, not silently truncate.
        let node = el('span', 'deepest', {}, 'bottom');
        for (let i = 0; i < 10; i++) node = el('div', `level-${i}`, {}, '', [node]);
        const out = m.renderElementSkeleton(node);
        check('the walk stops at the depth cap', out.indexOf('depth cap reached') !== -1, true);
        check('and the deepest element is genuinely absent, not merely unindented', out.indexOf('deepest') === -1, true);
    }

    {
        const kids = Array.from({ length: 20 }, (_, i) => el('p', `kid-${i}`, {}, `text ${i}`));
        const out = m.renderElementSkeleton(el('div', 'parent', {}, '', kids));
        check('siblings are capped per level', out.indexOf(`… ${20 - m.DOM_SKELETON_MAX_CHILDREN} more sibling(s) not shown`) !== -1, true);
        check('the ones shown are the first N, in document order', out.indexOf('text="text 0"') !== -1, true);
        check('and the ones past the cap really are omitted', out.indexOf('text="text 19"') === -1, true);
    }

    {
        // Depth and sibling caps alone still allow a combinatorial blow-up, so a hard total budget is
        // the actual guarantee that a bug report stays a bug report.
        function wide(depth) {
            if (depth === 0) return el('span', 'leaf', {}, 'x');
            return el('div', `d${depth}`, {}, '', Array.from({ length: 6 }, () => wide(depth - 1)));
        }
        const out = m.renderElementSkeleton(wide(4));
        check('a deep AND wide tree trips the total-node budget', out.indexOf('node budget') !== -1, true);
        const bodyLines = out.split('\n').filter((l) => l.indexOf('<') !== -1);
        check('and the total node count never exceeds the budget, whatever the shape',
            bodyLines.length <= m.DOM_SKELETON_MAX_NODES, true);
    }

    {
        check('nothing to describe is stated plainly rather than crashing or emitting a blank block',
            m.renderElementSkeleton(null), '(nothing to describe)');
        check('a non-element (e.g. a text node) is handled the same way', m.renderElementSkeleton({}), '');
    }

    // v7.63: driven by the first real capture. The walk was descending
    // <figure aria-hidden="true"> -> <svg> -> <path d="M14 12a2 2 0 1 1-2-2…">, spending the node
    // budget on decoration while the company name sat unreached further down the card. Both rules are
    // semantic rather than a tag blocklist: aria-hidden="true" is the DOM's own statement that a
    // subtree carries no meaningful content, and an <svg>'s children are drawing instructions.
    {
        check('an <svg> is presentational by definition', m.isPresentationalSubtree({ tagName: 'SVG', getAttribute: () => null }), true);
        check('so is anything the page itself marks aria-hidden',
            m.isPresentationalSubtree({ tagName: 'DIV', getAttribute: (n) => (n === 'aria-hidden' ? 'true' : null) }), true);
        check('aria-hidden="false" is NOT presentational — the attribute\'s value is what matters, not its presence',
            m.isPresentationalSubtree({ tagName: 'DIV', getAttribute: (n) => (n === 'aria-hidden' ? 'false' : null) }), false);
        check('an ordinary element is walked normally', m.isPresentationalSubtree({ tagName: 'DIV', getAttribute: () => null }), false);
    }

    {
        const icon = el('figure', 'logo', { 'aria-hidden': 'true' }, '', [
            el('svg', '', {}, '', [el('path', '', { d: 'M14 12a2 2 0 1 1-2-2' })])
        ]);
        const card = el('div', 'card', { componentkey: 'job-card-component-ref-1' }, '', [
            icon,
            el('p', 'name', {}, 'BitGo')
        ]);
        const out = m.renderElementSkeleton(card);
        check('the presentational element itself is still reported — its existence is information',
            out.indexOf('<figure>') !== -1, true);
        check('but its interior is not walked', out.indexOf('<path>') === -1, true);
        check('and the skip is stated, never silent', out.indexOf('presentational subtree not walked') !== -1, true);
        check('so the budget reaches the content that actually matters', out.indexOf('text="BitGo"') !== -1, true);
    }

    {
        // The caps that the first real capture proved were too tight: the card's <p> elements sat
        // below the old depth of 4, and a 40-char attribute cap cut both the company slug out of an
        // href and the company name out of an aria-label.
        check('depth reaches the level the real componentkey card keeps its company name at',
            m.DOM_SKELETON_MAX_DEPTH >= 6, true);
        const node = el('a', '', {
            href: 'https://www.linkedin.com/company/7-eleven-global-solution-center-india/life/',
            'aria-label': 'Company, BCE Global Tech - A Bell Canada Company.'
        }, '');
        const out = m.renderElementSkeleton(node);
        check('an href keeps its slug instead of being cut mid-path',
            out.indexOf('/company/7-eleven-global-solution-center-india/') !== -1, true);
        check('and an aria-label keeps the whole company name',
            out.indexOf('Company, BCE Global Tech - A Bell Canada Company.') !== -1, true);
    }
});

// v7.61. The central guarantee here is the SECOND block: attribution must not change which element
// a chain resolves to. A comma-joined querySelector returns the first match in DOCUMENT order; a
// sequential loop over the same selectors returns the first match in SELECTOR order. Those differ on
// any card carrying both an `.artdeco-entity-lockup__subtitle` and a `/company/` link, and getting it
// wrong would silently move which element getCardInfo() reads text from and where the inline card
// badge attaches — a measurement changing the thing it measures.
await suite('selector attribution — recordSelectorHit / queryWithAttribution / formatSelectorStats', () => {
    function build() {
        return buildModule(['selectorStats', 'recordSelectorHit', 'queryWithAttribution', 'formatSelectorStats']);
    }
    function el(...matching) {
        return { __tag: matching.join('+'), matches: (sel) => matching.includes(sel) };
    }
    // Records every selector string it is handed, so a test can assert HOW the query was issued and
    // not merely what came back.
    function root(result) {
        const asked = [];
        return { asked, querySelector(sel) { asked.push(sel); return result; } };
    }

    {
        const m = build();
        m.recordSelectorHit('chain.a', '.one');
        m.recordSelectorHit('chain.a', '.one');
        m.recordSelectorHit('chain.a', '.two');
        m.recordSelectorHit('chain.b', '.three');
        check('hits accumulate per chain and per selector',
            m.selectorStats, { 'chain.a': { '.one': 2, '.two': 1 }, 'chain.b': { '.three': 1 } });
    }

    {
        const m = build();
        const r = root(el('.b'));
        m.queryWithAttribution('c', r, ['.a', '.b', '.c']);
        check('issues exactly ONE querySelector call, never one per selector', r.asked.length, 1);
        check('and that call is the comma-joined list — document-order semantics preserved exactly',
            r.asked[0], '.a, .b, .c');
    }

    {
        const m = build();
        const target = el('.b');
        const out = m.queryWithAttribution('c', root(target), ['.a', '.b', '.c']);
        check('returns the element the single query found', out.el, target);
        check('attributed to the selector that element actually matches', out.selector, '.b');
        check('and recorded under that selector', m.selectorStats.c, { '.b': 1 });
    }

    {
        const m = build();
        const out = m.queryWithAttribution('c', root(el('.c', '.a')), ['.a', '.b', '.c']);
        check('an element matching several selectors is attributed to the first in ARRAY order (stable label)',
            out.selector, '.a');
    }

    {
        const m = build();
        const out = m.queryWithAttribution('c', root(null), ['.a', '.b']);
        check('a total miss returns null', out, null);
        check('a total miss records NOTHING — the caller reports its own fallback outcome, so recording here would double-count',
            m.selectorStats.c, undefined);
    }

    {
        const m = build();
        const out = m.queryWithAttribution('c', root(el('.zzz')), ['.a', '.b']);
        check('an element matching none of the listed selectors is still labelled, never dropped silently',
            out.selector, '(unknown)');
    }

    {
        const m = build();
        check('no activity yet reads as such, not as an empty section', m.formatSelectorStats(), '(no selector activity recorded yet)');
    }

    {
        const m = build();
        ['.subtitle', '.subtitle', '.subtitle', '(no match)'].forEach((s) => m.recordSelectorHit('card.company', s));
        check('formats each chain with counts and within-chain percentages, busiest rung first',
            m.formatSelectorStats(), 'card.company:\n  3 (75%)  .subtitle\n  1 (25%)  (no match)');
    }

    {
        const m = build();
        m.recordSelectorHit('z.chain', '.beta');
        m.recordSelectorHit('a.chain', '.alpha');
        check('chains are listed in stable alphabetical order, not insertion order',
            m.formatSelectorStats().split('\n')[0], 'a.chain:');
    }

    {
        const m = build();
        m.recordSelectorHit('c', '.zebra');
        m.recordSelectorHit('c', '.apple');
        check('equal counts tie-break alphabetically, so the report never reshuffles between runs',
            m.formatSelectorStats(), 'c:\n  1 (50%)  .apple\n  1 (50%)  .zebra');
    }
});

// v7.61. This is the alarm itself. Its whole value rests on being trusted when it fires, so the
// false-positive cases (a page with no list; cards mid-hydration) matter more here than the true
// positives — a spurious ❌ trains you to ignore the panel, which is strictly worse than no panel.
await suite('reportCardYieldHealth — detecting a break that used to report itself as healthy', () => {
    function build({ orphans = 0 } = {}) {
        const setup = `
            let cardYieldDegradedSince = null;
            const featureHealth = {};
            function setFeatureHealth(id, status, detail) { featureHealth[id] = { status, detail: detail || '' }; }
            function getSearchDocuments() { return [{ querySelectorAll() { return new Array(${orphans}).fill(0); } }]; }
        `;
        const decls = ['CARD_YIELD_GRACE_MS', 'CARD_YIELD_MIN_RATIO', 'CARD_PROBE_SELECTOR', 'CARD_PROBE_MIN',
            'countOrphanJobSignals', 'reportCardYieldHealth'].map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${decls}\n\nmodule.exports = { reportCardYieldHealth, countOrphanJobSignals,
            CARD_YIELD_GRACE_MS, get health() { return featureHealth.filtering; } };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    {
        const m = build();
        m.reportCardYieldHealth(0, 0, 0);
        check('no cards and no job markers -> idle, not an alarm (you are simply not on a job list)', m.health.status, 'idle');
    }

    {
        const m = build();
        m.reportCardYieldHealth(25, 25, 0);
        check('everything readable -> ok', m.health.status, 'ok');
    }

    {
        const m = build();
        m.reportCardYieldHealth(25, 13, 0);
        check('just over half readable -> ok, no alarm for a partially-hydrated list', m.health.status, 'ok');
    }

    {
        const G = build().CARD_YIELD_GRACE_MS;
        const m = build();
        m.reportCardYieldHealth(25, 0, 0);
        check('ZERO readable but only just now -> idle, because containers legitimately mount before their content (v7.19)',
            m.health.status, 'idle');
        m.reportCardYieldHealth(25, 0, G - 1);
        check('still inside the grace window -> still idle', m.health.status, 'idle');
        m.reportCardYieldHealth(25, 0, G);
        check('sustained past the grace window -> failed', m.health.status, 'failed');
        check('and says what was actually observed, in the language of the likely cause',
            m.health.detail, '25 job cards found, none readable — company-name selectors may have changed');
    }

    {
        const G = build().CARD_YIELD_GRACE_MS;
        const m = build();
        m.reportCardYieldHealth(25, 8, 0);
        m.reportCardYieldHealth(25, 8, G);
        check('a SUSTAINED partial read is a warning, not a failure — some cards still work', m.health.status, 'fallback');
        check('and reports both numbers so the ratio is visible', m.health.detail, '25 job cards found, only 8 readable');
    }

    {
        const G = build().CARD_YIELD_GRACE_MS;
        const m = build();
        m.reportCardYieldHealth(25, 0, 0);          // degrade starts
        m.reportCardYieldHealth(25, 25, 1000);      // recovers before the window elapses
        check('recovery inside the grace window reports ok', m.health.status, 'ok');
        m.reportCardYieldHealth(25, 0, 2000);       // degrades again
        m.reportCardYieldHealth(25, 0, 2000 + G - 1);
        check('and RESETS the timer — a later degrade gets its own full grace window, never an inherited one',
            m.health.status, 'idle');
        m.reportCardYieldHealth(25, 0, 2000 + G);
        check('which then fires on its own schedule', m.health.status, 'failed');
    }

    {
        const G = build({ orphans: 12 }).CARD_YIELD_GRACE_MS;
        const m = build({ orphans: 12 });
        m.reportCardYieldHealth(0, 0, 0);
        check('no cards matched but job-card markers ARE present -> still graced first, never an instant alarm', m.health.status, 'idle');
        m.reportCardYieldHealth(0, 0, G);
        check('sustained -> failed, pointing at the container chain rather than the company-name chain', m.health.status, 'failed');
        check('and reports the marker count that contradicts the zero',
            m.health.detail, '12 job-card markers on the page but no card matched — container selectors may have changed');
    }

    {
        const G = build({ orphans: 2 }).CARD_YIELD_GRACE_MS;
        const m = build({ orphans: 2 });
        m.reportCardYieldHealth(0, 0, 0);
        m.reportCardYieldHealth(0, 0, G * 10);
        check('a couple of stray markers is below the threshold and never alarms, however long it persists',
            m.health.status, 'idle');
    }

    {
        const m = build({ orphans: 9 });
        check('the probe counts across every document it is given', m.countOrphanJobSignals(), 9);
    }
});

// v7.61. The subtle part is not the verdict — it's that a single job must never be able to fill the
// window on its own. A failed read RETRIES every tick for as long as that job stays open, so the
// naive "record on failure" would have alarmed within seconds of one ordinary size-less company.
await suite('detailYieldVerdict / recordDetailReadOutcome — passive-capture stall detection', () => {
    function build() {
        return buildModule(['DETAIL_YIELD_WINDOW', 'detailReadOutcomes', 'recordDetailReadOutcome', 'detailYieldVerdict']);
    }

    {
        const m = build();
        check('nothing observed yet -> no verdict (absence of evidence is not evidence)', m.detailYieldVerdict(), null);
    }

    {
        const m = build();
        for (let i = 0; i < m.DETAIL_YIELD_WINDOW - 1; i++) m.recordDetailReadOutcome(false);
        check('one short of a full window -> still no verdict, however bad it looks', m.detailYieldVerdict(), null);
    }

    {
        const m = build();
        for (let i = 0; i < m.DETAIL_YIELD_WINDOW; i++) m.recordDetailReadOutcome(false);
        const verdict = m.detailYieldVerdict();
        check('a full window of consecutive empty reads -> a verdict', typeof verdict, 'string');
        check('which names the window size so the evidence behind it is legible',
            verdict.indexOf(`last ${m.DETAIL_YIELD_WINDOW} jobs`), 0);
        check('and points at the likely cause rather than just asserting breakage',
            /About-the-company selectors may have changed$/.test(verdict), true);
    }

    {
        const m = build();
        for (let i = 0; i < m.DETAIL_YIELD_WINDOW; i++) m.recordDetailReadOutcome(false);
        m.recordDetailReadOutcome(true);
        check('a single success anywhere in the window clears it immediately', m.detailYieldVerdict(), null);
    }

    {
        const m = build();
        m.recordDetailReadOutcome(true);
        for (let i = 0; i < m.DETAIL_YIELD_WINDOW - 1; i++) m.recordDetailReadOutcome(false);
        check('a success still inside the window suppresses the verdict', m.detailYieldVerdict(), null);
        m.recordDetailReadOutcome(false); // pushes the lone success off the end
        check('once that success slides out of the window, the verdict returns', typeof m.detailYieldVerdict(), 'string');
    }

    {
        const m = build();
        for (let i = 0; i < m.DETAIL_YIELD_WINDOW * 3; i++) m.recordDetailReadOutcome(false);
        check('the window is bounded — it never grows without limit across a long session',
            m.detailReadOutcomes.length, m.DETAIL_YIELD_WINDOW);
    }

    {
        const m = build();
        m.recordDetailReadOutcome('a size string');
        check('outcomes are coerced to real booleans, so a truthy value is stored as true not as itself',
            m.detailReadOutcomes, [true]);
    }
});

await suite('getCardInfo — slug extraction from the list card link', () => {
    function run({ companyHref, existingSlug, slugOverride, companyText, jobTitle, companyMissing, now }) {
        const setup = `
            let slugCache = ${existingSlug !== undefined ? JSON.stringify({ victoriassecret: existingSlug }) : '{}'};
            let slugOverrides = ${JSON.stringify(slugOverride ? { victoriassecret: slugOverride } : {})};
            let nameCollisions = {};
            let saveSlugCacheCalls = 0;
            function saveSlugCache() { saveSlugCacheCalls++; }
            function saveNameCollisions() {}
            const RESERVED_SLUGS = new Set(['company', 'jobs', 'search']);
            function findComponentKeyCompanyElement() { return null; }
            let cardTitleContradictions = 0;
            const pendingCompanyMisses = {};
            let transientMissResolvedCount = 0, transientMissResolvedTotalMs = 0,
                transientMissResolvedMaxMs = 0, transientMissGaveUpCount = 0;
            // v7.68: recordTransientCompanyMiss/Resolution both default their \`now\` parameter to
            // Date.now() — real wall-clock time, unusable for proving "resolved N ms after the first
            // miss" in a test. Shadowing the global Date (the same pattern several other suites in
            // this file already use for their own settle-window tests) makes every default-parameter
            // Date.now() call inside the extracted functions read this fake clock instead.
            let fakeNow = ${JSON.stringify(now === undefined ? 0 : now)};
            const Date = { now: () => fakeNow };
            function extractDisplayName(text) { return text; }
            function normalizeCompanyName(text) { return text.toLowerCase().replace(/[^a-z0-9]/g, ''); }
        `;
        // v7.35: getSlugFor + recordSlugObservation extracted for real, not stubbed — the override
        // guard and collision detection on this path are part of what this suite now covers.
        // v7.61: the attribution layer is extracted for real too — these tests double as proof that
        // adding it didn't change which element getCardInfo() picks (see queryWithAttribution's
        // comment: a sequential rewrite WOULD have changed it).
        // v7.66: the job-title contradiction guard is extracted for real, not stubbed — these tests
        // then also prove it stays inert on ordinary cards rather than quietly rejecting them.
        const deps = ['getSlugFor', 'recordSlugObservation', 'selectorStats', 'recordSelectorHit',
            'queryWithAttribution', 'CARD_COMPANY_SELECTORS', 'CARD_COMPANY_FALLBACK_LABEL',
            'CARD_DISMISS_LABEL_PATTERN', 'findCardJobTitle', 'isJobTitleNotCompany',
            'extractCardJobId', 'pruneStaleCompanyMisses', 'TRANSIENT_MISS_GIVE_UP_MS',
            'recordTransientCompanyMiss', 'recordTransientCompanyResolution']
            .map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const fn = extractDeclaration('getCardInfo', SRC);
        const body = `${setup}\n\n${deps}\n\n${fn}\n\nmodule.exports = { getCardInfo,
            get slugCache() { return slugCache; }, get saveSlugCacheCalls() { return saveSlugCacheCalls; },
            get nameCollisions() { return nameCollisions; },
            get pendingCompanyMisses() { return pendingCompanyMisses; },
            get transientMissResolvedCount() { return transientMissResolvedCount; },
            get transientMissResolvedTotalMs() { return transientMissResolvedTotalMs; },
            setNow(t) { fakeNow = t; } };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);

        // v7.61: .matches() is what queryWithAttribution() asks the winning element in order to label
        // which rung produced it — the query itself is unchanged (still one comma-joined call below).
        // v7.68: companyMissing drops it to null — the shape a real card takes for exactly one cycle
        // while its outer container has mounted but the inner company element has not, the case this
        // suite's transient-miss integration tests exist to reproduce through the REAL getCardInfo().
        const companyEl = companyMissing ? null : {
            textContent: companyText === undefined ? "Victoria's Secret" : companyText,
            matches: (sel) => sel === '.job-card-container__primary-description'
        };
        // v7.66: getAttribute + an aria-label, because findCardJobTitle() reads the job link's own
        // label. Deliberately a title that is NOT the company name, so these tests double as proof
        // that the contradiction guard stays inert on an ordinary card.
        const jobLink = {
            href: 'https://www.linkedin.com/jobs/view/4111222333',
            getAttribute: (n) => (n === 'aria-label' ? (jobTitle === undefined ? 'Senior Backend Engineer' : jobTitle) : null)
        };
        const companyLink = companyHref ? { href: companyHref } : null;
        const card = {
            // The real name-selector list happens to END with a[href*="/company/"] as one of
            // several comma-separated alternatives, so a loose "/company/" substring check would
            // wrongly match it too — check for something unique to each real selector string
            // instead, in the exact order getCardInfo() actually calls them.
            querySelector(sel) {
                if (sel.indexOf('primary-description') !== -1) return companyEl;
                if (sel.indexOf('/jobs/view/') !== -1) return jobLink;
                return companyLink; // the standalone a[href*="/company/"] call
            },
            querySelectorAll() { return []; } // no dismiss button on this fixture
        };
        mod.exports.__result = mod.exports.getCardInfo(card);
        return mod.exports;
    }

    {
        const mod2 = run({ companyHref: "https://www.linkedin.com/company/victoria's-secret/life/" });
        check('the real slug (with its apostrophe intact) is captured, not truncated at it',
            mod2.slugCache.victoriassecret, "victoria's-secret");
    }

    {
        // A step further than the reported case: the exact multi-segment shape seen live for OTHER
        // companies too (.../company/<slug>/life/) - the fix must stop at the NEXT / either way,
        // apostrophe or not.
        const mod2 = run({ companyHref: 'https://www.linkedin.com/company/tech-mahindra/life/' });
        check('an ordinary slug with no special characters still works exactly as before',
            mod2.slugCache.victoriassecret, 'tech-mahindra');
    }

    {
        const mod2 = run({ companyHref: null });
        check('no company link on the card at all -> no slug captured, no crash', mod2.slugCache.victoriassecret, undefined);
    }

    {
        const mod2 = run({ companyHref: "https://www.linkedin.com/company/wrong-slug/", existingSlug: "victoria's-secret" });
        check('never overwrites an already-correct slug on file', mod2.slugCache.victoriassecret, "victoria's-secret");
        check('does not even bother saving when nothing changed', mod2.saveSlugCacheCalls, 0);
    }

    // v7.66 (P3) — the guard's effect on getCardInfo itself. Rejecting rather than merely reporting
    // follows this file's oldest rule (v6.4/v6.5): wrong data is worse than none. A bad name here
    // doesn't just mis-render one card, it is written to companyCache under a garbage key; an
    // unreadable card is a state the rest of the file already handles safely, and it counts against
    // the v7.61 filtering yield, so a broad misfire raises an alarm instead of poisoning the cache.
    {
        const mod = run({ companyHref: 'https://www.linkedin.com/company/acme/', companyText: 'Supersei.ai', jobTitle: 'Back End Developer' });
        check('an ordinary card is completely unaffected by the guard', !!mod.__result, true);
        check('and still resolves its company', mod.__result.normalizedName, 'superseiai');
    }
    {
        const mod = run({ companyHref: 'https://www.linkedin.com/company/acme/', companyText: 'Back End Developer', jobTitle: 'Back End Developer' });
        check('a card whose "company" is exactly its own job title is rejected, not cached',
            mod.__result, null);
        check('and no slug is recorded off the back of a rejected card either', mod.saveSlugCacheCalls, 0);
    }
    {
        const mod = run({ companyHref: 'https://www.linkedin.com/company/acme/', companyText: 'Acme', jobTitle: 'Software Engineer at Acme' });
        check('a company merely NAMED in the title is not rejected — exact match is what keeps this safe',
            !!mod.__result, true);
    }

    // v7.68 — the transient-miss tracking wired through the REAL getCardInfo(), not just the isolated
    // helper functions (covered in their own dedicated suite above). This is what actually proves the
    // v7.19 hydration-lag hypothesis rather than merely exercising the bookkeeping in a vacuum: the
    // SAME card (matched by its job link's own href, exactly as extractCardJobId() reads it) misses
    // on one call and resolves on a later one, through the identical code path a real runCycle takes.
    {
        const mod = run({ companyMissing: true, now: 0 });
        check('a card with no companyEl records a miss, through the real code path', mod.__result, null);
        check('keyed by the job identity read off its own link', Object.keys(mod.pendingCompanyMisses), ['4111222333']);

        // The next cycle, ~800ms later (RUN_POLL_FALLBACK_MS order of magnitude): the SAME job link
        // href, but this time the company element has rendered — the exact shape v7.19 documented.
        mod.setNow(800);
        const resolvedCard = {
            querySelector(sel) {
                if (sel.indexOf('primary-description') !== -1) {
                    return { textContent: 'Supersei.ai', matches: (s) => s === '.job-card-container__primary-description' };
                }
                if (sel.indexOf('/jobs/view/') !== -1) return { href: 'https://www.linkedin.com/jobs/view/4111222333', getAttribute: () => null };
                return null;
            },
            querySelectorAll() { return []; }
        };
        const result = mod.getCardInfo(resolvedCard);
        check('the SAME card, resolved on a later cycle, is read normally', result && result.normalizedName, 'superseiai');
        check('and the miss is now recorded as resolved, with the real elapsed time', mod.transientMissResolvedTotalMs, 800);
        check('no longer sitting in the pending map', Object.keys(mod.pendingCompanyMisses).length, 0);
    }
    {
        // The negative case, equally important: a DIFFERENT card resolving must never be mistaken for
        // the first one resolving — proving the correlation is genuinely by identity.
        const mod = run({ companyMissing: true, now: 0 });
        const otherCard = {
            querySelector(sel) {
                if (sel.indexOf('primary-description') !== -1) {
                    return { textContent: 'Some Other Co', matches: (s) => s === '.job-card-container__primary-description' };
                }
                if (sel.indexOf('/jobs/view/') !== -1) return { href: 'https://www.linkedin.com/jobs/view/9999999999', getAttribute: () => null };
                return null;
            },
            querySelectorAll() { return []; }
        };
        mod.setNow(800);
        mod.getCardInfo(otherCard);
        check('a different card resolving does not clear an unrelated card\'s pending miss',
            Object.keys(mod.pendingCompanyMisses), ['4111222333']);
        check('and is not counted as a resolution of it either', mod.transientMissResolvedCount, 0);
    }
});

// ===========================================================================
// Suite: componentkey card detection (v7.5) — the "connections are hiring" layout has no <a href>
// anywhere on the card at all; company name has to come from DOM structure, not a class or link.
// ===========================================================================
await suite('findComponentKeyCompanyElement', () => {
    const m = buildModule(['findComponentKeyCompanyElement'], '');

    function el(tag, { text = null, children = [] } = {}) {
        const node = { tag, children, textContent: text != null ? text : children.map((c) => c.textContent).join('') };
        node.querySelectorAll = function (sel) {
            const out = [];
            (function walk(n) { if (n.tag === 'p') out.push(n); (n.children || []).forEach(walk); })(node);
            return out;
        };
        return node;
    }

    // Real structure from a live Microsoft card (DevTools inspection): title <p> nests <span>s
    // for the "Verified job" badge, company/location are plain un-nested <p>s.
    const titleP = el('p', { children: [el('span', { text: 'Selected, Software Engineer (Verified job)' }), el('span', { text: 'Software Engineer' })] });
    const companyP = el('p', { text: 'Microsoft' });
    const locationP = el('p', { text: 'Bengaluru (Hybrid)' });
    const card = el('div', { children: [titleP, companyP, locationP] });

    check('company is the first plain (un-nested) paragraph, skipping the title', m.findComponentKeyCompanyElement(card).textContent, 'Microsoft');

    const emptyCard = el('div', { children: [titleP] });
    check('no plain paragraph at all -> null, not a crash', m.findComponentKeyCompanyElement(emptyCard), null);
});

// ===========================================================================
// Suite: updateCardSizeBadge (v7.7) — inline per-card badge DOM manipulation.
// ===========================================================================
await suite('updateCardSizeBadge', () => {
    const m = buildModule(['updateCardSizeBadge', 'SIZE_BUCKET_SHORT_LABELS', 'CARD_BADGE_CLASS'], '');

    function mockDoc() { return { createElement: (tag) => makeEl(tag) }; }
    function makeEl(tag, text) {
        const e = {
            tag, _text: text || '', className: '', style: {}, ownerDocument: mockDoc(),
            get textContent() { return this._text; }, set textContent(v) { this._text = v; },
            classList: { contains(c) { return e.className.split(' ').includes(c); } },
            remove() { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((c) => c !== e); }
        };
        return e;
    }
    function attachParent(children) {
        const parent = { children, insertBefore(node, ref) {
            const idx = ref ? children.indexOf(ref) : -1;
            node.parentNode = parent;
            if (idx === -1) children.push(node); else children.splice(idx, 0, node);
        } };
        children.forEach((c) => {
            c.parentNode = parent;
            Object.defineProperty(c, 'nextSibling', { configurable: true, get() { const i = children.indexOf(c); return children[i + 1] || null; } });
        });
        return parent;
    }

    const companyEl = makeEl('a', 'Microsoft');
    attachParent([companyEl]);

    m.updateCardSizeBadge(companyEl, '10,001+ employees');
    check('badge inserted after companyEl with the right short label',
        companyEl.parentNode.children.map((c) => c.textContent), ['Microsoft', '10K+']);

    m.updateCardSizeBadge(companyEl, '10,001+ employees');
    check('idempotent: re-running with the same bucket does not duplicate',
        companyEl.parentNode.children.filter((c) => c.classList.contains(m.CARD_BADGE_CLASS)).length, 1);

    m.updateCardSizeBadge(companyEl, '51-200 employees');
    check('bucket change updates the label in place', companyEl.nextSibling.textContent, '51-200');

    m.updateCardSizeBadge(companyEl, null);
    check('falsy bucket removes an existing badge', companyEl.parentNode.children.map((c) => c.tag), ['a']);

    let threw = false;
    try { m.updateCardSizeBadge({ parentNode: null }, '1-10 employees'); } catch (e) { threw = true; }
    check('no parentNode does not throw', threw, false);
});

// ===========================================================================
// Suite: backup export / import / merge / provenance (v7.6, v7.8) — the one feature where a bug
// means real, irreplaceable data loss, so this is the most heavily covered suite.
// ===========================================================================
await suite('backup + provenance (mergeBackupIntoCache, parseBackupPayload, buildBackupPayload)', () => {
    const setup = `
        const BACKUP_TYPE = 'linkedin-size-filter-backup';
        const BACKUP_VERSION = 1;
        let companyCache = {}, slugCache = {}, companyCacheMeta = {}, slugOverrides = {};
        let savedCache = 0, savedSlugs = 0, savedMeta = 0, savedOverrides = 0;
        function saveCache() { savedCache++; }
        function saveSlugCache() { savedSlugs++; }
        function saveCacheMeta() { savedMeta++; }
        function saveSlugOverrides() { savedOverrides++; }
        function __reset(c, s, meta, ov) { companyCache = c || {}; slugCache = s || {}; companyCacheMeta = meta || {}; slugOverrides = ov || {}; savedCache = 0; savedSlugs = 0; savedMeta = 0; savedOverrides = 0; }
        function __state() { return { companyCache, slugCache, companyCacheMeta, slugOverrides, savedCache, savedSlugs, savedMeta, savedOverrides }; }
    `;
    // buildModule() only extracts real declarations from SRC — __reset/__state live only in the
    // setup string above, so they need to be added to module.exports manually via this variant.
    function buildModuleWithHelpers(names, extraSetup, helperNames) {
        const parts = names.map((n) => extractDeclaration(n, SRC));
        const body = `${extraSetup}\n\n${parts.join('\n\n')}\n\nmodule.exports = { ${names.concat(helperNames).join(', ')} };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }
    const b = buildModuleWithHelpers(
        ['SIZE_BUCKETS', 'CACHE_SOURCE', 'buildBackupPayload', 'parseBackupPayload', 'mergeBackupIntoCache', 'recordCacheMeta'],
        setup, ['__reset', '__state']
    );

    b.__reset();
    b.recordCacheMeta('microsoft', b.CACHE_SOURCE.COMPANY_PAGE);
    check('recordCacheMeta mutates only (caller saves)', [b.__state().companyCacheMeta.microsoft.source, b.__state().savedMeta], [b.CACHE_SOURCE.COMPANY_PAGE, 0]);

    b.__reset({ microsoft: '10,001+ employees' }, { microsoft: 'microsoft' }, { microsoft: { source: b.CACHE_SOURCE.JOB_DETAIL_PANE, timestamp: 111 } });
    const exported = b.buildBackupPayload();
    const roundTripped = b.parseBackupPayload(JSON.stringify(exported));
    check('export/import round trip preserves companies, slugs, and meta',
        [roundTripped.companies, roundTripped.slugs, roundTripped.meta],
        [{ microsoft: '10,001+ employees' }, { microsoft: 'microsoft' }, { microsoft: { source: b.CACHE_SOURCE.JOB_DETAIL_PANE, timestamp: 111 } }]);

    checkThrows('rejects non-JSON', () => b.parseBackupPayload('not json'), 'Not valid JSON');
    checkThrows('rejects an array', () => b.parseBackupPayload('[1,2,3]'), 'Expected a JSON object');
    checkThrows('rejects a file whole if any bucket is invalid', () => b.parseBackupPayload('{"acme":"12 employees"}'), 'unrecognized size bucket');

    check('bare {"company":"bucket"} map still parses (pre-v7.6 copy-paste backups)',
        b.parseBackupPayload('{"priceline":"1,001-5,000 employees"}').companies, { priceline: '1,001-5,000 employees' });

    b.__reset({ microsoft: '10,001+ employees', oracle: '10,001+ employees' }, { microsoft: 'microsoft' }, { oracle: { source: b.CACHE_SOURCE.COMPANY_PAGE, timestamp: 999 } });
    const mergeRes = b.mergeBackupIntoCache({
        companies: { microsoft: '10,001+ employees', oracle: '51-200 employees', priceline: '1,001-5,000 employees' },
        slugs: { priceline: 'priceline-com' },
        meta: { priceline: { source: b.CACHE_SOURCE.JOB_DETAIL_PANE, timestamp: 555 } }
    });
    check('merge: added/conflict counts correct', mergeRes, { added: 1, conflicts: 1, slugsAdded: 1, overridesAdded: 0 });
    check('merge: existing entry never overwritten (oracle conflict left as-is)', b.__state().companyCache.oracle, '10,001+ employees');
    check('merge: existing local provenance on a conflicting entry is untouched', b.__state().companyCacheMeta.oracle, { source: b.CACHE_SOURCE.COMPANY_PAGE, timestamp: 999 });
    check('merge: new entry\'s original provenance carried over verbatim, not stamped "imported"',
        b.__state().companyCacheMeta.priceline, { source: b.CACHE_SOURCE.JOB_DETAIL_PANE, timestamp: 555 });

    b.__reset();
    const noMetaRes = b.mergeBackupIntoCache({ companies: { oracle: '10,001+ employees' }, slugs: {}, meta: {} });
    check('merge: falls back to "imported" when the backup carries no provenance for a new entry',
        b.__state().companyCacheMeta.oracle.source, b.CACHE_SOURCE.IMPORTED);

    b.__reset();
    let threwOnOldShape = false;
    try { b.mergeBackupIntoCache({ companies: { alpha: '1-10 employees' }, slugs: {} }); } catch (e) { threwOnOldShape = true; }
    check('merge: backward-compatible with the pre-v7.8 two-field call shape (no meta key)', threwOnOldShape, false);
});

// ===========================================================================
// Suite: getRunCooldownRemainingMs / formatRunCooldownMessage (v7.32) — the shared macro-level
// cooldown between the END of one Auto-Fetch/Re-verify run and the START of the next, independent
// of page navigation. Scales by tier (clean/rateLimited/autoStopped) rather than a single flat
// number for every outcome.
// ===========================================================================
await suite('getRunCooldownRemainingMs / formatRunCooldownMessage — cooldown tier math', () => {
    // buildModule's fixed export list (just the names passed in) can't expose the free variables
    // these two functions close over (lastAnonymousRunState/runCooldownMinutes) — build directly
    // with explicit getters/setters for them instead.
    function buildWithState() {
        const declarations = ['RUN_COOLDOWN_TIER_MULTIPLIER', 'getRunCooldownRemainingMs', 'formatRunCooldownMessage']
            .map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `
            let lastAnonymousRunState = null;
            let runCooldownMinutes = 5;

            ${declarations}

            module.exports = { getRunCooldownRemainingMs, formatRunCooldownMessage,
                set lastAnonymousRunState(v) { lastAnonymousRunState = v; },
                set runCooldownMinutes(v) { runCooldownMinutes = v; } };
        `;
        const m = { exports: {} };
        new Function('module', 'exports', 'require', body)(m, m.exports, require);
        return m.exports;
    }

    const NOW = 1_700_000_000_000;
    const MIN = 60 * 1000;

    check('no prior run at all -> 0 remaining (nothing to wait on)', buildWithState().getRunCooldownRemainingMs(NOW), 0);

    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: NOW - 2 * MIN, tier: 'clean' };
        mod.runCooldownMinutes = 5;
        check('clean tier uses 1x base (5 min required, 2 min elapsed -> 3 min left)', mod.getRunCooldownRemainingMs(NOW), 3 * MIN);
    }
    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: NOW - 2 * MIN, tier: 'rateLimited' };
        mod.runCooldownMinutes = 5;
        check('rateLimited tier uses 2x base (10 min required, 2 min elapsed -> 8 min left)', mod.getRunCooldownRemainingMs(NOW), 8 * MIN);
    }
    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: NOW - 2 * MIN, tier: 'autoStopped' };
        mod.runCooldownMinutes = 5;
        check('autoStopped tier uses 4x base (20 min required, 2 min elapsed -> 18 min left)', mod.getRunCooldownRemainingMs(NOW), 18 * MIN);
    }
    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: NOW - 999 * MIN, tier: 'autoStopped' };
        mod.runCooldownMinutes = 5;
        check('well past the requirement -> 0, never negative', mod.getRunCooldownRemainingMs(NOW), 0);
    }
    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: NOW - 2 * MIN, tier: 'clean' };
        mod.runCooldownMinutes = 10;
        check('base minutes preference is actually used, not hardcoded (10 min base -> 8 min left)', mod.getRunCooldownRemainingMs(NOW), 8 * MIN);
    }

    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: 0, tier: 'clean' };
        const msg = mod.formatRunCooldownMessage(90 * 1000); // 90s -> rounds UP to 2 whole minutes
        checkTrue('rounds up to whole minutes', msg.includes('2 more minutes'));
        checkTrue('clean tier adds no extra explanation', !msg.includes('longer than usual'));
    }
    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: 0, tier: 'rateLimited' };
        const msg = mod.formatRunCooldownMessage(MIN);
        checkTrue('rateLimited tier explains the longer wait', msg.includes('a bit longer than usual — the last run saw some rate-limit responses'));
    }
    {
        const mod = buildWithState();
        mod.lastAnonymousRunState = { finishedAt: 0, tier: 'autoStopped' };
        const msg = mod.formatRunCooldownMessage(MIN);
        checkTrue('autoStopped tier explains the longer wait', msg.includes('longer than usual — the last run hit repeated rate-limit responses'));
    }
});

// ===========================================================================
// Suite: auto-fetch cancellation + non-blocking progress (v7.11).
// ===========================================================================
await suite('autoFetchUnclassifiedCompanies — cancellation, progress, provenance tagging, backoff', () => {
    const setup = `
        const FAILED_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
        const MAX_CANDIDATE_ATTEMPTS = 20;
        const CACHE_SOURCE = {
            COMPANY_PAGE: 'company-page', JOB_DETAIL_PANE: 'job-detail-pane',
            AUTO_FETCH_SLUG_CACHE: 'auto-fetch-slug-cache', AUTO_FETCH_CANDIDATE_GUESS: 'auto-fetch-candidate-guess',
            AUTO_FETCH_SEARCH_FALLBACK: 'auto-fetch-search-fallback', MANUAL_EDIT: 'manual-edit', IMPORTED: 'imported'
        };
        let companyCache, slugCache, slugOverrides, failedCache, companyCacheMeta, isFetchingUnclassified, cancelFetchRequested;
        let isReverifying, lastAnonymousRunState, runCooldownMinutes, recordAnonymousRunFinishedCalls;
        let unclassifiedEntriesMock, candidateSlugsMock, requestScript, alertCalls, statusUpdates, requestLog, sleepDelays;
        function __reset() {
            companyCache = {}; slugCache = {}; slugOverrides = {}; failedCache = {}; companyCacheMeta = {};
            isFetchingUnclassified = false; cancelFetchRequested = false;
            isReverifying = false; lastAnonymousRunState = null; runCooldownMinutes = 5; recordAnonymousRunFinishedCalls = [];
            unclassifiedEntriesMock = []; candidateSlugsMock = [];
            requestScript = () => 'SIZE:';
            alertCalls = []; statusUpdates = []; requestLog = []; sleepDelays = [];
        }
        __reset();
        function __setCancelNow() { cancelFetchRequested = true; }
        function collectUncachedCards() { return unclassifiedEntriesMock; }
        function generateCandidateSlugs() { return candidateSlugsMock; }
        function extractSizeFromHtml(html) { const m = /^SIZE:(.*)$/.exec(html || ''); return m && m[1] ? m[1] : null; }
        function verifyPageMatchesCompany() { return true; }
        async function searchLinkedInSlugInBrowser() { return null; }
        async function makeAnonymousRequest(url) {
            requestLog.push(url);
            const r = requestScript(url, requestLog.length);
            if (r instanceof Error) throw r;
            return r;
        }
        function sleep(ms) { sleepDelays.push(ms); return Promise.resolve(); }
        function saveCache() {} function saveSlugCache() {} function saveCacheMeta() {} function saveFailedCache() {}
        function filterJobListCards() {}
        function recordCacheMeta(name, source) { companyCacheMeta[name] = { source, timestamp: Date.now() }; }
        function setFetchStatus(text) { statusUpdates.push(text); }
        function alert(msg) { alertCalls.push(msg); }
        // v7.32: recordAnonymousRunFinished is persistence-adjacent (writes to localStorage in the
        // real script) — mocked here to just record its calls, same treatment as saveCache/
        // recordCacheMeta above. getRunCooldownRemainingMs/formatRunCooldownMessage (the actual
        // guard logic) are extracted for real below, not reimplemented, so the blocking behavior
        // itself is genuinely exercised, not just assumed.
        function recordAnonymousRunFinished(tier) { recordAnonymousRunFinishedCalls.push(tier); }
    `;

    // v7.12: the backoff constants and isRateLimitSignal() are pulled from the real source
    // (not hand-copied into `setup` above) so a change to their values or logic is caught here
    // the same way the rest of this suite catches drift in the functions it tests.
    const backoffDeclarations = ['BASE_CANDIDATE_DELAY_MS', 'BASE_COMPANY_DELAY_MS', 'MAX_BACKOFF_DELAY_MS', 'MAX_CONSECUTIVE_RATE_LIMITS', 'isRateLimitSignal',
        'RUN_COOLDOWN_TIER_MULTIPLIER', 'getRunCooldownRemainingMs', 'formatRunCooldownMessage', 'getSlugFor']
        .map((n) => extractDeclaration(n, SRC)).join('\n\n');

    function buildAutoFetchModule() {
        const fn = extractDeclaration('autoFetchUnclassifiedCompanies', SRC);
        const body = `${setup}\n\n${backoffDeclarations}\n\n${fn}\n\nmodule.exports = { autoFetchUnclassifiedCompanies, __reset, __setCancelNow,
            get companyCache() { return companyCache; }, get companyCacheMeta() { return companyCacheMeta; },
            get failedCache() { return failedCache; }, get isFetchingUnclassified() { return isFetchingUnclassified; },
            get cancelFetchRequested() { return cancelFetchRequested; },
            set isReverifying(v) { isReverifying = v; },
            set lastAnonymousRunState(v) { lastAnonymousRunState = v; }, set runCooldownMinutes(v) { runCooldownMinutes = v; },
            get recordAnonymousRunFinishedCalls() { return recordAnonymousRunFinishedCalls; },
            get unclassifiedEntriesMock() { return unclassifiedEntriesMock; }, get candidateSlugsMock() { return candidateSlugsMock; },
            get slugCache() { return slugCache; }, get slugOverrides() { return slugOverrides; },
            set requestScript(fn2) { requestScript = fn2; },
            get requestLog() { return requestLog; }, get alertCalls() { return alertCalls; }, get statusUpdates() { return statusUpdates; },
            get sleepDelays() { return sleepDelays; },
            BASE_CANDIDATE_DELAY_MS, BASE_COMPANY_DELAY_MS, MAX_CONSECUTIVE_RATE_LIMITS,
            CACHE_SOURCE };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    const entry = (name) => ({ normalizedName: name, displayName: name });
    const fakeBtn = () => ({ innerText: '' });

    return (async () => {
        // Cancel mid-run: stops before the NEXT company.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('alpha'), entry('beta'), entry('gamma'), entry('delta'));
            mod.slugCache.alpha = 'a'; mod.slugCache.beta = 'b'; mod.slugCache.gamma = 'g'; mod.slugCache.delta = 'd';
            mod.requestScript = (url, callNum) => { if (callNum === 2) mod.__setCancelNow(); return 'SIZE:51-200 employees'; };
            const btn = fakeBtn();
            await mod.autoFetchUnclassifiedCompanies(btn);
            check('cancel stops further companies (only 2 of 4 requested)', mod.requestLog.length, 2);
            check('gamma/delta left untouched', [mod.companyCache.gamma, mod.companyCache.delta], [undefined, undefined]);
            check('status reports cancellation with correct counts', mod.statusUpdates[mod.statusUpdates.length - 1], 'Cancelled after 2 of 4. Classified 2 of 2 attempted.');
            check('flags reset after run', [mod.isFetchingUnclassified, mod.cancelFetchRequested], [false, false]);
            check('button restored to default label', btn.innerText, '⚡ Auto-Fetch Unclassified Companies');
            check('no blocking alert() during a real run', mod.alertCalls, []);
        }

        // Cancel mid candidate-guess sub-loop: must not exhaust the full guess budget first.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('nomatch'));
            mod.candidateSlugsMock.push(...Array.from({ length: 10 }, (_, i) => `c${i}`));
            mod.requestScript = (url, callNum) => { if (callNum === 3) mod.__setCancelNow(); return 'SIZE:'; };
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('cancel inside the guess loop stops within one company (3, not 10)', mod.requestLog.length, 3);
        }

        // Full completion: all three CACHE_SOURCE tiers still tag correctly post-refactor.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('viaslug'));
            mod.slugCache.viaslug = 'viaslug';
            mod.requestScript = () => 'SIZE:11-50 employees';
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('slug-cache-hit tagged AUTO_FETCH_SLUG_CACHE', mod.companyCacheMeta.viaslug.source, mod.CACHE_SOURCE.AUTO_FETCH_SLUG_CACHE);
        }
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('viaguess'));
            mod.candidateSlugsMock.push('bad', 'good');
            mod.requestScript = (url, callNum) => (callNum === 1 ? 'SIZE:' : 'SIZE:201-500 employees');
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('candidate-guess success tagged AUTO_FETCH_CANDIDATE_GUESS', mod.companyCacheMeta.viaguess.source, mod.CACHE_SOURCE.AUTO_FETCH_CANDIDATE_GUESS);
        }

        // No unclassified companies -> the one remaining synchronous alert() still fires.
        {
            const mod = buildAutoFetchModule();
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('alert() shown when there is nothing to fetch', mod.alertCalls.length, 1);
        }

        // Cooldown-skipped companies don't consume a request and are reported.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('onCooldown'), entry('fresh'));
            mod.failedCache.onCooldown = Date.now();
            mod.slugCache.fresh = 'fresh';
            mod.requestScript = () => 'SIZE:1-10 employees';
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('cooldown company skipped without a request', mod.requestLog.length, 1);
            checkTrue('final status mentions the skip', mod.statusUpdates[mod.statusUpdates.length - 1].includes('1 skipped (cooldown)'));
        }

        const rateLimitError = () => new Error('HTTP 429');

        // v7.12: a 429 doubles the candidate-guess delay each time, and a success resets it back
        // to baseline — verified via the actual ms values passed to sleep(), not just call counts.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('nocandidatematch'));
            mod.candidateSlugsMock.push('c1', 'c2', 'c3');
            // c1 -> 429 (delay 250->500), c2 -> 429 (delay 500->1000), c3 -> success (resolves,
            // breaks out of the loop before its own sleep() call — see the `break` in tier 2).
            mod.requestScript = (url, callNum) => {
                if (callNum <= 2) return rateLimitError();
                return 'SIZE:51-200 employees';
            };
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('delay doubles on each consecutive 429 (250->500->1000)', mod.sleepDelays, [500, 1000]);
            check('company still resolved once the rate limit clears', mod.companyCache.nocandidatematch, '51-200 employees');
        }

        // v7.12: delay resets to baseline immediately after ANY non-rate-limit outcome, even a
        // 200 that doesn't end up matching this company (not just after an eventual success).
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('resetcase'));
            mod.candidateSlugsMock.push('c1', 'c2', 'c3');
            // c1 -> 429 (250->500), c2 -> plain 200/no-match (resets 500->250), c3 -> 429 again
            // (250->500, proving it reset rather than continuing to escalate from 500).
            mod.requestScript = (url, callNum) => {
                if (callNum === 1) return rateLimitError();
                if (callNum === 2) return 'SIZE:'; // 200, but no size text -> no match, not a 429
                return rateLimitError(); // callNum 3
            };
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('429, then a plain non-match resets the delay, then 429 doubles from baseline again',
                mod.sleepDelays, [500, 250, 500]);
        }

        // v7.12: sustained rate-limiting stops the whole run after MAX_CONSECUTIVE_RATE_LIMITS,
        // and none of the rate-limited companies (including the one that crossed the threshold)
        // get put on a 7-day cooldown for a failure that wasn't really theirs.
        {
            const mod = buildAutoFetchModule();
            const names = ['c1', 'c2', 'c3', 'c4', 'c5'];
            names.forEach((n) => { mod.unclassifiedEntriesMock.push(entry(n)); mod.slugCache[n] = n; });
            mod.requestScript = () => rateLimitError(); // every single request is rate-limited
            const btn = fakeBtn();
            await mod.autoFetchUnclassifiedCompanies(btn);
            check(`stops after exactly MAX_CONSECUTIVE_RATE_LIMITS (${mod.MAX_CONSECUTIVE_RATE_LIMITS}) companies, c5 never attempted`,
                mod.requestLog.length, mod.MAX_CONSECUTIVE_RATE_LIMITS);
            check('none of the rate-limited companies were put on cooldown', Object.keys(mod.failedCache).length, 0);
            checkTrue('final status explains it was a rate-limit stop, not a normal finish/cancel',
                mod.statusUpdates[mod.statusUpdates.length - 1].startsWith(`Stopped after ${mod.MAX_CONSECUTIVE_RATE_LIMITS} of 5`));
            check('flags still reset cleanly after a rate-limit stop', [mod.isFetchingUnclassified, mod.cancelFetchRequested], [false, false]);
        }

        // v7.12: a genuine (non-rate-limit) failure still gets a normal cooldown — this refinement
        // must not accidentally exempt every failure, only rate-limit-caused ones.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('genuinelyunresolvable'));
            mod.slugCache.genuinelyunresolvable = 'x';
            mod.requestScript = () => new Error('HTTP 404'); // a real, unrelated failure
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            checkTrue('a plain 404 (not rate-limited) still results in a cooldown entry', !!mod.failedCache.genuinelyunresolvable);
        }

        // v7.32: previously only reverifyStaleCompanies() checked the OTHER flag — Auto-Fetch could
        // start while a re-verify sweep was already running. Now symmetric.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('x'));
            mod.slugCache.x = 'x'; // real slug present, so a request WOULD fire if the guard didn't stop it
            mod.isReverifying = true;
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('refuses to run alongside an active Re-verify sweep', mod.requestLog.length, 0);
            check('explains why, rather than silently doing nothing', mod.alertCalls.length, 1);
        }

        // v7.32: the cross-run cooldown blocks a new run before it starts — no requests made at all.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('x'));
            mod.slugCache.x = 'x'; // real slug present, so a request WOULD fire if the guard didn't stop it
            mod.lastAnonymousRunState = { finishedAt: Date.now() - 1 * 60 * 1000, tier: 'clean' }; // 1 min ago
            mod.runCooldownMinutes = 5; // 5 min required -> still within cooldown
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('cooldown still active -> no requests made', mod.requestLog.length, 0);
            check('an explanatory alert is shown instead', mod.alertCalls.length, 1);
        }

        // v7.32: once enough time has passed, the run proceeds exactly as normal.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('x'));
            mod.slugCache.x = 'x';
            mod.lastAnonymousRunState = { finishedAt: Date.now() - 10 * 60 * 1000, tier: 'clean' }; // 10 min ago
            mod.runCooldownMinutes = 5; // only 5 min required -> already elapsed
            mod.requestScript = () => 'SIZE:51-200 employees';
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('cooldown already elapsed -> run proceeds normally', mod.requestLog.length, 1);
        }

        // v7.32: the tier recorded for the NEXT run's cooldown reflects what THIS run actually saw.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('cleanrun'));
            mod.slugCache.cleanrun = 'cleanrun';
            mod.requestScript = () => 'SIZE:51-200 employees';
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('a clean run (zero rate-limit hits) records tier "clean"', mod.recordAnonymousRunFinishedCalls, ['clean']);
        }
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('bounceback'));
            mod.candidateSlugsMock.push('c1', 'c2');
            // One 429 that recovers on the very next attempt — not enough to auto-stop.
            mod.requestScript = (url, callNum) => (callNum === 1 ? rateLimitError() : 'SIZE:11-50 employees');
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('a run that hits a rate limit but recovers records tier "rateLimited"', mod.recordAnonymousRunFinishedCalls, ['rateLimited']);
        }
        {
            const mod = buildAutoFetchModule();
            const names = ['c1', 'c2', 'c3', 'c4', 'c5'];
            names.forEach((n) => { mod.unclassifiedEntriesMock.push(entry(n)); mod.slugCache[n] = n; });
            mod.requestScript = () => rateLimitError(); // sustained -> auto-stops
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('a run that auto-stops from sustained rate-limiting records tier "autoStopped"', mod.recordAnonymousRunFinishedCalls, ['autoStopped']);
        }

        // v7.32: a cancelled run already sent at least one real request, so it's not a
        // zero-footprint run — the cooldown must still be recorded, not skipped.
        {
            const mod = buildAutoFetchModule();
            mod.unclassifiedEntriesMock.push(entry('alpha'), entry('beta'));
            mod.slugCache.alpha = 'a'; mod.slugCache.beta = 'b';
            mod.requestScript = (url, callNum) => { if (callNum === 1) mod.__setCancelNow(); return 'SIZE:51-200 employees'; };
            await mod.autoFetchUnclassifiedCompanies(fakeBtn());
            check('a cancelled run still records exactly one cooldown entry, not skipped', mod.recordAnonymousRunFinishedCalls.length, 1);
        }
    })();
});

// ===========================================================================
// Suite: re-verify sweep eligibility (v7.30) — a company only qualifies once it's genuinely gone
// thresholdDays without confirmation AND has a known slug (going straight to a confirmed page,
// never guessing) AND isn't a MANUAL_EDIT (a human decision, never auto-touched). This IS the
// throttle against overuse: once re-verified, an entry can't come up again for a full threshold
// period no matter how often the sweep runs — no separate cooldown state needed anywhere.
// ===========================================================================
await suite('re-verify sweep eligibility (getReverifyCandidates / getReverifyNextEtaMs / countReverifyMissingSlug)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 1000 * DAY;

    function run(companyCache, companyCacheMeta, slugCache, slugOverrides = {}) {
        const setup = `
            let companyCache = ${JSON.stringify(companyCache)};
            let companyCacheMeta = ${JSON.stringify(companyCacheMeta)};
            let slugCache = ${JSON.stringify(slugCache)};
            let slugOverrides = ${JSON.stringify(slugOverrides)};
            const Date = { now: () => ${now} };
        `;
        return buildModule(
            ['CACHE_SOURCE', 'FRESHNESS_DAY_MS', 'getSlugFor', 'isManualEditLockedOut', 'isReverifyEligible', 'getReverifyCandidates', 'getReverifyNextEtaMs', 'countReverifyMissingSlug'],
            setup
        );
    }

    {
        const m = run(
            { fresh: 'x', oldEnough: 'x', tooRecent: 'x', unknownAge: 'x', manualEdit: 'x', noSlug: 'x' },
            {
                fresh: { source: 'company-page', timestamp: now - 10 * DAY },
                oldEnough: { source: 'auto-fetch-slug-cache', timestamp: now - 400 * DAY },
                tooRecent: { source: 'job-detail-pane', timestamp: now - 300 * DAY },
                manualEdit: { source: 'manual-edit', timestamp: now - 900 * DAY }
                // 'unknownAge' and 'noSlug' deliberately have no meta entry at all.
            },
            { fresh: 's', oldEnough: 's', tooRecent: 's', unknownAge: 's', manualEdit: 's' } // noSlug has none
        );
        check('365-day threshold: only the genuinely-overdue + unknown-age entries with a slug qualify',
            m.getReverifyCandidates(365).sort(), ['oldEnough', 'unknownAge'].sort());
        check('a MANUAL_EDIT entry is never eligible, no matter how old', m.getReverifyCandidates(365).includes('manualEdit'), false);
        check('a company with no known slug is never eligible, no matter how old', m.getReverifyCandidates(365).includes('noSlug'), false);
    }

    {
        // Oldest-first ordering, so a cancelled/rate-limited run still makes progress on the most
        // overdue entries first.
        const m = run(
            { a: 'x', b: 'x', c: 'x' },
            {
                a: { source: 'company-page', timestamp: now - 400 * DAY },
                b: { source: 'company-page', timestamp: now - 900 * DAY },
                c: { source: 'company-page', timestamp: now - 366 * DAY }
            },
            { a: 's', b: 's', c: 's' }
        );
        check('sorted oldest (largest age) first', m.getReverifyCandidates(365), ['b', 'a', 'c']);
    }

    {
        const m = run(
            { onlyDue: 'x', notYetDue: 'x' },
            {
                onlyDue: { source: 'company-page', timestamp: now - 400 * DAY },
                notYetDue: { source: 'company-page', timestamp: now - 360 * DAY } // 5 days short of 365
            },
            { onlyDue: 's', notYetDue: 's' }
        );
        check('sanity: exactly one candidate due right now', m.getReverifyCandidates(365), ['onlyDue']);
    }

    {
        const m = run(
            { closer: 'x', further: 'x' },
            {
                closer: { source: 'company-page', timestamp: now - 360 * DAY },  // 5 days from due
                further: { source: 'company-page', timestamp: now - 300 * DAY } // 65 days from due
            },
            { closer: 's', further: 's' }
        );
        const etaMs = m.getReverifyNextEtaMs(365);
        check('reports the SMALLEST remaining time across not-yet-due entries', Math.round(etaMs / DAY), 5);
    }

    {
        const m = run({}, {}, {});
        check('nothing pending at all -> null, not zero (distinguishes "never" from "soon")', m.getReverifyNextEtaMs(365), null);
    }

    {
        const m = run(
            { dueNoSlug: 'x', dueWithSlug: 'x' },
            { dueNoSlug: { source: 'company-page', timestamp: now - 400 * DAY }, dueWithSlug: { source: 'company-page', timestamp: now - 400 * DAY } },
            { dueWithSlug: 's' } // dueNoSlug has none
        );
        check('counts companies that ARE due but unreachable (no known slug) separately', m.countReverifyMissingSlug(365), 1);
    }

    // v7.42: a MANUAL_EDIT entry with an explicit override IS eligible — adding one is a deliberate
    // decision to let this participate in re-verify again, unlike an incidental slugCache entry.
    {
        const m = run(
            { manualWithOverride: 'x' },
            { manualWithOverride: { source: 'manual-edit', timestamp: now - 400 * DAY } },
            {}, // no slugCache entry at all
            { manualWithOverride: 'the-real-slug' } // but an explicit override exists
        );
        check('a MANUAL_EDIT entry becomes eligible once an override is added and it\'s past threshold',
            m.getReverifyCandidates(365), ['manualWithOverride']);
    }

    // The exact nuance getCardInfo() creates: a MANUAL_EDIT company can pick up an INCIDENTAL
    // slugCache entry with zero deliberate action (that function has no MANUAL_EDIT guard at all,
    // unlike the two passive-capture functions) — that must NOT be read as consent.
    {
        const m = run(
            { manualIncidentalSlug: 'x' },
            { manualIncidentalSlug: { source: 'manual-edit', timestamp: now - 400 * DAY } },
            { manualIncidentalSlug: 'harvested-by-getCardInfo' } // slugCache has one, but...
            // ...no slugOverrides entry — this was never a deliberate user decision.
        );
        check('an incidental slugCache entry alone does NOT unlock a MANUAL_EDIT entry — only an override does',
            m.getReverifyCandidates(365).includes('manualIncidentalSlug'), false);
    }

    // A locked-out MANUAL_EDIT entry (no override) must not appear in "missing slug" either — even
    // with a slug it still wouldn't be reachable, so counting it there would be misleading.
    {
        const m = run(
            { manualLocked: 'x' },
            { manualLocked: { source: 'manual-edit', timestamp: now - 400 * DAY } },
            {} // no slug at all
        );
        check('a locked-out MANUAL_EDIT entry with no slug is NOT counted as "missing slug" — getting one wouldn\'t unlock it, only an override would',
            m.countReverifyMissingSlug(365), 0);
    }

    // An unlocked MANUAL_EDIT entry not yet past threshold still contributes to the ETA, same as any
    // other source — it's a normal candidate now, not a special case anymore.
    {
        const m = run(
            { manualWithOverride: 'x' },
            { manualWithOverride: { source: 'manual-edit', timestamp: now - 360 * DAY } }, // 5 days short of 365
            {},
            { manualWithOverride: 'the-real-slug' }
        );
        check('an unlocked-but-not-yet-due MANUAL_EDIT entry contributes to the next-eligible ETA',
            Math.round(m.getReverifyNextEtaMs(365) / DAY), 5);
    }
});

// ===========================================================================
// Suite: reverifyStaleCompanies (v7.30) — much simpler than Auto-Fetch's pipeline: no identity
// ambiguity to resolve (the slug is already trusted), so this is tier 1 of that pipeline (fetch the
// known page, verify, extract) run in a loop over the eligible set, reusing the exact same
// sequential-with-delay pacing and adaptive backoff. Mocking style mirrors the
// autoFetchUnclassifiedCompanies suite above for consistency, since this reuses several of the same
// real dependencies (makeAnonymousRequest, isRateLimitSignal, the backoff constants).
// ===========================================================================
await suite('reverifyStaleCompanies — sequential re-check, backoff, incremental saves', () => {
    const setup = `
        const CACHE_SOURCE = {
            COMPANY_PAGE: 'company-page', JOB_DETAIL_PANE: 'job-detail-pane',
            AUTO_FETCH_SLUG_CACHE: 'auto-fetch-slug-cache', AUTO_FETCH_CANDIDATE_GUESS: 'auto-fetch-candidate-guess',
            AUTO_FETCH_SEARCH_FALLBACK: 'auto-fetch-search-fallback', MANUAL_EDIT: 'manual-edit', IMPORTED: 'imported',
            REVERIFY_SWEEP: 'reverify-sweep'
        };
        const FRESHNESS_DAY_MS = 24 * 60 * 60 * 1000;
        let companyCache, companyCacheMeta, slugCache, slugOverrides, isFetchingUnclassified, isReverifying, cancelReverifyRequested;
        let lastAnonymousRunState, runCooldownMinutes, recordAnonymousRunFinishedCalls;
        let requestScript, alertCalls, confirmCalls, confirmReturns, statusUpdates, requestLog, sleepDelays;
        function __reset() {
            companyCache = {}; companyCacheMeta = {}; slugCache = {}; slugOverrides = {};
            isFetchingUnclassified = false; isReverifying = false; cancelReverifyRequested = false;
            lastAnonymousRunState = null; runCooldownMinutes = 5; recordAnonymousRunFinishedCalls = [];
            requestScript = () => 'SIZE:501-1,000 employees';
            alertCalls = []; confirmCalls = []; confirmReturns = [true]; statusUpdates = []; requestLog = []; sleepDelays = [];
        }
        __reset();
        function __setCancelAfterThisCall() { cancelReverifyRequested = true; }
        function extractSizeFromHtml(html) { const m = /^SIZE:(.*)$/.exec(html || ''); return m && m[1] ? m[1] : null; }
        function verifyPageMatchesCompany() { return true; }
        async function makeAnonymousRequest(url) {
            requestLog.push(url);
            const r = requestScript(url, requestLog.length);
            if (r instanceof Error) throw r;
            return r;
        }
        function sleep(ms) { sleepDelays.push(ms); return Promise.resolve(); }
        function saveCache() {} function saveSlugCache() {} function saveCacheMeta() {}
        function filterJobListCards() {}
        function recordCacheMeta(name, source) { companyCacheMeta[name] = { source, timestamp: Date.now() }; }
        function setReverifyStatus(text) { statusUpdates.push(text); }
        function alert(msg) { alertCalls.push(msg); }
        function confirm(msg) { confirmCalls.push(msg); return confirmReturns.length > 1 ? confirmReturns.shift() : confirmReturns[0]; }
        // v7.32: see the matching comment in the Auto-Fetch suite — mocked the same way here.
        function recordAnonymousRunFinished(tier) { recordAnonymousRunFinishedCalls.push(tier); }
    `;

    // Real eligibility logic AND real backoff constants, not hand-copied — a change to either is
    // caught here the same way the rest of this suite catches drift in what it tests.
    const reused = [
        'FRESHNESS_DAY_MS', 'isManualEditLockedOut', 'isReverifyEligible', 'getReverifyCandidates', 'getReverifyNextEtaMs', 'countReverifyMissingSlug',
        'BASE_COMPANY_DELAY_MS', 'MAX_BACKOFF_DELAY_MS', 'MAX_CONSECUTIVE_RATE_LIMITS', 'isRateLimitSignal',
        'RUN_COOLDOWN_TIER_MULTIPLIER', 'getRunCooldownRemainingMs', 'formatRunCooldownMessage', 'getSlugFor'
    ];

    function build() {
        // setup above already declares its own FRESHNESS_DAY_MS — extract everything else for real.
        const declarations = reused.filter((n) => n !== 'FRESHNESS_DAY_MS').map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const fn = extractDeclaration('reverifyStaleCompanies', SRC);
        const body = `${setup}\n\n${declarations}\n\n${fn}\n\nmodule.exports = { reverifyStaleCompanies, __reset, __setCancelAfterThisCall,
            get companyCache() { return companyCache; }, get companyCacheMeta() { return companyCacheMeta; },
            get slugCache() { return slugCache; }, get slugOverrides() { return slugOverrides; }, get isReverifying() { return isReverifying; },
            set requestScript(fn2) { requestScript = fn2; }, set isFetchingUnclassified(v) { isFetchingUnclassified = v; },
            set confirmReturns(v) { confirmReturns = v; },
            set lastAnonymousRunState(v) { lastAnonymousRunState = v; }, set runCooldownMinutes(v) { runCooldownMinutes = v; },
            get recordAnonymousRunFinishedCalls() { return recordAnonymousRunFinishedCalls; },
            get requestLog() { return requestLog; }, get alertCalls() { return alertCalls; }, get confirmCalls() { return confirmCalls; },
            get statusUpdates() { return statusUpdates; }, get sleepDelays() { return sleepDelays; },
            BASE_COMPANY_DELAY_MS, MAX_CONSECUTIVE_RATE_LIMITS };\n`;
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', body)(mod, mod.exports, require);
        return mod.exports;
    }

    const fakeBtn = () => ({ innerText: '' });
    const fakeSelect = () => ({ disabled: false });
    const DAY = 24 * 60 * 60 * 1000;
    const now = () => Date.now();

    function seedDue(mod, names, { manual = [], noSlug = [] } = {}) {
        for (const name of names) {
            mod.companyCache[name] = '1-10 employees';
            if (!manual.includes(name)) mod.companyCacheMeta[name] = { source: 'company-page', timestamp: now() - 400 * DAY };
            else mod.companyCacheMeta[name] = { source: 'manual-edit', timestamp: now() - 400 * DAY };
            if (!noSlug.includes(name)) mod.slugCache[name] = name + '-slug';
        }
    }

    return (async () => {
        // Nothing due at all — no confirm(), no requests, an informative alert instead.
        {
            const mod = build();
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('nothing due -> no confirm prompt shown', mod.confirmCalls.length, 0);
            check('nothing due -> no requests made', mod.requestLog.length, 0);
            check('an informative alert is shown instead', mod.alertCalls.length, 1);
        }

        // User declines the confirm() prompt — must not run anything.
        {
            const mod = build();
            seedDue(mod, ['alpha']);
            mod.confirmReturns = [false];
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('declining the confirm prompt makes no requests', mod.requestLog.length, 0);
            check('nothing gets re-tagged either', mod.companyCacheMeta.alpha.source, 'company-page');
        }

        // The core happy path: value unchanged, value changed, provenance tagged, saved
        // incrementally (per company, not batched to the end — checked via companyCacheMeta being
        // updated mid-loop, same as the rest of this file's incremental-save discipline).
        {
            const mod = build();
            seedDue(mod, ['alpha', 'beta']);
            mod.requestScript = (url, callNum) => (callNum === 1 ? 'SIZE:1-10 employees' : 'SIZE:10,001+ employees'); // alpha unchanged, beta changed
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('both companies requested', mod.requestLog.length, 2);
            check('unchanged value is left as the same value', mod.companyCache.alpha, '1-10 employees');
            check('changed value is actually updated', mod.companyCache.beta, '10,001+ employees');
            check('both re-tagged with the distinct REVERIFY_SWEEP source, not reusing an auto-fetch tag',
                [mod.companyCacheMeta.alpha.source, mod.companyCacheMeta.beta.source], ['reverify-sweep', 'reverify-sweep']);
            check('final status reports both changed and unchanged counts', mod.statusUpdates[mod.statusUpdates.length - 1],
                "Finished! 1 changed, 1 confirmed unchanged, 0 couldn't be re-checked.");
        }

        // A MANUAL_EDIT entry due for its age must never even be requested.
        {
            const mod = build();
            seedDue(mod, ['handEdited'], { manual: ['handEdited'] });
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('a MANUAL_EDIT entry is never requested, even though it would otherwise be due', mod.requestLog.length, 0);
        }

        // v7.42: ...UNLESS the user has explicitly added an override for it — that's the deliberate
        // consent this feature needs before touching a manual correction again. End-to-end through
        // the real sweep function, not just the eligibility check in isolation.
        {
            const mod = build();
            seedDue(mod, ['handEditedWithOverride'], { manual: ['handEditedWithOverride'] });
            mod.slugOverrides.handEditedWithOverride = 'the-real-slug';
            mod.requestScript = () => 'SIZE:10,001+ employees';
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('an unlocked MANUAL_EDIT entry (override present) IS requested and updated',
                [mod.requestLog.length, mod.companyCache.handEditedWithOverride], [1, '10,001+ employees']);
            check('it graduates to the REVERIFY_SWEEP source, no longer treated as an unconfirmed manual edit',
                mod.companyCacheMeta.handEditedWithOverride.source, 'reverify-sweep');
        }

        // Cancel mid-run — stops before the next company, keeps what already finished (incremental
        // save discipline means this isn't lost work).
        {
            const mod = build();
            seedDue(mod, ['a1', 'a2', 'a3', 'a4']);
            mod.requestScript = (url, callNum) => { if (callNum === 2) mod.__setCancelAfterThisCall(); return 'SIZE:501-1,000 employees'; };
            const btn = fakeBtn();
            await mod.reverifyStaleCompanies(btn, fakeSelect(), 365);
            check('cancel stops further requests (only 2 of 4)', mod.requestLog.length, 2);
            check('button restored to its default label', btn.innerText, '🔄 Re-verify Stale Companies');
            check('flags reset after a cancelled run', mod.isReverifying, false);
        }

        // 404 on an already-known slug: the stale slug is evicted, but the cached SIZE is left
        // untouched — a fetch failure is not evidence the last known value is wrong.
        {
            const mod = build();
            seedDue(mod, ['gone']);
            mod.companyCache.gone = '51-200 employees';
            mod.requestScript = () => new Error('HTTP 404');
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('the stale slug is evicted on a definitive 404', mod.slugCache.gone, undefined);
            check('the cached SIZE value is left untouched — a failure destroys nothing', mod.companyCache.gone, '51-200 employees');
        }

        // Adaptive backoff on 429/503, same mechanism as Auto-Fetch, reused not reimplemented.
        {
            const mod = build();
            seedDue(mod, ['r1', 'r2', 'r3']);
            mod.requestScript = (url, callNum) => (callNum <= 2 ? new Error('HTTP 429') : 'SIZE:1,001-5,000 employees');
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('delay doubles after each consecutive 429 before the next request', mod.sleepDelays[0], mod.BASE_COMPANY_DELAY_MS * 2);
        }

        // Auto-Fetch running already — refuse to start, with a clear explanation, not a silent no-op.
        {
            const mod = build();
            seedDue(mod, ['x']);
            mod.isFetchingUnclassified = true;
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('refuses to run alongside Auto-Fetch (same IP, same anonymity concern)', mod.requestLog.length, 0);
            check('explains why, rather than silently doing nothing', mod.alertCalls.length, 1);
        }

        // v7.32: the cross-run cooldown blocks a new sweep before it starts — no requests, no
        // confirm() prompt even shown.
        {
            const mod = build();
            seedDue(mod, ['x']);
            mod.lastAnonymousRunState = { finishedAt: now() - 1 * 60 * 1000, tier: 'clean' }; // 1 min ago
            mod.runCooldownMinutes = 5; // 5 min required -> still within cooldown
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('cooldown still active -> no requests made', mod.requestLog.length, 0);
            check('no confirm prompt is even shown', mod.confirmCalls.length, 0);
            check('an explanatory alert is shown instead', mod.alertCalls.length, 1);
        }

        // v7.32: once enough time has passed, the sweep proceeds exactly as normal.
        {
            const mod = build();
            seedDue(mod, ['x']);
            mod.lastAnonymousRunState = { finishedAt: now() - 10 * 60 * 1000, tier: 'clean' }; // 10 min ago
            mod.runCooldownMinutes = 5; // only 5 min required -> already elapsed
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('cooldown already elapsed -> sweep proceeds normally', mod.requestLog.length, 1);
        }

        // v7.32: shares the exact same tier-recording behavior as Auto-Fetch — one shared cooldown
        // state, since the two are mutually exclusive and carry the same connection risk.
        {
            const mod = build();
            seedDue(mod, ['alpha']);
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('a clean sweep records tier "clean"', mod.recordAnonymousRunFinishedCalls, ['clean']);
        }
        {
            const mod = build();
            seedDue(mod, ['r1', 'r2', 'r3', 'r4', 'r5']);
            mod.requestScript = () => new Error('HTTP 429'); // sustained -> auto-stops
            await mod.reverifyStaleCompanies(fakeBtn(), fakeSelect(), 365);
            check('a sweep that auto-stops from sustained rate-limiting records tier "autoStopped"', mod.recordAnonymousRunFinishedCalls, ['autoStopped']);
        }
    })();
});

// ===========================================================================
// Suite: mergeStoredIntoMemory (v7.35) — the multi-tab data-loss fix. Every save used to be a blind
// setItem of this tab's in-memory map, so with two LinkedIn tabs open (passive capture runs in both)
// whichever saved last silently erased what the other had learned. These tests drive the real
// function against a fake localStorage standing in for "what the other tab already wrote".
// ===========================================================================
await suite('mergeStoredIntoMemory — multi-tab safe saves', () => {
    function build({ memCompanies = {}, memMeta = {}, memSlugs = {}, storedCompanies = {}, storedMeta = {}, storedSlugs = {} }) {
        const setup = `
            ${extractDeclaration('SIZE_BUCKETS', SRC)}
            const CACHE_KEY = 'c', CACHE_META_KEY = 'm', SLUG_CACHE_KEY = 's';
            const __stored = {
                c: ${JSON.stringify(JSON.stringify(storedCompanies))},
                m: ${JSON.stringify(JSON.stringify(storedMeta))},
                s: ${JSON.stringify(JSON.stringify(storedSlugs))}
            };
            const localStorage = { getItem: (k) => (k in __stored ? __stored[k] : null), setItem: (k, v) => { __stored[k] = v; } };
            let companyCache = ${JSON.stringify(memCompanies)};
            let companyCacheMeta = ${JSON.stringify(memMeta)};
            let slugCache = ${JSON.stringify(memSlugs)};
        `;
        const decls = ['loadJson', 'mergeStoredIntoMemory'].map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${decls}\n\nmodule.exports = { mergeStoredIntoMemory,
            get companyCache() { return companyCache; }, get companyCacheMeta() { return companyCacheMeta; },
            get slugCache() { return slugCache; } };\n`;
        const m = { exports: {} };
        new Function('module', 'exports', 'require', body)(m, m.exports, require);
        return m.exports;
    }

    // The core reported scenario: the other tab learned a company this tab has never seen.
    {
        const mod = build({
            memCompanies: { microsoft: '10,001+ employees' },
            memMeta: { microsoft: { source: 'company-page', timestamp: 100 } },
            storedCompanies: { google: '10,001+ employees' },
            storedMeta: { google: { source: 'job-detail-pane', timestamp: 200 } }
        });
        mod.mergeStoredIntoMemory();
        check('another tab\'s company is adopted, not erased', mod.companyCache.google, '10,001+ employees');
        check('its provenance comes along too', (mod.companyCacheMeta.google || {}).source, 'job-detail-pane');
        check('this tab\'s own entry is untouched', mod.companyCache.microsoft, '10,001+ employees');
    }

    // Conflict resolution: the newer verification wins, whichever tab made it.
    {
        const mod = build({
            memCompanies: { acme: '51-200 employees' },
            memMeta: { acme: { source: 'company-page', timestamp: 100 } },
            storedCompanies: { acme: '201-500 employees' },
            storedMeta: { acme: { source: 'company-page', timestamp: 500 } }
        });
        mod.mergeStoredIntoMemory();
        check('a NEWER stored value wins over our older in-memory one', mod.companyCache.acme, '201-500 employees');
        check('and brings its timestamp with it', (mod.companyCacheMeta.acme || {}).timestamp, 500);
    }
    {
        const mod = build({
            memCompanies: { acme: '51-200 employees' },
            memMeta: { acme: { source: 'company-page', timestamp: 900 } },
            storedCompanies: { acme: '201-500 employees' },
            storedMeta: { acme: { source: 'company-page', timestamp: 100 } }
        });
        mod.mergeStoredIntoMemory();
        check('an OLDER stored value never overwrites our newer one', mod.companyCache.acme, '51-200 employees');
    }

    // excludeName is what makes a deliberate deletion (404 slug eviction) actually stick.
    {
        const mod = build({ memSlugs: {}, storedSlugs: { deadco: 'dead-slug', liveco: 'live-slug' } });
        mod.mergeStoredIntoMemory('deadco');
        check('an excluded name is NOT resurrected from the stored copy', mod.slugCache.deadco, undefined);
        check('other names still merge normally', mod.slugCache.liveco, 'live-slug');
    }

    // Never adopt a malformed value from a tab running an older version of the script.
    {
        const mod = build({ storedCompanies: { junkco: '2-10 employees' }, storedMeta: { junkco: { source: 'x', timestamp: 5 } } });
        mod.mergeStoredIntoMemory();
        check('a value outside SIZE_BUCKETS is never adopted', mod.companyCache.junkco, undefined);
    }

    // Slugs are additive-only: first discovery wins, no conflict resolution needed.
    {
        const mod = build({ memSlugs: { acme: 'acme-real' }, storedSlugs: { acme: 'acme-other', beta: 'beta-inc' } });
        mod.mergeStoredIntoMemory();
        check('an existing in-memory slug is not replaced', mod.slugCache.acme, 'acme-real');
        check('a slug we lack is adopted', mod.slugCache.beta, 'beta-inc');
    }
});

// ===========================================================================
// Suite: getSlugFor + recordSlugObservation (v7.35). Overrides exist because slugCache is
// machine-managed (auto-filled, auto-evicted on 404) — a hand-typed correction stored there would be
// destroyed by the next 404. Collision detection exists because cache keys are NORMALIZED names, so
// two genuinely different companies can collapse onto one key and silently share a size.
// ===========================================================================
await suite('getSlugFor / recordSlugObservation — overrides and name collisions', () => {
    function build({ slugCache = {}, slugOverrides = {}, nameCollisions = {} }) {
        const setup = `
            let slugCache = ${JSON.stringify(slugCache)};
            let slugOverrides = ${JSON.stringify(slugOverrides)};
            let nameCollisions = ${JSON.stringify(nameCollisions)};
            let saveCalls = 0;
            function saveNameCollisions() { saveCalls++; }
        `;
        const decls = ['getSlugFor', 'recordSlugObservation', 'countNameCollisions', 'formatNameCollisionSummary']
            .map((n) => extractDeclaration(n, SRC)).join('\n\n');
        const body = `${setup}\n\n${decls}\n\nmodule.exports = { getSlugFor, recordSlugObservation, countNameCollisions, formatNameCollisionSummary,
            get nameCollisions() { return nameCollisions; }, get saveCalls() { return saveCalls; } };\n`;
        const m = { exports: {} };
        new Function('module', 'exports', 'require', body)(m, m.exports, require);
        return m.exports;
    }

    {
        const mod = build({ slugCache: { acme: 'acme-auto' }, slugOverrides: { acme: 'acme-manual' } });
        check('a manual override wins over the auto-discovered slug', mod.getSlugFor('acme'), 'acme-manual');
    }
    {
        const mod = build({ slugCache: { acme: 'acme-auto' } });
        check('falls back to slugCache when no override exists', mod.getSlugFor('acme'), 'acme-auto');
        check('unknown company -> undefined, not a crash', mod.getSlugFor('nobody'), undefined);
    }

    // The real reported shape: one normalized key, two different real LinkedIn pages.
    {
        const mod = build({ slugCache: { acme: 'acme-corp' } });
        const flagged = mod.recordSlugObservation('acme', 'acme-industries');
        check('a second, different slug for the same key is flagged', flagged, true);
        check('both slugs are recorded so the user can tell them apart', mod.nameCollisions.acme, ['acme-corp', 'acme-industries']);
        check('collision count reflects it', mod.countNameCollisions(), 1);
    }
    {
        const mod = build({ slugCache: { acme: 'acme-corp' } });
        check('seeing the SAME slug again is not a collision', mod.recordSlugObservation('acme', 'acme-corp'), false);
        check('nothing recorded', mod.countNameCollisions(), 0);
        check('nothing persisted either', mod.saveCalls, 0);
    }
    {
        const mod = build({}); // no slug on file yet
        check('first-ever observation is not a collision', mod.recordSlugObservation('acme', 'acme-corp'), false);
    }
    {
        // Re-observing an already-known collision must not write to storage every single cycle —
        // getCardInfo() runs on every card on every pass.
        const mod = build({ slugCache: { acme: 'acme-corp' }, nameCollisions: { acme: ['acme-corp', 'acme-industries'] } });
        mod.recordSlugObservation('acme', 'acme-industries');
        check('an already-recorded collision does not re-persist', mod.saveCalls, 0);
    }
    {
        const mod = build({});
        check('no collisions -> plain summary', mod.formatNameCollisionSummary(), 'none detected');
    }

    // v7.37: reported live — "ey" had a stale slugCache value ("ey-studio", a different company)
    // shadowed by a correct override ("ernstandyoung"). Since every write site guards against ever
    // updating slugCache once an override exists, that stale value is permanently frozen — comparing
    // against it directly (the old behaviour) meant visiting the REAL, already-fixed company page
    // again kept re-flagging it as a "collision" forever, even though it was already resolved.
    {
        const mod = build({ slugCache: { ey: 'ey-studio' }, slugOverrides: { ey: 'ernstandyoung' } });
        const flagged = mod.recordSlugObservation('ey', 'ernstandyoung');
        check('an observation matching the override is NOT flagged, even though it disagrees with stale slugCache',
            flagged, false);
        check('nothing gets recorded for it', mod.nameCollisions.ey, undefined);
    }
    // A genuinely different THIRD slug must still be flagged even when an override already exists —
    // the override resolves ONE known pairing, it doesn't mean the key can't ALSO be catching some
    // other, unrelated company.
    {
        const mod = build({ slugCache: { ey: 'ey-studio' }, slugOverrides: { ey: 'ernstandyoung' } });
        const flagged = mod.recordSlugObservation('ey', 'some-third-company');
        check('a genuinely new third slug is still flagged despite an existing override',
            flagged, true);
        check('records the RESOLVED value alongside the new one, not the stale unused slugCache value',
            mod.nameCollisions.ey, ['ernstandyoung', 'some-third-company']);
    }
});

// ===========================================================================
// Suite: resolvePanelPosition (v7.35) — a panel position saved on a wide monitor must not strand the
// panel off-screen on a smaller one, where it could never be dragged back.
// ===========================================================================
await suite('resolvePanelPosition — off-screen guard on restore', () => {
    const m = buildModule(['resolvePanelPosition'], '');
    check('a position that still fits is restored as-is',
        m.resolvePanelPosition({ left: 100, top: 100 }, 1920, 1080, 280, 120), { left: 100, top: 100 });
    check('a position saved on a wider monitor is discarded',
        m.resolvePanelPosition({ left: 1800, top: 100 }, 1280, 800, 280, 120), null);
    check('a position saved on a taller monitor is discarded',
        m.resolvePanelPosition({ left: 100, top: 1000 }, 1280, 800, 280, 120), null);
    check('negative coordinates are discarded', m.resolvePanelPosition({ left: -50, top: 10 }, 1280, 800, 280, 120), null);
    check('exactly flush against the bottom-right edge still counts as on-screen',
        m.resolvePanelPosition({ left: 1000, top: 680 }, 1280, 800, 280, 120), { left: 1000, top: 680 });
    check('no saved position -> null (use the default corner)', m.resolvePanelPosition(null, 1280, 800, 280, 120), null);
    check('a partial/missing position -> null', m.resolvePanelPosition({ collapsed: true }, 1280, 800, 280, 120), null);
});

// ===========================================================================
// Suite: getCompaniesMissingSlug (v7.36) — reported live: the only way to find which cached
// companies had no known page (candidates for a manual override) was exporting and diffing
// companyCache against slugCache by hand.
// v7.41: MANUAL_EDIT entries used to be excluded (isReverifyEligible() skips them regardless of
// slug, so listing one pointed the user at a fix that unlocks nothing for the sweep) — reversed
// after being reported live: openSlugManager's table has no such filter and lists every company
// regardless of source, so a MANUAL_EDIT company with no page was visible in the table while
// silently missing from the count above it. Now "no page, full stop" — matches the table exactly.
// ===========================================================================
await suite('getCompaniesMissingSlug — every company with no known page, matching the table exactly', () => {
    function build({ companyCache = {}, companyCacheMeta = {}, slugCache = {}, slugOverrides = {} }) {
        const setup = `
            let companyCache = ${JSON.stringify(companyCache)};
            let companyCacheMeta = ${JSON.stringify(companyCacheMeta)};
            let slugCache = ${JSON.stringify(slugCache)};
            let slugOverrides = ${JSON.stringify(slugOverrides)};
        `;
        const decls = ['CACHE_SOURCE', 'getSlugFor', 'getCompaniesMissingSlug'].map((n) => extractDeclaration(n, SRC)).join('\n\n');
        return buildModule(['getCompaniesMissingSlug'], setup + '\n\n' + decls);
    }

    {
        const mod = build({
            companyCache: { alpha: '1-10 employees', beta: '11-50 employees' },
            slugCache: { alpha: 'alpha-inc' }
        });
        check('a company with a known slug is excluded', mod.getCompaniesMissingSlug(), ['beta']);
    }
    {
        const mod = build({
            companyCache: { alpha: '1-10 employees' },
            slugOverrides: { alpha: 'alpha-real' }
        });
        check('an override counts as "has a page", same as an auto-discovered slug', mod.getCompaniesMissingSlug(), []);
    }
    {
        // v7.41: a MANUAL_EDIT entry with no page is now INCLUDED — the re-verify sweep would still
        // never reach it, but the table this count sits above shows it regardless of source, and the
        // count has to match what's actually visible there.
        const mod = build({
            companyCache: { handedited: '1-10 employees' },
            companyCacheMeta: { handedited: { source: 'manual-edit', timestamp: 1 } }
        });
        check('a MANUAL_EDIT entry with no page IS listed, matching the (unfiltered) table',
            mod.getCompaniesMissingSlug(), ['handedited']);
    }
    {
        const mod = build({
            companyCache: { zebra: '1-10 employees', apple: '1-10 employees' }
        });
        check('results are sorted, not insertion order', mod.getCompaniesMissingSlug(), ['apple', 'zebra']);
    }
    check('empty cache -> empty list, not a crash', build({}).getCompaniesMissingSlug(), []);
});

// ===========================================================================
// Suite: esc (v7.38) — company names come from LinkedIn's own page text, not something this script
// controls, and the new slug manager table interpolates them into innerHTML rather than assigning
// as textContent (needed for the per-row "Edit" link markup) — this is what keeps that safe.
// ===========================================================================
await suite('esc — HTML-escapes text before it goes into innerHTML', () => {
    const m = buildModule(['esc'], '');
    check('escapes the four HTML-special characters', m.esc(`<b>Tom & "Jerry"</b>`), '&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;');
    check('plain text passes through unchanged', m.esc('Tata Consultancy Services'), 'Tata Consultancy Services');
    check('null -> empty string, not "null"', m.esc(null), '');
    check('undefined -> empty string, not "undefined"', m.esc(undefined), '');
    check('a number is coerced to its string form', m.esc(2026), '2026');
});

// ===========================================================================
// Suite: getCompanyNamesByRecency (v7.39) — reported live: a batch Auto-Fetch just classified
// landed at the very BOTTOM of the size manager (raw companyCache insertion order) while scattering
// alphabetically through the slug manager, so reviewing a fresh run meant scrolling one list and
// hunting the other. Both views now share this one ordering.
// ===========================================================================
await suite('getCompanyNamesByRecency — newest-touched first, shared by both management views', () => {
    const m = buildModule(['getCompanyNamesByRecency'], '');

    check('most recently touched sorts first', m.getCompanyNamesByRecency(
        { alpha: '1-10 employees', beta: '11-50 employees', gamma: '51-200 employees' },
        { alpha: { timestamp: 100 }, beta: { timestamp: 300 }, gamma: { timestamp: 200 } }
    ), ['beta', 'gamma', 'alpha']);

    check('an entry with no meta at all sorts last, not first or crashing', m.getCompanyNamesByRecency(
        { fresh: '1-10 employees', ancient: '11-50 employees' },
        { fresh: { timestamp: 500 } }
    ), ['fresh', 'ancient']);

    check('a meta entry present but missing a numeric timestamp is treated the same as no meta', m.getCompanyNamesByRecency(
        { fresh: '1-10 employees', broken: '11-50 employees' },
        { fresh: { timestamp: 500 }, broken: { source: 'company-page' } }
    ), ['fresh', 'broken']);

    check('empty cache -> empty list, not a crash', m.getCompanyNamesByRecency({}, {}), []);
});

// ===========================================================================
// Suite: computePanelPositionToPersist (v7.43) — a real, reproduced bug. injectControlPanel() called
// setActiveTab() (which persists panel state) BEFORE appending the container to document.body. A
// detached element's getBoundingClientRect() is all zeros, so a panel the user had dragged somewhere
// had its good saved position overwritten with (0,0) on EVERY page load, and came back jammed into
// the top-left corner. The call order is fixed too; this guard is the backstop so no future caller
// can reintroduce it by persisting at the wrong moment.
// ===========================================================================
await suite('computePanelPositionToPersist — never write a position from a detached container', () => {
    const m = buildModule(['computePanelPositionToPersist'], '');
    const el = (moved, connected) => ({ dataset: moved ? { moved: '1' } : {}, isConnected: connected });

    check('attached + moved -> persists the real rounded position',
        m.computePanelPositionToPersist(el(true, true), { left: 900.4, top: 400.6 }), { left: 900, top: 401 });

    // The exact reported shape: a restored position, persisted before attach.
    check('DETACHED + moved -> null, so the good saved position is left alone',
        m.computePanelPositionToPersist(el(true, false), { left: 0, top: 0 }), null);

    check('never moved -> explicit nulls, so the panel keeps following the default corner',
        m.computePanelPositionToPersist(el(false, true), { left: 123, top: 456 }), { left: null, top: null });

    check('never moved AND detached -> still explicit nulls, not a crash',
        m.computePanelPositionToPersist(el(false, false), { left: 0, top: 0 }), { left: null, top: null });
});

finish();

})();

function finish() {
    console.log(`\n${'='.repeat(60)}`);
    if (fail === 0) {
        console.log(`ALL PASS — ${pass} passed, 0 failed`);
        process.exit(0);
    } else {
        console.log(`FAILURES PRESENT — ${pass} passed, ${fail} failed`);
        failures.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
}
