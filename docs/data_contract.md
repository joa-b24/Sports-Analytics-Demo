# Contrato de datos

Fuente de verdad en código: `src/sportsan/schema.py`. Si cambias algo, actualiza ambos y los tests en el mismo commit.

## Convenciones

- **Coordenadas:** cancha normalizada de 105 x 68. Origen en la esquina superior izquierda de la cancha, `x` a lo largo (0 a 105), `y` a lo ancho (0 a 68). Se tolera un margen de 3 fuera de las líneas por ruido de la homografía. Arriba es la banda lejana a la cámara.
- **Medidas reales:** cada sede tiene las suyas en `match.yaml` (`venue.pitch_length_m`, `venue.pitch_width_m`). Una posición real `(X, Y)` en metros se normaliza como `x = X * 105 / largo`, `y = Y * 68 / ancho`. Distancias y velocidades se calculan deshaciendo esa escala; no se miden sobre las coordenadas normalizadas.
- **Tiempo:** `t_video = inicio_del_segmento + frame / video_fps`. Todo lo que se muestre al usuario (eventos, jugadas, links a YouTube) usa `t_video`, que es el tiempo del video **original**. Por eso el video original nunca se edita; los segmentos útiles se registran en `segments.csv`. Un partido puede venir en varios videos (`video_id`: `v1`, `v2`...); `t_video` es el tiempo dentro de su video. Los eventos, las jugadas y las marcas de tramo llevan `video_id` (en la app, una fila sin él pertenece a `v1`). Las tablas de tracking todavía no la llevan: se añade antes de procesar un segundo video.
- **fps:** el valor exacto del archivo (por ejemplo 29.97002997, no 30), tomado de `match.yaml`.
- **frame:** índice en el video del segmento al fps original, aunque el tracker salte frames (`vid_stride`).
- **Valores faltantes:** si algo no se puede calcular (homografía fallida, balón no visto), se deja `NaN`. No se inventan datos.
- **Equipos (`team`):** `own` (equipo analizado), `opp` (su contrario), `ref` (árbitro), `unk` (sin clasificar). En un partido propio, `own` somos nosotras; en un partido de scouting, `own` es el rival que se estudia. En el tracking se decide por color de camiseta, no por ID.
- **Dirección de ataque en eventos manuales:** el equipo analizado (`own`) ataca siempre hacia `x = 105`, en los dos periodos. La analista marca la posición ya normalizada.
- **`track_id`:** local a cada segmento (no sobrevive entre segmentos). La identidad real de una jugadora es `player_id`, que se llena en la validación manual.

## `matches/videos.csv` (registro de videos, versionado)

Una fila por video de cada partido: `match_id, kind, date, own_team, other_team, video_id, period, label, url, note`
(qué parte es en `label`, por ejemplo «1.er tiempo» o «Parte 2»). Lo usa `python -m sportsan.ingest.download_videos`, que
baja los que falten a `matches/<match_id>/video/<video_id>.mp4`, mide su fps con ffprobe y los añade a `match.yaml`. Una
fila sin `url` se salta.

## Carpeta del partido

**Nombre:** `aaaa_mm_dd_<local>_vs_<visitante>`, en minúsculas, sin acentos ni espacios (letras, números y `_`), con la fecha
del partido. Ejemplos: `2026_09_25_up_vs_anahuac`, `2011_05_28_barcelona_vs_manchester_united` (un video de referencia
sigue la misma regla). El `match_id` de `match.yaml` es el nombre de la carpeta. Para renombrar sin romper nada:
`python -m sportsan.ingest.rename_match <viejo> <nuevo>`. Las dos carpetas de antes de esta regla (`partido_2026_09_25`,
`partido_ccm_vs_up`) se renombran cuando se sepa el rival de la primera y la fecha de la segunda.

En `match.yaml`, cada video puede llevar `jersey_colors` (si no, se usan los del partido) y `own_attacks` (`right` o `left`:
hacia dónde ataca el equipo analizado en ese video, en la cancha de la calibración; lo usan las alturas de las métricas de
equipo).


