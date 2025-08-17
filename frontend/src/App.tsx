import React, {
  useEffect,
  useMemo,
  useRef,
  useLayoutEffect,
  useState,
} from "react";
import { motion } from "framer-motion";
import {
  Save,
  Trash,
  Settings,
  Users,
  ChevronRight,
  ChevronDown,
  HelpCircle,
} from "lucide-react";
import ClearableSearchInput from "./components/ClearableSearchInput";

/**
 * Fantasy Draft Assistant (MVP) — Backend Synced
 * -------------------------------------------------------------
 * Single-file React app designed for an offline live draft where the user
 * might not be present. This version syncs through a tiny FastAPI backend
 * and proxies API calls via Nginx at /api, so there are no CORS issues.
 *
 * Key features:
 *  - Helper marks each real-world pick as it happens (yours + others)
 *  - Tracks your roster needs by league requirements
 *  - Recommends picks dynamically (VOR + roster need + run pivot + WR/TE QB context)
 *  - Snake-draft aware (shows next overall picks based on slot/league size)
 *  - Settings (league size, slot, rounds, scoring, etc.) are **server-synced**
 *  - Players are **preloaded on the backend** from players.csv/json
 *
 * API Endpoints (proxied via /api):
 *   GET  /api/players
 *   GET  /api/state
 *   GET  /api/settings
 *   POST /api/settings  { partial settings }
 *   POST /api/pick      { player_id, owner: "me"|"other" }
 *   POST /api/undo
 *   POST /api/reset
 */

// ------------------------ Types ------------------------

type Position = "QB" | "RB" | "WR" | "TE" | "DST" | "K";

export type Player = {
  id: string; // server-provided unique key
  name: string;
  position: Position;
  team?: string;
  bye?: number | null;
  adp?: number | null; // Average Draft Position
  proj_pts?: number | null; // season projection baseline
  proj_rec?: number | null;
  proj_rec_yds?: number | null;
  proj_rec_td?: number | null;
  proj_rush?: number | null;
  proj_rush_yds?: number | null;
  proj_rush_td?: number | null;
  proj_pass_yds?: number | null;
  proj_pass_td?: number | null;
  proj_int?: number | null;
  qb_pass_att?: number | null; // QB pass attempts (for WR team QB)
  qb_rush_share?: number | null; // how run-oriented QB is (0-1)
  target_share?: number | null;
};

type DraftSettings = {
  leagueSize: number; // number of drafters
  draftSlot: number; // your pick number in snake (1-based)
  rounds: number; // total rounds
  scoring: "standard" | "half" | "ppr";
  teamQBInfluence: number; // how much QB volume influences WR/TE (0-1)
  runSensitivity: number; // how much to react to positional runs (0-2)
};

type Pos = "ALL" | "QB" | "RB" | "WR" | "TE" | "K" | "DST";

const POSITIONS: Pos[] = ["ALL", "QB", "RB", "WR", "TE", "K", "DST"];

// Roster template
const ROSTER_TEMPLATE: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1, // RB/WR/TE
  DST: 1,
  K: 1,
  BENCH: 7,
  IR: 1,
};

// Positions eligible for FLEX
const FLEX_ELIGIBLE: Position[] = ["RB", "WR", "TE"];

// --------------------- API helpers ---------------------

const api = {
  async getPlayers(): Promise<Player[]> {
    const r = await fetch("/api/players");
    const j = await r.json();
    return j.players || [];
  },
  async getState() {
    const r = await fetch("/api/state");
    return r.json();
  },
  async getSettings(): Promise<DraftSettings> {
    const r = await fetch("/api/settings");
    return r.json();
  },
  async updateSettings(partial: Partial<DraftSettings>) {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    });
  },
  async pick(player_id: string, owner: "me" | "other") {
    await fetch("/api/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id, owner }),
    });
  },
  async undo() {
    await fetch("/api/undo", { method: "POST" });
  },
  async reset() {
    await fetch("/api/reset", { method: "POST" });
  },
};

// Compute upcoming overall pick numbers for your slot in a snake draft
const getUpcomingPickIndexes = (
  settings: DraftSettings,
  totalPicksMade: number,
  count = 24 // just how many you want back; not a window
) => {
  const { leagueSize, draftSlot, rounds } = settings;
  const startPick = totalPicksMade + 1; // overall pick that is on the clock
  const lastPick = rounds * leagueSize;

  const upcoming: number[] = [];

  // Start from the round that contains startPick and walk to the end
  for (let r = Math.ceil(startPick / leagueSize); r <= rounds; r++) {
    const firstOfRound = (r - 1) * leagueSize + 1;

    // In odd rounds slots go 1..N, in even rounds N..1
    const myPickThisRound =
      r % 2 === 1
        ? firstOfRound + (draftSlot - 1)
        : firstOfRound + (leagueSize - draftSlot);

    if (myPickThisRound >= startPick && myPickThisRound <= lastPick) {
      upcoming.push(myPickThisRound);
      if (upcoming.length >= count) break;
    }
  }
  return upcoming;
};

// Replacement level baselines by position (rough initial assumptions)
const replacementRank: Record<Position, number> = {
  QB: 12,
  RB: 24,
  WR: 30,
  TE: 12,
  DST: 12,
  K: 12,
};

