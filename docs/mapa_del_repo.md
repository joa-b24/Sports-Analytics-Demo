# Mapa del repositorio

Para ubicarte: qué hay en cada carpeta, qué hace cada archivo, dónde se guarda cada dato y qué tocar para cambiar cada cosa.
Actualizado el 2026-10-12. Las reglas de formato de los datos están en `docs/data_contract.md`; aquí solo se dice dónde vive cada cosa.

## 1. Las dos mitades

El proyecto tiene dos programas que no se llaman entre sí. Se pasan archivos.

| | App web (`web/`) | Paquete Python (`src/sportsan/`) |
|---|---|---|
| Para qué | Todo lo que haces a mano: etiquetar, marcar tramos, calibrar, corregir tracks, ver análisis | Lo pesado sobre el video: cortar, calibrar cuadro a cuadro, detectar jugadoras, bajar sesiones de Strava |
| Cómo se usa | En el navegador, `http://localhost:3000` | Comandos en la terminal |
| Dónde guarda | En el navegador (`localStorage`); sale con Datos → Exportar respaldo | Archivos en `matches/<partido>/` y `data/` |
| Lenguaje | TypeScript (Next.js + React) | Python |

Lo que cruza de un lado al otro:

```
app web ──► segments.csv, anchors_*.json, colores (match.yaml) ──► Python
Python  ──► calib_*.json, tracks_*.json, data/strava/sessions.csv ──► app web
```

## 2. Desde dónde se corre cada comando

Hay dos carpetas de trabajo. Casi todos los errores de "no encuentra el módulo" vienen de estar en la equivocada.

**Comandos de Python (`python -m sportsan...`): desde la raíz del repo**, la carpeta `demo/`, con el entorno activado:

```powershell
cd "C:\Users\joana\College\Sports Analytics\demo"
.venv\Scripts\Activate.ps1          # el prompt pasa a empezar con (.venv)
python -m sportsan.tracking.process --benchmark
```

**Comandos de la app (`npm ...`): desde `demo/web/`:**

```powershell
cd "C:\Users\joana\College\Sports Analytics\demo\web"
npm run dev
```

| Comando | Carpeta | Qué hace |
|---|---|---|
| `python -m pytest` | `demo/` | Tests de Python |
| `python -m yt_dlp ...` | `demo/` | Descarga un video (línea completa en la sección 9) |
| `python -m sportsan.ingest.cut_segments` | `demo/` | Corta los tramos de juego en clips |
| `python -m sportsan.ingest.strava_sync auth / sync` | `demo/` | Autoriza Strava / baja sesiones |
| `python -m sportsan.tracking.propagate --anchors ...` | `demo/` | Calibración entre anclas de un tramo. Acepta la ruta completa o solo el nombre `anchors_<partido>_<video>.json` (lo busca en `matches/*/tracking/`) |
| `python -m sportsan.tracking.library build / locate` | `demo/` | Biblioteca de calibración |
| `python -m sportsan.tracking.process` | `demo/` | Detección + calibración de un video |
| `npm run dev` | `demo/web/` | Abre la app |
| `npm test`, `npx eslint .`, `npm run build` | `demo/web/` | Verificación de la app |

Los comandos de Python eligen el partido así: `--match <id>` si lo pasas; si no, la variable de entorno `SPORTSAN_MATCH`; si no, `default_match` de `config/project.yaml`.

## 3. Carpetas de la raíz

| Carpeta o archivo | Qué es | ¿Entra a git? |
|---|---|---|
| `web/` | La app (sección 5) | sí |
| `src/sportsan/` | El paquete Python (sección 6) | sí |
| `tests/` | Tests de Python, uno por módulo (`test_<módulo>.py`) | sí |
| `matches/<match_id>/` | Un partido: su configuración y sus archivos (sección 4) | solo `match.yaml` y `segments.csv` |
| `matches/videos.csv` | Registro de todos los videos (partido, qué parte es, enlace) | sí |
| `config/project.yaml` | Partido por defecto y medidas de la cancha normalizada (105 x 68) | sí |
| `config/strava.local.json` | Credenciales de Strava; lo crea `strava_sync auth` | **no** |
| `config/roster.json` | Plantilla (nombres y números); la lee y escribe la app | **no** |
| `data/strava/` | Sesiones bajadas de Strava | **no** |
| `data/mock/` | Datos falsos que genera `python -m sportsan.mock.generate` | no |
| `docs/` | Documentación (sección 8) | sí |
| `weights/` | Pesos del detector (`yolo11n`), se descargan | no |
| `notebooks/tracking_test.ipynb` | Cuaderno del pipeline antiguo en Colab; ya no se usa | sí |
| `app/` | Primera interfaz en Streamlit; referencia, no se desarrolla | sí |
| `Sports analytics dashboard mockup/` | Propuesta de diseño que sigue la app | no |
| `.venv/` | Entorno de Python de esta computadora | no |
| `pyproject.toml` | Dependencias de Python por grupos: `dev`, `calib`, `detect`, `tracking` (antiguo) | sí |
| `CLAUDE.md`, `.claude/agents/` | Instrucciones y agentes para Claude; locales | no |

