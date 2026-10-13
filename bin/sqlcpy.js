#!/usr/bin/env node
'use strict';
const { SqlCpy, loadConfig } = require('../src/index');
const { UI } = require('../src/ui');
const { describe } = require('../src/errors');

const col = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const red = (s) => col(31, s), green = (s) => col(32, s), yellow = (s) => col(33, s), cyan = (s) => col(36, s), gray = (s) => col(90, s), bold = (s) => col(1, s);

async function main() {
  let cfg;
  try {
    cfg = loadConfig(process.argv[2]);
  } catch (e) {
    console.error(`${red('✖ Configuration error:')} ${e.message}`);
    console.error(gray(`  ${e.hint || `Looked for .env in ${process.cwd()} (or pass a path: sqlcpy path/to/.env)`}`));
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(red('✖ sqlcpy needs an interactive terminal.'));
    process.exit(1);
  }

  console.log(`\n ${bold(cyan('sqlcpy'))} ${gray('– checking connections')}\n`);
  const app = new SqlCpy(cfg);
  let failed = false;
  for (const side of ['master', 'slave']) {
    const { host, port, user, database } = cfg[side];
    const target = `${user}@${host}:${port}/${database}`;
    const t0 = Date.now();
    try {
      const [r] = await app[side].query('SELECT VERSION() AS v');
      console.log(` ${green('✔')} ${bold(side.padEnd(6))} ${target} ${gray(`MySQL ${r[0].v} · ${Date.now() - t0}ms`)}`);
    } catch (e) {
      failed = true;
      const d = describe(e);
      console.log(` ${red('✖')} ${bold(side.padEnd(6))} ${target}`);
      console.log(`     ${red(d.code || 'ERROR')} ${d.message}`);
      if (d.hint) console.log(`     ${yellow('→ ' + d.hint)}`);
    }
  }
  if (failed) {
    console.log(`\n ${red('Cannot continue.')} ${gray('Fix the connection(s) above (values come from .env) and run sqlcpy again.')}\n`);
    await app.close();
    process.exit(1);
  }
  new UI(app).start();
}

main().catch((e) => {
  const d = describe(e);
  console.error(`${red('✖ ' + (d.code || 'Error'))} ${d.message}`);
  process.exit(1);
});
