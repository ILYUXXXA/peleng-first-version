import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from peleng_tracker.core.app import create_app
from peleng_tracker.core.config import ServerConfig
from peleng_tracker.core.stream_combiner import StreamCombinerTrack
from peleng_tracker.phone_frames import phone_frames


def jpeg() -> bytes:
    success, payload = cv2.imencode(".jpg", np.full((48, 64, 3), 127, dtype=np.uint8))
    assert success
    return payload.tobytes()


def test_phone_frame_registers_dynamic_camera_without_removing_rtsp() -> None:
    ServerConfig.configure_streams(
        [{"id": 7, "name": "pro-camera", "url": "rtsp://camera.local/live", "enabled": True}]
    )
    client = TestClient(create_app())
    response = client.post(
        "/api/cameras/phone/3/frame?name=Pixel",
        files={"frame": ("frame.jpg", jpeg(), "image/jpeg")},
    )
    assert response.status_code == 200
    assert response.json()["shape"] == [48, 64, 3]
    assert {camera["id"] for camera in client.get("/api/cameras").json()} == {3, 7}
    assert phone_frames.status(3)["connected"] is True


def test_phone_frame_rejects_invalid_image() -> None:
    client = TestClient(create_app())
    response = client.post(
        "/api/cameras/phone/4/frame",
        files={"frame": ("frame.jpg", b"not-an-image", "image/jpeg")},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_phone_source_is_rendered_by_stream_combiner() -> None:
    ServerConfig.configure_streams([{"id": 9, "name": "phone", "url": "phone://9", "enabled": True}])
    phone_frames.publish(9, jpeg(), "phone")
    track = StreamCombinerTrack()
    frame = await track.recv()
    assert (frame.width, frame.height) == ServerConfig.get_individual_resolution()
    track.cleanup()
