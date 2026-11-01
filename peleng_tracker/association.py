"""Cross-camera association driven by persistent local keys and geometry."""

from __future__ import annotations

from collections import defaultdict

from .domain import Track, WorldTrack
from .geometry import CalibrationStore


class CrossCameraAssociator:
    def __init__(self, calibration: CalibrationStore, max_reprojection_error_px: float) -> None:
        self.calibration = calibration
        self.max_reprojection_error_px = max_reprojection_error_px
        self.key_to_global: dict[tuple[int, str], str] = {}
        self._next_id = 1
        self._trajectory: dict[str, list[tuple[float, float, float, float]]] = {}

    def _new_id(self) -> str:
        value = str(self._next_id)
        self._next_id += 1
        return value

    def associate(self, tracks_by_camera: dict[int, list[Track]], timestamp: float | None = None) -> list[WorldTrack]:
        by_class: dict[int, list[Track]] = defaultdict(list)
        for tracks in tracks_by_camera.values():
            for track in tracks:
                by_class[track.class_id].append(track)

        groups: list[list[Track]] = []
        for class_tracks in by_class.values():
            existing: dict[str, list[Track]] = defaultdict(list)
            unmatched: list[Track] = []
            for track in class_tracks:
                global_id = self.key_to_global.get(track.key)
                if global_id is None:
                    unmatched.append(track)
                else:
                    existing[global_id].append(track)
            groups.extend(existing.values())

            while unmatched:
                seed = unmatched.pop(0)
                group = [seed]
                seed_observation = {seed.camera_id: seed.anchor}
                best_index: int | None = None
                best_error = float("inf")
                for index, candidate in enumerate(unmatched):
                    if candidate.camera_id == seed.camera_id:
                        continue
                    result = self.calibration.triangulate(
                        {**seed_observation, candidate.camera_id: candidate.anchor},
                        self.max_reprojection_error_px,
                    )
                    if result is not None and result.reprojection_error_px < best_error:
                        best_index = index
                        best_error = result.reprojection_error_px
                if best_index is not None:
                    group.append(unmatched.pop(best_index))
                groups.append(group)

        world_tracks: list[WorldTrack] = []
        for group in groups:
            known_ids = {self.key_to_global[track.key] for track in group if track.key in self.key_to_global}
            global_id = min(known_ids, key=int) if known_ids else self._new_id()
            for track in group:
                self.key_to_global[track.key] = global_id

            observations = {track.camera_id: track.anchor for track in group}
            triangulated = self.calibration.triangulate(observations, self.max_reprojection_error_px)
            position = triangulated.position_xyz_m if triangulated else None
            status = "valid" if triangulated else "unavailable"
            reprojection_error = triangulated.reprojection_error_px if triangulated else None
            if position is None and len(group) == 1:
                position = self.calibration.planar_position(group[0].camera_id, group[0].anchor)
                if position is not None:
                    status = "planar_fallback"

            trajectory = self._trajectory.setdefault(global_id, [])
            velocity = (0.0, 0.0, 0.0)
            if position is not None and timestamp is not None:
                if trajectory and timestamp > trajectory[-1][3]:
                    elapsed = timestamp - trajectory[-1][3]
                    velocity = tuple((position[index] - trajectory[-1][index]) / elapsed for index in range(3))
                trajectory.append((*position, timestamp))
                del trajectory[:-100]

            world_tracks.append(
                WorldTrack(
                    global_id=global_id,
                    class_id=group[0].class_id,
                    class_name=group[0].class_name,
                    confidence=sum(track.confidence for track in group) / len(group),
                    source_cameras=sorted({track.camera_id for track in group}),
                    position_xyz_m=position,
                    velocity_xyz_mps=velocity,
                    reprojection_error_px=reprojection_error,
                    position_status=status,
                    trajectory=trajectory.copy(),
                )
            )
        return world_tracks

    def reset(self) -> None:
        self.key_to_global.clear()
        self._next_id = 1
        self._trajectory.clear()
