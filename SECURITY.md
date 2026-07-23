# Security Policy

## Supported versions

Security fixes are applied to the latest released minor version. Pre-release branches receive fixes before release but carry no support guarantee.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** private security advisory flow for this repository. Do not open a public issue containing credentials, exploit details, private endpoints, or provider responses.

Include:

- affected version or commit
- Pi or OMP version
- reproduction using synthetic credentials
- impact and trust boundary crossed
- suggested mitigation, if known

Expect acknowledgement within five business days. Public disclosure happens after a fix and coordinated release.

## Security model

The extension owns no secret store. Configuration must contain only environment-variable names, credential commands, or `none` for trusted local endpoints.

Security invariants:

- raw credentials are never written by extension code
- cache stores public model metadata only
- config/cache files are created with mode `0600`
- redirects are rejected before authorization can cross origins
- response size, timeout, and pagination are bounded
- errors omit authorization headers and response bodies
- automated tests do not call paid provider APIs

## Out of scope

- compromise of the user's environment, shell, password manager, or credential command
- malicious code installed as another Pi/OMP extension
- provider behavior after a model request leaves the host
- secrets manually placed in configuration despite documentation and validation
