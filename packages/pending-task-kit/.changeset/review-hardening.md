---
"pending-task-kit": patch
---

Post-0.2.0 review-driven hardening (0.2.0 itself is not yet published; its changelog entry was
updated in place to match): survive storage-disabled browsers where the `localStorage`
accessor itself throws (`SecurityError`) without permanently wedging the tick loop, add React
binding tests (StrictMode re-mount, `visibilitychange` recovery, callback-option freshness),
widen the `react` peer range to `>=18`, document runtime-environment trade-offs in the README,
and add a tag-triggered release workflow publishing with `--provenance`.
