"""
Load or remove the CRM's dummy dataset straight in the database.

    python scripts/demo_data.py load   --database-url "postgresql://…"
    python scripts/demo_data.py remove --database-url "postgresql://…"

Same data as Settings → Export & backup → Demo data in the app (that button
is the easier way once the CRM is deployed). The API must have started once
against this database, so its tables exist. Demo rows have fixed IDs, so
`remove` deletes exactly them and nothing real.
"""
import argparse
import asyncio
import os
import sys

import asyncpg

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import demo  # noqa: E402
from app.db import normalise_dsn  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["load", "remove"])
    ap.add_argument("--database-url", default=os.environ.get("CRM_DATABASE_URL", ""), help="defaults to CRM_DATABASE_URL")
    ap.add_argument("--domain", default=os.environ.get("CRM_ALLOWED_DOMAIN", "leadstrategus.com"), help="email domain for the demo users")
    args = ap.parse_args()
    if not args.database_url:
        raise SystemExit("Give --database-url or set CRM_DATABASE_URL.")
    con = await asyncpg.connect(normalise_dsn(args.database_url))
    try:
        if args.action == "load":
            counts = await demo.load(con, args.domain)
            print("Loaded demo data:", ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in counts.items()))
        else:
            result = await demo.remove(con)
            print("Removed demo data." + (f" Kept (still used by real records): {', '.join(result['kept'])}" if result["kept"] else ""))
    except ValueError as e:
        raise SystemExit(str(e))
    finally:
        await con.close()


if __name__ == "__main__":
    asyncio.run(main())
