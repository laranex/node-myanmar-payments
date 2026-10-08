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
