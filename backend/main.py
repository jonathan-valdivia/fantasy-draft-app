from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json
from pathlib import Path

app = FastAPI()

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # allow all for dev
    allow_methods=["*"],
    allow_headers=["*"],
)

players_file = Path(__file__).parent / "players.json"
picks = []

class Pick(BaseModel):
    player_id: int
    picked_by: str

@app.get("/players")
def get_players():
    with open(players_file) as f:
        return json.load(f)

@app.get("/picks")
def get_picks():
    return picks

@app.post("/picks")
def add_pick(pick: Pick):
    picks.append(pick.dict())
    return {"message": "Pick added", "picks": picks}
