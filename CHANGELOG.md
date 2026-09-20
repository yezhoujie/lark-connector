# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ([Semantic Versioning](https://semver.org/)), released
as git tags `vX.Y.Z`. A release is installed from the repository by content, so a version is only a tag you can
pin (`npx skills add 'yezhoujie/lark-connector#v0.2.0'`).

## lark-connector

Before 0.2.0 this repository was a section of the `agent-remote-communication-skills` monorepo, tagged
`agent-lark/vX.Y.Z` there; the entries below for those versions are unchanged, and the same versions are
tagged plain `vX.Y.Z` here.

### [0.2.0][lark-connector-0.2.0] - 2026-09-20

#### Changed

- The repository and the CLI it ships are renamed from `agent-lark` to `lark-connector`; the skill keeps its
  name, `agent-lark`. Install moves to `npx skills add yezhoujie/lark-connector` (`--skill agent-lark` is now
  optional — it is the only skill this repository publishes); the layout inside the repository moves the
  skill's contents to `skill/agent-lark/` (was `skills/agent-lark/`) and the READMEs up to the repository
  root.
- Every reaction event the daemon receives is logged as `reaction.event` (message id, emoji, action, operator) before
  the filters, so "why did my reaction do nothing" can be read off `daemon.log`.

#### BREAKING

Everything the earlier version named after itself changes name; a first launch under the new name migrates
what it can on its own (below), but a few things do not carry over automatically:

| what | before | now |
|---|---|---|
| environment variable prefix | `AGENT_LARK_*` | `LARK_CONNECTOR_*` |
| state directory | `~/.agent-lark` | `~/.lark-connector` |
| config directory | `~/.config/agent-lark` | `~/.config/lark-connector` |
| keychain service | `agent-lark` | `lark-connector` |
| Windows named pipe prefix | `agent-lark-` | `lark-connector-` |
| project state directory | `.agent-lark/` | `.lark-connector/` |
| phone → agent injection prefix | `[agent-lark remote] ` | `[lark-connector remote] ` |
| setup hand-off report line | `[agent-lark] setup: …` | `[lark-connector] setup: …` |
| CLI self-name / stderr prefix | `agent-lark: …` | `lark-connector: …` |
| Feishu group marker (description) | `agent-lark · <project root>` | `lark-connector · <project root>` |

#### Added

- The first command run after upgrading migrates what an `agent-lark` install left behind, on its own: the
  state directory and the config directory to their default `lark-connector` locations, the keychain entry
  to the new service name, and — the first time a command runs inside a project that used the channel
  before — that project's state directory. Nothing is deleted, only moved or copied; both the old and the
  new directory existing leaves the old one alone and warns naming both. An old daemon still listening on
  the legacy state directory is guarded against (exit 4, naming its endpoint) so it is stopped with its own
  CLI first. A group's old marker description is still recognised when looking for a project's group, so
  nothing needs re-binding.

#### Docs

- README moved from `skill/agent-lark/README.md` to the repository root and rewritten for the new install
  address, the plugin marketplace note, and upgrading from `agent-lark` 0.1.x; SKILL.md, `references/` and
  `examples/` keep `agent-lark` only where it names the skill or a slash command.

### [0.1.4][agent-lark-0.1.4] - 2026-09-18

#### Added

- Injection now follows the CLI in the target pane (`herdr agent list`). A **kimi** is woken with `ctrl+s`
  after the prompt, as agent-ntfy already did (it reads its queue only between turns); a refused key gets a
  `Maybe not delivered` receipt. A **claude that is working** gets no key: Claude Code hands queued text to
  the model as soon as the running tool call ends, and its send-now key (`ctrl+enter`, ≥ 2.1.276)
  interrupts that call — so the phone message is marked ✈️ (`StatusInFlight`) instead of `Get`, and
  **a reaction the human adds to that message** makes the daemon press the key; the decision stays with
  the human, per message, with nothing new in the group. ✈️ becomes `Get` by itself when the session
  transcript records the entry as read or herdr reports the pane idle; after 30 minutes without either
  sign the message is forgotten and ✈️ left as it is. The app needs the `im:message.reactions:read` scope
  and the `im.message.reaction.created_v1` event — `setup` asks for them now; an existing app needs
  `setup --update`. New `queued.*` / `transcript.*` log events; `references/daemon.md` §5 has
  the table and the transcript caveat.