`matches/<match_id>/` contiene `match.yaml` (con `jersey_colors` opcional para asignar equipos en el tracking), `segments.csv`, `video/`, `segments/`, `tracking/` y `events/`. `match.yaml` lleva: `match_id` (igual al nombre de la carpeta), `kind` (`own` o `rival`), `date`, `own_team_name`, `other_team_name`, `analysis_stride`, `venue` (`name`, `pitch_length_m`, `pitch_width_m`, `notes`) y `videos`, una lista de `{video_id, period, youtube_id, file, fps}`. Se lee con `sportsan.config.load_config(match=...)`.

## `segments.csv` (entrada, en la carpeta del partido)

| columna | tipo | descripción |
|---|---|---|
| segment_id | str | `s01`, `s02`... Único en todo el partido, también entre videos (es el nombre del clip cortado) |
| video_id | str | opcional: a qué video pertenece la fila. Sin la columna, todas son de `v1` |
| start, end | str | `HH:MM:SS` dentro de ese video |
| tipo | str | `juego`, `pausa` o `no_medible` (solo `juego` se procesa) |

Hay **un archivo por partido**, aunque el partido venga en varios videos: `load_segments(ruta, video_id=...)` devuelve los tramos de un video. El archivo se puede escribir a mano o exportar desde la app web (pestaña **Tramos** de cada partido), que también lo importa. En la app se guardan las marcas de corte (`segments` en las tablas de la app) y el CSV se deriva de ellas. Los tiempos llevan decimales solo cuando hacen falta (`00:03:10.5`); `parse_hms` los acepta.

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
| video_id | str | no | a qué video del partido se refiere `t_video`; `v1` si solo hay uno |
| t_video | float | no | segundos dentro de ese video |
| period | int | no | 1 o 2 |
| type | str | no | `shot, goal, loss, recovery, foul, corner, free_kick, throw_in, penalty, key_pass, other, final_third_entry, box_entry, goal_kick, cross, duel` |
| team | str | no | `own`, `opp`, `ref`, `unk` |
| player_id | str | sí | |
| x, y | float | sí | posición del evento en metros |
| outcome | str | sí | resultado, según el tipo (tabla siguiente) |
| detail | str | sí | segundo dato, según el tipo (tabla siguiente) |
| note | str | sí | texto libre |
| x_end, y_end | float | sí | **opcionales**. Solo `cross` y `corner`: dónde cayó el balón, en la cancha (mismo sistema que `x`, `y`) |
| goal_y, goal_z | float | sí | **opcionales**. Solo `shot`, `goal`, `free_kick`, `penalty`: dónde cruzó la línea de gol, visto de frente desde quien remata. `goal_y` en metros desde el poste izquierdo (0 a 7.32 entre postes), `goal_z` la altura (0 a 2.44 bajo el larguero); un tiro fuera cae fuera de esos rangos (se admiten hasta 5 m alrededor; la app deja marcar hasta 2.5 m a los lados y 1.6 m por encima) |

`outcome` y `detail` son opcionales: nulo significa que no se anotó, no que no ocurrió. Solo se admiten estos valores
(`EVENT_OUTCOMES` y `EVENT_DETAILS` en `schema.py`, y los mismos en `web/lib/types.ts`):

| type | outcome | detail |
|---|---|---|
| shot | `on_target`, `off_target`, `blocked` (el gol es el tipo `goal`) | |
| corner | `shot` (acaba en remate), `cleared`, `play_on` | `inswing` (cerrado), `outswing` (abierto), `short` |
| free_kick | `shot`, `cleared`, `play_on` | |
| cross | `shot`, `cleared`, `play_on` | |
| goal_kick | `kept` (conservan el balón), `lost` | `short`, `long` |
| recovery | | `forward`, `backward` (primer pase tras recuperar) |
| duel | `won`, `lost` (para el equipo del evento) | `aerial`, `ground` |

Las dos parejas de destino van juntas (las dos o ninguna). Un archivo sin esas columnas es válido: se anotan en la tercera
pasada del etiquetado y casi siempre faltarán. Un tiro libre que es un centro se anota como `cross` si interesa dónde cayó.

`final_third_entry` y `box_entry` no llevan resultado: si acaban en tiro se deduce de los eventos siguientes.