// Positional weights per scoring (affects base value scaling slightly)
const scoringWeights = {
  standard: { QB: 1.0, RB: 1.05, WR: 1.0, TE: 1.0, DST: 0.6, K: 0.5 },
  half: { QB: 1.0, RB: 1.0, WR: 1.02, TE: 1.0, DST: 0.6, K: 0.5 },
  ppr: { QB: 1.0, RB: 0.98, WR: 1.05, TE: 1.03, DST: 0.6, K: 0.5 },
} as const;

// ADDED 8.13.2025
// hard caps (your team)
const MAX_BY_POSITION: Partial<Record<Position, number>> = {
  QB: 1,
  DST: 1,
  K: 1,
  TE: 2,
  // others unlimited for now
};

// helper: how many starters at a position are required (no bench/flex)
const STARTERS_ONLY: Record<Position, number> = {
  QB: ROSTER_TEMPLATE.QB,
  RB: ROSTER_TEMPLATE.RB,
  WR: ROSTER_TEMPLATE.WR,
  TE: ROSTER_TEMPLATE.TE,
  DST: ROSTER_TEMPLATE.DST,
  K: ROSTER_TEMPLATE.K,
};

// early-round positional priority
function priorityWeight(pos: Position, round: number): number {
  // round 1: WR/RB only (QB hard-avoid)
  if (round === 1) {
    if (pos === "WR" || pos === "RB") return 1.25;
    if (pos === "QB") return 0.05; // "no QB round 1"
    if (pos === "TE") return 0.9;
    if (pos === "K" || pos === "DST") return 0.05;
  }
  // round 2: still heavy WR/RB, QB still discouraged
  if (round === 2) {
    if (pos === "WR" || pos === "RB") return 1.2;
    if (pos === "QB") return 0.4;
    if (pos === "TE") return 0.95;
    if (pos === "K" || pos === "DST") return 0.1;
  }
  // rounds 3–5: WR/RB lead, QB OK-ish, TE ok, K/DST low
  if (round >= 3 && round <= 5) {
    if (pos === "WR" || pos === "RB") return 1.15;
    if (pos === "QB") return 0.9;
    if (pos === "TE") return 1.0;
    if (pos === "K" || pos === "DST") return 0.2;
  }
  // rounds 6–9: balanced, K/DST still low
  if (round >= 6 && round <= 9) {
    if (pos === "WR" || pos === "RB") return 1.05;
    if (pos === "QB") return 1.0;
    if (pos === "TE") return 1.0;
    if (pos === "K" || pos === "DST") return 0.4;
  }
  // rounds 10+: K/DST become acceptable; rest normalized
  if (round >= 10) {
    if (pos === "K" || pos === "DST") return 1.0;
    return 1.0;
  }
  return 1.0;
}

// ---------------- Heuristic Draft Model ----------------

type ModelInputs = {
  settings: DraftSettings;
  yourRoster: Record<string, Player[]>; // by slot buckets (QB, RB, WR, TE, FLEX, DST, K, BENCH)
  takenIds: Set<string>; // includes your picks + opponents’ picks
  playerPool: Player[];
  picksByPos: Record<Position, number>; // counts taken so far
};

