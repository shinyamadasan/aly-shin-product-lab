# MCP security hotfix — direct user request

## Objective

Resolve GHSA-46jr-4wx8-v453 with the smallest dependency/input-limit repair, obtain independent
security approval, integrate a security-only PR and prepare a new production-context Netlify draft.
Production publish, Worker deploy and Finance view migration remain separately gated.

## Baseline

Isolated fix/mcp-input-security starts clean at approved main508ff02ec99602ca9a559b7e970703a4f52f5cbf.
Unrelated dirty root preserved. Existing MCP/inventory baseline99/99; Finance hotfix already merged.
Product context, MCP architecture, workflow/review/QA, installed Next/SDK and Workers guidance read.
This is direct work, not a new formal milestone or architecture review.

## Current Step

Security implementation and independent review APPROVED; source-control scope gate and new Linux
production-context draft preparation next. Production and live Worker remain unchanged.

## Success Criteria

- [x] Exact SDK tree audited; only server/client/core2.0.0→2.3.0, reproducible lockfile.
- [x] Shared HTTP256KiB, tool5000elements, count500rows; SDK batch boundary verified.
- [x] Owner authorization, request isolation, RLS, approvals and sole count authority preserved.
- [x] Unit4587pass/0fail/1existing skip; focused110/110; real disposable security/Finance22/22,
      V1A11/11; actual local workerd approval/replay; production build, TypeScript, source lint pass.
- [x] Independent security approval; production audit0; unrelated dev advisory residuals disclosed.
- [x] Finance source unchanged and exact migration hash preserved; no production data/schema writes.
- [ ] Scope gate, separate security PR and expected-head merge; merged tree matches candidate.
- [ ] New Linux/Netlify production-context draft with assets/routes/guarded owner checks verified.
- [ ] Read-only production comparison and exact app/Worker/view release/recovery checkpoint recorded.

## Definition of Done

Independently approved security-only integration and newly verified compatible draft, with production
publication, Worker deployment and Finance migration still awaiting final approval. Details and
release sequence: docs/MCP_SECURITY_HOTFIX.md. Never promote the superseded stock-count draft.
