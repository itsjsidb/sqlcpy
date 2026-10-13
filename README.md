# sqlcpy

Interactive terminal tool (npkill-style) that copies MySQL **tables, views, stored procedures, functions and triggers** from a *master* database to a *slave* database — in small chunks so the master never hangs.

## Features

- Lists every object section by section with live sync status (✔ in sync · ≠ differs · ✖ missing · • only in slave)
- Skips objects that are already identical (schema + row count + checksum for tables up to 50 MB)
- `space` copies the selected object; copies are queued and run one at a time
- Tables larger than ~1 MB are split into ~1 MB chunks (keyset pagination on the primary key) with a short pause between chunks
- Writes a `.sql` dump of every copied object to `dumps/<database>/`
- Docker-pull style progress: bar, rows, chunk n/N, speed, ETA

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
```

A different env file can be passed as the first argument: `sqlcpy path/to/.env`.

## Keys

| key | action |
|---|---|
| `↑` `↓` / `j` `k` | move |
| `←` `→` / `tab` | jump between sections |
| `space` | copy selected object (skipped if already in sync) |
| `a` | copy everything that differs or is missing |
| `f` | force copy, even if in sync |
| `x` | cancel current copy and clear queue |
| `r` | rescan |
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
