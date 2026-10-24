# Duckling
**Duckling** enables the deployment of **DuckDB** instances within **Tangram OS**, with native support for Duck Lake and **Apache Iceberg™** as the underlying table formats.

## Versions

| Component | Version |
|---|---|
| Engine | DuckDB 2.0.0 (JDBC `org.duckdb:duckdb_jdbc` 2.0.0.0) |
| Extensions | `iceberg`, `delta`, `ducklake`, `httpfs`, `aws`, `azure`, `postgres`, `avro` (DuckDB 2.0.0 builds, pre-installed) |
| Delta Lake | DuckDB `delta` extension, against the Delta app's catalog (Delta Kernel 4.3.1) |

Each instance needs at least 1 GB of memory.

## Apache Iceberg™
It supports both **reading from** and **writing to** Iceberg tables.

```sql
create database iceberg.db;

use database iceberg.db;

create table heros(name string);

insert into heros values('james bond');

from heros;
```

### Granting Iceberg and Delta access to Duckling
Each Duckling instance reads tables as its own service account (shown on the instance as `serviceAccount`), after Tangram has checked that you may read them. Give that service account a role on the Iceberg or Delta databases it should read (for example the database `owner` or a reader role); until then a query names the account and what to grant.

## Delta Lake
Duckling reads Delta tables from the workspace's Delta catalog and can `INSERT` into them:

```sql
select * from delta.sales.orders;
```

## Duck Lake

First you need to create a duck lake in duckling app, then create a catalog in Tangram SQL to connect to the duck lake.

Please follow this duckling [quick start guide](https://docs.tangram-os.ai/tutorial-duckling-app/quick-start) for how to create duckling instance and a duck lake for testing. 

Assuming we have a catalog named `ducklake` mapping to the created duck lake. We can test the duck lake using the following example:
```sql
-- create duck lake schema
create schema ducklake.hr;

use schema ducklake.hr;

-- create duck lake table
create table people(name string, age int);

insert into people values('james bond', 52);
-- create duck lake view
create view employee as select * from people
-- query duck lake view
from employee;
```

## Trademarks

- Delta Lake is a trademark of LF Projects, LLC.
- Apache Iceberg™ is registered trademarks or trademarks of the Apache Software Foundation in the United States and/or other countries.

-  PostgreSQL™ are all registered trademarks of the PostgreSQL Community Association of Canada.