## 4. La carpeta de un partido

```
matches/partido_2026_09_25/
  match.yaml          equipos, sede y medidas, lista de videos (id de YouTube, archivo, fps, colores de uniforme)
  segments.csv        tramos del video (juego / pausa / no medible). Se exporta desde la app, pestaña Tramos.
                      HOY NO EXISTE en este partido: hay que exportarlo y guardarlo aquí.
  video/v1.mp4        video descargado (primer tiempo). v2.mp4 será el segundo.
  segments/           clips que corta cut_segments (opcional)
  events/             reservado para eventos en parquet; hoy vacío (los eventos viven en la app)
  tracking/           todo lo que produce el tracking:
    calib_v1_<ini>_<fin>.json      calibración cuadro a cuadro de un tramo (propagate o library locate)
    library_v1.npz                 biblioteca de calibración del video (library build). No borrar.
    tracks_v1_<ini>_<fin>.json     una parte procesada (1 minuto): cajas, posiciones, equipos, identidades propuestas
    tracking_v1_<ini>_<fin>.parquet  lo mismo en la tabla del contrato (solo personas dentro de la cancha)
    tracks_v1_index.json           lista de partes hechas con sus indicadores
```

`<ini>` y `<fin>` son números de cuadro del video. Para pasar a tiempo: cuadro / 29.97. Ejemplo: 59940 = 33:20.

Archivos que tú produces desde la app y conviene guardar en `tracking/` aunque el programa no lo exija: `anchors_*.json` (anclas de Calibración) y `tracks_fixed_*.json` (lo corregido).

## 5. La app web (`web/`)

Cuando la app corre en esta computadora (`npm run dev`) lee y escribe los archivos de la carpeta de cada partido por
`web/app/api/local/` (acceso en `web/lib/local.ts`): abre sola el video, lista las partes de tracking para elegirlas, guarda
`segments.csv`, los colores en `match.yaml`, las anclas y lo corregido en `tracking/`, y la plantilla en `config/roster.json`.
Para eso el partido necesita su carpeta (pestaña Calibración o «editar datos»). Desplegada en internet no hay carpeta: se
vuelve a elegir cada archivo a mano.

### 5.1 Pantallas

Cada pantalla es un archivo `web/app/<ruta>/page.tsx`. El menú lateral está en `web/components/Shell.tsx` (lista `NAV`).

| Menú | Ruta | Archivo | Qué hace |
|---|---|---|---|
| Resumen | `/` | `app/page.tsx` | Portada: últimos partidos y accesos |
| Análisis con video | `/partidos` | `app/partidos/page.tsx` | Todos los videos en tres grupos: nuestros partidos, rivales y videos de referencia; alta de uno nuevo (`components/MatchList.tsx`). `/rivales` redirige aquí |
| (al abrir un partido) | `/partido?id=` | `app/partido/page.tsx` | El partido: video, selector de video y las cinco pestañas (5.2) |
| Jugadoras | `/jugadoras` | `app/jugadoras/page.tsx` | Plantilla (pegar lista, editar números; `components/RosterCard.tsx`) y lo que se sabe de cada jugadora. El perfil sigue bloqueado |
| Sesiones | `/entrenamientos` | `app/entrenamientos/page.tsx` | Importa sesiones por CSV; carga, ACWR, cuestionario |
| Planificación | `/planificacion` | `app/planificacion/page.tsx` | Vista previa bloqueada |
| (dentro del partido) | pestaña Calibración | `components/workspace/Calibration.tsx` | Arriba: pasos, «Video y sede» (diálogo), cargar calibración o detecciones y «Comandos» (diálogo con los comandos de Python para copiar). Izquierda: video y lo cargado. Derecha, con scroll propio y en orden de uso: puntos de la sede, lupa y ajuste fino, ajuste y guardar ancla, anclas guardadas (Exportar las escribe en `tracking/` del partido). Ya no está en el menú; `/calibracion` sigue funcionando |
| (dentro del partido) | pestaña Tracking | `components/workspace/Correction.tsx` | Colores de uniforme, comando de proceso y mesa de corrección (5.4). Ya no está en el menú; `/correccion` sigue funcionando |
| Carga de datos | `/datos` | `app/datos/page.tsx` | Importar y exportar: respaldo completo, eventos, sesiones |
| Configuración | `/configuracion` | `app/configuracion/page.tsx` | Sedes: medidas, rejilla, colores, medición sobre imagen satelital |

