'use strict';
const { EventEmitter } = require('events');
const config = require('./config');
const { getDriver } = require('./drivers');
const { KINDS, LABELS } = require('./objects');
const { compareObject } = require('./compare');
const { copyObject } = require('./copier');

/**
 * Library entry. Events: 'items' (after listing), 'item' (an item changed).
 *   const s = new SqlCpy(config.load());
 *   await s.scan(); await s.copy(s.items[0]);
 */
class SqlCpy extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.driver = getDriver(cfg.type);
    this.master = this.driver.createPool(cfg.master, cfg.concurrency);
    this.slave = this.driver.createPool(cfg.slave, cfg.concurrency);
    this.items = [];
  }

  get ctx() {
    return { master: this.master, slave: this.slave, cfg: this.cfg, driver: this.driver };
  }

  _list() {
    const { driver, cfg } = this;
    return Promise.all([driver.listObjects(this.master, cfg.master.database), driver.listObjects(this.slave, cfg.slave.database)]);
  }

  /** List both sides, then compare each object one at a time (gentle on the master). */
  async scan() {
    const [m, s] = await this._list();
    this.items = [];
    for (const kind of KINDS.filter((k) => this.driver.kinds.includes(k))) {
      const names = new Set([...m[kind].map((x) => x.name), ...s[kind].map((x) => x.name)]);
      for (const name of [...names].sort()) {
        this.items.push({
          kind, name,
          master: m[kind].find((x) => x.name === name) || null,
          slave: s[kind].find((x) => x.name === name) || null,
          status: 'checking', detail: '',
        });
      }
    }
    this.emit('items', this.items);
    for (const it of this.items) {
      if (this._stop) return;
      await this.check(it);
    }
  }

  async check(item) {
    item.status = 'checking';
    this.emit('item', item);
    try {
      Object.assign(item, await compareObject(this.ctx, item.kind, item));
    } catch (e) {
      item.status = 'error';
      item.detail = e.message;
    }
    this.emit('item', item);
    return item;
  }

  /** Copy one object master -> slave, then re-compare. */
  async copy(item, { onProgress, signal } = {}) {
    const res = await copyObject(this.ctx, item.kind, item, onProgress, signal);
    const [m, s] = await this._list();
    item.master = m[item.kind].find((x) => x.name === item.name) || item.master;
    item.slave = s[item.kind].find((x) => x.name === item.name) || null;
    await this.check(item);
    return res;
  }

  async close() {
    this._stop = true;
    await Promise.allSettled([this.master.end(), this.slave.end()]);
  }
}

module.exports = { SqlCpy, loadConfig: config.load, KINDS, LABELS };