`duel` (2026-10-17) es opcional: solo se etiqueta en los partidos donde se quiere el mapa de duelos, porque alarga la
pasada 1. Se anota una vez por duelo, con el equipo de la jugadora que se quiere seguir y su resultado para ese equipo.
Un partido sin duelos no tiene el mapa; no significa que no los hubo.

## `passes_<match_id>.csv` (pases etiquetados a mano, exportados desde la app; fuera del repo)

Pasada 4 del etiquetado: con el video corriendo se escribe, en orden, el número de cada jugadora que recibe el balón;
dos seguidas del mismo equipo son un pase, y «la perdimos» cierra la cadena con un pase incompleto. Es la fuente de la
red de pases y de los pases por jugadora (no sale del tracking). En la app viven en `State.passes`. Se valida con
`validate_passes` de `schema.py`. Lleva los nombres de la plantilla, así que `.gitignore` excluye `passes_*.csv`: se guarda en
`matches/<match_id>/tracking/` (ignorada) o fuera del repo.

| columna | tipo | nulos | descripción |
|---|---|---|---|
| pass_id | str | no | único |
| match_id | str | no | |
| video_id | str | no | como en eventos |
| t_video | float | no | segundos dentro de ese video: cuando quien pasa tenía el balón (el momento en que se escribió su número, menos el retraso elegido) |
| period | int | no | 1 o 2 |
| team | str | no | `own` u `opp` |
| from_id | str | no | quien pasa: el nombre de la plantilla en nuestros partidos, o `#<número>` |
| to_id | str | sí | quien recibe; solo en los completos |
| outcome | str | no | `complete` (llega a una compañera) o `incomplete` (la perdió el equipo) |

## Tablas de la app web (`web/lib/types.ts`)

Viven en el navegador y se exportan como un JSON de respaldo. Los eventos usan las columnas de arriba.

- **`matches`:** `match_id`, `name`, `kind` (`own`: nuestro partido, `rival`: partido de un rival, `reference`: video de referencia de otros equipos), `date`, `focus_team`, `other_team`, `youtube_id`, `report` (texto del informe por sección: `resumen`, `fortalezas`, `debilidades`, `balon_parado`, `jugadoras_clave`, `plan`; desde el 2026-10-17 también, opcionales, `conclusiones` (sustituye al plan en un partido propio), `jornada` y `results_manual`, una lista de `{date, opponent, home, goals_for, goals_against, competition}` con resultados del equipo analizado en partidos que no están en la app; un informe guardado antes los abre vacíos), `is_demo`.
- **`plays`:** `play_id`, `match_id`, `title`, `t_start` y `t_end` (segundos de `t_video`), `note`, `keyframes`. Cada keyframe es `{t, pos}` con `t` en `t_video` y `pos` un mapa `token → [x, y]` en metros. Tokens: `o1..o11` (equipo analizado), `r1..r11` (contrario), `ball`. Entre keyframes la posición se interpola linealmente. Los keyframes puestos a mano son un esquema, no una medición. `abp` (opcional, 2026-10-17): la jugada es de balón parado y el informe la lista en esa sección.
- **`sessions`** (entrenamientos, una fila por jugadora y sesión): `date` (AAAA-MM-DD), `session_id`, `player_id` y `metrics`, un mapa `nombre → número` con las columnas numéricas del CSV del sensor. Nombres sugeridos: `duration_min, total_distance_m, hsr_distance_m, sprints, max_speed_kmh, player_load, hr_avg, hr_max`. Celda vacía = valor faltante.

