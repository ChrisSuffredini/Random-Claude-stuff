"""Parse data/raw/*.html.gz (from scraper/scrape.js) into tidy tables.

Writes data/parsed/:
  matches.csv    one row per match: id, time, team1, team2, maps won, format,
                 bo1 map, event, stars, lan
  rankings.csv   one row per (ranking date, team): rank, points, team id, lineup
  events.json    the Major's event pages: teams (+ids, notes), upcoming and
                 played matches per stage

    python3 model/parse.py
"""
from __future__ import annotations

import csv
import glob
import gzip
import json
import os
import re
import sys
from datetime import datetime, timezone

from bs4 import BeautifulSoup

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "parsed")


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return BeautifulSoup(f.read(), "lxml")


def text(el):
    return el.get_text(" ", strip=True) if el else ""


MATCH_HREF = re.compile(r"/matches/(\d+)/([^\"?#]+)")
TEAM_HREF = re.compile(r"/team/(\d+)/([^\"?#/]+)")


def parse_result_con(con):
    a = con.find("a", href=MATCH_HREF)
    if not a:
        return None
    m = MATCH_HREF.search(a["href"])
    teams = con.select("div.team")
    if len(teams) < 2:
        return None
    t1, t2 = text(teams[0]), text(teams[-1])
    score = text(con.select_one(".result-score"))
    sm = re.match(r"\s*(\d+)\s*-\s*(\d+)", score)
    if not sm:
        return None
    s1, s2 = int(sm.group(1)), int(sm.group(2))
    fmt_raw = text(con.select_one(".map-text")).lower()
    if fmt_raw.startswith("bo"):
        fmt, bo1_map = fmt_raw, ""
    elif fmt_raw in ("def", "-", ""):
        fmt, bo1_map = "def" if fmt_raw == "def" else "unknown", ""
    else:
        fmt, bo1_map = "bo1", fmt_raw
    ev = con.select_one(".event-name")
    if ev is None:
        img = con.select_one("img.event-logo")
        event = (img.get("title") or img.get("alt") or "") if img else ""
    else:
        event = text(ev)
    unix = con.get("data-zonedgrouping-entry-unix")
    stars = len(con.select(".stars i"))
    won = [("team-won" in (t.get("class") or [])) for t in (teams[0], teams[-1])]
    return {
        "id": int(m.group(1)),
        "slug": m.group(2),
        "unix_ms": int(unix) if unix else None,
        "team1": t1,
        "team2": t2,
        "score1": s1,
        "score2": s2,
        "format": fmt,
        "bo1_map": bo1_map,
        "event": event,
        "stars": stars,
        "winner_flag": 1 if won[0] else (2 if won[1] else 0),
    }


def parse_results_page(soup):
    big = set(id(c) for c in soup.select(".big-results .result-con"))
    rows = []
    for con in soup.select(".result-con"):
        if id(con) in big:
            continue
        r = parse_result_con(con)
        if r:
            rows.append(r)
    return rows


def maps_won(r):
    """Map counts per team. Bo1 rows carry round scores, so collapse to 1-0."""
    s1, s2 = r["score1"], r["score2"]
    if r["format"] == "bo1" or s1 > 5 or s2 > 5:
        return (1, 0) if s1 > s2 else (0, 1) if s2 > s1 else (0, 0)
    return s1, s2


def parse_results(kind="results"):
    rows = {}
    files = sorted(glob.glob(os.path.join(RAW, kind, "*.html.gz")))
    for f in files:
        for r in parse_results_page(load(f)):
            rows[r["id"]] = r
    return rows, len(files)


ORD = re.compile(r"(\d+)(st|nd|rd|th)")


def parse_ranking_page(soup, date):
    teams = []
    for el in soup.select(".ranked-team"):
        pos = re.search(r"\d+", text(el.select_one(".position")))
        name = text(el.select_one(".teamLine .name")) or text(el.select_one(".name"))
        pts = re.search(r"(\d+)", text(el.select_one(".points")).replace(",", ""))
        tid = None
        for a in el.find_all("a", href=TEAM_HREF):
            tid = int(TEAM_HREF.search(a["href"]).group(1))
            break
        players = []
        for a in el.find_all("a", href=re.compile(r"/player/(\d+)/")):
            pid = int(re.search(r"/player/(\d+)/", a["href"]).group(1))
            if pid not in players:
                players.append(pid)
        if name:
            teams.append({
                "date": date,
                "rank": int(pos.group()) if pos else None,
                "team": name,
                "team_id": tid,
                "points": int(pts.group(1)) if pts else None,
                "players": ";".join(map(str, players[:5])),
            })
    return teams


def parse_rankings():
    out = []
    for f in sorted(glob.glob(os.path.join(RAW, "rankings", "*.html.gz"))):
        date = os.path.basename(f)[:10]
        out.extend(parse_ranking_page(load(f), date))
    return out


