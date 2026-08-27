#!/bin/sh
set -eu

create_role() {
  role_name="$1"
  role_password="$2"
  psql --username "$POSTGRES_USER" --dbname postgres \
    --set=role_name="$role_name" --set=role_password="$role_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec
SQL
}

create_database() {
  database_name="$1"
  owner_name="$2"
  psql --username "$POSTGRES_USER" --dbname postgres \
    --set=database_name="$database_name" --set=owner_name="$owner_name" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'owner_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database_name')
\gexec
SQL
}

create_role "$N8N_DB_USER" "$N8N_DB_PASSWORD"
create_role "$LAB_DB_USER" "$LAB_DB_PASSWORD"
create_database "$N8N_DB_NAME" "$N8N_DB_USER"
create_database "$LAB_DB_NAME" "$LAB_DB_USER"