- **`anchors`** (calibración manual, una fila por cuadro calibrado): `anchor_id`, `match_id`, `video_id`, `venue_id`, `frame` (índice en el video original), `t_video` (`frame / fps`), `image_w`, `image_h` y `points`, una lista de `{landmark_id, px, py}` con el punto de referencia de la sede y su posición en píxeles. La homografía no se guarda: se recalcula con los puntos. Se exportan como `anchors_<match_id>_<video_id>.json` con `schema_version` (2), `match_id`, `video_id`, `fps`, `venue` (`venue_id`, `name`, `length_m`, `width_m`) y `anchors`; en la exportación cada punto lleva además `x_m`, `y_m` (su posición en metros reales en la sede), para que Python no tenga que repetir el modelo de la sede. La versión 1 no traía esos campos y `sportsan.tracking.propagate` la rechaza.
- **`sessions`**: columnas reconocidas además de las del sensor: `rpe` (1 a 10, cuestionario posterior), `duration_min`, y del cuestionario previo `sleep_hours`, `sleep_q`, `stress`, `fatigue`, `soreness` (1 a 7, **1 es lo mejor**) y `energy` (1 a 10, 10 es lo mejor). La carga de la sesión es `rpe * duration_min` (`web/lib/load.ts`); si falta la duración de una jugadora se usa la mediana de su sesión y se indica. Las columnas de salud (enfermedad, periodo menstrual, ánimo, molestias) se descartan al importar.
- **`matches`**: además de sus datos, `videos`, una lista de `{video_id, youtube_id, label, period}`. Un tiempo puede venir en varios videos: `period` (1 o 2) dice a cuál pertenece cada uno; sin él, el primer video es el 1.er tiempo y los demás el 2.º. Para analizar el partido entero la app pone los videos en fila sobre un solo eje (`web/lib/videos.ts`); ese eje no se guarda.
- **`trackEdits`** (correcciones de la mesa de corrección, una fila por parte procesada): `key` (`<match_id>|<video_id>|<inicio>_<fin>`), `identity` (`"<track>"` o `"i<identidad>"` -> identidad a la que pertenece), `people` (por identidad: `team` puesto a mano y `player_id`), `removed` (identidades que no son jugadoras), `splits` (`{track, frame, identity}`: desde ese cuadro el track es otra persona) y `manual` (`{identity, frame, px, py}`: pies marcados a mano donde el detector la perdió). El archivo de tracks nunca se modifica.
- **`matches`** también puede llevar `folder` (nombre de su carpeta en `matches/`, para la calibración y el tracking dentro del partido) y `venue_id` (la sede elegida en su calibración).
- **`roster`** (plantilla): `{player_id, number}`. `player_id` es el nombre con que se identifica a la jugadora en eventos, tracks y sesiones; `number` es su número habitual y puede cambiar. Los números desde 99 hacia abajo son provisionales (no se sabía el número).
- **`jerseys`**: colores de camiseta por `match_id` de la carpeta del partido, `{own, opp, ref, own_gk, opp_gk}` en `#rrggbb`. La app puede escribirlos en `jersey_colors` de `match.yaml`.
- **`segments`** (marcas de corte del video, una fila por marca): `mark_id`, `match_id`, `video_id`, `t_video` y `tipo` (`juego`, `pausa`, `no_medible` o `fin`). Desde cada marca hasta la siguiente el video es de ese tipo; `fin` cierra el tramo anterior sin abrir otro. De ahí sale un solo `segments.csv` por partido (`web/lib/segments.ts`), con los videos en orden y la columna `video_id`; un último tramo sin cerrar no se exporta.
- **`venues`** (sedes creadas o editadas en la app): `venue_id`, `name`, `kind` (`soccer` o `football_overlay`), `length_m`, `width_m`, `hash_far_m`, `hash_near_m`, `grid_dx_m`, `grid_dy_m`, `soccer_color`, `grid_color`. Una sede guardada con el `venue_id` de una del código la reemplaza.

## `report_<match_id>.json` (datos del informe, exportados desde la app; carpeta del partido, fuera del repo)

Todo lo que dibuja la pestaña Informe, calculado por `buildReport` de `web/lib/report.ts`. Lo escribe «Exportar datos del
reporte» (descarga y, si el partido tiene carpeta, `matches/<match_id>/report_<match_id>.json`). Servirá para un visor
estático que abra el informe sin la app. Campos principales:

