"""Unión de fragmentos de track sobre la cancha: une lo creíble y se abstiene ante la duda."""
import numpy as np

from sportsan.tracking.stitch import MAX_GAP_S, fragments_from_boxes, link_cost, stitch

FPS = 30.0
STRIDE = 3
BLUE, BLACK = [90, 135, 95], [30, 128, 128]


def walk(track_id, f0, f1, start, velocity, lab):
    """Cajas de una persona que va de `start` a velocidad constante (m/s), un cuadro de cada STRIDE."""
    out = {}
    for f in range(f0, f1 + 1, STRIDE):
        xy = np.array(start, dtype=float) + np.array(velocity, dtype=float) * ((f - f0) / FPS)
        out[f] = {"track_id": track_id, "xy": [float(xy[0]), float(xy[1])], "lab": lab}
    return out


def scene(*people):
    frames = sorted({f for p in people for f in p})
    return frames, [[p[f] for p in people if f in p] for f in frames]


def ids(*people):
    frames, boxes = scene(*people)
    return stitch(fragments_from_boxes(frames, boxes, FPS), FPS)


def test_a_player_lost_for_a_second_is_one_identity():
    # Corre a 4 m/s; el seguidor la pierde un segundo y le da otro número.
    first = walk(1, 0, 90, (20, 30), (4, 0), BLUE)
    again = walk(2, 120, 210, (36, 30), (4, 0), BLUE)  # donde estaría tras 4 s a 4 m/s
    assert ids(first, again) == {1: 1, 2: 1}


def test_fragments_chain_into_one_identity():
    a = walk(1, 0, 60, (10, 20), (3, 0), BLUE)
    b = walk(2, 75, 150, (17.5, 20), (3, 0), BLUE)
    c = walk(3, 165, 240, (26.5, 20), (3, 0), BLUE)
    assert ids(a, b, c) == {1: 1, 2: 1, 3: 1}


def test_nothing_is_joined_across_the_pitch_or_after_too_long():
    first = walk(1, 0, 90, (20, 30), (0, 0), BLUE)
    far = walk(2, 105, 200, (60, 30), (0, 0), BLUE)        # 40 m en medio segundo: imposible
    late_start = 90 + int((MAX_GAP_S + 1) * FPS)
    late = walk(3, late_start, late_start + 90, (20, 30), (0, 0), BLUE)
    assert ids(first, far) == {1: 1, 2: 2}
    assert ids(first, late) == {1: 1, 3: 3}


def test_a_different_kit_is_never_the_same_player():
    blue = walk(1, 0, 90, (20, 30), (0, 0), BLUE)
    black = walk(2, 105, 200, (20.5, 30), (0, 0), BLACK)
    assert ids(blue, black) == {1: 1, 2: 2}


def test_overlapping_tracks_are_two_people():
    a = walk(1, 0, 150, (20, 30), (0, 0), BLUE)
    b = walk(2, 90, 240, (21, 30), (0, 0), BLUE)  # coinciden en el tiempo: no puede ser la misma
    assert ids(a, b) == {1: 1, 2: 2}
    fa, fb = fragments_from_boxes(*scene(a, b), FPS)
    assert link_cost(fa, fb, FPS) is None


def test_two_players_crossing_are_left_for_the_person_to_decide():
    # Dos compañeras se pierden a la vez en el mismo sitio y reaparecen juntas: cualquiera podría ser cualquiera.
    a = walk(1, 0, 90, (30, 30), (0, 0), BLUE)
    b = walk(2, 0, 90, (30.5, 30.5), (0, 0), BLUE)
    c = walk(3, 120, 210, (30.2, 30.1), (0, 0), BLUE)
    d = walk(4, 120, 210, (30.4, 30.4), (0, 0), BLUE)
    assert ids(a, b, c, d) == {1: 1, 2: 2, 3: 3, 4: 4}


def test_the_clear_one_is_joined_even_when_another_ends_nearby():
    # Dos terminan casi a la vez, pero solo una estaba cerca de donde aparece la nueva.
    near = walk(1, 0, 90, (30, 30), (0, 0), BLUE)
    other = walk(2, 0, 90, (30, 45), (0, 0), BLUE)  # a 15 m
    back = walk(3, 120, 210, (30.5, 30), (0, 0), BLUE)
    assert ids(near, other, back) == {1: 1, 2: 2, 3: 1}


def test_tracks_without_position_are_left_alone():
    frames = [0, 3, 6]
    boxes = [[{"track_id": 9, "xy": None, "lab": BLUE}]] * 3
    assert fragments_from_boxes(frames, boxes, FPS) == []
    assert stitch([], FPS) == {}


