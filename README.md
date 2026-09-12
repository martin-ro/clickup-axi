# clickup-axi

An agent-friendly ClickUp CLI based on the [AXI principles](https://axi.md/).
It uses the ClickUp REST API and `axi-sdk-js`. No MCP server, daemon, or build step.

## Run

Requires Node.js 22 or later.

```sh
npm ci --ignore-scripts
node bin/clickup-axi.js --help
```

Set `CLICKUP_API_TOKEN` in your environment through your shell or secret manager.
Create a personal token in **ClickUp Settings > Apps**. `CLICKUP_TOKEN` is also
accepted. Do not paste tokens into agent conversations, command arguments, or files
in this repository. The CLI does not load `.env` files or store credentials.

```sh
node bin/clickup-axi.js             # accessible workspaces, or scoped project tasks
node bin/clickup-axi.js tasks       # your open tasks in the only available workspace
```

For a local installation:

```sh
npm install -g .
clickup-axi --version
```

This package is private and unpublished. Install from this checkout, not from an
unrelated `clickup-axi` package. No commands check for updates or install packages.

## Common commands

Put flags **after** the command. Every command supports `--help` without credentials.

```sh
clickup-axi workspaces
clickup-axi spaces --workspace 100
clickup-axi folders --space 300
clickup-axi lists --space 300       # folderless Lists only
clickup-axi lists --folder 400      # Lists inside this Folder
clickup-axi list 200                # description, task count, allowed statuses
clickup-axi members --workspace 100

clickup-axi tasks --workspace 100
clickup-axi tasks --list 200 --assignee all
clickup-axi tasks --workspace 100 --assignee 7 --status "in progress"
clickup-axi tasks --list 200 --fields id,name,priority,assignees,due_date
clickup-axi search "login redirect" --list 200 --include-closed
clickup-axi task abc123
clickup-axi task PROJ-42 --custom --workspace 100
clickup-axi task abc123 --full
clickup-axi comments abc123

clickup-axi task create --list 200 --name "Fix login" --description "Check redirects"
clickup-axi task create --list 200 --name "Add a check" --parent abc123
clickup-axi task update abc123 --status "in progress" --priority high
clickup-axi task update abc123 --assignee 7 --unassign 8 --dry-run
clickup-axi task update abc123 --due 2026-12-01
clickup-axi task update abc123 --due none --description ""
clickup-axi task comment abc123 --text "Ready for review"
```

IDs must be explicit. There is no name lookup. `task` and `comments` use internal
task IDs unless you pass `--custom`. Custom IDs require a selected workspace.
A parent ID on task creation must be an internal ID in the same List.

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

Output is [TOON](https://toonformat.dev/), with four task columns by default:
`id,name,status,list`. Use `--fields` to select other supported columns.

- `count` is the number of displayed rows.
- `totalCount` is exact only when the complete scope was read. `null` means unknown.
- Task API pages contain at most 100 tasks. `--page` is zero-based.
- `--limit` limits displayed rows, not the API page size. Follow the hint to see
  hidden rows on that page before moving to the next page.
- Search matches every word against task names and descriptions. It scans at most
  five API pages by default. `--pages` changes this bound, up to 100 pages.
- `scanned`, `matchedInScan`, `hasMore`, and `nextPage` describe the scan. Search
  `--offset` displays the remaining matches in the same scan window. Each command
  reads live data again; pagination is not a snapshot.
- `hasMore` is conservative for a full page if ClickUp supplies no last-page flag.
  The next page can be empty. Totals are never inferred from a full page alone.
- Task details include five newest comments. `comments` returns up to 25. Use both
  `--start` and `--start-id` from the returned `next` cursor to read older comments.
- Descriptions and comment text default to 1,000 Unicode characters. Previews state
  the full size. `--max-chars` changes the bound; `--full` restores text, not pages.

Empty results are explicit. Errors are structured on stdout. Exit codes are
`0` for success, `1` for API or setup failure, and `2` for invalid input.
Unknown flags, duplicate flags, and extra arguments fail before API access.

## Write safety

- `task update` reads current state, changes only supplied fields, and returns
  success without a write if those fields already match.
- Creation and comments are **not idempotent**. Each invocation creates a new item.
  No network request is retried automatically. After an uncertain response, inspect
  ClickUp before repeating a create or comment.
- Every mutation accepts `--dry-run`. Update previews still read the current task.
- `--assignee` adds one user. `--unassign` removes one user. Other assignees stay.
- `--description ""` clears the description using ClickUp's single-space payload.
- `--due YYYY-MM-DD` sets **midnight UTC with time enabled**. ClickUp otherwise
  shifts untimed dates to 4am in the creator's timezone. `--due none` clears it.
- Comments default to `notify_all: false`. Use `--notify` to notify all assignees.
- Requests have a 15-second timeout. Credentials go only to the fixed HTTPS ClickUp
  API origin. Redirects are rejected. Raw error bodies are never printed.
- There are no delete commands, automatic status remaps, or background writes.

## Agent integration

Session hooks are the primary integration. Install them only when wanted:

```sh
clickup-axi setup hooks             # current project
clickup-axi setup status
clickup-axi setup remove

clickup-axi setup hooks --global    # user scope
clickup-axi setup remove --global
```

Setup uses the AXI SDK to install Claude Code and Codex `SessionStart` hooks and an
OpenCode context plugin. It updates their configuration files only on explicit
setup. Repeated setup is a no-op when paths and settings are unchanged.

Project setup writes `.claude/settings.json`, `.codex/hooks.json`, and a managed
plugin under `.opencode/plugins/`. It also enables `[features].hooks = true` in
**`~/.codex/config.toml`**, even for project setup. User setup uses the equivalent
user directories. Removing hooks leaves this shared Codex feature flag enabled.
Existing unrelated hook entries are kept. Setup reports partial failures.

Hooks run the content-first home view with a 10-second host timeout. Authentication
must be available in the host environment. Use a stable install path without spaces
or shell symbols; the current SDK cannot safely quote such paths for every host.

For on-demand guidance instead of session hooks, install
[`skills/clickup-axi/SKILL.md`](skills/clickup-axi/SKILL.md) through your agent's
skill loader. With the Skills CLI, run this from the checkout:

```sh
npx skills add . --skill clickup-axi
```

The skill uses the locally installed binary. Its guidance is generated from
`src/help.js` and checked in CI. You can use hooks, the skill, or both.

## Development

```sh
npm run skill     # regenerate the skill after guidance changes
npm run check     # skill consistency and offline tests
npm pack --dry-run
```

Tests use fake API responses and temporary agent config directories. They do not
need a token or change live ClickUp data. Twelve live read checks also passed,
covering workspace discovery, tasks, search, and comments. They used only GET
requests. Live mutations have not been tested.

This first version does not cover Docs, time tracking, custom-field writes,
attachments, bulk operations, or OAuth login flows.
