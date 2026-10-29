"""
backend/app/config.py - settings for the internal LeadStrategus CRM API.

Separate from the public event-discovery backend on purpose: different
users (staff only), different auth and its own database.
"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CRM_", env_file=".env", extra="ignore")

    # postgresql://USER:PASSWORD@HOST/DB?sslmode=require  (Neon works as-is)
    database_url: str = ""

    # Browser origin of the CRM frontend (CORS). Comma-separate several.
    frontend_origin: str = "http://localhost:5174"

    # ── Auth: Google Workspace sign-in ─────────────────────────────
    # OAuth client ID of the Internal Google app (Cloud console →
    # APIs & Services → Credentials). ID tokens must be issued for it.
    google_client_id: str = ""
    # Only accounts from this Workspace domain may sign in (token `hd`).
    allowed_domain: str = "leadstrategus.com"
    # Comma-separated emails that become admins on first sign-in.
    admin_emails: str = ""

    # Local development / tests ONLY: trust an `X-Dev-User: email`
    # header instead of a Google token. Never enable in production.
    dev_auth: bool = False

    # §5.4 manager escalation threshold (business days overdue).
    escalation_business_days: int = 3

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.frontend_origin.split(",") if o.strip()]


@lru_cache()
def get_settings() -> Settings:
    return Settings()
