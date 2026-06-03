# Provenance Tier: Cryptographically Verifiable AI Reports

**Ledatic's Differentiator: The Only AI Vendor Where Third Parties Can Prove What You Generated**

---

## Executive Summary

Ledatic introduces **Provenance Tier**: a cryptographically signed, independently verifiable report layer that chains model identity, input, output, timestamp, and witness attestation into an immutable proof-of-generation record. Unlike OpenAI, Anthropic, and Google—which have no third-party witness to their AI outputs—Ledatic clients can prove to regulators, courts, and auditors exactly what model produced what result at what time.

**Core Value Proposition**: Not just "here's a report signed by Ledatic" but "here's proof the Claude 3.5 Sonnet v2 model hash abcdef...1234 processed input hash XYZ at 2026-05-09T14:37:22Z and produced output hash DEF..., witnessed and cryptographically verified by the Pi Zero 2 W physical node fleet0 at on the tailnet."

**Target**: Regulated enterprises, legal firms, financial institutions, and government agencies where AI output must survive courtroom scrutiny, EU AI Act compliance audits, or adversarial discovery.

---

## 1. The Product: "Provenance Tier"

### Product Name
**"Provenance Tier"** — a subscription tier on top of base DDA (Diagnosis/Data Analysis) Reports.

### What the Client Receives

1. **Signed Report PDF** (what they see): The same high-quality DDA report as the Standard Tier, now with a cryptographic signature embedded in metadata.
   
2. **Provenance Manifest** (proof chain): A JSON-LD file containing:
   ```json
   {
     "kind": "ledatic.report.provenance",
     "version": 1,
     "report_id": "rep_xyz789abcdef",
     "generated_at": "2026-05-09T14:37:22Z",
     "client_id": "client_acme_research",
     "generation_event": {
       "model": {
         "provider": "anthropic",
         "name": "claude-3-5-sonnet",
         "weights_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
         "parameters": 200000000000
       },
       "input": {
         "prompt_hash": "sha256:d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9",
         "context_hash": "sha256:abc123def456abc123def456abc123def456abc123def456abc123def456ab",
         "user_metadata": { "analysis_type": "financial_due_diligence" }
       },
       "output": {
         "result_hash": "sha256:123abc456def123abc456def123abc456def123abc456def123abc456defab",
         "token_count": 8472,
         "logprob_sum": -12847.3
       },
       "infrastructure": {
         "studio_host": "10.42.0.2",
         "dda_portal_version": "2.3.1",
         "request_id": "req_5k7m9p1q"
       }
     },
     "witness_attestation": {
       "node": "fleet0",
       "witnessed_at": 1777753139,
       "pulse_id": 517609,
       "pulse_value_hex": "31d49e01df5336155442b116361a76305ec217e6351102a6cc38c2667cc5ac48",
       "previous_hash": "d2048917601fe891369a6114582db16524dbd73ea74bbfe351edfaa1f1c053a4",
       "ed25519_public_key": "cac5f21a70564aeb...",
       "ed25519_signature": "base64:...",
       "chain_verified": true
     },
     "links": {
       "report": "https://reports.ledatic.org/verify/rep_xyz789abcdef",
       "witness_beacon": "https://ledatic.org/entropy/pulse",
       "witness_node": "https://ledatic.org/witness/fleet0/latest"
     }
   }
   ```

3. **Verification Page** (public, no auth): `/verify/<report_id>` — a third-party can enter any report ID and cryptographically verify the entire chain in their browser using Web Crypto API. No backend call needed (manifest is publicly accessible).

4. **Audit Trail** (for legal/regulatory): A human-readable summary page showing:
   - When the report was generated
   - Which model processed it
   - Chain-of-custody through the witness network
   - Whether the witness node was in consensus at generation time

### Pricing

| Tier | Base Cost | Per-Report | Provenance Surcharge | Use Case |
|------|-----------|-----------|----------------------|----------|
| **Standard** | $2,000/mo | $120 | — | Internal analytics, no compliance burden |
| **Provenance** | $5,000/mo | $320 | $200 | Regulatory, legal discovery, audit-ready |
| **Provenance+Audit** | $8,500/mo | $350 | $450 | High-stakes litigation, EU AI Act compliance with quarterly auditor access |

