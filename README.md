# MyTeslaGE V2

Clean rewrite of the Tesla in-car navigation app.

## Principles

- Self-hosted production infrastructure.
- GitHub is the source of truth.
- Lovable is used only to help write frontend code; the running product must not depend on Lovable Cloud, Lovable-hosted databases, or Lovable backend services.
- The Tesla browser stays thin; expensive work belongs on our server where practical.
- External API calls are centralized, cached, deduplicated, rate-limited, and observable.
- Secrets never live in Git.

## Target architecture

```text
Tesla Browser
    |
    v
React/Vite Web App
    |
    v
Fastify API
    |
    +--> Redis       cache / dedup / rate-limit
    +--> PostgreSQL  application data
    +--> Google APIs only when needed
```

## Repository layout

```text
apps/
  web/
  api/

infra/
  docker-compose.yml

docs/
  architecture.md
```
