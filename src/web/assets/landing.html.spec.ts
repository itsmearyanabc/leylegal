import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { LANDING_CSS } from './landing.css';
import { LandingView, esc, operatorClaims, renderLanding } from './landing.html';

/**
 * The landing page - the v2 design of 1 October 2026.
 *
 * The page is a string, so TypeScript checks almost nothing about it. What is
 * worth a test:
 *
 *  1. **It is the designer's page.** With the design's own numbers it renders
 *     byte for byte as the HTML the designer handed over (kept in
 *     __fixtures__), so nothing was lost or retyped on the way in.
 *  2. **What only the server knows is filled in truthfully** - the starting
 *     credits and prices from configuration, the header for a signed-in
 *     visitor, and the claim switches.
 *  3. **A syntax error in an inline script**, which `nest build` cannot see.
 *  4. **An unescaped display name** - a stored XSS if `esc` is ever dropped.
 */

const DESIGN = readFileSync(join(__dirname, '__fixtures__', 'landing-v2.design.html'), 'utf8');

/** The design's own numbers, signed out, nothing live: the page as handed over. */
function view(overrides: Partial<LandingView> = {}): LandingView {
  return {
    signedIn: false,
    displayName: null,
    freeMonthlyCredits: 30,
    searchCost: 2,
    caseStatusCost: 1,
    signupBonus: 0,
    whatsappNumber: '',
    caseStatusLive: true,
    caseLawLive: true,
    answersLive: true,
    claims: [],
    previewClaims: true,
    publicUrl: 'https://leylegal.in',
    year: 2026,
    ...overrides,
  };
}

const render = (overrides: Partial<LandingView> = {}): string => renderLanding(view(overrides), LANDING_CSS);

/** The document without its stylesheet and scripts - what a visitor reads. */
const copy = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');

