# Deployment

Local development requires Node.js, npm, Docker Compose, and PostgreSQL (or the provided local database service). Configure values from `.env.example`; never commit secrets. Apply versioned migrations before serving traffic. Local Compose is for development and persistence checks; production should use separately managed API/collaboration and web processes plus managed PostgreSQL, TLS termination, encrypted backups, and restricted network access.

Production requires secure HttpOnly/SameSite cookies, correct trusted origins, WebSocket proxy upgrade support, health/readiness checks, graceful shutdown, bounded connection pools, secrets from the host secret manager, and durable database storage. CI should lint, typecheck, test, build, then build/publish immutable SHA or version container tags; latest only from the stable branch. Deployment steps, actual provider topology, and rollback commands remain to be filled after they are implemented and verified.

Back up before migrations and rehearse restore. Roll back by deploying the previous immutable image and applying only backward-compatible migrations; database restore is a separate recovery action. Common failures include incorrect origins/cookies, proxy idle timeouts, missing migrations, and database connection exhaustion. Hosting cost depends on persistent WebSocket processes and database capacity; no provider or cost is assumed here.

## Repository commands

For local container startup, run `docker compose up --build` and browse to `http://localhost:3001`. This uses a local-only PostgreSQL password and a named volume. The production Compose file accepts an immutable image tag plus `DATABASE_URL` and `WEB_ORIGIN`; place secrets in the host environment and terminate TLS at a reverse proxy configured for WebSocket upgrades. The app image serves both the built web client and API, and runs the migration command before starting the HTTP/WebSocket process.

The `Checks` workflow runs install, strict typecheck, unit tests, and production build on pushes and pull requests. `Publish container` publishes SHA/tag images to GHCR on main or version tags after those checks. Registry publishing and production deployment require a configured GitHub repository and host credentials and have not been executed here.
