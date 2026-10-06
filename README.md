# MyTeslaGE V2

Clean rewrite of the Tesla in-car navigation app.

## Principles
- Self-hosted production infrastructure.
- GitHub is the source of truth.
- Lovable is a coding tool only; production must not depend on Lovable Cloud, Lovable DB, or Lovable backend.
- Keep the Tesla browser thin.
- Centralize, cache, deduplicate, rate-limit, and observe external API calls.
- Never commit secrets.

## Local start
1. Copy `.env.example` to `.env`.
2. Run `docker compose -f infra/docker-compose.yml up --build`.
3. Web: http://localhost:5173
4. API health: http://localhost:3000/health
