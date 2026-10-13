'use strict';
const fs = require('fs');
const path = require('path');
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

  get cacheKey() {
    const { cfg } = this;
    const side = (x) => `${x.host}:${x.port}/${x.database}`;
    return `${cfg.type}|${side(cfg.master)}|${side(cfg.slave)}`;
  }

  /** Restore items from the cache file; returns the scan time, or null if there is no usable cache. */
  _loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cfg.cacheFile, 'utf8'));
      if (data.key !== this.cacheKey || !Array.isArray(data.items) || !data.items.length) return null;
      this.items = data.items.map((it) => ({ detail: '', ...it }));
      this.scannedAt = data.scannedAt || null;
      return this.scannedAt || Date.now();
    } catch (e) {
      return null;
    }
  }

  _saveCache() {
    if (this.scanning || this._stop) return;
    const items = this.items.map((it) => {
      const status = it.status === 'queued' || it.status === 'copying' ? (it.prevStatus || 'different') : it.status;
      const { kind, name, master, slave, detail, masterRows, slaveRows, checkedAt } = it;
      return { kind, name, master, slave, status, detail, masterRows, slaveRows, checkedAt };
    });
    try {
      const json = JSON.stringify({ key: this.cacheKey, scannedAt: this.scannedAt, items }, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
      fs.mkdirSync(path.dirname(this.cfg.cacheFile), { recursive: true });
      fs.writeFileSync(this.cfg.cacheFile, json);
    } catch (e) { /* cache is best-effort */ }
  }

  /**
   * Use the cached result when there is one (unless force), otherwise list both sides
   * and compare each object one at a time (gentle on the master).
   * Resolves to { cached, at }.
   */
  async scan({ force = false } = {}) {
    if (!force) {
      const at = this._loadCache();
      if (at) { this.emit('items', this.items); return { cached: true, at }; }
    }
    this.scanning = true;
    try {
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
        if (this._stop) return { cached: false, at: null };
        await this.check(it);
      }
      this.scannedAt = Date.now();
    } finally {
      this.scanning = false;
    }
    this._saveCache();
    return { cached: false, at: this.scannedAt };
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
    item.checkedAt = Date.now();
    this.emit('item', item);
    return item;
  }

  /** Re-list both sides and re-compare a single object. Resolves to null if it no longer exists anywhere. */
  async recheck(item) {
    const [m, s] = await this._list();
    item.master = m[item.kind].find((x) => x.name === item.name) || null;
    item.slave = s[item.kind].find((x) => x.name === item.name) || null;
    if (!item.master && !item.slave) {
      this.items = this.items.filter((i) => i !== item);
      this.emit('items', this.items);
      this._saveCache();
      return null;
    }
    await this.check(item);
    this._saveCache();
    return item;
  }

  /** Copy one object master -> slave, then re-compare. */
  async copy(item, { onProgress, signal } = {}) {
    const res = await copyObject(this.ctx, item.kind, item, onProgress, signal);
    const [m, s] = await this._list();
    item.master = m[item.kind].find((x) => x.name === item.name) || item.master;
    item.slave = s[item.kind].find((x) => x.name === item.name) || null;
    await this.check(item);
    this._saveCache();
    return res;
  }

  async close() {
    this._stop = true;
    await Promise.allSettled([this.master.end(), this.slave.end()]);
  }
}

module.exports = { SqlCpy, loadConfig: config.load, KINDS, LABELS };
