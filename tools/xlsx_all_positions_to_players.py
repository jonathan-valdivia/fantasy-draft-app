#!/usr/bin/env python3
import sys, os, re, json, traceback
from typing import Dict, Any, List, Optional
import pandas as pd

SHEET_NAMES = ["QB", "RB", "WR", "TE", "K", "DST"]
DERIVE_PROJ_PTS_IF_MISSING = False

def log(*a): print("[xlsx->players]", *a)

def slugify(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', (s or "").lower()).strip('_')

def to_float(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return None
    s = str(v).strip().replace(",", "")
    try: return float(s)
    except: return None

def parse_player_and_team(s: str):
    if not s: return None, None
    s = str(s).strip()
    m = re.match(r'^(.*)\s+\(([A-Za-z]{2,4})\)\s*$', s)
    if m: return m.group(1).strip(), m.group(2).upper()
    return s, None

def find_header_row(df: pd.DataFrame) -> int:
    """
    Find the first row index that *looks* like the header row.
    We accept 'player' even if there are weird spaces/non-ASCII.
    """
    def norm_cell(x):
        s = "" if x is None else str(x)
        # strip non-breaking spaces and compress spaces
        s = s.replace("\u00A0", " ").replace("\u2007"," ").replace("\u202F"," ")
        s = re.sub(r"\s+", " ", s).strip().lower()
        return s

    for i in range(min(20, len(df))):
        row = [norm_cell(x) for x in list(df.iloc[i].values)]
        if any("player" == c or c.endswith(" player") or "player" in c for c in row):
            return i
    # fallback: look for a row that has lots of known column tokens
    tokens = {"rank","player","cmp","att","pct","yds","y/a","td","int","sacks","fl","g","fpts","fpts/g","rost"}
    best_i, best_score = 0, -1
    for i in range(min(20, len(df))):
        row = [norm_cell(x) for x in list(df.iloc[i].values)]
        score = sum(1 for c in row if c in tokens)
        if score > best_score:
            best_i, best_score = i, score
    return best_i


def flatten_multiindex_columns(df: pd.DataFrame) -> pd.DataFrame:
    flat = []
    for a, b in df.columns:
        a = (str(a) if a is not None else "").strip().lower()
        b = (str(b) if b is not None else "").strip().lower()
        flat.append(f"{a}_{b}" if a and a != "nan" else b)
    df.columns = flat
    return df

def disambiguate_qb_columns(cols: List[str]) -> List[str]:
    out, pass_seen = [], 0
    for c in cols:
        lc = (c or "").strip().lower()
        if lc in ("cmp","att","pct","yds","y/a","td","int","sacks"):
            if lc == "att" and "passing_att" in out: out.append("rushing_att"); continue
            if lc == "yds" and "passing_yds" in out and pass_seen >= 3: out.append("rushing_yds"); continue
            if lc == "td" and "passing_td" in out and pass_seen >= 5: out.append("rushing_td"); continue
            pass_seen += 1
            out.append({
                "cmp":"passing_cmp","att":"passing_att","pct":"passing_pct","yds":"passing_yds",
                "y/a":"passing_y_a","td":"passing_td","int":"passing_int","sacks":"passing_sacks"
            }[lc])
        elif lc in ("fl","g","fpts","fpts/g","rost"):
            out.append({"fl":"misc_fl","g":"games","fpts":"fpts","fpts/g":"fpts_g","rost":"rost"}[lc])
        else:
            out.append(lc)
    return out

def disambiguate_rbwrte_columns(cols: List[str]) -> List[str]:
    lower = [ (c or "").strip().lower() for c in cols ]
    idx_rec = lower.index("rec") if "rec" in lower else 10**9
    idx_att = lower.index("att") if "att" in lower else 10**9
    receiving_first = idx_rec < idx_att

    out = []
    for lc in lower:
        if lc in ("rec","tgt","yds","y/r","td","lg","20+"):
            if receiving_first:
                out.append({
                    "rec":"rec","tgt":"tgt","yds":"rec_yds","y/r":"ypr","td":"rec_td","lg":"rec_lg","20+":"rec_20plus"
                }[lc])
            else:
                if lc == "att": out.append("rushing_att")
                elif lc == "yds": out.append("rushing_yds")
                elif lc == "td": out.append("rushing_td")
                else:
                    out.append({
                        "rec":"rec","tgt":"tgt","yds":"rec_yds","y/r":"ypr","td":"rec_td","lg":"rec_lg","20+":"rec_20plus"
                    }.get(lc, lc))
        elif lc in ("att","yds","td"):
            # rushing block in RB-first sheets
            if lc == "att": out.append("rushing_att")
            elif lc == "yds": out.append("rushing_yds")
            elif lc == "td": out.append("rushing_td")
        elif lc in ("fl","g","fpts","fpts/g","rost"):
            out.append({"fl":"misc_fl","g":"games","fpts":"fpts","fpts/g":"fpts_g","rost":"rost"}[lc])
        else:
            out.append(lc)
    return out

def parse_qb(xlsx_path: str) -> List[Dict[str, Any]]:
    log("Parsing QB…")
    # Always read as no-header, find the header row with 'Player'
    df = pd.read_excel(xlsx_path, sheet_name="QB", header=None)
    hdr = find_header_row(df)

    # Build column names from that header row, normalize
    raw_cols = [str(x) if x is not None else "" for x in df.iloc[hdr].values]
    cols = []
    for c in raw_cols:
        c0 = c.replace("\u00A0", " ").strip().lower()
        # unify some variations
        c0 = c0.replace("y/a", "y_per_a").replace("fpts/g","fpts_g")
        cols.append(c0)

    df = df.iloc[hdr+1:].reset_index(drop=True)
    df.columns = cols

    # Disambiguate PASSING vs RUSHING duplicates
    # Expected order after RB-like exports:
    # [rank, player, cmp, att, pct, yds, y_per_a, td, int, sacks, att, yds, td, fl, g, fpts, fpts_g, rost]
    mapped = []
    passing_seen = {"att":0, "yds":0, "td":0}
    for c in df.columns:
        lc = c
        if lc in ("cmp","att","pct","yds","y_per_a","td","int","sacks"):
            if lc == "att":
                if passing_seen["att"] == 0:
                    mapped.append("passing_att"); passing_seen["att"] += 1
                else:
                    mapped.append("rushing_att")
            elif lc == "yds":
                if passing_seen["yds"] == 0:
                    mapped.append("passing_yds"); passing_seen["yds"] += 1
                else:
                    mapped.append("rushing_yds")
            elif lc == "td":
                if passing_seen["td"] == 0:
                    mapped.append("passing_td"); passing_seen["td"] += 1
                else:
                    mapped.append("rushing_td")
            elif lc == "cmp":
                mapped.append("passing_cmp")
            elif lc == "pct":
                mapped.append("passing_pct")
            elif lc == "y_per_a":
                mapped.append("passing_y_a")
            elif lc == "int":
                mapped.append("passing_int")
            elif lc == "sacks":
                mapped.append("passing_sacks")
        elif lc in ("fl","g","fpts","fpts_g","rost"):
            mapped.append({"fl":"misc_fl","g":"games","fpts":"fpts","fpts_g":"fpts_g","rost":"rost"}[lc])
        else:
            mapped.append(lc)

    df.columns = mapped

    # Ensure we have a 'player' column
    if "player" not in df.columns:
        # Find the column that contains many '(TEAM)' strings in first rows
        candidate = None
        for c in df.columns:
            sample = [str(x) for x in df[c].head(10).tolist()]
            hits = sum(1 for s in sample if re.search(r"\([A-Za-z]{2,4}\)", s or ""))
            if hits >= 3:
                candidate = c; break
        if candidate:
            df = df.rename(columns={candidate: "player"})
        else:
            # last resort: try 'name'
            if "name" in df.columns:
                df = df.rename(columns={"name":"player"})

    out = []
    for _, row in df.iterrows():
        player = str(row.get("player") or "").strip()
        if not player: 
            continue
        name, team = parse_player_and_team(player)
        rec = {
            "id": f"{slugify(name)}|{slugify(team) if team else ''}|qb",
            "name": name, "position": "QB", "team": team,
            "proj_pts": to_float(row.get("fpts")),
            "proj_pass_yds": to_float(row.get("passing_yds")),
            "proj_pass_td": to_float(row.get("passing_td")),
            "proj_int": to_float(row.get("passing_int")),
            "proj_rush": to_float(row.get("rushing_att")),
            "proj_rush_yds": to_float(row.get("rushing_yds")),
            "proj_rush_td": to_float(row.get("rushing_td")),
        }
        # Skip blank rows
        if rec["name"] and any(v is not None for v in (rec["proj_pts"], rec["proj_pass_yds"], rec["proj_rush_yds"])):
            out.append(rec)

    out.sort(key=lambda r: -(r.get("proj_pts") or 0))
    log(f"QB parsed: {len(out)}")
    return out


def parse_rbwrte_generic(xls: pd.ExcelFile, sheet: str, position: str) -> List[Dict[str, Any]]:
    log(f"Parsing {sheet}…")
    df = pd.read_excel(xls, sheet_name=sheet, header=None)
    hdr = find_header_row(df)
    header_vals = [str(x).strip() for x in df.iloc[hdr].values]
    df = df.iloc[hdr+1:].reset_index(drop=True)
    df.columns = disambiguate_rbwrte_columns(header_vals)
    df.columns = [str(c).strip().lower() for c in df.columns]
    if "player" not in df.columns and "name" in df.columns:
        df = df.rename(columns={"name":"player"})

    out = []
    for _, row in df.iterrows():
        player = str(row.get("player") or "").strip()
        if not player: continue
        name, team = parse_player_and_team(player)
        item = {
            "id": f"{slugify(name)}|{slugify(team) if team else ''}|{position.lower()}",
            "name": name, "position": position, "team": team,
            "proj_pts": to_float(row.get("fpts")),
            "proj_rec": to_float(row.get("rec")),
            "proj_rec_yds": to_float(row.get("rec_yds")),
            "proj_rec_td": to_float(row.get("rec_td")),
            "proj_rush": to_float(row.get("rushing_att")),
            "proj_rush_yds": to_float(row.get("rushing_yds")),
            "proj_rush_td": to_float(row.get("rushing_td")),
        }
        if item["name"] and any(v is not None for v in (item["proj_pts"], item["proj_rec_yds"], item["proj_rush_yds"])):
            out.append(item)
    out.sort(key=lambda r: -(r.get("proj_pts") or 0))
    log(f"{sheet} parsed: {len(out)}")
    return out

def parse_k(xls: pd.ExcelFile) -> List[Dict[str, Any]]:
    log("Parsing K…")
    df = pd.read_excel(xls, sheet_name="K", header=None)
    hdr = find_header_row(df)
    df.columns = [str(x).strip() for x in df.iloc[hdr].values]
    df = df.iloc[hdr+1:].reset_index(drop=True)
    df.columns = [c.strip().lower() for c in df.columns]
    if "player" not in df.columns and "name" in df.columns:
        df = df.rename(columns={"name":"player"})

    out = []
    for _, row in df.iterrows():
        player = str(row.get("player") or "").strip()
        if not player: continue
        name, team = parse_player_and_team(player)
        item = {
            "id": f"{slugify(name)}|{slugify(team) if team else ''}|k",
            "name": name, "position": "K", "team": team,
            "proj_pts": to_float(row.get("fpts")),
        }
        if item["name"] and item["proj_pts"] is not None:
            out.append(item)
    out.sort(key=lambda r: -(r.get("proj_pts") or 0))
    log(f"K parsed: {len(out)}")
    return out

def parse_dst(xls: pd.ExcelFile) -> List[Dict[str, Any]]:
    log("Parsing DST…")
    df = pd.read_excel(xls, sheet_name="DST", header=None)
    hdr = find_header_row(df)
    df.columns = [str(x).strip() for x in df.iloc[hdr].values]
    df = df.iloc[hdr+1:].reset_index(drop=True)
    df.columns = [c.strip().lower() for c in df.columns]
    if "player" not in df.columns and "name" in df.columns:
        df = df.rename(columns={"name":"player"})

    out = []
    for _, row in df.iterrows():
        player = str(row.get("player") or "").strip()
        if not player: continue
        name, team = parse_player_and_team(player)
        item = {
            "id": f"{slugify(name)}|{slugify(team) if team else ''}|dst",
            "name": name, "position": "DST", "team": team,
            "proj_pts": to_float(row.get("fpts")),
        }
        if item["name"] and item["proj_pts"] is not None:
            out.append(item)
    out.sort(key=lambda r: -(r.get("proj_pts") or 0))
    log(f"DST parsed: {len(out)}")
    return out

def main(xlsx_path: str, out_json: str, out_csv: Optional[str] = None):
    log("Opening:", xlsx_path)
    xls = pd.ExcelFile(xlsx_path)
    found = [s.strip() for s in xls.sheet_names]
    log("Found sheets:", found)

    # Normalize sheet name map (trim spaces)
    name_map = { s.strip().upper(): s for s in xls.sheet_names }

    all_players: List[Dict[str,Any]] = []

    if "QB" in name_map:
        all_players.extend(parse_qb(xlsx_path))
    for pos in ("RB","WR","TE"):
        if pos in name_map:
            df = pd.read_excel(xls, sheet_name=name_map[pos], header=None)
            all_players.extend(parse_rbwrte_generic(xls, name_map[pos], pos))
    if "K" in name_map:
        all_players.extend(parse_k(xls))
    if "DST" in name_map:
        all_players.extend(parse_dst(xls))

    all_players.sort(key=lambda x: -(x.get("proj_pts") or 0))

    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(all_players, f, indent=2)
    log(f"Wrote {len(all_players)} players -> {out_json}")

    if out_csv:
        os.makedirs(os.path.dirname(out_csv), exist_ok=True)
        pd.DataFrame(all_players).to_csv(out_csv, index=False)
        log(f"Wrote merged CSV -> {out_csv}")

if __name__ == "__main__":
    try:
        xlsx_path = sys.argv[1] if len(sys.argv) > 1 else "data/players.xlsx"
        out_json = sys.argv[2] if len(sys.argv) > 2 else "backend/players.json"
        out_csv = sys.argv[3] if len(sys.argv) > 3 else None
        main(xlsx_path, out_json, out_csv)
    except Exception as e:
        print("\n[ERROR] Script failed:")
        traceback.print_exc()
        sys.exit(1)