| Campo | Contenido |
|---|---|
| `version` | 1 |
| `generated`, `anonymized` | fecha del informe; `true` si los nombres se cambiaron por el dorsal (o `J1`, `J2`... sin dorsal conocido), también en los textos libres |
| `cover` | tipo de informe, partido, fecha, jornada, marcador (`score`, de los goles etiquetados; nulo sin eventos), `focus_team`, `other_team`, `level` |
| `cover.level` | `level` (0 a 4), `play_s` (segundos de juego de los tramos; nulo sin tramos), `ball` y `tracking` (`{seconds, share}` del tiempo de juego), `named_share`, `label`, `next` |
| `results` | últimos 5 resultados del equipo analizado (`V`/`E`/`D`), de la app (`source: app`) y escritos a mano (`manual`) |
| `summary` | filas comparativas `{key, label, own, opp}` y tramos de 5 y 10 min |
| `maps` | tiros (`goal_y`, `goal_z` si se marcaron), centros con destino, centros sin destino o sin posición por equipo, duelos (nulo si no hay) y cuadrículas 5 × 3 de pérdidas y recuperaciones |
| `transitions` | por equipo: pérdidas → tiro del contrario y recuperaciones → tiro propio en menos de 15 s, con su momento, zona y segundos; tasas `{k, n}` |
| `set_pieces` | córners, tiros libres, saques de meta y penales por equipo; jugadas marcadas como balón parado |
| `texts`, `plays`, `method` | textos de la analista, jugadas para revisar y líneas del método |

Un momento (`moment`) es `{video_id, t, label, minute, youtube, app}`: `t` en segundos del video, `minute` el minuto de
juego (nulo sin tramos), `youtube` el enlace al momento (3 s antes) y `app` la ruta del reproductor de la app
(`/partido?id=..&video=..&t=..`). En las cifras, `own` es siempre el equipo analizado (`focus_team`), también en el
informe de un rival.

**Niveles de datos.** N1 = hay eventos. N2 = balón seguido a mano en al menos el 50 % del tiempo de juego (cuenta cada
cuadro procesado con una marca a mano o unido a una por menos de 3 s; las posiciones tomadas de los eventos no cuentan).
N3 = además, partes revisadas en la mesa de corrección (con jugadoras de algún equipo) en al menos el 50 % del tiempo de
juego. N4 = además, al menos el 80 % de las posiciones del equipo analizado en esas partes tienen nombre. Sin tramos de
juego marcados no se puede medir la cobertura y el nivel se queda en N1. La cobertura se cuenta en celdas de 0.5 s por
video: un tramo cubierto por dos archivos (una exportación unida y sus partes) cuenta una vez; un último tramo de juego sin
cerrar no cuenta.

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

## `calib_<video_id>_<inicio>_<fin>.json` (calibración propagada, `matches/<match_id>/tracking/`)

Lo escribe `python -m sportsan.tracking.propagate` a partir de las anclas exportadas y del video original. Cubre un tramo corto
(una jugada), no el partido. La app lo carga en Calibración para dibujar la rejilla sobre los cuadros intermedios; no se guarda
en `localStorage`.

| campo | descripción |
|---|---|
| schema_version, kind | `1`, `"calib_track"` |
| match_id, video_id, fps, image_w, image_h, venue | de las anclas y del video |
| start_frame, end_frame | cuadros del video original, inclusive |
| frames | lista de `{frame, H, source, disagreement_m}` |
| check | anclas de control: `{frame, from, error_mean_m, error_max_m}` |

- `H`: 9 números por filas, **imagen (px) -> sede (metros reales)**, la misma convención que las anclas. `null` si no se pudo calcular.
- `source`: `anchor` (cuadro calibrado a mano), `library` (ubicado automáticamente con la biblioteca), `propagated` o `none`.
- `disagreement_m`: distancia media, en metros, entre lo que da la propagación desde el ancla anterior y desde la siguiente.
  Solo existe entre dos anclas; fuera de ellas es `null` y no hay medida de calidad.
- `check`: cada ancla interior se quita y se mide el error de sus puntos según la propagación entre sus vecinas. Es la medida
  honesta del error; hace falta un mínimo de tres anclas. Cuando el archivo viene de la biblioteca, `from` es `"library"` y cada
  fila lleva además `inliers` (emparejamientos con la mejor referencia) y `ref_spread_m` (cuánto difieren entre sí las referencias usadas).
- Supuesto: la cámara gira y hace zoom desde un punto fijo. Si la cámara se traslada, el movimiento entre cuadros deja de ser
  una homografía y el resultado no vale.

## `library_<video_id>.npz` (biblioteca de calibración, `matches/<match_id>/tracking/`)