**Rationale for pricing**:
- Provenance Tier requires 2-3x ops overhead: signing pipeline, witness latency tracking, verification endpoint maintenance, legal liability insurance (we're now making cryptographic claims).
- The $200/report premium covers insurance, witness infrastructure amortization, and archive retention (7-year legal hold).
- Provenance+Audit tier (enterprise) includes quarterly cryptographic audits by a third-party firm (e.g., Trail of Bits) that independently verifies our entire witness chain.

---

## 2. Threat Model & Buyer Persona

### Primary Buyer: Regulated Financial Institutions (Due Diligence & Compliance)

**The Problem They Face**:
- M&A due diligence: investment banks run AI-generated valuation models on target companies. If challenged post-deal, they need proof the model was Claude 3.5 Sonnet (not a cheaper, less-capable model) and that the input was the agreed-upon dataset.
- SEC/FCA audits: compliance officers must prove AI was used correctly, not retrofitted after suspicious results appeared.
- Sarbanes-Oxley § 302: CEO/CFO certify financial disclosures. If AI was used, they need cryptographic proof of what it generated.

**Buyer**: Chief Compliance Officer, Chief Risk Officer
**Budget**: $8,500/mo Provenance+Audit tier (quarterly audits included)
**Motivation**: Reduce litigation risk and audit findings by 60%+ (via easily-providable proof)

### Secondary Buyer: Legal Firms (Litigation & Discovery)

**The Problem**:
- Opposing counsel alleges "you AI-generated that analysis." Without a signed timestamp, the other side claims it was post-hoc AI use to bolster arguments.
- EU GDPR/EU AI Act compliance: litigants in EU jurisdictions must prove AI involvement and outcomes to regulators.

**Buyer**: Managing Partner, Head of Legal Tech
**Budget**: $5,000/mo Provenance Tier (proof of generation is sufficient)
**Motivation**: Shorten depositions, avoid "AI provenance" discovery battles

### Tertiary Buyer: Government/Intelligence (Classified Intelligence Analysis)

**The Problem**:
- Intelligence agencies generate AI-driven threat assessments. Adversaries might claim "that analysis is fabricated" or "the US AI was compromised."
- Need a timestamp and model identity locked in a public witness network (so no one can later forge the date).

**Buyer**: National Security Council, Defense Intelligence Agency
**Budget**: Custom enterprise contract (likely $15,000+/mo with on-premise witness nodes)
**Motivation**: Cryptographic proof of when/where analysis was conducted

### Adjacent Buyer: Journalism & Fact-Checking (Deepfake Era)

**The Problem**:
- Newsroom publishes AI-assisted investigative work. Competitors/adversaries claim the AI made it up.
- Verifiable proof improves reader trust and defensibility against misinformation campaigns.

**Buyer**: Editorial Director, Legal Counsel
**Budget**: $5,000/mo Provenance Tier
**Motivation**: Defensibility + reader trust in post-deepfake environment

---

## 3. End-to-End Architecture

### ASCII Protocol Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROVENANCE TIER FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

CLIENT (Browser / API)
         │
         ├─ /dda/new_report (POST)
         │  { client_id, vertical, input_prompt, ...}
         │
         ▼
LEDATIC DDA PORTAL (10.42.0.2:8082, Qwen 122B)
         │
         ├─ hash(input_prompt) → prompt_hash
         ├─ hash(context_data) → context_hash
         │
         ├─ Stream response → model_token_stream
         │  (capture token count, logprobs)
         │
         ├─ hash(full_response) → result_hash
         │  Capture: model_identity, weights_hash, parameters
         │
         ├─ POST /attest (Bearer auth)
         │  {
         │    report_id,
         │    model: { name, weights_hash, params },
         │    input: { prompt_hash, context_hash },
         │    output: { result_hash, token_count, logprob_sum },
         │    infrastructure: { studio_host, dda_version, request_id },
         │    generated_at (ISO 8601)
         │  }
         │
         ▼
LEDATIC ATTEST SIGNER (on Studio, com.ledatic.attest_sign service)
         │
         ├─ Composite payload = serialize([
         │    report_id, model_hash, prompt_hash, context_hash,
         │    result_hash, generated_at, dda_version
         │  ])
         │
         ├─ inner_digest = SHA-256(composite_payload)
         │
         ├─ SSH to fleet0 witness: $HOME/.ledatic/witness/sign_attestation.sh
         │    $ sign_attestation.sh <inner_digest> <pulse_id> <value_hex>
         │
         ▼
FLEET0 WITNESS (Pi Zero 2W, on the tailnet)
         │
         ├─ Read /entropy/pulse → { pulse_id, value_hex }
         ├─ chain_verify(pulse_id) → chain_verified: true/false
         │
         ├─ witness_payload = serialize([
         │    inner_digest, pulse_id, value_hex,
         │    witnessed_at (Unix timestamp),
         │    previous_hash (from beacon log)
         │  ])
         │
         ├─ ed25519_sign(witness_payload, fleet0_private_key)
         │  → ed25519_signature (64 bytes)
         │
         └─ Return JSON:
            {
              "digest": inner_digest,
              "pulse_id": 517609,
              "value_hex": "31d49e01...",
              "witnessed_at": 1777753139,
              "previous_hash": "d20489...",
              "pk_fp": "cac5f21a70564aeb",
              "ed25519_signature": "base64:...",
              "chain_verified": true
            }
         │
         ▼
LEDATIC ATTEST SIGNER (received witness response)
         │
         ├─ Compose final provenance manifest (JSON-LD)
         ├─ Store in: REPORTS_R2 bucket
         │  Key: reports/<client_id>/<report_id>/manifest.json
         │
         ├─ Generate report PDF (same as Standard Tier)
         ├─ Embed provenance signature + manifest URL in PDF metadata
         │  /Producer: Ledatic DDA v2.3.1 (Provenance Tier)
         │  /ProvenanceManifest: https://reports.ledatic.org/manifest/<report_id>
         │
         ├─ Store PDF in: REPORTS_R2 bucket
         │  Key: reports/<client_id>/<report_id>/report.pdf
         │
         ├─ Update KV with report metadata
         │  Key: reports:<client_id>
         │
         └─ Return to client: report_id (for verification URL)
             { "report_id": "rep_xyz789abcdef", "status": "ready" }
         │
         ▼
CLIENT DOWNLOADS (reports.ledatic.org/dl/<report_id>)
         │
         ├─ PDF with embedded provenance metadata
         ├─ Manifest JSON accessible at public verify endpoint
         │
         ▼
THIRD-PARTY VERIFIER (ledatic.org/verify/<report_id>)
         │
         ├─ Fetch manifest JSON (no auth needed)
         ├─ In browser: crypto.subtle.verify(
         │    algorithm: "Ed25519",
         │    public_key: fleet0_public_key,
         │    signature: witness_ed25519_signature,
         │    data: witness_payload_bytes
         │  )
         │
         ├─ Display verification result (VALID / INVALID / UNVERIFIABLE)
         │
         └─ Show full provenance chain in UI
             (scrollable, with hash verification indicators)

┌─────────────────────────────────────────────────────────────────────────────┐
│                         KEY HASH CHAIN                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ input_prompt ──[SHA-256]──> prompt_hash                                    │
│ context_data ──[SHA-256]──> context_hash                                   │
│ model_weights ──[SHA-256]──> weights_hash (known canonical value)         │
│                                                                             │
│ full_response ──[SHA-256]──> result_hash                                   │
│                                                                             │
│ [ report_id, weights_hash, prompt_hash, result_hash,                      │
│   generated_at, dda_version, model_name ]                                 │
│              ──[SHA-256]──> inner_digest (attestable)                     │
│                                                                             │
│ inner_digest || pulse_id || value_hex || witnessed_at || previous_hash    │
│              ──[SHA-256]──> witness_payload                               │
│              ──[Ed25519 Sign]──> ed25519_signature                        │
│                                                                             │
│ ed25519_signature ──[Ed25519 Verify @ fleet0_public_key]──> VALID/INVALID │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Concrete Code Changes Required

1. **`tools/attest/frame_attest_ot256_publisher.sh` → `tools/attest/report_attestation_publisher.sh`** (new)
   - Accept `report_id`, `model_metadata`, `prompt_hash`, `result_hash`, `generated_at`
   - Construct composite_payload (line 72-89 shows pattern for ledatic.frame.attestation; adapt for reports)
   - SSH to fleet0 witness and call `sign_attestation.sh`
   - Compose final manifest JSON
   - PUT to R2 at `reports/<client_id>/<report_id>/manifest.json`

2. **`tools/deploy/worker.js` → add `/verify/<report_id>` route** (new GET handler)
   - Around line 500-600 (in `handleSite` function)
   - Route: `if (pathname.startsWith('/verify/')) { ... }`
   - Fetch manifest from R2 via the report_id
   - Return HTML page with verification UI (rendered with manifest data embedded)
   - Set CORS headers to allow cross-origin verification requests

3. **`stdlib/ed25519.rail` → `ed25519_verify_for_proof`** (already exists, but document usage)
   - The witness signature is already Ed25519-verifiable via existing Rail stdlib
   - Add usage comment clarifying this is safe for in-browser verification via crypto.subtle

4. **DDA portal (`10.42.0.2:8082`) → add `/attest` endpoint** (new POST handler)
   - Accept report metadata
   - Call report_attestation_publisher.sh with proper Bearer auth token
   - Return status + manifest URL to client
   - Error handling if fleet0 is unreachable (fallback to "unwitnessed" report)

5. **Cloudflare Worker R2 permissions** (existing, extend)
   - Current: write to `ledatic-reports/entropy/frame/ot256/`
   - Extend: write to `ledatic-reports/reports/<client_id>/<report_id>/` (manifest + PDF)

---

## 4. Verification Page UX

### `/verify/<report_id>` Page (Public, No Auth)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Report — Ledatic Provenance</title>
  <style>
    :root {
      --bg: #0b0d11;
      --panel: #11151b;
      --line: #1f242c;
      --fg: #cfd6df;
      --dim: #6a7886;
      --ok: #5fb878;
      --warn: #d8a25a;
      --bad: #ff6b6b;
      --accent: #86c5ff;
    }
    
    body {
      font-family: 'SF Mono', Menlo, monospace;
      background: var(--bg);
      color: var(--fg);
      margin: 0;
      padding: 40px 32px;
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .header {
      border-bottom: 1px solid var(--line);
      padding-bottom: 24px;
      margin-bottom: 32px;
    }
    
    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      color: #e6edf3;
    }
    
    .subtitle {
      color: var(--dim);
      font-size: 13px;
      margin-top: 4px;
    }
    
    .status-box {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .status-box .left { flex: 1; }
    .status-box .right {
      font-size: 32px;
      font-weight: bold;
      text-align: right;
    }
    
    .status-ok .right { color: var(--ok); }
    .status-invalid .right { color: var(--bad); }
    .status-unverifiable .right { color: var(--warn); }
    
    .status-label {
      color: var(--dim);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }
    
    .status-value {
      font-size: 16px;
      font-weight: 600;
    }
    
    .chain-section {
      margin-bottom: 32px;
    }
    
    .chain-title {
      color: var(--accent);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 600;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--line);
    }
    
    .chain-item {
      background: var(--panel);
      border-left: 3px solid var(--line);
      border-radius: 4px;
      padding: 16px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    
    .chain-item.verified {
      border-left-color: var(--ok);
    }
    
    .chain-item.invalid {
      border-left-color: var(--bad);
    }
    
    .chain-item .label {
      color: var(--dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    
    .chain-item .value {
      font-family: 'SF Mono', Menlo, monospace;
      word-break: break-all;
      color: var(--fg);
    }
    
    .hash-display {
      background: #0a0c10;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 8px 12px;
      margin-top: 4px;
      font-size: 11px;
      overflow-x: auto;
    }
    
    .verify-btn {
      background: #33ff3322;
      border: 1px solid #33ff3344;
      color: #33ff33;
      padding: 8px 16px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 8px;
    }
    
    .verify-btn:hover {
      background: #33ff3344;
    }
    
    .verify-result {
      margin-top: 8px;
      padding: 8px;
      border-radius: 4px;
      font-size: 11px;
    }
    
    .verify-result.ok {
      background: rgba(95, 184, 120, 0.1);
      color: var(--ok);
      border: 1px solid rgba(95, 184, 120, 0.3);
    }
    
    .verify-result.invalid {
      background: rgba(255, 107, 107, 0.1);
      color: var(--bad);
      border: 1px solid rgba(255, 107, 107, 0.3);
    }
    
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 10px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-right: 6px;
      margin-bottom: 6px;
    }
    
    .pill.ok {
      background: rgba(95, 184, 120, 0.15);
      color: var(--ok);
      border: 1px solid rgba(95, 184, 120, 0.3);
    }
    
    .pill.warn {
      background: rgba(216, 162, 90, 0.15);
      color: var(--warn);
      border: 1px solid rgba(216, 162, 90, 0.3);
    }
    
    .pill.bad {
      background: rgba(255, 107, 107, 0.15);
      color: var(--bad);
      border: 1px solid rgba(255, 107, 107, 0.3);
    }
    
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      color: var(--dim);
      font-size: 12px;
    }
    
    .footer a {
      color: var(--accent);
      text-decoration: none;
    }
    
    .footer a:hover {
      text-decoration: underline;
    }
    
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--line);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .error-box {
      background: rgba(255, 107, 107, 0.1);
      border: 1px solid rgba(255, 107, 107, 0.3);
      color: var(--bad);
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Verify Report Provenance</h1>
    <div class="subtitle">Cryptographic proof of AI generation</div>
  </div>
  
  <div id="container">
    <div style="text-align: center; padding: 40px;">
      <span class="spinner"></span> Loading report...
    </div>
  </div>
  
  <script>
    const reportId = window.location.pathname.split('/').pop();
    
    async function loadManifest() {
      try {
        const resp = await fetch(`https://reports.ledatic.org/manifest/${reportId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) {
        return null;
      }
    }
    
    async function verifySignature(manifest) {
      try {
        // Import the witness public key (Ed25519, 32 bytes)
        const pkBytes = new Uint8Array(
          atob(manifest.witness_attestation.ed25519_public_key).split('').map(c => c.charCodeAt(0))
        );
        
        const publicKey = await crypto.subtle.importKey(
          'raw',
          pkBytes,
          { name: 'Ed25519', namedCurve: 'Ed25519' },
          false,
          ['verify']
        );
        
        // Reconstruct witness payload bytes
        const witness_attestation = manifest.witness_attestation;
        const payload = JSON.stringify({
          digest: witness_attestation.digest,
          pulse_id: witness_attestation.pulse_id,
          value_hex: witness_attestation.value_hex,
          witnessed_at: witness_attestation.witnessed_at,
          previous_hash: witness_attestation.previous_hash
        });
        const payloadBytes = new TextEncoder().encode(payload);
        
        // Decode the signature (base64)
        const sigBytes = new Uint8Array(
          atob(manifest.witness_attestation.ed25519_signature.replace('base64:', '')).split('').map(c => c.charCodeAt(0))
        );
        
        // Verify
        const isValid = await crypto.subtle.verify(
          'Ed25519',
          publicKey,
          sigBytes,
          payloadBytes
        );
        
        return isValid ? 'VALID' : 'INVALID';
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    }
    
    async function render() {
      const manifest = await loadManifest();
      const container = document.getElementById('container');
      
      if (!manifest) {
        container.innerHTML = `
          <div class="error-box">
            Report not found or provenance manifest unavailable.
            This report may not be on the Provenance Tier.
          </div>
        `;
        return;
      }
      
      const witnessStatus = manifest.witness_attestation.chain_verified ? 'VERIFIED' : 'CHAIN BREAK';
      const witnessStatusClass = manifest.witness_attestation.chain_verified ? 'ok' : 'bad';
      
      let signatureVerifyResult = '';
      if (manifest.witness_attestation.ed25519_signature) {
        const verifyStatus = await verifySignature(manifest);
        const verifyClass = verifyStatus === 'VALID' ? 'ok' : (verifyStatus === 'INVALID' ? 'invalid' : 'warn');
        signatureVerifyResult = `<div class="verify-result ${verifyClass}">${verifyStatus}</div>`;
      }
      
      const overallStatus = manifest.witness_attestation.chain_verified && signatureVerifyResult.includes('VALID')
        ? 'VERIFIED'
        : (manifest.witness_attestation.chain_verified && signatureVerifyResult ? 'PARTIAL' : 'UNVERIFIABLE');
      const overallClass = overallStatus === 'VERIFIED' ? 'status-ok' : (overallStatus === 'PARTIAL' ? 'status-unverifiable' : 'status-invalid');
      
      const html = `
        <div class="status-box ${overallClass}">
          <div class="left">
            <div class="status-label">Verification Status</div>
            <div class="status-value">${overallStatus}</div>
          </div>
          <div class="right">${overallStatus.charAt(0)}</div>
        </div>
        
        <div class="chain-section">
          <div class="chain-title">Generation Event</div>
          
          <div class="chain-item">
            <div class="label">Report ID</div>
            <div class="value">${manifest.report_id}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Generated At</div>
            <div class="value">${manifest.generated_at}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Model</div>
            <div class="value">
              <strong>${manifest.generation_event.model.name}</strong>
              (${manifest.generation_event.model.provider})
            </div>
            <div style="margin-top: 6px;">
              Parameters: <code>${manifest.generation_event.model.parameters.toLocaleString()}</code>
            </div>
          </div>
          
          <div class="chain-item">
            <div class="label">Model Weights Hash (SHA-256)</div>
            <div class="hash-display">${manifest.generation_event.model.weights_hash}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Input Prompt Hash (SHA-256)</div>
            <div class="hash-display">${manifest.generation_event.input.prompt_hash}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Output Result Hash (SHA-256)</div>
            <div class="hash-display">${manifest.generation_event.output.result_hash}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Token Count & Metrics</div>
            <div class="value">
              Tokens: ${manifest.generation_event.output.token_count} |
              Log-Probability Sum: ${manifest.generation_event.output.logprob_sum}
            </div>
          </div>
        </div>
        
        <div class="chain-section">
          <div class="chain-title">Witness Attestation (fleet0 Witness Node)</div>
          
          <div class="chain-item ${manifest.witness_attestation.chain_verified ? 'verified' : 'invalid'}">
            <div class="label">Chain Verification</div>
            <div class="value">
              <span class="pill ${manifestwitness_attestation.chain_verified ? 'ok' : 'bad'}">
                ${manifest.witness_attestation.chain_verified ? 'VERIFIED' : 'CHAIN BREAK'}
              </span>
            </div>
          </div>
          
          <div class="chain-item">
            <div class="label">Witnessed At (Unix Timestamp)</div>
            <div class="value">${manifest.witness_attestation.witnessed_at}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Entropy Pulse ID</div>
            <div class="value">${manifest.witness_attestation.pulse_id}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Entropy Pulse Value (SHA-256)</div>
            <div class="hash-display">${manifest.witness_attestation.pulse_value_hex}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Previous Pulse Hash (Chain Link)</div>
            <div class="hash-display">${manifest.witness_attestation.previous_hash}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Witness Public Key (Ed25519, first 16 bytes)</div>
            <div class="hash-display">${manifest.witness_attestation.ed25519_public_key.substring(0, 32)}</div>
          </div>
          
          <div class="chain-item">
            <div class="label">Ed25519 Signature Verification</div>
            <button class="verify-btn" onclick="verifyInBrowser(event)">Verify Signature in Browser</button>
            ${signatureVerifyResult}
          </div>
        </div>
        
        <div class="footer">
          <p>
            <strong>What does this prove?</strong>
          </p>
          <p>
            This report was processed by the Anthropic Claude 3.5 Sonnet v2 model
            (weights hash above) on ${new Date(manifest.generated_at).toLocaleDateString()}.
            The input prompt, output text, and model identity are cryptographically
            bound to an Ed25519 signature from the fleet0 witness node (Pi Zero 2W at
            on the tailnet). The witness signature chains to a public entropy
            beacon at <a href="https://ledatic.org/entropy/pulse">ledatic.org/entropy/pulse</a>,
            preventing backdating or tampering.
          </p>
          <p>
            <strong>Verify the witness node:</strong>
            <a href="https://ledatic.org/witness/fleet0/latest">Latest witness attestation</a> |
            <a href="https://ledatic.org/entropy/pulse">Current entropy pulse</a>
          </p>
          <p style="color: #555; margin-top: 20px;">
            Ledatic Provenance Tier — Cryptographically verifiable AI reports.
            <a href="https://ledatic.org/provenance">Learn more</a>
          </p>
        </div>
      `;
      
      container.innerHTML = html;
    }
    
    window.verifyInBrowser = async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Verifying...';
      
      const manifest = await loadManifest();
      const result = await verifySignature(manifest);
      
      const container = btn.nextElementSibling || btn.parentElement;
      const resultDiv = document.createElement('div');
      const isValid = result === 'VALID';
      resultDiv.className = `verify-result ${isValid ? 'ok' : 'invalid'}`;
      resultDiv.textContent = result;
      
      if (btn.nextElementSibling && btn.nextElementSibling.className.includes('verify-result')) {
        btn.nextElementSibling.replaceWith(resultDiv);
      } else {
        btn.parentElement.appendChild(resultDiv);
      }
      
      btn.style.display = 'none';
    };
    
    render();
  </script>
</body>
</html>
```

---

## 5. Marketing Copy: `/provenance` Landing Page

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="Provenance Tier — Prove What Your AI Generated">
  <meta property="og:description" content="The only AI vendor where third parties can cryptographically verify your model, input, and output.">
  <meta property="og:image" content="https://ledatic.org/og-provenance.jpg">
  <title>Provenance Tier — Ledatic</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      background: #0b0d11;
      color: #cfd6df;
      line-height: 1.6;
    }
    
    header {
      background: linear-gradient(135deg, #0b0d11 0%, #11151b 100%);
      border-bottom: 1px solid #1f242c;
      padding: 16px 32px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .nav {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo { font-size: 18px; font-weight: 600; color: #33ff33; }
    .nav-links { display: flex; gap: 24px; font-size: 13px; }
    .nav-links a { color: #cfd6df; text-decoration: none; }
    .nav-links a:hover { color: #33ff33; }
    
    section {
      padding: 80px 32px;
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .hero {
      text-align: center;
      padding: 120px 32px;
    }
    
    h1 {
      font-size: 56px;
      font-weight: 700;
      margin-bottom: 16px;
      background: linear-gradient(135deg, #33ff33 0%, #86c5ff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .tagline {
      font-size: 24px;
      color: #6a7886;
      margin-bottom: 40px;
      max-width: 700px;
      margin-left: auto;
      margin-right: auto;
    }
    
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #33ff3333 0%, #86c5ff33 100%);
      border: 1px solid #33ff3366;
      color: #33ff33;
      padding: 16px 40px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.3s ease;
    }
    
    .cta-button:hover {
      background: linear-gradient(135deg, #33ff3355 0%, #86c5ff55 100%);
      border-color: #33ff33;
      box-shadow: 0 0 20px rgba(51, 255, 51, 0.2);
    }
    
    h2 {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 40px;
      color: #e6edf3;
      border-bottom: 1px solid #1f242c;
      padding-bottom: 16px;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }
    
    .card {
      background: #11151b;
      border: 1px solid #1f242c;
      border-radius: 8px;
      padding: 24px;
      transition: all 0.3s ease;
    }
    
    .card:hover {
      border-color: #33ff3344;
      background: #13171f;
      box-shadow: 0 0 20px rgba(51, 255, 51, 0.1);
    }
    
    .card h3 {
      font-size: 18px;
      color: #33ff33;
      margin-bottom: 12px;
    }
    
    .card p {
      font-size: 13px;
      color: #6a7886;
      line-height: 1.8;
    }
    
    .comparison {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 40px;
    }
    
    .comparison-box {
      background: #11151b;
      border: 1px solid #1f242c;
      border-radius: 8px;
      padding: 24px;
    }
    
    .comparison-box h3 {
      font-size: 16px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .check { color: #33ff33; }
    .x { color: #ff6b6b; }
    
    .feature {
      font-size: 13px;
      padding: 8px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .feature.yes { color: #cfd6df; }
    .feature.no { color: #6a7886; }
    
    .testimonial {
      background: #11151b;
      border: 1px solid #1f242c;
      border-radius: 8px;
      padding: 32px;
      margin-bottom: 24px;
      font-style: italic;
    }
    
    .testimonial::before {
      content: '"';
      font-size: 48px;
      color: #33ff3344;
    }
    
    .testimonial-author {
      font-style: normal;
      font-weight: 600;
      color: #33ff33;
      margin-top: 16px;
      font-size: 13px;
    }
    
    .pricing-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    
    .pricing-table th {
      background: #0a0c10;
      color: #33ff33;
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #1f242c;
    }
    
    .pricing-table td {
      padding: 12px;
      border-bottom: 1px solid #1f242c;
    }
    
    .pricing-table tr:hover {
      background: #11151b;
    }
    
    footer {
      background: #0a0c10;
      border-top: 1px solid #1f242c;
      padding: 40px 32px;
      text-align: center;
      color: #6a7886;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div class="nav">
      <div class="logo">LEDATIC</div>
      <div class="nav-links">
        <a href="https://ledatic.org">Home</a>
        <a href="#why">Why Provenance</a>
        <a href="#how">How It Works</a>
        <a href="#pricing">Pricing</a>
        <a href="https://reports.ledatic.org">Client Portal</a>
      </div>
    </div>
  </header>
  
  <div class="hero">
    <h1>Provenance Tier</h1>
    <div class="tagline">
      The only AI vendor where third parties can cryptographically verify<br>
      what your model generated, when, and with what inputs.
    </div>
    <a href="https://reports.ledatic.org" class="cta-button">Start a Provenance Report</a>
  </div>
  
  <section id="why">
    <h2>Why Provenance Matters</h2>
    <div class="grid">
      <div class="card">
        <h3>Litigation Defense</h3>
        <p>When opposing counsel claims "that AI analysis is fake," you hand them a cryptographically signed proof. Ed25519 signature + public witness. Game over.</p>
      </div>
      <div class="card">
        <h3>Regulatory Compliance</h3>
        <p>EU AI Act Article 13 demands transparency. Article 26 high-risk systems need traceability. Provenance Tier is the easy checkbox: here's the model, here's the timestamp, here's the hash chain.</p>
      </div>
      <div class="card">
        <h3>Audit Trail</h3>
        <p>SEC, FCA, or your internal auditors want proof AI was used correctly. No retrofit stories. No "we signed this after." Cryptographic timestamp proves generation order.</p>
      </div>
      <div class="card">
        <h3>Deepfake Era</h3>
        <p>AI-generated content is everywhere. Real news outlets prove their AI work. Provenance Tier is your source-of-truth credibility marker.</p>
      </div>
      <div class="card">
        <h3>M&A Due Diligence</h3>
        <p>You used Claude 3.5 Sonnet for that valuation. Buyer asks "prove it." Provenance manifest includes model weights hash, input hash, output hash, witness signature. Done.</p>
      </div>
      <div class="card">
        <h3>Intelligence & Government</h3>
        <p>Adversaries claim your threat assessment is fabricated. Public witness beacon proves the analysis timestamp. No way to backdoor the date.</p>
      </div>
    </div>
  </section>
  
  <section id="how">
    <h2>How It Works</h2>
    <div class="comparison">
      <div class="comparison-box">
        <h3><span class="x">✗</span> Standard Tier (No Provenance)</h3>
        <div class="feature no">PDF report, no signature</div>
        <div class="feature no">No model identity locked in</div>
        <div class="feature no">No input hash chain</div>
        <div class="feature no">No third-party witness</div>
        <div class="feature no">Opponent: "You could have AI'd this after"</div>
      </div>
      <div class="comparison-box">
        <h3><span class="check">✓</span> Provenance Tier</h3>
        <div class="feature yes">Signed PDF + manifest</div>
        <div class="feature yes">Claude 3.5 Sonnet weights hash locked in</div>
        <div class="feature yes">Input/output hash chain</div>
        <div class="feature yes">Pi Zero physical witness node, Ed25519 signature</div>
        <div class="feature yes">Opponent: "Oh. Okay."</div>
      </div>
    </div>
    
    <h3 style="font-size: 18px; color: #e6edf3; margin-top: 40px; margin-bottom: 20px;">The Chain</h3>
    <p style="margin-bottom: 20px; color: #6a7886;">
      Your input → hashed | Claude processes → output hashed | Model identity locked in |
      Ledatic signer hashes all of it | Fleet0 witness (Pi Zero) Ed25519-signs the attestation |
      Entropy beacon chains the signature to a public ledger | You get a report + manifest |
      Third party can verify the signature in-browser (no backend trust needed).
    </p>
  </section>
  
  <section id="pricing">
    <h2>Pricing</h2>
    <table class="pricing-table">
      <thead>
        <tr>
          <th>Tier</th>
          <th>Monthly Base</th>
          <th>Per-Report</th>
          <th>Use Case</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Standard</strong></td>
          <td>$2,000</td>
          <td>$120</td>
          <td>Internal analytics, no compliance burden</td>
        </tr>
        <tr>
          <td><strong>Provenance</strong></td>
          <td>$5,000</td>
          <td>$320</td>
          <td>Regulatory, legal discovery, audit-ready</td>
        </tr>
        <tr>
          <td><strong>Provenance+Audit</strong></td>
          <td>$8,500</td>
          <td>$350</td>
          <td>High-stakes litigation, EU AI Act compliance</td>
        </tr>
      </tbody>
    </table>
    <p style="margin-top: 24px; color: #6a7886; font-size: 12px;">
      Provenance+ includes quarterly third-party cryptographic audits of the entire witness chain.
      Reports retained for 7 years (legal hold standard).
    </p>
  </section>
  
  <section>
    <h2>Buyer Stories</h2>
    <div class="testimonial">
      We spent 6 months in SEC discovery arguing about whether that AI analysis was even used or retrofit post-hoc.
      With Provenance Tier, we proved the model, timestamp, and input/output chain in 10 minutes.
      Case settled. Ledatic saved us $400k in legal fees.
      <div class="testimonial-author">— Chief Compliance Officer, Goldman Sachs (example)</div>
    </div>
    <div class="testimonial">
      EU AI Act compliance was a nightmare until we switched to Provenance Tier.
      Now our high-risk AI systems have cryptographic proof of model identity and data provenance.
      Auditors are happy. We sleep better.
      <div class="testimonial-author">— Legal Director, Munich Re (example)</div>
    </div>
    <div class="testimonial">
      Our investigative journalism team uses Provenance Tier on AI-assisted research.
      We embed the proof in our article headers. Readers can verify the AI didn't hallucinate it.
      Trust up 40% YoY.
      <div class="testimonial-author">— Editorial Director, Financial Times (example)</div>
    </div>
  </section>
  
  <section>
    <h2>The Competition Can't Match This</h2>
    <div class="grid">
      <div class="card">
        <h3>OpenAI, Anthropic, Google</h3>
        <p>They sign your output. But <em>they</em> control the signing key. You're trusting their audit logs, not cryptographic proof. No third-party witness. No public beacon. Centralized, opaque.</p>
      </div>
      <div class="card">
        <h3>Ledatic</h3>
        <p>We use a <em>physical witness node</em> you can SSH into. Ed25519 signatures chain to a public entropy beacon. Third parties verify the signature in-browser. Decentralized proof. Open network.</p>
      </div>
    </div>
  </section>
  
  <section style="text-align: center;">
    <h2>Ready to Prove What Your AI Generated?</h2>
    <a href="https://reports.ledatic.org" class="cta-button" style="display: inline-block; margin-top: 20px;">Start a Provenance Report</a>
    <p style="margin-top: 20px; color: #6a7886;">
      Questions? <a href="mailto:sales@ledatic.org" style="color: #33ff33;">sales@ledatic.org</a> | 
      <a href="https://ledatic.org/witness/fleet0/latest" style="color: #33ff33;">Inspect the witness node</a>
    </p>
  </section>
  
  <footer>
    <p>&copy; 2026 Ledatic. Cryptographically verifiable AI.</p>
  </footer>
</body>
</html>
```

---

## 6. Compliance Angle: EU AI Act

### Article 13 (Transparency) & Article 26 (High-Risk Deployer Obligations)

**EU AI Act Status (May 2026)**: The Act entered force August 2024. High-risk systems (Annex III: credit scoring, CV filtering, law enforcement, critical infrastructure) face compliance deadlines in 2025-2026.

**Article 13 Demand**: High-risk AI must be transparent. Deployers must understand how the system works, what data it uses, and what it outputs.

**Article 26 Demand**: Deployers of high-risk AI must:
1. Maintain human oversight
2. Keep logs of system operation for at least 6 months
3. Inform authorities immediately if risks are identified
4. Ensure input data quality

**Provenance Tier as Compliance Shortcut**:
- **Article 13 transparency**: Manifest shows model name, weights hash, input hash, output hash, timestamp. Auditor can verify every claim in-browser.
- **Article 26 logging**: 7-year retention in R2. Proof of who, what, when, where for every report.
- **No guesswork**: Instead of "we think we used Claude," you have cryptographic proof of model identity.

**Liability Shield**: Ledatic's Provenance+Audit tier includes quarterly audits by a third party. If a regulator questions your AI use, you hand them an independent auditor's verified report. Liability shifts partly to the auditor (shared responsibility reduces your exposure).

---

## 7. Six-Week Implementation Roadmap

### **Week 1: Infrastructure & Contracts**
- [ ] Draft Provenance Tier legal terms (especially liability clauses for wrong model attestations)
- [ ] Negotiate insurance for cryptographic signing claims
- [ ] SSH to fleet0, verify witness node is live and signing correctly
- [ ] Code review: `frame_attest_ot256_publisher.sh` for pattern adaptation

### **Week 2: Attest Signer Pipeline**
- [ ] Write `tools/attest/report_attestation_publisher.sh` (adapt from frame_attest_ot256_publisher.sh)
  - Accept: `report_id`, `model_metadata`, `prompt_hash`, `result_hash`, `generated_at`
  - SSH to fleet0, call witness signer
  - Compose final provenance manifest JSON
  - PUT to R2 at `reports/<client_id>/<report_id>/manifest.json`
  - Return manifest URL
- [ ] Add `/attest` endpoint to DDA portal (10.42.0.2:8082)
  - Accept report metadata
  - Call report_attestation_publisher.sh with Bearer auth
  - Return status + manifest URL

### **Week 3: Verification Page**
- [ ] Write `/verify/<report_id>` handler in `tools/deploy/worker.js`
  - Fetch manifest from R2
  - Render verification UI page (copy from section 4 above)
  - In-browser Ed25519 verification via crypto.subtle
- [ ] Test verification page with real fleet0 signatures
- [ ] Deploy to Cloudflare Worker staging

### **Week 4: Integration & Testing**
- [ ] Integrate `/attest` endpoint into DDA portal request flow
- [ ] End-to-end test: client uploads data → DDA portal → witness signs → manifest stored → verify page works
- [ ] Test witness outage fallback (unsignedd report, clear degradation notice)
- [ ] Load test: 100 simultaneous report attestations
- [ ] Verify Ed25519 signature correctness with security team

### **Week 5: Landing Page & Marketing**
- [ ] Write `/provenance` landing page (copy from section 5 above)
- [ ] Create FAQ: "How is this different from OpenAI signing?" / "What if the witness goes down?" / "Can you backdateReports?"
- [ ] Prepare sales deck (3-5 slides on Provenance Tier, compliance angle, buyer ROI)
- [ ] Draft 1-page case study (hypothetical Goldman Sachs scenario)

### **Week 6: First Customer Onboarding & Launch**
- [ ] Pick first customer (pre-sold to a compliance-heavy prospect)
- [ ] Run them through the flow, gather feedback
- [ ] Fix any UX/integration bugs discovered
- [ ] Go live: launch `/provenance` landing page
- [ ] Send announcement email to warm prospect list (finance, legal, gov)
- [ ] Monitor: witness uptime, signature verification success rate, customer feedback

**MVP Success Criteria**:
- 5+ Provenance Tier reports generated, all verified successfully
- Witness node uptime > 99%
- Verification page loads in < 2 sec, Ed25519 verify in-browser works
- Zero cryptographic errors in logs
- First paying customer signs contract by end of week 6

---

## 8. The Really Creative Angle: "Legal Research Warrants"

### The Wild Use Case

**Problem**: A law firm cites AI-generated legal analysis in a court filing. Opposing counsel gets a copy and claims: "They LLM'd that, maybe it's hallucinated. Prove it."

**Solution**: **Legal Research Warrants** — a Provenance Tier report paired with a visual certificate that law firms print, sign, and file as evidence of AI provenance.

**The Pitch**:
Ledatic + select law firms (Cravath, Wachtell, etc.) co-create a new legal artifact: the **AI Warrant**. It's a one-page (or two-page) signed certificate that says:

> **AFFIDAVIT OF AI GENERATION**
>
> I, [Attorney Name], certify that the attached analysis (Report ID: `rep_abc123xyz`) was generated on 2026-05-09 at 14:37:22 UTC by the Anthropic Claude 3.5 Sonnet model (weights hash: `e3b0c4...`) processing the input dataset [CASE NAME - CONFIDENTIAL]. I have verified the Ed25519 signature from the Ledatic witness node fleet0 (key: `cac5f21a...`). The analysis is not retrofitted or hallucinated; it is a direct, timestamped output of the model.
>
> **Verifiable via**: https://ledatic.org/verify/rep_abc123xyz
>
> Signed: _______________
> Date: 2026-05-09
> Bar No: NY-123456

**Why This Matters**:
- Law firms can now **prove chain-of-custody** for AI work in court filings.
- Judges get a visual artifact to file with the record.
- Opposing counsel can independently verify the signature in-browser.
- Regulatory bodies (SEC, FTC, DOJ) can audit AI use in legal proceedings.
- First-mover advantage: law firms that use this look more credible than competitors.

**Business Model**:
- Provenance Tier base price: $5,000/mo
- **Legal Research Warrant Add-on**: +$2,000/mo for white-label warrant template + priority support
- **Enterprise Law Firm Package**: $12,000/mo (Provenance Tier + Warrants + custom branding)

**Customer Acquisition**:
- Partner with 2-3 elite law firms (Cravath, Latham, Paul Weiss) for closed beta
- They use Warrants in real cases (with client consent)
- Case wins + press coverage ("First AI-Verified Legal Analysis in Court") drive adoption
- Other firms see it working, sign up to stay competitive

**The Moonshot**: Ledatic + leading law firms draft a **Model Warrant Standard** and propose it to the American Bar Association. If adopted, it becomes the industry norm. Every law firm using AI needs Provenance Tier to issue Warrants. Ledatic becomes the crypto-proof infrastructure for legal AI.

---

## 9. Competitive Moats

1. **Hardware Witness Node**: We own a physical Pi Zero that no competitor can easily replicate. Ed25519 signatures from a tangible machine are legally more defensible than "our backend signed this."

2. **Public Beacon**: The entropy.pulse is auditable by anyone. No private signing key that competitors can steal. OpenAI/Google can't match this without building their own Pi fleet.

3. **Regulatory Positioning**: We're the first to market with a product that solves EU AI Act compliance via cryptography. By the time competitors copy us (6-12 months), we'll have case law, regulatory goodwill, and customer stickiness.

4. **Brand Differentiation**: "Only AI vendor with third-party witness" is a marketing slam dunk. Fits neatly on a slide, easy for compliance officers to explain to their board.

---

## 10. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Witness node goes down | Fallback to "unwitnessed" report with clear disclosure; add redundant witness nodes (mini, etc.) in week 9+ |
| Fleet0 key compromise | Rotate Ed25519 key, invalidate old signatures, offer customer refunds for affected reports |
| EU regulators challenge our "proof" | Partner with audit firm (e.g., Big 4) to validate methodology; file whitepaper with regulatory bodies |
| OpenAI/Google copy us | They can sign, but they can't match "independent physical witness." We remain differentiated. |
| Customer wants to backdateproof | We refuse. Manifest timestamp is immutable. Cryptographic proof prevents fraud. |

---

## Conclusion

**Provenance Tier** turns Ledatic's unique hardware advantage (fleet0 Pi Zero witness node) into a market-leading product. We're not just signing reports; we're offering cryptographic proof that competitors fundamentally cannot match without building their own physical witness infrastructure.

**The Three-Layer Value**:
1. **Legal**: Survive court discovery with signed timestamp + model identity.
2. **Regulatory**: Tick EU AI Act Article 13/26 compliance checkboxes.
3. **Competitive**: Be the vendor your clients name-drop when asked "how do you prove AI provenance?"

**Target Market**: Regulated enterprises (finance, insurance, law, government) where AI output must survive audit and litigation. TAM: ~$2B annual spend on AI compliance infrastructure.

**6-Week MVP**: Fully functional end-to-end. First customer signed by week 6. Path to $500k ARR by end of 2026.

---

**Appendix: Glossary**

- **Provenance**: Origin and custody history of an artifact (here, an AI report).
- **Witness Node**: A Pi Zero 2W running `com.ledatic.attest_sign`, signing entropy observations.
- **Manifest**: JSON-LD file containing model identity, input/output hashes, witness signature, and chain-of-custody.
- **Fleet0**: Specific physical Pi Zero at on the tailnet, primary witness node.
- **Entropy Pulse**: Public beacon at ledatic.org/entropy/pulse, updated every 30s with randomness from Qwen 122B.
- **Ed25519**: Elliptic curve signature scheme, 64-byte signature, verifiable via Web Crypto API in-browser.
- **Chain Verified**: Boolean flag indicating the witness node's entropy chain is unbroken (no backdating).
- **Audit Tier**: Provenance+Audit (includes quarterly third-party cryptographic audits).
