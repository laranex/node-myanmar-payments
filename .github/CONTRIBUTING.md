# Contribution Guide

Thank you for considering contributing to Node Myanmar Payments! Please review the following guidelines before submitting a pull request.

For significant changes, please open an issue first so we can discuss the approach.

## Process

1. Fork the project
2. Create a new branch
3. Code, test, commit, and push
4. Open a pull request detailing your changes

## Guidelines

- Keep the package free of runtime dependencies: it uses the global `fetch` and `node:crypto` only.
- Validation rules, amount limits and currencies must match each gateway's official documentation; link the document in your pull request.
- Keep behavior in line with `php-myanmar-payments` and `go-myanmar-payments`, and reuse their test vectors.
- Keep test coverage at 100%.
- Send a coherent commit history, making sure each commit in your pull request is meaningful.
- You may need to [rebase](https://git-scm.com/book/en/v2/Git-Branching-Rebasing) to avoid merge conflicts.
- Please remember that we follow [SemVer](http://semver.org/).

## Setup

Node.js 20 or higher is the only requirement:

```bash
npm install
```

## Lint

```bash
npm run lint
npm run typecheck
```

## Tests

```bash
npm run test:coverage
npm run build && npm run test:dist && npm run check:package
```

## Releasing

Pushing a version tag releases the package: `.github/workflows/release.yml` runs the test suite, publishes to npm with provenance, and creates the GitHub release.

1. Set the new version in `package.json` and `package-lock.json` (`npm version 4.1.0 --no-git-tag-version`).
2. Add the release's section to `CHANGELOG.md` (`## v4.1.0 - 2026-10-08`). Its body becomes the GitHub release notes; when no section matches the tag, the notes are generated from the merged pull requests instead.
3. Merge into `dev`.
4. Tag the merged commit and push the tag:

   ```bash
   git tag v4.1.0
   git push origin v4.1.0
   ```

That's it. The tag must equal `v` + the `package.json` version, or the release fails before anything is published. Pre-release versions (`4.1.0-rc.1`) are published under `next` and marked as GitHub pre-releases; stable versions go to `latest`. Until the first stable version exists, pre-releases take `latest` too and the workflow moves `next` along with them (this needs "Allow npm dist-tag" on the trusted publisher). `CHANGELOG.md` is written by hand before tagging; nothing commits it back after the release.

One-time setup: publishing uses npm trusted publishing (OIDC), so no npm token is stored. npm only offers the trusted publisher setting once the package exists, so the first release is bootstrapped from CI with a temporary token:

1. On npmjs.com create a granular access token: read and write, scoped to `@laranex`, "Bypass two-factor authentication" enabled, short expiry. Add it as the repository secret `NPM_TOKEN`.
2. Push the first tag. `release.yml` publishes with the token.
3. Open the package → Settings → Trusted Publisher → GitHub Actions: organization `laranex`, repository `node-myanmar-payments`, workflow `release.yml`, no environment, and allow `npm publish`.
4. Delete the `NPM_TOKEN` secret and revoke the token. Every later tag publishes through trusted publishing.