- README §2.1: two Feishu accounts on one Mac — install the App Store build (`com.bytedance.macos.feishu`)
  next to the feishu.cn build (`com.electron.lark`); they are independent apps with their own data
  directories, so one account signs in to each with no script and no background service. The one limit
  (browser → desktop-client authorization always wakes the same one; this channel never goes through it) and
  a link to feishu-dual for those who need that re-routed.

#### Fixed

- A herdr refusal (`agent_not_found`, `agent_blocked`, …) was read as "herdr is not installed": herdr 0.9.1
  prints the error envelope on stderr and exits 1, and the adapter only looked at stdout on exit 0. Both
  streams are read now, so the receipt card names the real reason.

### [0.1.3][agent-lark-0.1.3] - 2026-09-16

#### Added

- The repository now doubles as a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`), so this
  skill can also be installed with `claude plugin marketplace add yezhoujie/agent-remote-communication-skills`
  followed by `claude plugin install agent-lark@agent-remote-communication-skills`. `npx skills add` is
  unaffected.

#### Changed

- The tests moved out of the skill directory to `tests/lark/` at the repository root, so what
  `npx skills add` installs no longer carries them — 232 KB less, with the shipped `dist/cli.mjs`,
  `SKILL.md`, both READMEs, `references/` and `examples/` untouched.
- The development toolchain moved to the repository root too: `package.json`, `package-lock.json`, both
  `tsconfig*.json` and `scripts/` now live there, and `skills/agent-lark/` holds only what ships
  (`SKILL.md`, both READMEs, `references/`, `examples/`, `dist/cli.mjs`, `src/`) — installing this skill
  as a Claude Code plugin no longer finds a manifest and a lockfile in the plugin root and runs an
  `npm ci` in it. Build, type-check and tests run from the repository root: `npm ci && npm test`.
- `dist/cli.mjs` was rebuilt for that move. The only differences inside the bundle are the path
  comments esbuild writes above each module and the matching module keys, which are relative to the
  build's working directory and so now read `// skills/agent-lark/src/cli.ts` rather than
  `// src/cli.ts`; dependency paths are unchanged and no logic is.

### [0.1.2][agent-lark-0.1.2] - 2026-09-15

#### Added

- `unbind --dissolve` dissolves the project's group in Feishu (`im.v1.chat.delete`) and forgets its record,
  for a group the human does not want offered back. Feishu dissolving it exits 0
  (`Dissolved Feishu group "…"; the local record is removed.`); Feishu refusing — the app can only dissolve
  a group it owns, or one it created with the `im:chat:operate_as_owner` scope — or the call failing exits 4
  with the reason and `Dissolve it by hand in Feishu`, the record removed all the same and the group's
  marker description replaced so it is not offered back (a group whose marker could not be cleared either
  is offered back until it is dissolved — the line says which); not connected exits 3 with nothing
  touched; a daemon from before this version exits 3 naming the restart.
  The plain `unbind` is unchanged. SKILL.md and the example rule now have the agent ask whether the group
  should stay before choosing.
- The daemon forgets records of groups that no longer exist in Feishu (dissolved, or the bot removed from
  them): once a day, right after the first successful handshake, and whenever `bind` / `away on` looks for
  a group to offer back. The list is read page by page straight from `im.v1.chat.list`; a page Feishu
  refused, a missing `page_token`, more than 100 pages, a thrown call or no connection leaves every record
  in place (`bindings.sweep-skipped` in the log), and a project with a question pending keeps its live
  record that round. A live record found gone leaves the allowlist and sets `chatId: null` in the project's
  `state.json` (the `away` switch is left as it was, so the next `ask` exits 4 as not bound).
- A state directory too deep for a Unix socket is reported as such: `daemon`, `daemon --detach` and
  `away on` exit 4 with `socket path <home>/daemon.sock is N bytes, over this platform's limit of M; set
  AGENT_LARK_HOME to a shorter directory` before anything is spawned (no 10 s wait, and before the
  credentials are looked at), every other command answers rc 3 with the same sentence instead of
  `connect EINVAL`, `status` shows it as `daemon: cannot run here (…)`, and `away off` still switches the
  local state off. The limit is 104 bytes on macOS and the BSDs, 108 on Linux; Windows (named pipe) has none.