`app/layout.tsx` envuelve todas las pantallas (fuentes, menú). `app/globals.css` tiene todo el diseño: colores, tipografías, clases (`.btn`, `.card`, `.input`...) y animaciones.

### 5.2 Pestañas de un partido (`web/components/match/`)

Las pestañas son los pasos del análisis, en orden: Calibración, Tramos, Tracking, Etiquetado, Jugadas, Análisis, Informe. Cada una muestra su estado (verde completo, ámbar a medias, círculo vacío por hacer, punteado opcional) calculado en `web/lib/steps.ts` a partir de los datos del partido y de lo que hay en su carpeta.

| Pestaña | Archivo | Qué hace | Dónde está el cálculo |
|---|---|---|---|
| Tramos | `SegmentsTab.tsx` | Marcas de corte → tramos de juego/pausa; exporta e importa `segments.csv` | `lib/segments.ts` |
| Etiquetado | `TagTab.tsx` | Cuatro pasadas: 1 identificar (teclas, etiqueta sobre el video, aviso de duplicado, `J` = jugada), 2 revisar uno por uno (`ReviewPanel.tsx`), 3 ejecución: destino de tiros en la portería (`GoalFrame.tsx`) y de centros y córners en la cancha; 4 pases (`PassTagger.tsx`): el número de cada jugadora que recibe, en orden, para la red de pases. Bajo el video, línea de tiempo (`VideoTimeline.tsx`) y eventos activos; abajo, la tabla con filtros (`EventsTable.tsx`) | `lib/tagging.ts`; catálogo en `lib/types.ts` |
| Jugadas | `PlaysTab.tsx` | Jugadas y su animación: posiciones medidas si la jugada cae en una parte corregida (`tracks_fixed_*`), si no keyframes a mano | `lib/positions.ts` (`positionsAt`), `lib/stats.ts` (`interpolate`) |
| Análisis | `AnalysisTab.tsx` | Respuestas a las preguntas del cuerpo técnico; «Pases y jugadoras» (`PassesCards.tsx`: red de pases y tabla por jugadora, de los pases etiquetados); con posiciones medidas: forma del bloque (`TeamShape.tsx`), mapa de calor y jugadoras detrás del balón (`PositionsCards.tsx`; partes corregidas y, donde no las hay, las procesadas contadas solo por equipo) | `lib/analysis.ts`, `lib/stats.ts`, `lib/passes.ts`, `lib/positions.ts`, `lib/fixed.ts` |
| Informe | `ReportTab.tsx` | Informe imprimible | los mismos |

### 5.3 Piezas compartidas (`web/components/`)

| Archivo | Qué contiene |
|---|---|
| `Shell.tsx` | Menú lateral plegable, `PageHeader`, `Card`, `Section`, nombres de clases de botón |
| `VideoPlayer.tsx` | Reproductor de YouTube o de archivo local, con la misma interfaz |
| `SpeedControl.tsx` | Botón de velocidad con deslizador (hasta 5x) |
| `Pitch.tsx` | La cancha dibujada (SVG de 105 x 68) y los colores de equipo |
| `charts.tsx` | Todos los gráficos: `StatTile`, `CompareBars`, `ShotMap`, `ZoneMap`, `LineChart`, `EventTimeline`, `MiniBars`, `RateDuo`, `PartsDuo`, `BinChart`, `AcwrChart` |
| `Locked.tsx` | Marco para lo que aún no funciona, con su motivo (falta de datos / en desarrollo / requiere tracking) |
| `motion.tsx` | Aparición al hacer scroll (`Reveal`) y cifras que cuentan (`CountUp`) |
| `VenueEditor.tsx` | Editor de sedes |
| `MatchList.tsx` | Lista de partidos y alta de uno nuevo |
| `LocalPick.tsx` | `FilePicker`: un botón con menú para abrir un archivo de la carpeta del partido (se relee al abrirlo) o «Otro archivo…» de cualquier sitio; `partLabel` |
| `BallStrip.tsx` | Barra de dónde hay balón para animar en un tramo (posición conocida o trazada entre marcas, marcas a mano y de eventos); bajo el video de la mesa y bajo la animación de Jugadas |
| `Command.tsx` | `Command` (comando de terminal con botón de copiar) y `CopyButton` (copia y muestra una palomita) |
| `Modal.tsx` | `Modal` (diálogo que se cierra con Esc o clic fuera) e `IconButton` (botón de solo icono; el texto va en el título) |