function rankPlayers({
  settings,
  yourRoster,
  takenIds,
  playerPool,
  picksByPos,
}: ModelInputs) {
  const weights = scoringWeights[settings.scoring];

  // count how many of a pos are on your full roster (inc. FLEX where applicable)
  const countOnRoster = (pos: Position) =>
    (yourRoster[pos]?.length || 0) +
    (pos !== "DST" && pos !== "K"
      ? yourRoster["FLEX"]?.filter((p) => p.position === pos).length || 0
      : 0);

  // starters remaining (excluding bench/flex)
  const startersRemaining = (pos: Position) => {
    const have = yourRoster[pos]?.length || 0;
    const need = STARTERS_ONLY[pos] || 0;
    return Math.max(0, need - have);
  };

  // FLEX open slots count
  const flexOpen = Math.max(
    0,
    ROSTER_TEMPLATE.FLEX - (yourRoster["FLEX"]?.length || 0)
  );

  // bye distribution for your current roster (by position)
  const byeCounts: Record<Position, Record<string, number>> = {
    QB: {},
    RB: {},
    WR: {},
    TE: {},
    DST: {},
    K: {},
  };
  (["QB", "RB", "WR", "TE", "DST", "K"] as Position[]).forEach((pos) => {
    const list = (yourRoster[pos] || []).concat(
      pos !== "DST" && pos !== "K"
        ? (yourRoster["FLEX"] || []).filter((p) => p.position === pos)
        : []
    );
    for (const p of list) {
      const k = String(p.bye ?? "");
      byeCounts[pos][k] = (byeCounts[pos][k] || 0) + 1;
    }
  });

  // group available by pos, sorted by proj
  const byPos: Record<Position, Player[]> = {
    QB: [],
    RB: [],
    WR: [],
    TE: [],
    DST: [],
    K: [],
  };
  playerPool.forEach((p) => {
    if (!takenIds.has(p.id)) byPos[p.position].push(p);
  });
  (Object.keys(byPos) as Position[]).forEach((pos) => {
    byPos[pos].sort((a, b) => (b.proj_pts ?? 0) - (a.proj_pts ?? 0));
  });

  const replacementValue: Record<Position, number> = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    DST: 0,
    K: 0,
  };
  (Object.keys(byPos) as Position[]).forEach((pos) => {
    const idx = Math.min(replacementRank[pos] - 1, byPos[pos].length - 1);
    replacementValue[pos] = idx >= 0 ? byPos[pos][idx].proj_pts ?? 0 : 0;
  });

  const totalTaken = Object.values(picksByPos).reduce((a, b) => a + b, 0) || 1;
  const evenShare: Record<Position, number> = {
    QB: 0.17,
    RB: 0.27,
    WR: 0.27,
    TE: 0.1,
    DST: 0.1,
    K: 0.09,
  };
  const runBias: Record<Position, number> = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    DST: 0,
    K: 0,
  };
  (Object.keys(picksByPos) as Position[]).forEach((pos) => {
    const actual = picksByPos[pos] / totalTaken;
    runBias[pos] = settings.runSensitivity * (actual - (evenShare[pos] || 0));
  });

  // compute current round from total picks made
  const totalPicksMade = Object.values(picksByPos).reduce((a, b) => a + b, 0);
  const currentRound = Math.max(
    1,
    Math.ceil((totalPicksMade + 1) / settings.leagueSize)
  );

  type Scored = { player: Player; score: number; explain: string };
  const scored: Scored[] = [];

  for (const p of playerPool) {
    if (takenIds.has(p.id)) continue;

    // enforce caps: skip if we already reached the cap for this position
    const cap = MAX_BY_POSITION[p.position as Position];
    if (cap !== undefined && countOnRoster(p.position) >= cap) continue;

    const base = (p.proj_pts ?? 0) * (weights[p.position] || 1.0);
    const vor = (p.proj_pts ?? 0) - (replacementValue[p.position] || 0);

    // Team QB influence for WR/TE
    let qbAdj = 0;
    if (
      (p.position === "WR" || p.position === "TE") &&
      settings.teamQBInfluence > 0
    ) {
      const passAtt = p.qb_pass_att ?? 550;
      const qbRun = Math.min(Math.max(p.qb_rush_share ?? 0.2, 0), 0.8);
      qbAdj =
        settings.teamQBInfluence *
        ((passAtt - 520) * 0.02 + (0.3 - qbRun) * 20);
    }

    // Starter-first boost: if starter(s) at this position are not yet filled, boost more.
    const startersLeft = startersRemaining(p.position);
    // fractional flex share still available for RB/WR/TE
    const fractionalFlex =
      FLEX_ELIGIBLE.includes(p.position) && flexOpen > 0
        ? flexOpen / FLEX_ELIGIBLE.length
        : 0;
    const needUnits = startersLeft + fractionalFlex; // how many "useful slots" remain

    // Stronger boost for unfilled starters, lighter if only bench remains
    const starterBoost = startersLeft > 0 ? 1.35 : 1.0;
    const benchDamp = startersLeft === 0 ? 0.93 : 1.0; // once starters filled, slightly de-emphasize piling more

    // Pivot bonus (avoid chasing runs)
    const pivotBonus = 1 + Math.max(0, 0.15 - Math.max(0, runBias[p.position]));

    // ADP small helper (overall ADP expected)
    const adpHelp = p.adp ? Math.max(0, (100 - p.adp) * 0.01) : 0;

    // Early-round positional priority (no QB in round 1, WR/RB early, K/DST late)
    const prio = priorityWeight(p.position, currentRound);

    // Bye diversification: small penalty if we already have 2+ with the same bye in this position
    let byeAdj = 1.0;
    if (p.bye != null) {
      const k = String(p.bye);
      const already = byeCounts[p.position][k] || 0;
      if (already >= 2)
        byeAdj *= 0.94; // avoid stacking 3+ same-bye at same position
      else if (already === 1) byeAdj *= 0.98;
    }

    // Final scoring
    const score = base + vor * 1.4 + qbAdj;
    const finalScore =
      score *
        (1 + 0.18 * Math.min(2, needUnits)) * // more open "useful slots" => higher weight
        starterBoost *
        benchDamp *
        pivotBonus *
        prio *
        byeAdj +
      adpHelp;

    scored.push({
      player: p,
      score: finalScore,
      explain: `base=${base.toFixed(1)} vor=${vor.toFixed(
        1
      )} qbAdj=${qbAdj.toFixed(1)} starterBoost=${starterBoost.toFixed(
        2
      )} prio=${prio.toFixed(2)} pivot=${pivotBonus.toFixed(
        2
      )} byeAdj=${byeAdj.toFixed(2)} adpHelp=${adpHelp.toFixed(2)}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ----------------------- UI -----------------------

// add props: className, bodyClassName
const SectionCard: React.FC<{
  title: string;
  children: any;
  defaultOpen?: boolean;
  right?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}> = ({
  title,
  children,
  defaultOpen = true,
  right,
  className = "",
  bodyClassName = "",
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-2xl shadow p-4 bg-white ${className}`}>
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <h3 className="font-semibold text-lg">{title}</h3>
        </div>
        <div className="flex items-center gap-3">{right}</div>
      </div>
      {open && <div className={`pt-3 ${bodyClassName}`}>{children}</div>}
    </div>
  );
};

