# Mapa del repositorio

Para ubicarte: qué hay en cada carpeta, qué hace cada archivo, dónde se guarda cada dato, qué tocar para cambiar cada cosa
y **por qué está hecho así**. Actualizado el 2026-10-18.

- El formato exacto de cada tabla y archivo está en `docs/data_contract.md` (la fuente de verdad); aquí solo se dice dónde vive
  cada cosa y para qué sirve.
- El recorrido completo de un partido, de la descarga al informe, con su diagrama: `docs/guia_analisis.html` (ábrelo en el
  navegador). La sección 7 de este mapa es el mismo recorrido en texto.

## 0. Por qué está hecho así

Las decisiones de fondo, con su motivo. Si alguna deja de tener sentido, se cambia aquí y en `docs/architecture.md`.

| Decisión | Por qué |
|---|---|
| **Dos programas que se pasan archivos**: la app (`web/`) y el paquete Python (`src/sportsan/`) | Lo que se hace a mano (etiquetar, corregir, dibujar) necesita una interfaz rápida en el navegador; lo pesado sobre el video (detectar, calibrar cuadro a cuadro, exportar MP4) necesita OpenCV y modelos en la laptop. Se comunican solo por archivos con formato fijo (el contrato), así uno puede cambiar sin romper al otro |
| **Sin servidor ni cuentas**: los datos de la app viven en el navegador (`localStorage`) | Gratis y sin configurar nada para el MVP. El costo: cada navegador tiene sus datos y el respaldo es manual (Datos → Exportar respaldo). La base de datos compartida es la fase 2 de `architecture.md` |
| **Un partido, una carpeta** (`matches/<id>/`), con uno o varios videos | Todo lo de un partido junto (video, calibración, tracking, ediciones) y los comandos solo necesitan `--match`. Un tiempo puede venir en varias partes de video |
| **El video original nunca se edita ni se concatena** | Todos los tiempos (eventos, jugadas, tracks) son `t_video` del archivo original: si se recortara, dejarían de coincidir |
| **Cancha normalizada de 105 x 68** y medidas reales en `match.yaml` | Las posiciones de sedes distintas se pueden comparar y dibujar igual; las distancias y velocidades se calculan en metros reales con la medida de la sede |
| **Calibración por anclas marcadas a mano + biblioteca** | En canchas con líneas de varios deportes (americano y fútbol) el detector automático de puntos de cancha falló. Se calibra a mano un barrido de cámara y la biblioteca ubica cualquier otro cuadro comparándolo con ese barrido |
| **`tracks_*.json` nunca se modifica**: las correcciones van aparte y se aplican encima | Todo se puede deshacer y una parte se puede volver a corregir; las etiquetas (`labels_*.json`) sirven para medir si un cambio del tracking deja menos trabajo |
| **Lo automático solo marca cuando está muy seguro** (revisión rápida, tracker de balón) y pide el resto | Un error silencioso (un nombre o un balón falso) contamina el análisis sin que se note; un hueco se ve y se completa. Por la misma razón, si un dato no se puede calcular es `NaN` / vacío, nunca un relleno inventado |
| **La app sirve completa solo con eventos etiquetados** | El tracking es una capa extra: tarda y no siempre sale bien (cámaras que no ven toda la cancha). Lo que no se ve en cuadro no está ausente, solo no se ve |
| **El informe va por niveles** (N1 eventos … N4 tracking con nombres) | Cada sección pide su fuente y, sin ella, dice qué le falta en vez de mostrar una cifra débil |
| **Dibujos en metros de la cancha, no en píxeles** | El mismo dibujo sirve en el pizarrón (vista desde arriba) y sobre el video (proyectado en perspectiva con la calibración de cada cuadro). La app y Python proyectan igual: lo comprueba `tests/fixtures/projection_cases.json` |
| **Nombres de jugadoras fuera de git** (plantilla, ediciones, informes, clips) | El repositorio puede compartirse; los datos personales se quedan en la laptop |
| **Solo herramientas gratuitas** | Requisito del proyecto: todo gratis salvo la suscripción de Claude |

## 1. Las dos mitades

| | App web (`web/`) | Paquete Python (`src/sportsan/`) |
|---|---|---|
| Para qué | Todo lo que haces a mano: tramos, calibración, etiquetado, corrección de tracks, jugadas, pizarrón, clips, análisis, informe | Lo pesado: descargar, calibrar cuadro a cuadro, detectar jugadoras, tracker de balón, exportar MP4, Strava |
| Cómo se usa | En el navegador, `http://localhost:3000` | Comandos en la terminal |
| Dónde guarda | En el navegador (`localStorage`) y, cuando corre en esta laptop, en la carpeta del partido | Archivos en `matches/<partido>/`, `data/`, `weights/` y `clips/` |
| Lenguaje | TypeScript (Next.js + React) | Python |

Lo que cruza de un lado al otro:

```
app web ──► segments.csv, anchors_*.json, colores (match.yaml), tracks_fixed_*.json, edit_*.json, clips_*.json, board_*.json ──► Python
Python  ──► calib_*.json, library_*.npz, tracks_*.json, ball_auto_*.json, team_metrics_*.json, MP4, data/strava/sessions.csv ──► app web
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
| `python -m sportsan.ingest.download_videos [--list] [--match <id>]` | `demo/` | Baja los videos de `matches/videos.csv` que falten y los añade a su `match.yaml` (crea la carpeta si el partido es nuevo) |
| `python -m yt_dlp ...` | `demo/` | Descarga a mano un video (línea completa en la sección 9) |
| `python -m sportsan.ingest.rename_match <viejo> <nuevo>` | `demo/` | Renombra la carpeta de un partido según la convención |
| `python -m sportsan.ingest.cut_segments` | `demo/` | Corta los tramos de juego en clips (opcional) |
| `python -m sportsan.ingest.strava_sync auth / sync` | `demo/` | Autoriza Strava / baja sesiones |
| `python -m sportsan.tracking.overnight [--plan] [--match <id>]` | `demo/` | **Todo el tracking pendiente de una vez**: propagación de las anclas, biblioteca y `process` de cada video con tramos y anclas. `--plan` dice qué haría y cuánto tardaría |
| `python -m sportsan.tracking.library check --match <id>` | `demo/` | Antes de procesar: 8 tramos de 10 s repartidos por los tramos de juego, ubicados con la biblioteca; tabla (bien / REVISAR) y sus `calib_` en `tracking/revision/` para cargarlos en Calibración › Verificar |
| `python -m sportsan.tracking.propagate --anchors ...` | `demo/` | Calibración entre anclas de un tramo. Acepta la ruta completa o solo el nombre `anchors_<partido>_<video>.json` (lo busca en `matches/*/tracking/`) |
| `python -m sportsan.tracking.library build / locate` | `demo/` | Biblioteca de calibración |
| `python -m sportsan.tracking.process` | `demo/` | Detección + calibración de un video. Con cámara amplia: `detector: {model, tiles, band: auto}` en `match.yaml` (o `--model`, `--tiles`, `--band`) detecta solo en la franja de la cancha y por trozos |
| `python -m sportsan.cloud.kaggle login --user <u>` / `run tracking --match <id> [--dry-run]` / `status` / `pull` | `demo/` | El tracking (lo de `overnight`) en una GPU de Kaggle: sube código, datos y videos (privados; cada video una vez), corre, espera y baja solo lo nuevo a `tracking/` sin pisar lo tuyo. Necesita `pip install -e ".[cloud]"` |
| `python -m sportsan.tracking.ball train` / `run --match <id>` / `eval` | `demo/` | Tracker de balón: entrena con las marcas a mano guardadas (`tracks_fixed_*`) y marca solo lo seguro en cada parte (`ball_auto_*.json`); la vista Balón de la mesa lo usa y pide el resto. `--accept` cambia el umbral (0.90) |
| `python -m sportsan.metrics.report --match <id> --own-attacks right` | `demo/` | Forma de los equipos para Análisis (`team_metrics_*.json`) |
| `python -m sportsan.clips.render --edit <edit_*.json> --profile charla\|whatsapp` | `demo/` | Exporta a MP4 un clip con sus dibujos y pausas (en `matches/<id>/clips/`). Con `--board <id>`, una jugada del pizarrón (en `clips/`). Necesita `pip install -e ".[clips]"` y ffmpeg |
| `python -m sportsan.clips.cut_clips [--match <carpeta>] [--profile ...]` | `demo/` | Corta los clips de `clips_<match_id>.json` (los editados salen con sus dibujos) en `matches/<id>/clips/` |
| `npm run dev` | `demo/web/` | Abre la app |
| `python -m sportsan.tracking.process --match <id> --video v1 --test` | `demo/` | Prueba de 30 s antes de procesar: `tracking/prueba/` y su `summary.json` (también es el botón «Probar 30 s» de Tracking) |
| `npm test`, `npx eslint .`, `npm run build` | `demo/web/` | Verificación de la app |

Los comandos de Python eligen el partido así: `--match <id>` si lo pasas; si no, la variable de entorno `SPORTSAN_MATCH`; si no,
`default_match` de `config/project.yaml`.

**Ojo con correr dos cosas pesadas a la vez** (`process`, `overnight`, `ball train/run`, `clips.render`): se reparten los núcleos
de la laptop y todas van varias veces más lento. Mejor una detrás de otra.

## 3. Carpetas de la raíz

| Carpeta o archivo | Qué es | ¿Entra a git? |
|---|---|---|
| `web/` | La app (sección 5) | sí |
| `desktop/` | La misma app como programa de Windows (Electron): arranca el servidor de `web/` y le da acceso a la carpeta del proyecto. `npm run dist` deja el instalador y la versión portable en `desktop/dist/` (sección 5.7) | sí, sin `node_modules/`, `server/` ni `dist/` |
| `src/sportsan/` | El paquete Python (sección 6) | sí |
| `tests/` | Tests de Python, uno por módulo (`test_<módulo>.py`); `tests/fixtures/` tiene casos compartidos con la app | sí |
| `matches/<match_id>/` | Un partido: su configuración y sus archivos (sección 4) | solo `match.yaml` y `segments.csv` |
| `matches/videos.csv` | Registro de todos los videos (partido, qué parte es, enlace); de aquí descarga `download_videos` | sí |
| `config/project.yaml` | Partido por defecto y medidas de la cancha normalizada (105 x 68) | sí |
| `config/strava.local.json` | Credenciales de Strava; lo crea `strava_sync auth` | **no** |
| `config/roster.json` | Plantilla (nombres y números); la lee y escribe la app | **no** |
| `config/kaggle.local.json` | Tu usuario de Kaggle; lo crea `cloud.kaggle login` | **no** |
| `data/strava/` | Sesiones bajadas de Strava | **no** |
| `data/boards/` | Jugadas del pizarrón exportadas para hacerlas video | **no** |
| `data/mock/` | Datos falsos que genera `python -m sportsan.mock.generate` | no |
| `docs/` | Documentación (sección 8) | sí |
| `weights/` | Pesos de modelos: detector de jugadoras (`yolo11n`, `yolo11s` en OpenVINO) y el del balón (`ball_model.pt`, entrenado aquí) | no |
| `clips/` | MP4 de jugadas del pizarrón | no |
| `notebooks/tracking_test.ipynb` | Cuaderno del pipeline antiguo en Colab; ya no se usa | sí |
| `app/` | Primera interfaz en Streamlit; referencia, no se desarrolla | sí |
| `Sports analytics dashboard mockup/` | Propuesta de diseño que sigue la app | no |
| `.venv/` | Entorno de Python de esta computadora | no |
| `pyproject.toml` | Dependencias de Python por grupos: `dev`, `calib`, `detect`, `clips`, `ingest`, `tracking` (antiguo) | sí |
| `CLAUDE.md`, `.claude/agents/` | Instrucciones y agentes para Claude; locales | no |

## 4. La carpeta de un partido

```
matches/partido_2026_09_25/
  match.yaml          equipos, sede y medidas reales, lista de videos (id de YouTube, archivo, fps, colores de uniforme),
                      detector (modelo, trozos, franja) para cámaras amplias
  segments.csv        tramos del video (juego / pausa / no medible), uno por partido con columna video_id. Lo escribe la
                      app (pestaña Tramos). Sin él, process no sabe qué procesar
  video/v1.mp4        videos descargados, uno por parte (v1, v2, v3...)
  segments/           clips que corta cut_segments (opcional)
  events/             reservado para eventos en parquet; hoy vacío (los eventos viven en la app)
  tracking/           todo lo que produce o corrige el tracking:
    anchors_<partido>_<video>.json   anclas de calibración (desde la app, pestaña Calibración → Exportar)
    calib_<video>_<ini>_<fin>.json   calibración cuadro a cuadro de un tramo (propagate o library locate)
    library_<video>.npz              biblioteca de calibración del video (library build). No borrar
    tracks_<video>_<ini>_<fin>.json  una parte procesada (un tramo de juego): cajas, posiciones, equipos, identidades propuestas.
                                     Nunca se modifica
    tracking_<video>_<ini>_<fin>.parquet  lo mismo en la tabla del contrato (solo personas dentro de la cancha)
    tracks_<video>_index.json        lista de partes hechas con sus indicadores
    tracks_fixed_<video>_<ini>_<fin>.json  la parte corregida en la mesa (nombres, balón): de aquí leen Análisis e Informe
    labels_<video>_<ini>_<fin>.json  las correcciones como etiquetas, sin nombres (para medir el tracking)
    ball_auto_<video>_<ini>_<fin>.json  lo que encontró el tracker de balón y dónde pide marca
    team_metrics_<video>.json        forma de los equipos (metrics.report)
  edits/              dibujos sobre el video de una jugada (edit_<id>.json, desde la app; fuera de git)
  clips/              clips exportados a MP4 (sportsan.clips.render y cut_clips; fuera de git)
  clips_<match_id>.json  lista de clips del informe (desde la app; fuera de git)
  report_<match_id>.json datos del informe (desde la app; fuera de git)
```

`<ini>` y `<fin>` son números de cuadro del video. Para pasar a tiempo: cuadro / fps (29.97 o 30). Ejemplo: 59940 = 33:20.

## 5. La app web (`web/`)

Cuando la app corre en esta computadora (`npm run dev`) lee y escribe los archivos de la carpeta de cada partido por
`web/app/api/local/` (también `POST` para subir en streaming a `matches/<carpeta>/` con las reglas de `lib/uploads.ts`: 409 si ya existe, salvo `?overwrite=1`; el zip va por `web/app/api/unzip/` en dos pasos, inspeccionar y descomprimir, con `yauzl`) (acceso en `web/lib/local.ts`; solo puede escribir los archivos de la lista `WRITABLE`): abre sola el video,
lista las partes de tracking, guarda `segments.csv`, los colores en `match.yaml`, las anclas, lo corregido, las ediciones de clip,
la lista de clips y la plantilla. Para eso el partido necesita su carpeta (pestaña Calibración o «editar datos»). Desplegada en
internet no hay carpeta: se vuelve a elegir cada archivo a mano.

### 5.1 Pantallas

Cada pantalla es un archivo `web/app/<ruta>/page.tsx`. La barra de iconos de la izquierda está en `web/components/Shell.tsx` (listas `NAV` y `NAV_END`; cada icono dice su nombre al pasar el cursor) y abajo tiene el botón de tema claro/oscuro.

| Menú | Ruta | Archivo | Qué hace |
|---|---|---|---|
| Inicio | `/` | `app/page.tsx` | Último partido propio (marcador grande, franja de los 8 pasos que abre cada uno, frase del informe, barras enfrentadas de posesión, tiros, a puerta, córners y recuperaciones, accesos a Análisis/Informe/Estudio), ficha del próximo rival (videos, goles, tiros, frase de su informe, partidos contra nosotras) y pendientes accionables con el ícono de su paso. Cálculo en `lib/home.ts`. La carga de entrenamiento está oculta (ver abajo) |
| Partidos | `/partidos` | `app/partidos/page.tsx` | Todos los videos en tres grupos: nuestros partidos, rivales y videos de referencia; alta de uno nuevo (`components/MatchList.tsx`). Cada grupo tiene su «Añadir», que abre el diálogo de alta (tipo, equipos frente a frente, fecha, sede, YouTube y carpeta sugerida con `suggestFolder` de `lib/local.ts`). Cada partido: fecha, marcador, micro resumen (primera oración del resumen del informe; posesión, tiros, a puerta, córners y recuperaciones de cada lado; `lib/summary.ts`) y los íconos de sus pasos completos. La posesión se guarda en `Match.possession` al abrir el Informe de un partido con balón seguido. `/rivales` redirige aquí |
| (al abrir un partido) | `/partido?id=` | `app/partido/page.tsx` | El partido: video, selector de video y sus pestañas (5.2). `&modo=` elige el modo y `&paso=` un paso concreto (p. ej. `&modo=analisis&paso=report`). `?video=&t=` abre ese momento; `?edit=` abre un clip editado en modo presentación |
| Pizarrón | `/pizarron?id=` | `app/pizarron/page.tsx` | Jugadas en el pizarrón: ABP diseñadas sin partido y jugadas que vienen de un partido («Pasar al pizarrón» en Jugadas). Lista filtrable por categoría (córner, tiro libre, saque de banda, salida de balón, otra) y a favor o en contra; encuadre (cancha entera o una mitad). Tres vistas: Editar (pasos, fichas y dibujos; `components/board/BoardEditor.tsx`), Animación (`BoardPlayer.tsx`) y Láminas para imprimir o guardar en PDF, de 2 a 4 pasos por página (`BoardSheets.tsx`). El botón de película la guarda en `data/boards/` para exportarla a MP4 |
| (temporal, fuera del menú) | `/revision` | `app/revision/page.tsx` | Revisión de saltos imposibles: lee `tracking/revision/saltos/casos.json` y guarda `respuestas.json` al lado (única ruta de revisión escribible en `app/api/local`). Se quita al terminar el estudio |
| Jugadoras (oculta) | `/jugadoras` | `app/jugadoras/page.tsx` | Lo que se sabe de cada jugadora. El perfil sigue bloqueado |
| Sesiones (oculta) | `/entrenamientos` | `app/entrenamientos/page.tsx` | Importa sesiones por CSV; carga, ACWR, cuestionario |
| Calendario (oculta) | `/planificacion` | `app/planificacion/page.tsx` | Vista previa bloqueada (en desarrollo) |
| Datos | `/datos` | `app/datos/page.tsx` | Dos bloques: cargar datos de un partido (zip de su carpeta o de un video de referencia, eventos CSV, video y tracking; se escriben en `matches/<carpeta>/` solo con la app en la laptop) y respaldo completo (exportar y restaurar con confirmación). Componentes en `components/data/` (`ZipCard`, `MatchFiles`, `BackupCard`, `DropZone`) |
| Configuración | `/configuracion` | `app/configuracion/page.tsx` | Tres pestañas: Apariencia (tema, color de nuestro equipo y del rival con vista previa, cómo se marca a las jugadoras), Sedes (tarjetas con su dibujo; el editor ocupa la pantalla: medidas, rejilla, portería, colores y vista previa a la izquierda; a la derecha la imagen satelital con lupa y la cancha como rectángulo que se mueve, gira y escala sin deformarse, y herramientas Escala, Portería, Dibujar —líneas y franjas del pasto— y Verificar puntos de referencia) y Plantilla (`components/RosterCard.tsx`, se usa al etiquetar y en Tracking) |

**Secciones ocultas para la primera entrega al cuerpo técnico** (solo análisis de partidos): con `TEAM_SECTIONS = false` en `web/lib/features.ts`, Jugadoras, Sesiones y Calendario salen del menú, Inicio pierde la carga de entrenamiento, Datos el CSV de sensores y Configuración los umbrales; sus rutas redirigen a `/partidos` (`web/next.config.ts`). El código sigue ahí: se reactivan poniendo `true`.

`app/layout.tsx` envuelve todas las pantallas (fuente Archivo, menú) y aplica el tema y los colores guardados antes de pintar
(`THEME_BOOT` en `lib/teamColors.ts`). `app/globals.css` tiene todo el diseño: colores (solo por tokens; el tema claro los
redefine en `:root[data-theme="light"]`), clases (`.btn`, `.card`, `.seg`, `.sec-tag`, `.num`...), animaciones e impresión.
Dirección de diseño: base neutra casi negra, color solo en los datos, azul rey para el equipo analizado (cambiable),
tipografía condensada para cifras, marcador y encabezados de sección. Los colores de equipo salen de `lib/teamColors.ts`
y `lib/theme.ts` los aplica (`--color-own`, `--color-opp`; y su versión oscura para papel blanco, `--paper-own`,
`--paper-opp`). Impresión: la página no tiene margen (el fondo llega al borde) y `.print-sheet` devuelve el margen en
cada hoja. El PDF sale con los colores de la app salvo que `<html>` lleve `data-paper="white"` (`lib/print.ts`): el
Informe lo elige con «Como la app / Blanco» y las láminas del pizarrón siempre van en blanco. `--slot-1..4` son los
colores de las jugadoras comparadas en Rendimiento individual (validados en oscuro y en claro, distintos de los de equipo).

### 5.2 Los tres modos de un partido

Los modos se eligen en la barra lateral, sección Partidos: Resumen (lista de partidos), **Captura** (Calibración,
Tramos, Tracking, Balón, Eventos), **Estudio** (Jugadas, con el editor de clips, y Pizarrón) y **Análisis** (Pantalla e
Informe); van al último partido abierto (`?modo=`). Arriba, una sola fila (`components/match/MatchHeader.tsx`): el
marcador (goles etiquetados), el video, los pasos del modo y los datos del partido y del video (engrane). Cada modo muestra sus pasos en una franja, cada uno con su ícono (`STEP_ICONS` en `MatchHeader.tsx`, verde cuando el paso está completo), con su estado calculado en `web/lib/steps.ts` a partir de
los datos del partido y de lo que hay en su carpeta. Un partido con eventos abre en Análisis; uno sin, en Captura. Calibración y Tracking son opcionales: todo lo demás funciona solo
con eventos.

| Pestaña | Archivo | Qué hace | Dónde está el cálculo |
|---|---|---|---|
| Calibración | `components/workspace/Calibration.tsx` | Arriba: pasos, «Video y sede» (diálogo), cargar calibración o detecciones y «Comandos» (los comandos de Python para copiar). Izquierda: video y lo cargado. Derecha, en orden de uso: puntos de la sede (o «Líneas»: dos clics sobre una línea visible y su línea del dibujo; dos líneas que se cruzan dan un punto calculado aunque el cruce no salga en cuadro, `lib/calibLines.ts`; clic en el nombre de una línea marcada la elige para el ajuste fino: Alt + flechas mueve su clic 1, su clic 2 o toda la línea —Alt + 1 / 2 / 3—, Alt + , / . la gira 0.1°, con Mayús 1°; o «Círculo»: 5 o más clics a lo largo del círculo central o de un arco del área, que se ajustan junto con puntos y líneas; avisa si el arco cubre menos de 120°), lupa y ajuste fino, ajuste y guardar ancla, anclas guardadas (Exportar las escribe en `tracking/`). `/calibracion` sigue funcionando | `lib/homography.ts`, `lib/venue.ts` |
| Tramos | `components/match/SegmentsTab.tsx` | Marcas de corte → tramos de juego/pausa/no medible; escribe e importa `segments.csv` | `lib/segments.ts` |
| Tracking | `components/workspace/Correction.tsx` | Colores de uniforme, comando de proceso y mesa de corrección (5.4). Cada persona se marca sobre el video como caja, óvalo en el piso con el nombre en el borde, o flecha arriba (`components/PlayerMark.tsx`; Mayús + L cambia). `/correccion` sigue funcionando | `lib/tracks.ts`, `lib/parts.ts`, `lib/quick.ts`, `lib/anomalies.ts` |
| Eventos | `components/match/TagTab.tsx` | Tres pasadas: 1 identificar (teclas, etiqueta sobre el video, aviso de duplicado, `J` = jugada), 2 revisar uno por uno (`ReviewPanel.tsx`), 3 ejecución: destino de tiros en la portería (`GoalFrame.tsx`; no lo pide un tiro bloqueado ni un tiro libre que no fue tiro) y de centros y córners en la cancha. Los pases no se etiquetan: salen del tracking. Bajo el video, línea de tiempo (`VideoTimeline.tsx`); en el panel, la lista corta paginada y la tabla completa en grande con filtros (`EventsTable.tsx`), selector de jugadora con sugerencias cerca del balón y clic sobre el video (`PlayerPicker.tsx`, `lib/videoPeople.ts`), opciones de los menús en `eventOptions.ts` | `lib/tagging.ts`; catálogo en `lib/types.ts` |
| Jugadas | `components/match/PlaysTab.tsx` | Bajo el video, el bin de jugadas (todo el video como barra con cada jugada y el cabezal, y una fila de tarjetas por páginas); a la derecha la jugada elegida con su animación (la cancha toma el alto que queda) (casilla «Balón parado»: el informe la lista en esa sección): posiciones medidas si la jugada cae en una parte corregida (`tracks_fixed_*`), si no keyframes a mano. «Pasar al pizarrón» copia la jugada al Pizarrón; «Dibujar sobre el clip» abre el editor de clips (5.3). Lista y jugada elegida en un panel del mismo alto que el video; reproducir es un botón de solo ícono; sin línea de tiempo del balón | `lib/positions.ts` (`positionsAt`), `lib/stats.ts` (`interpolate`), `lib/clips.ts` |
| Análisis | `components/match/AnalysisTab.tsx` | Respuestas a las preguntas del cuerpo técnico (`docs/preguntas_cuerpo_tecnico.md`). Tiros: un gol y su tiro (y su penal) cuentan una vez. Pases (`PassesCards.tsx`): dos fuentes lado a lado, del tracking y marcados a mano, que nunca se suman (`lib/passSources.ts`). Goles (`GoalsList.tsx`) y los momentos de los paneles se reproducen bajo el panel con `MomentPlayer.tsx` (`lib/moments.ts`; mismo enlace «ver» del informe). **Rendimiento individual** (`PlayersCompare.tsx`): hasta 4 jugadoras de los dos equipos, cifra por cifra (ataque, con balón, defensa, físico; totales o por 10 min vistos) y su mapa de calor; los eventos cuentan si llevan su nombre, el resto sale del tracking corregido; «—» es no medido. **Minutos**: «Minutos jugados» es el reloj del partido (`playedMinutes`, con `videoPeriods` para que varios videos de un mismo tiempo cuenten como uno; sin cambio etiquetado, «sin dato»); «Tiempo visto» (`minutes`) es solo lo que salió en cuadro y es el denominador de «por 10 min». Se muestra el % de tiempo y de distancia que viene de posiciones rellenadas (`fill_time_pct`, `fill_dist_pct`), nunca mezclado con lo medido. La selección se guarda por partido en las preferencias. Con posiciones medidas: forma del bloque (`TeamShape.tsx`), mapa de calor y jugadoras detrás del balón (`PositionsCards.tsx`) | `lib/analysis.ts` (`finishes`), `lib/stats.ts`, `lib/positions.ts`, `lib/passSources.ts`, `lib/moments.ts`, `lib/blockShape.ts`, `lib/fixed.ts` |
| Informe | `components/match/ReportTab.tsx` | Encabezado tipo tablero (título, marcador y franja de cifras clave: posesión, tiros, a puerta, recuperaciones, pases completos; solo las que hay), «Como la app / Blanco» elige el color del PDF, **General** comparando los dos equipos, y debajo un selector del equipo que describen las demás secciones. Las secciones se eligen y ordenan con «Secciones» (catálogo y biblioteca en `lib/reportSections.ts`; se guarda en `Report.sections` y `Report.focus`); una sección sin datos se oculta sola. Nuevas: Bloque (calor, posición media, altura de línea, largo y ancho), Mapa de pases (flechas, progresivos), Distancia y velocidad (`components/match/ReportExtra.tsx`, cálculo en `lib/physical.ts` y `passArrows` de `lib/positions.ts`). Antes: informe imprimible por niveles de datos (N1 eventos, N2 balón seguido, N3 tracking revisado, N4 tracking con nombres): portada con nivel, últimos resultados, resumen, mapas (tiros y portería, centros con destino, duelos, pérdidas y recuperaciones en 5 carriles × 3 tercios), transiciones con «ver» (abre el clip editado si lo hay), balón parado, jugadoras clave, textos de la analista, jugadas y método. Una sección sin su nivel dice qué le falta y no se imprime. «Exportar datos del reporte» (`report_<match_id>.json`), «Exportar lista de clips» (`clips_<match_id>.json`), «Sin nombres» (dorsales). Con balón seguido: posesión, pases por zona, cambios y red de pases (`ReportBall.tsx`). Solo dibuja: todo el cálculo está en `lib/report.ts` | `lib/report.ts` (`buildReport`, `dataLevel`, `clipList`) |

### 5.3 Piezas compartidas (`web/components/`)

| Archivo | Qué contiene |
|---|---|
| `Shell.tsx` | Barra de iconos (con el partido elegido como marcador pequeño entre Resumen y los tres modos), `PageHeader`, `Card`, `Section` (rótulo condensado), nombres de clases de botón |
| `workspace/ProcessPanel.tsx` | Lo que muestra Tracking cuando un video no tiene partes: ajustes del detector (se guardan en `match.yaml` con `lib/trackingSettings.ts`), prueba de 30 s (`process --test`, lee `tracking/prueba/summary.json`) y procesar en la laptop (`overnight`) o en Kaggle. Con la app en esta computadora son botones (`app/api/run`, `lib/run.ts`); en la web, comandos para copiar |
| `workspace/KitPanel.tsx` | Colores de los uniformes (`jersey_colors`), en Calibración: gotero sobre el video y guardar en `match.yaml` |
| `board/BoardsWorkspace.tsx` | El pizarrón: su página (`/pizarron`) y el paso Pizarrón de Estudio |
| `PlayerMark.tsx` | Cómo se marca una persona sobre el video: caja, óvalo en el piso (nombre en un arco plano debajo) o flecha |
| `Dropdown.tsx` | `Dropdown` (botón que abre un panel; se cierra con clic fuera o Esc) y `MenuItem`. Lo usan el menú ⋯ de Tracking y el engrane del partido |
| `FocusMode.tsx` | Modo enfoque dentro de un partido (botón junto a Guardar en Tracking): la barra lateral y la barra del partido salen de la pantalla y vuelven al llevar el cursor al borde izquierdo o de arriba (o salir por ahí) |
| `workspace/LoadingStage.tsx` | Animación de carga (líneas de cancha que se trazan y balón que bota) mientras se buscan o abren las partes y mientras carga el video |
| `workspace/PersonTimeline.tsx` | Línea de la seleccionada bajo el video: presencia, huecos, saltos imposibles (recuadro rojo, clic para revisarlo) y la línea de la fijada; un tramo elegido se borra, se separa, se une a otra (`u`: buscador de las que tienen nombre; `j`: a la fijada) o se arrastra sobre otra jugadora |
| `match/MatchHeader.tsx` | Marcador del partido, los tres modos y la franja de pasos |
| `match/SaveStatus.tsx` | Junto a los pasos: «Sin guardar: N cambios en M partes» / «Todo guardado a las HH:MM» (detalle por parte en el tooltip), «Guardar todo» (Ctrl+S), guardado automático opcional cada 5 min y diálogo cuando un archivo de la carpeta es más nuevo |
| `lib/saveAll.ts` (test `saveAll.test.mjs`) | Huellas de cada parte y de los eventos, qué está sin guardar, conflicto por archivo más nuevo, nombre y rotación de respaldos (5), CSV de eventos y respaldo de un solo partido |
| `lib/saveMatch.ts` | Escribe en la carpeta: `savePart` (el «Guardar» de la mesa: `tracking/tracks_fixed_*` + `labels_*`) y `saveAll` (todas las partes con cambios, `events_<carpeta>.csv` o el CSV de eventos que ya exista, y `respaldo/respaldo_<aaaa-mm-dd_hhmm>.json`). Último guardado por carpeta en la preferencia `saved:<carpeta>` del navegador |
| `lib/fixedExport.ts` | `buildFixed`: el contenido de `tracks_fixed_*.json` (personas, balón, suavizado), igual desde la mesa y desde «Guardar todo» |
| `VideoPlayer.tsx` | Reproductor de YouTube o de archivo local, con la misma interfaz |
| `SpeedControl.tsx` | Botón de velocidad con deslizador (hasta 5x) |
| `Select.tsx` | Menú desplegable propio (uno o varios valores, con color y tecla), en lugar del `<select>` del navegador |
| `Pitch.tsx` | La cancha dibujada (SVG de 105 x 68), los colores de equipo y `toMeters` (clic → metros) |
| `charts.tsx` | Todos los gráficos: `StatTile`, `CompareBars`, `ShotMap`, `ZoneMap`, `LineChart`, `EventTimeline`, `MiniBars`, `RateDuo`, `PartsDuo`, `BinChart`, `AcwrChart` |
| `Locked.tsx` | Marco para lo que aún no funciona, con su motivo (falta de datos / en desarrollo / requiere tracking) |
| `motion.tsx` | Aparición al hacer scroll (`Reveal`) y cifras que cuentan (`CountUp`) |
| `VenueEditor.tsx` | Editor de sede en una pantalla (exporta `VenueEditor` y `VenueDiagram`). Panel «Líneas extra para calibrar» (`ref_lines`: rectas paralelas a las bandas o al fondo a la distancia que se diga, p. ej. el fin del pasto; salen en Calibración › Líneas). Panel «Marcas de fútbol» (fondo y ancho de las áreas, punto penal, radio del círculo; `SOCCER_DEFAULTS` en `lib/venue.ts`) y ancho entre bandas del americano: al pasar por un campo se resaltan los puntos de referencia que mueve. Usa `venue/FitStage.tsx` (imagen con la cancha encima, lupa y herramientas Escala, Portería, Dibujar y Verificar), `venue/ModelDrawing.tsx` (dibujo del modelo) y `venue/fields.tsx` (Panel, Num, Paint); geometría en `lib/venueFit.ts` |
| `MatchList.tsx` | Lista de partidos (Resumen), diálogo de alta por grupo y borrar un partido (papelera fuera de la tarjeta, al pasar el ratón, con confirmación) |
| `LocalPick.tsx` | `FilePicker`: abrir un archivo de la carpeta del partido o «Otro archivo…»; `partLabel` |
| `BallStrip.tsx` | Barra de dónde hay balón en un tramo: posición conocida o trazada, marcas tuyas, del tracker y de eventos, huecos en rojo. Solo en la mesa de corrección |
| `match/FolderSync.tsx` | En el engrane del partido, bajo Carpeta: `match.yaml` al día por sí solo (tipo, fecha, equipos y nombre de sede; las medidas solo con botón, porque cambian la escala del tracking) y «Renombrar la carpeta» (`app/api/rename` corre `sportsan.ingest.rename_match` y luego pasan al nombre nuevo, en el navegador, la carpeta del partido, las correcciones de tracks, las anclas y las preferencias) |
| `TimeRange.tsx` | Inicio y fin de una jugada o un clip: escribir el tiempo, − / + medio segundo (Mayús: una décima) o «en el momento del video». En Jugadas y en el editor de clips (el clip arrastra a su jugada) |
| `studio/Studio.tsx` | Armazón común del editor de clips y del pizarrón: barra de herramientas vertical (`ToolRail`), lienzo ajustado (`FitAspect`), línea de controles abajo y panel lateral con pestañas; alto fijo desde 1280 px de ancho |
| `studio/Timeline.tsx` | Línea de tiempo tipo editor de video de los dos editores: regla con cabezal arrastrable, pista de bloques (pasos del pizarrón), pista de marcadores (pausas del clip, se arrastran) y los dibujos como barras en carriles (arrastrar mueve, los bordes recortan; se pegan al cabezal, a las pausas o a los pasos). Más carriles los hace más delgados, nunca scroll |
| `Paged.tsx` | `usePaged` + `Pager`: una lista que llena su alto y se divide en páginas en vez de desplazarse dentro (marcas de Tramos; mismo criterio que la lista de Eventos) |
| `Command.tsx` | `Command` (comando con botón de copiar) y `CopyButton` |
| `Modal.tsx` | `Modal` (diálogo) e `IconButton` (botón de solo icono; el texto va en el título) |
| `clip/ClipEditor.tsx` | Editor de clips sobre el video del tramo (armazón `studio/Studio.tsx`; línea de tiempo con pausas y dibujos abajo e Inspector a la derecha: el dibujo o la pausa elegidos, o el resumen del clip con el rótulo de jugadoras y las teclas): capa SVG que proyecta los dibujos con la H de cada cuadro; herramientas Elegir `m`, Resaltar `r`, Flecha `f`, Línea `l`, Zona `z`, Texto `t`; pausas con `p` (lo dibujado en una pausa aparece en ella, uno a uno); entrada y salida de cada dibujo; rótulo por dorsal, nombre o ninguno; «Guardar en la carpeta» escribe `edits/edit_<id>.json`. **Presentar**: pantalla completa, se detiene sola en cada pausa y sigue con espacio o →; ← vuelve a la pausa anterior. Datos: `clip/useClipData.ts`; dibujo: `clip/ClipOverlay.tsx` |
| `board/BoardView.tsx` | El pizarrón en un momento: cancha (entera o una mitad), dibujos y fichas. Lo usan el editor, la animación y las láminas |
| `board/BoardEditor.tsx` | Editor del pizarrón (armazón `studio/Studio.tsx`; línea de tiempo con los pasos como bloques y los dibujos como barras que abarcan pasos; pestañas Paso (inspector del dibujo elegido o nota y dibujos del paso), Jugada y Jugadas; la lista de jugadas vive en el panel lateral; ícono del paso: `Strategy`): pasos con su nota, herramientas (Mover `m`, Resaltar `r`, Flecha `f`, Línea `l`, Zona `z`, Texto `t`), lista de dibujos del paso y fichas (dorsal o rol) |

### 5.4 La mesa de corrección, por zonas

Todo está en `components/workspace/Correction.tsx` (pestaña Tracking del partido); la lógica, en `lib/tracks.ts`, `lib/parts.ts`,
`lib/quick.ts`, `lib/anomalies.ts`, `lib/feetKeys.ts` y `lib/smooth.ts`.

**Pies en cuadros clave** (`p`, o «Ajustar pies» en un salto): clic en sus pies en 2 o más cuadros; en los de en medio los pies son el centro del borde inferior de la caja más el desplazamiento interpolado entre claves (sigue a la caja de lado, solo corrige la altura), y antes de la primera y después de la última se mantiene como máximo 0.5 s (los últimos 0.2 s vuelve a la caja). Se guarda como marcas a mano por cuadro en `TrackEdits.manual` (píxeles, `fit` = id del tramo, `key` true/false), así que exportar, animaciones y velocidades lo pasan a metros con la H de cada cuadro igual que antes; las marcas viejas sin `fit` no se tocan. Tira sobre el video con claves, tramo y contador; `Supr` borra la clave del cuadro, `Mayús Supr` el tramo, `Enter`/`Esc` termina (y pasa al siguiente salto), `Ctrl Z` deshace el tramo entero. Línea verde punteada a la altura de los pies ajustados. Test: `lib/feetKeys.test.mjs`.

| Zona de la pantalla | Qué hace | Función principal |
|---|---|---|
| Encabezado | Otra parte, Revisión rápida, estado de la parte, Guardar y menú ⋯ (Movimientos imposibles, Exportar…, Restablecer…, otro archivo de video) | |
| Guardar | Escribe `tracks_fixed_*.json` y `labels_*.json` en `matches/<id>/tracking/`; solo si no puede, los descarga. El botón mismo dice cómo fue (Guardando… / Guardado / Descargado); el resumen del suavizado va en su tooltip | `buildLabels` |
| Teclas del video | `←` `→` un cuadro procesado (mantener: rápido x4); `Mayús ←/→` 1 s; espacio reproduce o pausa (mantener: cuadro a cuadro); `0`–`9` van al 0 %, 10 %… 90 % de la parte; el video no sale de la parte cargada | |
| Paneles | En una ventana ancha la mesa cabe en la pantalla sin ningún scroll: cada panel mide lo que su contenido necesita y el video toma el resto. Arrastrar el borde izquierdo del panel lateral cambia su ancho (doble clic: el de siempre). Cada módulo (En la cancha, Jugadora, Balón, Revisión rápida, Plantilla) se arrastra por su asa (arriba a la derecha, al pasar el ratón) entre el panel lateral y la zona bajo el video; un clic en el asa lo cambia de lado. La plantilla de la revisión rápida va bajo el video de inicio. Recortar (icono junto a Caja/Óvalo/Flecha) oculta arriba y abajo del cuadro, por video. El blanco (`h`) deja resaltada solo a la seleccionada: las demás se ven al pasar el ratón | |
| Anomalías | Lista de movimientos imposibles de la parte; clic va al momento y selecciona a la jugadora. **Jugadora**: salta más de 9 m/s y 3 m (casi siempre su nombre pasó a otra: un barrido de cámara en la revisión rápida, alguien que entra al cuadro); primero las que tienen nombre. **Cámara**: muchas saltan a la vez, falla la calibración de ese cuadro, no las identidades. **Balón**: más de 35 m/s, o un desvío de ida y vuelta (un balón por alto marcado y llevado al suelo) | `playerAnomalies`, `ballAnomalies` |
| Video con cajas | Clic en una caja la selecciona; arrastrar una caja sobre otra las une (se queda el nombre que haya); modos unir (`u`), marcar a mano (`p`), marcar balón (`b`). Zoom que sigue a la seleccionada (`z`: ×1, ×2, ×3; se recuerda en el navegador). Pantalla completa (`f` o el botón junto al zoom) en las tres vistas, con una línea arriba: a quién se nombra (revisión rápida), el % de balón (Balón) o los avisos del momento y la palomita de la seleccionada (Jugadoras); los avisos de la mesa también salen ahí. La candidata que se está revisando sale con recuadro amarillo punteado y una barra debajo: Unir (Enter), No (X), otra vez (R), cerrar (Esc) | `identityOf`, `setManual`, `setBall` |
| Bajo el video: la seleccionada | Su fila (nombre, equipo, completa), herramientas con atajo (`g` hueco por revisar, a 1 s de donde se perdió y 1 s más cada vez; `c` siguiente cambio de camiseta; `d` siguiente cuadro con dos cajas; `v` verificada; `m` deja una caja donde hay dos en el mismo sitio; `u` unir, `s` partir aquí y seguir con el segundo tramo, `Shift S` partir y quedarse en el primero, `p` marcar a mano, `k` fijarla, `j` unirla a la fijada, `a` siguiente salto imposible, `Supr` no es jugadora, `Esc` soltar), su línea de presencia (arrastrar elige un tramo para borrar, separar, unir a otra o arrastrarlo sobre otra jugadora del video o del panel) y la de la fijada debajo, para ver qué huecos suyos llena un tramo. Sus avisos son fichas pequeñas de icono y número en la misma línea que sus herramientas (el detalle, al pasar el ratón; el clic hace lo obvio): candidatas (`n`, se unen o descartan en la barra bajo el video), cambios de camiseta (y tijera si hay uno en pantalla), trozos cortos, dos cajas, saltos imposibles (y goma para quitarlos todos), huecos por revisar y fuera de cuadro. La fijada sale bajo «En la cancha». **Saltos imposibles** de la seleccionada (ficha roja, recuadros rojos en su línea, `a`): barra bajo el video con Quitar cuadros (`Q`; la caja perdió sus pies, se rellenan al guardar), Quitar el anterior (`Alt Q`: muchas veces el cuadro malo es el de antes del salto; en la vista Balón, `Alt Q` quita la marca anterior), Ajustar pies (`P`: abre «Pies en cuadros clave» con el salto y ±1 s) y Está bien (`Enter`, queda en `TrackEdits.anomalyOk`) y avisos en fichas: candidatas (`n` ver la siguiente; ojo / ✓ / ✗), cambios de camiseta (ojo / tijera), trozos cortos suyos, dos cajas a la vez y huecos por revisar: en medio de la imagen y de más de 2 s o imposibles (`g` siguiente; rojo en la línea, ficha verde cuando no queda ninguno); los de fuera de cuadro, en gris, no cuentan (`offCamera`: estaba en el borde de la imagen al perderla o al encontrarla) | `personTimeline`, `dropRange`, `separateRange`, `merge`, `candidatesFor`, `applyHint`, `splitPerson`, `suggestAbsorb` |
| Lista de personas | Nombre (= identidad), equipo, completa, filtros (incluido «solo con cambio de camiseta»); `v` verifica y salta a la siguiente con trabajo pendiente; con una seleccionada, arriba sus candidatas; scroll propio y ancho ajustable | `people`, `setPerson` |
| Diálogo Limpieza rápida | Trozos de menos de 1 s: añadir a su jugadora o descartar | `duplicatesAmong`, `suggestAbsorb`, `applyAbsorb` |
| En la cancha | Posiciones del cuadro, rastro de la seleccionada, balón. En la vista Balón, un clic marca el balón ahí (en el suelo) | `measuredPaths`, `ballPath`, `pitchToPixel` |
| Diálogo Uniformes | Colores por equipo y porteras; escribe en `match.yaml` | `teamOfColor`, `kitOfColor` |
| Vista Balón | Barra junto al video (revisado %, «No se ve / fuera» con `Enter`, paso 0.5/1/2 s, cajas con `h`, engrane para el balón desde eventos). Clic en el balón (en el video o en «En la cancha») marca y avanza; `→` un paso, `Alt →` un cuadro, `Tab` dos pasos; `Supr` quita la marca (o el balón del tracker si estaba mal); `n` va a donde falta (con el tracker, a donde pide marca); `i` recta a mano desde la última marca hasta el siguiente clic (pases largos, balones por alto); `k` mantiene el balón quieto desde tu marca anterior hasta aquí (saques de meta, de esquina, faltas); `a` siguiente salto imposible. El balón del tracker sale con anillo naranja discontinuo y cuenta como balón. La barra cuenta el % del tiempo en juego: lo marcado como fuera no falta | `manualBall`, `autoBall`, `holdBall`, `eventBall`, `ballPath`, `BallStrip` |
| Ajustes del balón | Engrane de la vista Balón: hacia dónde atacamos en este video (dos canchas con flecha), partido de los eventos y paso de la revisión (también en la barra, como botones 0.5 / 1 / 2 s) |
| Sugerencias | Módulo de la vista Balón (`components/workspace/AutoSuggestions.tsx`, reglas en `lib/autoEvents.ts`). Solo lee lo revisado: marcas a mano, balón del tracker conservado en tramos revisados y las muestras «No se ve / fuera»; necesita la dirección de ataque del video. La sugerencia de este momento se acepta con `s` (su primera opción) o se descarta con `x` (queda en `TrackEdits.autoRejected`); lo aceptado entra como eventos normales y se revisa en Eventos. Se ocultan las que ya están etiquetadas (mismo tipo y equipo a menos de 4 s) |
| Anclas | Botón «Anclas» de la mesa (`components/workspace/AnchorsPanel.tsx`, lógica pura en `lib/anchors.ts`, test `anchors.test.mjs`). Lee de `matches/<id>/tracking/auto/` `suggest_<parte>.json` y `links_<parte>.json` (los escribe Python) y escribe `anchors_<parte>.json`. Pasada de anclas: la caja amarilla es la sugerida (por puntuación); teclas 1-9/0 eligen jugadora de la plantilla, Enter o espacio anclan, `n` salta, Ctrl+Z deshace; densidad 1-5 anclas/min (inicial 2) con el número de sugerencias de cada nivel, en ámbar si no hay más sitios. «Rellenar: cargar links» (tras `python -m sportsan.tracking.anchors fill --match <id> --part <parte>`) convierte las identidades en ediciones normales (`TrackEdits.identity`/nombre; Ctrl+Z). Dudas: ordenadas por gravedad, clic va al cuadro; está bien / es otra / quitar cuadros (`TrackEdits.anchorDoubts`). Cronómetro por acción en preferencias del navegador (`anchors:timing`), exportable a JSON. Datos de ejemplo rotulados en `tracking/auto/ejemplo/` (hechos desde los tracks, no por el modelo) |
| Relleno B y empezar de cero | En Anclas, «Rellenar» usa el relleno B (`python -m sportsan.tracking.anchors fill --variant exp`, `links_<parte>_exp.json`, menos saltos) y al cargarlo aplica en un paso sus cajas a quitar (exclusión, ruta, ambas, salto) con su resumen por motivo; Ctrl+Z lo deshace. «Empezar de cero esta parte» (`components/workspace/ResetPart.tsx`, `lib/reset.ts`, test `reset.test.mjs`) borra, tras un diálogo con «Exportar antes», `anchors_`/`links_<parte>*.json` y los registros `progreso`/`run_fill_<parte>*` (DELETE de `app/api/run/anchors`, lista blanca `resettableFile` de `lib/runTask.ts`) y en el navegador las dudas resueltas, las anclas saltadas y el cronómetro de la parte; no toca suggest, tracks ni labels. Orden de modos: Anclas (Alt+1) · Revisión rápida (Alt+2) · Mesa (Alt+3), el último usado se recuerda por parte. Mesa: hasta 3 jugadoras seleccionadas (Ctrl/Shift+clic) con color propio, tiras juntas y verificación por jugadora; avisos bajo el video con un solo molde de altura fija (`components/workspace/Notice.tsx`) |
| Tarjetas de duda | En Anclas › Dudas, cada duda abierta es una tarjeta (`components/workspace/DoubtCard.tsx`, lógica pura en `lib/doubts.ts`, test `doubts.test.mjs`): salto con miniaturas ANTES/DESPUÉS, flecha en la cancha y «1 es ella / 2 es ella / ninguna / es real»; en dos sitios, cajas A y B con «A / B / ninguna / las dos»; unión dudosa con «unir / no unir / otra». Usa `doubt.boxes`, `jump` y `resolution` de links (Python); en links viejos las cajas se calculan en la app y se rotulan «ejemplo». Solo resalta esas cajas; ←/→ recorren ±1 s; teclas 1/A, 2/B, 0, Enter, D, S, Tab. Botón «?»: leyenda de todos los tipos de duda. En la pasada de anclas, «No es jugadora» (x) guarda el ancla `__no__`; «Saltar» (n) solo oculta la sugerencia aquí |
| Vista Revisión rápida | Por jugadora (por defecto): eliges una, la señalas y la app solo se detiene donde pudo cambiarse de persona; `Enter` es ella, `X` no, clic en otra caja = es esa. Por muestras: un cuadro cada 3 s, el número de cada caja. «Aplicar a la mesa» convierte el resultado en cortes, uniones y nombres (Ctrl+Z lo deshace). La plantilla (módulo aparte, bajo el video de inicio) sale como dorsales, nuestras o rivales (`A` / `S`; hecha con palomita, empezada con punto). Las rivales se añaden ahí con «7 Pérez»: su identidad es `R7` y el nombre solo se muestra (`State.rivals`, por partido). «Por muestras» tiene el mismo diseño y la misma plantilla; al llegar al final de la parte aparece «Fin de la parte» sobre el video y `Mayús + Enter` la da por hecha y pasa a la siguiente sin hacer. Después, revisa «Anomalías»: un barrido de cámara puede haber pasado un nombre a otra jugadora | `quickModel`, `applyQuick`, `applyQuickOnto` |
| Estado de la parte | «Completa» con al menos 10 jugadoras verificadas (con nombre y ✓) y balón en el 95 % del tiempo en juego (marcas, rectas de hasta 3 s, tracker y eventos; lo marcado «fuera» no cuenta). Al completarse se descartan las personas sobrantes sin nombre | `partStatus`, `leftovers`, `ballCoverage` |
| Diálogo Exportar | Suavizado y unir varias partes del mismo video en un archivo | `smoothTrack`, `joinParts` |

El archivo `tracks_*.json` nunca se modifica. Tus correcciones se guardan aparte (en el navegador, por parte, en `trackEdits`) y se
aplican encima; por eso todo se puede deshacer, y se quitan con «Restablecer…».

### 5.5 Lógica sin pantalla (`web/lib/`)

Son funciones puras con test al lado (`<nombre>.test.mjs`, se corren con `npm test`). Si un número de la app te parece mal, el
cálculo está aquí.

| Archivo | Qué resuelve | Constantes que quizá quieras ajustar |
|---|---|---|
| `types.ts` | Forma de todos los datos de la app y catálogo de eventos (`EVENT_TYPES`, `EVENT_OUTCOMES`, `EVENT_DETAILS`, teclas) | el catálogo (también hay que tocar `schema.py` y el contrato) |
| `store.ts` | Único acceso a los datos guardados (`useStore`, `mutate`) y preferencias de interfaz (`usePref`) | |
| `local.ts` | Archivos de la carpeta del partido por `app/api/local` (solo en esta laptop): leer, escribir texto, subir en streaming (`uploadLocal`), zip (`inspectZip`, `applyZip`, `dropZip`), `suggestFolder`, `readFolderFiles`; no es pura | |
| `analysis.ts` | Transiciones, tiros (un gol y su tiro son una acción: `finishes`), carriles, entradas al área, balón parado, tramos de 5/10 min | `SHOT_WINDOW_S` (15), `COUNTERPRESS_WINDOW_S` (8), `SAME_ACTION_S` (5) |
| `stats.ts` | Conteos por tipo, zonas, interpolación de jugadas | |
| `tagging.ts` | Reglas de las tres pasadas: duplicados, eventos activos, qué falta en cada pasada (`asksEnd`: qué pide destino), filtros | `DUPLICATE_S` (3), `ACTIVE_S` (2) |
| `segments.ts` | Marcas → tramos → `segments.csv`; qué saltar al etiquetar (`skipTarget`) | |
| `videos.ts` | Varios videos por partido y su línea de tiempo común | `VIDEO_GAP_S` (120) |
| `steps.ts` | Estado de cada pestaña del partido | |
| `summary.ts` | Micro resumen de cada partido en la lista (Resumen) | `summary.test.mjs` |
| `renames.ts` | Carpetas renombradas: pasa al nombre nuevo, en el navegador, la carpeta del partido, correcciones, anclas y preferencias; lee `matches/renames.json` (lo escribe `rename_match`) una vez por sesión | |
| `shootout.ts` | Tanda de penales tras un empate (`Match.shootout`): marcador, texto «4–3 pen.», si se pregunta | `shootout.test.mjs` |
| `matchYaml.ts` | Escribe en `match.yaml` los datos del partido (tipo, fecha, equipos, nombre y medidas de la sede) cambiando solo esas líneas y conservando comentarios | `matchYaml.test.mjs` |
| `calibFit.ts` | Calibración con círculos: ajuste numérico (Levenberg-Marquardt) de puntos, clics de líneas y clics sobre el círculo central o los arcos del área; elipse por mínimos cuadrados como arranque; los clics de arcos y líneas salen como pares de puntos para Python | `calibFit.test.mjs` |
| `calibLines.ts` | Calibración por líneas: líneas con nombre del modelo de la sede, cruce de dos rectas y puntos calculados de un cuadro | `calibLines.test.mjs` |
| `autoEvents.ts` | Eventos sugeridos desde el balón revisado (salidas por banda y fondo con su reinicio, juego detenido, entradas al último tercio y al área, centros, pérdidas/recuperaciones y duelos); umbrales en `AUTO` | `autoEvents.test.mjs` |
| `home.ts` | Lo que muestra Inicio: último partido, ficha del próximo rival, pendientes con su modo y paso, ancho de las barras enfrentadas | `home.test.mjs` |
| `uploads.ts` | Qué se puede subir a `matches/<carpeta>/`, destino de videos y tracking, entradas de un zip, `match.yaml` → partido (`matchFromYaml`), eventos CSV (`eventsFromCsv`) | `uploads.test.mjs` |
| `venueFit.ts` | Geometría del editor de sede: rectángulo de la cancha, arrastres sin deformar, medidas leídas, portería, franjas, grupos de referencia | `venueFit.test.mjs` |
| `features.ts` | Interruptor de las secciones ocultas (`TEAM_SECTIONS`) | |
| `roster.ts` | Plantilla: leer una lista pegada, números provisionales, números repetidos | `UNKNOWN_FROM` (99) |
| `homography.ts` | Homografía a partir de anclas (imagen → metros de la sede) | |
| `venue.ts` | Modelo de cada sede: líneas y puntos de referencia | `BUILTIN_SPECS` (sedes incluidas) |
| `overlay.ts` | Calzar el modelo de la sede sobre una imagen satelital | |
| `tracks.ts` | Correcciones de tracks: identidad, unir, partir, descartar, duplicados, trozos cortos, colores, balón a mano | `SAME_PLAYER_M` (2), `ABSORB_SPEED_MS` (8), `ABSORB_GAP_S` (2), `MAX_COLOR_DISTANCE` (40) |
| `suggestions.ts` | Con quién podría seguir o de quién podría venir una persona; quitar o separar un tramo de su línea | `MAX_GAP_S` (3), `RUN_MS` (8) |
| `cuts.ts` | Dónde una persona es probablemente dos: cambios de camiseta sostenidos y saltos imposibles | `TEAM_RUN` (10), `JUMP_SPEED_MS` (9) |
| `anomalies.ts` | Movimientos imposibles de jugadoras, de la cámara y del balón (botón Anomalías) | `CAMERA_MIN_PEOPLE` (4), `CAMERA_SHARE` (0.4), `BALL_MAX_MS` (35), `DETOUR_S` (2) |
| `quick.ts` | Revisión rápida: nombres dados en muestras que se extienden a toda la parte; estado de la parte | `SAMPLE_S` (3), `PLAYERS_DONE` (10), `BALL_DONE_SHARE` (0.95) |
| `labels.ts` | Las correcciones de una parte como etiquetas (`labels_*.json`), sin nombres | |
| `parts.ts` | Trayectorias medidas, balón (a mano, del tracker, de eventos, mantenido), clic en la cancha → píxel, unión de varias partes, cobertura del balón | `BALL_FILL_S` (3), `LINK_EDGE_S` (0.5), `LINK_SLACK_M` (2), `LINK_SPEED_MS` (8) |
| `smooth.ts` | Limpieza de trayectorias al exportar | `SMOOTH_DEFAULTS` (9 m/s, 2 s, 0.5 s de ventana), `EXCURSION_MAX_S` (0.8 s: escapada de la caja que se quita si vuelve) |
| `positions.ts` | Sobre las partes corregidas: dirección de ataque, mapa de calor, quién tiene el balón, pases y pérdidas leídos del balón, jugadoras detrás del balón, pases por tramo (`passStretches`) | `POSSESS_M` (2), `PASS_MAX_S` (5), `PASS_PLAYERS_SHARE` (0.8), `PASS_BALL_SHARE` (0.7) |
| `fixed.ts` | Carga las `tracks_fixed_*.json` (y, donde no hay, las partes sin corregir) y las orienta; no es pura | |
| `panels.test.mjs` | Prueba de los paneles de Análisis: `passSources`, `moments` y `blockShape` | `npm test` |
| `passSources.ts` | Pases de un equipo de las dos fuentes (tracking y a mano), por separado; nunca se suman | — |
| `moments.ts` | Un momento de un video (video y t del propio video) para reproducirlo bajo un panel y su enlace «ver» | `LEAD_S` (3) |
| `blockShape.ts` | Forma de cada equipo (ancho, largo, altura de línea y bloque) leída de las posiciones de la mesa, por tramos de minutos; mismas definiciones que `team_blocks.py` | `MIN_VISIBLE` (7), `GK_GAP_M` (8), `LINE_PLAYERS` (4), `MIN_FRAMES_PER_BIN` (10) |
| `passes.ts` | Pases etiquetados a mano antes (la pasada 4 ya no existe): red de pases y estadística por jugadora | |
| `report.ts` | Todo lo que dibuja el Informe, por niveles; lista de clips | `RECENT_N`, `CLIP_BEFORE_S` (3), `CLIP_AFTER_S` (2) |
| `players.ts` | Rendimiento individual: una fila por jugadora (eventos con su nombre + tracking corregido), catálogo de cifras y valor por 10 min vistos; `minutes` = tiempo visto, `minutes_played` = reloj (`playedMinutes`), `NO_DATA` = «sin dato», y % de relleno de tiempo y distancia | `MAX_COMPARE` (4), `METRICS` |
| `print.ts` | Imprimir con los colores de la app o en papel blanco (`data-paper`) | — |
| `load.ts` | Carga de sesión (RPE x minutos), ACWR, escalas del cuestionario | `ACUTE_DAYS` (7), `CHRONIC_DAYS` (28), `SAFE_ACWR` (0.8–1.3) |
| `annotations.ts` | Modelo único de dibujos (pizarrón y video): en metros de la cancha o pegados a una ficha o identidad; `resolve`, línea de tiempo con pausas, proyección sobre el cuadro | `DRAW_PX`, `DRAW_M` |
| `clips.ts` | Ediciones de clip: copia del tracking del tramo, H de cada cuadro, posiciones con la regla de 1 s, rótulos | `MAX_HOLE_S` (1) |
| `boards.ts` | Pizarrón: posiciones de salida por categoría, pasos, encuadre, pasar una jugada al pizarrón, tamaño de las láminas | `STEP_S` (2), `BOARD_TAIL_S` (1), `SHEET` |
| `format.ts` | Tiempos, CSV, descarga de archivos | |
| `demo.ts` | Datos de ejemplo (siempre rotulados como ejemplo) | |

### 5.6 Dónde guarda la app

Todo en el `localStorage` del navegador, en la clave `sportsan:v1`, con esta forma (`State` en `lib/types.ts`):

| Campo | Qué guarda | Se llena en |
|---|---|---|
| `matches` | Partidos (nombre, equipos, videos, carpeta, sede, informe) | Análisis con video |
| `events` | Eventos etiquetados | pestaña Etiquetado |
| `plays` | Jugadas con keyframes | pestaña Jugadas |
| `boards` | Jugadas del pizarrón con sus pasos y dibujos | Pizarrón |
| `edits` | Dibujos sobre el video de una jugada (también en `matches/<id>/edits/` al guardar) | Jugadas → «Dibujar sobre el clip» |
| `segments` | Marcas de tramo | pestaña Tramos |
| `sessions` | Sesiones de entrenamiento | Sesiones (CSV) |
| `anchors` | Anclas de calibración | pestaña Calibración |
| `venues` | Sedes editadas | Configuración |
| `trackEdits` | Correcciones de cada parte de tracking (identidades, nombres, balón a mano, balón del tracker quitado) | pestaña Tracking |
| `roster` | Plantilla (también en `config/roster.json`) | Jugadoras |
| `passes` | Pases etiquetados a mano antes de quitar la pasada 4 | (ya no se llena) |
| `jerseys` | Colores de uniforme por partido | pestaña Tracking → Uniformes |

Consecuencias: otro navegador u otra computadora empiezan vacíos; borrar los datos del sitio borra todo. El respaldo es Datos →
Exportar respaldo. Las preferencias de interfaz (menú plegado, hacia dónde ataca el equipo) van aparte, en `sportsan:ui`, y no
entran al respaldo.

### 5.7 La app de escritorio (`desktop/`)

Es la misma app de `web/` dentro de Electron. `web/next.config.ts` compila un servidor autónomo (`output: "standalone"`);
`desktop/stage.mjs` lo copia a `desktop/server/` y `desktop/main.js` lo arranca con el Node de Electron en
`http://127.0.0.1:3939` (puerto fijo: los datos del navegador viven en ese origen) con `SPORTSAN_LOCAL=1` y
`SPORTSAN_ROOT` = la carpeta del proyecto, que pregunta la primera vez y guarda en `%APPDATA%/Rendimiento/config.json`.
Así lee y escribe videos, tracking y `segments.csv` como `npm run dev`. Los datos del navegador no se comparten con el de
`localhost:3000`: se pasan con Datos → Exportar respaldo e importar.

| Comando | Desde | Qué hace |
|---|---|---|
| `npm run build` | `demo/web/` | Compila la app (también es la versión web) |
| `npm install` y luego `npm run dist` | `demo/desktop/` | Copia el servidor y genera `dist/Rendimiento Setup <versión>.exe` (instalador) y `dist/Rendimiento <versión>.exe` (portable) |
| `npm start` | `demo/desktop/` | Abre la app de escritorio sin empaquetar |

## 6. El paquete Python (`src/sportsan/`)

| Archivo | Qué hace | ¿Se corre como comando? |
|---|---|---|
| `config.py` | `load_config(match=, video=)`: une `config/project.yaml` con el `match.yaml` y resuelve rutas | no |
| `schema.py` | Columnas del contrato y validadores (`validate_tracking`, `validate_ball`, `validate_events`) | no |
| `timebase.py` | Tiempos: `parse_hms`, `load_segments`, cuadro → segundo | no |
| `io.py` | Lee parquets validando | no |
| `ingest/download_videos.py` | Baja los videos de `matches/videos.csv` que falten (YouTube o cualquier enlace que acepte yt-dlp) y los añade a su `match.yaml` | sí |
| `ingest/rename_match.py` | Renombra la carpeta de un partido según la convención, y su `match_id` en los archivos | sí |
| `ingest/cut_segments.py` | Corta con ffmpeg los tramos `juego` de `segments.csv` | sí |
| `ingest/strava_sync.py` | Autoriza Strava y baja sesiones a `data/strava/` | sí |
| `tracking/overnight.py` | Todo el tracking pendiente de una vez: propagación, biblioteca y process de cada video de `videos.csv` que tenga tramos y anclas | sí |
| `tracking/propagate.py` | Lleva la calibración de unas anclas a todos los cuadros entre ellas: cada cuadro se empareja directo con sus dos anclas (SIFT) y el flujo óptico solo tapa huecos (`--no-direct`: solo flujo, lo de antes). El cuadro de cada ancla sale de su `t_video` con el fps del video | sí |
| `tracking/library.py` | Biblioteca de calibración: de un barrido calibrado, ubica cualquier otro cuadro del video | sí (`build`, `locate`) |
| `tracking/detect.py` | Detector (YOLO con OpenVINO, en CPU) y seguidor (BoT-SORT); color de camiseta; planifica las partes | sí (solo cajas) |
| `tracking/process.py` | **El que se usa**: detección + calibración en una pasada, posiciones, equipos, identidades propuestas, archivos de salida; una parte por tramo de juego, reanudable | sí |
| `tracking/stitch.py` | Une fragmentos de track sobre la cancha (propuesta de identidad, conservadora) | no |
| `tracking/team.py` | Equipo por color de camiseta: decisión con margen y votación por track | no |
| `tracking/restitch.py` | Vuelve a unir las cajas de una parte ya procesada sin detectar de nuevo | no |
| `tracking/tracklets.py` | Fase 1 de la unión con mínima intervención (`docs/propuesta_union_tracks.md`): trozos puros (cortes por cruce, tamaño, velocidad y color), candidatos de unión, árboles de gradiente en numpy (`TreeModel`), ¿es jugadora?, unión uno a uno con abstención y medida de pureza / uniones / cortes pendientes. Funciones puras | no |
| `tracking/groups.py` | F2: clasifica cada trozo puro en propias, rivales, porteras, árbitros o fuera de juego (k-vecinos en numpy sobre color Lab, posición, distancia al arco, tamaño y velocidad; regla de portera con `jersey_colors`), marca como duda el cambio de grupo sin cruce. `python -m sportsan.tracking.groups --match <id>` escribe `tracking/revision/grupos_f2.md` | no |
| `tracking/reid.py` | Reidentificación por apariencia de los trozos (histograma Lab por franjas + gradientes, o `weights/yolo26n-reid.onnx`); caché en `tracking/revision/reid_cache/`; `python -m sportsan.tracking.reid --match <id>` mide el AUC por alto de caja (`revision/reid_auc.md`); `links_eval`/`anchors --reid classic --reid-hmin <px>` la añaden como variable opcional. Informe: `revision/reid.md` | sí |
| `tracking/links_eval.py` | Mide la fase 1 contra lo corregido a mano (`labels_*.json`): `python -m sportsan.tracking.links_eval --match <id> --train v1 --test <partes>`. Escribe `tracking/revision/union_f1.md` y `tracking/link_model.json` (~8 min en la laptop) | sí |
| `tracking/anchors.py` | Fase 3 de la unión: anclas (cadena, jugadora) y relleno entre anclas con asignación húngara por ventanas, todas las jugadoras a la vez; simula 1-3 anclas/min desde `labels_*.json` y mide pureza, dudas y horas: `python -m sportsan.tracking.anchors --match <id> --feet [--p-min 0.9]`. Escribe `tracking/revision/anclas_f3.md` | sí |
| `tracking/anchors_cli.py` | Modo real de `anchors` (sin labels): `python -m sportsan.tracking.anchors suggest --match <id> --part <parte> [--per-min 1-5 | hybrid [--near 2 --center 3 --far 4]]` escribe `tracking/auto/suggest_<parte>.json` (cadenas, sugerencias de anclas y `available` por densidad, más `hybrid` y `zones`; «hybrid» = cuota por franja de la cancha respecto a la cámara: cercana/centro/lejana, la portería pide 2; `coverage --rates 3,4,hybrid` lo simula); `... fill --match <id> --part <parte>` lee `auto/anchors_<parte>.json` (de la app) y escribe `auto/links_<parte>.json` (identidades, dudas, cobertura). Usa `link_model.json`; avance en `revision/progreso_<tarea>_<parte>.log` | sí |
| `tracking/doubles.py`, `tracking/doubles_eval.py` | Segunda pasada de `fill`: resuelve las dobles cajas (dos cajas de una jugadora en el mismo cuadro) con una ruta por programación dinámica que solo elige con margen calibrado (≥ 95 % de acierto); si no, quita las dos cajas del solape (≤ 4 s) o deja la duda `dos_sitios`. Salen en `links_<parte>.json` como `drops` (la app las aplica como cajas quitadas, deshacibles). Aún no es seguro: baja la cobertura (ver informe). Medición contra labels: `python -m sportsan.tracking.doubles_eval --match <id>`, informe en `tracking/revision/dobles_cajas.md` | sí |
| Dudas con cajas (`anchors_cli.RESOLUTION`, `not_player_chains`) | Cada duda de `links_<parte>[_exp].json` lleva `boxes` (cuadro, track, jugadora, papel `antes/despues/a/b/candidata`, `t`, `chain`), `jump` (salto), `t0/t1` (hueco_largo, sin_nombre) y, en salto/dos_sitios/union_dudosa, `resolution{options,default}`. Un ancla con `player:"__no__"` en `anchors_<parte>.json` marca la cadena (y las que comparten su track) como «no es jugadora»: fill y suggest la ignoran; las saltadas no se envían (solo viven en el navegador) | sí |
| `fill --variant exp` (`anchors_cli.exp_passes`, `doubles.jump_pass/holes_pass/measure`) | Variante B (experimento, no sustituye a A): relleno con exclusión (una jugadora no recibe dos cadenas solapadas), después dobles cajas (`exclusion`/`ruta`/`ambas`), saltos imposibles (excursiones ≤ 0.8 s fuera, `salto`) y huecos ≤ 4 s interpolados. Escribe `auto/links_<parte>_exp.json` (nunca pisa `links_<parte>.json`) con `variant` y `passes`; avance en `revision/progreso_fill_<parte>_exp.log`; comparación en `tracking/revision/experimento_b.md` | sí |
| `tracking/coverage.py` | Cobertura por parte y por jugadora (segundos con su identidad correcta, errores, huecos por duración y por fuera de cuadro) y tiempo de la analista a 90 min (anclas × 2 s + revisión × 3 s) sobre la salida de `anchors`: `python -m sportsan.tracking.coverage --match <id>`. Escribe `tracking/revision/cobertura.md` | sí |
| `tracking/priors.py` | F4 de la unión: términos de costo aprendidos de formación (posición relativa a la forma del equipo, por jugadora y por zona del balón) y de balón revisado (nunca el tracker), como variables opcionales del modelo de unión (`prior_features`). `python -m sportsan.tracking.priors --match <id>` compara base / +formación / +formación+balón y escribe `tracking/revision/priors_f4.md` | sí |
| `tracking/team_seq.py` | F4b de la unión: red pequeña (torch CPU) que predice dónde debería estar cada jugadora propia (media + varianza) a partir de su rol (formación dada o rol aprendido de sus anclas), la forma de los dos equipos y los últimos 5 s del balón revisado; costo de Mahalanobis para el relleno de `anchors.py` (`extra_cost`). `python -m sportsan.tracking.team_seq --match <id>` escribe `tracking/revision/secuencias_f4b.md` | sí |
| `tracking/links_review.py` | Muestra a ciegas de uniones dudosas (cuadros con las dos cajas, `index.html` con respuestas): `python -m sportsan.tracking.links_review --match <id>` → `tracking/revision/muestra_uniones/` | sí |
| `tracking/jumps_review.py` | Muestra de saltos imposibles con el patrón que propone una regla (pico, lo malo era antes, prolongado), para revisarla en la app en `/revision`: `python -m sportsan.tracking.jumps_review --match <id>` → `tracking/revision/saltos/` | sí |
| `tracking/feet_review.py` | Muestra para revisar la corrección de pies (`feet.py`, hoy apagada con `FEET_CORRECTION = False`): pies movidos lejos de saltos y cajas que «bailan» con la alternativa de altura mediana; se responde en `/revision/pies`: `python -m sportsan.tracking.feet_review --match <id>` | sí |
| `tracking/refine.py` | Refina una parte ya procesada sin detectar de nuevo: pies corregidos y homografía suavizada en el tiempo (6 puntos fijos, mediana + Savitzky-Golay ~0.7 s, sin cruzar cortes). `python -m sportsan.tracking.refine --match <id> --part <parte> [--out <ruta>] [--no-feet] [--no-smooth-h]`; en sitio deja `tracks_<parte>.pre_refine.json` y regenera el parquet; idempotente (`"refined"` en el JSON). También desde la app: Anclas › «Aplicar pies y calibración suavizada a esta parte» (`task: "refine"` en `web/lib/runTask.ts`). `process` ya suaviza por defecto (`SMOOTH_H`). Medición: `tracking/revision/refine.md` | sí |
| `tracking/ball.py` | Tracker de balón: candidatos (manchas blancas en la cancha), red pequeña entrenada con tus marcas a mano, acepta solo con apoyo de los cuadros vecinos y sin saltos imposibles; `train`, `run`, `eval`. `run` escribe el avance en `tracking/revision/progreso_ball_<parte>.log`; en la app, el botón «Detectar balón automáticamente» (vista Balón, `task: "ball"` en `app/api/run/anchors`) lo lanza y recarga `ball_auto_*.json` como marcas automáticas | sí |
| `tracking/evaluate.py` | Mide cuánto trabajo de corrección deja cada método de unión, contra `labels_*.json` | sí |
| `tracking/botsort_pitch.yaml` | Parámetros del seguidor | no |
| `tracking/geometry.py`, `models.py`, `pipeline.py`, `run_tracking.py` | Pipeline antiguo (Colab, homografía automática). No se usa | no |
| `metrics/team_shape.py`, `metrics/team_blocks.py` | Forma de cada equipo (ancho, largo, altura de línea y bloque) | no |
| `metrics/report.py` | Escribe `team_metrics_<video>.json` para la pestaña Análisis | sí |
| `cloud/kaggle.py` | Procesar en Kaggle desde la laptop: qué videos faltan (el plan de `overnight`), empaquetar, subir, lanzar, esperar y bajar | sí |
| `cloud/kaggle_job.py` | Lo que corre dentro de Kaggle: arma el repositorio, cambia el detector OpenVINO por su `.pt` (GPU), corre `overnight` con tope de tiempo y deja lo nuevo para bajar | no (lo sube `kaggle.py`) |
| `clips/geometry.py` | Dibujos de un clip igual que en la app: anclas, pausas (`frame_plan`), proyección, regla de 1 s, rótulos | no |
| `clips/render.py` | Exporta a MP4 un clip editado o una jugada del pizarrón (OpenCV + Pillow + ffmpeg), perfiles `charla` y `whatsapp` | sí |
| `clips/cut_clips.py` | Clips del informe: renderiza los que tienen edición y corta los demás | sí |
| `mock/generate.py` | Datos falsos para probar | sí |

Constantes del tracking que quizá quieras ajustar: en `stitch.py`, `MAX_GAP_S` (3), `MAX_OFFSCREEN_S` (10), `MAX_SPEED_MS` (8),
`DUPLICATE_M` (1.2), `MIN_LINK_S` (1); en `team.py`, `MAX_COLOR_DISTANCE` (40), `TEAM_MARGIN` (1.3); en `botsort_pitch.yaml`,
`new_track_thresh` (0.3) y `track_buffer` (90); en `ball.py`, `ACCEPT_P` (0.90), `SUPPORT_MIN` (2), `BALL_MAX_MS` (35); en
`match.yaml`, `analysis_stride` (3 = 1 de cada 3 cuadros) y `detector` (modelo, trozos, franja).

**Por qué el tracker de balón se entrena con todas las marcas y busca en toda la cancha** (medido el 2026-10-18 en dos partes de
`partido_2026_09_25` no usadas al entrenar): así acierta el 94 % de lo que marca y pide la mitad de marcas que sin él. Entrenar solo
con el balón a los pies de una jugadora salió mucho peor: ahí se confunde con medias y botines blancos, y se pierde la mitad de los
ejemplos. Por la cámara: el modelo solo conoce las cámaras con las que se entrenó; en una cámara nueva, revisa a mano un tramo
mediano y vuelve a entrenar.

## 7. Flujos completos, paso a paso

El mismo recorrido, con diagrama, en `docs/guia_analisis.html`.

### 7.1 Etiquetar un partido (no necesita tracking)

1. App → Análisis con video → Nuevo video (nuestro, rival o referencia) con el enlace de YouTube, o abrir uno ya creado.
2. Pestaña Tramos (`G` juego, `P` pausa, `X` no medible, `E` fin): se guarda `segments.csv` en la carpeta del partido.
3. Pestaña Etiquetado, pasada 1: tipo y equipo con teclas mientras corre el video (las pausas se saltan solas). `J` guarda el momento como jugada. Un gol se marca como gol y, si hubo tiro, también el tiro (cuentan una vez).
4. Pasada 2: uno por uno, posición, jugadora, resultado, detalle y nota.
5. Pasada 3: tiros sobre la portería, centros y córners donde cayeron (un tiro bloqueado no lo pide).
6. Pestañas Análisis e Informe: se llenan solas.

### 7.2 De video a posiciones

1. Añadir el video a `matches/videos.csv` y `python -m sportsan.ingest.download_videos`.
2. App → partido → Calibración: sede (Configuración si es nueva) y anclas en un barrido de lado a lado → Exportar (`anchors_*.json`).
3. Pestaña Tramos marcada (paso 2 de 7.1) y colores en Tracking → Uniformes.
4. `python -m sportsan.tracking.overnight --plan` y luego sin `--plan`: propagación, biblioteca y `process` de todo lo que falte (de noche). Una parte por tramo de juego; reanudable.
5. App → partido → Calibración → «De la carpeta» → una parte, para comprobar que la cancha calza.

### 7.3 Corregir: jugadoras y balón

1. Pestaña Tracking → abrir una parte (se lee de la carpeta).
2. Revisión rápida → aplicar a la mesa. Luego **Anomalías**: corregir nombres que saltaron.
3. Jugadoras: verificar (✓) al menos 10; unir, partir, marcar a mano donde se pierden.
4. Balón: revisar a mano un tramo mediano y Guardar. Entrenar (`python -m sportsan.tracking.ball train`) y correr (`... run --match <id>`) para el resto; en la vista Balón, `n` lleva a donde pide marca y `a` a los saltos imposibles.
5. «Guardar»: `tracks_fixed_*.json` y `labels_*.json` en la carpeta. Análisis e Informe leen de ahí.

### 7.4 Informe, clips y pizarrón

1. Informe: revisar cifras, escribir textos, «Sin nombres» si sale del cuerpo técnico; Imprimir / guardar PDF.
2. Jugadas: «Dibujar sobre el clip» para las clave; Presentar en la charla; `python -m sportsan.clips.render` para WhatsApp.
3. «Exportar lista de clips» y `python -m sportsan.clips.cut_clips` para todos los clips del informe.
4. Pizarrón: ABP propias o «Pasar al pizarrón» desde una jugada; láminas impresas o animación.

### 7.5 Sesiones de Strava

1. Una vez: crear la aplicación en `strava.com/settings/api` con "Authorization Callback Domain" = `localhost`.
2. Una vez: `python -m sportsan.ingest.strava_sync auth --client-id <id> --client-secret <secreto>`.
3. Primera descarga: `python -m sportsan.ingest.strava_sync sync --after 2026-08-01`; después, `sync` baja solo lo nuevo.
4. App → Sesiones → importar `data/strava/sessions.csv`.

## 8. Documentación (`docs/`)

| Archivo | Para qué abrirlo |
|---|---|
| `mapa_del_repo.md` | Este mapa |
| `guia_analisis.html` | El recorrido de un partido con diagrama (ábrelo en el navegador) |
| `data_contract.md` | Formato exacto de cada tabla y archivo. Fuente de verdad |
| `architecture.md` | Qué es el producto, flujo general, decisiones ya tomadas, plan de base de datos |
| `roadmap.md` | Orden de trabajo y todas las mediciones hechas (errores de calibración, tiempos, conteos) |
| `preguntas_cuerpo_tecnico.md` | Las preguntas del cuerpo técnico, el catálogo de eventos y los cuestionarios |
| `propuesta_union_tracks.md` | Borrador: modelo para unir tracks con mínima intervención (trozos puros, unión local, anclas y relleno, verificación), con lo medido en la corrección del partido 1 |
| `propuesta_investigacion.md` | Propuesta de investigación |
| `referencias.md` | Fuentes |
| `parallel_workflow.md` | Cómo usar varios agentes de Claude a la vez |

## 9. Recetas

**Descargar un video a mano** (desde `demo/`; lo normal es `download_videos`):

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
| Qué sale en el informe y qué fuente pide cada sección | `web/lib/report.ts` |
| Umbrales de movimiento imposible | `web/lib/anomalies.ts` (y `BALL_MAX_MS` en `src/sportsan/tracking/ball.py`) |
| Qué tan seguro debe estar el tracker de balón | `--accept` de `ball run`, o `ACCEPT_P` en `src/sportsan/tracking/ball.py` |
| Umbrales de carga y ACWR | `web/lib/load.ts` |
| Medidas o marcas de una sede | App → Configuración (o `BUILTIN_SPECS` en `web/lib/venue.ts`) |
| Colores de uniforme | pestaña Tracking → Uniformes, o `jersey_colors` en `match.yaml` |
| Tapar marcador y logo | Calibración › botón de selección (arrastra sobre el video, clic quita, «Guardar en match.yaml»), o `mask: [[x0, y0, x1, y1], ...]` en el video de `match.yaml` (píxeles de ese video): biblioteca, propagación y process no miran ahí y process descarta cajas dentro; la biblioteca lo guarda |
| Cuántos cuadros se procesan | `analysis_stride` en `match.yaml`, o `--stride` |
| Qué partido usan los comandos | `default_match` en `config/project.yaml`, o `--match` |
| Reglas para unir trozos en la mesa | constantes de `web/lib/tracks.ts` (5.5) |
| Reglas del suavizado | Exportar… → Suavizado, o `SMOOTH_DEFAULTS` en `web/lib/smooth.ts` |
| Añadir una parte de video | una fila en `matches/videos.csv` y `download_videos`; en la app, añadir el video en el partido |

**Algo no funciona**

| Síntoma | Causa habitual |
|---|---|
| `No module named sportsan` | No estás en `demo/` o falta activar `.venv` |
| `npm` no encuentra `package.json` | No estás en `demo/web/` |
| La app aparece vacía | Otro navegador o perfil: los datos viven en cada navegador. Importa tu respaldo |
| `process` dice que falta la biblioteca | No existe `library_<video>.npz`: anclas exportadas y `overnight` (o `propagate` + `library build`) |
| `process` no sabe qué procesar | Falta `segments.csv` en la carpeta del partido; o pasa `--start` y `--end` |
| `process` va mucho más lento que de costumbre | Hay otro proceso pesado corriendo a la vez (otro `process`, `ball`, `render`): se reparten los núcleos |
| No aparece el archivo de una parte | `process` escribe cada parte al terminarla; en un tramo largo con el detector grande tarda |
| Falla la descarga de pesos o de git | Certificados de esta computadora: usar `C:\Windows\System32\curl.exe -L` y `git -c http.sslBackend=schannel` |
| Las correcciones siguen ahí tras recargar | Es lo esperado: se quitan con «Restablecer…» |
| El tracker de balón no marca casi nada | El modelo no conoce esa cámara: revisa a mano un tramo y vuelve a entrenar; o baja `--accept` (más errores) |
