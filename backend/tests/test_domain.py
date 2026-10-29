"""Pure business-rule tests: no database needed."""
from datetime import date

from app import domain

TODAY = date(2026, 10, 29)


def fields(issues):
    return {i["field"] for i in issues}


def opp(**kw):
    base = {
        "name": "Norvale · LinkedIn lead generation", "account_id": "a", "owner_id": "u", "geography": "Sweden",
        "stage": "Lead identified", "currency": "USD", "risk_rating": "Unassessed", "on_nurture": False,
        "next_action_code": "05", "next_action_other": None, "next_action_due": date(2026, 11, 2),
    }
    base.update(kw)
    return base


def test_taxonomy_matches_spec():
    assert len(domain.NEXT_ACTIONS) == 18 and domain.NEXT_ACTIONS["18"] == "Other"
    assert [s for s, _ in domain.STAGES][-2:] == ["Won", "Lost"]
    assert domain.STAGE_PROBABILITY["Proposal submitted"] == 55
    assert domain.PROSPECT_STATUSES == ["New", "Contacted", "Engaged", "Qualified", "Nurture", "Disqualified"]


def test_other_requires_description_of_50_chars_or_fewer():
    errors, _ = domain.validate_opportunity(opp(next_action_code="18"), TODAY)
    assert "next_action_other" in fields(errors)
    errors, _ = domain.validate_opportunity(opp(next_action_code="18", next_action_other="x" * 51), TODAY)
    assert "next_action_other" in fields(errors)
    errors, _ = domain.validate_opportunity(opp(next_action_code="18", next_action_other="x" * 50), TODAY)
    assert errors == []


def test_other_description_only_with_other_code():
    errors, _ = domain.validate_opportunity(opp(next_action_other="stray text"), TODAY)
    assert "next_action_other" in fields(errors)


def test_unknown_next_action_rejected():
    errors, _ = domain.validate_opportunity(opp(next_action_code="99"), TODAY)
    assert "next_action_code" in fields(errors)


def test_active_prospect_needs_owner_action_and_due():
    errors, _ = domain.validate_prospect({"full_name": "Sofia Lind", "status": "New"})
    assert {"owner_id", "next_action_code", "next_action_due"} <= fields(errors)
    errors, _ = domain.validate_prospect({"full_name": "Clara Moreau", "status": "Disqualified"})
    assert errors == []


def test_prospect_warns_without_contact_route_or_account():
    errors, warnings = domain.validate_prospect(
        {"full_name": "A", "status": "New", "owner_id": "u", "next_action_code": "14", "next_action_due": TODAY}
    )
    assert errors == [] and {"email", "account_id"} <= fields(warnings)


def test_open_opportunity_needs_next_action():
    errors, _ = domain.validate_opportunity(opp(next_action_code=None, next_action_due=None), TODAY)
    assert {"next_action_code", "next_action_due"} <= fields(errors)


def test_qualified_needs_value_and_assessed_risk():
    errors, _ = domain.validate_opportunity(opp(stage="Qualified"), TODAY)
    assert {"estimated_value", "risk_rating"} <= fields(errors)
    errors, _ = domain.validate_opportunity(opp(stage="Qualified", estimated_value="24000", risk_rating="Low"), TODAY)
    assert errors == []


def test_high_risk_needs_reason_and_mitigation():
    errors, _ = domain.validate_opportunity(opp(stage="Qualified", estimated_value=1, risk_rating="High"), TODAY)
    assert {"high_risk_reason", "risk_mitigation"} <= fields(errors)


def test_stage_gates():
    base = {"estimated_value": 9600, "risk_rating": "Medium"}
    errors, _ = domain.validate_opportunity(opp(stage="Solution design", **base), TODAY)
    assert "expected_close" in fields(errors)
    errors, _ = domain.validate_opportunity(opp(stage="Proposal submitted", expected_close=date(2026, 11, 14), **base), TODAY)
    assert "proposal_due" in fields(errors)


def test_won_and_lost_requirements_and_no_next_action_needed():
    errors, _ = domain.validate_opportunity(opp(stage="Won", estimated_value=1, risk_rating="Low", next_action_code=None, next_action_due=None), TODAY)
    assert {"actual_value", "won_date"} <= fields(errors) and "next_action_code" not in fields(errors)
    errors, _ = domain.validate_opportunity(opp(stage="Lost", next_action_code=None, next_action_due=None), TODAY)
    assert {"lost_reason", "lost_date"} <= fields(errors)
    ok, _ = domain.validate_opportunity(opp(stage="Lost", lost_reason="Budget", lost_date=TODAY, next_action_code=None, next_action_due=None), TODAY)
    assert ok == []


def test_nurture_rules():
    errors, _ = domain.validate_opportunity(opp(on_nurture=True, next_action_code=None, next_action_due=None), TODAY)
    assert {"nurture_reason", "nurture_until", "nurture_next_action_code"} <= fields(errors)
    assert "next_action_code" not in fields(errors)
    ok, _ = domain.validate_opportunity(opp(
        on_nurture=True, nurture_reason="Timing delayed", nurture_until=date(2027, 1, 15),
        nurture_next_action_code="17", next_action_code=None, next_action_due=None,
    ), TODAY)
    assert ok == []
    errors, _ = domain.validate_opportunity(opp(stage="Lost", lost_reason="Budget", lost_date=TODAY, on_nurture=True), TODAY)
    assert "on_nurture" in fields(errors)


def test_review_prompts_are_warnings_not_errors():
    errors, warnings = domain.validate_opportunity(opp(next_action_due=date(2026, 10, 20), expected_close=date(2026, 10, 1)), TODAY)
    assert errors == [] and {"next_action_due", "expected_close"} <= fields(warnings)


def test_closing_clears_open_next_action():
    rec = domain.normalise_closed_opportunity(opp(stage="Won"))
    assert rec["next_action_code"] is None and rec["next_action_due"] is None


def test_helpers():
    assert domain.business_days_between(date(2026, 10, 23), date(2026, 10, 29)) == 4  # Fri → Thu
    assert domain.business_days_between(date(2026, 10, 29), date(2026, 10, 29)) == 0
    assert str(domain.weighted_value(42000, "Proposal submitted")) == "23100.00"
    assert domain.account_name_key("Norvale Pharma Ltd.") == domain.account_name_key("norvale  pharma")
