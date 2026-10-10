# Contrato de datos

Fuente de verdad en código: `src/sportsan/schema.py`. Si cambias algo, actualiza ambos y los tests en el mismo commit.

## Convenciones

- **Coordenadas:** cancha normalizada de 105 x 68. Origen en la esquina superior izquierda de la cancha, `x` a lo largo (0 a 105), `y` a lo ancho (0 a 68). Se tolera un margen de 3 fuera de las líneas por ruido de la homografía. Arriba es la banda lejana a la cámara.
- **Medidas reales:** cada sede tiene las suyas en `match.yaml` (`venue.pitch_length_m`, `venue.pitch_width_m`). Una posición real `(X, Y)` en metros se normaliza como `x = X * 105 / largo`, `y = Y * 68 / ancho`. Distancias y velocidades se calculan deshaciendo esa escala; no se miden sobre las coordenadas normalizadas.
- **Tiempo:** `t_video = inicio_del_segmento + frame / video_fps`. Todo lo que se muestre al usuario (eventos, jugadas, links a YouTube) usa `t_video`, que es el tiempo del video **original**. Por eso el video original nunca se edita; los segmentos útiles se registran en `segments.csv`. Un partido puede venir en varios videos (`video_id`: `v1`, `v2`...); `t_video` es el tiempo dentro de su video. Las tablas todavía no llevan la columna `video_id`: se añade en el contrato v2, antes de procesar un segundo video del mismo partido.
- **fps:** el valor exacto del archivo (por ejemplo 29.97002997, no 30), tomado de `match.yaml`.
- **frame:** índice en el video del segmento al fps original, aunque el tracker salte frames (`vid_stride`).
- **Valores faltantes:** si algo no se puede calcular (homografía fallida, balón no visto), se deja `NaN`. No se inventan datos.
- **Equipos (`team`):** `own` (equipo analizado), `opp` (su contrario), `ref` (árbitro), `unk` (sin clasificar). En un partido propio, `own` somos nosotras; en un partido de scouting, `own` es el rival que se estudia. En el tracking se decide por color de camiseta, no por ID.
- **Dirección de ataque en eventos manuales:** el equipo analizado (`own`) ataca siempre hacia `x = 105`, en los dos periodos. La analista marca la posición ya normalizada.
- **`track_id`:** local a cada segmento (no sobrevive entre segmentos). La identidad real de una jugadora es `player_id`, que se llena en la validación manual.

## Carpeta del partido

`matches/<match_id>/` contiene `match.yaml`, `segments.csv`, `video/`, `segments/`, `tracking/` y `events/`. `match.yaml` lleva: `match_id` (igual al nombre de la carpeta), `kind` (`own` o `rival`), `date`, `own_team_name`, `other_team_name`, `analysis_stride`, `venue` (`name`, `pitch_length_m`, `pitch_width_m`, `notes`) y `videos`, una lista de `{video_id, period, youtube_id, file, fps}`. Se lee con `sportsan.config.load_config(match=...)`.

## `segments.csv` (entrada, en la carpeta del partido)

| columna | tipo | descripción |
|---|---|---|
| segment_id | str | `s01`, `s02`... |
| start, end | str | `HH:MM:SS` en el video original |
| tipo | str | `juego`, `pausa` o `no_medible` (solo `juego` se procesa) |

## `tracking_<segment_id>.parquet` (una fila por jugadora y frame)

| columna | tipo | nulos | descripción |
|---|---|---|---|
| match_id | str | no | de `match.yaml` |
| segment_id | str | no | |
| frame | int | no | ver convenciones |
| t_local | float | no | segundos desde el inicio del segmento |
| t_video | float | no | segundos en el video original |
| track_id | int | no | local al segmento |
| team | str | no | `own`, `opp`, `ref`, `unk` |
| player_id | str | sí | se llena en validación manual |
| x, y | float | sí | metros; NaN si no hay homografía |
| conf | float | sí | confianza de la detección, 0 a 1 |

Único por `(segment_id, frame, track_id)`.

Columnas opcionales que escribe el pipeline: `px`, `py` (pie de la jugadora en píxeles). Permiten reproyectar a metros más adelante con una calibración suavizada, sin volver a correr YOLO.

## `ball_<segment_id>.parquet` (una fila por frame)

`match_id, segment_id, frame, t_local, t_video, x, y, conf, interpolated` (bool: posición interpolada y no detectada). Único por `(segment_id, frame)`. Opcionales: `px`, `py`. Los huecos de hasta 5 frames se interpolan (`interpolated = True`); los más largos quedan en NaN.

## `calib_<segment_id>.parquet` (opcional, una fila por frame procesado)

Resultado de la calibración de cada frame: `n_keypoints` (visibles y confiables), `n_inliers`, `ok`, `reason` (`ok`, `pocos_keypoints`, `puntos_casi_colineales`, `ransac_fallo`, `fov_implausible`, `salto_temporal`, `sin_keypoints`), la homografía px→m en `h0..h8` y el campo de visión proyectado a la cancha en `fov0..fov7` (esquinas de la imagen: x1,y1,...,x4,y4, en metros). Si `ok = False`, esos valores son NaN y las filas de `tracking` de ese frame tienen `x, y = NaN`.