const IconButton: React.FC<{
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, danger, children }) => (
  <button
    title={title}
    onClick={onClick}
    className={`p-2 rounded-xl border hover:bg-gray-50 transition ${
      danger ? "text-red-600 border-red-200 hover:bg-red-50" : ""
    }`}
    aria-label={title}
  >
    {children}
  </button>
);

const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}> = ({ open, onClose, title, children }) => {
  // close on ESC, lock body scroll
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="dialog"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" />
      {/* Panel */}
      <div
        className="relative bg-white rounded-2xl shadow-xl w-[min(96vw,820px)] max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="px-2 py-1 rounded-lg border hover:bg-gray-50 text-sm"
          >
            Close
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
};

// very light tints for each position
const POS_BG: Record<Position, string> = {
  WR: "bg-blue-50",
  RB: "bg-red-50",
  TE: "bg-green-50",
  QB: "bg-yellow-50",
  DST: "bg-gray-50",
  K: "bg-black/15", // "very light black"
};

// ----- Taken Grid Helpers (snake mapping) -----
function getRoundAndSlot(overallPick: number, leagueSize: number) {
  const round = Math.ceil(overallPick / leagueSize);
  const pickInRound = ((overallPick - 1) % leagueSize) + 1;
  const slot = round % 2 === 1 ? pickInRound : leagueSize - pickInRound + 1;
  return { round, slot };
}

// Build [round][slot] => Player | null
function buildTakenGrid(
  picks: { player_id: string; owner: "me" | "other"; ts: number }[],
  players: Player[],
  settings: DraftSettings
) {
  const { leagueSize, rounds } = settings;
  const grid: (Player | null)[][] = Array.from({ length: rounds }, () =>
    Array.from({ length: leagueSize }, () => null)
  );
  const byId = new Map(players.map((p) => [p.id, p]));

  for (let i = 0; i < picks.length; i++) {
    const overall = i + 1;
    const { round, slot } = getRoundAndSlot(overall, leagueSize);
    if (round >= 1 && round <= rounds) {
      grid[round - 1][slot - 1] = byId.get(picks[i].player_id) ?? null;
    }
  }
  return grid;
}

