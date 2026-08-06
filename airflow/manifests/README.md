# Airflow on Tangram OS

## Configure DAGs Git Repo Sync:

1.  Prepare a Git repository containing your DAGs.
2.  Create a secret for Git authentication

## Generate Secrets

### 1. Fernet Key

Airflow uses a Fernet key to encrypt sensitive information (e.g., connection passwords).

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

> [!CAUTION]
> Once connection credentials and variables have been encrypted using a fernet key, changing the key will cause decryption of existing credentials to fail. 


### 2. API Secret Key

It is used to authenticate internal API clients to core

```bash
openssl rand -hex 32
```

## Logging

When deploying this Airflow App on Tangram OS, a storage bucket will be provisioned for storing task instance logs.
