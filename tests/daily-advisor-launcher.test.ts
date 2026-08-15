import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// daily-advisor.ps1 runtime isolation.
//
// The launcher used to hardcode one developer's absolute checkout path, which meant the scheduled
// task executed whatever branch that checkout happened to be on -- including unmerged feature work.
// These are [static] source assertions, the same technique tests/creative-ai-background-worker.test.ts
// already uses for install-background-worker.ps1: a PowerShell launcher cannot be imported, and
// executing it would fetch, commit and push to origin, so the file's text is the contract.

const ps1 = readFileSync(new URL("../daily-advisor.ps1", import.meta.url), "utf8");

// ---- no hardcoded absolute developer checkout path ---------------------------------------------

test("[static] the launcher contains no absolute developer checkout path", () => {
  assert.doesNotMatch(ps1, /C:\\Users\\Admin/i);
  assert.doesNotMatch(ps1, /C:\/Users\/Admin/i);
  // The repository name itself must not be baked in either -- that is what pinned it to one
  // checkout and prevented a dedicated automation controller from ever owning the run.
  assert.doesNotMatch(ps1, /aly-shin-product-lab/i);
  // Any drive-absolute assignment to $projectPath is the exact defect being prevented.
  assert.doesNotMatch(ps1, /\$projectPath\s*=\s*["'][A-Za-z]:/);
});

// ---- explicit ProjectPath override --------------------------------------------------------------

test("[static] the launcher accepts an explicit -ProjectPath parameter", () => {
  assert.match(ps1, /\[string\]\$ProjectPath/, "ProjectPath must be a declared parameter");

  // Declared inside the param() block, not assigned as an ordinary variable further down. The
  // block ends at the first `)` alone on its own line -- ValidateSet's own parens are inline.
  const start = ps1.indexOf("param(");
  const paramBlock = ps1.slice(start, start + ps1.slice(start).search(/^\)\s*$/m));
  assert.match(paramBlock, /\$ProjectPath/, "ProjectPath must be declared in the param() block");

  // The pre-existing parameters must survive -- the scheduled task passes -Source.
  for (const existing of [/\$Source/, /\$Force/, /\$SkipClaude/]) {
    assert.match(paramBlock, existing, `existing parameter ${existing} must be preserved`);
  }
  assert.match(paramBlock, /ValidateSet\("supabase", "sample"\)/);
});

// ---- default repository-path resolution ---------------------------------------------------------

test("[static] omitting -ProjectPath resolves to the repository containing the script", () => {
  assert.match(ps1, /\$projectPath\s*=\s*if\s*\(\[string\]::IsNullOrWhiteSpace\(\$ProjectPath\)\)\s*\{\s*\$PSScriptRoot\s*\}\s*else\s*\{\s*\$ProjectPath\s*\}/);
});

test("[static] the default never walks up the tree to an unrelated parent repository", () => {
  // The parent chain reaches a real, unrelated git repository at the user profile root, so any
  // upward search for .git could silently resolve to the wrong project.
  for (const forbidden of [/Split-Path\s+.*\$PSScriptRoot.*-Parent/i, /while\s*\(.*\.git.*\)/i, /Resolve-Path\s+["']\.\.["']/i]) {
    assert.doesNotMatch(ps1, forbidden, `launcher must not search upward for a repository root: ${forbidden}`);
  }
});

test("[static] the preflight still verifies the resolved path is the right repository", () => {
  // This is what makes an explicit -ProjectPath safe: a wrong path aborts rather than running.
  assert.match(ps1, /Test-Path \(Join-Path \$projectPath "\.git"\)/);
  assert.match(ps1, /scripts\\daily-advisor\\run\.ts/);
  assert.match(ps1, /Abort-Preflight/);
  assert.match(ps1, /exit 2/);
});

// ---- no regression to the dedicated worktree / branch behaviour --------------------------------

test("[static] the dedicated artifact branch and worktree architecture is unchanged", () => {
  assert.match(ps1, /\$artifactBranch\s*=\s*"automation\/daily-advisor"/);
  assert.match(ps1, /\$worktreePath\s*=\s*Join-Path \$projectPath "\.worktrees\\daily-advisor"/);
  assert.match(ps1, /git worktree add/);

  // Publication remains fetch -> reset/rebase -> commit -> push, on the artifact branch only.
  for (const required of [/git fetch origin/, /reset --hard "origin\/\$artifactBranch"/, /git -C \$worktreePath rebase/, /git -C \$worktreePath commit -m/, /git -C \$worktreePath push origin \$artifactBranch/]) {
    assert.match(ps1, required, `publication step must be preserved: ${required}`);
  }
});

test("[static] every git write is scoped to the dedicated worktree, never to main", () => {
  assert.doesNotMatch(ps1, /push origin main/);

  // Line-by-line rather than one broad regex: a git write must carry `-C $worktreePath`, which is
  // what keeps publication inside the artifact worktree instead of whatever branch the controller
  // checkout is on. `git worktree add` is the one legitimate exception -- it creates that worktree.
  const writes = /\b(commit|push|add -f|reset --hard|rebase)\b/;
  const offenders = ps1
    .split(/\r?\n/)
    .filter((line) => /(^|\s)git\s/.test(line) && writes.test(line))
    .filter((line) => !line.includes("-C $worktreePath") && !line.includes("git worktree add"));

  assert.deepEqual(offenders, [], `every git write must be scoped to $worktreePath:\n${offenders.join("\n")}`);
});

// ---- output-path cleanliness --------------------------------------------------------------------

test("[static] the local output directory stays ignored, and the worktree force-add is preserved", () => {
  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

  // Already ignored before this change -- asserted so a future .gitignore edit cannot silently
  // start dirtying whichever checkout runs the launcher.
  assert.match(gitignore, /^\/daily-advisor\/output\/$/m);
  assert.match(gitignore, /^\/daily-advisor\/\.run\.lock$/m);
  assert.match(gitignore, /^daily-advisor-session\.log$/m);

  // The rule the dedicated automation controller depends on: the launcher creates its artifact
  // worktree at <projectPath>/.worktrees/daily-advisor, so without this the controller would report
  // an untracked directory after every single run and stop being a clean, pinned checkout.
  assert.match(gitignore, /^\/\.worktrees\/$/m);

  // The force-add is the deliberate counterpart: the artifact branch is the one place these files
  // ARE meant to be tracked. Removing it would silently stop publishing the briefing.
  assert.match(ps1, /git -C \$worktreePath add -f daily-advisor\/output/);
});