## `events_*.parquet` (etiquetado manual, `matches/<match_id>/events/`)

| columna | tipo | nulos | descripción |
|---|---|---|---|
| event_id | str | no | único |
| match_id | str | no | |
| t_video | float | no | segundos en el video original |
| period | int | no | 1 o 2 |
| type | str | no | `shot, goal, loss, recovery, foul, corner, free_kick, throw_in, penalty, key_pass, other` |
| team | str | no | `own`, `opp`, `ref`, `unk` |
| player_id | str | sí | |
| x, y | float | sí | posición del evento en metros |
| outcome | str | sí | libre (p. ej. `on_target`, `blocked`) |
| note | str | sí | texto libre |

## Tablas de la app web (`web/lib/types.ts`)

Viven en el navegador y se exportan como un JSON de respaldo. Los eventos usan las columnas de arriba.

- **`matches`:** `match_id`, `name`, `kind` (`rival` o `own`), `date`, `focus_team`, `other_team`, `youtube_id`, `report` (texto del informe por sección), `is_demo`.
- **`plays`:** `play_id`, `match_id`, `title`, `t_start` y `t_end` (segundos de `t_video`), `note`, `keyframes`. Cada keyframe es `{t, pos}` con `t` en `t_video` y `pos` un mapa `token → [x, y]` en metros. Tokens: `o1..o11` (equipo analizado), `r1..r11` (contrario), `ball`. Entre keyframes la posición se interpola linealmente. Los keyframes puestos a mano son un esquema, no una medición.
- **`sessions`** (entrenamientos, una fila por jugadora y sesión): `date` (AAAA-MM-DD), `session_id`, `player_id` y `metrics`, un mapa `nombre → número` con las columnas numéricas del CSV del sensor. Nombres sugeridos: `duration_min, total_distance_m, hsr_distance_m, sprints, max_speed_kmh, player_load, hr_avg, hr_max`. Celda vacía = valor faltante.

- **`anchors`** (calibración manual, una fila por cuadro calibrado): `anchor_id`, `match_id`, `video_id`, `venue_id`, `frame` (índice en el video original), `t_video` (`frame / fps`), `image_w`, `image_h` y `points`, una lista de `{landmark_id, px, py}` con el punto de referencia de la sede y su posición en píxeles. La homografía no se guarda: se recalcula con los puntos. Se exportan como `anchors_<match_id>_<video_id>.json` con `schema_version`, `match_id`, `video_id`, `fps` y `anchors`.

## Modelo de referencia de una sede (`web/lib/venue.ts`)

Cada sede define `venue_id`, sus medidas reales y un catálogo de puntos de referencia `{id, label, x, y, group, exact}` en **metros reales**, con origen en la esquina de la cancha de fútbol lejana a la cámara y a su izquierda. `exact = false` marca una posición que descansa en un supuesto todavía sin comprobar. La homografía de un ancla va de píxeles a esos metros reales; para guardar posiciones se normaliza a 105 x 68.

Sede `cueva_del_leon` (100 x 65 m): cancha de fútbol sobre un campo de fútbol americano reglamentario. Grupos: `football` (cruces de las líneas de yarda con las bandas; exactos por reglamento), `hash` (marcas interiores; posición sin confirmar) y `soccer` (líneas de fútbol; suponen medidas estándar y cancha centrada).

Los datos de ejemplo llevan `is_demo = true` o un id que empieza por `demo_`, y la UI los rotula siempre.

## Cámara de seguimiento automático: qué implica

La cámara es de tipo panorámico 180° con encuadre automático: solo existe el encuadre que sigue el juego, no el panorámico completo. Consecuencias que las métricas **deben** respetar:

- Las jugadoras fuera del encuadre **no están ausentes, simplemente no se ven**. Largo, ancho y centroide del equipo solo describen a quienes salen en cuadro, y están sesgados hacia donde está la jugada. Usa `fov0..fov7` de `calib_*` para saber qué parte de la cancha estaba visible en cada frame.
- Mapas de calor y distancia recorrida por jugadora tienen huecos: no son comparables entre jugadoras sin corregir por tiempo en cuadro.
- La homografía se calcula frame por frame con los keypoints visibles. Con pocos keypoints es frágil (simulación con ruido de 2 px y un keypoint mal ubicado: error medio ~49 m con 6 puntos sin filtros; ~1.8 m entre los frames aceptados con filtros, a costa de rechazar ~44 % de los frames). Por eso el pipeline prefiere dejar `NaN` antes que inventar posiciones.
- Las coordenadas se reescalan desde la cancha de Roboflow (120x70 m) a 105x68 m: los bordes son exactos, las áreas interiores son aproximadas.
- La orientación (qué portería es cuál) puede invertirse cuando solo se ve una zona simétrica de la cancha. Falta normalizar la dirección de ataque por periodo.

## Qué se calcula de dónde

- **Solo con tracking:** mapas de calor, distancia y velocidad, forma del equipo (centroide, largo, ancho, línea defensiva), control de espacio, posesión aproximada.
- **Requiere eventos manuales:** tiros, goles, pérdidas y recuperaciones, jugadas del visor. Las redes de pase quedan fuera del MVP.
