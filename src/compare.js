'use strict';

/**
 * Compare one object across master and slave.
 * Returns { status: 'same'|'different'|'missing'|'extra', detail, masterRows?, slaveRows? }
 */
async function compareObject(ctx, kind, item) {
  const { master, slave, cfg, driver } = ctx;
  if (!item.master) return { status: 'extra', detail: 'exists only in slave' };
  if (!item.slave) return { status: 'missing', detail: 'missing in slave' };

  const [mSql, sSql] = await Promise.all([
    driver.getCreateSql(master, kind, item.name).then((s) => driver.normalizeSql(s, cfg.master.database)),
    driver.getCreateSql(slave, kind, item.name).then((s) => driver.normalizeSql(s, cfg.slave.database)),
  ]);
  if (mSql !== sSql) return { status: 'different', detail: kind === 'tables' ? 'schema differs' : 'definition differs' };
  if (kind !== 'tables') return { status: 'same', detail: 'definition identical' };

  const mRows = await driver.count(master, item.name);
  const sRows = await driver.count(slave, item.name);
  const res = { masterRows: mRows, slaveRows: sRows };
  if (mRows !== sRows) return { ...res, status: 'different', detail: `rows ${mRows} vs ${sRows}` };

  if (item.master.bytes <= cfg.checksumMaxBytes) {
    const [a, b] = [await driver.checksum(master, item.name), await driver.checksum(slave, item.name)];
    if (a !== b) return { ...res, status: 'different', detail: 'data checksum differs' };
    return { ...res, status: 'same', detail: 'rows + checksum match' };
  }
  return { ...res, status: 'same', detail: 'rows match (checksum skipped: large table)' };
}

module.exports = { compareObject };
