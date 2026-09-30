# Authentication

Perch separates the owner browser session from MCP client authentication. OAuth consent permits a client to request commands; it does not grant the client authority to approve them.

## Owner

The owner password is a separate secret in the service environment. Browser sessions are random, expire after one hour, rotate on sign-in and are lost on restart. Forms require a session-bound CSRF token. Production cookies use Secure, HttpOnly and SameSite=Strict. Owner pages escape command text, client-supplied metadata and output.

The login limiter trusts the socket address unless explicit reverse-proxy addresses are configured. Configure `TRUST_PROXY` narrowly and have the proxy replace forwarded headers. Otherwise clients may share a login-rate bucket, or a misconfigured trusted proxy may allow address spoofing.

## OAuth

Discovery endpoints:

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/mcp`

The resource identifier is exactly `<PUBLIC_URL>/mcp`. Authorization and token requests for another resource are rejected. The server supports the authorization-code flow with S256 PKCE, dynamic client registration, issuer identification, refresh rotation and token revocation. No implicit or client-credentials grant is provided.

A client registers exact HTTPS redirect URIs; HTTP is limited to loopback development callbacks. The owner sees the app-provided name, registered client ID and callback before consenting. Names are not verified client identities.

Authorization requests expire after ten minutes. Approved codes expire after two minutes and are single-use. Access tokens expire after one hour; refresh tokens expire after thirty days. A reused refresh token revokes its family. Disabling a client revokes all its OAuth tokens and command access.

Access/refresh tokens and authorization codes are stored as hashes. OAuth client metadata, including confidential client secrets, is encrypted with AES-256-GCM using the separate `oauth.key` file. Back up that key together with the database and protect both. Changing `PUBLIC_URL` requires clients to reconnect because token resources are bound to the old origin.

## ChatGPT

Add the public HTTPS `/mcp` URL as a custom MCP connection and choose OAuth. ChatGPT discovers the server, registers a client, and sends the user through Perch's owner sign-in and consent screen. Copy the callback shown by the connection setup if configuring a predefined client; do not guess callback URLs. Perch's DCR flow uses the client-provided registered URI and exact matching during exchange.

See [OpenAI's MCP authentication documentation](https://developers.openai.com/plugins/build/auth) for the current connection contract. A successful local protocol test is not evidence that an actual ChatGPT connection has completed; verify linking and a harmless approved command in the real client before relying on it.

## Token clients

The owner can create named clients at `/clients`. The random token is shown once and only its hash is stored. Use separate credentials for separate clients. Sharing a token shares its approval identity. Disable a compromised client and provision a new one; do not reuse its ID for another person or application.
