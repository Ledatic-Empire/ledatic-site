// Per-release attestation badge.  Each .release[data-attest-tag] gets an
// index.json fetched on load; if present, we inject a small mono-text
// block with pulse_id, binary sha-12, and download links.  Releases
// without published attestations stay quiet — visitor sees nothing,
// not a 404 ghost.
(async () => {
  const blocks = document.querySelectorAll(".release[data-attest-tag]");
  for (const el of blocks) {
    const tag = el.getAttribute("data-attest-tag");
    let idx;
    try {
      const r = await fetch("/releases/" + tag + "/index.json", { cache: "default" });
      if (!r.ok) continue;
      idx = await r.json();
    } catch (e) { continue; }
    const arts = idx.artifacts || [];
    const bin = arts.find(a => a.path === "rail_native");
    const src = arts.find(a => a.path === "tools/compile.rail");
    const pulse = bin ? bin.pulse_id : (src ? src.pulse_id : "?");
    const sha = bin ? bin.sha256.slice(0, 16) : (src ? src.sha256.slice(0, 16) : "");

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
      line2.appendChild(sep());
      line2.appendChild(mkLink("/releases/" + tag + "/rail_native.attestation.json", "attestation"));
    }
    line2.appendChild(sep());
    line2.appendChild(mkLink("/attest/verify.sh", "verify.sh"));

    div.appendChild(line1);
    div.appendChild(line2);

    const body = el.children[1];
    (body || el).appendChild(div);
  }
})();
