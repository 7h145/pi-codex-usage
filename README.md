# pi-codex-usage

Small Pi extension that shows the current ChatGPT-backed Codex usage windows.

## Footer status

In TUI mode, the extension fetches usage at session startup, after the agent
settles, and every five minutes while idle. It publishes a compact status such
as:

```text
C W2%
C 5h37% W2%
```

The percentages are usage consumed. The status uses Pi's warning theme above
70% and error theme above 90%. Only active windows returned by OpenAI are shown;
if a 5-hour window is absent, the compact status contains only the weekly one.

Background refresh failures do not show repeated notifications. A recent
successful value is retained unchanged for 15 minutes, then marked stale with
`?` (for example `C W5%?`). After one hour without a successful refresh, or when
no successful value exists, the footer shows `C ?`. A later successful refresh
restores the normal value automatically. `/codex-usage` always reports the
specific request or response error.

For first-line placement, install and enable
[`pi-footer-compositor`](../pi-footer-compositor/). Pi has no manifest mechanism
for extension-to-extension activation dependencies, so this is an optional,
gracefully degraded dependency: without the compositor, Pi displays the compact
value on its ordinary extension-status line. Installing the complete
`pi-assorted` package loads both extensions.

## Command

```text
/codex-usage
```

Example output:

```text
Codex usage (plus)
5h: 23% used, resets in 2h 14m
Week: 48% used, resets in 4d 7h
```

## Authentication

The extension reuses Pi's existing OpenAI Codex OAuth login. If needed, run
`/login` and select **OpenAI Codex**. The access token is obtained through Pi's
model registry on each refresh and is never stored or logged by the extension.

## Important caveat

This extension calls the undocumented ChatGPT backend endpoint
`https://chatgpt.com/backend-api/wham/usage`. It is not part of the public
OpenAI Platform API and may change or disappear without notice. Requests time
out after 15 seconds. OAuth tokens and response bodies are not logged.

## Install / try locally

Install the complete package:

```bash
pi install git:github.com/7h145/pi-assorted
```

Or load the compositor and this extension directly from the repository root:

```bash
pi \
  -e ./extensions/pi-footer-compositor/pi-footer-compositor.ts \
  -e ./extensions/pi-codex-usage/pi-codex-usage.ts
```

If `pi-assorted` is already installed, these explicit files create a second copy
of only the named extensions. Disable their installed copies with `pi config`,
or use `--no-extensions` for an isolated run.

Then run `/codex-usage`.
