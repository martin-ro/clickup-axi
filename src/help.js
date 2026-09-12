export const DESCRIPTION = 'Browse ClickUp workspaces and manage tasks and comments.';

export const GUIDANCE = [
  'Run `clickup-axi tasks` for your open tasks; use --assignee all to include other people.',
  'Run `clickup-axi search "<words>" --list <id>` to search task names and descriptions.',
  'Run `clickup-axi task <id>` for a task and its newest comments.',
  'Run `clickup-axi task update <id> --status "<status>"` to change task status.',
  'Run `clickup-axi task create --list <id> --name "<name>"` to create a task.',
  'Run `clickup-axi task comment <id> --text "<text>"` to add a comment.',
  'Run `clickup-axi spaces --workspace <id>` and `clickup-axi lists --space <id>` to find a List.',
  'Run `clickup-axi <command> --help` for flags and examples. Put flags after the command.',
];

const scope = {
  workspace: 'Workspace ID (default: CLICKUP_WORKSPACE_ID, project file, or the only workspace)',
  list: 'List ID (default: CLICKUP_LIST_ID or project file)',
};
const text = {
  full: 'Do not truncate text (does not fetch more pages)',
  'max-chars': 'Text preview size, 1..100000 (default: 1000)',
};
const taskID = {
  workspace: scope.workspace,
  custom: 'Treat the task ID as a custom ID; requires a selected workspace',
};
const filters = {
  ...scope,
  space: 'Filter by Space ID',
  assignee: 'me, all, or a numeric user ID (default: me)',
  status: 'Exact status name',
  tag: 'Exact tag name',
  'include-closed': 'Include closed tasks (default: false)',
  page: 'First API page, zero-based (default: 0)',
  limit: 'Maximum rows to display, 1..100 (default: 100)',
  fields: 'Task columns: id,name,status,list,custom_id,priority,assignees,due_date,url,parent',
};
const changes = {
  name: 'Task name',
  description: 'Plain-text description; an empty string clears it',
  status: 'Exact status name',
  priority: 'urgent, high, normal, low, or none',
  due: 'YYYY-MM-DD at midnight UTC (time enabled), or none to clear',
  assignee: 'Add one numeric user ID',
};

export const COMMANDS = {
  home: { usage: 'home', flags: scope, description: 'Show project tasks, or workspaces if no project scope is set.' },
  workspaces: { usage: 'workspaces', flags: {}, description: 'List authorized workspaces.' },
  members: { usage: 'members', flags: { workspace: scope.workspace }, description: 'List workspace members and their IDs.' },
  spaces: { usage: 'spaces', flags: { workspace: scope.workspace }, description: 'List active Spaces in a workspace.' },
  folders: { usage: 'folders --space <id>', flags: { space: 'Required Space ID' }, description: 'List active Folders in a Space.' },
  lists: { usage: 'lists --space <id> | --folder <id>', examples: ['lists --space <id>', 'lists --folder <id>'], flags: { space: 'Space ID (folderless Lists only)', folder: 'Folder ID' }, description: 'List active Lists. Use folders to discover Lists inside Folders.' },
  list: { usage: 'list <id>', flags: text, description: 'Read a List, its task count, and allowed statuses.' },
  tasks: { usage: 'tasks', flags: filters, description: 'List tasks, including subtasks. The default scope is your open tasks.' },
  search: { usage: 'search "<words>"', flags: { ...filters, pages: 'API pages to scan, 1..100 (default: 5)', offset: 'Skip this many matches within the same scan (default: 0)' }, description: 'Find tasks containing every search word in their name or description. Search is local and bounded.' },
  task: { usage: 'task <id>', flags: { ...taskID, ...text }, description: 'Read a task with its five newest comments. Subcommands: create, update, comment.' },
  'task create': { usage: 'task create --name "<name>" --list <id>', flags: { list: scope.list, ...changes, parent: 'Internal parent task ID (same List)', 'dry-run': 'Show the request without writing to ClickUp' }, description: 'Create a task. Repeating this command creates another task; writes are never retried.' },
  'task update': { usage: 'task update <id> --status "<status>"', flags: { ...taskID, ...changes, unassign: 'Remove one numeric user ID', 'dry-run': 'Show changed fields without writing to ClickUp' }, description: 'Set task fields. Already-matching values succeed without a write.' },
  'task comment': { usage: 'task comment <id> --text "<text>"', flags: { ...taskID, text: 'Required comment text', notify: 'Notify all task assignees (default: false)', 'dry-run': 'Show the request without writing to ClickUp' }, description: 'Post a comment. Repeating this command posts another comment; writes are never retried.' },
  comments: { usage: 'comments <id>', flags: { ...taskID, ...text, start: 'Cursor timestamp in milliseconds; requires --start-id', 'start-id': 'Cursor comment ID; requires --start' }, description: 'Read up to 25 comments, newest first. Use the returned cursor for older comments.' },
  setup: { usage: 'setup hooks | status | remove [--global]', examples: ['setup hooks', 'setup status', 'setup remove --global'], flags: { global: 'Use user scope instead of the current project' }, description: 'Opt in to Claude Code, Codex, and OpenCode session context. Codex also needs a user-level feature flag, which setup enables.' },
  update: { usage: 'update', flags: {}, description: 'This local package has no self-update service. Reinstall from your checkout.' },
};

export const BOOLEAN_FLAGS = new Set(['help', 'full', 'custom', 'include-closed', 'dry-run', 'notify', 'global']);

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
  home, workspaces, members, spaces, folders, lists, list
  tasks, search, task, task create, task update, task comment, comments
  setup hooks|status|remove [--global]

Authentication: set CLICKUP_API_TOKEN (or CLICKUP_TOKEN). Never put tokens in project files.
Project scope: .clickup-axi.json with string workspace and list IDs.
Flags follow the command. Output is TOON. Exit codes: 0 success, 1 error, 2 usage error.
Run clickup-axi <command> --help for flags and examples.
`;
