/**
 * The public landing page - the v2 design of 1 October 2026.
 *
 * ## Why this is server-rendered and the app is not
 *
 * The app is a shell that fetches everything it shows; this page has to be
 * complete in the first response. It is the only page a search engine, a
 * WhatsApp link preview or a visitor with scripts disabled will ever see, and
 * all three read the bytes the server sent and nothing else.
 *
 * That has one consequence worth stating plainly: the header is personalised
 * server-side, so the response varies by cookie. See the cache-control
 * reasoning in landing.controller.ts - a personalised page that reaches a
 * shared cache is somebody else's name on your screen.
 *
 * ## The design, and what the server fills in
 *
 * The markup is the designer's, verbatim, apart from what only the server can
 * know:
 *
 * - **Every number.** Starting credits and prices come from configuration and
 *   CREDIT_COST, never from the markup. The design said "30 free credits"; a new
 *   account gets the free allowance *and* the signup bonus, so the page says
 *   whatever those add up to on this deployment.
 * - **The header and every call to action**, which differ for a signed-in
 *   visitor.
 * - **The claim switches** (`data-live` on `<html>`). Each "Live" claim in the
 *   design is hidden until its switch is on. WA and PAY are switched by
 *   configuration - WhatsApp and Razorpay either have credentials or they do
 *   not. The rest are claims about how answers are produced, which only the
 *   operator can vouch for: they are listed in LANDING_CLAIMS, and none is on
 *   by default. A claim switched on that is not true is the one failure this
 *   page cannot afford.
 * - **The preview notice**, when this deployment cannot do what the page
 *   describes.
 *
 * ## The preview script
 *
 * The design carries a script that turns claims on from the URL (`?live=all`),
 * for looking at the page before a claim is live. On production it is left
 * out: a link that makes leylegal.in display "Live" beside something that is
 * not would be a screenshot of the product claiming it.
 */

export interface LandingView {
  /** Renders the account chip instead of the sign-in pair. */
  signedIn: boolean;
  /** Display name for the chip. Untrusted - it is whatever the user typed. */
  displayName: string | null;
  /** The free allowance, granted once at signup. -1 means unmetered for that role. */
  freeMonthlyCredits: number;
  /** Credits per search, from CREDIT_COST so the page cannot drift from billing. */
  searchCost: number;
  /** Credits per case-status lookup, from CREDIT_COST. */
  caseStatusCost: number;
  /** Credits granted on signup on top of the allowance. */
  signupBonus: number;
  /** Digits only, as WHATSAPP_DISPLAY_NUMBER holds it. Empty when unset. */
  whatsappNumber: string;
  /** True when eCourts is a live provider rather than the mock adapter. */
  caseStatusLive: boolean;
  /** True when a judgment source is configured. */
  caseLawLive: boolean;
  /** True when a real synthesis model is wired up. */
  answersLive: boolean;
  /** The claim switches that are on: see {@link CLAIMS}. */
  claims: readonly Claim[];
  /** Include the design's ?live= preview script. Never on production. */
  previewClaims: boolean;
  /** Public origin, for canonical and og:url. */
  publicUrl: string;
  /** Current year, passed in rather than read from the clock, so output is testable. */
  year: number;
}

/**
 * The design's claim switches.
 *
 *   T2      a named case is found, or reported as not found
 *   T3      no answer, no charge
 *   T4      section numbers come from the bare acts, not the AI's memory
 *   WA      the WhatsApp channel is open            (from configuration)
 *   S1      student verification, with more credits
 *   PAY     paid top-ups                            (from configuration)
 *   REVIEW  answers reviewed by a legal reviewer every week
 *   V2      every citation checked against the judgments database
 */
export const CLAIMS = ['T2', 'T3', 'T4', 'WA', 'S1', 'PAY', 'REVIEW', 'V2'] as const;
export type Claim = (typeof CLAIMS)[number];

/** The ones only the operator can vouch for - set in LANDING_CLAIMS. */
export const OPERATOR_CLAIMS: readonly Claim[] = ['T2', 'T3', 'T4', 'S1', 'REVIEW', 'V2'];

/**
 * LANDING_CLAIMS as written ("T3 T4", "t3,t4") to the claims it switches on.
 *
 * Anything else is dropped, WA and PAY included: those follow configuration,
 * and listing them cannot make WhatsApp open or payments work.
 */
export function operatorClaims(raw: string): Claim[] {
  const wanted = new Set(raw.toUpperCase().split(/[\s,]+/).filter(Boolean));
  return OPERATOR_CLAIMS.filter((claim) => wanted.has(claim));
}

