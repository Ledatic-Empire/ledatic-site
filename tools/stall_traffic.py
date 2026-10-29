#!/usr/bin/env python3
"""The stall's traffic, from Cloudflare's account-level analytics (agent stall plan, step 2 and step 7).

    tools/stall_traffic.py [days]        default 30

Prints eyeball requests to ledatic.org for the stall's surfaces (/data*, /x402*, /llms.txt) by path, split
into browser and bot by user agent (the Free plan exposes no bot score), the crawlers seen, and html
pageviews per day. Counts come from the sampled adaptive dataset: estimates, not ledger figures.
Token: ~/.fleet/cf_token with Account Analytics Read; ids: ~/.ledatic/cf_ids.env.
"""
import datetime
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict

HOME = os.path.expanduser("~")
BOT = re.compile(r"bot|crawl|spider|slurp|fetch|python|curl|wget|go-http|httpx|java|okhttp|scrapy|headless|preview|"
                 r"facebookexternalhit|GPT|Claude|anthropic|openai|perplexity|bytespider|ccbot|ahrefs|semrush|petal|"
                 r"yandex|bing|duckduck|applebot|amazonbot|meta-external|discovery|node", re.I)


def ids():
    out = {}
    with open(os.path.join(HOME, ".ledatic", "cf_ids.env")) as fh:
        for line in fh:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                out[k] = v.strip().strip('"').strip("'")
    with open(os.path.join(HOME, ".fleet", "cf_token")) as fh:
        out["TOKEN"] = fh.read().strip()
    return out


def gql(cfg, query):
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=json.dumps({"query": query}).encode(),
                                 headers={"Authorization": "Bearer " + cfg["TOKEN"], "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = json.load(resp)
    if d.get("errors"):
        raise SystemExit("analytics error: " + d["errors"][0]["message"])
    return d["data"]["viewer"]["accounts"][0]["httpRequestsAdaptiveGroups"]


def main(days):
    cfg = ids()
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    acct = cfg["CF_ACCOUNT"]
    rows = gql(cfg, '{ viewer { accounts(filter:{accountTag:"%s"}) { httpRequestsAdaptiveGroups(limit:400, filter:{datetime_geq:"%s", '
                    'clientRequestHTTPHost:"ledatic.org", requestSource:"eyeball", OR:[{clientRequestPath_like:"/data%%"},'
                    '{clientRequestPath_like:"/x402%%"},{clientRequestPath:"/llms.txt"}]}, orderBy:[count_DESC]) '
                    '{ count dimensions{clientRequestPath userAgent} } } } }' % (acct, since))
    by = defaultdict(lambda: [0, 0])
    crawlers = defaultdict(int)
    for r in rows:
        p, ua = r["dimensions"]["clientRequestPath"], r["dimensions"].get("userAgent") or ""
        bot = (not ua) or bool(BOT.search(ua))
        by[p][1 if bot else 0] += r["count"]
        if bot and ua:
            crawlers[ua.split("(")[-1].split(";")[0].split("/")[0][:28] if "compatible" in ua else ua.split("/")[0][:28]] += r["count"]
    print("stall surfaces since %s (eyeball requests to ledatic.org, sampled estimates)" % since[:10])
    print("%-46s %7s %5s" % ("path", "browser", "bot"))
    for p, (h, b) in sorted(by.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))[:25]:
        print("%-46s %7d %5d" % (p[:46], h, b))
    print("\ncrawlers:", ", ".join("%s %d" % kv for kv in sorted(crawlers.items(), key=lambda kv: -kv[1])[:12]))
    daily = gql(cfg, '{ viewer { accounts(filter:{accountTag:"%s"}) { httpRequestsAdaptiveGroups(limit:60, filter:{datetime_geq:"%s", '
                     'clientRequestHTTPHost:"ledatic.org", requestSource:"eyeball", edgeResponseContentTypeName:"html"}, '
                     'orderBy:[date_ASC]) { count dimensions{date} } } } }' % (acct, since))
    print("\nhtml pageviews per day:", " ".join("%s:%d" % (r["dimensions"]["date"][5:], r["count"]) for r in daily))
    return 0


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 30))
