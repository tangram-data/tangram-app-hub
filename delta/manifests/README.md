## Delta Lake catalog

Delta Lake is an open table format with ACID transactions, time travel and schema evolution on
object storage. This app runs a Delta Lake catalog for the workspace. It speaks the Unity Catalog
REST API (`/api/2.1/unity-catalog`), so Sail, Spark and DuckDB can read and write the same tables.

- One catalog per workspace, named `delta`. Databases (schemas) and tables live in Tangram storage
  folders; access follows the Database and Table roles.
- Engines never get bucket keys: each table read or write gets short-lived credentials scoped to
  that table's folder and to what the caller may do (read-only or read-write).
- Commits go straight to the Delta log in storage, so any Delta reader can also read a table by path.

## Create a database

Create a storage bucket in the workspace first, then a database from a SQL engine, e.g. on Sail:

```sql
CREATE DATABASE delta.sales;
CREATE TABLE delta.sales.orders (id BIGINT, amount DOUBLE) USING delta;
```

Names must be lower-case letters, digits and underscores.

### Trademarks

- Delta Lake is a trademark of LF Projects, LLC. Unity Catalog is a trademark of LF Projects, LLC.
- PostgreSQL™ is a registered trademark of the PostgreSQL Community Association of Canada.
