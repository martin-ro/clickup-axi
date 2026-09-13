export const DESCRIPTION = 'Browse ClickUp workspaces and manage tasks and comments.';

export const GUIDANCE = [
  'Set CLICKUP_API_TOKEN in the environment or .env. The CLI reads tokens but never saves them. No login command or credential store is used.',
  'Run `clickup-axi tasks` for your open tasks; use --assignee all to include other people.',
  'Run `clickup-axi search "<words>" --list <id>` to search task names and descriptions.',
  'Run `clickup-axi task <id>` for a task and its newest comments.',
  'Run `clickup-axi task update <id> --status "<status>"` to change task status.',
  'Run `clickup-axi task create --list <id> --name "<name>"` to create a task.',
  'Run `clickup-axi task comment <id> --text "<text>"` to add a comment.',
  'Use names or IDs for workspaces, Spaces, Folders, Lists, and assignees. List and Folder names need --space. Ambiguous names fail.',
  'Use task update with --parent, --append-description, --add-tag, or --remove-tag. Tags must already exist in the Space.',
  'Run `clickup-axi task move <id> --list <id>` to change the home List. Status remaps must be explicit.',
  'Run `clickup-axi task close <id>` to preview closing. Add --yes only after user approval.',
  '--dry-run is optional: other mutations write by default. A dry run can read ClickUp, but never writes.',
  'Run `clickup-axi <command> --help` for flags and examples. Put flags after the command.',
];

const scope = {
  workspace: 'Workspace name or ID (default: CLICKUP_WORKSPACE_ID, project file, or the only workspace)',
  list: 'List name or ID (names need --space; default: CLICKUP_LIST_ID or project file)',
};
const space = { space: 'Space name or ID (names use the selected workspace)' };
const text = {
  full: 'Do not truncate text (does not fetch more pages)',
  'max-chars': 'Text preview size, 1..100000 (default: 1000)',
};
const taskID = {
  workspace: scope.workspace,
  custom: 'Force custom task ID lookup; PREFIX-123 is detected automatically. Requires a workspace',
};
const dryRun = { 'dry-run': 'Show the request without writing to ClickUp; may make read requests' };
const filters = {
  ...scope, ...space,
  assignee: 'me, all, user ID, name, or email (default: me)',
  status: 'Exact status name',
  tag: 'Exact tag name',
  'include-closed': 'Include closed tasks (default: false)',
  page: 'First API page, zero-based (default: 0)',
  limit: 'Maximum rows to display, 1..100 (default: 100)',
  fields: 'Task columns: id,name,status,list,custom_id,priority,assignees,due_date,url,parent,tags',
};
const changes = {
  name: 'Task name',
  description: 'Plain-text description; an empty string clears it',
  status: 'Exact status name',
  priority: 'urgent, high, normal, low, or none',
  due: 'YYYY-MM-DD at midnight UTC (time enabled), or none to clear',
  assignee: 'Add one user by ID, name, email, or me',
  parent: 'Parent task ID, internal or custom, in the same List; cannot be cleared',
};

