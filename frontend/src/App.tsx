import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Search,
  Upload,
  Save,
  Trash,
  Settings,
  Users,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  HelpCircle,
} from "lucide-react";

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

// Compute upcoming pick numbers for snake draft given slot and round count
const getUpcomingPickIndexes = (
  settings: DraftSettings,
  totalPicksMade: number,
  lookahead = 24
) => {
  const picks: number[] = [];
  const { leagueSize, draftSlot } = settings;
  let pickIndex = totalPicksMade + 1; // 1-based
  const lastPick = settings.rounds * leagueSize;
  while (picks.length < lookahead && pickIndex <= lastPick) {
    const round = Math.ceil(pickIndex / leagueSize);
    const isOdd = round % 2 === 1;
    const pickInRound = ((pickIndex - 1) % leagueSize) + 1;
    const drafter = isOdd ? pickInRound : leagueSize - pickInRound + 1;
    if (drafter === draftSlot) picks.push(pickIndex);
    pickIndex++;
  }
  return picks;
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

  const countOnRoster = (pos: Position) =>
    (yourRoster[pos]?.length || 0) +
    ((pos !== "DST" &&
      pos !== "K" &&
      (yourRoster["FLEX"]?.filter((p) => p.position === pos).length || 0)) ||
      0);
  const needCount = (pos: Position) => {
    const base = ROSTER_TEMPLATE[pos as keyof typeof ROSTER_TEMPLATE] || 0;
    const flexOpen = Math.max(
      0,
      ROSTER_TEMPLATE.FLEX - (yourRoster["FLEX"]?.length || 0)
    );
    const fractionalFlex = FLEX_ELIGIBLE.includes(pos)
      ? flexOpen / FLEX_ELIGIBLE.length
      : 0;
    return Math.max(0, base + fractionalFlex - countOnRoster(pos));
  };

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

  type Scored = { player: Player; score: number; explain: string };
  const scored: Scored[] = [];

  for (const p of playerPool) {
    if (takenIds.has(p.id)) continue;

    const base = (p.proj_pts ?? 0) * (weights[p.position] || 1.0);
    const vor = (p.proj_pts ?? 0) - (replacementValue[p.position] || 0);

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

    const need = needCount(p.position);
    const needBoost = Math.min(1.25, 1 + 0.2 * need);

    const pivotBonus = 1 + Math.max(0, 0.15 - Math.max(0, runBias[p.position]));

    const adpHelp = p.adp ? Math.max(0, (100 - p.adp) * 0.01) : 0;

    const score = base + vor * 1.4 + qbAdj;
    const finalScore = score * needBoost * pivotBonus + adpHelp;

    scored.push({
      player: p,
      score: finalScore,
      explain: `base=${base.toFixed(1)} vor=${vor.toFixed(
        1
      )} qbAdj=${qbAdj.toFixed(1)} needBoost=${needBoost.toFixed(
        2
      )} pivot=${pivotBonus.toFixed(2)} adpHelp=${adpHelp.toFixed(2)}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ----------------------- UI -----------------------

const Chip: React.FC<{
  label: string;
  onClick?: () => void;
  active?: boolean;
}> = ({ label, onClick, active }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1 rounded-full border text-sm ${
      active ? "bg-black text-white" : "bg-white"
    }`}
  >
    {label}
  </button>
);

const SectionCard: React.FC<{
  title: string;
  children: any;
  defaultOpen?: boolean;
  right?: React.ReactNode;
}> = ({ title, children, defaultOpen = true, right }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl shadow p-4 bg-white">
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
      {open && <div className="pt-3">{children}</div>}
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

  const [filter, setFilter] = useState("");
  const [posFilter, setPosFilter] = useState<Position | "ALL">("ALL");
  const [showWhy, setShowWhy] = useState(false);

  const takenSet = useMemo(
    () => new Set(picks.map((p) => p.player_id)),
    [picks]
  );
  const yourIds = useMemo(
    () => picks.filter((p) => p.owner === "me").map((p) => p.player_id),
    [picks]
  );

  function findSlotForPlayer(p: Player, by: Record<string, Player[]>) {
    const need = (slot: string, count: number) =>
      (by[slot]?.length || 0) < count;
    if (p.position === "QB" && need("QB", ROSTER_TEMPLATE.QB)) return "QB";
    if (p.position === "RB" && need("RB", ROSTER_TEMPLATE.RB)) return "RB";
    if (p.position === "WR" && need("WR", ROSTER_TEMPLATE.WR)) return "WR";
    if (p.position === "TE" && need("TE", ROSTER_TEMPLATE.TE)) return "TE";
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

  const filtered = useMemo(
    () =>
      scored.filter(
        (s) =>
          (posFilter === "ALL" || s.player.position === posFilter) &&
          (filter === "" ||
            s.player.name.toLowerCase().includes(filter.toLowerCase()) ||
            (s.player.team || "").toLowerCase().includes(filter.toLowerCase()))
      ),
    [scored, filter, posFilter]
  );

  const myRecommended = filtered.slice(0, 18);

  const totalPicksMade = picks.length;
  const myUpcoming = getUpcomingPickIndexes(settings, totalPicksMade, 12);

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

  const rosterCounts: Record<Position, number> = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    DST: 0,
    K: 0,
  };
  for (const id of yourIds) {
    const p = players.find((x) => x.id === id);
    if (!p) continue;
    rosterCounts[p.position]++;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-4 md:p-6">
        <motion.h1
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-2xl md:text-3xl font-bold mb-2"
        >
          Fantasy Draft Assistant (Synced)
        </motion.h1>
        <p className="text-gray-600 mb-6">
          Draft helper with live backend sync, roster tracking, and run
          detection. Players are preloaded server-side.
        </p>

        {/* Top Controls */}
        <div className="grid md:grid-cols-3 gap-4 mb-6">
          <SectionCard title="Draft Settings" right={<Settings size={18} />}>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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
            <div className="text-xs text-gray-500 mt-2 flex items-center gap-2">
              <HelpCircle size={14} /> Settings auto-sync to all connected
              devices.
            </div>
          </SectionCard>

          <SectionCard title="Sync & Admin" right={<Upload size={18} />}>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={refreshAll}
                className="px-3 py-2 rounded-xl border flex items-center gap-2"
              >
                <RefreshCw size={16} /> Refresh
              </button>
              <button
                onClick={undoLastPick}
                className="px-3 py-2 rounded-xl border flex items-center gap-2"
              >
                <RefreshCw size={16} /> Undo Pick
              </button>
              <button
                onClick={clearAll}
                className="px-3 py-2 rounded-xl border text-red-600 flex items-center gap-2"
              >
                <Trash size={16} /> Reset
              </button>
            </div>
            <div className="text-xs text-gray-500 mt-2">
              Players are served by the backend; to preload, place a{" "}
              <code>players.csv</code> or <code>players.json</code> on the
              server and (re)start the backend.
            </div>
          </SectionCard>

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

        {/* Picks & Recommendations */}
        <div className="grid md:grid-cols-3 gap-4">
          <SectionCard title="Live Picks & Controls" defaultOpen>
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <input
                  className="w-full border rounded-2xl pl-9 pr-3 py-2"
                  placeholder="Search player or team..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <Search
                  size={16}
                  className="absolute left-3 top-2.5 text-gray-400"
                />
              </div>
              <div className="flex gap-1">
                {(["ALL", "QB", "RB", "WR", "TE", "DST", "K"] as const).map(
                  (p) => (
                    <Chip
                      key={p}
                      label={p}
                      active={posFilter === p}
                      onClick={() => setPosFilter(p)}
                    />
                  )
                )}
              </div>
            </div>

            <div className="border rounded-2xl overflow-hidden">
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
                      <td className="p-2 text-right">{s.player.adp ?? "—"}</td>
                      <td className="p-2 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => markTaken(s.player, "me")}
                            className="px-2 py-1 rounded-lg border"
                          >
                            My Pick
                          </button>
                          <button
                            onClick={() => markTaken(s.player, "other")}
                            className="px-2 py-1 rounded-lg border"
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
                Players loaded: {players.length} · Picks made: {picks.length}
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

          <div className="md:col-span-2 grid gap-4">
            <SectionCard
              title="Snake Draft Planner"
              right={
                <span className="text-xs text-gray-500">upcoming picks</span>
              }
            >
              <div className="text-sm text-gray-700">
                Your next picks (overall numbers):{" "}
                {myUpcoming.join(", ") || "—"}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Based on league size {settings.leagueSize}, slot{" "}
                {settings.draftSlot}, rounds {settings.rounds}. Auto-updates as
                picks are logged.
              </div>
            </SectionCard>

            <SectionCard
              title="Position Run Radar"
              right={<span className="text-xs text-gray-500">live trend</span>}
            >
              <div className="grid grid-cols-6 gap-2 text-sm">
                {(Object.keys(picksByPos) as Position[]).map((pos) => (
                  <div
                    key={pos}
                    className="rounded-xl border p-2 bg-white flex flex-col"
                  >
                    <div className="text-gray-500">{pos}</div>
                    <div className="text-2xl font-semibold">
                      {picksByPos[pos] || 0}
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                As certain positions spike, recommendations will pivot to
                exploit value rather than chase runs blindly.
              </div>
            </SectionCard>

            <SectionCard
              title="All Players (Available)"
              right={
                <span className="text-xs text-gray-500">mark picks below</span>
              }
            >
              <div className="max-h-[420px] overflow-auto border rounded-2xl">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100 text-gray-600 sticky top-0">
                    <tr>
                      <th className="text-left p-2">Player</th>
                      <th className="text-left p-2">Pos</th>
                      <th className="text-left p-2">Team</th>
                      <th className="text-right p-2">Proj</th>
                      <th className="text-right p-2">ADP</th>
                      <th className="text-right p-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players
                      .filter((p) => !takenSet.has(p.id))
                      .slice(0, 500)
                      .map((p) => (
                        <tr key={p.id} className="border-t">
                          <td className="p-2">{p.name}</td>
                          <td className="p-2">{p.position}</td>
                          <td className="p-2">{p.team || ""}</td>
                          <td className="p-2 text-right">
                            {p.proj_pts?.toFixed(1) ?? "—"}
                          </td>
                          <td className="p-2 text-right">{p.adp ?? "—"}</td>
                          <td className="p-2 text-right">
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => markTaken(p, "me")}
                                className="px-2 py-1 rounded-lg border"
                              >
                                My Pick
                              </button>
                              <button
                                onClick={() => markTaken(p, "other")}
                                className="px-2 py-1 rounded-lg border"
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
            </SectionCard>

            <SectionCard title="Taken Board (All Teams)">
              <div className="text-sm text-gray-700">
                Chronological list of drafted players. Useful if someone bumps
                the sticker board.
              </div>
              <div className="max-h-[260px] overflow-auto border rounded-2xl mt-2">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100 text-gray-600 sticky top-0">
                    <tr>
                      <th className="text-left p-2">#</th>
                      <th className="text-left p-2">Player</th>
                      <th className="text-left p-2">Pos</th>
                      <th className="text-left p-2">Team</th>
                      <th className="text-right p-2">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picks.map((row, i) => {
                      const p = players.find((x) => x.id === row.player_id);
                      if (!p) return null;
                      return (
                        <tr key={`${row.player_id}-${i}`} className="border-t">
                          <td className="p-2">{i + 1}</td>
                          <td className="p-2">{p.name}</td>
                          <td className="p-2">{p.position}</td>
                          <td className="p-2">{p.team || ""}</td>
                          <td className="p-2 text-right">
                            {row.owner === "me" ? "You" : "Other"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </div>
        </div>

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