#### Changed

- The daily sweep timer is always armed: `AGENT_LARK_MEDIA_TTL_DAYS=0` keeps every attachment as before
  but no longer switches off the sweep of stale group records.

#### Fixed

- `send-file` with a relative path (`send-file out/shot.png`) no longer fails with `file not found`: the path
  is resolved against the directory the command runs in before it reaches the daemon, which has a working
  directory of its own. The `file not found` message now names the resolved absolute path.
- An option's value is no longer mistaken for a command's positional argument when it comes first:
  `send-file --caption "a note" ./shot.png` used to look for a file named `a note`, and `away --name x on`
  refused `--name` as unknown. The positional is the first argument that is neither an option nor the value
  of one the command takes (`rename`, `send-file`, `away`), and an option's value is the token right after
  it whatever it looks like — `--caption --draft` used to drop the caption silently, and `away on --name --new`
  also switched on `--new`.

### [0.1.1][agent-lark-0.1.1] - 2026-09-15

#### Added

- `setup` is guided: on a terminal it opens with a menu — create a new app by QR code, or reuse an app you
  already have. The reuse branch asks for the App ID and the App Secret (typed blind, never echoed), checks
  the pair against Feishu once (Feishu's code and message are shown on a refusal; three refusals exit 1),
  stores it like a QR-code setup does, and prints the scopes, the event subscription and the card callback
  that must be enabled by hand in the developer console. `setup --reuse` goes there without the menu.
- `setup --reuse` without a terminal (an agent running it) hands the typing over: inside herdr it opens a pane
  below the caller's and runs the interactive setup there, then injects one `[agent-lark] setup: …` line back
  into the caller's session (`--report-to <pane>`; success, failure, interruption and "credentials already
  stored" each have their line) and offers to close the pane (`--close-pane`); outside herdr it exits 4 and
  prints the command for the human to run in their own terminal. The new pane takes focus; every end that is
  not success sends a `failed: <why>` line.
- `/agent-lark setup`, `/agent-lark on`, `/agent-lark off`: three arguments the agent understands
  (SKILL.md, "Invoked with an argument") — guided setup, remote mode on (through setup when there are no
  credentials yet), remote mode off.
- `AGENT_LARK_OFFLINE=1` makes `setup` refuse both of its network calls (exit 3); the test runner sets it, so
  no test can register an app or probe credentials by accident.

#### Changed

- Every subcommand refuses an option it does not know (`unknown option --xyz`, exit 1) instead of ignoring
  it; option values take a space (`--name x`), `--home=<dir>` remains the one `=` form.
- `away off` no longer needs the daemon: with none running it still switches the project's `state.json` off
  and exits 0, saying `daemon is not running; local state cleared`.
- The App Secret is masked as `***` in every error text, log line and report line that could otherwise
  quote it.
- `npm test` rebuilds `dist/cli.mjs` after the type check, so the CLI tests always run the current sources.
- `setup` ends by telling the user to go back to the agent session and say "turn remote mode on" or type
  `/agent-lark on`, instead of listing `daemon --detach` and `away on` for them to run by hand.
- Multi-line bilingual texts (the `setup` menu) print the Chinese block and then the English block instead of
  joining them on one line.
- README rewritten as a user guide (180 lines): setup by hand or through your agent, then what you say and
  what the agent does; file locations, environment variables, exit codes and the CLI reference moved to
  `references/`.
- SKILL.md: the `setup --reuse` command handed to the human outside herdr must be run in a terminal window of
  their own — never suggested inside the agent session (no TTY there).

#### Removed

- `setup --app-id` and `setup --store` (the reuse branch and `AGENT_LARK_STORE` replace them).
- The env file (`~/.config/agent-lark/.env`, `AGENT_LARK_ENV_FILE`) and the unprefixed `LARK_APP_ID` /
  `LARK_APP_SECRET` names: credentials come from `AGENT_LARK_APP_ID` / `AGENT_LARK_APP_SECRET`, the OS
  keychain, or `credentials.json`, and from nowhere else. Credentials that lived only in an env file need one
  `setup --reuse`.

### [0.1.0][agent-lark-0.1.0] - 2026-09-15

First release of the Feishu / Lark channel: the same ask-and-block contract as agent-ntfy, carried by a
Feishu custom app of your own instead of a public notification service.

#### Added

- `ask`: one JSON on stdin becomes a Feishu card with one button per option; the reply (the tapped label, or
  whatever was typed in the group) comes back verbatim on stdout, exit codes 0 / 1 / 2 / 3 / 4 as in agent-ntfy.
  Irreversible options carry `danger: true` (red button behind a native confirm dialog) and can never be the
  recommendation; `select: "multi"` renders tick boxes plus a Submit button and returns the ticked labels joined
  with `、`; `--urgent` additionally flags the card to the app owner in-app (any refusal is only a `note:`);
  `lang` (`zh` / `en`, default `en`) selects the card's fixed wording. Answered cards turn green with the reply on
  top, timed-out and cancelled cards grey; the buttons lock on the first tap.
- `notify` (one-way card, Markdown body) and `send-file` (an image or a file into the project group, only from
  the project, the media directory or the temp directory; 10 MB images / 30 MB files).
- One Feishu group per project, named `<task> [<dir>]` and marked with the project path in its description.
  `away on --name "<task>"` starts the daemon, waits for Feishu, creates the group (or, on exit 4, lists the
  groups this project let go of earlier for `--reuse <chat_id>` / `--new`) and only then switches remote mode on;
  `rename "<task>"`, `unbind` (the group stays in Feishu and is offered back next time), `bind --chat <id>` for a
  group made by hand, `status` for the whole picture. Groups are found again from their description when the
  local records are gone.
- Phone → agent, with [herdr](https://herdr.dev): messages sent in the group while no question is pending are
  injected into the project's pane as `[agent-lark remote] …`, a `Get` reaction marks delivery, an orange receipt
  card says why when delivery is impossible; a Feishu reply to one of the skill's cards arrives as
  `(reply to: "<card title>")`; photos and files are downloaded and listed as `[saved: <path>]`; voice notes are
  transcribed (a failure is reported with Feishu's code and message instead of a placeholder). Attachments are kept
  under `~/.agent-lark/media/` and swept after `AGENT_LARK_MEDIA_TTL_DAYS` (7) days.
- The 🔔 *waiting for you* card: pushed while remote mode is on and herdr reports the session stuck on a prompt
  only a human can answer, at most once a minute per project.
- The daemon opens its local endpoint before the Feishu handshake and retries the handshake with backoff, so an
  offline machine never crash-loops; a Unix socket on macOS / Linux, a named pipe on Windows; `daemon --stop` is
  refused while a question is pending unless `--force`; `daemon --status` reports the connection and the media
  directory.
- `setup`: creates the Feishu app by QR code (retrying on network errors), or adopts an existing one with
  `--app-id` and the secret from the environment / env file; credentials go to the macOS keychain, a Windows
  DPAPI file, Linux `secret-tool`, or a `0600` file; `--update` re-authorizes, `--reset` starts over.
- Documentation for the agent (`SKILL.md`, `references/{daemon,failures,message-spec}.md`) and for people
  (`README.md`, `README.zh-CN.md`), plus a ready-made remote-mode rule in English and Chinese
  (`examples/remote-mode-rule*.md`).
- `node --test` suite (cards, validation, IPC, daemon with a fake Feishu channel, the CLI against a fake daemon)
  on ubuntu / windows / macos × Node 22 / 24.

[lark-connector-0.2.0]: https://github.com/yezhoujie/lark-connector/compare/v0.1.4...v0.2.0
[agent-lark-0.1.4]: https://github.com/yezhoujie/lark-connector/compare/v0.1.3...v0.1.4
[agent-lark-0.1.3]: https://github.com/yezhoujie/lark-connector/compare/v0.1.2...v0.1.3
[agent-lark-0.1.2]: https://github.com/yezhoujie/lark-connector/compare/v0.1.1...v0.1.2
[agent-lark-0.1.1]: https://github.com/yezhoujie/lark-connector/compare/v0.1.0...v0.1.1
[agent-lark-0.1.0]: https://github.com/yezhoujie/lark-connector/releases/tag/v0.1.0
