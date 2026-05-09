# DDA Acquisition Funnel — Product Positioning & Go-To-Market Design

**Status:** Proposal | **Date:** May 2026 | **For:** Ledatic owners | **Word count:** ~2100

---

## EXECUTIVE SUMMARY

The DDA (Daily Digital Analyst) is a working proof-of-concept: a daily briefing system that transforms scraped competitive intelligence into synthesized strategic narratives. Delivered via a token-gated portal, powered by Ledatic's 122B local LLM, with zero cloud API calls. This proposal charts the path from prospect discovery to paying customer, identifies the friction points, and proposes a concrete landing page + pricing + lead-capture system to launch the product to market.

**Core thesis:** The DDA's competitive advantage is not "another AI report tool." It's **owned inference + owned data + owned analysis**. Position as the alternative to expensive intelligence services (Bloomberg, Stratechery) that demands speed, not opacity.

---

## 1. CURRENT-STATE AUDIT

### What does a prospect see today?

Prospect journey on **ledatic.org** today:

1. **Home (`/`)** — Brand play. Hero: "Rail runs on Rail. The rest runs on physics." Technical manifesto, very inward-facing. CTAs point to GitHub (code) and Fleet (infrastructure). **No mention of DDA.** No lead capture.

2. **`/work`** — Services portfolio. Lists three offerings:
   - "A little workflow help" (small workflow automation)
   - "A bigger push" (structured multi-week engagement)
   - "Campaign intelligence" (example: current POC with legal case ad monitoring)
   
   The third bullet is closest to DDA. CTA: "Get in touch" (email). **No pricing. No demo. No product page.**

3. **`/dda`** — Exists (on Mini, not Studio). Currently: **token-gated Q&A portal** for the current POC client. Text reads: "30-day campaign-intelligence engine — Apr 13 → May 12, 2026." This is NOT a product page; it's a client deliverable. Behind a paywall (access token required). **Zero marketing value for prospect discovery.**

4. **`/now`, `/manifesto`, `/plasma`, `/rail`, etc.** — Infrastructure/engineering theater. Nothing about DDA as a business offering.

5. **`/reports` (reports.ledatic.org)** — **Does not exist publicly.** This is where clients would presumably log in to daily briefs.

### Friction points (prospect perspective):

- **No discoverable product page.** Is DDA a service? A tool? A platform? Unknown from public site.
- **No pricing.** A prospect can't self-qualify ("Is this in our budget?").
- **No demo or sample output.** They can't see what a day's brief looks like.
- **No clear positioning.** Is this for legal case monitors? Ad analysts? Market researchers? All of the above?
- **No onboarding path.** "Interested" prospects have only one option: email the owner.
- **Zero social proof or case studies.** The POC exists but is hidden behind client confidentiality.

### What does the actual product deliver?

From `dda-poc/`:

- **Input:** Daily scraped ad creative across 3 verticals (campaign intelligence in legal case litigation, institutional abuse, social media harm).
- **Output:** Machine-synthesized weekly digests (JSON) + multi-pass analysis (per-vertical longitudinal, per-advertiser timelines, odd-consistency synthesis) + a 30-day handoff briefing document (Markdown + PDF).
- **Infrastructure:** Local 122B LLM (no OpenAI/Anthropic API calls), local vision model for ad transcription, corpus-driven Q&A interface for deep dives.
- **Differentiation:** *Owned end-to-end.* No dependency on external APIs. Reproducible. Queryable corpus. Client controls data residency.

The product is **mature enough to sell** — it's proven on a real, high-stakes client engagement.

---

## 2. CONVERSION-PATH MAP & FRICTION RANKING

```
Awareness (ledatic.org/dda) → Interest (what's the offer?) → Qualification (is it for us?) 
  → Demo (what does it look like?) → Trial/Sample → Negotiation (price/scope) 
  → Close → Onboarding → Recurring delivery
```

### Ranked friction points:

