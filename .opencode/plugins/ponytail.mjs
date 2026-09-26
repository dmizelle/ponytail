// ponytail — OpenCode V2 plugin.
//
// Registers the ponytail ruleset injection, slash commands, and bundled skills
// with OpenCode V2's plugin API. V2 requires a default-exported definition
// object ({ id, setup }); the V1 shape (default-exported async function
// returning a hooks map) is rejected at load. The shared instruction builder in
// hooks/ stays the single source of truth for all adapters.

import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const { getPonytailInstructions } = require('../../hooks/ponytail-instructions');
const { getDefaultMode, normalizePersistedMode } = require('../../hooks/ponytail-config');
const { parseCommandFile } = require('./ponytail-frontmatter.cjs');

const statePath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode',
  '.ponytail-active',
);

function readMode() {
  try {
    return normalizePersistedMode(fs.readFileSync(statePath, 'utf8').trim()) || getDefaultMode();
  } catch (e) {
    return getDefaultMode();
  }
}

function writeMode(mode) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, mode);
}

// Same substitution rule OpenCode applies to config commands: $ARGUMENTS is
// replaced in place when the template has it, otherwise the arguments are
// appended as a new paragraph.
function expandTemplate(template, args) {
  if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', args);
  return args ? `${template}\n\n${args}` : template;
}

// ponytail: hand-rolled frontmatter reader, not YAML — the bundled SKILL.md
// files use exactly two shapes (plain `key: value` and folded `key: >` blocks).
// If a skill ever needs real YAML, swap this for a YAML parser.
function parseSkillFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fallbackName = path.basename(path.dirname(file));
  if (!match) return { name: fallbackName, description: undefined, content: raw.trim() };

  let name;
  let description;
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^name:\s*(.+)$/);
    if (nameMatch) name = nameMatch[1].trim();
    const descMatch = lines[i].match(/^description:\s*(.*)$/);
    if (descMatch) {
      const inline = descMatch[1].trim();
      if (inline && inline !== '>') {
        description = inline;
      } else {
        const folded = [];
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) folded.push(lines[j].trim());
        description = folded.join(' ');
      }
    }
  }
  return { name: name || fallbackName, description, content: match[2].trim() };
}

function loadSkills() {
  const skillsDir = path.resolve(__dirname, '../../skills');
  const skills = [];
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const parsed = parseSkillFile(file);
      skills.push({ id: entry.name, path: file, ...parsed });
    }
  } catch (e) {}
  return skills;
}

export default {
  id: 'ponytail',
  async setup(ctx) {
    // Inject the ruleset at the active level into every agent-loop model call.
    await ctx.session.hook('context', (event) => {
      const mode = readMode();
      if (mode === 'off') return;
      event.system.push({ type: 'text', text: getPonytailInstructions(mode) });
    });

    // Register the /ponytail* commands from the shared markdown templates.
    // When the package is installed as a plugin, its .opencode/command/ files
    // are not in any discovered config directory, so they must be added here.
    const commandDir = path.join(__dirname, '..', 'command');
    await ctx.command.transform((editor) => {
      try {
        for (const file of fs.readdirSync(commandDir).filter((f) => f.endsWith('.md'))) {
          const name = path.basename(file, '.md');
          const parsed = parseCommandFile(path.join(commandDir, file));
          if (!parsed) continue;
          editor.add({
            name,
            description: parsed.description,
            execute: async ({ sessionID, prompt, delivery }) => {
              const args = String(prompt?.text || '').trim();
              // Persist `/ponytail <level>` before prompting so the same turn's
              // context hook already injects at the new level.
              if (name === 'ponytail') {
                const mode = args ? normalizePersistedMode(args) : getDefaultMode();
                if (mode) writeMode(mode);
              }
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: expandTemplate(parsed.template, args),
                delivery,
              });
            },
          });
        }
      } catch (e) {}
    });

    // Register the bundled skills. The skill editor shape changed across V2
    // releases; support both: editor.add (2.0.x) and draft.source with an
    // embedded skill (newer releases).
    const skills = loadSkills();
    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        if (typeof editor.source === 'function') {
          editor.source({
            type: 'embedded',
            skill: {
              name: skill.name,
              ...(skill.description === undefined ? {} : { description: skill.description }),
              location: skill.path,
              content: skill.content,
            },
          });
        } else {
          editor.add({
            id: skill.id,
            name: skill.name,
            ...(skill.description === undefined ? {} : { description: skill.description }),
            path: skill.path,
            content: skill.content,
          });
        }
      }
    });
  },
};
