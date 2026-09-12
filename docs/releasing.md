# Releasing

This package is not ready for automatic publication until the transport spike,
security review and maintainer ownership are complete.

## Pre-release gate

1. Update `CHANGELOG.md` and `package.json` with the intended version.
2. Run `npm ci --ignore-scripts --include=dev` on Node 22.19+.
3. Run `npm run check`, `npm run test:pi`, `npm run test:install`, `npm run build`,
   and `npm audit --audit-level=high`.
4. Inspect `npm pack --dry-run --json`; confirm no credentials, local state,
   tests or `node_modules` are included.
5. Verify the exact Pi and Claude Code compatibility matrix and record unresolved
   limitations in the changelog.
6. Publish only from a reviewed tag using npm trusted publishing or a short-lived
   token supplied by the release environment. Never store an npm token in the
   repository or workflow source.

The workflow in `.github/workflows/release.yml` currently packages and validates
only; it intentionally does not publish, merge or deploy.