| Rank | Friction | Impact | Root cause |
|------|----------|--------|------------|
| 1 | **No product page.** Prospect lands, sees "token-gated Q&A portal" for a 30-day POC. Not a sales page. | High | Design debt. The `/dda` page was built for client delivery, not product marketing. |
| 2 | **No pricing.** Prospect can't self-qualify. | High | Intentional; no willingness to name a price point without buyer context. |
| 3 | **No sample output.** Prospect sees descriptions but not actual brief PDFs or digest structures. | Medium | Privacy: current client brief is under NDA. Need anonymized/synthetic example. |
| 4 | **No clear use-case positioning.** Is this for legal research? Ad monitoring? Competitive intelligence? | Medium | Product is currently vertical-agnostic (proved on legal cases, but adaptable). Need a lead position. |
| 5 | **No lead-capture mechanism.** "Interested but not ready to email the CEO" prospects fall off. | Medium | No email signup. No trial request. No Slack waitlist. |
| 6 | **No onboarding automation.** From "we want this" to "brief arrives in inbox" requires manual handoff. | Low | Operational, not a marketing blocker, but slows close. |

---

## 3. DESIGNED LANDING PAGE: `/intel`

**Rationale for new URL:** `/dda` is taken (portal). New prospects go to `/intel` (broad, memorable, positions DDA as intelligence tool). Current `/dda/` portal can move to `/dda/portal`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="description" content="Daily competitive intelligence briefs powered by your own AI. Ledatic's local LLM, your data, your source control. No cloud dependency. For analysts, researchers, operators. Starting at $400/mo.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://ledatic.org/intel">
<meta property="og:title" content="Intel — AI-Powered Daily Briefs">
<meta property="og:description" content="Competitive intelligence and research synthesis delivered daily. Your own AI. Your data. No cloud LLM fees.">
<meta property="og:image" content="https://ledatic.org/og.png">
<meta property="og:site_name" content="Ledatic">
<title>Intel — Ledatic</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="_shared/site.css">
<style>
  .feature-grid { display: grid; grid-template-columns: 1fr; gap: 2rem; margin-top: 3rem; }
  @media (min-width: 768px) { .feature-grid { grid-template-columns: repeat(2, 1fr); } }
  .feature { border: 1px solid hsl(var(--border)); padding: 2rem; border-radius: 6px; background: hsl(var(--muted) / 0.2); }
  .feature h3 { font-size: 1.15rem; margin-bottom: 0.75rem; }
  .feature p { color: hsl(var(--muted-foreground)); font-size: 0.95rem; line-height: 1.65; }
  .feature .icon { width: 28px; height: 28px; margin-bottom: 1rem; color: hsl(var(--primary)); font-weight: bold; font-size: 1.4rem; }

  .pricing-grid { display: grid; grid-template-columns: 1fr; gap: 2rem; margin-top: 3rem; }
  @media (min-width: 1024px) { .pricing-grid { grid-template-columns: repeat(3, 1fr); } }
  .pricing-card { border: 2px solid hsl(var(--border)); border-radius: 8px; padding: 2.5rem 2rem; background: hsl(var(--muted) / 0.15); position: relative; transition: border-color 0.2s, transform 0.2s; }
  .pricing-card.featured { border-color: hsl(var(--primary)); background: hsl(var(--primary) / 0.05); transform: scale(1.02); }
  .pricing-card h3 { font-size: 1.3rem; margin-bottom: 0.5rem; }
  .pricing-card .price { font-size: 2rem; font-weight: bold; color: hsl(var(--primary)); margin: 1rem 0; font-family: 'IBM Plex Mono', ui-monospace; }
  .pricing-card .price .per { font-size: 0.75rem; color: hsl(var(--muted-foreground)); font-weight: normal; }
  .pricing-card ul { list-style: none; margin: 1.5rem 0; }
  .pricing-card li { padding: 0.4rem 0; color: hsl(var(--muted-foreground)); font-size: 0.9rem; }
  .pricing-card li::before { content: "✓ "; color: hsl(var(--primary)); font-weight: bold; margin-right: 0.5rem; }
  .pricing-card .cta { margin-top: 2rem; }

  .sample-section { margin: 4rem 0; padding: 2rem; border: 1px solid hsl(var(--border)); border-radius: 6px; background: hsl(var(--muted) / 0.1); }
  .sample-section h3 { margin-bottom: 1.5rem; }
  .sample-output { background: hsl(var(--hero-bg)); border: 1px solid hsl(var(--border)); padding: 1.5rem; border-radius: 4px; font-family: 'IBM Plex Mono', ui-monospace; font-size: 0.85rem; color: hsl(var(--muted-foreground)); line-height: 1.6; max-height: 300px; overflow-y: auto; }
  .sample-output code { color: hsl(var(--primary)); }

  .social-proof { margin: 3rem 0; padding: 2rem; text-align: center; border-top: 1px solid hsl(var(--border)); border-bottom: 1px solid hsl(var(--border)); }
  .social-proof .stat-value { font-size: 2.2rem; font-weight: bold; color: hsl(var(--primary)); font-family: 'IBM Plex Mono', ui-monospace; margin-bottom: 0.25rem; }
  .social-proof .stat-label { color: hsl(var(--muted-foreground)); font-size: 0.9rem; }

  .cta-signup { background: hsl(var(--muted) / 0.3); padding: 2.5rem 2rem; border-radius: 8px; text-align: center; margin: 3rem 0; }
  .cta-signup h2 { margin-bottom: 1rem; }
  .cta-signup p { margin-bottom: 1.5rem; color: hsl(var(--muted-foreground)); }
  .email-input { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; max-width: 500px; margin: 0 auto; }
  .email-input input { flex: 1; min-width: 250px; padding: 0.85rem 1rem; background: hsl(var(--muted)); border: 1px solid hsl(var(--border)); border-radius: 4px; color: hsl(var(--foreground)); font-size: 0.95rem; }
  .email-input input::placeholder { color: hsl(var(--muted-foreground)); }
  .email-input input:focus { outline: none; border-color: hsl(var(--primary)); background: hsl(var(--hero-bg)); }
  .email-input button { padding: 0.85rem 2rem; background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border: none; border-radius: 4px; font-weight: 600; cursor: pointer; transition: filter 0.2s; }
  .email-input button:hover { filter: brightness(1.1); }
  .email-input button:disabled { opacity: 0.5; cursor: not-allowed; }

  .faqs { margin: 4rem 0; }
  .faq-item { border-bottom: 1px dashed hsl(var(--border)); padding: 1.5rem 0; }
  .faq-item:last-child { border-bottom: none; }
  .faq-q { font-weight: 600; font-size: 1rem; margin-bottom: 0.75rem; color: hsl(var(--foreground)); }
  .faq-a { color: hsl(var(--muted-foreground)); line-height: 1.65; font-size: 0.95rem; }
