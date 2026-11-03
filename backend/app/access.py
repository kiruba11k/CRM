"""
backend/app/access.py - what each permission lets someone do.

Roles (table `roles`) are named sets of these permissions. Everyone signed in
can see the shared pipeline and work the records they own; permissions add
to that.
"""

PERMISSIONS: list[dict] = [
    {"key": "edit_all", "group": "Records", "label": "Edit and reassign anyone’s records",
     "detail": "Change any account, prospect or deal, assign records to other people, and remove others’ linked emails and meetings."},
    {"key": "team_view", "group": "Records", "label": "Team view",
     "detail": "See everyone’s actions, the team summary in the daily digest, escalations and everyone’s calendar sync status."},
    {"key": "set_targets", "group": "Sales management", "label": "Set sales targets",
     "detail": "Set quarterly targets for each salesperson on the Reports page."},
    {"key": "import_data", "group": "Data", "label": "Bulk import",
     "detail": "Import accounts, prospects and deals from CSV files and HubSpot."},
    {"key": "export_data", "group": "Data", "label": "Export CSV",
     "detail": "Download accounts, prospects, opportunities and change history as CSV."},
    {"key": "manage_settings", "group": "Administration", "label": "Manage CRM settings",
     "detail": "Change controlled lists, stage probabilities, reminders and the digest, demo data and booking links."},
    {"key": "manage_users", "group": "Administration", "label": "Manage people and roles",
     "detail": "Add people, change their role and access, deactivate them, and create or edit roles."},
]
KEYS = [p["key"] for p in PERMISSIONS]
LABEL = {p["key"]: p["label"] for p in PERMISSIONS}
