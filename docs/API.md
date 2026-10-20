# API and Collaboration Protocol

This is the intended contract; route details must stay aligned with the server implementation. JSON errors use `{ "error": { "code": string, "message": string } }`.

| Method | Path | Auth / permission | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | Public | `{name,email,password}` → user/session; 201, 400, 409 |
| POST | `/api/auth/login` | Public | `{email,password}` → user/session; 200, 400, 401 |
| POST | `/api/auth/logout` | Session + CSRF | End session; 204 |
| GET | `/api/auth/me` | Session | Current user; 200, 401 |
| GET/POST | `/api/workspaces` | Session / member | List or create workspace; 200/201, 400 |
| GET | `/api/workspaces/:workspaceId` | Workspace member | Workspace metadata; 200, 403, 404 |
| GET/POST | `/api/documents` | Session / workspace member | List (cursor pagination) or create; 200/201, 400 |
| GET/PATCH/DELETE | `/api/documents/:documentId` | Member / editor / owner | Read, rename, soft-delete; 200/204, 400/403/404 |
| GET/POST | `/api/documents/:documentId/collaborators` | Owner / owner | List or grant `read`/`edit`; 200/201, 400/403/404 |
| DELETE | `/api/documents/:documentId/collaborators/:userId` | Owner | Revoke; 204, 403/404 |
| GET | `/api/health` | Public | Process liveness; 200 |
| GET | `/api/ready` | Public | Dependency readiness; 200/503 |

All inputs are schema-validated; document IDs are not authorization. Missing/invalid input returns 400, unauthenticated 401, forbidden 403, absent resource 404, duplicate/conflict 409, and unexpected failures 500 without internal details. Mutations require CSRF protection where cookie sessions are used. Listing uses bounded cursor pagination and optional workspace filter.

## WebSocket
Use the `y-websocket` provider's standard Yjs synchronization and awareness protocol; no custom Yjs messages are added. The handshake authenticates using the existing session (no long-lived URL token), validates Origin, authorizes the document before room join, and applies a 1 MB message limit and a 50-connection-per-document limit. Room IDs are server-derived from authorized document IDs. On leave, stale awareness is removed. Reconnect performs provider synchronization and merges IndexedDB-persisted state. Edit updates are validated, committed to PostgreSQL, and only then applied to the in-memory room and relayed. Read-only clients receive shared state and awareness, but their sync response is ignored and update messages close the socket. The provider protocol has no per-update durable acknowledgement; a client can retry its local Yjs state after reconnect.
