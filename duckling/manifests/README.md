# Duckling
**Duckling** enables the deployment of **DuckDB** instances within **Tangram OS**, with native support for Duck Lake and **Apache Iceberg™** as the underlying table formats.

## Apache Iceberg™
It supports both **reading from** and **writing to** Iceberg tables.

```sql
create database iceberg.db;

use database iceberg.db;

create table heros(name string);

insert into heros values('james bond');

from heros;
```

### Granting Iceberg Access to Duckling
To allow Duckling instances to access Iceberg data, you must assign a role to the Duckling App's service account that includes **read and write privileges** for Iceberg.

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

- Apache Iceberg™ is registered trademarks or trademarks of the Apache Software Foundation in the United States and/or other countries.

-  PostgreSQL™ are all registered trademarks of the PostgreSQL Community Association of Canada.



