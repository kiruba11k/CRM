"""
backend/app/emaildomains.py - which account an email address belongs to.

An address matches an account when its domain (or a parent domain, so
mail.norvale.com counts for norvale.com) is the account's website domain or
one of its extra email domains. Free-mail providers never match: an address
at gmail.com says nothing about the company.
"""
import re
from typing import Optional
from uuid import UUID

import asyncpg

from .dedupe import domain_of

FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk",
    "yahoo.in", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "web.de",
    "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "rediffmail.com", "fastmail.com", "hey.com", "tutanota.com",
}
_DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$")


def clean_list(raw: Optional[str]) -> Optional[str]:
    """'@Norvale.se, norvale-group.com ' -> 'norvale.se, norvale-group.com'. Invalid entries are dropped."""
    out = []
    for part in re.split(r"[\s,;]+", (raw or "").lower()):
        d = part.strip().lstrip("@")
        d = domain_of(d) or d
        if _DOMAIN.match(d) and d not in FREE_MAIL and d not in out:
            out.append(d)
    return ", ".join(out) or None


def domain_of_email(addr: str) -> Optional[str]:
    return addr.rsplit("@", 1)[1].lower() if "@" in addr else None


async def account_map(con: asyncpg.Connection) -> dict[str, UUID]:
    """Email domain -> account id. A domain claimed by two accounts is left
    out (ambiguous); merge the duplicates to fix it."""
    seen: dict[str, set] = {}
    for r in await con.fetch("SELECT id, website, email_domains FROM accounts"):
        doms = {domain_of(r["website"])} | {d.strip() for d in (r["email_domains"] or "").split(",")}
        for d in doms:
            if d and d not in FREE_MAIL:
                seen.setdefault(d, set()).add(r["id"])
    return {d: next(iter(ids)) for d, ids in seen.items() if len(ids) == 1}


def match(addr: str, amap: dict[str, UUID]) -> Optional[UUID]:
    d = domain_of_email(addr)
    while d and "." in d:
        if d in FREE_MAIL:
            return None
        if d in amap:
            return amap[d]
        d = d.split(".", 1)[1]
    return None