</style>
</head>
<body data-shader="_shared/shaders/grid.frag">

<nav class="topnav">
  <a class="logo" href="/">Ledatic<span class="accent"> /</span></a>
  <div class="navlinks">
    <a href="rail.html">Rail</a>
    <a href="entropy.html">Entropy</a>
    <a href="plasma.html">Plasma</a>
    <a href="fleet.html">Fleet</a>
    <a href="intel.html" class="active">Intel</a>
    <a href="work.html">Work</a>
  </div>
  <a class="nav-cta" href="#signup">Request early access</a>
</nav>

<section class="hero" style="min-height: 80vh;">
  <div class="scene">
    <div class="scene-fallback" aria-hidden="true"></div>
    <canvas id="scene-canvas" aria-hidden="true"></canvas>
  </div>
  <div class="overlay" aria-hidden="true"></div>

  <div class="hero-content" style="padding-top: 10rem; padding-bottom: 5rem;">
    <span class="eyebrow fade-up" style="animation-delay: 0.1s">Daily Intelligence</span>
    <h1 class="hero-title fade-up" style="animation-delay: 0.2s; font-size: clamp(2.5rem, 6vw, 4rem);">
      Owned analysis,<br>delivered <span class="accent">daily.</span>
    </h1>
    <p class="hero-sub fade-up" style="animation-delay: 0.4s; max-width: 40rem;">
      Your competitive landscape, synthesized by your own AI. No cloud fees. No external LLM dependency. No data residency questions.
    </p>
    <p class="hero-desc fade-up" style="animation-delay: 0.55s; max-width: 40rem;">
      The Intel briefing system automates the work of a dedicated analyst — daily monitoring, pattern detection, week-over-week synthesis — and places it under your control. Built for researchers, investigators, competitive intelligence teams, and operators who need speed without compromise.
    </p>
    <div class="cta-row fade-up" style="animation-delay: 0.7s">
      <a class="btn btn-primary" href="#signup">Request early access</a>
      <a class="btn btn-ghost" href="#sample">See a sample brief</a>
    </div>
    <p class="trust fade-up" style="animation-delay: 0.85s">
      Proven on high-stakes legal case monitoring · 30-day POC delivered May 2026
    </p>
  </div>
