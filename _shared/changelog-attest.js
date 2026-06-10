// Per-release attestation badge.  Each .release[data-attest-tag] gets an
// index.json fetched on load; the "attested" label is only printed after
// the release's attestation.json has itself been fetched and carries a
// signature — index presence alone does not earn the claim.  Releases
// without published attestations stay quiet — visitor sees nothing,
// not a 404 ghost.  Releases load in parallel, and a malformed record
// silences its own badge without killing the rest.
(() => {
  const blocks = document.querySelectorAll(".release[data-attest-tag]");
  blocks.forEach(async (el) => {
    try {
      const tag = el.getAttribute("data-attest-tag");
      const r = await fetch("/releases/" + tag + "/index.json", { cache: "default" });
      if (!r.ok) return;
      const idx = await r.json();
      const arts = idx.artifacts || [];
      const bin = arts.find(a => a.path === "rail_native");
      const src = arts.find(a => a.path === "tools/compile.rail");
      const art = bin || src;
      if (!art || typeof art.sha256 !== "string") return;

      // Honesty gate: confirm the attestation artifact exists and is
      // signed before claiming "attested".
      const attName = art.attestation
        || (bin ? "rail_native.attestation.json" : "compile.rail.attestation.json");
      const attUrl = "/releases/" + tag + "/" + attName;
      const ar = await fetch(attUrl, { cache: "default" });
      if (!ar.ok) return;
      const att = await ar.json();
      const sig = att && (att.sig || (att.witness && att.witness.sig));
      if (!sig) return;

      const pulse = art.pulse_id !== undefined ? art.pulse_id : "?";
      const sha = art.sha256.slice(0, 16);

      const div = document.createElement("div");
      div.className = "attest-badge";

      const line1 = document.createElement("div");
      const okSpan = document.createElement("span");
      okSpan.className = "ok"; okSpan.textContent = "attested";
      line1.appendChild(okSpan);
      line1.appendChild(document.createTextNode(" · pulse "));
      const pulseVal = document.createElement("span");
      pulseVal.className = "val"; pulseVal.textContent = String(pulse);
      line1.appendChild(pulseVal);
      line1.appendChild(document.createTextNode(" · sha "));
      const shaCode = document.createElement("code");
      shaCode.className = "val"; shaCode.textContent = sha + "…";
      line1.appendChild(shaCode);

      const line2 = document.createElement("div");
      const labv = document.createElement("span");
      labv.className = "lab"; labv.textContent = "verify: ";
      line2.appendChild(labv);
      const mkLink = (href, text) => {
        const a = document.createElement("a");
        a.href = href; a.textContent = text;
        return a;
      };
      const sep = () => document.createTextNode(" · ");
      line2.appendChild(mkLink("/releases/" + tag + "/index.json", "index.json"));
      if (bin) {
        line2.appendChild(sep());
        line2.appendChild(mkLink("/releases/" + tag + "/rail_native", "rail_native"));
      }
      line2.appendChild(sep());
      line2.appendChild(mkLink(attUrl, "attestation"));
      line2.appendChild(sep());
      line2.appendChild(mkLink("/attest/verify.sh", "verify.sh"));

      div.appendChild(line1);
      div.appendChild(line2);

      const body = el.children[1];
      (body || el).appendChild(div);
    } catch (e) {
      // Stay quiet — no badge beats a broken claim.
    }
  });
})();
