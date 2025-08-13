from fastapi import FastAPI, Body
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Any, Optional
import csv, json, os, threading, time

app = FastAPI()
lock = threading.Lock()

# CORS (handy for dev; Nginx proxy will be used in Docker)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(DATA_DIR, "players.csv")
JSON_PATH = os.path.join(DATA_DIR, "players.json")

players: List[Dict[str, Any]] = []
picks: List[Dict[str, Any]] = []  # [{player_id, owner: "me"|"other", ts}]
picks_by_pos: Dict[str, int] = {"QB":0, "RB":0, "WR":0, "TE":0, "DST":0, "K":0}

settings: Dict[str, Any] = {
    "leagueSize": 12,
    "draftSlot": 6,
    "rounds": 16,
    "scoring": "ppr",              # "standard"|"half"|"ppr"
    "teamQBInfluence": 0.6,        # 0..1
    "runSensitivity": 1.0,         # 0..2
}

NUM_FIELDS = {
    "bye", "adp", "proj_pts", "proj_rec", "proj_rec_yds", "proj_rec_td",
    "proj_rush", "proj_rush_yds", "proj_rush_td",
    "proj_pass_yds", "proj_pass_td", "proj_int",
    "qb_pass_att", "qb_rush_share", "target_share"
}
KEY_MAP = {
    "name":"name","player":"name","player_name":"name",
    "pos":"position","position":"position",
    "tm":"team","team":"team",
    "bye":"bye","adp":"adp","proj":"proj_pts","proj_pts":"proj_pts",
    "targets":"target_share","target_share":"target_share",
    "qb_pass_att":"qb_pass_att","qb_att":"qb_pass_att","qb_attempts":"qb_pass_att",
    "qb_rush_share":"qb_rush_share","qb_run_share":"qb_rush_share",
    "rec":"proj_rec","rec_yds":"proj_rec_yds","rec_td":"proj_rec_td",
    "rush":"proj_rush","rush_yds":"proj_rush_yds","rush_td":"proj_rush_td",
    "pass_yds":"proj_pass_yds","pass_td":"proj_pass_td","int":"proj_int",
}

def to_number(v):
    try:
        if v is None or str(v).strip()=="":
            return None
        return float(v)
    except:
        return None

def make_id(name: str, team: Optional[str], pos: str) -> str:
    return f"{name.strip()}|{(team or '').strip()}|{pos.strip()}".lower()

def load_players_from_csv(path: str) -> List[Dict[str, Any]]:
    out = []
    with open(path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            norm = {}
            for k, v in row.items():
                if k is None: continue
                kh = k.strip().lower().replace(" ", "_")
                key = KEY_MAP.get(kh, kh)
                norm[key] = to_number(v) if key in NUM_FIELDS else (v.strip() if isinstance(v, str) else v)
            name = norm.get("name")
            pos = (norm.get("position") or "").upper()
            team = norm.get("team") or ""
            if not name or pos not in {"QB","RB","WR","TE","DST","K"}:
                continue
            pid = norm.get("id") or make_id(name, team, pos)
            norm["id"] = pid
            norm["position"] = pos
            out.append(norm)
    return out

def load_players_from_json(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        items = json.load(f)
    out = []
    for p in items:
        name = p.get("name")
        pos = (p.get("position") or "").upper()
        team = p.get("team") or ""
        if not name or pos not in {"QB","RB","WR","TE","DST","K"}:
            continue
        pid = p.get("id") or make_id(name, team, pos)
        p["id"] = pid
        p["position"] = pos
        for k in NUM_FIELDS:
            if k in p: p[k] = to_number(p[k])
        out.append(p)
    return out

def load_players():
    global players
    if os.path.exists(JSON_PATH):
        players = load_players_from_json(JSON_PATH)
    elif os.path.exists(CSV_PATH):
        players = load_players_from_csv(CSV_PATH)
    else:
        players = []
    players.sort(key=lambda x: (-(x.get("proj_pts") or 0), (x.get("adp") or 9999)))
    return len(players)

def rebuild_pos_counts():
    global picks_by_pos
    picks_by_pos = {"QB":0, "RB":0, "WR":0, "TE":0, "DST":0, "K":0}
    pid_to_pos = {p["id"]: p["position"] for p in players}
    for row in picks:
        pos = pid_to_pos.get(row["player_id"])
        if pos in picks_by_pos: picks_by_pos[pos] += 1

# init
load_players()
rebuild_pos_counts()

@app.get("/api/players")
def api_players():
    return {"players": players}

@app.get("/api/state")
def api_state():
    return {"picks": picks, "picks_by_pos": picks_by_pos}

@app.get("/api/settings")
def api_settings():
    return settings

@app.post("/api/settings")
def api_update_settings(body: Dict[str, Any] = Body(...)):
    with lock:
        for k, v in body.items():
            if k in settings: settings[k] = v
    return settings

@app.post("/api/pick")
def api_pick(body: Dict[str, Any] = Body(...)):
    pid = body.get("player_id")
    owner = body.get("owner") or "other"
    if not pid:
        return {"error": "player_id required"}
    with lock:
        if any(p["player_id"] == pid for p in picks):
            return {"error": "already taken"}
        pos = next((p["position"] for p in players if p["id"] == pid), None)
        if not pos: return {"error": "player not found"}
        picks.append({"player_id": pid, "owner": "me" if owner=="me" else "other", "ts": int(time.time())})
        if pos in picks_by_pos: picks_by_pos[pos] += 1
    return {"message": "ok"}

@app.post("/api/undo")
def api_undo():
    with lock:
        if not picks:
            return {"message": "no picks"}
        last = picks.pop()
        pid_to_pos = {p["id"]: p["position"] for p in players}
        pos = pid_to_pos.get(last["player_id"])
        if pos in picks_by_pos and picks_by_pos[pos] > 0:
            picks_by_pos[pos] -= 1
    return {"message": "ok"}

@app.post("/api/reset")
def api_reset():
    with lock:
        picks.clear()
        rebuild_pos_counts()
    return {"message": "ok"}

@app.post("/api/reload")
def api_reload():
    with lock:
        n = load_players()
        rebuild_pos_counts()
    return {"message": "reloaded", "players": n}