export const COMMANDS = {
  home: { usage: 'home', flags: { ...scope, ...space }, description: 'Show project tasks, or workspaces if no project scope is set.' },
  workspaces: { usage: 'workspaces', flags: {}, description: 'List authorized workspaces.' },
  members: { usage: 'members', flags: { workspace: scope.workspace }, description: 'List workspace members and their IDs.' },
  spaces: { usage: 'spaces', flags: { workspace: scope.workspace }, description: 'List active Spaces in a workspace.' },
  folders: { usage: 'folders --space <name|id>', flags: { ...space, workspace: scope.workspace }, description: 'List active Folders in a Space.' },
  lists: { usage: 'lists --space <name|id> | --folder <name|id>', examples: ['lists --space <name|id>', 'lists --folder <id>', 'lists --folder "<name>" --space "<name>"'], flags: { ...space, workspace: scope.workspace, folder: 'Folder name or ID (names need --space)' }, description: 'List active Lists. --space alone returns folderless Lists; --folder returns Folder Lists.' },
  list: { usage: 'list <name|id>', flags: { ...text, ...space, workspace: scope.workspace }, description: 'Read a List, its task count, and allowed statuses. Names need --space.' },
  tags: { usage: 'tags --space <name|id>', flags: { ...space, workspace: scope.workspace }, description: 'List existing task tags in a Space.' },
  tasks: { usage: 'tasks', flags: filters, description: 'List tasks, newest updates first, including subtasks. The default scope is your open tasks.' },
  search: { usage: 'search "<words>"', flags: { ...filters, pages: 'API pages to scan, 1..100 (default: 5)', offset: 'Skip this many matches within the same scan (default: 0)' }, description: 'Find tasks containing every search word in their name or description. Search is local and bounded.' },
  task: { usage: 'task <id>', flags: { ...taskID, ...text }, description: 'Read a task with its five newest comments. Subcommands: create, update, comment, move, close.' },
  'task create': { usage: 'task create --name "<name>" --list <name|id>', flags: { ...scope, ...space, ...changes, tag: 'Existing Space tag; repeat for more tags (commas are literal)', ...dryRun }, description: 'Create a task. Repeating this command creates another task; writes are never retried.' },
  'task update': { usage: 'task update <id> --status "<status>"', flags: { ...taskID, ...changes, unassign: 'Remove one user by ID, name, email, or me', 'append-description': 'Append Markdown to the existing description; cannot combine with --description', 'add-tag': 'Add an existing Space tag; repeat for more tags (commas are literal)', 'remove-tag': 'Remove a task tag, not the Space tag; repeat for more tags', ...dryRun }, description: 'Set task fields and tags. Matching values need no write. Appends are not idempotent. Multi-request edits can partly succeed.' },
  'task comment': { usage: 'task comment <id> --text "<text>"', flags: { ...taskID, text: 'Required comment text', notify: 'Notify all task assignees (default: false)', ...dryRun }, description: 'Post a comment. Repeating this command posts another comment; writes are never retried.' },
  'task move': { usage: 'task move <id> --list <name|id>', flags: { ...taskID, list: 'Required destination List name or ID; names need --space', ...space, status: 'Landing status, only when the destination lacks the current status', ...dryRun }, description: 'Move the home List using API v3. Keeps additional List memberships. Does not request custom-field transfer.' },
  'task close': { usage: 'task close <id> [--yes]', flags: { ...taskID, yes: 'Confirm closing; without this flag, only preview', ...dryRun }, description: 'Use the List status with type closed, not done. --dry-run prevents writing even with --yes.' },
  comments: { usage: 'comments <id>', flags: { ...taskID, ...text, start: 'Cursor timestamp in milliseconds; requires --start-id', 'start-id': 'Cursor comment ID; requires --start' }, description: 'Read up to 25 comments, newest first. Use the returned cursor for older comments.' },
  setup: { usage: 'setup hooks | status | remove [--global]', examples: ['setup hooks', 'setup status', 'setup remove --global'], flags: { global: 'Use user scope instead of the current project' }, description: 'Opt in to Claude Code, Codex, and OpenCode session context. Codex also needs a user-level feature flag, which setup enables.' },
  update: { usage: 'update', flags: {}, description: 'This local package has no self-update service. Reinstall from your checkout.' },
};

export const BOOLEAN_FLAGS = new Set(['help', 'full', 'custom', 'include-closed', 'dry-run', 'notify', 'global', 'yes']);

export function commandHelp(command) {
  const spec = COMMANDS[command];
  return {
    command: `clickup-axi ${spec.usage}`,
    description: spec.description,
    flags: { ...Object.fromEntries(Object.entries(spec.flags).map(([key, value]) => [`--${key}`, value])), '--help': 'Show this reference without authentication' },
    examples: (spec.examples ?? [spec.usage, `${command} --help`]).map(example => `clickup-axi ${example}`),
  };
}

export const TOP_LEVEL_HELP = `clickup-axi: ${DESCRIPTION}

Commands:
  home, workspaces, members, spaces, folders, lists, list, tags
  tasks, search, task, comments
  task create|update|comment|move|close
  setup hooks|status|remove [--global]

Authentication: CLICKUP_API_TOKEN in the environment, then .env. No saved login.
Never put tokens in arguments, chat, or tracked files.
Project scope: .clickup-axi.json with string workspace and list IDs.
Names: use --space with List or Folder names. Ambiguous names fail.
Writes: --dry-run previews; task close also requires --yes to write.
Flags follow the command. Output is TOON. Exit codes: 0 success, 1 error, 2 usage error.
Run clickup-axi <command> --help for flags and examples.
`;