describe('the landing page', () => {
  describe('the design', () => {
    it('renders as the designer\'s HTML, byte for byte, given the design\'s numbers', () => {
      // The one line changed on purpose: the design pointed at developer notes
      // that are not in this repository.
      const expected = DESIGN.replace(
        '<!-- Claim switches: see data-live above. Instructions are in the developer notes, not in this file. -->',
        '<!-- Claim switches: data-live is set by the server - see landing.html.ts and LANDING_CLAIMS. -->',
      );
      expect(render()).toBe(expected);
    });
  });

  describe('inline scripts', () => {
    const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

    it('all parse as JavaScript', () => {
      for (const source of scripts(render())) expect(() => new Script(source)).not.toThrow();
    });

    it('apply the theme the app stores, under the key the app uses', () => {
      expect(render()).toContain("localStorage.getItem('vs-theme')");
      expect(render()).toContain("localStorage.setItem('vs-theme',n)");
    });

    it('leave out the claim preview on production, where ?live=all would show claims that are not live', () => {
      expect(render({ previewClaims: true })).toContain('Preview of claim switches');
      expect(render({ previewClaims: false })).not.toContain('Preview of claim switches');
      expect(scripts(render({ previewClaims: false }))).toHaveLength(2);
    });
  });

  describe('the claim switches', () => {
    it('are on only as given', () => {
      expect(render()).toContain('<html lang="en" data-live="">');
      expect(render({ claims: ['T3', 'T4', 'V2'] })).toContain('<html lang="en" data-live="T3 T4 V2">');
    });

    it('take only the claims an operator can vouch for from LANDING_CLAIMS', () => {
      expect(operatorClaims('T3 T4')).toEqual(['T3', 'T4']);
      expect(operatorClaims(' t3,v2 ')).toEqual(['T3', 'V2']);
      // WhatsApp and payments follow configuration; listing them changes nothing.
      expect(operatorClaims('WA PAY T4 X9')).toEqual(['T4']);
      expect(operatorClaims('')).toEqual([]);
    });
  });

  describe('the numbers', () => {
    it('say what a new account actually starts with - the allowance and the bonus', () => {
      const page = copy(render({ freeMonthlyCredits: 30, signupBonus: 10 }));
      expect(page).toContain('40 free credits to start. No card.');
      expect(page).toContain('<div class="n">40</div>');
      expect(page).toContain('Start with 40 free credits.');
      expect(page).not.toMatch(/\b30 free credits\b/);
    });

    it('quote the prices they were given rather than numbers typed into the markup', () => {
      const page = copy(render({ searchCost: 3, caseStatusCost: 2 }));
      expect(page).toContain('Research costs 3 credits; case status costs 2.');
      expect(page).toContain('<span class="tag">3 credits</span>');
      expect(page).toContain('<span class="tag">2 credits</span>');
      expect(page).toContain('One CNR, 2 credits.');
      expect(page).not.toContain('<span class="tag">1 credit</span>');
    });

    it('render an unmetered allowance without printing -1 at anybody', () => {
      const page = copy(render({ freeMonthlyCredits: -1 }));
      // The words on the page, not the icons' drawing paths ("-1.4 0-3.6").
      expect(page.replace(/<[^>]+>/g, ' ')).not.toContain('-1');
      expect(page).toContain('Free credits to start. No card.');
      expect(page).toContain('&#8734;');
    });
  });

  describe('the header, signed out', () => {
    it('offers both doors, and keeps them in the collapsed menu', () => {
      const page = render();
      expect(page).toContain('<a class="btn quiet" href="/app">Log in</a><a class="btn" href="/app/signup">Sign up</a>');
      expect(page).toContain('<hr><a href="/app">Log in</a><a href="/app/signup">Create an account</a>');
      expect(page).not.toContain('class="who"');
    });
  });

  describe('the header, signed in', () => {
    const page = render({ signedIn: true, displayName: 'Meera Iyer' });

    it('shows the name and initials', () => {
      expect(page).toContain('<span class="who-name">Meera Iyer</span>');
      expect(page).toContain('<span class="avatar" aria-hidden="true">MI</span>');
    });

    it('drops every sign-up and log-in call, for one way into the app', () => {
      expect(page).not.toContain('/app/signup');
      expect(copy(page)).not.toContain('Log in');
      expect(page).toContain('<a class="btn lg" href="/app">Open Ley Legal</a>');
      expect(page).toContain('Pick up where you left off.');
    });

    it('falls back to a neutral mark when there is no name', () => {
      expect(render({ signedIn: true, displayName: null })).toContain('<span class="avatar" aria-hidden="true">LEY</span>');
    });
  });

  describe('escaping', () => {
    it('neutralises markup in the display name', () => {
      const page = render({ signedIn: true, displayName: '<img src=x onerror=alert(1)>' });
      expect(page).not.toContain('<img src=x');
      expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('neutralises quotes and escapes ampersands first', () => {
      expect(esc(`"'`)).toBe('&quot;&#39;');
      expect(esc('&lt;')).toBe('&amp;lt;');
    });
  });

  describe('a deployment that cannot do what the page describes', () => {
    it('says nothing when everything is connected', () => {
      expect(render()).not.toContain('class="notice"');
    });

    it.each([
      [{ answersLive: false }, 'placeholder model'],
      [{ caseLawLive: false }, 'no judgment source is connected'],
      [{ caseStatusLive: false }, 'sample data rather than live eCourts data'],
    ])('admits it: %j', (over, said) => {
      const page = render(over);
      expect(page).toContain('Preview deployment.');
      expect(page).toContain(said);
      // WhatsApp is not open; the notice no longer vouches for it.
      expect(page).not.toContain('the WhatsApp channel work');
    });
  });

  describe('WhatsApp', () => {
    it('links to wa.me with digits only, when there is a number', () => {
      expect(render({ whatsappNumber: '+91 98765-43210' })).toContain('href="https://wa.me/919876543210"');
    });

    it('offers no link without one', () => {
      expect(render()).not.toContain('wa.me');
    });
  });

  describe('the document', () => {
    it('normalises a trailing slash on the public URL rather than doubling it', () => {
      const page = render({ publicUrl: 'https://leylegal.in///' });
      expect(page).toContain('<link rel="canonical" href="https://leylegal.in/">');
      expect(page).toContain('<meta property="og:url" content="https://leylegal.in/">');
    });

    it('leaves no undefined or NaN in the output', () => {
      const page = render({ signedIn: true, displayName: null, whatsappNumber: '919876543210', claims: ['T3'] });
      expect(page).not.toMatch(/undefined|NaN/);
    });

    it('carries the year it was given', () => {
      expect(render({ year: 2027 })).toContain('&#169; 2027 Ley Legal');
    });

    it('inlines the stylesheet, so the page needs no second round trip', () => {
      expect(render()).toContain(LANDING_CSS);
    });
  });
});