### 5.4 La mesa de corrección, por zonas

Todo está en `components/workspace/Correction.tsx` (pestaña Tracking del partido); la lógica, en `lib/tracks.ts`, `lib/parts.ts` y `lib/smooth.ts`.

| Zona de la pantalla | Qué hace | Función principal |
|---|---|---|
| Encabezado | Vista Jugadoras / Balón; botones Uniformes y Exportar… (abren un diálogo) y Guardar | |
| Guardar | Escribe `tracks_fixed_*.json` y `labels_*.json` en `matches/<id>/tracking/`; solo si no puede, los descarga | `buildLabels` |
| Video con cajas | Clic en una caja la selecciona; modos unir (`u`), marcar a mano (`p`), marcar balón (`b`). Zoom que sigue a la seleccionada (`z`: ×1, ×2, ×3; se recuerda en el navegador). La candidata que se está revisando sale con recuadro amarillo punteado y una barra debajo: Unir (Enter), No (X), otra vez (R), cerrar (Esc) | `identityOf`, `setManual`, `setBall` |
| Bajo el video: la seleccionada | Su fila (nombre, equipo, completa), herramientas con atajo (`g` hueco por revisar, a 1 s de donde se perdió y 1 s más cada vez; `c` siguiente cambio de camiseta; `d` siguiente cuadro con dos cajas; `v` verificada; `u` unir, `s` partir aquí y seguir con el segundo tramo, `Shift S` partir y quedarse en el primero, `p` marcar a mano, `Supr` no es jugadora, `Esc` soltar), su línea de presencia (arrastrar elige un rango para quitar, separar o partir) y avisos en fichas: candidatas (`n` ver la siguiente; ojo / ✓ / ✗), cambios de camiseta (ojo / tijera), trozos cortos suyos, dos cajas a la vez y huecos por revisar: en medio de la imagen y de más de 2 s o imposibles (`g` siguiente; rojo en la línea, ficha verde cuando no queda ninguno); los de fuera de cuadro, en gris, no cuentan (`offCamera`: estaba en el borde de la imagen al perderla o al encontrarla) | `personTimeline`, `dropRange`, `separateRange`, `merge`, `candidatesFor`, `applyHint`, `splitPerson`, `suggestAbsorb` |
| Lista de personas (título: verificadas, huecos por revisar y cuántas hay; cada fila con fichas de huecos por revisar y dos cajas que llevan al primero; con el filtro Árbitras o Sin equipo, «Descartar las N que se ven»; `v` verifica y salta a la siguiente con trabajo pendiente, primero las nuestras con nombre; por defecto solo las que tienen nombre; con una seleccionada, arriba sus candidatas y los trozos sin nombre de su equipo vistos en sus huecos; scroll propio; su ancho se arrastra en la línea que la separa del video, doble clic la deja como estaba) | Nombre (= identidad), equipo, completa, filtros (incluido «solo con cambio de camiseta»); dibuja 80 filas y «Mostrar más» | `people`, `setPerson` |
| Diálogo Limpieza rápida | Trozos de menos de 1 s: añadir a su jugadora o descartar | `duplicatesAmong`, `suggestAbsorb`, `applyAbsorb` |
| En la cancha | Posiciones del cuadro, rastro de la seleccionada, balón | `measuredPaths`, `ballPath` |
| Diálogo Uniformes | Colores por equipo y porteras; escribe en `match.yaml` | `teamOfColor`, `kitOfColor` |
| Vista Balón | Barra compacta junto al video (revisado %, «No se ve / fuera» con `Enter`, paso 0.5/1/2 s, cajas con `h`, engrane para el balón desde eventos) y «En la cancha» al lado; clic en el balón marca y avanza; `→` un paso, `Alt →` un cuadro, `Tab` dos pasos (`Mayús` + `Tab` atrás), `Supr` quita la marca, `n` va a donde falta, `i` traza una recta a mano desde la última marca hasta el siguiente clic (pases largos, balones por alto). No se seleccionan jugadoras. La barra del balón cuenta el % del tiempo en juego: lo marcado como fuera no falta | `manualBall`, `eventBall`, `setBall`, `BallStrip` |
| Estado de la parte | En el encabezado y en el menú de partes: «completa» con al menos 10 jugadoras verificadas en la mesa (con nombre y ✓; pueden ser más por los cambios; en verde desde 10) y balón en el 95 % del tiempo en juego. Es la misma medida que la barra del balón (`ballCoverage`: marcas, rectas de hasta 3 s y eventos; lo marcado «fuera / no se ve» no cuenta). En la vista Balón, `n` lleva al siguiente tramo en juego sin balón (rojo en la barra). Los avisos se quitan solos a los 6 s. Al completarse (con la revisión rápida ya aplicada) se descartan las personas sin nombre de nuestro equipo, las rivales de menos de 1 s, árbitras y sin equipo. «Restablecer…»: solo la mesa, o todo | `partStatus`, `leftovers` (`lib/quick.ts`), `ballCoverage` (`lib/parts.ts`) |
| Vista Revisión rápida | Por jugadora (por defecto): eliges una, la señalas y la app solo se detiene donde pudo cambiarse de persona (tras un cruce con alguien de su equipo o uno largo con una rival, al reaparecer, donde el modelo le pasó el nombre); `Enter` es ella, `X` no, clic en otra caja = es esa, `←` `→` 1 s para buscarla, `Tab` siguiente jugadora. Por muestras: un cuadro cada 3 s: el número de cada caja resaltada (se elige sola la siguiente), `Enter` confirma lo que propone el modelo y pasa a la siguiente muestra, `−` = nadie, `Supr` quita; «Aplicar a la mesa» convierte el resultado en cortes, uniones y nombres (Ctrl+Z lo deshace); si ya hay jugadoras verificadas pregunta: «Agregar lo nuevo» (`applyQuickOnto`: las verificadas no se tocan y se conservan las correcciones) o «Todo desde cero» y rellena huecos de hasta 3 s al guardar | `quickModel`, `applyQuick` |
| Diálogo Exportar | Suavizado y unir varias partes del mismo video en un archivo | `smoothTrack`, `joinParts` |

