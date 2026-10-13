# sqlcpy – plan

Goal: interactive terminal tool (npkill-style) that copies MySQL objects from a **master** DB to a **slave** DB, safely and in small chunks.

## Config (.env)
`MASTER_*` and `SLAVE_*` (HOST, PORT, USERNAME, PASSWORD, DATABASE).
Optional tuning: `CHUNK_BYTES` (1048576), `CHUNK_DELAY_MS` (100), `CHECKSUM_MAX_MB` (50), `CONCURRENCY` (1, must be 1–10), `DUMP_DIR` (./dumps).

## Architecture
| file | job |
|---|---|
| `src/config.js` | read .env, validate |
| `src/drivers/` | one module per engine (`mysql.js`): pool, quoting, list objects, DDL, PK, count/checksum, session setup. Selected by `DB_TYPE`; master and slave are always the same engine |
| `src/objects.js` | object kinds + labels |
| `src/compare.js` | decide in-sync / different / missing / extra (DDL + COUNT + CHECKSUM TABLE for small tables) |
| `src/copier.js` | dump + copy one object; tables use keyset-paginated chunks (~1 MB each) with a pause between chunks |
| `src/index.js` | `SqlCpy` library class (EventEmitter) – scan(), copy(), compare() |
| `src/ui.js` | TUI: sections, cursor, status, docker-pull style progress |
| `bin/sqlcpy.js` | CLI entry |

## Behaviour
1. Scan: list objects on both sides, compare one at a time (gentle on master).
2. Show sections: Tables, Views, Procedures, Functions, Triggers with status.
3. `space` copies selected object (queued, one at a time). In-sync objects are skipped (`f` forces).
4. Table copy: SHOW CREATE TABLE → write `dumps/<db>/<table>.sql` locally → apply to slave chunk by chunk
   (`WHERE pk > last ORDER BY pk LIMIT n`; tables <= 1 MB are a single chunk). Sleep between chunks so master never stalls.
5. After copy, object is re-compared and marked in sync.

## Keys
`↑/↓` move · `space` copy · `a` copy all out-of-sync · `f` force copy · `x` cancel · `r` rescan · `q` quit