La construye `python -m sportsan.tracking.library build` a partir de un tramo ya calibrado que recorra la cancha (un barrido), y la
usa `... library locate` para calibrar cualquier otro tramo del mismo video sin anclas a mano. Es un archivo binario de trabajo
(unos MB), no se versiona ni se carga en la app.

Contiene, por cada cuadro de referencia: su número de cuadro, su `H` (imagen px -> metros reales) y sus puntos característicos
(posición en píxeles del video original y descriptor). `meta` guarda `schema_version`, `match_id`, `video_id`, tamaño de imagen,
sede y los cuadros del barrido.

Vale solo mientras la cámara esté en el mismo sitio que durante el barrido, y para encuadres parecidos a alguno de él. Un cuadro
que no se parece a ninguna referencia queda sin ubicar; no se inventa.

## `tracks_<video_id>_<inicio>_<fin>.json` (detecciones en píxeles, `matches/<match_id>/tracking/`)

Lo escribe `python -m sportsan.tracking.detect`, una por parte del video (60 s por defecto). Todo en **píxeles del video original**;
la conversión a metros se hace después con la calibración. Los `track_id` son locales a cada parte.

| campo | descripción |
|---|---|
| schema_version, kind | `1` (solo cajas, de `detect`) o `3` (con posición, equipo, identidad propuesta y calibración, de `process`); `"tracks_px"` |
| match_id, video_id, fps, image_w, image_h, model, tracker | del video y de la corrida |
| venue | `{length_m, width_m}`: medida real de la sede con la que se calibró (solo con `process`). La app la copia a `tracks_fixed` para medir distancias en metros reales |
| start_frame, end_frame, stride | cuadros del video original (final exclusivo); se procesa 1 de cada `stride` |
| box_columns | nombres de las columnas de cada caja |
| frames | lista de `{frame, H, boxes}`; cada caja es `[track_id, x1, y1, x2, y2, conf, lab_l, lab_a, lab_b]`. `H` (solo con `process`) es la calibración del cuadro, imagen px -> metros reales, o `null` |
| quality | indicadores de la parte |

- Con `python -m sportsan.tracking.process` (detección + biblioteca de calibración) cada caja lleva cuatro columnas más: `x`, `y` (pie de la caja en la cancha normalizada 105 x 68; `null` si ese cuadro no tiene calibración), `on_pitch` (dentro de la cancha con el margen del contrato) y `team` (`own`, `opp`, `ref` o `unk`). `quality` suma `calibrated_share`, `library_anchors`, `library_dropped`, `on_pitch_median`, `on_pitch_tracks`, `on_pitch_tracks_long`, `on_pitch_tracks_short`, `on_pitch_tracks_per_person` y `teams`.
- La misma corrida escribe `tracking_<video_id>_<inicio>_<fin>.parquet`: la tabla `tracking` de este contrato (validada con `validate_tracking`), solo con las personas dentro de la cancha, `segment_id = <video_id>_<inicio>_<fin>`, `frame` contado desde el inicio de la parte y `px`, `py` con el pie en píxeles. `player_id` va vacío hasta la corrección manual.
- El equipo sale del color de la camiseta comparado con `jersey_colors` de `match.yaml` (`{own, opp, ref}` en `#rrggbb`); se decide por track, con el color mediano de sus cajas. Sin esa clave, todo queda en `unk`.
- Con `process`, la última columna de cada caja es `identity`: la identidad propuesta tras unir fragmentos sobre la cancha (`sportsan.tracking.stitch`: un track que termina y otro del mismo color que empieza cerca poco después). Es una propuesta que la mesa de corrección puede deshacer; `track_id` conserva el identificador original del seguidor. `quality` suma `identities` e `identities_per_person`.
- **Detecciones sueltas.** El seguidor solo devuelve los tracks que da por confirmados y deja fuera parte de lo que el detector ve. Esas detecciones se guardan con `track_id` a partir de 1 000 000 (una por cuadro); la unión de fragmentos las asigna después por posición. `quality` trae `loose_boxes` y `loose_absorbed` (las que rellenaron el hueco de un track).
- `jersey_colors` admite también `own_gk` y `opp_gk` (porteras): cuentan para su equipo.
- `lab_*`: color de la camiseta en Lab (escala de OpenCV, 0 a 255): mediana del torso sin contar los píxeles de césped. Al comparar dos colores la luminosidad pesa la mitad.
- `quality`: `frames`, `people_median`, `people_min`, `tracks`, `tracks_long` (duran al menos el 80 % de la parte),
  `tracks_per_person`, `low_visibility` (pares de cuadros entre los que se ven menos de 6 personas durante 2 s o más) y
  `low_visibility_share`.
