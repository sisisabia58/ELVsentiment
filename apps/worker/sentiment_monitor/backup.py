def describe_backup(destination: str) -> dict:
    return {
        "built": False,
        "status": "not_built",
        "cadence": "nightly",
        "destination": destination,
        "command": ["pg_dump", "--format=custom", "--no-owner", "--dbname", "$DATABASE_URL"],
    }
