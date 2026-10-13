# sqlcpy

Interactive terminal tool (npkill-style) that copies MySQL **tables, views, stored procedures, functions and triggers** from a *master* database to a *slave* database — in small chunks so the master never hangs.

## Features

- Lists every object section by section with live sync status (✔ in sync · ≠ differs · ✖ missing · • only in slave)
- Skips objects that are already identical (schema + row count + checksum for tables up to 50 MB)
- `space` copies the selected object; copies are queued and run one at a time
- Tables larger than ~1 MB are split into ~1 MB chunks (keyset pagination on the primary key) with a short pause between chunks
- Writes a `.sql` dump of every copied object to `dumps/<database>/`
- Docker-pull style progress: bar, rows, chunk n/N, speed, ETA
- Policy file: ignore tables, keep sensitive data on the master, copy only the latest rows of huge tables (see [Policy file](#policy-file))

## Install

```bash
cd backup-script
npm install
npm link        # makes the `sqlcpy` command available globally
```

Without linking you can always run `npm start` (or `node bin/sqlcpy.js`) from the project folder.

## Configure

Create a `.env` in the directory you run `sqlcpy` from:

```env
MASTER_HOST=10.10.20.41
MASTER_PORT=3306
MASTER_USERNAME=dev
MASTER_PASSWORD=secret
MASTER_DATABASE=bdms

SLAVE_HOST=localhost
SLAVE_PORT=3307
SLAVE_USERNAME=dev
SLAVE_PASSWORD=secret
SLAVE_DATABASE=bdms

# optional
DB_TYPE=mysql           # engine; master and slave must be the same type (mysql, mariadb)
CHUNK_BYTES=1048576     # target size of each chunk
CHUNK_DELAY_MS=100      # pause between chunks
CHECKSUM_MAX_MB=50      # skip CHECKSUM TABLE above this size
CONCURRENCY=1           # chunks downloaded/inserted in parallel per table, whole number 1-10
DUMP_DIR=./dumps
CONFIG_FILE=./sqlcpy.config.jsonc   # policy file (default shown); must exist if you set it
MASK_SALT=some-long-random-string   # required only if the policy uses "hash" masking
```

A different env file can be passed as the first argument: `sqlcpy path/to/.env`.

## Policy file

`sqlcpy.config.jsonc` (comments allowed; see [sqlcpy.config.example.jsonc](sqlcpy.config.example.jsonc)) decides **what is allowed to leave the master**. Without it everything is copied in full, as before.

```jsonc
{
  "ignore": ["tmp_*", "*_bak"],                       // not listed, compared or copied at all
  "sensitive": {
    "tables":  ["oauth_tokens"],                      // structure only – no row is ever read
    "columns": {
      "users": {
        "email": "hash",
        "display_name": { "from": "first_name" },
        "password": {
          "concat": [
            { "column": "first_name" },
            "@123",
            { "column": "last_name" }
          ]
        },
        "nickname": { "value": "Sample User" },
        "phone": "random"
      }
    }
  },
  "range": {
    "audit_log": { "column": "created_at", "last": "1m" }   // only the latest month
  }
}
```

| rule | what happens | status / SCOPE column |
|---|---|---|
| `ignore` | hidden: never compared, copied or dropped (triggers on an ignored table too) | counted in the header (`· 3 ignored`) |
| `sensitive.tables` | table structure copied; **no `SELECT` of its rows is ever issued** – nothing in the slave, `dumps/` or on this machine | `schema only`; in sync when the definitions match |
| `sensitive.columns` | the master computes the replacement inside the `SELECT`, so the original value never leaves the server | `masked`; masked columns are left out of the sync check |
| `range` | only rows with `column` ≥ cut-off are copied (`last`: `12h` `7d` `2w` `1m` `1y`, or fixed `since`) | `30d`, `≥2026-01-01`; **in sync = every master row inside the range is on the slave, unchanged** (older rows are ignored). The table list shows whole-table estimates and a scoped row beneath it with in-range counts, estimated size, and status. |

Good to know:

- **Fail closed.** Unknown keys, bad durations, `hash` without `MASK_SALT`, masking a column that does not exist, masking a primary key, or a range on a non-date / unindexed column all refuse to run (config error, or that table shows `error` and is not copied). A sensitive rule naming a table that does not exist is flagged in the log.
- Column replacements can be `null`, `empty`, salted `hash`, or `random`; use `{ "value": "fixed value" }` for a custom literal, `{ "from": "other_column" }` to take a compatible, unmasked non-key column's value, or `{ "concat": [{ "column": "first_name" }, "@123", { "column": "last_name" }] }` to combine text columns and static text. Concatenation parts are quoted/escaped and never treated as SQL. Values and derived columns are type-checked. Random replacements are pseudo-random text or a number from 0 to 9; replacements other than `hash` can collide with `UNIQUE` indexes, so use a suitable deterministic hash or unique-safe values when needed.
- **Range tables hold only the range** on the slave: a copy drops and recreates the table, as always. The cut-off is evaluated once on the master and the same instant is used for both sides.
- **A range needs an index** on its column on the master (paging is `ORDER BY column, pk`; a composite index that *starts* with the column counts). Without one every chunk would scan and sort the whole table, so sqlcpy refuses instead and the table shows `error`. The preferred fix is to add the index, e.g. `CREATE INDEX idx_audit_log_created_at ON audit_log (created_at);`. If you accept the full scans (small table, off-hours or replica, schema can't change), opt out per table with `"allowUnindexed": true`:

  ```jsonc
  "range": {
    "import_batches": { "column": "imported_at", "last": "90d", "allowUnindexed": true }
  }
  ```

  It is optional, defaults to `false`, applies to that table only, and must be the literal `true` (the string `"true"` counts as `false`).
- **Stale dumps.** Dumps written *before* a table was protected still hold real rows. sqlcpy warns about them in the log (it never deletes files); dumps written under a rule start with a `-- scope:` line.
- The `hash` salt is sent to the master inside the `SELECT`; it is meant to stop dictionary attacks on the copy, not to hide data from people who already have the master.
- Changing the policy file invalidates the scan cache automatically.
- In the interactive CLI, saving `sqlcpy.config.jsonc` reloads the policy and rescans automatically. Invalid edits are reported in the log and the last valid config stays active; edits are applied after any current copy finishes.

## Keys

| key | action |
|---|---|
| `↑` `↓` / `j` `k` | move |
| `←` `→` / `tab` | jump between sections |
| `s` / `S` | cycle sort column (name, master rows, slave rows, size, status) / reverse direction |
| `space` | copy selected object (skipped if already in sync) |
| `a` | copy everything that differs or is missing |
| `f` | force copy, even if in sync |
| `x` | cancel current copy and clear queue |
| `R` / `r` | rescan all / rescan selected |
| `q` | quit |

## Library use

```js
const { SqlCpy, loadConfig } = require('sqlcpy');
const app = new SqlCpy(loadConfig());
await app.scan();                       // lists + compares
const t = app.items.find(i => i.name === 'orders');
await app.copy(t, { onProgress: console.log });
await app.close();
```

## Warning

Copying a table **drops and recreates it on the slave** (foreign key checks are disabled during the copy). Double-check `SLAVE_*` before pressing `space`.

## License

[MIT](LICENSE.md)
