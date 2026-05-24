# NFL Fantasy Draft Assistant

NFL Fantasy Draft Assistant is a web app I built so I could participate remotely in an offline fantasy football draft. A helper at the live draft marks players as they are taken, the app syncs those picks over the web, and I can mark my own pick when it is my turn so the helper can update the physical draft board.

## Why I Built This

The project solves a practical workflow problem: offline fantasy drafts are fun, but they are hard to join remotely without losing track of picks. I wanted a lightweight draft board that could sync between two people, help me see who was still available, and give me a better way to make picks from a distance.

It was also a learning project for building a small full-stack app with a React frontend, a FastAPI backend, Docker-based deployment, and a simple production hosting setup on a DigitalOcean Droplet.

## Tech Stack

- React 19, TypeScript, and Vite for the frontend
- Tailwind CSS, Framer Motion, and Lucide React for UI styling and interactions
- FastAPI and Uvicorn for the backend API
- JSON/CSV player data loaded by the backend
- Docker Compose for running the frontend, backend, and reverse proxy together
- Caddy for production web serving and HTTPS on the droplet

## Key Features

- Shared draft state so a remote user and an in-person helper can track picks together
- Player pool loaded from backend data files
- Mark players as drafted by me or by another team
- Undo and reset controls for draft corrections
- Draft settings for league size, draft slot, rounds, scoring format, and recommendation behavior
- Snake-draft awareness for upcoming pick numbers
- Heuristic player ranking based on projected points, roster needs, positional runs, scoring format, and draft round
- Position filters and search for quickly finding available players

## What I Learned

- Designing a small API around shared draft state
- Keeping frontend state synchronized with a backend service
- Modeling fantasy draft settings, roster needs, and pick recommendations
- Building a production deployment with Docker Compose and Caddy
- Separating local development workflow from droplet deployment workflow
- Using AI-assisted development to quickly iterate on product behavior and UI details

## Current Status

Prototype / learning project. The app is functional for the draft workflow it was built for, but it is not packaged as a polished public product.

## Screenshots

Screenshots can be added here if the UI needs to be shown in the repository.

## Running Locally

The backend and frontend both need to run for the app to load data and sync picks correctly.

### Backend

From the repository root:

```bash
cd backend
python -m venv ../.venv
source ../.venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend

In a second terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev
```

The frontend development server is powered by Vite and proxies `/api` requests to the FastAPI server on port `8000`.

## Running with Docker

The production-style setup uses Docker Compose to run the backend, frontend, and Caddy reverse proxy together.

```bash
docker compose build
docker compose up
```

## Deployment Notes

The app is currently built with Docker and hosted on a DigitalOcean Droplet.

To update the droplet:

```bash
cd /opt/fantasy-draft-app
git pull
docker compose build
docker compose up
```
