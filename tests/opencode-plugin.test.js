#!/usr/bin/env node
// Smoke test for the OpenCode V2 adapter: the plugin's setup registers against
// the real (structural) V2 plugin API shapes. No live OpenCode needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Point the plugin's mode-flag at a temp config home BEFORE it loads — the
// plugin resolves its state path once at load. The dynamic import below runs
// after this assignment, so the ordering holds.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-opencode-'));
process.env.XDG_CONFIG_HOME = tmp;
delete process.env.PONYTAIL_DEFAULT_MODE;
const statePath = path.join(tmp, 'opencode', '.ponytail-active');

let plugin;
test.before(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', '.opencode', 'plugins', 'ponytail.mjs'));
  plugin = (await import(url)).default;
});

// Structural doubles for the V2 plugin context. Each transform/hook captures
// its callback and the registered entities so tests can drive them directly.
async function setupPlugin() {
  const captured = { contextHook: null, commands: [], skills: [], editorShape: null };
  const ctx = {
    session: {
      hook: async (name, callback) => {
        assert.equal(name, 'context');
        captured.contextHook = callback;
      },
      prompt: async (input) => {
        captured.prompted = input;
      },
    },
    command: {
      transform: async (callback) => {
        callback({
          add: (definition) => captured.commands.push(definition),
        });
      },
    },
    skill: {
      transform: async (callback) => {
        const editor = {
          add: (skill) => captured.skills.push(skill),
        };
        callback(editor);
      },
    },
  };
  await plugin.setup(ctx);
  return captured;
}

test('default export is a V2 definition object with id and setup', async () => {
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.id, 'ponytail');
  assert.equal(typeof plugin.setup, 'function');
});

test('context hook injects the ruleset at the default mode (full)', async () => {
  try { fs.unlinkSync(statePath); } catch (e) {}
  const captured = await setupPlugin();
  const system = [];
  await captured.contextHook({ system });
  assert.equal(system.length, 1);
  assert.equal(system[0].type, 'text');
  assert.match(system[0].text, /PONYTAIL MODE ACTIVE — level: full/);
  assert.match(system[0].text, /lazy senior developer/);
});

test('context hook follows the persisted mode and stays silent on off', async () => {
  const captured = await setupPlugin();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  fs.writeFileSync(statePath, 'ultra');
  const ultra = { system: [] };
  await captured.contextHook(ultra);
  assert.match(ultra.system[0].text, /PONYTAIL MODE ACTIVE — level: ultra/);

  fs.writeFileSync(statePath, 'off');
  const off = { system: ['existing'] };
  await captured.contextHook(off);
  assert.deepEqual(off.system, ['existing']);
});

test('commands register from .opencode/command with descriptions', async () => {
  const captured = await setupPlugin();
  const names = captured.commands.map((c) => c.name).sort();
  assert.deepEqual(names, [
    'ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review',
  ]);
  for (const command of captured.commands) assert.ok(command.description, `missing description on /${command.name}`);
});

test('/ponytail execute persists the mode and prompts with the expanded template', async () => {
  try { fs.unlinkSync(statePath); } catch (e) {}
  const captured = await setupPlugin();
  const ponytail = captured.commands.find((c) => c.name === 'ponytail');
  const invocation = { sessionID: 's1', prompt: { text: ' ultra ' }, delivery: 'steer' };
  await ponytail.execute(invocation);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'ultra');
  assert.equal(captured.prompted.sessionID, 's1');
  assert.equal(captured.prompted.delivery, 'steer');
  assert.match(captured.prompted.text, /\$ARGUMENTS|ultra/);
  // The same turn's injection already reflects the new level.
  const system = [];
  await captured.contextHook({ system });
  assert.match(system[0].text, /level: ultra/);
});

test('commands without $ARGUMENTS append the args as a new paragraph', async () => {
  const captured = await setupPlugin();
  const review = captured.commands.find((c) => c.name === 'ponytail-review');
  await review.execute({ sessionID: 's1', prompt: { text: 'focus on hooks' }, delivery: 'queue' });
  assert.match(captured.prompted.text, /focus on hooks$/);
  assert.ok(captured.prompted.text.includes('\n\n'));
});

test('skills register with id, name, description, path, and content', async () => {
  const captured = await setupPlugin();
  const ids = captured.skills.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review',
  ]);
  const main = captured.skills.find((s) => s.id === 'ponytail');
  assert.equal(main.name, 'ponytail');
  assert.ok(main.description.length > 20, 'frontmatter description should parse');
  assert.ok(main.path.endsWith(path.join('skills', 'ponytail', 'SKILL.md')));
  assert.ok(!main.content.startsWith('---'), 'content should be the body without frontmatter');
});

test('skill transform also supports the newer draft.source(embedded) shape', async () => {
  const sources = [];
  await plugin.setup({
    session: { hook: async () => {}, prompt: async () => {} },
    command: { transform: async () => {} },
    skill: {
      transform: async (callback) => {
        callback({
          source: (source) => sources.push(source),
          list: () => [],
        });
      },
    },
  });
  assert.equal(sources.length, 6);
  for (const source of sources) {
    assert.equal(source.type, 'embedded');
    assert.ok(source.skill.name);
    assert.ok(source.skill.location.endsWith('SKILL.md'));
    assert.ok(!source.skill.content.startsWith('---'));
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
