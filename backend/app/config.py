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

    # ── Google Calendar + Meet sync (§6) ───────────────────────────
    # Secret of the same Web OAuth client as google_client_id. Add
    # {public_api_url}/api/calendar/oauth/callback as an authorised
    # redirect URI on that client, and enable the Google Calendar API.
    google_client_secret: str = ""
    # Public URL of this API (e.g. https://leadstrategus-crm-api.onrender.com).
    public_api_url: str = ""
    # Any long random string; encrypts stored Google refresh tokens and
    # signs the OAuth state. Changing it means everyone reconnects.
    token_key: str = ""

    # ── HubSpot import (read-only private-app token) ───────────────
    # HubSpot → Settings → Integrations → Private apps. Server-side only.
    hubspot_token: str = ""
    hubspot_base_url: str = "https://api.hubapi.com"

    # §5.4 manager escalation threshold (business days overdue).
    escalation_business_days: int = 3

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def calendar_missing(self) -> list[str]:
        need = {"CRM_GOOGLE_CLIENT_ID": self.google_client_id, "CRM_GOOGLE_CLIENT_SECRET": self.google_client_secret,
                "CRM_PUBLIC_API_URL": self.public_api_url, "CRM_TOKEN_KEY": self.token_key}
        return [k for k, v in need.items() if not v]

    @property
    def calendar_redirect_uri(self) -> str:
        return self.public_api_url.rstrip("/") + "/api/calendar/oauth/callback"

    @property
    def app_url(self) -> str:
        return (self.cors_origins or ["http://localhost:5174"])[0].rstrip("/")

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.frontend_origin.split(",") if o.strip()]


@lru_cache()
def get_settings() -> Settings:
    return Settings()