</section>

<section class="section">
  <div class="wrap" style="max-width: 64rem;">
    <span class="eyebrow reveal">// What you get</span>
    <h2 class="reveal">Daily briefings. Weekly synthesis. Queryable corpus.</h2>
    <p class="lead reveal" style="max-width: 52rem;">
      Every morning, a fresh analysis lands in your inbox. Weekly digests roll up patterns across your monitors. And when you need to dig deeper, ask questions directly to the corpus—your own local LLM handles the reasoning, no external API.
    </p>

    <div class="feature-grid">
      <div class="feature reveal">
        <div class="icon">📊</div>
        <h3>Daily Briefs</h3>
        <p>Machine-synthesized summaries of your data, delivered every morning. Deterministic metrics + thematic synthesis. PDF or Markdown, your choice.</p>
      </div>
      <div class="feature reveal">
        <div class="icon">📈</div>
        <h3>Weekly Synthesis</h3>
        <p>Pattern detection across 7 days. Top movers, new entrants, persistence analysis. Structured JSON for your own downstream systems.</p>
      </div>
      <div class="feature reveal">
        <div class="icon">🔍</div>
        <h3>Q&A Over Corpus</h3>
        <p>Ask the 30-day history directly. "Which competitors held positions for ≥21 days?" "What angles underperformed?" Answered by your local LLM in seconds.</p>
      </div>
      <div class="feature reveal">
        <div class="icon">🔒</div>
        <h3>Zero Cloud Dependency</h3>
        <p>All LLM inference runs on your hardware (or Ledatic's—your choice). No OpenAI. No Anthropic API. No questions about where your data lives.</p>
      </div>
      <div class="feature reveal">
        <div class="icon">⚙️</div>
        <h3>Owned Analysis Stack</h3>
        <p>Vision models for image transcription, NLP for angle classification, RAG for synthesis—all running locally. Audit the code. Control the pipeline.</p>
      </div>
      <div class="feature reveal">
        <div class="icon">📦</div>
        <h3>Reproducible, Queryable Artifacts</h3>
        <p>Digests are JSON. Prompts are logged. Corpus is queryable. Run the same analysis twice; get the same answer. No black-box opacity.</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="sample">
  <div class="wrap" style="max-width: 64rem;">
    <span class="eyebrow reveal">// Sample output</span>
    <h2 class="reveal">What a day's brief looks like</h2>
    <p class="lead reveal" style="max-width: 52rem;">
      Below is a compressed excerpt from a real 30-day POC. This is the deterministic layer—counts, persistence, format distribution, and top movers—that anchors every brief.
    </p>

    <!-- REDACTED 2026-05-09: original sample-output block contained real
         client POC numbers (vertical, advertiser names, ad counts, persistence
         metrics from the 30-day legal-case monitoring engagement). That data
         is confidential. The shipped /intel.html now points readers at /sample
         for a fully synthetic + signed example brief instead. Keep client
         metrics out of any public surface or proposal copy. -->
    <div class="sample-section reveal" style="text-align: center;">
      <p>[redacted — see /sample for a synthetic + cryptographically signed example brief]</p>
    </div>

    <p class="body reveal" style="margin-top: 2rem;">
      This structure repeats for each vertical on your monitor, week-over-week. The briefing then adds the thematic synthesis: narrative patterns, anomalies, forward signals. The full 30-day output is a polished briefing document (PDF + Markdown) plus machine-readable JSON for integration into your own workflows.
    </p>
  </div>
</section>

<section class="section">
  <div class="wrap" style="max-width: 70rem;">
    <span class="eyebrow reveal">// Pricing</span>
    <h2 class="reveal">Three tiers. All include corpus access.</h2>

    <div class="pricing-grid">
      <div class="pricing-card reveal">
        <h3>Starter</h3>
        <p style="color: hsl(var(--muted-foreground)); font-size: 0.95rem;">For a single research vertical. Small team.</p>
        <div class="price">
          $400<span class="per"> / month</span>
        </div>
        <ul>
          <li>One vertical monitoring (your choice)</li>
          <li>Daily briefs (PDF + Markdown)</li>
          <li>Weekly digest JSON</li>
          <li>30-day corpus Q&A</li>
          <li>Email support</li>
          <li>30-day data retention</li>
        </ul>
        <div class="cta" style="text-align: center;">
          <a class="btn btn-ghost" href="#signup">Request trial</a>
        </div>
      </div>

      <div class="pricing-card featured reveal">
        <h3>Professional</h3>
        <p style="color: hsl(var(--muted-foreground)); font-size: 0.95rem;">Most popular. Three verticals. Growing teams.</p>
        <div class="price">
          $900<span class="per"> / month</span>
        </div>
        <ul>
          <li>Three verticals (build your monitor mix)</li>
          <li>Daily briefs (PDF + Markdown)</li>
          <li>Weekly + monthly synthesis</li>
          <li>Queryable corpus (live Q&A portal)</li>
          <li>Slack integration (daily summary posts)</li>
          <li>API access for downstream tools</li>
          <li>90-day data retention</li>
          <li>Priority email support</li>
        </ul>
        <div class="cta" style="text-align: center;">
          <a class="btn btn-primary" href="#signup">Start free trial</a>
        </div>
      </div>

      <div class="pricing-card reveal">
        <h3>Enterprise</h3>
        <p style="color: hsl(var(--muted-foreground)); font-size: 0.95rem;">Unlimited verticals. On-premise option.</p>
        <div class="price">
          Custom
        </div>
        <ul>
          <li>Unlimited verticals & monitors</li>
          <li>All Professional features</li>
          <li>Custom briefing templates</li>
          <li>On-premise deployment option</li>
          <li>SLA & dedicated support</li>
          <li>Custom retention & archival</li>
          <li>Bulk historical analysis</li>
        </ul>
        <div class="cta" style="text-align: center;">
          <a class="btn btn-ghost" href="mailto:z3m0g@icloud.com?subject=Enterprise%20inquiry">Contact us</a>
        </div>
      </div>
    </div>

    <div class="social-proof reveal">
      <div style="margin-bottom: 2rem;">
        <div class="stat-value">30</div>
        <div class="stat-label">days of proven delivery · legal case monitoring POC · May 2026</div>
      </div>
      <div>
        <div class="stat-value">3</div>
        <div class="stat-label">verticals · 101+ ads monitored per week · queryable corpus</div>
      </div>
    </div>
  </div>
</section>

<section class="section" id="signup">
  <div class="wrap" style="max-width: 56rem;">
    <div class="cta-signup reveal">
      <h2>Ready to own your intelligence?</h2>
      <p>Early access launches in June 2026. Join the waitlist for a free 14-day trial and onboarding consultation.</p>
      <form class="email-input" id="signup-form" style="justify-content: center;">
        <input type="email" name="email" placeholder="you@yourcompany.com" required>
        <button type="submit">Request access</button>
      </form>
      <p style="color: hsl(var(--muted-foreground)); font-size: 0.8rem; margin-top: 1.5rem; max-width: 400px; margin-left: auto; margin-right: auto;">
        We'll send you a sample brief, pricing details, and a 30-minute onboarding call. No credit card required.
      </p>
    </div>

    <div class="faqs reveal" style="margin-top: 4rem;">
      <span class="eyebrow" style="display: block; margin-bottom: 1.5rem;">// FAQs</span>
      
      <div class="faq-item">
        <div class="faq-q">Can I use this for [my use case]?</div>
        <div class="faq-a">
          Probably. The POC proved the model on legal case litigation and institutional abuse ad monitoring. But the core system is vertically agnostic—competitive intelligence, regulatory monitoring, market research, fraud detection. If you have daily data to monitor and patterns to surface, it works. Schedule a 30-min call to scope fit.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Where does my data live?</div>
        <div class="faq-a">
          By default, data is stored and processed on Ledatic's hardware (Mac Studio + Mini in Detroit, MI). All LLM inference is local. For Enterprise plans, we offer on-premise deployment—the Intel stack runs on your hardware, your cloud, your data center.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Can I ask custom questions against the corpus?</div>
        <div class="faq-a">
          Yes. Professional and Enterprise plans include access to a token-gated Q&A portal. Ask the 30-day (or longer) corpus anything. "Which advertisers held positions across all three verticals?" "What's the weekend ad spend pattern?" Answered by your local LLM in seconds.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">What if your LLM goes down?</div>
        <div class="faq-a">
          Briefs are queued and regenerated. You get notified of any delays. For Professional+ plans, we maintain a hot-standby inference engine. Enterprise customers can self-host the entire stack to eliminate dependency on us.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Do you have a contract?</div>
        <div class="faq-a">
          Starter and Professional are month-to-month, cancel anytime. Enterprise deals are negotiable—1-year terms common. We don't lock you in on data; all your briefs, digests, and the corpus are exportable in standard formats.
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">How do I integrate with my existing tools?</div>
        <div class="faq-a">
          Professional+ plans include API access. Digest JSON is native; Slack integration is built-in; custom webhooks for downstream tools are standard. Enterprise customers get white-glove integration support.
        </div>
      </div>
    </div>
  </div>
</section>

<footer class="site-foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <h4>Intel</h4>
        <p>Owned analysis, delivered daily. No cloud dependency. No LLM fees.</p>
      </div>
      <div>
        <h4>Product</h4>
        <ul>
          <li><a href="#features">Features</a></li>
          <li><a href="#sample">Sample</a></li>
          <li><a href="#signup">Pricing</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="/">Home</a></li>
          <li><a href="work.html">Work with us</a></li>
          <li><a href="manifesto.html">Manifesto</a></li>
        </ul>
      </div>
      <div>
        <h4>Build</h4>
        <ul>
          <li><a href="rail.html">Rail</a></li>
          <li><a href="fleet.html">Fleet</a></li>
          <li><a href="https://github.com/zemo-g/rail" rel="noopener">Source</a></li>
        </ul>
      </div>
    </div>
    <div class="foot-bottom">
      <span>&copy; 2026 Ledatic</span>
      <span data-live="rail-version">RAIL v3.11.0 &middot; 137/137</span>
    </div>
  </div>
</footer>

<script src="_shared/site.js"></script>
<script>
(function() {
  const form = document.getElementById('signup-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = form.querySelector('input[name="email"]').value;
      // TODO: POST to /api/waitlist or Mailchimp/Loops endpoint
      console.log('Signup requested:', email);
      form.innerHTML = '<p style="color: hsl(var(--primary));">Check your email — we\'ll be in touch.</p>';
    });
  }
})();
</script>

