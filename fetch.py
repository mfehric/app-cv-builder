#!/usr/bin/env python3
"""Daily job: collect internships / junior roles from public sources into discover.json.

Usage: fetch.py <app_id>. Reads /data/apps/<id>/sources.json (created with defaults if absent)
and writes /data/apps/<id>/discover.json. Plain HTTP, no AI, no accounts.
"""
import html, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor

APP = sys.argv[1]
DIR = f"/data/apps/{APP}"
DEFAULTS = {
    "keywords": ["software", "data", "machine learning", "ml", "ai", "quant", "research", "engineer", "analyst", "developer", "science"],
    "levels": ["intern", "internship", "graduate", "new grad", "junior", "entry", "trainee", "student", "apprentice", "research"],
    "simplify_internships": True,
    "simplify_newgrad": True,
    "greenhouse": ["stripe", "databricks", "robinhood", "airbnb", "figma", "datadog", "cloudflare", "anthropic"],
    "lever": ["spotify", "palantir"],
    "recruitee": ["zira"],
    "workable": ["atlantbh", "infinum", "netcetera"],
    "euraxess": ["mathematics", "computer science", "machine learning", "data science", "artificial intelligence"],
    "max_age_days": 90,
}
SIMPLIFY = {
    "simplify_internships": ("https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json", "Praksa"),
    "simplify_newgrad": ("https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json", "Full-time"),
}

def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "mobius-cv-builder/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def get_text(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 mobius-cv-builder/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


VISA_SIMPLIFY = {"Offers Sponsorship": "yes", "Does Not Offer Sponsorship": "no", "U.S. Citizenship is Required": "citizen"}
_KEY = re.compile(r"sponsor|visa|work authori|authori[sz]ed to work|right to work|work permit|citizen|clearance", re.I)
_WORK = r"(?:visa|work permit|work authori[sz]ation|employment|immigration|h-?1b|work)"
_NEG = re.compile(r"\b(?:not|no|unable|cannot|can't|can not|won't|don't|doesn't|never|without)\b[^.;]{0,60}sponsor|sponsor[^.;]{0,60}\b(?:not (?:available|offered|provided)|unavailable)|without[^.;]{0,30}sponsorship", re.I)
_YES = re.compile(r"(?:visa|work permit|immigration|relocation)[^.;]{0,50}(?:sponsor|support|assist)|(?:sponsor|support|assist)[^.;]{0,50}(?:visa|work permit|immigration)|sponsor(?:s|ship)? (?:is )?(?:available|provided|offered)|(?:we|will|can|able to) (?:offer |provide )?(?:visa )?sponsor", re.I)

def visa_from(text):
    """Classify what a posting says about visa sponsorship / work authorisation.
    Returns (status, sentence) with status yes | no | citizen | auth | '' (not stated)."""
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(text or "")))).replace("\xa0", " ")
    found = {}
    for sent in re.split(r"(?<=[.!?;])\s+|\s[•·]\s", t):
        if not _KEY.search(sent):
            continue
        sent = sent.strip()[:240]
        if re.search(r"u\.?s\.? citizen|citizenship (?:is )?required|security clearance|eligible for (?:a )?(?:u\.?s\.? )?(?:government )?(?:security )?clearance", sent, re.I):
            found.setdefault("citizen", sent)
        elif _NEG.search(sent) and re.search(_WORK + "|sponsor", sent, re.I) and re.search(r"sponsor", sent, re.I) and re.search(_WORK, sent, re.I):
            found.setdefault("no", sent)
        elif _YES.search(sent):
            found.setdefault("yes", sent)
        elif re.search(r"authori[sz]ed to work|right to work|work authori[sz]ation|eligible to work|legally (?:able|entitled|permitted) to work", sent, re.I):
            found.setdefault("auth", sent)
    for k in ("citizen", "no", "yes", "auth"):
        if k in found:
            return k, found[k]
    return "", ""

MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}

def parse_date(s):
    """'2 Nov 2026' / '1 October 2026' -> '2026-11-02' ('' if unrecognised)."""
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(20\d\d)", s or "")
    return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}" if m and m.group(2).lower() in MONTHS else ""

def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")