# ---------------------------------------------------------------- equipo y salida del encuadre

def tagged(person, **extra):
    """Añade datos a todas las cajas de una persona (equipo) o marca su último/primer cuadro como pegado al borde."""
    out = {f: {**b, **{k: v for k, v in extra.items() if k not in ("exits", "enters")}} for f, b in person.items()}
    if extra.get("exits"):
        out[max(out)]["edge"] = True
    if extra.get("enters"):
        out[min(out)]["edge"] = True
    return out


def test_different_teams_are_never_joined_even_with_similar_shirts():
    # Azul oscuro y negro, parecidos de color; el equipo, decidido por el track entero, manda.
    navy, black = [45, 130, 118], [32, 128, 126]
    a = tagged(walk(1, 0, 90, (20, 30), (0, 0), navy), team="own")
    b = tagged(walk(2, 105, 200, (20.5, 30), (0, 0), black), team="opp")
    assert ids(a, b) == {1: 1, 2: 2}
    # Si no se sabe el equipo de una de las dos, decide el color: aquí son casi iguales y se unen.
    c = tagged(walk(2, 105, 200, (20.5, 30), (0, 0), black), team="unk")
    assert ids(a, c) == {1: 1, 2: 1}


def test_a_player_who_leaves_the_shot_is_matched_by_where_she_was_heading():
    # Sale del encuadre corriendo hacia +x a 5 m/s. Seis segundos después entran dos del mismo equipo:
    # una cerca de donde se la vio por última vez y otra más adelante, hacia donde iba.
    runner = tagged(walk(1, 0, 90, (40, 30), (5, 0), BLUE), exits=True)        # termina en x = 55
    behind = tagged(walk(2, 270, 360, (54, 31), (0, 0), BLUE), enters=True)     # a 1 m de su última posición
    ahead = tagged(walk(3, 270, 360, (66, 30), (0, 0), BLUE), enters=True)      # 11 m más allá, en su dirección
    assert ids(runner, behind, ahead) == {1: 1, 2: 2, 3: 1}


def test_long_gaps_are_only_bridged_when_she_really_left_the_shot():
    still = walk(1, 0, 90, (40, 30), (0, 0), BLUE)
    later = walk(2, 240, 330, (40.5, 30), (0, 0), BLUE)  # 5 s después, en el mismo sitio
    # A la vista todo el rato y sin caja durante 5 s: no se supone que sea la misma.
    assert ids(still, later) == {1: 1, 2: 2}
    # Si salió por el borde y otra entra por el borde, sí.
    assert ids(tagged(still, exits=True), tagged(later, enters=True)) == {1: 1, 2: 1}
    # Pero no si reaparece demasiado lejos de donde podía estar.
    far = tagged(walk(3, 240, 330, (75, 30), (0, 0), BLUE), enters=True)
    assert ids(tagged(still, exits=True), far) == {1: 1, 3: 3}


def test_single_frame_detections_do_not_glue_tracks():
    # El seguidor pierde a una jugadora parada; el detector la ve en cuadros sueltos. Los dos tracks largos se unen
    # entre sí; las detecciones de un cuadro no se unen a nada (son demasiado cortas para saber de quién son).
    first = walk(1, 0, 60, (30, 30), (0, 0), BLUE)
    loose = [walk(100 + k, 63 + 3 * k, 63 + 3 * k, (30, 30), (0, 0), BLUE) for k in range(4)]
    again = walk(2, 75, 150, (30.3, 30), (0, 0), BLUE)
    out = ids(first, *loose, again)
    assert out[1] == out[2] == 1
    assert all(out[100 + k] == 100 + k for k in range(4))


def test_a_chain_through_a_loose_detection_does_not_join_two_people():
    # A (azul) termina, una detección de un cuadro aparece entre medio, y B (negro, otra persona) empieza al lado.
    # Sin equipo decidido, antes A -> suelta -> B se encadenaba por la regla de reaparición inmediata.
    a = walk(1, 0, 60, (30, 30), (0, 0), BLUE)
    glue = walk(1_000_005, 63, 63, (30.4, 30), (0, 0), BLUE)
    b = walk(2, 66, 150, (30.8, 30), (0, 0), BLACK)
    out = ids(a, glue, b)
    assert len(set(out.values())) == 3


def test_a_short_fragment_between_two_long_ones_is_left_alone():
    a = walk(1, 0, 90, (20, 30), (2, 0), BLUE)
    short = walk(2, 96, 111, (26.4, 30), (2, 0), BLUE)  # 0.5 s
    c = walk(3, 117, 210, (27.8, 30), (2, 0), BLUE)
    out = ids(a, short, c)
    assert out[2] == 2
    assert out[3] == 1  # los dos largos sí se unen entre ellos


