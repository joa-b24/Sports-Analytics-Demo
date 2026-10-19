# Arquitectura

Orden de trabajo y criterios de avance: `docs/roadmap.md`.

## Qué es el producto

Una app para el cuerpo técnico con cuatro usos:

| Sección | Para qué | Datos que usa |
|---|---|---|
| Rivales (análisis previo) | Preparar el partido contra un rival | Video del rival + eventos etiquetados a mano |
| Nuestros partidos (post-partido) | Revisar nuestros juegos | Video propio + eventos (+ tracking cuando sirva) |
| Entrenamientos | Carga de trabajo por jugadora | CSV de sensores |
| Calibración | Relacionar la imagen del video con la cancha | Archivo local del video + puntos de referencia de la sede |
| Datos | Cargar, exportar, respaldar | Todo lo anterior |

Dentro de cada partido: video y etiquetado, jugadas con animación de cancha, análisis (gráficos) e informe imprimible.

## Un partido, una carpeta

```
matches/<match_id>/
  match.yaml        datos del partido, sede (medidas reales) y lista de videos
  segments.csv      tramos de juego
  video/            video original, uno por parte (v1, v2...)   no se versiona
  segments/         segmentos cortados                          no se versiona
  tracking/         parquets de tracking, balón y calibración   no se versiona
  events/           parquets de eventos
```

`config/project.yaml` solo guarda lo global y el partido por defecto. Los comandos aceptan `--match <match_id>`; el código lee todo con `sportsan.config.load_config(match=...)`.

## Flujo

```
video YouTube (original, no se edita)
   │
   ├──────────────► app web (web/, Next.js): etiquetado manual, jugadas, animación, informe
   │  yt-dlp
   ▼
matches/<id>/video/v1.mp4 ──► segments.csv ──► segments/s01.mp4 ...
   │                                   │
   │  app web · Calibración            │  detección y seguimiento (YOLO + BoT-SORT, OpenVINO en la laptop)
   ▼                                   ▼
anclas (puntos de referencia        detecciones y tracks (px, py)
por cuadro, a mano)                    │
   │  propagación entre anclas         │
   └──────────────┬────────────────────┘
                  ▼
     posiciones en la cancha (process) → revisión rápida y corrección en la app (+ tracker de balón)
                  ▼
     tracks_fixed → análisis, informe por niveles, jugadas, clips y pizarrón
```

El etiquetado manual y el tracking son caminos independientes que comparten el tiempo del video original (`t_video`). La app funciona completa sin tracking.

## Frentes de trabajo

Cada frente es dueño de su carpeta y se comunica con los demás solo a través del contrato (`docs/data_contract.md`).

| Frente | Carpeta | Entrada | Salida |
|---|---|---|---|
| A. Ingesta | `src/sportsan/ingest/`, `src/sportsan/config.py` | video + `segments.csv` | `matches/<id>/segments/*.mp4` |
| B. Tracking | `src/sportsan/tracking/`, `notebooks/` | segmentos + anclas | parquets de tracking, balón y calibración |
| C. Métricas | `src/sportsan/metrics/` | DataFrames del contrato | DataFrames/matrices |
| D. App web | `web/` | eventos, jugadas, sesiones, anclas (y exportes de B/C) | UI |
| E. Clips | `src/sportsan/clips/` | ediciones de clip (`edits/edit_*.json`), jugadas del pizarrón (`data/boards/`), `clips_<match_id>.json` y el video | MP4 en `matches/<id>/clips/` y `clips/` |

`app/` (Streamlit) queda como referencia y no se sigue desarrollando.

## Datos y backend: plan por fases

**Fase 1 (actual): sin servidor.** Los datos de la app viven en el navegador (`localStorage`) y se mueven con exportar/importar. Todo el acceso está en `web/lib/store.ts`.

**Fase 2: base de datos compartida.** Dos almacenes, cada uno para lo que hace bien:

| Qué | Dónde | Por qué |
|---|---|---|
| Lo relacional: equipos, plantilla, sedes, partidos, videos, eventos, jugadas, anclas, sesiones, correcciones de tracks | **Postgres** (Supabase: incluye autenticación, API REST generada y seguridad por filas) | Son miles de filas por partido, con relaciones, ediciones concurrentes y permisos |
| Las posiciones: ~1 millón de filas por partido | **Parquet en almacenamiento de objetos**, un archivo por partido y video, con el esquema del contrato | Es un dato que se escribe una vez y se lee en bloque. En columnas y comprimido, un partido ocupa del orden de 10 a 20 MB; como filas de Postgres con índices, más de 100 MB |