El archivo `tracks_*.json` nunca se modifica. Tus correcciones se guardan aparte (en el navegador, por parte) y se aplican encima; por eso todo se puede deshacer.

### 5.5 Lógica sin pantalla (`web/lib/`)

Son funciones puras con test al lado (`<nombre>.test.mjs`). Si un número de la app te parece mal, el cálculo está aquí.

| Archivo | Qué resuelve | Constantes que quizá quieras ajustar |
|---|---|---|
| `types.ts` | Forma de todos los datos de la app y catálogo de eventos (`EVENT_TYPES`, `EVENT_OUTCOMES`, `EVENT_DETAILS`, teclas) | el catálogo (también hay que tocar `schema.py` y el contrato) |
| `store.ts` | Único acceso a los datos guardados (`useStore`, `mutate`) y preferencias de interfaz (`usePref`) | |
| `analysis.ts` | Transiciones, tiros, carriles, entradas al área, balón parado, tramos de 5/10 min | `SHOT_WINDOW_S` (15), `COUNTERPRESS_WINDOW_S` (8) |
| `stats.ts` | Conteos por tipo, zonas, interpolación de jugadas | |
| `load.ts` | Carga de sesión (RPE x minutos), ACWR, escalas del cuestionario | `ACUTE_DAYS` (7), `CHRONIC_DAYS` (28), `SAFE_ACWR` (0.8–1.3) |
| `segments.ts` | Marcas → tramos → `segments.csv`; qué saltar al etiquetar (`skipTarget`) | |
| `roster.ts` | Plantilla: leer una lista pegada, números provisionales, números repetidos | `UNKNOWN_FROM` (99) |
| `tagging.ts` | Reglas de las tres pasadas: duplicados, eventos activos, qué falta en cada pasada, filtros | `DUPLICATE_S` (3), `ACTIVE_S` (2) |
| `videos.ts` | Varios videos por partido y su línea de tiempo común | `VIDEO_GAP_S` (120) |
| `homography.ts` | Homografía a partir de anclas (imagen → metros de la sede) | |
| `venue.ts` | Modelo de cada sede: líneas y puntos de referencia | `BUILTIN_SPECS` (sedes incluidas) |
| `tracks.ts` | Correcciones de tracks: identidad, unir, partir, descartar, duplicados, trozos cortos, colores | `SAME_PLAYER_M` (2), `ABSORB_SPEED_MS` (8), `ABSORB_GAP_S` (2), `MAX_COLOR_DISTANCE` (40) |
| `suggestions.ts` | Con quién podría seguir o de quién podría venir una persona (candidatas en el panel de la seleccionada); quitar o separar un tramo de su línea | `MAX_GAP_S` (3), `RUN_MS` (8) |
| `cuts.ts` | Dónde una persona de la mesa es probablemente dos: cambios de camiseta sostenidos (para cortar) y saltos imposibles de posición | `TEAM_RUN` (10), `JUMP_SPEED_MS` (9) |
| `labels.ts` | Las correcciones de una parte como etiquetas (`labels_*.json`), sin nombres | |
| `parts.ts` | Trayectorias medidas, balón, unión de varias partes | `BALL_FILL_S` (3), `LINK_EDGE_S` (0.5), `LINK_SLACK_M` (2), `LINK_SPEED_MS` (8) |
| `smooth.ts` | Limpieza de trayectorias al exportar | `SMOOTH_DEFAULTS` (9 m/s, 2 s, 0.5 s) |
| `quick.ts` | Revisión rápida: nombres dados en cuadros de muestra (uno cada 3 s) que se extienden a toda la parte; corta en el cruce más probable cuando un track recibe dos nombres o no se confirmó en una muestra, une por nombre y pasa el nombre a trozos que nacen justo donde acabó otro | `SAMPLE_S` (3) |
| `passes.ts` | Pases etiquetados a mano: cadena de toques → pases, estadística por jugadora, red de pases (posición media de los eventos de cada una) | |
| `positions.ts` | Sobre las partes corregidas: dirección de ataque deducida, mapa de calor, quién tiene el balón, pases y pérdidas leídos del balón, jugadoras detrás del balón, posiciones de un instante | `POSSESS_M` (2), `PASS_MAX_S` (5), `ATTACK_MIN_DIFF_M` (4) |
| `fixed.ts` | Carga las `tracks_fixed_*.json` de la carpeta del partido y las orienta (la dirección dicha en la mesa o la deducida); no es pura | |
| `format.ts` | Tiempos, CSV, descarga de archivos | |
| `demo.ts` | Datos de ejemplo (siempre rotulados como ejemplo) | |

