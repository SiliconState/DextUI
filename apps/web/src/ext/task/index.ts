// task extension: Finder command and /tasks for the shared task workspace.
// The panel edits the same <cwd>/.dext/tasks/<name>.task.json the agent holds.
import { registerCommand, registerSlash } from "../registry";
import { openTasks } from "../../lib/tasks.svelte";

registerCommand({
  slug: "tasks.open",
  label: "Tasks — shared task workspace",
  group: "app",
  run: () => openTasks(),
});

registerSlash({
  cmd: "/tasks",
  desc: "Open the shared task workspace",
  run: () => {
    openTasks();
    return true;
  },
});