/**
 * Escape text for HTML interpolation.
 *
 * The display name is the reason this exists. It is chosen by the user at
 * signup, stored verbatim, and printed into the header of a page served back to
 * them - precisely the shape of a stored XSS. Everything interpolated below goes
 * through here; nothing is trusted for being "ours", because the numbers are
 * configuration and configuration is edited by hand.
 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Initials for the account chip. Falls back to a neutral mark, never to blank. */
function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'LEY';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Digits only - what wa.me expects, and what keeps a hand-typed value safe. */
export function waDigits(value: string): string {
  return value.replace(/\D/g, '');
}

const ICON = {
  moon:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  menu:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M3.5 7.5h17M3.5 16.5h17"/></svg>',
  info:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9.2"/><path d="M12 11v5.5M12 7.6v.1"/></svg>',
};

/** "2 credits", "1 credit". */
function credits(n: number): string {
  return `${n} credit${n === 1 ? '' : 's'}`;
}

/** What a new account starts with: the free allowance plus the signup bonus. */
function startingCredits(view: LandingView): number | null {
  return view.freeMonthlyCredits < 0 ? null : view.freeMonthlyCredits + view.signupBonus;
}

/** "40 free credits", or "Free credits" when the allowance is unmetered. */
function startPhrase(view: LandingView): string {
  const n = startingCredits(view);
  return n === null ? 'Free credits' : `${n} free credits`;
}

function priceTag(cost: number): string {
  return cost === 0 ? '<span class="tag free">Always free</span>' : `<span class="tag">${esc(credits(cost))}</span>`;
}

/**
 * Whatever this deployment cannot currently do, said once, at the top.
 *
 * Empty when everything the page describes is wired up - which is the state a
 * production deployment should be in, and therefore the state in which a
 * visitor sees no notice at all.
 */
function previewNotice(view: LandingView): string {
  const missing: string[] = [];
  if (!view.answersLive) missing.push('answers come from a placeholder model, not a legal one');
  if (!view.caseLawLive) missing.push('no judgment source is connected, so case-law search returns nothing');
  if (!view.caseStatusLive) missing.push('court records are sample data rather than live eCourts data');
  if (missing.length === 0) return '';

  return (
    '<div class="notice"><div class="wrap">' +
    `<span class="mark">${ICON.info}</span>` +
    '<p><b>Preview deployment.</b> On this instance, ' +
    esc(missing.join('; ')) +
    '. Accounts and credits work exactly as described.</p>' +
    '</div></div>'
  );
}

/** The right-hand side of the header: an account chip, or the two doors. */
function headerActions(view: LandingView): string {
  const toggle =
    '<button class="icon-btn" id="theme-toggle" type="button" aria-label="Switch between light and dark">' +
    ICON.moon +
    '</button>';

  if (view.signedIn) {
    return (
      '<div class="header-actions">' +
      toggle +
      '<a class="who" href="/app">' +
      `<span class="who-name">${esc(view.displayName || 'Your account')}</span>` +
      `<span class="avatar" aria-hidden="true">${esc(initials(view.displayName))}</span>` +
      '</a>' +
      '</div>'
    );
  }

  return '<div class="header-actions">' + toggle + '<a class="btn quiet" href="/app">Log in</a><a class="btn" href="/app/signup">Sign up</a></div>';
}

/**
 * The collapsed menu for narrow screens.
 *
 * Carries the section links plus whichever account action the header drops at
 * that width, so nothing becomes unreachable on a phone - which is most of this
 * audience. A `<details>` rather than a button with a handler, so it opens on a
 * page where no script ran.
 */
function mobileMenu(view: LandingView): string {
  const account = view.signedIn
    ? '<a href="/app">Open Ley Legal</a>'
    : '<a href="/app">Log in</a><a href="/app/signup">Create an account</a>';

  return (
    '<details class="menu"><summary aria-label="Menu">' +
    ICON.menu +
    '</summary><div class="menu-panel">' +
    '<a href="#features">Features</a><a href="#advocates">For advocates</a><a href="#students">For students</a>' +
    '<a href="#checks">How we check</a><a href="#credits">Credits</a><a href="#faq">Questions</a>' +
    '<hr>' +
    account +
    '</div></details>'
  );
}

