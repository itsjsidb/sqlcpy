'use strict';
const readline = require('readline');
const { KINDS, LABELS } = require('./objects');
const { describe } = require('./errors');

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', inv: '\x1b[7m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const c = (col, s) => A[col] + s + A.reset;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
};
const fmtNum = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const pad = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
const padL = (s, w) => (s.length > w ? s.slice(0, w) : s.padStart(w));
const bar = (frac, w) => {
  const f = Math.max(0, Math.min(1, frac));
  const n = Math.round(f * w);
  return c('cyan', '█'.repeat(n)) + c('gray', '░'.repeat(w - n));
};

class UI {
  constructor(app) {
    this.app = app;
    this.cursor = 0;
    this.selection = null;
    this.sortBy = 'name';
    this.sortDirection = 1;
    this.scroll = 0;
    this.queue = [];
    this.current = null;
    this.progress = null;
    this.abort = null;
    this.log = [];
    this.frame = 0;
    this.scanning = true;
    this.done = new Map(); // item -> {rows, bytes, file}
  }

  start() {
    const out = process.stdout;
    out.write('\x1b[?1049h\x1b[?25l');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (_, key) => this.onKey(key || {}));
    out.on('resize', () => this.render());
    this.timer = setInterval(() => { this.frame++; this.render(); }, 100);
    this.app.on('items', () => this.render());
    this.app.on('item', () => this.render());
    this.rescan();
    this.render();
  }

  stop() {
    clearInterval(this.timer);
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  note(msg, col = 'gray') {
    this.log.push(c(col, new Date().toLocaleTimeString() + ' ' + msg));
    if (this.log.length > 50) this.log.shift();
  }

  rescan() {
    if (this.current || this.queue.length) return this.note('Finish or cancel copying before rescanning', 'yellow');
    this.scanning = true;
    this.app.scan().then(() => { this.scanning = false; const f = this.items.filter((i) => i.status === 'error').length; this.note(f ? `Scan complete with ${f} error(s) – select the red items for details` : 'Scan complete', f ? 'yellow' : 'green'); })
      .catch((e) => { this.scanning = false; const d = describe(e); this.note(`✖ Scan failed: ${d.code} ${d.message}`, 'red'); if (d.hint) this.note('  → ' + d.hint, 'yellow'); });
  }

  get items() { return this.app.items; }
  sortedItems() {
    const fields = {
      name: (it) => it.name,
      masterRows: (it) => it.kind === 'tables' ? (it.masterRows ?? it.master?.approxRows) : null,
      slaveRows: (it) => it.kind === 'tables' ? (it.slaveRows ?? it.slave?.approxRows) : null,
      size: (it) => it.kind === 'tables' ? it.master?.bytes : null,
      status: (it) => ({ same: 0, different: 1, missing: 2, extra: 3, error: 4, queued: 5, copying: 6, checking: 7 })[it.status],
    };
    const value = fields[this.sortBy];
    const kindOrder = new Map(KINDS.map((kind, index) => [kind, index]));
    return [...this.items].sort((a, b) => {
      const kindDiff = kindOrder.get(a.kind) - kindOrder.get(b.kind);
      if (kindDiff) return kindDiff;
      const aValue = value(a);
      const bValue = value(b);
      if (aValue == null) return bValue == null ? a.name.localeCompare(b.name) : 1;
      if (bValue == null) return -1;
      const diff = typeof aValue === 'string'
        ? aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' })
        : aValue - bValue;
      return diff ? diff * this.sortDirection : a.name.localeCompare(b.name);
    });
  }

  selected(items = this.sortedItems()) {
    if (this.selection && items.includes(this.selection)) {
      this.cursor = items.indexOf(this.selection);
      return this.selection;
    }
    this.cursor = Math.max(0, Math.min(this.cursor, items.length - 1));
    this.selection = items[this.cursor] || null;
    return this.selection;
  }

  async onKey(k) {
    if ((k.ctrl && k.name === 'c') || k.name === 'q') return this.quit();
    const items = this.sortedItems();
    const selected = this.selected(items);
    const n = items.length;
    if (k.name === 'up' || k.name === 'k') this.cursor = Math.max(0, this.cursor - 1);
    else if (k.name === 'down' || k.name === 'j') this.cursor = Math.min(n - 1, this.cursor + 1);
    else if (k.name === 'pageup') this.cursor = Math.max(0, this.cursor - 10);
    else if (k.name === 'pagedown') this.cursor = Math.min(n - 1, this.cursor + 10);
    else if (k.name === 'home') this.cursor = 0;
    else if (k.name === 'end') this.cursor = Math.max(0, n - 1);
    else if (k.name === 'right' || k.name === 'tab') this.jumpSection(1);
    else if (k.name === 'left') this.jumpSection(-1);
    else if (k.name === 's' && k.shift) {
      this.sortDirection *= -1;
      this.cursor = this.sortedItems().indexOf(selected);
      this.note(`Sort ${this.sortBy} ${this.sortDirection === 1 ? 'ascending' : 'descending'}`, 'cyan');
    } else if (k.name === 's') {
      const fields = ['name', 'masterRows', 'slaveRows', 'size', 'status'];
      this.sortBy = fields[(fields.indexOf(this.sortBy) + 1) % fields.length];
      this.cursor = this.sortedItems().indexOf(selected);
      this.note(`Sort by ${this.sortBy} (${this.sortDirection === 1 ? 'ascending' : 'descending'})`, 'cyan');
    } else if (k.name === 'space') this.enqueue(this.selected(), false);
    else if (k.name === 'f') this.enqueue(this.selected(), true);
    else if (k.name === 'a') this.enqueueAll();
    else if (k.name === 'x') this.cancel();
    else if (k.name === 'r') this.rescan();
    if (k.name !== 's') this.selection = this.sortedItems()[this.cursor] || null;
    else this.selected();
    this.render();
  }

  jumpSection(dir) {
    const it = this.selected();
    if (!it) return;
    const items = this.sortedItems();
    const kinds = KINDS.filter((kd) => items.some((i) => i.kind === kd));
    const idx = (kinds.indexOf(it.kind) + dir + kinds.length) % kinds.length;
    this.cursor = items.findIndex((i) => i.kind === kinds[idx]);
    this.selection = items[this.cursor];
  }

  enqueue(item, force) {
    if (!item) return;
    if (item.status === 'extra') return this.note(`${item.name}: only exists in slave, nothing to copy`, 'yellow');
    if (item.status === 'checking') return this.note(`${item.name}: still being compared`, 'yellow');
    if (item.status === 'same' && !force) return this.note(`${item.name}: already in sync – skipped (press f to force)`, 'yellow');
    if (item === this.current || this.queue.includes(item)) return;
    this.queue.push(item);
    item.prevStatus = item.status;
    item.status = 'queued';
    this.pump();
  }

  enqueueAll() {
    for (const it of this.sortedItems()) if (it.status === 'different' || it.status === 'missing') this.enqueue(it, false);
  }

  cancel() {
    for (const it of this.queue) it.status = it.prevStatus || 'different';
    this.queue = [];
    if (this.abort) this.abort.abort();
  }

  async pump() {
    if (this.current) return;
    while (this.queue.length) {
      const item = this.queue.shift();
      this.current = item;
      this.abort = new AbortController();
      this.progress = null;
      item.status = 'copying';
      this.note(`Copying ${item.kind.slice(0, -1)} ${item.name}`, 'cyan');
      try {
        const res = await this.app.copy(item, { signal: this.abort.signal, onProgress: (p) => { this.progress = p; } });
        this.done.set(item, res);
        this.note(`✔ ${item.name} copied (${fmtNum(res.rows)} rows, ${fmtBytes(res.bytes)}) → ${res.file}`, 'green');
      } catch (e) {
        const d = describe(e);
        item.status = e.cancelled ? (item.prevStatus || 'different') : 'error';
        item.detail = e.cancelled ? 'cancelled' : `${d.code ? d.code + ': ' : ''}${d.message}${d.hint ? '  → ' + d.hint : ''}`;
        this.note(e.cancelled ? `⏹ cancelled ${item.name}` : `✖ failed ${item.name}: ${d.code ? d.code + ' ' : ''}${d.message}`, e.cancelled ? 'yellow' : 'red');
        if (!e.cancelled && d.hint) this.note('  → ' + d.hint, 'yellow');
      }
      this.current = null;
      this.progress = null;
      this.abort = null;
    }
    this.render();
  }

  async quit() {
    if (this.abort) this.abort.abort();
    this.stop();
    await this.app.close();
    process.exit(0);
  }

  statusCell(it, w) {
    const sp = SPIN[this.frame % SPIN.length];
    switch (it.status) {
      case 'same': return c('green', pad('✔ in sync', w));
      case 'different': return c('yellow', pad('≠ differs', w));
      case 'missing': return c('red', pad('✖ missing in slave', w));
      case 'extra': return c('gray', pad('• only in slave', w));
      case 'queued': return c('magenta', pad('⧖ queued', w));
      case 'error': return c('red', A.bold + pad('✖ error (see below)', w));
      case 'copying': {
        const p = this.progress;
        const frac = p && p.rowsTotal ? p.rowsDone / p.rowsTotal : 0;
        return c('cyan', sp + ' ') + bar(frac, w - 7) + c('cyan', ' ' + padL(Math.round(frac * 100) + '%', 4));
      }
      default: return c('gray', pad(sp + ' checking', w));
    }
  }

  render() {
    const W = Math.max(60, process.stdout.columns || 100);
    const H = Math.max(15, process.stdout.rows || 30);
    const items = this.sortedItems();
    this.selected(items);
    const L = [];

    const m = this.app.cfg.master, s = this.app.cfg.slave;
    L.push(` ${A.bold}${A.cyan}sqlcpy${A.reset}  ${c('gray', 'master')} ${A.bold}${m.database}${A.reset}${c('gray', '@' + m.host)}  ${c('cyan', '➜')}  ${c('gray', 'slave')} ${A.bold}${s.database}${A.reset}${c('gray', '@' + s.host)}`);
    const cnt = (st) => items.filter((i) => i.status === st).length;
    L.push(` ${c('green', '✔ ' + cnt('same'))} in sync  ${c('yellow', '≠ ' + cnt('different'))} differ  ${c('red', '✖ ' + cnt('missing'))} missing  ${c('gray', '• ' + cnt('extra') + ' extra')}  ${cnt('error') ? c('red', '⚠ ' + cnt('error') + ' error') + '  ' : ''}${c('magenta', '⧖ ' + this.queue.length + ' queued')}` +
      (this.scanning ? '  ' + c('gray', SPIN[this.frame % SPIN.length] + ' scanning ' + items.filter((i) => i.status !== 'checking').length + '/' + items.length) : ''));

    const nameW = Math.max(16, W - 2 - 2 - 12 - 12 - 10 - 24 - 2);
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));
    const indicator = (key) => this.sortBy === key ? (this.sortDirection === 1 ? '↑' : '↓') : '';
    L.push(c('dim', `   ${pad('NAME' + indicator('name'), nameW + 2)}${padL('MASTER ROWS' + indicator('masterRows'), 12)} ${padL('SLAVE ROWS' + indicator('slaveRows'), 11)} ${padL('SIZE' + indicator('size'), 9)}  STATUS${indicator('status')}`));

    // body rows (section headers interleaved)
    const rows = [];
    let lastKind = null;
    items.forEach((it, idx) => {
      if (it.kind !== lastKind) {
        lastKind = it.kind;
        const inKind = items.filter((i) => i.kind === it.kind);
        const bad = inKind.filter((i) => ['different', 'missing'].includes(i.status)).length;
        rows.push({ header: ` ${A.bold}${LABELS[it.kind]}${A.reset} ${c('gray', '(' + inKind.length + ')')}${bad ? ' ' + c('yellow', bad + ' need copy') : ''}` });
      }
      rows.push({ it, idx });
    });

    const footerH = 9;
    const bodyH = Math.max(3, H - L.length - footerH);
    const curRow = Math.max(0, rows.findIndex((r) => r.idx === this.cursor));
    if (curRow < this.scroll) this.scroll = curRow;
    if (curRow >= this.scroll + bodyH) this.scroll = curRow - bodyH + 1;
    if (this.scroll > 0 && rows[this.scroll] && !rows[this.scroll].header && rows[this.scroll - 1]?.header && curRow > this.scroll) this.scroll--;

    for (const r of rows.slice(this.scroll, this.scroll + bodyH)) {
      if (r.header) { L.push(r.header); continue; }
      const it = r.it;
      const sel = r.idx === this.cursor;
      const mRows = it.kind === 'tables' ? (it.masterRows != null ? it.masterRows : it.master && it.master.approxRows) : null;
      const sRows = it.kind === 'tables' ? (it.slaveRows != null ? it.slaveRows : it.slave && it.slave.approxRows) : null;
      const size = it.kind === 'tables' && it.master ? fmtBytes(it.master.bytes) : it.kind === 'triggers' && it.master ? it.master.table : '';
      const nameCol = pad(it.name, nameW);
      const line = `${sel ? c('cyan', '❯ ') : '  '}${sel ? A.inv + nameCol + A.reset : nameCol}  ${padL(fmtNum(it.kind === 'tables' && it.master ? mRows : null), 11)} ${padL(fmtNum(it.kind === 'tables' && it.slave ? sRows : null), 11)} ${padL(size, 9)}  ${this.statusCell(it, 24)}`;
      L.push(line);
    }
    while (L.length < 4 + bodyH) L.push('');

    // footer
    L.push(c('gray', ' ' + '─'.repeat(W - 2)));
    const cur = this.current;
    if (cur) {
      const p = this.progress || {};
      const frac = p.rowsTotal ? p.rowsDone / p.rowsTotal : 0;
      const el = p.started ? (Date.now() - p.started) / 1000 : 0;
      const spd = el > 0 ? p.bytesDone / el : 0;
      const eta = frac > 0 ? el / frac - el : 0;
      L.push(` ${c('cyan', SPIN[this.frame % SPIN.length])} ${A.bold}${cur.name}${A.reset} ${c('gray', p.phase === 'schema' ? 'creating schema…' : p.keyed === false ? '(no primary key – offset paging)' : '')}`);
      L.push(` ${bar(frac, Math.min(50, W - 40))} ${padL((frac * 100).toFixed(1) + '%', 6)}  ${fmtNum(p.rowsDone || 0)}/${fmtNum(p.rowsTotal || 0)} rows`);
      L.push(c('gray', `   chunk ${p.chunk || 0}/${p.chunks || 0} · ${fmtBytes(p.bytesDone || 0)} · ${fmtBytes(spd)}/s · ETA ${fmtTime(eta)} · elapsed ${fmtTime(el)}`));
    } else {
      const it = this.selected();
      const dcol = { same: 'green', different: 'yellow', missing: 'red', error: 'red', extra: 'gray' }[it && it.status] || 'gray';
      const detail = it ? (it.detail || it.status) : '';
      L.push(it ? ` ${A.bold}${it.name}${A.reset} ${c(dcol, '– ' + detail.slice(0, Math.max(10, W - it.name.length - 8)))}` : '');
      L.push(it && detail.length > W - it.name.length - 8 ? '   ' + c(dcol, detail.slice(W - it.name.length - 8, W * 2 - it.name.length - 16)) : '');
      L.push('');
    }
    const logs = this.log.slice(-3);
    while (logs.length < 3) logs.unshift('');
    for (const l of logs) L.push(' ' + l);
    L.push(
      c('bold', ' ↑↓') +
      c('gray', ' move |') +
      c('bold', ' ←→ ') +
      c('gray', ' tab section |') +
      c('bold', ' space') +
      c('gray', ' copy |') +
      c('bold', ' a') +
      c('gray', ' copy all |') +
      c('bold', ' f') +
      c('gray', ' force |') +
      c('bold', ' s') +
      c('gray', ' sort column |') +
      c('bold', ' S') +
      c('gray', ' sort ASC/DESC |') +
      c('bold', ' x') +
      c('gray', ' cancel |') +
      c('bold', ' r') +
      c('gray', ' rescan |') +
      c('bold', ' q') +
      c('gray', ' quit')
    );

    process.stdout.write('\x1b[H' + L.slice(0, H).map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  }
}

module.exports = { UI };