def parse_event_page(soup):
    title = text(soup.select_one(".event-hub-title")) or text(soup.find("h1"))
    teams = []
    for box in soup.select(".team-box"):
        a = box.select_one(".team-name a") or box.find("a", href=TEAM_HREF)
        logo = box.select_one(".logo") or box.find("img")
        name = text(box.select_one(".team-name .text")) or (logo.get("title") if logo else "") or text(a)
        tid = int(TEAM_HREF.search(a["href"]).group(1)) if a and TEAM_HREF.search(a.get("href", "")) else None
        teams.append({
            "team": name,
            "team_id": tid,
            "note": text(box.select_one(".sub-text")),
            "world_rank": text(box.select_one(".event-world-rank")),
        })
    dates = [int(s["data-unix"]) for s in soup.select("td.eventdate span[data-unix]")]
    return {"title": title, "teams": teams, "date_unix_ms": dates}


def parse_upcoming(soup):
    """Upcoming matches of an event: team names, time, format if shown."""
    out = []
    seen = set()
    for a in soup.find_all("a", href=MATCH_HREF):
        mid = int(MATCH_HREF.search(a["href"]).group(1))
        if mid in seen:
            continue
        holder = a
        for _ in range(4):  # climb to the element that holds both team names
            names = holder.select(".match-teamname, .matchTeamName, .team")
            if len(names) >= 2 or holder.parent is None:
                break
            holder = holder.parent
        names = [text(n) for n in holder.select(".match-teamname, .matchTeamName, .team")]
        unix = None
        for el in [holder] + holder.find_all(attrs={"data-unix": True}):
            if el.get("data-unix"):
                unix = int(el["data-unix"])
                break
        if unix is None and holder.get("data-zonedgrouping-entry-unix"):
            unix = int(holder["data-zonedgrouping-entry-unix"])
        fmt = text(holder.select_one(".match-meta, .matchMeta"))
        seen.add(mid)
        out.append({
            "id": mid,
            "slug": MATCH_HREF.search(a["href"]).group(2),
            "teams": names[:2],
            "unix_ms": unix,
            "format": fmt,
        })
    return out


def parse_events():
    events = {}
    for f in sorted(glob.glob(os.path.join(RAW, "events", "*.html.gz"))):
        base = os.path.basename(f).replace(".html.gz", "")
        if base.endswith("-matches"):
            eid = int(base.split("-")[0])
            events.setdefault(eid, {})["upcoming"] = parse_upcoming(load(f))
        elif base.endswith("-results"):
            eid = int(base.split("-")[0])
            events.setdefault(eid, {})["results"] = parse_results_page(load(f))
        else:
            eid = int(base)
            events.setdefault(eid, {}).update(parse_event_page(load(f)))
    return events


def main():
    os.makedirs(OUT, exist_ok=True)
    rows, nfiles = parse_results("results")
    lan, nlan = parse_results("results-lan")
    lan_ids = set(lan)
    print(f"results: {len(rows)} matches from {nfiles} pages; LAN pages {nlan} -> {len(lan_ids)} LAN matches")
    missing_lan = len(lan_ids - set(rows))
    if missing_lan:
        print(f"  note: {missing_lan} LAN matches not in the all-results pages (added)")
        for k in lan_ids - set(rows):
            rows[k] = lan[k]

    fields = ["id", "unix_ms", "date", "team1", "team2", "maps1", "maps2", "score1", "score2",
              "format", "bo1_map", "event", "stars", "lan", "slug"]
    bad = 0
    with open(os.path.join(OUT, "matches.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in sorted(rows.values(), key=lambda r: (r["unix_ms"] or 0, r["id"])):
            if not r["unix_ms"]:
                bad += 1
                continue
            m1, m2 = maps_won(r)
            w.writerow({
                **{k: r[k] for k in ("id", "unix_ms", "team1", "team2", "score1", "score2",
                                     "format", "bo1_map", "event", "stars", "slug")},
                "date": datetime.fromtimestamp(r["unix_ms"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
                "maps1": m1,
                "maps2": m2,
                "lan": int(r["id"] in lan_ids),
            })
    if bad:
        print(f"  skipped {bad} matches without a timestamp")

    ranks = parse_rankings()
    with open(os.path.join(OUT, "rankings.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "rank", "team", "team_id", "points", "players"])
        w.writeheader()
        w.writerows(ranks)
    ndates = len(set(r["date"] for r in ranks))
    print(f"rankings: {len(ranks)} rows over {ndates} dates")

    events = parse_events()
    with open(os.path.join(OUT, "events.json"), "w") as f:
        json.dump(events, f, indent=1)
    for eid, e in events.items():
        print(f"event {eid}: {e.get('title')!r}: {len(e.get('teams', []))} teams, "
              f"{len(e.get('upcoming', []))} upcoming, {len(e.get('results', []))} played")

    if not rows or not ranks:
        print("\nWARNING: something parsed empty; check the raw HTML selectors.", file=sys.stderr)


if __name__ == "__main__":
    main()
