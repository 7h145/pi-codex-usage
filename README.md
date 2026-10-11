# pi-codex-usage

Shows ChatGPT-backed Codex usage in Pi's footer and through `/codex-usage`.
Usage retrieval works with the **`openai-codex` OAuth login**, not the newer
**`openai` ChatGPT login**. See [OpenAI provider limitation](#openai-provider-limitation)
below.

## Footer status

In TUI mode, the extension fetches usage at session startup, after the agent
settles, when the model changes, and every five minutes while idle. It publishes
a compact status such as:

```text
C W2%
C 5h37% W2%
```

The percentages are usage consumed. The status uses Pi's warning theme above
70% and error theme above 90%. Only active windows returned by OpenAI are shown;
if a 5-hour window is absent, the compact status contains only the weekly one.
A malformed present window rejects the whole response rather than disappearing
beside a healthy-looking window. Percentages must be nonnegative; window lengths
must be positive whole seconds. Usage above 100% is displayed, not clamped.

Background refresh failures do not show repeated notifications. A recent
successful value is retained for 15 minutes, then marked stale with
`?` (for example `C W5%?`). After one hour without a successful refresh, or when
no successful value exists, the footer shows `C ?`. A later successful refresh
restores the normal value automatically. Aging and theme styling are checked
once per second, even while the agent is busy; this does not make extra network
requests. Changing provider preference or detecting a different OAuth account
clears the old value rather than presenting another account's usage.

`/codex-usage` reports request or response error categories without including raw
response bodies or credential-refresh details. Shutdown and session replacement
cancel pending work and suppress late notifications.

For first-line placement, install and enable
[`pi-footer-compositor`](https://github.com/7h145/pi-footer-compositor).
The compositor is optional and is not installed automatically. Without it,
Pi displays the compact value on its ordinary extension-status line.

## Command

```text
/codex-usage
```

Available in TUI and RPC modes. Print and JSON modes report an unsupported-mode
error before resolving credentials or fetching usage; notifications would be
invisible there. RPC uses notifications only, without polling or footer status.

Example output:

```text
Codex usage (plus)
Provider: openai-codex
5h: 23% used, resets in 2h 14m
Week: 48% used, resets in 4d 7h
```

## Authentication

Requires Pi 1.0.2 or newer. Run `/login` and choose **OpenAI Codex (legacy)**
(`openai-codex`) to set up the login used for Codex usage retrieval. If you are
already signed in to that provider, no additional login is needed.

The extension reuses the OAuth login through Pi's model registry. It does not
read credential files or store or log tokens. OpenAI Platform API keys cannot
retrieve ChatGPT subscription usage and are never sent to the usage endpoint.

The command's `Provider` line identifies the credentials used to retrieve usage,
not necessarily the selected model provider. If the extension uses another
provider's login as a fallback, the command explains why and the footer adds a
source label, such as `C W2% [legacy]`. See the
[OpenAI provider limitation](#openai-provider-limitation) for how provider
selection affects this.

## Important caveat

This extension calls the undocumented ChatGPT backend endpoint
`https://chatgpt.com/backend-api/wham/usage`. It is not part of the public
OpenAI Platform API and may change or disappear without notice. The complete
refresh has a 15-second deadline, including credential resolution and response
parsing. Pi may finish an OAuth refresh after the extension stops waiting; late
results do not start a usage request. HTTP redirects are refused. OAuth tokens
and response bodies are not logged.

## OpenAI provider limitation

**Usage retrieval with the newer `openai` provider is not supported.** Its
ChatGPT login can work for model requests while being rejected by the usage
endpoint this extension calls. A live usage request returned HTTP 401.
Repeating a valid login is not a remedy. For that provider, check
[ChatGPT's usage page](https://chatgpt.com/settings/usage) instead.

Pi stores `openai` and `openai-codex` logins separately. Switching models does
not migrate credentials or change which authentication method is configured.

The extension tries the selected model's OpenAI provider first; for other
models it tries `openai` first. If that provider is unavailable, has no login,
or uses API-key authentication, it can fall back to the other provider. This
allows legacy Codex usage to be displayed while another model is selected.
But if an `openai` OAuth login is present and its usage request is rejected,
the extension reports the rejection; it does not silently try legacy
credentials afterward. If both logins are present, select an `openai-codex`
model before running `/codex-usage` to query the legacy quota. The extension
does not change your model for you.

A `[legacy]` footer label means the displayed value comes from `openai-codex`.
The reverse fallback is labelled `[openai]`, but that label is not evidence of
working newer-provider usage support. **Legacy Codex quota is not a verified
remaining budget for a selected `openai` model.** This extension does not show
OpenAI Platform API billing or every model-specific limit.

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

## Development

Use Node.js 24 or newer:

```bash
npm ci
npm run check
```

`check` runs TypeScript checking and Node's regression tests. The tests use
synthetic OAuth credentials, a fake clock and mocked HTTP; they do not read
credential files or call ChatGPT. They cover credential selection,
legacy-token and metadata-free-token handling, endpoint rejection, validation,
shared refreshes, cancellation, session replacement, cache aging, themes and
mode guards. Mocked success does not establish live provider support.
CI runs the checks on Node.js 24 with Pi SDKs 1.0.2 and 1.1.0.

## Last confirmed working

| Date | Code revision | Pi | Node.js | Platform |
|---|---|---|---|---|
| 2026-10-11 | `dff3545` | `1.1.0` | `26.10.0` | Linux x64 |

**Checked:** 77 automated regression tests and type checking; isolated scripted
regular/fullscreen TUI with the compositor (metadata-free OAuth handling,
fallback labels, status, command, thresholds, theme changes, sanitized errors,
reload and exit), RPC notifications and print/JSON mode guards. Automated and
scripted checks used synthetic credentials and mocked HTTP. A separate live
request with newer `openai` OAuth returned HTTP 401, not usage data; see the
[OpenAI provider limitation](#openai-provider-limitation).

One known-working configuration, not a supported-version range.
