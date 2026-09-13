# clickup-axi

Browse ClickUp workspaces and manage tasks with compact TOON output.
This [AXI](https://axi.md/) uses Node.js 22+ built-ins and the ClickUp REST API.
No external packages or separate official ClickUp CLI are needed.

## Agent integration

Use opt-in session hooks for project context at session start. Use the self-contained
skill for on-demand guidance. Choose either, or both. Ordinary commands install neither.

### Session hooks (opt-in)

From your project directory, run the bundled script at its actual install path:

```sh
node /path/to/clickup-axi/scripts/clickup-axi.mjs setup hooks
node /path/to/clickup-axi/scripts/clickup-axi.mjs setup status
node /path/to/clickup-axi/scripts/clickup-axi.mjs setup remove
```

Use `--global` for user scope instead of project scope. Install hooks only when asked.

Setup uses Node.js built-ins to install Claude Code and Codex `SessionStart` hooks
and an OpenCode context plugin. It updates their configuration files only on
explicit setup. Repeated setup is a no-op when paths and settings are unchanged.

Project setup writes `.claude/settings.json`, `.codex/hooks.json`, and a managed
plugin under `.opencode/plugins/`. It also enables `[features].hooks = true` in
**`~/.codex/config.toml`**, even for project setup. User setup uses the equivalent
user directories. Removing hooks leaves this shared Codex feature flag enabled.
Existing unrelated hook entries are kept. Setup reports partial failures.
Complex TOML requires manual configuration of the Codex feature flag; setup does
not try to parse it. Status reports `null` when the flag cannot be verified.
Unrecognized OpenCode plugin files are not replaced or removed.

Hooks run the content-first home view with a 10-second host timeout. The host must
have access to `CLICKUP_API_TOKEN` in its environment or the project's `.env`.
Hooks use a verified PATH binary only when it resolves to this executable. Otherwise
they use safely quoted Node and script paths. Setup repairs moved paths. Shell hooks
use POSIX quoting; real Windows shells have not been tested.
The OpenCode plugin caches context once per session.

### Self-contained skill

Install the complete [`skills/clickup-axi`](skills/clickup-axi) directory through your
agent's skill loader. It includes `SKILL.md` and the runnable `scripts/*.mjs` files.
No checkout, npm install, `node_modules`, or global binary is needed on that machine.
Keep the user's project as cwd, not the skill directory. Node.js 22+ and a token are
required. Project config is optional. The skill is generated from the static home
and help guidance in `skills/clickup-axi/scripts/help.mjs` and checked for drift.
No session-end transcript capture is implemented.

## Run from a checkout

```sh
node bin/clickup-axi.js --help
node bin/clickup-axi.js             # workspaces, or scoped project tasks
node bin/clickup-axi.js tasks --help
```

Optional local binary installation is `npm install -g .`. Then `clickup-axi` uses the
same bundled runtime. This package is private and unpublished. Do not install an
unrelated package with that name. No command installs packages or checks for updates.

## Authentication

Credential order:

1. `CLICKUP_API_TOKEN` in the process environment.
2. `CLICKUP_API_TOKEN` in the closest `.env` that defines it, up to the Git root.

There are no login commands, saved credentials, OS credential-store access, or
browser login. The CLI reads tokens but never saves them.

This is the only supported token environment variable. `.env` loading reads only
that key. It does not run shell code, expand variables, change the process environment,
or import workspace/List defaults. `.env` remains plain text; keep it out of Git.
The CLI does not create or change `.env` or store tokens in `.clickup-axi.json`.

Credentials are read once per command. An invalid or rejected credential fails
without trying a lower-priority token. A token must contain 1 to 4096 printable
ASCII characters without spaces. An unreadable, non-regular, or oversized `.env`
file fails instead of silently selecting an ancestor's token. The size limit is
1 MiB. Use `clickup-axi workspaces` to check access with a GET request.

## Commands

Put flags after the command. Every command supports `--help` without credentials or
project config reads. Help and follow-up hints show a runnable invocation, with a
verified binary or the actual Node and script paths.

```sh
node bin/clickup-axi.js workspaces
node bin/clickup-axi.js tasks --list 200 --assignee all
node bin/clickup-axi.js task abc123
node bin/clickup-axi.js task update --help
```

Workspaces, Spaces, Folders, Lists, and assignees accept names or IDs. Lookup uses
case-insensitive exact matches first, then a unique name substring. Assignees also
accept exact email addresses and `me`. Ambiguous names fail with candidate IDs.
List and Folder names require `--space`. List lookup checks folderless Lists and
all active Folders in that Space. It never uses a partial inventory after an error.
Numeric IDs avoid name discovery. Explicit workspace and Space scopes still check
ownership. Internal task IDs with --workspace require a task read before comments
or comment writes. Missing ownership data fails closed. Project defaults remain IDs.

Tasks still require IDs, not titles. `PREFIX-123` custom IDs are detected automatically;
use `--custom` for other custom-ID formats. Custom IDs require a selected workspace.
Parent IDs can be internal or `PREFIX-123` custom IDs, and must be in the same home List.

Tags on create (`--tag`) and update (`--add-tag`, `--remove-tag`) are repeatable.
Commas are literal, not separators. Other flags cannot repeat. For text that starts
with a dash, use the equals form: `--append-description="- New item"`.

`tasks` and `search` include subtasks and exclude closed tasks by default.
The default assignee is `me`. Use `--assignee all` for all visible assignees.
Status and tag filters are exact matches. A workspace is selected automatically
only when the token has access to exactly one workspace.

## Project context

Create `.clickup-axi.json` at the project root:

```json
{
  "workspace": "100",
  "list": "200"
}
```

Both fields are optional string IDs. No other keys are accepted. The nearest file
is used, stopping at the Git root. This repository ignores the local file.

Precedence is explicit flags, then `CLICKUP_WORKSPACE_ID` / `CLICKUP_LIST_ID`, then
the project file. The default List constrains both listing and search, including
when other filters are supplied. Without a List scope, queries use the workspace.

With a project scope, no arguments shows your five most recently updated open
tasks. Without a scope, it shows authorized workspaces instead of unrelated tasks.

## Output and pagination

Output is [TOON](https://toonformat.dev/) 4.1, with four task columns by default:
`id,name,status,list`. Use `--fields` to select other supported columns.
A local encoder handles JSON-shaped output with commas and two-space indentation.
It uses JavaScript numbers; missing values and non-finite numbers become `null`.
Invalid Unicode surrogates fail instead of changing text. There is no format library.

- `count` is the number of displayed rows.
- `totalCount` is exact only when the complete scope was read. `null` means unknown.
- Task API pages contain at most 100 tasks. `--page` is zero-based.
- `--limit` limits displayed rows, not the API page size. Follow the hint to see
  hidden rows on that page before moving to the next page.
- Search matches every word against task names and descriptions. It scans at most
  five API pages by default. `--pages` changes this bound, up to 100 pages.
- Ordinary task lists return `page`, `hasMore`, and, when needed, `nextPage`.
  Search also returns `scanned`, `matchedInScan`, `firstPage`, and `pages`. Search
  `--offset` displays the remaining matches in the same scan window. Each command
  reads live data again; pagination is not a snapshot.
- `hasMore` is conservative for a full page if ClickUp supplies no last-page flag.
  The next page can be empty. Totals are never inferred from a full page alone.
- Task details include five newest comments. `comments` returns up to 25. Use both
  `--start` and `--start-id` from the returned `next` cursor to read older comments.
- Descriptions and comment text default to 1,000 Unicode characters. Previews state
  the full size. `--max-chars` changes the bound; `--full` restores text, not pages.

Unset scope fields and search-only metadata are omitted from ordinary task lists.
Update and close previews contain each request body once, under `requests`.
Self-contained detail and no-op results omit unrelated next steps.
Empty results are explicit. Errors are structured on stdout. Exit codes are
`0` for success, `1` for API or setup failure, and `2` for invalid input.
Unknown flags, duplicate non-repeatable flags, and extra arguments fail before API access.

## Write safety

- `task update` reads current state, changes only supplied fields, and returns
  success without a write if those fields already match.
- Creation, comments, and description appends are **not idempotent**. Repeating
  them adds content again. No network request is retried automatically. After an
  uncertain response, inspect ClickUp before repeating a write.
- `--dry-run` is **optional**, not the default. Without it, mutations write.
  The exception is `task close`, which previews unless you supply `--yes`.
  `--dry-run` always prevents writes, even with `--yes`. Previews can make GET
  requests to resolve names and check task state, statuses, parents, and tags.
- `task close` selects the List's `closed`-type status, not its `done` status.
  Already-closed tasks need no write. Closing hides tasks from default listings.
- `task move` changes the **home List**, not additional List memberships. It uses
  API v3, moves subtasks with their parent, and does not request custom-field
  transfer. It requires an explicit destination, never a project default. If the
  destination lacks the current status, you must supply `--status`. If it has that
  status, a different override is rejected. ClickUp may reject moves with other
  status conflicts, including subtask conflicts. No extra status write is hidden.
- `--parent` rejects self-parenting, parent cycles, and parents in another home List.
  The API cannot promote a subtask by clearing its parent. Use ClickUp for that.
- Added tags must already exist in the Space. Exact case-insensitive matches use
  the stored name to avoid creating tags from typos. Removal affects the task only.
  Matching tag and parent changes need no write.
- Tag edits use one request per tag, followed by one field update if needed. All
  lookups and checks finish before writes start, but these requests are **not a
  transaction**. A failure reports confirmed writes and warns that the failed
  request may also have succeeded. No rollback is attempted. Inspect before retrying.
- `--assignee` adds one user. `--unassign` removes one user. Other assignees stay.
- `--description ""` clears the description using ClickUp's single-space payload.
- `--append-description` reads Markdown source and appends with a blank line. It
  fails if the source is unavailable. It cannot combine with `--description`.
  This is a read-modify-write operation, not an atomic append. Concurrent edits
  can be overwritten; do not use it while another editor is changing the description.
- `--due YYYY-MM-DD` sets **midnight UTC with time enabled**. ClickUp otherwise
  shifts untimed dates to 4am in the creator's timezone. `--due none` clears it.
- Comments default to `notify_all: false`. Use `--notify` to notify all assignees.
- Requests have a 15-second timeout. Credentials go only to the fixed HTTPS ClickUp
  API origin. Redirects are rejected. Raw error bodies are never printed.
- There are no task-delete commands, automatic status remaps, or background writes.

## Development

```sh
npm run skill     # regenerate skill guidance and the leaf version module
npm run check     # generated-file checks and offline tests
npm pack --dry-run
```

Offline tests use fake API responses, copied skill directories, and fake homes and
projects. They do not use real credentials, live ClickUp data, or actual user hooks.
Version latency is checked against the Node console.log startup floor. The tested
runtime is Node.js 24.18.0; Node 22 is the declared minimum, not a tested host here.
Live mutations and real agent-host hook execution were not tested in this refactor.

This version does not cover Docs, time tracking, custom-field writes, attachments,
bulk operations, or OAuth login flows.
