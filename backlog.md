## New Ideas / Backlog

### 1. Task reordering in the sidebar/bar
Allow users to manually reorder TaskDev tasks in the UI.

Status: implemented. Mouse drag-and-drop can reorder tasks and move them
between categories; dropping on the project makes a task uncategorized.
**Move task up** / **Move task down** remain as context-menu fallbacks.

Possible options:
* Drag & drop sorting
* Move up / move down actions
* Persist order in config file
* Decide whether order is global or per workspace

---

### 2. Investigate VS Code native `tasks.json` support
Research whether TaskDev can use `.vscode/tasks.json` instead of `taskdev.json`.

Status: partially implemented. TaskDev can read `.vscode/tasks.json` directly
as a read-only project when a workspace has no root `taskdev.json`. Tasks can
be started/stopped/restarted and exposed to MCP/logs without import.

Questions:
* How much TaskDev metadata can be stored in `tasks.json`?
* Can comments/descriptions/links be represented cleanly?
* Compatibility with normal VS Code tasks
* Risk of breaking existing user workflows
* Whether TaskDev-specific fields are ignored safely by VS Code
* Whether schema validation complains about custom fields

Current finding:
VS Code `tasks.json` has a defined schema with `version`, `tasks`, `inputs`, OS-specific sections, `dependsOn`, `problemMatcher`, etc. Some options are extension-contributed, but custom TaskDev metadata may be problematic if it violates schema validation.

Current implementation:
* `label` / `taskName` -> safe TaskDev `name` plus `detail`
* `command` + `args` -> command
* `options.cwd` -> `cwd`
* `options.env` -> `env`
* `group` / `group.kind` -> `category`
* Runtime state/logs live in workspace-root `.taskdev/`
* Edit operations still require `taskdev.json`

Implementation idea:
* Keep `taskdev.json` as default
* Add optional mode:
  * `storageMode: "taskdev"`
  * `storageMode: "vscode-tasks"`
* Provide migration/import/export later

---

### 3. Add TaskDev comments with website link
Add generated comments near TaskDev-managed sections.

Example:

```jsonc
// Managed by TaskDev
// Website: https://taskdev.example.com
```
