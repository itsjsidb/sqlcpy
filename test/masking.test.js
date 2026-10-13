'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rules } = require('../src/rules');
const mysql = require('../src/drivers/mysql');
const { resolveScope } = require('../src/scope');

const columns = [
  { name: 'id', type: 'int', nullable: false, maxLen: null },
  { name: 'external_id', type: 'varchar', nullable: false, maxLen: 32 },
  { name: 'first_name', type: 'varchar', nullable: false, maxLen: 20 },
  { name: 'last_name', type: 'varchar', nullable: false, maxLen: 20 },
  { name: 'email', type: 'varchar', nullable: true, maxLen: 60 },
  { name: 'display_name', type: 'varchar', nullable: false, maxLen: 40 },
  { name: 'password', type: 'varchar', nullable: false, maxLen: 255 },
  { name: 'phone', type: 'varchar', nullable: true, maxLen: 15 },
  { name: 'login_count', type: 'int', nullable: false, maxLen: null },
];

function context(masks) {
  return {
    master: {},
    cfg: {
      master: { database: 'master' },
      maskSalt: '',
      rules: new Rules({ sensitive: { columns: { users: masks } } }),
    },
    driver: {
      ...mysql,
      columns: async () => columns,
      primaryKey: async () => ['external_id'],
    },
  };
}

test('parses literal and other-column replacement rules', () => {
  const rules = new Rules({
    sensitive: {
      columns: {
        users: {
          nickname: { value: 'Example' },
          display_name: { from: 'first_name' },
          password: { concat: [{ column: 'first_name' }, '@123', { column: 'last_name' }] },
          phone: 'random',
        },
      },
    },
  });
  assert.deepEqual({ ...rules.tableRule('users').masks }, {
    nickname: { value: 'Example' },
    display_name: { from: 'first_name' },
    password: { concat: [{ column: 'first_name' }, '@123', { column: 'last_name' }] },
    phone: 'random',
  });
});

test('exposes configured ranges as range scope', () => {
  const rules = new Rules({ range: { users: { column: 'created_at', last: '7d' } } });
  assert.equal(rules.scopeOf('users').mode, 'range');
});

test('rejects malformed replacement rules', () => {
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { value: 'x', from: 'name' } } } } }),
    /give exactly one of "value", "from", or "concat"/,
  );
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { value: { unsafe: true } } } } } }),
    /must be a string, number, boolean, or null/,
  );
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { concat: [{ column: 'first_name' }, 42] } } } } }),
    /must be text or \{ "column": "name" \}/,
  );
});

test('builds escaped custom, derived, and random expressions for the master SELECT', async () => {
  const ctx = context({
    email: { value: "x' OR 1=1 --" },
    display_name: { from: 'first_name' },
    password: { concat: [{ column: 'first_name' }, "@123' OR 'x'='x", { column: 'last_name' }] },
    phone: 'random',
    login_count: 'random',
  });
  const scope = await resolveScope(ctx, 'users');

  assert.ok(scope.select.includes("'x\\' OR 1=1 --'"));
  assert.match(scope.select, /`first_name` AS `display_name`/);
  assert.ok(scope.select.includes("CONCAT(`first_name`, '@123\\' OR \\'x\\'=\\'x', `last_name`) AS `password`"));
  assert.ok(scope.select.includes('LEFT(MD5(RAND()), 15) AS `phone`'));
  assert.ok(scope.select.includes('FLOOR(RAND() * 10) AS `login_count`'));
  assert.deepEqual(scope.masked, ['email', 'display_name', 'password', 'phone', 'login_count']);
});

test('rejects deriving from a masked column or a key column', async () => {
  await assert.rejects(
    resolveScope(context({ first_name: 'random', display_name: { from: 'first_name' } }), 'users'),
    /derives from "first_name", which is also masked/,
  );
  await assert.rejects(
    resolveScope(context({ display_name: { from: 'external_id' } }), 'users'),
    /derives from primary-key \/ range column "external_id"/,
  );
  await assert.rejects(
    resolveScope(context({
      first_name: 'random',
      password: { concat: [{ column: 'first_name' }, '@123'] },
    }), 'users'),
    /derives from "first_name", which is also masked/,
  );
  await assert.rejects(
    resolveScope(context({ password: { concat: [{ column: 'external_id' }, '@123'] } }), 'users'),
    /derives from primary-key \/ range column "external_id"/,
  );
});

test('caps a concat replacement with maxLength by trimming the extra characters', async () => {
  const rules = new Rules({
    sensitive: { columns: { users: { display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }], maxLength: 40 } } } },
  });
  assert.deepEqual({ ...rules.tableRule('users').masks }, {
    display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }], maxLength: 40 },
  });

  const scope = await resolveScope(
    context({ display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }], maxLength: 40 } }),
    'users',
  );
  assert.ok(scope.select.includes('LEFT(CONCAT(`first_name`, \'@\', `last_name`), 40) AS `display_name`'));
});

test('rejects a bad maxLength, or one that is not on a concat rule', () => {
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { concat: ['a', 'b'], maxLength: 0 } } } } }),
    /maxLength: must be a positive whole number/,
  );
  assert.throws(
    () => new Rules({ sensitive: { columns: { users: { email: { value: 'x', maxLength: 5 } } } } }),
    /maxLength: only applies to "concat"/,
  );
});

test('validates replacement types and literal lengths', async () => {
  await assert.rejects(
    resolveScope(context({ display_name: { value: 'x'.repeat(41) } }), 'users'),
    /shorter than the custom value/,
  );
  await assert.rejects(
    resolveScope(context({ phone: 'random', login_count: { from: 'phone' } }), 'users'),
    /not compatible with int/,
  );
  await assert.rejects(
    resolveScope(context({ display_name: { concat: [{ column: 'first_name' }, '@', { column: 'last_name' }] } }), 'users'),
    /may produce 41 characters, exceeding its length limit of 40/,
  );
});
