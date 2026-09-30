# Security policy

Perch is an early alpha. Only the latest development version receives fixes, and the project does not yet claim production security assurance.

Do not publish exploit details, tokens or production logs in public issues. Use GitHub's private vulnerability reporting for this repository when available; otherwise contact the maintainer privately through the contact information on their GitHub profile. Do not include credentials in your first message.

Useful reports include the affected commit/version, the security boundary crossed, a minimal reproduction using disposable infrastructure, expected behaviour, observed behaviour and impact. Do not test against another person's installation.

## Scope

Authentication bypass, owner-consent bypass, approval replay, cross-client access, token audience mistakes, unsafe archive extraction, privileged deployment compromise and unintended credential disclosure are in scope.

An explicitly approved root command modifying the host is expected root capability, not a sandbox escape. A saved rule invoking a subsequently changed script is a documented limitation of exact-command approval. These limitations do not excuse code that executes a pending or revoked request.

Read [the threat model](docs/threat-model.md) before exposing an installation.
