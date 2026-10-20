# SyncSpace Product Requirements

## Overview
SyncSpace is a browser workspace for small teams to edit shared rich-text documents together, with durable storage and offline recovery. The first release prioritizes correct access control and convergent editing over feature breadth.

## Problem and users
People writing notes, assignments, and technical documents need a shared place that does not lose edits during concurrent work or brief network outages. Primary personas are students working on assignments, developers maintaining documentation, and small teams drafting internal material.

## Stories and acceptance criteria
- As a user, I can register, sign in, and sign out; server-side session checks protect every private operation.
- As a member, I can create, rename, open, and delete documents; changes remain after reload.
- As an owner, I can grant a collaborator read or edit access; unauthorized users cannot fetch or join the document.
- As an editor, I can edit rich text concurrently; independent Yjs replicas converge after updates are exchanged.
- As a disconnected editor, I can keep editing locally and merge pending work after reconnect.
- As a reader, I can observe content and collaborators without submitting document changes.

## Functional requirements
Authentication and authorization, workspace and document metadata, rich-text editing, Yjs synchronization and awareness, PostgreSQL update persistence and snapshots, browser-local persistence, clear connection state, and recoverable error handling. HTTP and collaboration authorization are enforced server-side.

## Non-functional objectives (not yet measured)
- Target local API p95 under 250 ms, and same-region edit-to-peer visibility p95 under 500 ms for a two-client document under 100 KB.
- No acknowledged durable update is lost across process restart.
- At least 99.9% of generated deterministic concurrent-edit cases converge.
- Keyboard operability, visible focus, semantic controls, and responsive layouts.

## Scope
MVP: registration/login/logout; workspace and document ownership; document CRUD and sharing; Tiptap/Yjs editing; presence; PostgreSQL recovery; IndexedDB offline state; tests and reproducible benchmark. Out of scope: billing, video, AI, native apps, multi-region active-active, and full office-suite parity. Search, revision UI, richer invitations, and advanced mobile support are post-MVP.

## Journeys
Register → create workspace → create document → grant collaborator access → edit together → disconnect and continue locally → reconnect → refresh and confirm persisted content.

## Security, privacy, and constraints
Use hashed credentials, HttpOnly session cookies, CSRF protections for cookie-authenticated mutations, origin checks for WebSockets, and least-privilege document access. Avoid logging document content or credentials. Assumptions: users can run Node and PostgreSQL locally; production needs a host supporting persistent WebSockets. Risks include provider protocol compatibility, persistence ordering, session revocation, and offline merges; address with integration and restart tests before production claims.

## Definition of done
The requested workflows are implemented and verified with independent clients, persistence/restart and offline tests, authorization tests, production build, Docker startup, and actual benchmark output. Registry and deployment completion additionally require authorized external accounts and successful verification.
