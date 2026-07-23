# Pi Provider Discovery

Dynamic OpenAI-compatible and Anthropic-compatible model discovery for [Pi](https://github.com/earendil-works/pi) and [OMP](https://github.com/can1357/oh-my-pi).

The extension fetches each configured provider's Models API, normalizes the catalog, registers models before startup finishes, and exposes a portable `/providers` configuration menu. Static `models.json` remains the better choice when a catalog rarely changes.

## Features

- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages request APIs
- OpenAI and Anthropic Models API discovery formats
- Multiple independently configured providers
- `/providers` setup, testing, refresh, diagnostics, enable/disable, and removal
- Exact model metadata overrides and include/exclude filters
- Profile-local configuration and last-known-good cache
- Environment-variable and command-backed credentials
- Redirect rejection, response-size limits, pagination guards, and bounded timeouts
- Zero runtime dependencies

## Install

From GitHub:

```bash
pi install https://github.com/bloodf/pi-extension
omp plugin install https://github.com/bloodf/pi-extension
```

Local development:

```bash
pi install /absolute/path/to/pi-extension
omp plugin install /absolute/path/to/pi-extension
```

After npm publication, both hosts can install `@bloodf/pi-provider-discovery` through their npm package flows.

## Quick start

1. Set the credential in the active profile environment:

   ```bash
   export GATEWAY_API_KEY="..."
   ```

2. Start Pi or OMP.
3. Run `/providers`.
4. Select **Add provider**.
5. Enter the API base URL, request API, discovery format/path, and credential reference.
6. Select the new model through `/model` after the automatic reload.

The menu stores `GATEWAY_API_KEY`, not its resolved value.

## Configuration files

Default locations:

| Host/profile | Configuration |
|---|---|
| Pi default | `~/.pi/agent/provider-discovery.json` |
| OMP default | `~/.omp/agent/provider-discovery.json` |
| Active profile | `${PI_CODING_AGENT_DIR}/provider-discovery.json` |
| Explicit override | `${PI_PROVIDER_DISCOVERY_CONFIG}` |

Public model metadata cache:

```text
${PI_CODING_AGENT_DIR}/cache/provider-discovery.json
```

See [Configuration](docs/configuration.md) for the complete schema, discovery behavior, metadata precedence, and examples.

## Credentials

Supported credential sources:

```json
{ "kind": "env", "value": "GATEWAY_API_KEY" }
```

```json
{ "kind": "command", "value": "security find-generic-password -ws gateway" }
```

```json
{ "kind": "none" }
```

Never put a raw key in the extension configuration. Header values may use `$ENV_VAR`, `${ENV_VAR}`, or `!command` references.

## Discovery behavior

- Fresh cache avoids startup network access for 24 hours by default.
- `/providers` → **Refresh all models** bypasses the TTL.
- Successful non-empty responses replace the provider cache.
- Failed, empty, malformed, redirected, or oversized responses never replace good cache.
- Stale cache remains available during discovery outages.
- A provider with no live result and no cache is omitted; other providers continue loading.

OpenAI's standard Models API returns only basic identifiers. Configure conservative defaults or exact overrides rather than inferring capabilities or pricing from model names. Anthropic capability and token-limit fields are mapped when returned by its Models API.

## Security

- Secrets resolve only in memory.
- Extension-owned config and cache use mode `0600`.
- Errors omit authorization headers and response bodies.
- Cross-origin redirects are rejected before credentials can be forwarded.
- Automated tests use local/fake endpoints and never call paid providers.

Report vulnerabilities through GitHub's private security advisory flow. See [Security Policy](SECURITY.md).

## Compatibility

The package deliberately uses the common Pi/OMP extension surface:

- async extension factory
- `registerProvider`
- `registerCommand`
- `ui.select`, `ui.input`, `ui.confirm`, and `ui.notify`
- command-context `reload`

OMP's extension-only `fetchDynamicModels` is not used because Pi does not expose it. One discovery/cache path keeps behavior consistent across hosts.

See [Architecture](docs/architecture.md) for module boundaries and failure handling.

## Development

Requirements: Node.js 22.19 or newer.

```bash
npm install
npm run check
npm pack --dry-run
```

`npm run check` typechecks against current Pi and OMP packages, then runs behavioral tests.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Changes affecting configuration, credentials, discovery, or cache behavior require an observable regression test.

## License

MIT. See [LICENSE](LICENSE).
