# Releasing

## Pull request gate

All changes must enter `main` through a pull request. Use a Conventional Commit
PR title, for example:

```text
feat: persist Decision Worker sessions
fix: close orphaned workers during shutdown
```

The required `CI / Quality gate` aggregates every prerequisite. It fails when
any job fails, is cancelled, or is skipped:

- Node 22.19.0 and Node 24 checks;
- npm 10 and npm 12 compatibility checks;
- TypeScript, unit tests, package checks and documentation checks;
- Pi smoke and native package-install tests;
- npm audit at high severity;
- deterministic package artifact build with SHA-256 and npm integrity metadata.

Configure branch protection for `main` with:

- pull request required;
- `CI / Quality gate` required and up to date;
- conversation resolution required;
- force pushes and branch deletion disabled.

The workflow does not auto-merge arbitrary pull requests.

## Local release checks

```bash
npm ci --ignore-scripts --include=dev
npm run check
npm run test:pi
npm run test:install
npm run build
npm audit --audit-level=high
```

`npm run build` writes exactly these files to `dist/`:

```text
pi-claude-supervisor-X.Y.Z.tgz
release-manifest.json
SHA256SUMS
```

The manifest binds the archive to the exact source commit, SHA-256 digest and
npm SHA-512 integrity value. Never manually replace an artifact after CI builds
it.

## Versioning and automatic publication

The `Release` workflow runs on `main` and uses Release Please:

1. Release Please opens or updates a release PR from Conventional Commits.
2. A maintainer reviews and merges the release PR.
3. Release Please creates a stable `vX.Y.Z` Git tag and GitHub Release.
4. The workflow runs the full reusable CI against the exact tag commit.
5. Only after verification succeeds does the `npm` environment publish the
   verified archive with `npm publish --provenance`.
6. The archive, manifest and checksum file are attached to the GitHub Release.

A failed publication must be retried from the original release workflow. Do not
move tags, overwrite versions, or rebuild a different artifact to bypass a
failed verification.

## npm authentication

Preferred mode is npm trusted publishing (OIDC):

- configure `btnalit/pi-claude-supervisor` and `.github/workflows/release.yml`
  as a trusted publisher in npm;
- configure the GitHub environment named `npm`;
- set repository/environment variable `NPM_AUTH_MODE=oidc`;
- grant only the publish job `id-token: write`.

Temporary fallback mode uses the GitHub environment secret `NPM_TOKEN` and
variable `NPM_AUTH_MODE=token`. The token must be package-scoped, short-lived
and rotated. It is never committed or copied into workflow source.

For local/manual recovery only, the machine-held credential is stored in:

```text
/home/yancao/.config/key.conf
```

Keep that file at mode `0600`. It must not be copied into the repository,
GitHub Actions variables, npm package contents, logs or pull requests. Local
publication should use a temporary `npm_config_userconfig` file and remove it
immediately after the command.

## Dependency and workflow updates

Dependabot is configured for both npm dependencies and GitHub Actions. Minor and
patch updates are grouped; every update must pass the same CI quality gate.
Major updates remain separate for explicit review. There is no blanket auto-merge.

## Manual retry

A maintainer can retry an existing stable release from Actions:

```bash
gh workflow run release.yml --ref main -f tag=v0.1.1
```

The workflow verifies that the release tag is stable and belongs to `main`, then
reruns CI before publication. A tag or GitHub Release alone is not evidence that
npm publication succeeded; verify the npm registry separately.
