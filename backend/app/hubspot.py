"""
backend/app/hubspot.py - minimal read-only HubSpot CRM v3 client.

Authenticates with a private-app access token (CRM_HUBSPOT_TOKEN), pages
through objects, and retries rate-limited (429) and transient 5xx calls.
Only GET requests and the read-only search endpoint are used.
"""
import asyncio
from typing import AsyncIterator, Iterable, Optional

import httpx

BASE_URL = "https://api.hubapi.com"


class HubSpotError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _explain(resp: httpx.Response) -> str:
    try:
        detail = resp.json().get("message") or resp.text
    except ValueError:
        detail = resp.text
    if resp.status_code == 401:
        return "HubSpot rejected the access token (401). Check CRM_HUBSPOT_TOKEN on the server."
    if resp.status_code == 403:
        return f"The HubSpot private app is missing a read scope for this data (403): {detail}"
    return f"HubSpot returned {resp.status_code}: {detail}"


class HubSpot:
    retry_delays = (1, 2, 5, 10, 20)

    def __init__(self, token: str, base_url: str = BASE_URL, transport: Optional[httpx.AsyncBaseTransport] = None):
        self._c = httpx.AsyncClient(
            base_url=base_url, transport=transport, timeout=30,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )

    async def __aenter__(self) -> "HubSpot":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._c.aclose()

    async def _request(self, method: str, path: str, **kw) -> dict:
        for attempt, delay in enumerate((*self.retry_delays, None)):
            try:
                resp = await self._c.request(method, path, **kw)
            except httpx.TransportError as e:
                if delay is None:
                    raise HubSpotError(503, f"Couldn’t reach HubSpot: {e}") from e
                await asyncio.sleep(delay)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                if delay is None:
                    raise HubSpotError(resp.status_code, _explain(resp))
                retry_after = resp.headers.get("Retry-After")
                await asyncio.sleep(float(retry_after) if retry_after and retry_after.replace(".", "").isdigit() else delay)
                continue
            if resp.status_code >= 400:
                raise HubSpotError(resp.status_code, _explain(resp))
            return resp.json()
        raise AssertionError("unreachable")

    async def get(self, path: str, params: Optional[dict] = None) -> dict:
        return await self._request("GET", path, params=params)

    async def pages(self, path: str, params: Optional[dict] = None) -> AsyncIterator[list[dict]]:
        """Yield one page of `results` at a time, following paging.next.after."""
        params = dict(params or {})
        while True:
            data = await self.get(path, params)
            yield data.get("results", [])
            after = ((data.get("paging") or {}).get("next") or {}).get("after")
            if not after:
                return
            params["after"] = after

    async def objects(self, object_type: str, properties: Iterable[str], associations: Iterable[str] = ()) -> AsyncIterator[list[dict]]:
        params = {"limit": 100, "archived": "false", "properties": ",".join(properties)}
        if associations:
            params["associations"] = ",".join(associations)
        async for page in self.pages(f"/crm/v3/objects/{object_type}", params):
            yield page

    async def total(self, object_type: str) -> int:
        data = await self._request("POST", f"/crm/v3/objects/{object_type}/search", json={"limit": 1})
        return int(data.get("total", 0))

    async def account_info(self) -> dict:
        return await self.get("/account-info/v3/details")

    async def owners(self) -> list[dict]:
        out: list[dict] = []
        async for page in self.pages("/crm/v3/owners", {"limit": 100}):
            out.extend(page)
        return out

    async def deal_pipelines(self) -> list[dict]:
        return (await self.get("/crm/v3/pipelines/deals")).get("results", [])