Cómo se leen las posiciones:
- **La app** no carga el partido entero: pide el tramo que muestra (una jugada) como un archivo pequeño generado por el pipeline, o consulta el parquet directamente desde el navegador con DuckDB-WASM.
- **El análisis** (Python) lee los parquets con pandas o DuckDB; una temporada completa cabe en una laptop.
- La tabla `tracks` de Postgres guarda solo el índice: partido, video, rango de tiempo, ruta del archivo y versión.

Esto escala por temporadas sin cambiar de diseño. Si más adelante hiciera falta consultar posiciones con SQL en el servidor, el paso es una tabla particionada por partido en un Postgres propio; como el esquema es el mismo del contrato, la migración es mecánica.

Por verificar antes de adoptarlo: los límites vigentes del plan gratuito (tamaño de base y de almacenamiento, y si pausa proyectos inactivos). Exportar e importar se conserva como respaldo.

Tablas de Postgres previstas (se fijan en el contrato v2): `teams`, `players`, `venues`, `matches`, `videos`, `events`, `plays`, `anchors`, `track_corrections`, `tracks`, `sessions`. Seguridad por filas: cada usuario solo ve los datos de su equipo.

**Fase 3: resultados del pipeline.** Python sigue corriendo por lotes. Al terminar, sube los parquets y registra la fila en `tracks`. No hay servidor Python permanente.

## Decisiones tomadas

- **Calibración por anclas** (2026-10-09): una persona marca puntos de referencia en algunos cuadros y la homografía se propaga entre ellos siguiendo el movimiento de la cámara. Sustituye al detector automático de puntos de cancha de `roboflow/sports`, que no sirve en canchas con líneas de varios deportes. La homografía se calcula en el navegador (`web/lib/homography.ts`).
- **Cada sede tiene su modelo de referencia** con medidas reales (`web/lib/venue.ts`). Las posiciones se guardan normalizadas a 105x68; las medidas reales sirven para convertir distancias y velocidades.
- **Python produce píxeles; la app produce metros** (2026-10-09). El pipeline entrega detecciones y tracks en píxeles; la calibración y las correcciones se hacen en la app. *Cambió el 2026-10-14:* con la biblioteca de calibración, `process` ya calcula las posiciones en la cancha; la app sigue siendo donde se corrige y se nombra.
- **Un partido por carpeta** (2026-10-09), con uno o más videos por partido.
- **Posiciones en parquet, lo relacional en Postgres** (2026-10-09). Ver arriba.
- Detección y seguimiento con YOLO (Ultralytics) + BoT-SORT, en la laptop con OpenVINO (CPU). Con cámaras amplias, modelo mediano por trozos y solo en la franja de la cancha (`detector` en `match.yaml`). Colab o Kaggle quedan como opción para acelerar (necesitaría PyTorch con CUDA en vez de OpenVINO).
- Lo que no se ve en cuadro no está ausente: las métricas declaran siempre qué parte de la cancha era visible. Se prefiere `NaN` a una posición falsa.
- `track_id` es local al segmento; el equipo se decide por apariencia y la identidad (`player_id`) se asigna a mano.
- Sin servicios de IA de pago. Solo modelos pequeños que corren en la laptop: el detector de jugadoras y el tracker de balón (`sportsan.tracking.ball`, 2026-10-18), entrenado con las marcas a mano del propio proyecto.
- **Lo automático solo marca cuando está muy seguro** (2026-10-18): el tracker de balón y la revisión rápida dejan huecos que la analista completa, y un detector de movimientos imposibles (`web/lib/anomalies.ts`) señala lo que se coló. Un error silencioso es peor que un hueco.
- Etiquetado manual de eventos obligatorio en el MVP.
- Todo gratuito. No se aloja video: YouTube embebido o archivo local.
- **Interfaz en Next.js (`web/`), no en Streamlit** (2026-10-04).
- **La app sirve completa solo con eventos manuales** (2026-10-04). El tracking es una capa adicional.
- **La animación de cancha admite keyframes manuales.** Son un esquema dibujado por la analista, no una medición, y la UI lo dice.

## Fuera de alcance por ahora

Multiusuario y autenticación (fase 2), reconocimiento de jugadoras por rostro. (Las redes de pase y el balón ya salen del tracking, con revisión a mano.)
