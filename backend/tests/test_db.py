"""Connection-string handling for Neon (no database needed)."""
from app.db import is_pooled, normalise_dsn

NEON = "postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/crm?sslmode=require&channel_binding=require"
POOLED = "postgresql://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/crm?sslmode=require"


def test_channel_binding_is_dropped_and_sslmode_kept():
    dsn = normalise_dsn(NEON)
    assert "channel_binding" not in dsn and "sslmode=require" in dsn
    assert dsn.startswith("postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/crm")


def test_sqlalchemy_style_scheme_is_accepted():
    assert normalise_dsn("postgresql+asyncpg://u:p@h/db").startswith("postgresql://")


def test_pooler_detection():
    assert is_pooled(POOLED) and not is_pooled(NEON)
