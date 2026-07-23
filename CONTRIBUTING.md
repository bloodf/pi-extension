# Contributing

## Development setup

Requirements:

- Node.js 22.19 or newer
- npm
- Pi and/or OMP for manual host smoke tests

```bash
git clone https://github.com/bloodf/pi-extension.git
cd pi-extension
npm install
npm run check
```

## Change workflow

1. Open an issue for behavior changes larger than a focused bug fix.
2. Create a branch from the default branch.
3. Keep runtime dependencies at zero unless standard library code cannot safely satisfy the requirement.
4. Add a regression test for every observable behavior change.
5. Run `npm run check` and `npm pack --dry-run`.
6. Open a pull request using the repository template.

## Code standards

- TypeScript strict mode; no suppression comments.
- Keep Pi and OMP behavior aligned through their common extension surface.
- Treat configuration and remote responses as untrusted.
- Never log headers, response bodies, or resolved credential values.
- Prefer host-neutral configuration; isolate unavoidable host translation.
- Update documentation when schema, paths, behavior, or compatibility changes.

## Testing

Required checks:

```bash
npm run typecheck
npm test
npm pack --dry-run
```

Tests must be deterministic and use fake/local Models API responses. Never put real API keys in fixtures or CI secrets. Live host E2E is manual-trigger only.

## Commit messages

Use concise imperative subjects. Explain why in the body when the change is not self-evident.

## Releases

Maintainers update `CHANGELOG.md`, verify packed contents, tag the exact tested commit, and publish the public npm package. GitHub and npm release artifacts must come from the same commit.