def main():
    path = f"{DIR}/sources.json"
    src = dict(DEFAULTS)
    if os.path.exists(path):
        src.update(json.load(open(path)))
    else:
        json.dump(DEFAULTS, open(path, "w"), ensure_ascii=False, indent=1)
    kws = [k.lower() for k in src["keywords"] if k.strip()]
    lvls = [k.lower() for k in src["levels"] if k.strip()]
    cutoff = time.time() - src["max_age_days"] * 86400
    items, errors = [], []
    hit = lambda t, words: not words or any(re.search(r"\b" + re.escape(w), t) for w in words)

    for key, (url, kind) in SIMPLIFY.items():
        if not src.get(key):
            continue
        try:
            for x in get(url, 120):
                if not (x.get("active") and x.get("is_visible", True)) or x.get("date_posted", 0) < cutoff:
                    continue
                if not hit((x["title"] + " " + x.get("category", "")).lower(), kws):
                    continue
                items.append({"id": "s-" + x["id"], "source": "GitHub / Simplify", "kind": kind, "title": x["title"], "company": x["company_name"],
                              "location": ", ".join(x.get("locations") or [])[:80], "url": x["url"], "posted": iso(x["date_posted"]), "deadline": "", "category": x.get("category", ""),
                              "visa": VISA_SIMPLIFY.get(x.get("sponsorship"), ""), "visa_note": x.get("sponsorship", "") if x.get("sponsorship") in VISA_SIMPLIFY else ""})
        except Exception as e:
            errors.append(f"{key}: {e}")

    def board_ok(title):
        t = title.lower()
        return hit(t, lvls) and hit(t, kws)

    for tok in src["greenhouse"]:
        try:
            for x in get(f"https://boards-api.greenhouse.io/v1/boards/{tok}/jobs?content=true", 120)["jobs"]:
                if not board_ok(x["title"]):
                    continue
                posted = (x.get("first_published") or x.get("updated_at") or "")[:10]
                if posted and posted < iso(cutoff):
                    continue
                items.append({"id": f"g-{tok}-{x['id']}", "source": "Greenhouse", "gh": [tok, x["id"]], "kind": "", "title": x["title"], "company": x.get("company_name") or tok,
                              "location": (x.get("location") or {}).get("name", ""), "url": x["absolute_url"], "posted": posted, "deadline": (x.get("application_deadline") or "")[:10], "category": "",
                              "visa": visa_from(x.get("content"))[0], "visa_note": visa_from(x.get("content"))[1]})
        except Exception as e:
            errors.append(f"greenhouse/{tok}: {e}")

    for co in src["lever"]:
        try:
            for x in get(f"https://api.lever.co/v0/postings/{co}?mode=json"):
                if not board_ok(x["text"]):
                    continue
                if x.get("createdAt", 0) / 1000 < cutoff:
                    continue
                items.append({"id": f"l-{co}-{x['id']}", "source": "Lever", "kind": "", "title": x["text"], "company": co.capitalize(),
                              "location": (x.get("categories") or {}).get("location", ""), "url": x["hostedUrl"], "posted": iso(x["createdAt"] / 1000), "deadline": "",
                              "category": (x.get("categories") or {}).get("team", ""), "text": (x.get("descriptionPlain") or "")[:6000],
                              "visa": visa_from(x.get("descriptionPlain"))[0], "visa_note": visa_from(x.get("descriptionPlain"))[1]})
        except Exception as e:
            errors.append(f"lever/{co}: {e}")

    # Recruitee boards (local / regional companies, e.g. zira.recruitee.com). These are hand-picked
    # by the owner, so keep every published offer: local ads use varied wording ("DEV Academy",
    # "Razvoj") that the generic tech keywords would wrongly filter out. Internship detection reads
    # the whole text so an academy/praksa still gets the "Praksa" tag.
    strip_html = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()
    for co in src.get("recruitee", []):
        try:
            for x in get(f"https://{co}.recruitee.com/api/offers/").get("offers", []):
                if x.get("status") not in (None, "published"):
                    continue
                title, dept = x.get("title") or "", x.get("department") or ""
                # No age cutoff here: local boards reuse one evergreen/annual posting (old created_at
                # but open right now), so "published" is the relevance signal, not recency.
                posted = (x.get("created_at") or "")[:10]
                desc = strip_html(x.get("description"))
                kind = "Praksa" if re.search(r"intern|trainee|student|apprentice|academy|akademij|praks|priprav|sta[žz]ir", (title + " " + dept + " " + desc).lower()) else "Full-time"
                items.append({"id": f"r-{co}-{x['id']}", "source": "Recruitee", "kind": kind, "title": title,
                              "company": x.get("company_name") or co.capitalize(), "location": x.get("city") or x.get("location") or "",
                              "url": x.get("careers_apply_url") or x.get("careers_url") or "", "posted": posted, "deadline": "",
                              "category": dept, "text": desc[:6000], "visa": visa_from(desc)[0], "visa_note": visa_from(desc)[1]})
        except Exception as e:
            errors.append(f"recruitee/{co}: {e}")

    # Workable boards (regional companies, e.g. apply.workable.com/atlantbh). Curated like Recruitee:
    # every published offer is kept regardless of title wording or age.
    for co in src.get("workable", []):
        try:
            for x in get(f"https://apply.workable.com/api/v1/widget/accounts/{co}").get("jobs", []):
                title, dept = x.get("title") or "", x.get("department") or ""
                if re.search(r"talent pool|general application", title, re.I):
                    continue
                kind = "Praksa" if re.search(r"intern|trainee|student|apprentice|academy|akademij|praks|junior", title.lower()) else "Full-time"
                items.append({"id": f"w-{co}-{x.get('shortcode')}", "source": "Workable", "kind": kind, "title": title, "company": co.capitalize(),
                              "location": ", ".join(p for p in (x.get("city"), x.get("country")) if p), "url": x.get("application_url") or x.get("url") or "",
                              "posted": (x.get("published_on") or x.get("created_at") or "")[:10], "deadline": "", "category": dept, "text": ""})
        except Exception as e:
            errors.append(f"workable/{co}: {e}")

    # EURAXESS research jobs (universities / institutes) for first-stage researchers (R1: PhD students,
    # research assistants). Its keyword URL parameter is ignored by the site, so scan the newest pages and
    # keep postings whose research field or title match the keywords. The deadline lives on each posting.
    eu_kws = [k.lower() for k in src.get("euraxess", []) if k.strip()]
    if eu_kws:
        flat_text = lambda h: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " | ", h))
        def eu_detail(jid):
            try:
                d = get_text(f"https://euraxess.ec.europa.eu/jobs/{jid}")
            except Exception:
                return None
            flat = flat_text(d)
            k = flat.find("Job Information")
            if k < 0:
                return None
            flat = flat[k:]
            m = re.search(r'<h1 class="ecl-content-block__title">(.*?)</h1>', d, re.S)
            title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip().rstrip(",") if m else ""
            field = re.search(r"Research Field[ |]+(.*?)\| *Researcher Profile", flat)
            field = re.sub(r"[ |]+", " ", field.group(1)).strip() if field else ""
            if not title or not any(k in (title + " " + field).lower() for k in eu_kws):
                return None
            dl = re.search(r"Application Deadline[ |]+([^|]+)", flat)
            ctry = re.search(r"Application Deadline[ |]+[^|]+\|[ |]+Country[ |]+([^|]+)", flat)
            org = re.search(r"Organisation/Company[ |]+([^|]+)", flat)
            desc = re.search(r"Offer Description[ |]+(.{60,}?)(?: \| Where to apply| \| Requirements|$)", flat)
            return {"id": f"e-{jid}", "source": "EURAXESS", "kind": "Istraživanje", "title": title or f"EURAXESS {jid}",
                    "company": (org.group(1).strip() if org else "")[:80], "location": ctry.group(1).strip() if ctry else "",
                    "url": f"https://euraxess.ec.europa.eu/jobs/{jid}", "posted": "", "deadline": parse_date(dl.group(1)) if dl else "",
                    "category": field[:60], "text": re.sub(r"[ |]+", " ", desc.group(1)).strip()[:3000] if desc else ""}
        try:
            ids = []
            for pg in range(10):
                page = get_text(f"https://euraxess.ec.europa.eu/jobs/search?f%5B0%5D=offer_type%3Ajob_offer&f%5B1%5D=research_profile%3A446&page={pg}")
                ids += [j for j in dict.fromkeys(re.findall(r'href="/jobs/(\d+)"', page)) if j not in ids]
            with ThreadPoolExecutor(8) as ex:
                items += [r for r in ex.map(eu_detail, ids) if r]
        except Exception as e:
            errors.append(f"euraxess: {e}")

    for i in items:
        if not i["kind"]:
            i["kind"] = "Praksa" if re.search(r"intern|trainee|student|apprentice", i["title"], re.I) else "Full-time"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = [i for i in items if not i["deadline"] or i["deadline"] >= today]  # expired ads disappear
    items.sort(key=lambda i: i["posted"], reverse=True)
    # Keep the big GitHub lists from crowding out company boards.
    big = [i for i in items if i["source"] == "GitHub / Simplify"][:350]
    kept = sorted([i for i in items if i["source"] != "GitHub / Simplify"][:350] + big, key=lambda i: i["posted"], reverse=True)
    out = {"updated": int(time.time() * 1000), "count": len(kept), "errors": errors, "items": kept}
    json.dump(out, open(f"{DIR}/discover.json", "w"), ensure_ascii=False)
    print(f"ok {len(items)} items, {len(errors)} errors")

main()
