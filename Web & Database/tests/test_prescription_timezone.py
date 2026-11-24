"""Regression tests for live Arduino prescriptions and Waterloo timestamps."""
from datetime import datetime

import app as motion
from conftest import login


def test_time_filter_converts_utc_naive_to_waterloo_est_and_edt(app):
    render = app.jinja_env.filters["waterloo_datetime"]
    assert render(datetime(2026, 11, 24, 20, 0)) == "Nov 24, 2026 · 03:00 PM EST"
    assert render(datetime(2026, 7, 24, 20, 0)) == "Jul 24, 2026 · 04:00 PM EDT"


def test_utc_evening_can_display_previous_waterloo_date(app):
    render = app.jinja_env.filters["waterloo_datetime"]
    assert render(datetime(2026, 11, 24, 2, 0)) == "Nov 23, 2026 · 09:00 PM EST"


def test_patient_can_retrieve_only_own_active_prescription(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Arm Curl")
    login(client, "patA")
    response = client.get(f"/api/device/prescription/{plan_id}")
    assert response.status_code == 200
    assert response.json == {
        "plan_id": plan_id, "exercise_name": "Arm Curl",
        "sets": 3, "reps": 10, "duration_seconds": 0, "frequency_per_week": 3,
    }


def test_duration_is_converted_from_minutes_to_seconds(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Arm Curl")
    with make.app.app_context():
        plan = motion.db.session.get(motion.ExercisePlan, plan_id)
        plan.duration_minutes = 2
        motion.db.session.commit()
    login(client, "patA")
    assert client.get(f"/api/device/prescription/{plan_id}").json["duration_seconds"] == 120


def test_cannot_download_other_patients_plan(client, make, people):
    other_id = make.plan(people["pat_b"], people["ins_b"], "Arm Curl")
    login(client, "patA")
    assert client.get(f"/api/device/prescription/{other_id}").status_code == 404


def test_cannot_download_inactive_plan(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Arm Curl", active=False)
    login(client, "patA")
    assert client.get(f"/api/device/prescription/{plan_id}").status_code == 404


def test_cannot_send_unsupported_exercise_to_v3(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Walking")
    login(client, "patA")
    response = client.get(f"/api/device/prescription/{plan_id}")
    assert response.status_code == 400
    assert "supports" in response.json["error"]


def test_instructor_cannot_download_patient_device_prescription(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Arm Curl")
    login(client, "insA")
    assert client.get(f"/api/device/prescription/{plan_id}").status_code == 403


def test_signed_out_request_is_not_authorized(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Arm Curl")
    assert client.get(f"/api/device/prescription/{plan_id}").status_code == 302


def test_patient_dashboard_includes_prescription_link_and_waterloo_time(client, make, people):
    plan_id = make.plan(people["pat_a"], people["ins_a"], "Arm Curl")
    login(client, "patA")
    patient_page = client.get("/dashboard")
    assert patient_page.status_code == 200
    assert f"/api/device/prescription/{plan_id}".encode() in patient_page.data
    client.post(f"/progress/log/{plan_id}", data={"sets": "1", "reps": "8"})
    refreshed = client.get("/dashboard")
    assert b"EST" in refreshed.data or b"EDT" in refreshed.data
