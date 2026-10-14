from sportsan.ingest.strava_sync import (
    SESSION_COLUMNS,
    after_epoch,
    merge_summaries,
    session_row,
    streams_by_type,
    summary_of,
    token_expired,
    wanted,
)


def test_token_is_renewed_when_missing_or_about_to_expire():
    assert token_expired({}, now=1000)
    assert token_expired({"access_token": "a", "expires_at": 1200}, now=1000)        # le quedan 200 s
    assert not token_expired({"access_token": "a", "expires_at": 5000}, now=1000)


def test_only_the_chosen_sports_get_detail():
    assert wanted({"sport_type": "Soccer"}, ["soccer"])
    assert wanted({"type": "Run"}, ["Soccer", "Run"])           # actividad antigua, sin sport_type
    assert not wanted({"sport_type": "Ride"}, ["Soccer"])
    assert not wanted({}, ["Soccer"])


def test_session_row_keeps_missing_values_empty():
    act = {"id": 7, "start_date_local": "2026-09-30T18:05:00Z", "elapsed_time": 5400, "moving_time": 3600,
           "distance": 6543.2, "average_heartrate": 151.26, "max_speed": 7.512}
    row = session_row({**act, "suffer_score": 87}, "Joana")
    assert list(row) == SESSION_COLUMNS
    assert row["date"] == "2026-09-30" and row["session_id"] == "strava_7" and row["player_id"] == "Joana"
    assert row["duration_min"] == 90.0 and row["moving_min"] == 60.0 and row["distance_m"] == 6543
    assert row["hr_avg"] == 151.3 and row["speed_max_ms"] == 7.51
    assert row["relative_effort"] == 87 and row["football"] == 1
    assert session_row(act, "Joana", football=False)["football"] == 0
    # Sin pulso máximo ni esfuerzo percibido: vacío, no cero.
    assert row["hr_max"] == "" and row["rpe"] == ""


def test_streams_in_both_shapes():
    by_type = {"time": {"data": [0, 1, 2], "series_type": "time"}, "heartrate": {"data": [120, 121, 123]}}
    as_list = [{"type": "time", "data": [0, 1, 2]}, {"type": "heartrate", "data": [120, 121, 123]}]
    assert streams_by_type(by_type) == streams_by_type(as_list) == {"time": [0, 1, 2], "heartrate": [120, 121, 123]}
    assert streams_by_type(None) == {}


def test_summaries_merge_by_id_in_date_order():
    old = [{"id": 1, "start_date": "2026-09-01T00:00:00Z", "name": "a"}, {"id": 2, "start_date": "2026-09-03T00:00:00Z", "name": "b"}]
    new = [{"id": 2, "start_date": "2026-09-03T00:00:00Z", "name": "b editada"}, {"id": 3, "start_date": "2026-09-02T00:00:00Z", "name": "c"}]
    assert [(a["id"], a["name"]) for a in merge_summaries(old, new)] == [(1, "a"), (3, "c"), (2, "b editada")]


def test_summary_and_date():
    s = summary_of({"id": 5, "type": "Soccer", "name": "Entreno", "kudos_count": 3})
    assert s["sport_type"] == "Soccer" and "kudos_count" not in s
    assert after_epoch("1970-01-02") == 86400
