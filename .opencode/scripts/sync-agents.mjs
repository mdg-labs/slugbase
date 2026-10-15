#!/usr/bin/env node
// Generates .opencode/agents/*.md from .claude/agents/*.md so the agent prompts
// have one source. Only the frontmatter is translated; the body is copied as is.
//   node .opencode/scripts/sync-agents.mjs          write the generated files
//   node .opencode/scripts/sync-agents.mjs --check  exit 1 if they are stale
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDir = join(root, '.claude', 'agents');
const targetDir = join(root, '.opencode', 'agents');
const check = process.argv.includes('--check');

const models = {
  sonnet: 'anthropic/claude-sonnet-5-5',
  opus: 'anthropic/claude-opus-5-5',
};

const colors = {
  green: '#22c55e',
  blue: '#3b82f6',
  yellow: '#eab308',
  red: '#ef4444',
  orange: '#f97316',
  purple: '#a855f7',
};

// OpenCode has one `edit` action for Edit, Write and patch, and no tool allow-list.
// Each Claude `tools` / `disallowedTools` line is expressed as permission rules here.
const scratch = '/tmp/opencode';
const noSubagents = [{ action: 'subagent', resource: '*', effect: 'deny' }];
const readOnlyInvestigator = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'shell', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: `${scratch}/*`, effect: 'allow' },
];
const noNetworkShell = [
  { action: 'shell', resource: 'curl *', effect: 'deny' },
  { action: 'shell', resource: 'wget *', effect: 'deny' },
  { action: 'shell', resource: 'sudo *', effect: 'deny' },
];

const permissions = {
  'task-executor': noSubagents,
  'task-verifier': [...noSubagents, { action: 'edit', resource: '*', effect: 'deny' }],
  'issue-refiner': [
    ...noSubagents,
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'edit', resource: `${scratch}/orchestrate/refine-*-out/*`, effect: 'allow' },
  ],
  'security-reviewer': [...readOnlyInvestigator, ...noNetworkShell],
  'security-verifier': [...readOnlyInvestigator, ...noNetworkShell],
  'ci-investigator': readOnlyInvestigator,
};

// The orchestrate skill picks Opus for risk-flagged work by passing `model: "opus"`.
const opusVariants = ['task-verifier', 'issue-refiner'];

function parse(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no frontmatter`);
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

function render(name, meta, body, modelKey, source) {
  const permissionRules = permissions[name];
  if (!permissionRules) throw new Error(`${source}: no permission mapping for agent "${name}"`);
  const model = models[modelKey];
  if (!model) throw new Error(`${source}: unknown model "${modelKey}"`);
  const variant = meta.effort ? `#${meta.effort}` : '';
  const lines = [
    '---',
    `# Generated from .claude/agents/${name}.md by .opencode/scripts/sync-agents.mjs. Edit the source, then rerun it.`,
    `description: ${JSON.stringify(meta.description)}`,
    'mode: subagent',
    `model: ${model}${variant}`,
  ];
  if (colors[meta.color]) lines.push(`color: ${JSON.stringify(colors[meta.color])}`);
  lines.push('permissions:');
  for (const rule of permissionRules) {
    lines.push(
      `  - action: ${JSON.stringify(rule.action)}`,
      `    resource: ${JSON.stringify(rule.resource)}`,
      `    effect: ${rule.effect}`,
    );
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

const outputs = new Map();
for (const file of readdirSync(sourceDir).filter((f) => f.endsWith('.md')).sort()) {
  const name = file.replace(/\.md$/, '');
  const { meta, body } = parse(readFileSync(join(sourceDir, file), 'utf8'), file);
  const source = `.claude/agents/${file}`;
  outputs.set(`${name}.md`, render(name, meta, body, meta.model, source));
  if (opusVariants.includes(name)) {
    const variantName = `${name}-opus`;
    const opusMeta = {
      ...meta,
      description: `${meta.description} Opus variant: use it when the dispatch calls for Opus.`,
    };
    const text = render(name, opusMeta, body, 'opus', source).replace(
      `.claude/agents/${name}.md by`,
      `.claude/agents/${name}.md (Opus variant) by`,
    );
    outputs.set(`${variantName}.md`, text);
  }
}

let stale = false;
if (!check) mkdirSync(targetDir, { recursive: true });
for (const [file, text] of outputs) {
  const path = join(targetDir, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      console.error(`stale: .opencode/agents/${file}`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote .opencode/agents/${file}`);
  }
}
if (check && existsSync(targetDir)) {
  for (const file of readdirSync(targetDir).filter((f) => f.endsWith('.md'))) {
    if (!outputs.has(file)) {
      console.error(`orphan: .opencode/agents/${file}`);
      stale = true;
    }
  }
}
process.exit(stale ? 1 : 0);
