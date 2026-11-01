"""Peleng Tracker command line interface."""

from __future__ import annotations

import json
import time
from pathlib import Path

import click
import numpy as np

from .geometry import CalibrationStore
from .settings import AppSettings


@click.group()
@click.version_option()
def cli() -> None:
    """Multicamera object tracking and 3D localization."""


@cli.command()
@click.option("--config", "config_path", default="config/hackathon.yaml", show_default=True)
def run(config_path: str) -> None:
    """Start the API, WebRTC stream and dashboard."""
    from .core.peleng_tracker_app import PelengTrackerApp

    app = PelengTrackerApp(AppSettings.load(config_path))
    app.start()
    app.wait()


@cli.command("validate-calibration")
@click.argument("path", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def validate_calibration(path: Path) -> None:
    """Validate a 3D camera calibration file."""
    store = CalibrationStore.load(path)
    click.echo(json.dumps(store.status(), indent=2))
    if not store.status()["valid"]:
        raise click.ClickException("at least two calibrated cameras are required for 3D")


@cli.command()
@click.option("--config", "config_path", default="config/hackathon.yaml", show_default=True)
@click.option("--iterations", default=20, type=click.IntRange(1, 1000), show_default=True)
def benchmark(config_path: str, iterations: int) -> None:
    """Measure detector latency on synthetic frames."""
    from .factory import create_detector

    settings = AppSettings.load(config_path)
    detector = create_detector(settings.vision)
    frame = np.zeros((settings.vision.detector.image_size, settings.vision.detector.image_size, 3), dtype=np.uint8)
    detector.warmup()
    started = time.perf_counter()
    for _ in range(iterations):
        detector.detect(frame)
    elapsed = time.perf_counter() - started
    click.echo(f"model={detector.weights} avg_ms={elapsed * 1000 / iterations:.2f} fps={iterations / elapsed:.2f}")


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
