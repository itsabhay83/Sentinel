## What changed

<!-- One paragraph. What behaviour is different after this merges? -->

## Why

<!-- Link the issue, or describe the failure this fixes. -->

## Verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Ran it against a real stack (`./start.sh`)

## Operational impact

- [ ] Adds or changes a migration — rollout order is migrate → scheduler → probes → web
- [ ] Adds or renames an environment variable — updated `.env.example`, `turbo.json` `globalEnv`, `deploy/k8s`, `deploy/helm`
- [ ] Changes a health or metrics endpoint — updated probes in `deploy/` and `docs/observability.md`
- [ ] None of the above
