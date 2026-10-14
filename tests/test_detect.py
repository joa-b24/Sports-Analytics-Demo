"""Planificación por partes e indicadores de calidad de la detección (sin modelo ni video)."""
import pytest

from sportsan.tracking.detect import Chunk, chunk_quality, estimate_seconds, fmt_duration, low_visibility, plan_chunks

FPS = 30.0


def test_ranges_are_split_into_chunks_that_cover_them_exactly():
    chunks = plan_chunks([(180, 400)], FPS, 60)
    assert [(c.start, c.end) for c in chunks] == [(5400, 7200), (7200, 9000), (9000, 10800), (10800, 12000)]
    assert chunks[0].name == "5400_7200"
    # Varios tramos de juego: cada uno se parte por separado, sin cubrir la pausa de en medio.
    two = plan_chunks([(0, 60), (120, 150)], FPS, 60)
    assert [(c.start, c.end) for c in two] == [(0, 1800), (3600, 4500)]


def test_a_short_tail_joins_the_previous_chunk():
    # 123 s en partes de 60: sobrarían 3 s, que se suman a la segunda parte.
    chunks = plan_chunks([(0, 123)], FPS, 60)
    assert [(c.start, c.end) for c in chunks] == [(0, 1800), (1800, 3690)]
    assert plan_chunks([(10, 10)], FPS, 60) == []
    assert plan_chunks([(0, 3)], FPS, 60) == [Chunk(0, 90)]


def test_low_visibility_needs_a_sustained_drop():
    frames = list(range(0, 300, 3))  # 10 s a 10 cuadros por segundo
    counts = [18] * 100
    assert low_visibility(frames, counts, FPS) == []
    # Un cuadro suelto con pocas personas no cuenta.
    counts[10] = 2
    assert low_visibility(frames, counts, FPS) == []
    # Tres segundos seguidos sí.
    for i in range(40, 70):
        counts[i] = 3
    assert low_visibility(frames, counts, FPS) == [(frames[40], frames[69])]
    # También al final de la parte.
    assert low_visibility(frames, [18] * 70 + [0] * 30, FPS) == [(frames[70], frames[99])]


def test_quality_tells_stable_tracking_from_broken_identities():
    frames = list(range(0, 300, 3))
    box = lambda tid: [tid, 0, 0, 10, 30, 0.8, 50, 128, 128]
    # 10 personas seguidas de principio a fin.
    stable = chunk_quality(frames, [[box(t) for t in range(10)] for _ in frames], FPS)
    assert stable["tracks"] == 10 and stable["tracks_long"] == 10 and stable["tracks_per_person"] == 1.0
    assert stable["people_median"] == 10 and stable["low_visibility"] == []
    # Las mismas 10 personas, pero el identificador cambia cada segundo.
    broken = chunk_quality(frames, [[box(t + 100 * (i // 10)) for t in range(10)] for i, _ in enumerate(frames)], FPS)
    assert broken["tracks"] == 100 and broken["tracks_long"] == 0 and broken["tracks_per_person"] == 10.0
    # Media parte sin nadie a la vista.
    half = chunk_quality(frames, [[box(t) for t in range(10)] if i < 50 else [] for i, _ in enumerate(frames)], FPS)
    assert half["low_visibility"] == [[frames[50], frames[99]]]
    assert half["low_visibility_share"] == pytest.approx(0.495, abs=0.01)
    assert chunk_quality([], [], FPS)["frames"] == 0


def test_time_estimate_and_its_wording():
    # 45 min a 30 cuadros por segundo, 1 de cada 3, a 0.35 s por cuadro.
    seconds = estimate_seconds(45 * 60 * 30, 3, 0.35)
    assert seconds == pytest.approx(9450)
    assert fmt_duration(seconds) == "2 h 38 min"
    assert fmt_duration(600) == "10 min"


def test_detections_the_tracker_dropped_are_found():
    import numpy as np

    from sportsan.tracking.detect import unmatched

    det = np.array([[0, 0, 10, 30], [100, 0, 110, 30], [200, 0, 210, 30]], dtype=float)
    tracked = np.array([[1, 1, 11, 31], [300, 0, 310, 30]], dtype=float)  # solo la primera coincide
    assert unmatched(det, tracked).tolist() == [1, 2]
    assert unmatched(det, np.empty((0, 4))).tolist() == [0, 1, 2]
    assert unmatched(np.empty((0, 4)), tracked).tolist() == []


def test_shirt_colour_ignores_the_grass_around_the_torso():
    import numpy as np

    from sportsan.tracking.detect import shirt_median

    blue = np.tile([60.0, 140.0, 95.0], (60, 1))    # camiseta azul
    grass = np.tile([120.0, 95.0, 160.0], (40, 1))  # césped: a bajo, b alto
    assert shirt_median(np.vstack([blue, grass])).tolist() == [60.0, 140.0, 95.0]
    # La media, en cambio, la habría dejado en un gris verdoso.
    assert np.vstack([blue, grass]).mean(axis=0)[2] > 120
    # Si casi todo es césped (caja mal puesta) no se descarta nada.
    assert shirt_median(np.vstack([blue[:5], grass])).tolist() == [120.0, 95.0, 160.0]


def test_una_parte_por_tramo():
    from sportsan.tracking.detect import plan_chunks

    chunks = plan_chunks([(10.0, 250.0), (300.0, 960.0)], 30.0, 0)
    assert [(c.start, c.end) for c in chunks] == [(300, 7500), (9000, 28800)]


def test_linea_de_progreso():
    import io

    from sportsan.tracking.process import Progress

    p = Progress("[1/3]", 100, 30.0, 3, out=io.StringIO())
    assert "midiendo" in p.line(0, 61.0)
    p.t0 -= 10  # 10 s para 50 cuadros: 5 cuadros/s
    text = p.line(50, 61.0)
    assert "[############------------]" in text and "50 %" in text and "video 1:01" in text and "5.0 c/s" in text
    assert text.isascii()
