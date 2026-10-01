# Direct connections and the public plugin

The public Perch package in `plugins/perch/` provides a skill. It intentionally contains no `mcp.json`, `.mcp.json` or app binding. Install it for workflow guidance, then connect your own instance separately. Installing the skill alone does not provide command tools.

## Connect your instance

1. Install and expose your Perch instance over HTTPS using the deployment guide.
2. In a compatible client's custom MCP setup, enter `https://<your-perch-host>/mcp`.
3. Use OAuth. With dynamic client registration, optional client ID and secret fields can remain empty unless you provisioned a predefined client.
4. Sign in on your own instance and select **Connect this client**.
5. Discover the tools, request `uptime`, approve it in your instance's `/approvals`, execute and read the result.

If your client or plan does not support custom MCP connections, the skills package cannot add that capability.

Commands and results travel directly between your client and your Perch server. AWTechs does not operate a command relay for this package.

## Distribution

The existing private owner-specific plugin is separate and retains its existing server connection. Never package a maintainer's MCP URL, credentials or private app binding into the public bundle.

Run `python3 scripts/package-public-plugin.py` from the repository root to validate and build `artifacts/perch-plugin.zip`. GitHub Actions also creates this artifact for the workflow's commit. A built ZIP is not a directory publication.

The intended publisher is AWTechs, distribution is free, and targeting is all available countries. Submit the skills-only package through the public submission workflow. Verify the publisher and complete portal attestations. This package does not need new MCP app review cases, a demo recording or reviewer VPS credentials because it bundles no MCP server. Template URL support would be a separate future integration requiring platform eligibility.

See https://perch.awtechs.com/support/, https://perch.awtechs.com/privacy/ and https://perch.awtechs.com/terms/.
