# ADR 0005: Local web UI before Electron

- Status: accepted (2026-10-29)

## Context

Most target users are on macOS. A signed and notarised Electron build is not possible before the deadline, and installers slow down adoption.

## Decision

The gateway serves a React + Vite UI on `127.0.0.1` only (host not configurable), protected by a random per-session token, a loopback `Host` check and no CORS. Electron will later wrap the same UI.

## Consequences

Users open a browser tab for approvals and the live feed. The UI's HTTP surface is security-critical (threat model T10) and gets dedicated tests.