### 5.6 Dónde guarda la app

Todo en el `localStorage` del navegador, en la clave `sportsan:v1`, con esta forma (`State` en `lib/types.ts`):

| Campo | Qué guarda | Se llena en |
|---|---|---|
| `matches` | Partidos (nombre, equipos, videos, informe) | Rivales / Nuestros partidos |
| `events` | Eventos etiquetados | pestaña Video y etiquetado |
| `plays` | Jugadas con keyframes | pestaña Jugadas |
| `segments` | Marcas de tramo | pestaña Tramos |
| `sessions` | Sesiones de entrenamiento | Sesiones (CSV) |
| `anchors` | Anclas de calibración | Calibración |
| `venues` | Sedes editadas | Configuración |
| `trackEdits` | Correcciones de cada parte de tracking | Corrección de tracks |
| `jerseys` | Colores de uniforme por partido | Corrección de tracks |

Consecuencias: otro navegador u otra computadora empiezan vacíos; borrar los datos del sitio borra todo. El respaldo es Datos → Exportar respaldo. Las preferencias de interfaz (menú plegado, hacia dónde ataca el equipo) van aparte, en `sportsan:ui`, y no entran al respaldo.

## 6. El paquete Python (`src/sportsan/`)

| Archivo | Qué hace | ¿Se corre como comando? |
|---|---|---|
| `config.py` | `load_config(match=, video=)`: une `config/project.yaml` con el `match.yaml` y resuelve rutas | no |
| `schema.py` | Columnas del contrato y validadores (`validate_tracking`, `validate_ball`, `validate_events`) | no |
| `timebase.py` | Tiempos: `parse_hms`, `load_segments`, cuadro → segundo | no |
| `io.py` | Lee parquets validando | no |
| `ingest/cut_segments.py` | Corta con ffmpeg los tramos `juego` de `segments.csv` | sí |
| `ingest/strava_sync.py` | Autoriza Strava y baja sesiones (resumen y esfuerzo relativo de todas, series de las de fútbol) a `data/strava/` | sí |
| `ingest/download_videos.py` | Baja los videos de `matches/videos.csv` que falten (YouTube o cualquier enlace que acepte yt-dlp, como Facebook) y los añade a su `match.yaml` | sí |
| `ingest/rename_match.py` | Renombra la carpeta de un partido según la convención, y su `match_id` en los archivos | sí |
| `tracking/propagate.py` | Lleva la calibración de unas anclas a todos los cuadros entre ellas (movimiento de cámara) | sí |
| `tracking/library.py` | Biblioteca de calibración: de un barrido calibrado, ubica cualquier otro cuadro del video | sí (`build`, `locate`) |
| `tracking/detect.py` | Detector (YOLO11n con OpenVINO) y seguidor (BoT-SORT); color de camiseta; planifica las partes | sí (solo cajas) |
| `tracking/process.py` | **El que se usa**: detección + calibración en una pasada, posiciones, equipos, identidades, archivos de salida | sí |
| `tracking/stitch.py` | Une fragmentos de track sobre la cancha (propuesta de identidad) | no |
| `tracking/team.py` | Equipo por color de camiseta: luminosidad completa, decisión con margen y votación por track | no |
| `tracking/restitch.py` | Vuelve a unir las cajas de una parte ya procesada sin detectar de nuevo (método `legacy` de la evaluación) | no |
| `tracking/overnight.py` | Todo el tracking pendiente de una vez: propagación, biblioteca y process de cada video de `videos.csv` que tenga tramos y anclas (`--plan` para ver qué haría) | sí |
| `tracking/evaluate.py` | Mide cuánto trabajo de corrección deja cada método de unión, contra las etiquetas exportadas de la mesa (`labels_*.json`); `remap` pasa etiquetas a otra corrida de las mismas cajas; `fixture` recorta ejemplos para tests | sí |
| `tracking/botsort_pitch.yaml` | Parámetros del seguidor | no |
| `tracking/geometry.py`, `models.py`, `pipeline.py`, `run_tracking.py` | Pipeline antiguo (Colab, homografía automática). No se usa | no |
| `metrics/team_shape.py` | `team_shape`, `heatmap` sobre la tabla de tracking | no |
| `metrics/team_blocks.py` | Forma de cada equipo por cuadro y por tramos de juego: ancho, largo, altura de línea y bloque | no |
| `metrics/report.py` | Escribe `team_metrics_<video>.json` para la pestaña Análisis | sí |
| `mock/generate.py` | Datos falsos para probar | sí |

