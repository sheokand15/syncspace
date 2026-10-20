# Roadmap and Implementation Checklist

## Current status update (2026-10-20)

- The collaboration module validates Yjs updates and commits them to PostgreSQL before applying or broadcasting them. It uses the standard y-websocket provider protocol and does not add a per-update durable acknowledgement.
- Docker Compose, a multi-stage container, and GitHub checks/GHCR workflows have been added but are unverified because Docker and PostgreSQL are not available in this environment.
- Still required: database migration and restart/compaction tests; two authenticated browser clients; read-only and revocation verification; dependency advisory review; actual benchmark; and deployment checks.
- Local Git metadata exists, but no remote is configured and no commits or pushes have been made.

- [x] Repository audit: empty directory, no Git metadata or existing package manager detected (2026-10-20).
- [x] Documentation baseline and architecture decisions (written, architecture notes the provider persistence limitation).
- [x] Foundation scaffold: workspaces, strict TypeScript, tooling, initial PostgreSQL migration, session authentication, and app shell. PostgreSQL migration has not been executed locally.
- [x] Document metadata CRUD, soft deletion, sharing grants, and Tiptap editor shell. Database-backed behavior is not yet integration-tested.
- [x] Yjs WebSocket provider protocol, room authorization, awareness, and deterministic CRDT unit tests. Independent browser clients have not been tested.
- [ ] Durable update persistence with commit-gated acknowledgement, snapshot/restart recovery against PostgreSQL, and end-to-end offline synchronization. Current append/compaction code is present but asynchronous relay-before-commit remains a known data-loss window.
- [ ] Security review, accessibility, responsive/error states, end-to-end checks.
- [ ] Benchmark execution and measured results.
- [ ] Docker/Compose after core checks pass.
- [ ] GitHub CI and registry publication after remote credentials are available.
- [ ] Web deployment and two-session verification after hosting access is available.

Dependencies follow the order above. Acceptance requires runnable implementation and observed checks, not documentation alone. Post-MVP: revision restoration, invitations, read-only sharing refinements, search, richer toolbar, and mobile polish.
