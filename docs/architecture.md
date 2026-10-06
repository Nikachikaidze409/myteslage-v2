# Architecture

## Ownership boundary
Production infrastructure, database, runtime configuration, secrets, logs and deployment belong to the project owner. Lovable may generate code but is not part of the runtime architecture.

## Client
The Tesla browser should primarily render UI, collect device/location input, and display server results. Heavy computation should be avoided on the client where practical.

## API
All privileged third-party API calls should pass through the API layer when provider rules allow it. This enables:
- key protection,
- request validation,
- caching,
- in-flight request deduplication,
- rate limiting,
- cost accounting,
- telemetry.

## Data
PostgreSQL is the durable application store. Redis is ephemeral infrastructure for cache, in-flight locks/deduplication, sessions where appropriate, and rate limiting.

## Google request policy
Before a Google-backed endpoint is added, define:
1. cache key/fingerprint,
2. TTL/freshness rules,
3. deduplication behavior,
4. per-user/device limits,
5. logging and cost metric,
6. fallback/error behavior.

Do not send a provider request merely because a React component re-rendered.