Constantes del tracking que quizá quieras ajustar: en `stitch.py`, `MAX_GAP_S` (3), `MAX_OFFSCREEN_S` (10), `MAX_SPEED_MS` (8), `DUPLICATE_M` (1.2), `MIN_LINK_S` (1: un fragmento más corto no se une), `IMMEDIATE_MAX_COLOR` (50); en `team.py`, `MAX_COLOR_DISTANCE` (40), `TEAM_MARGIN` (1.3), `MIN_VOTES` (5), `MIN_SHARE` (0.7); en `botsort_pitch.yaml`, `new_track_thresh` (0.3) y `track_buffer` (90); en `match.yaml`, `analysis_stride` (3 = 1 de cada 3 cuadros).

## 7. Flujos completos, paso a paso

### 7.1 Etiquetar un partido (no necesita tracking)

1. App → Análisis con video → Nuevo video (nuestro, rival o referencia) con el enlace de YouTube.
2. Pestaña Tramos (`G` juego, `P` pausa, `X` no medible, `E` fin) → Exportar `segments.csv` → guardarlo en `matches/<id>/`.
3. Pestaña Etiquetado, pasada 1: tipo y equipo con teclas mientras corre el video (las pausas se saltan solas). `J` guarda el momento como jugada.
4. Pasada 2: uno por uno, posición, jugadora, resultado, detalle y nota. `Enter` pasa al siguiente.
5. Pasada 3: tiros sobre la portería, centros y córners donde cayeron.
6. Pestañas Análisis e Informe: se llenan solas.

### 7.2 De video a posiciones

1. Descargar el video a `matches/<id>/video/v1.mp4` (sección 9).
2. App → Corrección de tracks → Uniformes: elegir los colores sobre el video → Escribir en `match.yaml`.
3. App → Calibración: marcar anclas en un barrido de lado a lado → exportar `anchors_*.json`.
4. `python -m sportsan.tracking.propagate --anchors <archivo>` → escribe `calib_*.json` del barrido.
5. `python -m sportsan.tracking.library build --track <ese calib>` → escribe `library_v1.npz`. Se hace una vez por video.
6. `python -m sportsan.tracking.process --benchmark` para ver cuánto tardará, y luego sin `--benchmark`. Sin `--start/--end` procesa los tramos `juego` de `segments.csv`, una parte por tramo, con una barra de progreso. Es reanudable por partes; `--force` rehace partes (y descoloca las correcciones que ya tengan).
7. `python -m sportsan.metrics.report --own-attacks right` (o `left`): forma de los equipos para Análisis.
8. App → partido → Calibración → «De la carpeta» → una parte, para comprobar que la cancha calza.

### 7.3 Corregir y exportar

