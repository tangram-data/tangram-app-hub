## Open Table Format
Apache Iceberg™ is a high-performance format for huge analytic tables. Iceberg brings the reliability and simplicity of SQL tables to big data, while making it possible for engines like Spark, Trino, Flink, Presto, Hive and Impala to safely work with the same tables, at the same time.

Background and documentation is available at <https://iceberg.apache.org>

This application allows to deploy an Iceberg REST catalog service backed by Iceberg JDBC catalog using
PostgreSQL™ as database. 

## Create an Iceberg Table

Before you can create an Iceberg table, you need to create an Iceberg database(or namespace) first. 
To create an Iceberg database, you need to create a storage bucket in the workspace, to create a storage bucket, you can
navigate to `workspace>your workspace> storage > storage bucket` in Tangram OS UI. Then you can create an Iceberg database
using the created bucket as data storage. 


### Trademarks

- Apache Iceberg™ is registered trademarks or trademarks of the Apache Software Foundation in the United States and/or other countries.

-  PostgreSQL™ are all registered trademarks of the PostgreSQL Community Association of Canada.



