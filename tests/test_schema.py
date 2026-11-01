from peleng_tracker.core.vision_websocket import result_payload
from peleng_tracker.domain import VisionResult, WorldTrack


def test_websocket_schema_v2_keeps_compatibility_alias() -> None:
    track = WorldTrack("g1", 0, "person", 0.8, [0, 1])
    payload = result_payload(VisionResult(1, 1.0, 2.0, [0], {0: []}, {0: []}, [track]))
    assert payload["schema_version"] == 2
    assert payload["world_tracks"] == payload["bev_tracks"]
