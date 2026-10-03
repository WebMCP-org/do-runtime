---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": patch
"@cloudflare/codemode": patch
---

Refresh the package closure to Agents 0.26.0 / Think 0.20.0 / AI Chat 0.12.1 /
Codemode 0.5.3 (upstream `74570a19`). Voice 0.5.0 and Shell 0.4.3 remain unchanged.
Think requires AI SDK 7, React SDK 4 and Agents >=0.25; AI Chat also requires
Agents >=0.25. Agents adds optional model/Pi integrations and persistent Browser
tools under `agents/browser/ai-sdk` and `agents/browser/tanstack-ai`.

Use upstream declared-member override detection, React cleanup/address reset,
and noncreating deleted-facet routing in place of equivalent fork patches.
Compose replay sequence tracking and terminal-only Agent-tool events with the
fork's continuation descriptors, atomic snapshots, unstored live events and
Stop/cancellation contracts. Persist the canonical transcript before completion;
finish pending resume replay before broadcasting that terminal frame, retaining
server-authored timing and completed outcomes after callback delivery failures.

The 0.24-to-0.26 storage changes add nullable content hashes, submission message
identity and child event-delivery metadata. The previous Lifecycle queue
migration remains a prerequisite for older deployments; this update does not
make pre-0.24 rollbacks lossless. The detailed commit range, integration choices,
and verification are in `docs/audit/agents-sync-2026-10-02.md`.
