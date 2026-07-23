# Configuration

The `/providers` command owns `provider-discovery.json`. Manual editing remains supported for automation and advanced model overrides.

## Location precedence

1. `PI_PROVIDER_DISCOVERY_CONFIG`
2. `${PI_CODING_AGENT_DIR}/provider-discovery.json`
3. Host default: `~/.pi/agent/provider-discovery.json` or `~/.omp/agent/provider-discovery.json`

The cache is stored under the active agent directory at `cache/provider-discovery.json`.

## Complete example

```json
{
  "version": 1,
  "cacheTtlMs": 86400000,
  "providers": [
    {
      "id": "gateway",
      "name": "Gateway",
      "enabled": true,
      "baseUrl": "https://gateway.example/v1",
      "api": "openai-completions",
      "discovery": {
        "format": "openai",
        "path": "/models",
        "timeoutMs": 15000
      },
      "credential": {
        "kind": "env",
        "value": "GATEWAY_API_KEY"
      },
      "headers": {
        "User-Agent": "my-gateway-client/1.0",
        "X-Tenant": "$GATEWAY_TENANT"
      },
      "defaults": {
        "reasoning": false,
        "input": ["text"],
        "cost": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0
        },
        "contextWindow": 128000,
        "maxTokens": 8192
      },
      "overrides": {
        "reasoning-model": {
          "name": "Reasoning Model",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      },
      "include": ["chat-*", "reasoning-model"],
      "exclude": ["*-deprecated"]
    }
  ]
}
```

## Provider fields

| Field | Required | Description |
|---|---:|---|
| `id` | yes | Lowercase provider identifier used by `/model` |
| `name` | yes | Menu display name |
| `enabled` | yes | Whether startup discovers and registers the provider |
| `baseUrl` | yes | HTTPS API base; HTTP is accepted only for localhost |
| `api` | yes | Request protocol used after model selection |
| `discovery.format` | yes | Models API response shape: `openai` or `anthropic` |
| `discovery.path` | yes | Path appended to `baseUrl` |
| `discovery.timeoutMs` | no | Per-page timeout, maximum 60 seconds |
| `credential` | yes | Environment, command, or unauthenticated reference |
| `headers` | no | Discovery and inference request headers |
| `defaults` | yes | Conservative metadata for missing API fields |
| `overrides` | yes | Exact model-ID metadata corrections |
| `include` | no | Allowed exact IDs or `*` glob patterns |
| `exclude` | no | Rejected exact IDs or `*` glob patterns |

## Request APIs

- `openai-completions`: OpenAI-compatible Chat Completions
- `openai-responses`: OpenAI-compatible Responses API
- `anthropic-messages`: Anthropic-compatible Messages API

Request API and discovery format are independent. A gateway may expose an OpenAI-shaped Models API while routing selected models through an Anthropic-compatible Messages API.

## Endpoint composition

The discovery path is appended to the base URL rather than resolved from the origin.

```text
baseUrl: https://gateway.example/v1
path:    /models
result:  https://gateway.example/v1/models
```

For Anthropic directly:

```text
baseUrl: https://api.anthropic.com
path:    /v1/models
result:  https://api.anthropic.com/v1/models
```

## Credential references

### Environment

```json
{ "kind": "env", "value": "GATEWAY_API_KEY" }
```

The package translates this canonical reference to each host's native syntax. The resolved key exists only in memory during discovery.

### Command

```json
{ "kind": "command", "value": "op read op://vault/gateway/key" }
```

Commands have a 10-second timeout and 64 KiB output limit. Empty output fails closed.

### No authentication

```json
{ "kind": "none" }
```

Use only for trusted local endpoints.

## Header references

Header values support:

- literal: `"custom-client/1.0"`
- environment: `"$TENANT_TOKEN"` or `"${TENANT_TOKEN}"`
- command: `"!security find-generic-password -ws tenant-token"`

Do not place raw authorization values in headers. Use the credential field for normal bearer or `x-api-key` authentication.

## Metadata precedence

For each model:

1. Exact `overrides[modelId]`
2. Compatible-provider response metadata
3. Provider `defaults`
4. Built-in conservative defaults

OpenAI's standard Models API does not report context limits, output limits, pricing, or capabilities. Zero cost means unknown tracking data, not free service.

Anthropic fields mapped when present:

- `display_name`
- `max_input_tokens`
- `max_tokens`
- `capabilities.image_input.supported`
- `capabilities.thinking.supported`

## Cache and refresh

- Default TTL: 24 hours
- Cache contains public normalized metadata only
- Empty or invalid responses never replace good cache
- Stale cache is accepted when live discovery fails
- `/providers` → **Refresh all models** bypasses TTL

Deleting the cache is safe; the next startup performs live discovery.