def test_loose_detections_fill_the_holes_of_a_track():
    from sportsan.tracking.stitch import absorb_loose

    # Track 1 camina a 3 m/s y le faltan los cuadros 30 a 39; ahí el detector la vio (sueltas 1001-1003).
    full = walk(1, 0, 90, (20, 30), (3, 0), BLUE)
    track = {f: b for f, b in full.items() if not 30 <= f <= 39}
    loose = [{f: {**full[f], "track_id": 1001 + k}} for k, f in enumerate((30, 33, 36))]
    # Otra suelta en el mismo instante pero a 15 m: no es ella.
    other = {33: {"track_id": 2000, "xy": [23.3, 45.0], "lab": BLUE}}
    # Y una del otro color justo encima: tampoco.
    rival = {36: {"track_id": 2001, "xy": [23.6, 30.0], "lab": BLACK}}
    frames, boxes = scene(track, *loose, other, rival)
    got = absorb_loose(frames, boxes, lambda t: t >= 1000, FPS)
    assert got == {1001: 1, 1002: 1, 1003: 1}


def test_a_loose_detection_is_not_absorbed_where_the_track_already_has_a_box():
    from sportsan.tracking.stitch import absorb_loose

    track = walk(1, 0, 90, (20, 30), (0, 0), BLUE)
    twin = {45: {"track_id": 1001, "xy": [20.4, 30.0], "lab": BLUE}}  # otra persona pegada a ella
    frames, boxes = scene(track, twin)
    assert absorb_loose(frames, boxes, lambda t: t >= 1000, FPS) == {}


def test_a_loose_detection_on_top_of_a_tracked_person_is_a_duplicate():
    from sportsan.tracking.stitch import duplicate_loose

    loose = lambda t: t >= 1000
    row = [
        {"track_id": 1, "xy": [30.0, 30.0]},
        {"track_id": 1001, "xy": [30.5, 30.3]},   # medio metro: la misma persona vista dos veces
        {"track_id": 1002, "xy": [45.0, 30.0]},   # sola: alguien a quien el seguidor no lleva
        {"track_id": 1003, "xy": [45.4, 30.0]},   # junto a otra suelta: no se decide entre ellas
        {"track_id": 1004, "xy": None},           # sin posición no se puede saber
    ]
    assert duplicate_loose(row, loose) == {1001}
    assert duplicate_loose([r for r in row if r["track_id"] != 1], loose) == set()


def test_physics_in_real_meters_of_the_venue():
    # Sede de 102 x 66: una jugadora a 7.8 m/s reales. En metros su velocidad se conserva; en la cancha normalizada
    # (105 x 68) parecería ir a 8.03 m/s y se recortaría al límite de 8.
    from sportsan.tracking.stitch import MAX_SPEED_MS

    run = walk(1, 0, 60, (20, 30), (7.8, 0), BLUE)
    frames, boxes = scene(run)
    v = fragments_from_boxes(frames, boxes, FPS)[0].velocity
    assert abs(v[0] - 7.8) < 1e-6

    scaled = {f: {**b, "xy": [b["xy"][0] * 105 / 102, b["xy"][1]]} for f, b in run.items()}
    frames, boxes = scene(scaled)
    assert fragments_from_boxes(frames, boxes, FPS)[0].velocity[0] == MAX_SPEED_MS


def test_restitch_rebuilds_meters_from_the_calibration():
    from sportsan.tracking.restitch import legacy_identities, rebuild

    # Calibración trivial: 10 px = 1 m, sede de 102 x 66. Una persona camina; el seguidor la parte en dos tracks.
    H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    frames = []
    for i in range(40):
        x_px = 200 + i * 3 * 10 / FPS * 2 * 10 / 10  # 2 m/s
        tid = 1 if i < 20 else 2
        frames.append({"frame": i * 3, "H": H, "boxes": [[tid, x_px - 5, 290, x_px + 5, 300, 0.9, *BLUE, None, None, True, "unk", tid]]})
    tracks = {"match_id": "x", "video_id": "v1", "fps": FPS, "stride": 3, "image_w": 1920, "image_h": 1080,
              "venue": {"length_m": 102, "width_m": 66}, "frames": frames}
    _, _, meters, insides = rebuild(tracks)
    assert meters[0][0].tolist() == [20.0, 30.0] and insides[0][0]
    ids = legacy_identities(tracks, refs={})
    assert ids[(0, 1)] == ids[(117, 2)] == 1