- Incluye a todas las personas detectadas, también banca, grada y árbitra: no se filtra nada hasta tener metros.
- El balón no está: un detector genérico lo confunde con las marcas del campo a este tamaño.

`tracks_<video_id>_index.json` lista las partes hechas con sus indicadores y sus tiempos, para ver el avance.

## `tracks_fixed_<video_id>_<inicio>_<fin>.json` (tracks corregidos, exportados desde la app)

Resultado de la mesa de corrección sobre una parte (`schema_version` 2): `people` (`{id, team, player_id, tracks}`) y, por cuadro
procesado, `positions` (`{id, x, y, source, raw?}`) en la cancha normalizada. `venue` (`{length_m, width_m}`, desde 2026-10-16;
`null` si no se conoce) es la medida real de la sede: las distancias (quién tiene el balón, velocidades) se miden en esos metros,
no en unidades del dibujo de 105 x 68. Los archivos anteriores no lo traen y se toma de `match.yaml`. No incluye a quien quedó fuera de la cancha ni a las
identidades descartadas. Cada persona tiene como mucho una posición por cuadro: si el detector dio dos cajas sobre la misma jugadora
(a menos de 2 m una de otra) y en la mesa se unificaron, queda la de más confianza y la otra no se exporta.

`ball` es la lista de posiciones del balón, `{frame, x, y, source}`. **El balón no se detecta**: `source` es `manual` (clic sobre
el video, llevado a la cancha como si el balón estuviera en el suelo), `event` (posición de un evento etiquetado en ese instante; solo donde no hay una marca a mano a menos de 3 s, porque su momento y su lugar son aproximados) o
`interpolated` (recta entre dos de las anteriores separadas por 3 s o menos, o unidas a mano en la mesa para un pase largo o un balón por alto, sin límite de tiempo). Donde no hay ninguna cerca no hay balón. Los eventos
se etiquetan con el equipo analizado atacando hacia `x = 105`; al exportar se indica hacia dónde ataca en ese video y, si es hacia
`x = 0`, se reflejan.

Si el archivo une varias partes de un video trae además `parts` (`{start_frame, end_frame, corrected, linked_to_previous}`) y cada
persona lleva `sources` (`{part, id}`: quién era en cada parte) en lugar de `tracks`; los `id` se numeran de nuevo desde 1. Las
personas con el mismo nombre son una sola. Las que no tienen nombre se enlazan entre dos partes seguidas solo si la que termina y la
que empieza son la más cercana una de otra, a una distancia alcanzable (2 m más 8 m/s por el tiempo transcurrido), de equipos
compatibles y sin otra candidata a menos de 1 m de diferencia. El suavizado se aplica después de unir.

`source` dice de dónde sale cada posición, y es obligatorio leerlo antes de calcular nada:

| source | qué es |
|---|---|
| `auto` | detección del programa (pie de la caja, pasado a la cancha con la calibración del cuadro) |
| `manual` | pies marcados a mano donde el detector perdió a la persona |
| `interpolated` | **no es una medición**: posición rellenada en línea recta dentro de un hueco (por defecto, de cualquier duración: la jugadora fuera de cuadro suele volver a su sitio) |

`smoothing` es `null` si se exportó tal como se midió. Si no, guarda las reglas con que se limpiaron las trayectorias
(`web/lib/smooth.ts`) y sus totales:

| campo | regla | valor recomendado |
|---|---|---|
| `max_speed_ms` | un punto que exigiría más velocidad que esta para llegar **y** para irse es un microsalto y se quita; tampoco se rellena un hueco que la exigiría | 9 m/s |
| `max_fill_s` | los huecos de hasta esta duración entre dos posiciones conocidas se rellenan con una recta; los más largos se dejan vacíos. `null` = se rellenan todos (desde 2026-10-17, lo predeterminado en la mesa) | sin límite |
| `window_s` | promedio centrado (pesos triangulares; una marca a mano pesa el triple) dentro de cada tramo sin huecos | 0.5 s |
| `outliers`, `filled`, `openGaps` | microsaltos quitados, posiciones rellenadas y huecos dejados vacíos | |

