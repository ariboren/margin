# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please don't open a public issue. I'll reply in the report.

## Scope

- The local daemon: its HTTP server, the Host and Origin checks, and anything that lets a web page or another local user reach it.
- The per-daemon token: how it is generated, stored and checked.
- File access: opening files a doc links to, serving images beside the doc, and writes to the doc and its `.margin/` sidecar.
- The `margin` CLI run against a doc you didn't write.

Out of scope: an attacker who already runs code as your user, since they can read your files and the token directly, and the agent you connect to margin.

## Threat model

margin runs on your machine for one user.

- The daemon listens on 127.0.0.1 only. It accepts `127.0.0.1` and `localhost` as the Host, and a request that changes anything must come from the daemon's own origin.
- Each daemon generates a random token when it starts. The tab URL carries it and every API request must present it. It is stored in a 0600 file inside a 0700 state directory.
- Docs are often written by an AI agent, so margin treats them as untrusted input. Raw HTML renders as text, and the page's Content Security Policy allows only the daemon's own scripts. Images load only from the doc's directory. Links open only text and document file types, checked on the real path so a symlink can't get around it. Links with other schemes, such as `javascript:` or `file:`, render as plain text.