1. App → Corrección de tracks → abrir `video/v1.mp4` y un `tracks_v1_<ini>_<fin>.json`.
2. Limpieza rápida: "Añadir los N a su jugadora", luego "Descartar los N duplicados".
3. Nombrar a quienes importan en la jugada; unir, partir, marcar a mano donde se pierden.
4. Balón: modo `b` y clic al salir y al llegar cada pase; o elegir el partido de la app y hacia dónde ataca el equipo para usar los eventos.
5. "Guardar" (esta parte: `tracks_fixed_*.json` y `labels_*.json` en la carpeta del partido) o, en "Exportar…", unir las demás partes del tramo en un archivo. Marca como completas (✓) a las personas ya revisadas: solo esas cuentan al medir.

### 7.4 Sesiones de Strava

1. Una vez: crear la aplicación en `strava.com/settings/api` con "Authorization Callback Domain" = `localhost`.
2. Una vez: `python -m sportsan.ingest.strava_sync auth --client-id <id> --client-secret <secreto>`.
3. Primera descarga: `python -m sportsan.ingest.strava_sync sync --after 2026-08-01`.
4. Después: `python -m sportsan.ingest.strava_sync sync` baja solo lo nuevo.
5. App → Sesiones → importar `data/strava/sessions.csv`.

## 8. Documentación (`docs/`)

| Archivo | Para qué abrirlo |
|---|---|
| `mapa_del_repo.md` | Este mapa |
| `data_contract.md` | Formato exacto de cada tabla y archivo. Fuente de verdad |
| `architecture.md` | Qué es el producto, flujo general, decisiones ya tomadas, plan de base de datos |
| `roadmap.md` | Orden de trabajo y todas las mediciones hechas (errores de calibración, tiempos, conteos) |
| `preguntas_cuerpo_tecnico.md` | Las 22 preguntas, el catálogo de eventos y los cuestionarios |
| `propuesta_investigacion.md` | Propuesta de investigación |
| `referencias.md` | Fuentes |
| `parallel_workflow.md` | Cómo usar varios agentes de Claude a la vez |

## 9. Recetas

**Descargar un video** (desde `demo/`):

```
python -m yt_dlp --compat-options no-certifi --js-runtimes node --remote-components ejs:github -f 137 -o "matches/<match_id>/video/v1.%(ext)s" <url>
```

**Quiero cambiar...**

| Qué | Dónde |
|---|---|
| Un texto o el diseño de una pantalla | su `page.tsx` (5.1) o su pestaña (5.2) |
| Colores, tipografías, forma de botones y tarjetas | `web/app/globals.css` |
| El menú lateral | `NAV` en `web/components/Shell.tsx` |
| Tipos de evento, resultados o teclas | `web/lib/types.ts` + `src/sportsan/schema.py` + `docs/data_contract.md` (los tres a la vez) |
| Cómo se calcula una cifra de Análisis | `web/lib/analysis.ts` |
| Umbrales de carga y ACWR | `web/lib/load.ts` |
| Medidas o marcas de una sede | App → Configuración (o `BUILTIN_SPECS` en `web/lib/venue.ts`) |
| Colores de uniforme | App → Corrección de tracks → Uniformes, o `jersey_colors` en `match.yaml` |
| Cuántos cuadros se procesan | `analysis_stride` en `match.yaml`, o `--stride` |
| Qué partido usan los comandos | `default_match` en `config/project.yaml`, o `--match` |
| Reglas para unir trozos en la mesa | constantes de `web/lib/tracks.ts` (5.5) |
| Reglas del suavizado | la tarjeta "Suavizado al exportar", o `SMOOTH_DEFAULTS` en `web/lib/smooth.ts` |
| Añadir el segundo tiempo | descomentar `v2` en `match.yaml`, bajar el video, añadir el video en el partido de la app |

**Algo no funciona**

| Síntoma | Causa habitual |
|---|---|
| `No module named sportsan` | No estás en `demo/` o falta activar `.venv` |
| `npm` no encuentra `package.json` | No estás en `demo/web/` |
| La app aparece vacía | Otro navegador o perfil: los datos viven en cada navegador. Importa tu respaldo |
| `process` dice que falta la biblioteca | No existe `library_<video>.npz`: pasos 3 a 5 de 7.2 |
| `process` no sabe qué procesar | Falta `segments.csv` en la carpeta del partido; o pasa `--start` y `--end` |
| Falla la descarga de pesos o de git | Certificados de esta computadora: usar `C:\Windows\System32\curl.exe -L` y `git -c http.sslBackend=schannel` |
| Las correcciones siguen ahí tras recargar | Es lo esperado: se quitan con "Restablecer esta parte" |
