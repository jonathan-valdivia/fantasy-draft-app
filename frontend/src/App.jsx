import React, { useEffect, useState } from 'react';

function App() {
  const [players, setPlayers] = useState([]);
  const [picks, setPicks] = useState([]);
  const [pickedBy, setPickedBy] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState("");

  useEffect(() => {
    fetch("http://localhost:8000/players")
      .then(res => res.json())
      .then(setPlayers);

    fetch("http://localhost:8000/picks")
      .then(res => res.json())
      .then(setPicks);
  }, []);

  const makePick = () => {
    fetch("http://localhost:8000/picks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: Number(selectedPlayer), picked_by: pickedBy })
    })
    .then(res => res.json())
    .then(data => setPicks(data.picks));
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>Fantasy Draft Tracker</h1>
      <div>
        <select onChange={e => setSelectedPlayer(e.target.value)}>
          <option value="">Select Player</option>
          {players.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} - {p.position} ({p.team})
            </option>
          ))}
        </select>
        <input
          placeholder="Picked By"
          value={pickedBy}
          onChange={e => setPickedBy(e.target.value)}
        />
        <button onClick={makePick}>Make Pick</button>
      </div>
      <h2>Picks</h2>
      <ul>
        {picks.map((p, i) => (
          <li key={i}>
            Player #{p.player_id} picked by {p.picked_by}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;