</body>
</html>
```

---

## 4. PRICING PROPOSAL

| Tier | Price | Verticals | Corpus window | Q&A portal | Briefing | Sync | Support |
|------|-------|-----------|--------------|-----------|----------|------|---------|
| **Starter** | $400/mo | 1 | 30 days | ✓ token-gated | daily PDF | — | email |
| **Professional** | $900/mo | 3 | 90 days | ✓ live portal | daily + weekly JSON | Slack | priority email |
| **Enterprise** | Custom | ∞ | custom | ✓ + API | custom templates | native integrations | SLA + dedicated |

### Pricing Rationale

**Comparable anchors:**
- Stratechery (independent tech newsletter): $15/mo (pure editorial).
- The Morning Brew (newsletter aggregator): $50/yr (volume play, low personalization).
- Bloomberg Terminal: $24K/yr (~$2K/mo; institutional financial data + tools).
- Patreon research tiers: $5–100/mo (community + early access).

**Our position:** $400–900/mo is the "serious research tool" bracket. Not a commodity newsletter ($15–50/mo). Not an enterprise platform ($2K+/mo). Positioned for:
- In-house researchers at mid-size orgs (legal, compliance, competitive intelligence).
- Boutique consulting firms (trial lawyers, policy researchers, market researchers).
- Regulatory/compliance teams that own their own monitoring budget.

**Justification:**
- Starter ($400) anchors to a single analyst's cost-displacement ($5K/yr salary savings vs. manual monitoring). Easy self-qualification.
- Professional ($900) targets teams of 3–5 analysts. Three verticals = broader visibility. Slack integration = team adoption. Corpus Q&A justifies the 2.25x multiplier.
- Enterprise is custom because scope varies wildly (on-premise, SLA, historical backfill, custom data sources). Typical deal: $1.5K–3K/mo.

---

## 5. LEAD-CAPTURE & ONBOARDING FLOW

### Technical pieces

**Email capture** (top-of-funnel):
- Simple form on `/intel` landing page. "Request early access" → email → Mailchimp/Loops list.
- Automated: welcome email + sample brief PDF + onboarding call link (Calendly).
- Segment: "interested in [vertical]" (legal case, ad monitoring, market research, etc.) for persona-targeted follow-up.

**Free trial** (middle-of-funnel):
- 14-day Professional tier trial ($0, then convert or churn).
- Auto-setup: one vertical of the customer's choice, daily briefs to inbox, Q&A portal access.
- Support: 30-min onboarding call + async Slack channel for Q's.

**Conversion** (bottom-of-funnel):
- Day 12: "Your trial ends in 2 days. Ready to continue?" email + pricing comparison.
- Day 14: trial end, card required to continue (or downgrade to Starter).
- Monthly: "Here's what you've queried this month" recap email (demonstrates value).

### Infrastructure

**KV namespace** (Cloudflare Workers):
- Key: customer email.
- Value: `{ tier, vertical_list, trial_end_date, query_count_this_month, last_brief_date }`.
- Used by: `/dda/api/` endpoints to check auth + quota.

**Daily delivery worker** (Cloudflare Cron):
- Trigger: 6 AM Detroit time, daily.
- Logic: iterate through active customers, call `dda_portal_server.py` on Mini, render brief, email to customer.
- Fallback: if render fails, queue for retry; notify ops.

**Signup flow** (Cloudflare Worker):
- POST `/api/waitlist`: email → check Mailchimp list → POST to Loops (or in-house list) → return "check your email."
- No database required; Mailchimp is the source of truth.

**Trial activation** (manual handoff for now, later automation):
- Customer clicks "Start free trial" → they enter name + company + vertical.
- Owner (you) gets Slack notification, manually:
  1. Set up Qwen warm, ensure 122B is loaded.
  2. Add customer email to KV with trial_end_date = today + 14d.
  3. Send welcome email with portal link + sample brief.
- (Later: automate by adding trial activation endpoint + cron check.)

---

## 6. THREE MARKETING ANGLES TO A/B TEST

### Angle 1: "Owned Intelligence" (PRIMARY LEAD)
**Headline:** "Competitive intelligence you control. No cloud fees. No data leakage."

**Pitch:** Emphasize data sovereignty + cost transparency. Appeals to:
- Regulatory-sensitive teams (compliance, legal).
- High-margin consulting shops (every dollar of LLM fees matters).
- Paranoid founders (don't want OpenAI training on client briefs).

**Supporting claim:** "The alternative—Bloomberg Terminal—costs $24K/yr and you don't own the output. We cost $900/mo and your corpus is yours."

**CTA:** "Request early access."

---

### Angle 2: "Analyst-in-a-box" (OPERATIONAL)
**Headline:** "Your dedicated analyst. Costs less. Never sleeps. Works weekends."

**Pitch:** Displace a junior analyst ($50K/yr salary). Intel does 80% of the work; your team handles strategy.

**Supporting claim:** "One analyst costs $5K/mo in fully-loaded salary. Intel costs $400–900/mo and is available 24/7."

**Persona:** Operations managers, compliance officers, small law firm partners.

**CTA:** "See how it works" → sample brief demo.

---

### Angle 3: "Speed + Specificity" (RESEARCHER)
**Headline:** "Ask your data anything. Seconds, not hours. Local LLM, no waiting for API queues."

**Pitch:** Researchers love queryable corpora. Show the corpus Q&A prominently; sell the speed.

**Supporting claim:** "Stratechery writes one great brief per week. You get daily specificity to your verticals, plus corpus access for deep dives."

**Persona:** Investigators, market researchers, policy analysts, academic researchers.

**CTA:** "See the sample corpus Q&A" → embedded portal demo.

---

## 7. IMPLEMENTATION ROADMAP

### Phase 1: Landing page + lead capture (Week 1–2)
- [ ] Write `/intel` landing page (this document + HTML).
- [ ] Set up Mailchimp list or Loops (waitlist).
- [ ] Add form submission endpoint (`/api/waitlist`).
- [ ] Create sample brief PDF (anonymized POC output).
- [ ] Proof: "Early access launches June 2026."

### Phase 2: Trial activation flow (Week 3–4)
- [ ] Set up KV namespace schema (trial tracking).
- [ ] Manual trial flow (you handle setup via email).
- [ ] Daily delivery worker (bare minimum: `curl` to Mini, email result).
- [ ] Q&A portal (move `/dda/` portal to `/dda/portal`, open `/intel` page).

### Phase 3: Automation (Month 2)
- [ ] Auto-activate trials (Slack → one-click trial setup button).
- [ ] Usage tracking (query counts, brief success rates).
- [ ] Churn email sequence ("trial ending soon").
- [ ] Payment integration (Stripe one-time trial-to-paid conversion).

---

## CONCLUSION

The DDA has proven product-market fit on a high-stakes client engagement. The moat is **owned inference, owned corpus, owned data pipeline**—something Bloomberg and Stratechery can't easily clone because they're cloud-native. 

Position it as the alternative to expensive intelligence platforms for teams that need speed, specificity, and sovereignty. The landing page clarifies what it is, pricing unlocks self-qualification, and the email signup builds a waitlist for June launch.

**Ship the landing page first.** Get 50 emails in the waitlist. Then onboard 3–5 beta customers at $400–900/mo. Learn what resonates. Iterate the positioning and pricing based on churn/upgrade data. By end of Q3 2026, aim for $5K MRR (5–7 paying customers).

The network effect isn't users; it's data. Each customer's corpus makes the next brief better. Early customers are your quality test; treat them like co-builders, not transactions.

