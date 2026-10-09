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
[`pi-footer-compositor`](https://github.com/7h145/pi-footer-compositor).
The compositor is optional and is not installed automatically. Without it,
Pi displays the compact value on its ordinary extension-status line.

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

## Installation

Install this extension from GitHub:

```bash
pi install git:github.com/7h145/pi-codex-usage
```

For first-line footer placement, also install the optional compositor:

```bash
pi install git:github.com/7h145/pi-footer-compositor
```

These are personal/global installs. Add `-l` to each command for project-local
installs. Run `/reload` after installing or updating while Pi is running,
then run `/codex-usage`.

To try a local checkout without installing, run from its root:

```bash
pi --no-extensions -e .
```

This loads only the checkout's extension, without the optional compositor or
duplicate installed copies. Then run `/codex-usage`.

### Migrating from pi-assorted

If you have the legacy [`pi-assorted`](https://github.com/7h145/pi-assorted)
collection installed, turn off its pi-codex-usage extension before installing this
standalone version. Otherwise Pi will try to load the same extension twice.

Run `pi config` in a terminal. Under the `pi-assorted` package's Extensions
entries, select `pi-codex-usage/pi-codex-usage.ts` and press Space to uncheck it
(`[ ]`). Changes are saved immediately; press Esc to close.

For a project-local collection installation, run `pi config -l` from that
project and press Space until the entry shows `[-]` (project unload).

If you also install the compositor separately, turn off its
`pi-footer-compositor/pi-footer-compositor.ts` entry in the collection too.

See Pi's [resource settings reference](https://pi.dev/docs/latest/settings#resources)
for configuration details.