/** The design's claim preview - ?live=all or ?live=T2,T4 - verbatim. */
const PREVIEW_SCRIPT =
  "<script>/* Preview of claim switches: ?live=all or ?live=T2,T4 */try{var q=new URLSearchParams(location.search).get('live');" +
  "if(q!==null)document.documentElement.setAttribute('data-live',q==='all'?'T2 T3 T4 WA S1 PAY REVIEW V2':q.replace(/,/g,' '))}catch(e){}</script>";

export function renderLanding(view: LandingView, css: string): string {
  const canonical = view.publicUrl.replace(/\/+$/, '') + '/';
  const start = startPhrase(view);
  const startCount = Math.max(0, view.freeMonthlyCredits) + view.signupBonus;
  const digits = waDigits(view.whatsappNumber);

  const doors = view.signedIn
    ? '<a class="btn lg" href="/app">Open Ley Legal</a>'
    : '<a class="btn lg" href="/app/signup?for=advocate">I&#8217;m an advocate</a>' +
      '<a class="btn lg quiet" href="/app/signup?for=student">I&#8217;m a law student</a>';

  const prices = `Research costs ${esc(credits(view.searchCost))}; case status costs ${esc(view.caseStatusCost)}.`;
  const heroNote = view.signedIn
    ? `<p class="hero-note rise d3">${prices}</p>`
    : `<p class="hero-note rise d3">
        <span data-until="S1">${esc(start)} to start. No card.</span><span data-needs="S1">${esc(start)} to start, 50 for verified law students. No card.</span>
        ${prices}
        Already have an account? <a href="/app">Log in</a>
      </p>`;

  const advocateCta = view.signedIn
    ? '<div class="cta-row"><a class="btn lg" href="/app">Open Ley Legal</a></div>'
    : `<div class="cta-row"><a class="btn lg" href="/app/signup?for=advocate">Start as an advocate</a><span class="small">${esc(start)}. No card.</span></div>`;
  const studentCta = view.signedIn
    ? '<div class="cta-row"><a class="btn lg" href="/app">Open Ley Legal</a></div>'
    : `<div class="cta-row"><a class="btn lg" href="/app/signup?for=student">Sign up as a student</a><span class="small" data-until="S1">${esc(start)}. No card.</span><span class="small" data-needs="S1">Up to 50 free credits. No card.</span></div>`;

  const startFigure = startingCredits(view) === null ? '&#8734;' : esc(startingCredits(view));
  const caseStatusLine =
    view.caseStatusCost === 0 ? 'Free, every time.' : view.caseStatusCost === 1 ? 'One CNR, one credit.' : `One CNR, ${esc(credits(view.caseStatusCost))}.`;

  const closerHead = view.signedIn ? 'Pick up where you left off.' : `Start with ${esc(start)}.`;
  const closerNote = view.signedIn ? '' : '\n      <p class="hero-note">Already have an account? <a href="/app">Log in</a></p>';
  const footerAccount = view.signedIn
    ? '<li><a href="/app">Open Ley Legal</a></li>'
    : '<li><a href="/app">Log in</a></li>\n          <li><a href="/app/signup">Sign up</a></li>';

  // Only with a number to send to: an "On WhatsApp" with nowhere to go is a dead end.
  const waLine = digits
    ? `\n            <p class="wa-line"><a class="btn quiet" href="https://wa.me/${esc(digits)}" rel="noopener">Message Ley Legal on WhatsApp</a></p>`
    : '';

  return `<!doctype html>
<html lang="en" data-live="${esc(view.claims.join(' '))}">
<!-- Claim switches: data-live is set by the server - see landing.html.ts and LANDING_CLAIMS. -->
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Ley Legal: legal research for Indian advocates and law students</title>
<meta name="description" content="Sections across the old and new criminal codes, judgments on your point, and case status by CNR, for Indian advocates and law students. Ask in English, Hindi or Hinglish. Early access.">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Ley Legal">
<meta property="og:title" content="Ley Legal: Indian law, in your language">
<meta property="og:description" content="Sections across the old and new criminal codes, judgments on your point, and case status by CNR, for Indian advocates and law students. Ask in English, Hindi or Hinglish.">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<script>try{var t=localStorage.getItem('vs-theme');if(!t)t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
${view.previewClaims ? PREVIEW_SCRIPT : ''}
<style>${css}</style>
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">
      <span class="logo-mark"><svg width="24" height="24" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><rect x="23" y="10" width="10" height="42" rx="4"/><circle cx="28" cy="12" r="5"/><circle cx="28" cy="48" r="5"/><rect x="10" y="52" width="16" height="24" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><rect x="26" y="52" width="22" height="24" rx="4"/><path d="M54 26 h18 v6 h-12 v14 h10 v6 h-10 v16 h12 v6 h-18 z"/><path d="M78 26 l7 22 l7 -22 h6 l-10 28 v18 h-6 v-18 l-10 -28 z"/></svg></span>
      <span class="en">Ley Legal</span>
    </a>
    <nav class="site-nav" aria-label="Sections">
      <a href="#features">Features</a>
      <a href="#advocates">Advocates</a>
      <a href="#students">Students</a>
      <a href="#checks">How we check</a>
      <a href="#credits">Credits</a>
      <a href="#faq">Questions</a>
    </nav>
    ${headerActions(view)}
    ${mobileMenu(view)}
  </div>
</header>
${previewNotice(view)}
<main>
  <!-- ================================================================ HERO -->
  <section class="hero">
    <div class="wrap">
      <p class="eyebrow rise">Early access &#183; For advocates and law students</p>
      <h1 class="display rise d1">
        Indian law,<br><span class="soft">in your language.</span>
      </h1>
      <p class="lede rise d2">
        Look up a section under the old criminal codes or the new ones, find judgments
        on your point, and check a case&#8217;s next date by CNR. Built for advocates in
        India&#8217;s district courts, and for the law students who will join them.
      </p>
      <p class="lede-hi rise d2" lang="hi">&#2361;&#2367;&#2306;&#2342;&#2368;, English &#2351;&#2366; Hinglish &#8212; &#2332;&#2376;&#2360;&#2375; &#2360;&#2379;&#2330;&#2340;&#2375; &#2361;&#2376;&#2306;, &#2357;&#2376;&#2360;&#2375; &#2346;&#2370;&#2331;&#2367;&#2319;&#2404;</p>
      <div class="hero-cta rise d3">${doors}</div>
      ${heroNote}

      <div class="specimen rise d4" aria-label="An example of the answer format">
        <div class="specimen-bar">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span style="margin-left:5px">An example of the answer format</span>
        </div>
        <div class="specimen-body">
          <p class="q">498A mein seedha arrest ho sakta hai? Naye law mein section kya hai?</p>
          <h4>Provision</h4>
          <p>Cruelty by husband or relatives: <span class="ref">Section 85, BNS</span>,
             formerly <span class="ref">Section 498A, IPC</span>.
             Arrest without warrant: <span class="ref">Section 35, BNSS</span>,
             formerly <span class="ref">Sections 41 and 41A, CrPC</span>.</p>
          <h4>Authority</h4>
          <p><i>Arnesh Kumar v. State of Bihar</i>, <span class="ref">(2014) 8 SCC 273</span>.
             Arrest is not automatic in a 498A case. The police must satisfy the conditions
             in Section 41 and record their reasons, and a magistrate must not authorise
             detention mechanically.</p>
          <p class="foot">Open the full judgment and the section text before you cite either.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ============================================================ FEATURES -->
  <section class="band hair" id="features">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">What it does</p>
        <h2 class="h2">Three tools for questions that come up every day.</h2>
        <p class="sub">
          Not a general chatbot pointed at law. Each tool does one job you would otherwise
          do with two statute books, a database login and the eCourts website.
        </p>
      </div>
      <div class="cards">
        <div class="card">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7"/></svg></div>
          <h3 class="h3">Sections, old and new</h3>
          <p>Name a section or describe the offence. Get the provision with its counterpart
             across IPC&#8596;BNS and CrPC&#8596;BNSS, so an FIR under the new code and a
             judgment under the old one can be read side by side.</p>
          <p class="card-note" data-needs="T4"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.8 4.8L19 7"/></svg>Section numbers come from our table of the bare acts, never from the AI&#8217;s memory.</p>
          ${priceTag(view.searchCost)}
        </div>
        <div class="card">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v17M8.5 21h7M4 7.5h16"/><path d="M6.5 7.5 3 14.5h7zM17.5 7.5 14 14.5h7"/><path d="M3 14.5a3.5 3.5 0 0 0 7 0M14 14.5a3.5 3.5 0 0 0 7 0"/><path d="M12 4.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg></div>
          <h3 class="h3">Judgments on your point</h3>
          <p>Describe the point of law in your own words, or name the case you have in mind.
             Get judgments with the court, the date and a link to the full text.</p>
          <p class="card-note" data-needs="T2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.8 4.8L19 7"/></svg>Name a case we don&#8217;t have and you are told so. Nothing is guessed.</p>
          ${priceTag(view.searchCost)}
        </div>
        <div class="card">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13.5 12.5-7.8 7.8a1.9 1.9 0 0 1-2.7-2.7l7.8-7.8"/><path d="m15.5 3.5 5 5M13.5 5.5l5 5M17.5 1.5l5 5M3 22h8"/></svg></div>
          <h3 class="h3">Case status by CNR</h3>
          <p>Send the 16-character CNR. Get the stage, the next hearing date, the court, the
             parties and the advocates on record.</p>
          ${priceTag(view.caseStatusCost)}
        </div>
      </div>

      <div class="channels" style="margin-top:44px">
        <div class="channel">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.8" y="3.8" width="18.4" height="14.4" rx="2.4"/><path d="M2.8 8.2h18.4M8 21.2h8"/></svg></div>
          <div class="body">
            <h3 class="h3">In your browser</h3>
            <p class="small">Works on any phone or computer, with nothing to install. Your
               questions and answers stay in your account, so you can pick up where you
               left off.</p>
          </div>
        </div>
        <div class="channel">
          <div class="glyph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.8a9.2 9.2 0 0 0-7.9 13.9L2.8 21.2l4.6-1.2A9.2 9.2 0 1 0 12 2.8z"/><path d="M9 8.4c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .6.5l.7 1.7c.1.2 0 .4-.1.5l-.5.6c-.1.2-.3.3-.1.6a7 7 0 0 0 3.2 2.8c.3.1.4 0 .6-.1l.6-.8c.2-.2.3-.2.6-.1l1.6.8c.3.1.4.3.4.5a1.9 1.9 0 0 1-1.4 1.7c-.6.1-1.4 0-3.6-1a9.9 9.9 0 0 1-4-4.2c-.4-.9-.6-1.6-.6-2.2A2.4 2.4 0 0 1 9 8.4z"/></svg></div>
          <div class="body" data-needs="WA">
            <h3 class="h3">On WhatsApp</h3>
            <p class="small">Ask from the court corridor, on the phone you already carry.
               Link your number once and both channels share one account, one history
               and one balance.</p>${waLine}
          </div>
          <div class="body" data-until="WA">
            <h3 class="h3">On WhatsApp <span class="tag">Not open yet</span></h3>
            <p class="small">The same assistant on WhatsApp, for the court corridor. It
               isn&#8217;t open yet. Everyone who has signed up will hear when it is.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- =========================================================== ADVOCATES -->
  <section class="band tint" id="advocates">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">For advocates</p>
        <h2 class="h2">For the hour before your matter is called.</h2>
        <p class="sub">
          District-court practice runs on short notice: a brief handed over in the morning,
          a bail matter listed for tomorrow, an FIR registered under codes that changed on
          1 July 2024. Ley Legal is built for that hour.
        </p>
      </div>
      <div class="uses">
        <div class="use">
          <h3 class="h3">Both section numbers, side by side</h3>
          <p>FIRs and chargesheets now cite BNS and BNSS. Most of the case law you rely on
             cites IPC and CrPC. Ask with either number and get both.</p>
        </div>
        <div class="use">
          <h3 class="h3">Authorities, asked in your own words</h3>
          <p>Type the issue the way you would put it to a colleague, such as
             <q>default bail, chargesheet not filed in 90 days</q>, and get judgments you
             can open and read.</p>
        </div>
        <div class="use">
          <h3 class="h3">The next date, from your phone</h3>
          <p>Check a matter&#8217;s stage and next hearing by CNR, without working through
             the eCourts website on a small screen.</p>
        </div>
        <div class="use">
          <h3 class="h3">Hindi, English or Hinglish</h3>
          <p>Ask in the language you argue in. A question that mixes Hindi and English is
             expected, not an error.</p>
        </div>
      </div>
      ${advocateCta}
    </div>
  </section>

  <!-- ============================================================ STUDENTS -->
  <section class="band" id="students">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">For law students</p>
          <h2 class="h2">Read the judgment, not just the guidebook.</h2>
          <p class="sub" style="margin:16px 0 36px">
            Most LLB students learn their cases from notes and summaries, often because a
            paid database is out of reach. Ley Legal helps you find the section, open the
            judgment itself, and see how the old code maps to the new, on your phone and
            in your language.
          </p>
          <ul class="points">
            <li><span class="pip"></span><span><b>Old code, new code</b>
              <span class="detail">Your syllabus has moved to BNS and BNSS, but most of the
              judgments you will read still cite IPC and CrPC. Look up either and see
              both.</span></span></li>
            <li><span class="pip"></span><span><b>Cases for assignments and moots</b>
              <span class="detail">Find judgments on a proposition, with court and date,
              and open the full text to follow the reasoning yourself.</span></span></li>
            <li><span class="pip"></span><span><b>Follow a real matter</b>
              <span class="detail">Interning with an advocate? Check a case&#8217;s stage
              and next date by CNR.</span></span></li>
            <li><span class="pip"></span><span><b>Research help, not a ghostwriter</b>
              <span class="detail">It helps you find and read the law. It is not built to
              write your assignment.</span></span></li>
            <li data-needs="S1"><span class="pip"></span><span><b>More credits for students</b>
              <span class="detail green">Verify with your college email ID or by uploading
              your student ID card, and start with 50 credits instead of ${esc(startCount)}.</span></span></li>
          </ul>
        </div>

        <div class="specimen" aria-label="An example of the answer format">
          <div class="specimen-bar">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            <span style="margin-left:5px">An example of the answer format</span>
          </div>
          <div class="specimen-body">
            <p class="q">IPC 302 ka BNS mein kaunsa section hai?</p>
            <h4>Punishment for murder</h4>
            <p><span class="ref">Section 103(1), BNS</span>, formerly
               <span class="ref">Section 302, IPC</span>.</p>
            <h4>Definition of murder</h4>
            <p><span class="ref">Section 101, BNS</span>, formerly
               <span class="ref">Section 300, IPC</span>.</p>
            <h4>Watch out</h4>
            <p class="warn">Section 302 of the BNS is a different provision: uttering words
               with deliberate intent to wound religious feelings. Never write &#8220;BNS 302&#8221;
               for murder.</p>
            <p class="foot">Open the bare-act text before you put a section number in an
               answer script.</p>
          </div>
        </div>
      </div>

      <div class="subhead">
        <h3 class="h3">Planned for students</h3>
        <span class="small">Not live yet. Sign up as a student and we will tell you as each one opens.</span>
      </div>
      <div class="cards">
        <div class="card">
          <h3 class="h3">Judgment, explained</h3>
          <p>Name a judgment and get a short brief covering facts, issues, holding and ratio,
             with each point linked to the paragraph it comes from.</p>
          <span class="tag">Planned</span>
        </div>
        <div class="card">
          <h3 class="h3">New criminal laws practice</h3>
          <p>Short questions on BNS, BNSS and BSA against the old codes, for semester exams
             and judiciary prelims.</p>
          <span class="tag">Planned</span>
        </div>
        <div class="card">
          <h3 class="h3">Moot and project research pack</h3>
          <p>Collect the authorities on a proposition into one list with full citations,
             ready for a memorial or a project.</p>
          <span class="tag">Planned</span>
        </div>
      </div>
      ${studentCta}
    </div>
  </section>

  <!-- ========================================================= HOW WE CHECK -->
  <section class="band tint" id="checks">
    <div class="wrap">
      <div class="split">
        <div>
          <p class="eyebrow">How we check answers</p>
          <h2 class="h2">An invented case is worse than no answer.</h2>
          <p class="sub" style="margin-top:16px">
            The Supreme Court has held that it is misconduct for an advocate to cite
            AI-generated judgments without verifying them.<sup>1</sup> That is the standard
            Ley Legal is being built to. Here is each check, and whether it is live.
          </p>
          <p class="early until-core">
            <b>Ley Legal is in early access.</b> Its answers can still contain mistakes,
            including a wrong section number or a case that does not exist. Read every
            authority in full before you rely on it.
          </p>
          <ul class="status">
            <li>
              <span><span class="chip on" data-needs="T2">Live</span><span class="chip" data-until="T2">Not yet</span></span>
              <span><b>A case you name is found, or reported as not found</b>
              <span class="detail">Give a case name or a citation and we look for that exact
              judgment. If it is not in our data, the answer says so instead of offering
              something close.</span></span>
            </li>
            <li>
              <span><span class="chip on" data-needs="T4">Live</span><span class="chip" data-until="T4">Not yet</span></span>
              <span><b>Section numbers come from the bare acts</b>
              <span class="detail">Section numbers and old-to-new mappings are read from our
              table of the acts, not written from the AI&#8217;s memory.</span></span>
            </li>
            <li>
              <span><span class="chip on" data-needs="T3">Live</span><span class="chip" data-until="T3">Not yet</span></span>
              <span><b>No answer, no charge</b>
              <span class="detail">If a search finds nothing, the credits go back to your
              balance.</span></span>
            </li>
            <li>
              <span><span class="chip on" data-needs="REVIEW">Live</span><span class="chip" data-until="REVIEW">Not yet</span></span>
              <span><b>Answers reviewed every week</b>
              <span class="detail">Every answer is logged. Each week a legal reviewer checks
              a sample against the source, and what they find decides what we fix
              next.</span></span>
            </li>
            <li>
              <span><span class="chip on" data-needs="V2">Live</span><span class="chip" data-until="V2">Not yet</span></span>
              <span><b>Every citation in an answer checked automatically</b>
              <span class="detail">Each citation matched against our own database of
              judgments before you see the answer.</span></span>
            </li>
          </ul>
          <p class="footnote">1. <i>Pooja Ramesh Singh v. Jammu and Kashmir Bank Ltd.</i>,
             2026 INSC 668 (2 July 2026).</p>
        </div>

        <div class="stack">
          <div class="specimen" data-needs="T2" aria-label="An example of a not-found answer">
            <div class="specimen-bar">
              <span class="dot"></span><span class="dot"></span><span class="dot"></span>
              <span style="margin-left:5px">What &#8220;not found&#8221; looks like</span>
            </div>
            <div class="specimen-body">
              <p class="q">Mercy v. Mankind ka judgment bhejo</p>
              <h4>Result</h4>
              <p>No judgment titled <i>Mercy v. Mankind</i> was found in our data. Check the
                 party names or the citation, or describe the point of law instead.</p>
              <p class="foot" data-needs="T3">No credits were charged for this search.</p>
            </div>
          </div>
          <div class="checklist">
            <h3>Before you cite anything from Ley Legal</h3>
            <ol>
              <li>Open the judgment and read the paragraph you are relying on.</li>
              <li>Match the citation: year, volume, reporter and page.</li>
              <li>Check it is still good law, not overruled and not reversed on appeal.</li>
              <li>For a section, check which code applies. Offences committed before 1 July 2024
                  are still charged under the IPC; whether the CrPC or the BNSS governs
                  procedure depends on when the proceedings began.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ============================================================= CREDITS -->
  <section class="band" id="credits">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">What it costs</p>
        <h2 class="h2">Credits, not a subscription.</h2>
        <p class="sub" data-until="PAY">
          You get free credits when you sign up, and each question draws on them.
          Paid top-ups by UPI are on the way.
        </p>
        <p class="sub" data-needs="PAY">
          You get free credits when you sign up, and each question draws on them. When they
          run out, top up by UPI. There is no monthly plan.
        </p>
      </div>
      <div class="figures">
        <div class="figure">
          <div class="n">${startFigure}</div>
          <div class="unit">free credits, once</div>
          <p>Given when you create your account. A one-time allowance, not a monthly one.</p>
          <p class="extra" data-needs="S1">Verified law students get 50: verify with a college email ID or a student ID card.</p>
        </div>
        <div class="figure">
          <div class="n">${esc(view.searchCost)}</div>
          <div class="unit">${view.searchCost === 1 ? 'credit' : 'credits'} per research question</div>
          <p>Section lookups and judgment searches.</p>
        </div>
        <div class="figure">
          <div class="n">${esc(view.caseStatusCost)}</div>
          <div class="unit">${view.caseStatusCost === 1 ? 'credit' : 'credits'} per case-status check</div>
          <p>${caseStatusLine}</p>
        </div>
      </div>
      <p class="figures-note" data-needs="T3">If a search finds nothing, you are not charged.</p>
    </div>
  </section>

  <!-- ================================================================ TEAM -->
  <section class="band tint" id="team">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">Who is building this</p>
        <h2 class="h2">Built to the standard of a regulatory report.</h2>
        <p class="sub">
          In regulatory reporting, a figure that cannot be traced back to its source is a
          failure, however good it looks. Ley Legal&#8217;s founder worked to that rule at
          Goldman Sachs, and it is the rule this product is being built to: an answer you
          cannot trace to a judgment or a section should not reach you.
        </p>
      </div>
      <div class="uses">
        <div class="use">
          <p class="role">Founder</p>
          <h3 class="h3">Ex-Goldman Sachs, regulatory reporting</h3>
          <p>Spent 15 years at Goldman Sachs in financial regulation, working on
             regulatory reporting: the figures a bank submits to its regulators, where every
             number has to trace back to its source and stand up to audit.</p>
        </div>
        <div class="use">
          <p class="role">Co-founder and CMO</p>
          <h3 class="h3">Second-time founder</h3>
          <p>Has built a company before. Leads marketing at Ley Legal, and how it reaches
             advocates and law students.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ================================================================= FAQ -->
  <section class="band" id="faq">
    <div class="wrap">
      <div class="band-head center">
        <p class="eyebrow">Questions</p>
        <h2 class="h2">Before you sign up.</h2>
      </div>
      <div class="faq">
        <details><summary>Can I rely on the answers?</summary><p class="answer">Treat them as the start of your research, not the end of it. Open every judgment and section Ley Legal gives you and read it before you rely on it. <span class="until-core">Ley Legal is in early access and its answers can be wrong. </span>The Supreme Court has made clear that citing an AI-generated judgment without verifying it is misconduct.</p></details>
        <details><summary>Is this legal advice?</summary><p class="answer">No. It is a research tool. It does not advise, does not appear for anyone, and has no view on your case.</p></details>
        <details><summary>Which languages can I ask in?</summary><p class="answer">English, Hindi and Hinglish, including the mix most people actually type.</p></details>
        <details><summary>I&#8217;m a law student. Can I use it?</summary><p class="answer">Yes. Sign up as a student. <span data-needs="S1">Verify with your college email ID or by uploading your student ID card, and you start with 50 credits instead of ${esc(startCount)}. </span>It is built to help you find and read the law, not to write your assignment.</p></details>
        <details><summary>Where do the judgments and case details come from?</summary><p class="answer">Judgments: from what Indian courts publish. Each result links to the full text, so you can read it at source. Case status: from published eCourts records.</p></details>
        <details><summary>Do I need to install anything?</summary><p class="answer">No. Ley Legal works in any modern browser on your phone or computer.<span data-needs="WA"> You can also use it on WhatsApp.</span></p></details>
        <details><summary>What happens to my questions?</summary><p class="answer">They are stored with your account, so your research history is there when you come back, and so we can review answers and fix mistakes. You can ask for your account and history to be deleted. The <a href="/privacy" style="text-decoration:underline;text-underline-offset:3px">privacy notice</a> explains how.</p></details>
      </div>
    </div>
  </section>

  <!-- ============================================================== CLOSER -->
  <section class="closer">
    <div class="wrap">
      <h2 class="h2">${closerHead}</h2>
      <p class="lede">No card and no sales call. Ask your first question in the language you think in.</p>
      <div class="hero-cta">${doors}</div>${closerNote}
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="brand" href="/">
          <span class="logo-mark"><svg width="24" height="24" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><rect x="23" y="10" width="10" height="42" rx="4"/><circle cx="28" cy="12" r="5"/><circle cx="28" cy="48" r="5"/><rect x="10" y="52" width="16" height="24" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><rect x="26" y="52" width="22" height="24" rx="4"/><path d="M54 26 h18 v6 h-12 v14 h10 v6 h-10 v16 h12 v6 h-18 z"/><path d="M78 26 l7 22 l7 -22 h6 l-10 28 v18 h-6 v-18 l-10 -28 z"/></svg></span>
          <span class="en">Ley Legal</span>
        </a>
        <p class="footer-blurb">
          Legal research for Indian advocates and law students: sections, judgments and
          case status, in English, Hindi or Hinglish.
        </p>
      </div>
      <div>
        <h4>Product</h4>
        <ul>
          <li><a href="#features">Features</a></li>
          <li><a href="#advocates">For advocates</a></li>
          <li><a href="#students">For students</a></li>
          <li><a href="#checks">How we check</a></li>
          <li><a href="#credits">Credits</a></li>
          <li><a href="#team">Who is building this</a></li>
        </ul>
      </div>
      <div>
        <h4>Account</h4>
        <ul>
          ${footerAccount}
          <li><a href="#faq">Questions</a></li>
          <li><a href="/privacy">Privacy</a></li>
        </ul>
      </div>
    </div>
    <div class="legal">
      <p>
        Ley Legal is a research tool for advocates and law students, in early access. It
        does not provide legal advice, does not create an advocate&#8211;client relationship,
        and its answers can be wrong. Read every authority in full before relying on it.
      </p>
      <p>&#169; ${esc(view.year)} Ley Legal</p>
    </div>
  </div>
</footer>
<script>var b=document.getElementById('theme-toggle');if(b)b.addEventListener('click',function(){var n=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('vs-theme',n)}catch(e){}});var m=document.querySelector('details.menu');if(m)document.addEventListener('click',function(e){if(m.open&&!m.contains(e.target))m.open=false});</script>
</body>
</html>
`;
}