Las velocidades se juzgan en metros reales de la sede, no en unidades de la cancha normalizada. `raw` es la posición medida de un
punto que el suavizado movió. Las marcas a mano nunca se quitan como microsalto.

## Sesiones de Strava (`data/strava/`, fuera del repo)

Las escribe `python -m sportsan.ingest.strava_sync sync`. Son datos personales de una atleta: no entran al repo.

- `activities.json`: resumen de todas las actividades desde la fecha pedida, de cualquier deporte (`id, name, sport_type,
  start_date, start_date_local, elapsed_time, moving_time, distance, average_heartrate, max_heartrate, average_speed, max_speed,
  total_elevation_gain, has_heartrate`), en las unidades de Strava (segundos, metros, m/s).
- `<id>.json`: una por actividad de los deportes elegidos (por defecto `Soccer`). `activity` (el resumen más
  `perceived_exertion`), `laps` (vueltas marcadas en el reloj, con `start_index` y `end_index` sobre las series) y `streams`:
  series por segundo del mismo largo (`time`, `distance`, `latlng`, `heartrate`, `velocity_smooth`, `cadence`, `altitude`,
  `moving`). Una serie que el reloj no grabó no aparece.
- `sessions.csv`: una fila por actividad del índice (de cualquier deporte: toda carga cuenta), en el formato que importa la app:
  `date, session_id` (`strava_<id>`), `player_id, football` (1 si es de fútbol), `duration_min, moving_min, distance_m, hr_avg,
  hr_max, speed_avg_ms, speed_max_ms, relative_effort, rpe`. `relative_effort` es el «esfuerzo relativo» de Strava
  (`suffer_score`): sale del tiempo en cada zona de frecuencia cardiaca, con una fórmula que Strava no publica, y solo existe si
  la sesión tiene pulso. `rpe` es el esfuerzo percibido anotado en Strava. Lo que falta queda vacío.

## `team_metrics_<video_id>.json` (forma de los equipos, `matches/<match_id>/tracking/`)

Lo escribe `python -m sportsan.metrics.report` a partir de las partes `tracking_<video>_*.parquet` (sin corregir: solo usa el
equipo de cada persona). Por equipo (`own`, `opp`): cuadros, cuadros válidos y, por tramos de 5 y 10 minutos de **juego**
(según `segments.csv`), la mediana de `width` (ancho), `length` (largo), `line_height` (distancia media de las 4 más
retrasadas a su portería), `block_height` (distancia media de todas a su portería), `centroid_x`, `centroid_y`, con
`valid_share`. Un cuadro cuenta si se ven al menos `min_visible` (7) jugadoras de campo del equipo; la portera se quita si va
sola a más de 8 m de la siguiente. Sin `own_attacks` las alturas son `null`. Un tramo con menos de 10 cuadros válidos da
`null`. Funciones en `src/sportsan/metrics/team_blocks.py`.

## `labels_<video_id>_<inicio>_<fin>.json` (correcciones como etiquetas, exportadas desde la app)

Para medir cuánto trabajo deja una forma de unir tracks (`python -m sportsan.tracking.evaluate`). Una entrada por cada caja
del archivo de tracks, también las descartadas: `frames: [{frame, boxes: [{track, label, status}]}]`, donde `track` es la
columna 0 original (nunca la identidad), `label` la persona tras las correcciones y `status` `player`, `dropped` (caja
descartada una por una: duplicado; `label` null) o `removed` (la persona no es jugadora). Además `manual` (pies marcados a
mano, con su `label`), `people` (`{label, team, reviewed, named}`: **solo las revisadas cuentan como verdad**),
`rejected` (pares que no son la misma persona), `source` (`schema_version`, `tracker`, `assoc` del archivo de tracks) y
`edits` (las correcciones tal cual). **Nunca lleva nombres de jugadoras**: solo `named` (true/false). La clave es la caja
original, así que las etiquetas siguen valiendo si la parte se vuelve a unir con otro método sin volver a detectar.