const PositionPanel: React.FC<{
  title: Position;
  players: Player[];
  onMyPick: (p: Player) => void;
  onOtherPick: (p: Player) => void;
}> = ({ title, players, onOtherPick }) => {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    if (!q) return players;
    const s = q.toLowerCase();
    return players.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.team || "").toLowerCase().includes(s)
    );
  }, [q, players]);

  return (
    <div className={`border rounded-2xl p-3 ${POS_BG[title]}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
      </div>

      <ClearableSearchInput
        value={q}
        onChange={setQ}
        placeholder={`Search ${title}…`}
        className="mb-2"
      />

      <div className="max-h-72 overflow-y-auto rounded-lg">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white/70 backdrop-blur">
            <tr className="[&>th]:text-left [&>th]:py-2 [&>th]:px-2">
              <th className="w-1/2">Player</th>
              <th>Team</th>
              <th className="text-right">Proj</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="py-1.5 px-2">{p.name}</td>
                <td className="py-1.5 px-2">{p.team || ""}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">
                  {p.proj_pts?.toFixed(1) ?? "—"}
                </td>
                <td className="py-1.5 px-2 text-right">
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded-lg bg-rose-500 text-white hover:bg-rose-600"
                      onClick={() => onOtherPick(p)}
                    >
                      Taken
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-sm opacity-60">
                  No players match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [picks, setPicks] = useState<
    { player_id: string; owner: "me" | "other"; ts: number }[]
  >([]);
  const [picksByPos, setPicksByPos] = useState<Record<Position, number>>({
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    DST: 0,
    K: 0,
  });
  const [settings, setSettings] = useState<DraftSettings>({
    leagueSize: 12,
    draftSlot: 6,
    rounds: 16,
    scoring: "ppr",
    teamQBInfluence: 0.6,
    runSensitivity: 1.0,
  });

  // Read-only board mode (share: ?mode=board or #board)
  const isBoard =
    typeof window !== "undefined" &&
    (new URLSearchParams(window.location.search).get("mode") === "board" ||
      window.location.hash === "#board");

  const [filter, setFilter] = useState("");
  const [posFilter, setPosFilter] = useState<Position | "ALL">("ALL");
  const [showWhy, setShowWhy] = useState(false);
  // NEW: which main pane is visible
  const [activePane, setActivePane] = useState<"PICKER" | "PLAYERS" | "TAKEN">(
    isBoard ? "TAKEN" : "PICKER"
  );

  const takenSet = useMemo(
    () => new Set(picks.map((p) => p.player_id)),
    [picks]
  );
  const yourIds = useMemo(
    () => picks.filter((p) => p.owner === "me").map((p) => p.player_id),
    [picks]
  );

  const leftColRef = useRef<HTMLDivElement>(null);
  const [leftHeight, setLeftHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!leftColRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect?.height || 0;
      setLeftHeight(h);
    });
    ro.observe(leftColRef.current);
    return () => ro.disconnect();
  }, []);

  const picksDesc = useMemo(() => [...picks].reverse(), [picks]);

  const availablePlayers = useMemo(
    () => players.filter((p) => !takenSet.has(p.id)),
    [players, takenSet]
  );

  const playersByPos = useMemo(() => {
    const map: Record<Position, Player[]> = {
      QB: [],
      RB: [],
      WR: [],
      TE: [],
      DST: [],
      K: [],
    };
    for (const p of availablePlayers) {
      map[p.position].push(p);
    }
    (["QB", "RB", "WR", "TE", "K", "DST"] as Position[]).forEach((pos) => {
      map[pos].sort((a, b) => (b.proj_pts ?? 0) - (a.proj_pts ?? 0));
    });
    return map;
  }, [availablePlayers]);

  // Grid of all taken players by [round][slot]
  const takenGrid = useMemo(
    () => buildTakenGrid(picks, players, settings),
    [picks, players, settings]
  );

  const [settingsOpen, setSettingsOpen] = useState(false);

  function findSlotForPlayer(p: Player, by: Record<string, Player[]>) {
    const need = (slot: string, count: number) =>
      (by[slot]?.length || 0) < count;
    if (p.position === "QB" && need("QB", ROSTER_TEMPLATE.QB)) return "QB";
    if (p.position === "RB" && need("RB", ROSTER_TEMPLATE.RB)) return "RB";
    if (p.position === "WR" && need("WR", ROSTER_TEMPLATE.WR)) return "WR";
    if (p.position === "TE" && need("TE", ROSTER_TEMPLATE.TE)) return "TE";
    if (p.position === "DST" && need("DST", ROSTER_TEMPLATE.DST)) return "DST";
    if (p.position === "K" && need("K", ROSTER_TEMPLATE.K)) return "K";
    if (
      FLEX_ELIGIBLE.includes(p.position) &&
      need("FLEX", ROSTER_TEMPLATE.FLEX)
    )
      return "FLEX";
    return "BENCH";
  }

  const yourRoster: Record<string, Player[]> = useMemo(() => {
    const by: Record<string, Player[]> = {
      QB: [],
      RB: [],
      WR: [],
      TE: [],
      FLEX: [],
      DST: [],
      K: [],
      BENCH: [],
      IR: [],
    };
    const chosen = yourIds
      .map((id) => players.find((p) => p.id === id))
      .filter(Boolean) as Player[];
    // Allocate in sequence
    for (const p of chosen) {
      const slot = findSlotForPlayer(p, by) || "BENCH";
      by[slot].push(p);
    }
    return by;
  }, [yourIds, players]);

  // Rank
  const scored = useMemo(
    () =>
      rankPlayers({
        settings,
        yourRoster,
        takenIds: takenSet,
        playerPool: players,
        picksByPos,
      }),
    [settings, yourRoster, takenSet, players, picksByPos]
  );

  // How many you already have at each position
  const rosterCounts = useMemo(() => {
    const counts: Record<Position, number> = {
      QB: 0,
      RB: 0,
      WR: 0,
      TE: 0,
      DST: 0,
      K: 0,
    };
    for (const id of yourIds) {
      const p = players.find((x) => x.id === id);
      if (p) counts[p.position]++;
    }
    return counts;
  }, [yourIds, players]);

  // filter out positions that hit caps, then apply pos/search filters
  const filtered = useMemo(() => {
    return scored.filter((s) => {
      const pos = s.player.position;

      // cap enforcement (e.g., QB ≤ 2, DST ≤ 1)
      const cap = MAX_BY_POSITION[pos];
      if (cap !== undefined && rosterCounts[pos] >= cap) return false;

      // position filter chip
      if (posFilter !== "ALL" && pos !== posFilter) return false;

      // text filter (name or team)
      if (filter) {
        const q = filter.toLowerCase();
        if (
          !s.player.name.toLowerCase().includes(q) &&
          !(s.player.team || "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }

      return true;
    });
  }, [scored, filter, posFilter, rosterCounts]);

  // change the amount of players that show in recommended
  const myRecommended = filtered.slice(0, 18);

  const totalPicksMade = picks.length;
  const myUpcoming = getUpcomingPickIndexes(settings, totalPicksMade, 12);
  const currentOverall = picks.length + 1; // the overall pick that would be on the clock now
  const nextOverall = myUpcoming[0] ?? null; // your next overall pick #
  const picksUntil = nextOverall
    ? Math.max(0, nextOverall - currentOverall)
    : null;

  // -------- Sync with backend --------
  async function refreshAll() {
    const [pls, st, se] = await Promise.all([
      api.getPlayers(),
      api.getState(),
      api.getSettings(),
    ]);
    setPlayers(pls);
    setPicks(st.picks || []);
    setPicksByPos(
      st.picks_by_pos || { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0, K: 0 }
    );
    setSettings(se);
  }

  useEffect(() => {
    refreshAll();
  }, []);
  useEffect(() => {
    const iv = setInterval(refreshAll, 1500); // lightweight polling for live sync
    return () => clearInterval(iv);
  }, []);

  async function markTaken(player: Player, owner: "me" | "other") {
    await api.pick(player.id, owner);
    await refreshAll();
  }

  async function undoLastPick() {
    await api.undo();
    await refreshAll();
  }
  async function clearAll() {
    if (confirm("Reset all picks?")) {
      await api.reset();
      await refreshAll();
    }
  }

  // Debounced settings updates
  function updateSetting<K extends keyof DraftSettings>(
    k: K,
    v: DraftSettings[K]
  ) {
    const next = { ...settings, [k]: v };
    setSettings(next);
    api.updateSettings({ [k]: v } as Partial<DraftSettings>).catch(() => {});
  }

  // ---------------- Read-only Board View ----------------
  if (isBoard) {
    const jvIndex = settings.draftSlot - 1;
    const JV_TH_CLASS =
      "ring-2 ring-amber-400 ring-offset-1 ring-offset-gray-100 rounded-md";
    const JV_TD_CLASS =
      "ring-2 ring-amber-400 ring-offset-1 ring-offset-white rounded-md";
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto p-4 md:p-6">
          <motion.h1
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-2xl md:text-3xl font-bold mb-3"
          >
            JVLOOKUP — Draft Board (Read-only)
          </motion.h1>
          <SectionCard
            title="All Taken (Rounds × Slots)"
            right={<span className="text-xs text-gray-500">auto-updating</span>}
            defaultOpen
          >
            <div className="overflow-auto border rounded-2xl">
              <table className="w-full text-sm">
                <thead className="bg-gray-100 text-gray-700 sticky top-0">
                  <tr>
                    <th className="p-2 text-left w-28">Round</th>
                    {Array.from({ length: settings.leagueSize }).map((_, i) => (
                      <th
                        key={i}
                        className={`p-2 text-left whitespace-nowrap ${
                          i === jvIndex ? JV_TH_CLASS : ""
                        }`}
                      >
                        {i + 1 === settings.draftSlot ? "JV" : i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {takenGrid.map((row, rIdx) => (
                    <tr key={rIdx} className="border-t">
                      <td className="p-2 font-semibold text-gray-600">
                        ROUND {rIdx + 1}
                      </td>
                      {row.map((player, sIdx) => {
                        const bg = player
                          ? POS_BG[player.position as Position] ?? ""
                          : "";
                        return (
                          <td
                            key={sIdx}
                            className={`p-2 align-top ${bg} ${
                              sIdx === jvIndex ? JV_TD_CLASS : ""
                            }`}
                          >
                            {player ? (
                              <div>
                                <div className="font-medium leading-tight">
                                  {player.name}
                                </div>
                                <div className="text-xs text-gray-700">
                                  {player.position}
                                  {player.team ? ` · ${player.team}` : ""}
                                </div>
                              </div>
                            ) : (
                              <span className="opacity-40">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-4 md:p-6">
        <div className="flex items-center justify-between mb-2">
          <motion.h1
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-2xl md:text-3xl font-bold"
          >
            JVLOOKUP - Fantasy Draft Assistant
          </motion.h1>
          <div className="flex items-center gap-2">
            <IconButton
              title="Draft settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={18} />
            </IconButton>
            <IconButton title="Undo last pick" onClick={undoLastPick}>
              UNDO
            </IconButton>
            <IconButton title="Reset draft" onClick={clearAll} danger>
              <Trash size={18} />
            </IconButton>
          </div>
        </div>

        {/* Top Controls */}
        <div className="grid md:grid-cols gap-4 mb-4">
          <SectionCard title="Roster Snapshot" right={<Users size={18} />}>
            <div className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
              {(
                ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BENCH"] as const
              ).map((slot) => (
                <div key={slot} className="">
                  <div className="text-gray-500">{slot}</div>
                  <div className="font-medium">
                    {yourRoster[slot]?.map((p) => p.name).join(", ") || "—"}
                  </div>
                </div>
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              Starters filled: QB {rosterCounts.QB}/{ROSTER_TEMPLATE.QB}, RB{" "}
              {rosterCounts.RB}/{ROSTER_TEMPLATE.RB}, WR {rosterCounts.WR}/
              {ROSTER_TEMPLATE.WR}, TE {rosterCounts.TE}/{ROSTER_TEMPLATE.TE},
              DST {rosterCounts.DST}/{ROSTER_TEMPLATE.DST}, K {rosterCounts.K}/
              {ROSTER_TEMPLATE.K}
            </div>
          </SectionCard>
        </div>

        <div className="grid grid-cols-3 mb-4">
          <SectionCard
            title="Snake Draft Planner"
            right={
              <span className="text-xs text-gray-500">upcoming picks</span>
            }
          >
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-700">
                Your next picks (overall): {myUpcoming.join(", ") || "—"}
                <div className="text-xs text-gray-500 mt-1">
                  Based on league size {settings.leagueSize}, slot{" "}
                  {settings.draftSlot}, rounds {settings.rounds}.
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide">
                  Picks until you're up
                </div>
                <div className="text-3xl font-bold">{picksUntil ?? "—"}</div>
              </div>
            </div>
          </SectionCard>
          <SectionCard
            title="Position Run Radar"
            right={<span className="text-xs text-gray-500">live trend</span>}
          >
            <div className="grid grid-cols-3 gap-2 text-sm">
              {(Object.keys(picksByPos) as Position[]).map((pos) => (
                <div
                  key={pos}
                  className="rounded-xl border p-1 bg-white flex flex-col"
                >
                  <div className="text-xs text-gray-500">{pos}</div>
                  <div className="text-md font-semibold">
                    {picksByPos[pos] || 0}
                  </div>
                </div>
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              As certain positions spike, recommendations will pivot to exploit
              value rather than chase runs blindly.
            </div>
          </SectionCard>
          <SectionCard
            title="Last 3 Picks"
            className="h-full"
            bodyClassName="flex flex-col min-h-0"
          >
            {/* This is the only part that grows and scrolls */}
            <div className="flex-1 min-h-0 overflow-auto border rounded">
              <table className="w-full text-sm">
                <thead className="bg-gray-100 text-gray-600 sticky top-0">
                  <tr>
                    <th className="text-left">#</th>
                    <th className="text-left ">Player</th>
                    <th className="text-left ">Pos</th>
                    <th className="text-left">Team</th>
                    <th className="text-right ">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {picksDesc.slice(0, 3).map((row, i) => {
                    const p = players.find((x) => x.id === row.player_id);
                    if (!p) return null;
                    const displayNumber = picks.length - i; // newest first
                    return (
                      <tr
                        key={`${row.player_id}-${i}`}
                        className={`border-t transition-colors ${
                          row.owner === "me" ? "bg-yellow-100" : ""
                        }`}
                      >
                        <td className="p-2">{displayNumber}</td>
                        <td className="p-2">{p.name}</td>
                        <td className="p-2">{p.position}</td>
                        <td className="p-2">{p.team || ""}</td>
                        <td className="p-2 text-right">
                          {row.owner === "me" ? "JV" : "Other"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>

        {/* Switch between the two main panes */}
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setActivePane("PICKER")}
            className={`px-3 py-1 rounded-full border text-xl ${
              activePane === "PICKER"
                ? "bg-emerald-500 text-white border"
                : "hover:bg-black/5"
            }`}
          >
            Recomended
          </button>
          <button
            type="button"
            onClick={() => setActivePane("PLAYERS")}
            className={`px-3 py-1 rounded-full border text-xl ${
              activePane === "PLAYERS"
                ? "bg-emerald-500 text-white border"
                : "hover:bg-black/5"
            }`}
          >
            Available
          </button>
          <button
            type="button"
            onClick={() => setActivePane("TAKEN")}
            className={`px-3 py-1 rounded-full border text-xl ${
              activePane === "TAKEN"
                ? "bg-emerald-500 text-white border"
                : "hover:bg-black/5"
            }`}
          >
            All Taken
          </button>
        </div>

        {/* Picks & Recommendations */}
        {/* MAIN PANE: Picker */}
        {activePane === "PICKER" && (
          <div className="grid md:grid-cols gap-4 mb-4 items-stretch">
            <div className="md:col-span-2" ref={leftColRef}>
              <SectionCard title="Live Picks & Controls" defaultOpen>
                <ClearableSearchInput
                  value={filter}
                  onChange={setFilter}
                  placeholder="Search player or team…"
                  className="w-full"
                />
                <div className="flex flex-wrap gap-2 mt-3">
                  {POSITIONS.map((p) => {
                    const isActive = posFilter === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => setPosFilter(p)}
                        className={`px-3 py-1 rounded-full border text-sm
            ${
              isActive ? "bg-black text-white border-black" : "hover:bg-black/5"
            }`}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>

                <div className="border rounded-2xl overflow-hidden mt-3">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100 text-gray-600">
                      <tr>
                        <th className="text-left p-2">#</th>
                        <th className="text-left p-2">Player</th>
                        <th className="text-left p-2">Pos</th>
                        <th className="text-left p-2">Team</th>
                        <th className="text-right p-2">Proj</th>
                        <th className="text-right p-2">ADP</th>
                        <th className="text-right p-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myRecommended.map((s, i) => (
                        <tr key={s.player.id} className="border-t">
                          <td className="p-2">{i + 1}</td>
                          <td className="p-2 font-medium">{s.player.name}</td>
                          <td className="p-2">{s.player.position}</td>
                          <td className="p-2">{s.player.team || ""}</td>
                          <td className="p-2 text-right">
                            {s.player.proj_pts?.toFixed(1) ?? "—"}
                          </td>
                          <td className="p-2 text-right">
                            {s.player.adp ?? "—"}
                          </td>
                          <td className="p-2 text-right">
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => markTaken(s.player, "me")}
                                className="px-2 py-1 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600"
                              >
                                My Pick
                              </button>
                              <button
                                onClick={() => markTaken(s.player, "other")}
                                className="px-2 py-1 rounded-lg bg-rose-500 text-white hover:bg-rose-600"
                              >
                                Taken
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-600">
                  <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={showWhy}
                        onChange={(e) => setShowWhy(e.target.checked)}
                      />{" "}
                      Show scoring rationale
                    </label>
                  </div>
                  <div>
                    Players loaded: {players.length} · Picks made:{" "}
                    {picks.length}
                  </div>
                </div>

                {showWhy && (
                  <div className="mt-3 text-xs text-gray-600 border rounded-xl p-3 bg-gray-50">
                    {myRecommended.map((s) => (
                      <div
                        key={s.player.id}
                        className="py-1 border-b last:border-b-0"
                      >
                        <span className="font-medium">{s.player.name}</span>:{" "}
                        {s.explain}
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>
            <div className="md:col-span-1 min-h-0">
              {/* Limit the Taken card to the left card's height */}
              <div
                className="h-full overflow-hidden"
                style={leftHeight ? { maxHeight: leftHeight } : undefined}
              ></div>
            </div>
          </div>
        )}
        {/* MAIN PANE: All Players */}
        {activePane === "PLAYERS" && (
          <div className="mb-6">
            <SectionCard
              title="All Players (Available)"
              right={<span className="text-xs text-gray-500">by position</span>}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {(["RB", "WR", "QB", "TE", "K", "DST"] as Position[]).map(
                  (pos) => (
                    <PositionPanel
                      key={pos}
                      title={pos}
                      players={playersByPos[pos]}
                      onMyPick={(p) => markTaken(p, "me")}
                      onOtherPick={(p) => markTaken(p, "other")}
                    />
                  )
                )}
              </div>
            </SectionCard>
          </div>
        )}

        {/* MAIN PANE: All Taken */}
        {activePane === "TAKEN" && (
          <div className="mb-6">
            <SectionCard title="All Taken (Rounds × Slots)">
              {/* JV column index (0-based) */}
              {(() => {
                const jvIndex = settings.draftSlot - 1;
                const JV_TH_CLASS =
                  "ring-2 ring-amber-400 ring-offset-1 ring-offset-gray-100 rounded-md";
                const JV_TD_CLASS =
                  "ring-2 ring-amber-400 ring-offset-1 ring-offset-white rounded-md";
                return (
                  <div className="overflow-auto border rounded-2xl">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-100 text-gray-700 sticky top-0">
                        <tr>
                          <th className="p-2 text-left w-28">Round</th>
                          {Array.from({ length: settings.leagueSize }).map(
                            (_, i) => (
                              <th
                                key={i}
                                className={`p-2 text-left whitespace-nowrap ${
                                  i === jvIndex ? JV_TH_CLASS : ""
                                }`}
                              >
                                {i + 1 === settings.draftSlot ? "JV" : i + 1}
                              </th>
                            )
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {takenGrid.map((row, rIdx) => (
                          <tr key={rIdx} className="border-t">
                            <td className="p-2 font-semibold text-gray-600">
                              ROUND {rIdx + 1}
                            </td>
                            {row.map((player, sIdx) => {
                              const bg = player
                                ? POS_BG[player.position as Position] ?? ""
                                : "";
                              return (
                                <td
                                  key={sIdx}
                                  className={`p-2 align-top ${bg} ${
                                    sIdx === jvIndex ? JV_TD_CLASS : ""
                                  }`}
                                >
                                  {player ? (
                                    <div>
                                      <div className="font-medium leading-tight">
                                        {player.name}
                                      </div>
                                      <div className="text-xs text-gray-700">
                                        {player.position}
                                        {player.team ? ` · ${player.team}` : ""}
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="opacity-40">—</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </SectionCard>
          </div>
        )}

        <Modal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title="Draft Settings"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-sm">
              <span className="block text-gray-600">League Size</span>
              <input
                type="number"
                min={6}
                max={20}
                value={settings.leagueSize}
                onChange={(e) =>
                  updateSetting("leagueSize", Number(e.target.value))
                }
                className="w-full border rounded-xl px-3 py-2"
                autoFocus
              />
            </label>
            <label className="text-sm">
              <span className="block text-gray-600">Your Draft Slot</span>
              <input
                type="number"
                min={1}
                max={settings.leagueSize}
                value={settings.draftSlot}
                onChange={(e) =>
                  updateSetting("draftSlot", Number(e.target.value))
                }
                className="w-full border rounded-xl px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="block text-gray-600">Rounds</span>
              <input
                type="number"
                min={12}
                max={25}
                value={settings.rounds}
                onChange={(e) =>
                  updateSetting("rounds", Number(e.target.value))
                }
                className="w-full border rounded-xl px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="block text-gray-600">Scoring</span>
              <select
                value={settings.scoring}
                onChange={(e) =>
                  updateSetting("scoring", e.target.value as any)
                }
                className="w-full border rounded-xl px-3 py-2"
              >
                <option value="standard">Standard</option>
                <option value="half">Half-PPR</option>
                <option value="ppr">Full PPR</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-gray-600">
                WR/TE ↔ Team QB Influence
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.teamQBInfluence}
                onChange={(e) =>
                  updateSetting("teamQBInfluence", Number(e.target.value))
                }
                className="w-full"
              />
            </label>
            <label className="text-sm">
              <span className="block text-gray-600">Run Sensitivity</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={settings.runSensitivity}
                onChange={(e) =>
                  updateSetting("runSensitivity", Number(e.target.value))
                }
                className="w-full"
              />
            </label>
          </div>

          <div className="text-xs text-gray-500 mt-3 flex items-center gap-2">
            <HelpCircle size={14} /> Settings auto-sync to all connected
            devices.
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={() => setSettingsOpen(false)}
              className="px-3 py-2 rounded-xl border hover:bg-gray-50"
            >
              Done
            </button>
          </div>
        </Modal>

        {/* Footer */}
        <div className="mt-6 text-xs text-gray-500 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div>
            Tip: Share the URL with your helper. Both of you can log picks and
            stay in sync automatically.
          </div>
          <div className="flex items-center gap-2">
            <Save size={14} /> Synced via backend
          </div>
        </div>
      </div>
    </div>
  );
}
