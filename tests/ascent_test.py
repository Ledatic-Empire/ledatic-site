#!/usr/bin/env python3
"""The home page's ascent, in a real browser (run: .venv/bin/python tests/ascent_test.py).

Checks, at desktop and phone widths, against this working tree:
  1. the visitor lands at sea level: the hero's top is at the top of the screen, altimeter 0
  2. the top of the page is the summit: altimeter 14,000
  3. a visitor who has left the bottom is never pulled back by a late layout change
     (2026-11-11: the first version re-landed on any resize until a wheel, touch or key
     event; a scrollbar drag or an anchor link followed by a slow asset sent them back down)
Exit 0 all pass, 1 any fail.
"""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PORT = 8819
fails = 0

def check(ok, label):
    global fails
    print(("ok   " if ok else "FAIL ") + label)
    fails += 0 if ok else 1

srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "-d", ROOT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(1)
    if srv.poll() is not None:
        print(f"ascent_test: could not own port {PORT}"); sys.exit(1)
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, w, h in [("desk", 1440, 900), ("phone", 390, 844)]:
            pg = b.new_page(viewport={"width": w, "height": h})
            pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_timeout(2500)
            top = pg.evaluate("document.querySelector('.mountain > .hero').getBoundingClientRect().top")
            check(abs(top) < 4 and pg.inner_text("[data-altimeter]") == "0", f"{name}: lands at sea level (hero top {top:.1f})")
            pg.evaluate("scrollTo(0,0)"); pg.wait_for_timeout(600)
            check(pg.inner_text("[data-altimeter]") == "14,000", f"{name}: the top is the summit")
            pg.evaluate("document.querySelector('.mountain main').style.paddingTop='37px'"); pg.wait_for_timeout(1500)
            y = pg.evaluate("scrollY")
            check(y < 100, f"{name}: a late layout change does not pull the visitor back (scrollY {y})")
        b.close()
finally:
    srv.terminate(); srv.wait()
print("all passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
