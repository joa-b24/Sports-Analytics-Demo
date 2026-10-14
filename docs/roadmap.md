# Hoja de ruta

Aprobada el 2026-10-09. Reemplaza el "orden recomendado" de `docs/parallel_workflow.md`. Las decisiones que resultan de ella ya están en `docs/architecture.md`.

## Video de trabajo (actualizado 2026-10-09)

El video de trabajo pasa a ser **nuestro último partido**, en el Estadio La Cueva del León: toma amplia, más alta y de mejor calidad. El video del rival (sección siguiente) queda como caso difícil para probar más adelante. Carpeta: `matches/partido_2026_09_25/` (primer tiempo en `video/v1.mp4`, 1080p, 29.97 fps, 44:31).

**Qué hay en la cancha.** Es un campo de fútbol americano con las líneas de fútbol pintadas encima, más tenues.

| Medida | Valor | De dónde sale |
|---|---|---|
| Escala de la imagen | 8.2 px/m | Barra de 20 m = 164 px |
| Campo de americano, borde gris exterior | ~111 x 52 m medidos | Esperado para un campo reglamentario con su borde: ~113 x 52 m. Diferencia de 2 %, dentro del error de medir sobre una captura |
| Cancha de fútbol | **100 x 65 m** | Medida por la analista sobre la imagen satelital |

**Qué se ve en el video** (cuadros de los minutos 1, 7, 15, 25, 35 y 43):

| Observación | Consecuencia |
|---|---|
| Cámara elevada a la altura de media cancha, movida a mano; sin red ni obstáculos | Entre cuadros la imagen cambia por giro y zoom: es el caso favorable para propagar la calibración |
| Rejilla de americano nítida: líneas cada 5 yardas, números, marcas | Decenas de puntos de referencia en cualquier encuadre |
| Las líneas de fútbol son **amarillas** (círculo central, áreas, bandas) | Se distinguen bien de la rejilla blanca |
| La banda cercana a veces queda fuera por abajo, y nunca se ve la cancha entera | Lo que no sale en cuadro no se mide; sigue valiendo la regla de declarar qué era visible |
| Equipos de azul y de negro; árbitra de amarillo | Fáciles de separar por color |
| Jugadoras de 40 a 60 px de alto | Un detector genérico de personas debería bastar |

**La rejilla de americano es la referencia de calibración.** Sus medidas son reglamentarias y exactas: líneas cada 5 yardas (4.572 m), 100 yardas entre líneas de gol (91.44 m), zonas de anotación de 10 yardas y 160 pies de ancho (48.77 m). Eso da decenas de cruces de posición conocida, visibles en cualquier encuadre. Cambia el paso A2:

1. Se calibra con la rejilla de americano (cruces de líneas de yarda con las laterales, números y marcas).
2. Con unos pocos frames bien calibrados se proyectan las esquinas, áreas y círculo de la cancha de fútbol, y así se obtienen sus medidas reales desde el propio video.
3. De ahí sale la transformación fija rejilla → cancha de fútbol normalizada (105x68) que usa el resto de la app.

**Primera comprobación con un cuadro real (minuto 15).** Leí a mano 17 cruces de líneas de yarda con las dos bandas y ajusté la homografía con el código de la app:

| Qué | Resultado |
|---|---|
| Error de ajuste (RMS) | 0.18 m |
| Peor error dejando un punto fuera | 0.53 m |
| Extremo derecho del círculo central (no usado en el ajuste) | Sale en (59.28, 32.62) m; lo esperado es (59.15, 32.5). Diferencia: 0.18 m |
| Marcas interiores lejanas | A 16.4–16.6 m de la banda lejana (tres lecturas) |
| Marcas interiores cercanas | A 19.5 m de la banda cercana (tres lecturas) |

La rejilla a lo largo y el círculo central calzan con el modelo. Las marcas interiores **no** están donde supuse (18.29 m de cada banda) ni son simétricas, así que algo del modelo a lo ancho no está entendido todavía: puede ser el estándar con que se pintaron, qué borde de la franja blanca es la línea, o que la cancha de fútbol no esté centrada. Hasta aclararlo, las marcas interiores no se usan para calibrar (en la app salen apagadas). Es una sola imagen leída a ojo: se confirma en A2 con varios cuadros.

Consecuencia para un detector automático: las líneas de americano son mucho más marcadas que las de fútbol, así que un modelo de puntos de cancha entrenado con fútbol fallará aquí también. La calibración por anclas sigue siendo el camino, y con esta rejilla es más fácil y más precisa que en la sede anterior.

## Punto de partida: qué se ve en el video del rival (primer video)

Revisé frames de `s05`, `s13` y `s17` (1920x1080, 60 fps, ~4.5 Mbps). Lo que condiciona el plan:

| Observación | Consecuencia |
|---|---|
| La cámara graba **detrás de una red** y con un **poste** en cuadro | Textura de rombos sobre toda la imagen y oclusión vertical fija: los modelos entrenados con transmisiones no vieron nada parecido |
| Cámara **baja y lateral** | Ángulo muy rasante: las jugadoras lejanas miden ~25 px y se tapan entre sí; el error en metros crece con la distancia |
| Líneas **amarillas** de canchas transversales, tan marcadas como las blancas | Confirma la hipótesis: un detector automático de puntos de cancha no tiene cómo distinguirlas |
| La cancha **parece más chica que 105x68** | El contrato asume 105x68. Hay que medir la cancha real antes de calcular distancias o velocidades |
| Marcador y logo sobreimpresos | Hay que enmascararlos; el reloj del marcador sirve para sincronizar periodos |
| Público y banca detrás de la banda lejana | Detecciones falsas fuera de la cancha (se filtran cuando la calibración es buena) |
| Equipos: blanco contra rayas azul y blanco; árbitro en celeste | Separables por color, pero mejor con muestras elegidas a mano que con clustering automático |

Conclusión: el modelo de puntos de cancha de `roboflow/sports` no es recuperable para esta sede sin reentrenarlo. En cambio, una persona sí ve 4 o más puntos de referencia en casi cualquier frame. El plan se apoya en eso.

## Cambio de enfoque

1. **La unidad de tracking es la jugada (10 a 20 s), no el segmento.** La analista ya marca jugadas en la app; solo esas se miden. Así el trabajo manual es acotado y no hace falta GPU para partidos completos.
2. **Calibración semiautomática:** la persona fija la homografía en unos pocos frames (anclas) y el programa la propaga entre anclas siguiendo el movimiento de la cámara.
3. **Python produce píxeles; la app produce metros.** El pipeline entrega detecciones y tracks en píxeles (`px`, `py`, ya previstos en el contrato). La calibración y las correcciones se hacen en la app, y de ahí salen las posiciones en metros.
4. **Diseño y métricas definen el contrato, no al revés.** El contrato v2 se congela cuando esas dos líneas dicen qué datos necesitan; la base de datos se crea después.

## Fase 0. Base (1 a 2 días)

- **Git:** la carpeta `demo/` no tiene repositorio propio; el `.git` que se detecta está en `C:\` y no tiene commits. Hoy nada está versionado. Crear el repo dentro de `demo/`.
- **Medir la cancha real:** hecho (100 x 65 m); los detalles a lo ancho se confirman en A2.
- **Varios partidos:** hecho. Una carpeta por partido en `matches/<match_id>/`.
- **Banco de pruebas fijo:** 3 jugadas de 15 s (una cerca de la cámara, una lejos, una con paneo rápido) y ~20 frames sueltos. Todo cambio de tracking se evalúa contra este mismo banco.
- **Desplegar `web/` en Vercel tal como está** (sigue con `localStorage`). No depende de nada y permite que el cuerpo técnico la vea.

## Línea A. Cancha, jugadoras y tracking (propuestas 1 y 3)

Cada paso tiene un entregable que se puede usar aunque el siguiente falle.

| Paso | Qué se construye | Dónde | Listo cuando |
|---|---|---|---|
| A1. Calibrar un frame a mano (**construido**, falta probarlo en el navegador) | Pantalla "Calibración": se carga el clip local, se hace clic en puntos de referencia y se elige a cuál corresponde cada uno en el esquema de la cancha. La homografía se calcula en el navegador y la cancha se dibuja reproyectada sobre el frame para ver si calza | `web/` | Error < 1.5 m en puntos de control que no se usaron para ajustar, en los 20 frames del banco |
| A2. Modelo de cancha de la sede | Catálogo de puntos de referencia con sus coordenadas: líneas blancas y también cruces de líneas amarillas (dejan de ser un estorbo y pasan a ser referencias) | contrato + `web/` | Cualquier frame del banco tiene al menos 4 puntos visibles no colineales |
| A3. Propagar entre anclas (**primera versión construida**, falta probarla con anclas reales) | Estimación del movimiento de cámara frame a frame (OpenCV en CPU, enmascarando jugadoras, marcador y poste) encadenada desde cada ancla; entre dos anclas se mezclan la propagación hacia adelante y hacia atrás | `src/sportsan/tracking/` | En una jugada de 15 s bastan 3 a 5 anclas para mantener el error < 2 m |
| A4. Detección y tracks en píxeles (**primera versión construida**, en la laptop) | YOLO + ByteTrack sobre el clip, sin homografía. Equipos por muestras de color elegidas a mano (clic en 3 a 5 jugadoras por equipo). Probar primero un detector genérico de personas a 1280 px | `src/sportsan/tracking/` (Colab, o CPU para clips cortos) | Informe por clip: % de jugadoras detectadas y nº de cambios de identidad, contados a mano en el banco |
| A5. Mesa de corrección (**primera versión construida**, falta medir cuánto se tarda) | Sobre el video con los tracks dibujados: unir y partir tracks, borrar falsos, cambiar equipo, asignar `player_id`, marcar el balón a mano en keyframes | `web/` | Una jugada de 15 s queda corregida en un tiempo que la analista considere aceptable (se mide) |
| A6. Salida medida | Tracks corregidos + calibración → posiciones en metros → keyframes de la animación, rotulados como **medidos** y no como esquema | `web/` + validación en `schema.py` | La animación de una jugada del banco coincide con el video |

Notas:
- La mesa de corrección necesita el **archivo local** del clip: con el reproductor de YouTube no se puede avanzar frame a frame con precisión. El resto de la app sigue con YouTube.
- El balón queda manual. Es de pocos píxeles y está detrás de la red; automatizarlo no es prioridad.
- A1 y A2 ya dan valor solos: permiten ubicar eventos con clic sobre el video en vez de sobre el esquema.
- **Criterio de corte:** si tras A3 hacen falta más de ~8 anclas por jugada, o tras A5 corregir una jugada toma más que dibujarla a mano, el tracking se queda en línea de investigación y la animación sigue con keyframes manuales (que ya funcionan). Los umbrales exactos se fijan al medir el banco.
- Mejora posterior, solo si A3 deriva demasiado: como la cámara física está fija, el encuadre se puede modelar con paneo, inclinación y zoom (3 parámetros en vez de 8), lo que es más estable.

## Línea B. Metodología de métricas y gráficos (propuesta 2)

Se parte de preguntas del cuerpo técnico, no de la lista de métricas posibles. El borrador de preguntas, el catálogo de eventos propuesto y los cuestionarios del auxiliar están en `docs/preguntas_cuerpo_tecnico.md` (2026-10-11), pendientes de revisar con el cuerpo técnico.

1. **Levantar preguntas** con el cuerpo técnico, ordenadas por momento del juego: ataque organizado, transición defensiva, defensa organizada, transición ofensiva y balón parado. Meta: 3 a 5 preguntas por momento, separando rival y partido propio.
2. **Una ficha por métrica** en `docs/metricas/`: pregunta que responde, definición exacta, datos que exige, gráfico, límites de validez (encuadre, tamaño de muestra) y cómo se prueba.
3. **Clasificar por fuente de datos:**

| Nivel | Fuente | Ejemplos | Estado |
|---|---|---|---|
| 1 | Eventos actuales | Conteos por tipo, mapa de tiros, zonas de recuperación y pérdida | Hecho |
| 1b | Eventos con catálogo ampliado | Secuencias de posesión (cómo empieza y cómo termina), resultado del balón parado, altura de recuperación, evolución por tramos de 5 a 10 min | Requiere ampliar el contrato; cuesta tiempo de etiquetado |
| 2 | Tracking por jugada | Ancho, largo y altura de la línea en el instante de un evento; superioridad numérica cerca del balón; distancia entre líneas | Depende de la línea A; solo vale dentro del encuadre |
| No viable | Tracking de partido completo | Distancia total, mapas de calor por jugadora, control de espacio agregado | La carga física se cubre con los sensores |

4. **Validar antes de mostrar:** dos personas etiquetan el mismo tramo y se mide la concordancia; se mide el tiempo de etiquetado por partido. Un tipo de evento en el que no hay acuerdo sale del catálogo.
5. **Regla de gráficos:** cada gráfico responde una pregunta de la lista y muestra el tamaño de muestra; lo que no responde ninguna pregunta no entra a la app.

## Línea C. Diseño y secciones (propuesta 4)

Hoy `web/app/globals.css` solo define fondo y texto; los colores están repartidos por los componentes.

- **Inventario de pantallas** con una matriz pantalla × dato que necesita. Esa matriz es el insumo del contrato v2.
- **Tokens de color en un solo lugar:** superficies, texto, equipo analizado, contrario, balón, cancha y estados. La pareja de colores de equipos tiene que distinguirse sobre la cancha, con daltonismo y en el informe impreso en gris. Evaluar una cancha neutra (no verde saturado) para que resalten las marcas.
- **Etiquetas de procedencia como parte del sistema:** "datos de ejemplo", "esquema dibujado", "medido", "fuera de encuadre".
- **Entregable:** `docs/design.md` con tokens, tipografía, componentes y bocetos de cada sección, antes de rehacer pantallas.

## Convergencia: contrato v2 (propuesta 5)

Se redacta cuando A1 y A2, la línea B y la matriz de la línea C están listos. Cambios previstos:

- `venues`: medidas reales de la cancha y catálogo de puntos de referencia.
- `calib_anchors`: por jugada, frame y pares (punto de referencia, píxel).
- Paquete de tracking por jugada (JSON): detecciones en píxeles y movimiento de cámara. Es la entrada de la mesa de corrección.
- `track_corrections`: uniones, particiones, borrados, equipo y `player_id`.
- `players` (plantilla) y campo de procedencia en los keyframes (`manual` o `measured`).
- Ampliación del catálogo de eventos que resulte de la línea B.
- `schema_version` en todo lo exportado.
- **Coordenadas:** mantener la cancha normalizada a 105x68 para posiciones y gráficos, y guardar las medidas reales en `venues` para convertir distancias y velocidades.
- **Una sola fuente de verdad:** hoy el contrato vive en `schema.py` y en `web/lib/types.ts` sin nada que los compare. Añadir un test que falle si divergen.

## Backend (propuesta 6)

No hace falta escribir una API propia. El diseño está en `docs/architecture.md` ("Datos y backend"):

1. **Ya:** desplegar en Vercel (fase 0).
2. **Tras el contrato v2:** Postgres (Supabase) para lo relacional y parquet en almacenamiento de objetos para las posiciones (~1 millón de filas por partido). Se reemplaza `web/lib/store.ts`; el resto de la app no cambia.
3. **Después:** Python sube los parquets y registra cada archivo en la tabla `tracks`.

Por verificar antes de adoptarlo: límites vigentes del plan gratuito. Exportar e importar se conserva como respaldo.

## Orden

```
Fase 0 ──┬── A1 → A2 → A3 → A4 → A5 → A6
         ├── B: preguntas → fichas ──────┐
         ├── C: inventario → tokens ─────┼──► contrato v2 ──► Supabase ──► rehacer pantallas
         └── A1 + A2 ────────────────────┘
```

A, B y C avanzan en paralelo. El contrato v2 espera a las tres; la base de datos espera al contrato.

## Decisiones previas que esto cambió

- "Modelos de `roboflow/sports`" para la cancha: se sustituye por calibración con anclas. El detector de jugadoras se decide en A4.
- "Homografía por frame": pasa a anclas + propagación.
- "Carga de tracking en la app" deja de estar fuera de alcance: pasa a ser la mesa de corrección.
- Se mantiene: **la app sirve completa solo con eventos manuales.**

## Estado de A3 (2026-10-11)

`src/sportsan/tracking/propagate.py` estima el movimiento de cámara cuadro a cuadro (seguimiento de puntos + RANSAC, CPU), encadena
desde cada ancla y mezcla las dos direcciones entre anclas. Escribe `calib_<video>_<inicio>_<fin>.json`, que Calibración carga para
dibujar la rejilla punteada. Lo medido hasta ahora sobre `v1.mp4`, **sin anclas reales todavía**:

| Prueba | Resultado |
|---|---|
| Velocidad | ~32 ms por cuadro en la laptop (10 s de video en ~10 s) |
| Cadena en una dirección contra emparejamiento directo entre el primer y el último cuadro, 10 s con paneo de ~60 px | 9 px de media, 15 px máximo |
| Lo mismo con paneo de ~300 px | 17 px de media, 37 px máximo |
| Lo mismo en 15 s con paneo de ~1800 px | 104 px de media: demasiado; un paneo amplio necesita anclas intermedias |
| Tubería completa con tres anclas sintéticas en 10 s | Ancla de control a 0.69 m de media, en una escala de metros **arbitraria** (no es el error real) |

Falta: marcar anclas reales en dos o tres jugadas del banco y leer el error del ancla de control (criterio: < 2 m con 3 a 5 anclas
en 15 s). No se enmascaran jugadoras ni se usa un modelo de paneo-inclinación-zoom; son las dos mejoras previstas si la deriva no baja.

## Biblioteca de calibración (2026-10-11)

Idea de la analista: calibrar una sola vez un recorrido de lado a lado (un barrido de la cámara antes del partido, o una jugada que
cruce la cancha) y usarlo como referencia para todo el video. `src/sportsan/tracking/library.py` lo implementa: `build` toma un tramo
calibrado y guarda cuadros de referencia; `locate` empareja cada segundo de una jugada con las referencias más parecidas, descarta
las ubicaciones que no cuadran con el movimiento de cámara medido y propaga entre las demás.

Con esto las anclas a mano dejan de crecer con el número de jugadas: son las del barrido (5 a 8), una vez por sede y posición de cámara.

Medido sobre `v1.mp4`, con un barrido de 15 s del minuto 15 calibrado con **anclas sintéticas** (escala de metros arbitraria):

| Prueba | Resultado |
|---|---|
| Biblioteca | 22 referencias, 5.6 MB |
| Cuadros ubicados en tramos de 10 s de los minutos 6, 25, 33 y 37 | 44 de 44 |
| Anclas automáticas contra sus vecinas | 0.05 a 0.20 m de media por tramo; peor caso 0.49 m |
| Diferencia entre las referencias combinadas | 0.04 a 0.13 m de media |
| Descartadas por no cuadrar | 1 de 44 |
| Tiempo | 25 a 35 s por tramo de 10 s |

Qué dicen y qué no: los cuadros se reconocen a lo largo de todo el tiempo y las ubicaciones son estables entre sí. **No** miden el
error real en metros, que depende de lo bien calibrado que esté el barrido; con anclas sintéticas el propio barrido tenía hasta
~1 m de error en sus anclas de control. Antes de combinar varias referencias por cuadro, referencias distintas llegaban a diferir
varios metros en algunos encuadres: por eso se combinan las tres mejores.

Para grabar el barrido en los próximos partidos: desde el mismo sitio y altura que el partido, sin mover el trípode después; lento
(10 a 20 s de banda a banda); con el zoom que se usa en el juego, y si se usa mucho zoom, un segundo barrido con él; mejor con la
cancha vacía. Para el video actual sirve una jugada que cruce la cancha.

Falta: repetirlo con anclas reales, y decidir si el barrido se guarda por partido o por sede.

## Primera medición con anclas reales (2026-10-11)

La analista marcó 6 anclas a mano en el recorrido de 15:00 a 15:17 de `v1.mp4` (cuadros 26973 a 27475) y corrió `propagate`:

| Medida | Resultado |
|---|---|
| Cuadros sin movimiento fiable | 0 de 502 |
| Discrepancia adelante/atrás | media 1.08 m, máxima 1.68 m |
| Anclas de control (cada ancla interior quitada) | medias de 0.40, 0.45, 0.77 y 0.63 m; máximo 1.50 m |

Cumple el criterio de A3 (< 2 m). Con ese tramo se construyó la biblioteca y se ubicó otra jugada; revisada a la vista en
Calibración, la rejilla calza ("quedó bastante bien"). Después se le puso número: en el cuadro 60030 (minuto 33, a 18 minutos del barrido) la analista marcó 6 cruces de líneas de yarda
con las bandas y la biblioteca los coloca a **0.21 m de media y 0.36 m en el peor punto** (el ajuste propio de esos 6 puntos tiene
0.04 m de RMS). Es un solo cuadro; conviene repetirlo en otra zona de la cancha.

## Estado de A4 (2026-10-11)

`src/sportsan/tracking/detect.py` detecta personas con YOLO11n (exportado a OpenVINO, entrada de 1280 x 736) y las sigue con
BoT-SORT con compensación del movimiento de cámara. Corre en la laptop (Ryzen 7 5700U, sin tarjeta gráfica), por partes de 60 s,
reanudable. Medido sobre `v1.mp4`:

| Prueba | Resultado |
|---|---|
| Detección, 5 cuadros repartidos por el partido | 18 a 24 personas por cuadro en la zona de la cancha; a la vista, todas las jugadoras visibles y la árbitra |
| Velocidad | 0.31 a 0.35 s por cuadro procesado (detección + seguimiento) |
| Un minuto de video (33:20 a 34:20), 1 de cada 3 cuadros | 194 s de cálculo: unas 3.2 veces la duración del video |
| Estimado para los ~39.5 min de juego del primer tiempo | ~2 h 10 min a 10 cuadros por segundo; ~1 h 05 min a 5 |
| Seguidor de fábrica, 20 s | 59 tracks para 19 personas; 19 de ellos fuera de la cancha (banca, grada) |
| Seguidor ajustado (`botsort_pitch.yaml`), los mismos 20 s | 44 tracks; 35 en la cancha, de los cuales 20 duran 10 s o más |
| Seguidor de fábrica, un minuto entero | 194 tracks para 18 personas: en partes largas las identidades se parten mucho |
| "Sports ball" del detector genérico | Falsos positivos sobre las marcas del campo; no sirve para saber si el balón está a la vista |

Lectura: detectar no es el problema; mantener la identidad sí, y empeora con la duración. Para la mesa de corrección (A5) conviene
trabajar en jugadas de 10 a 20 s y descartar antes a quien queda fuera de la cancha usando la calibración.

Subtramos automáticos: el criterio del balón no es viable con este detector. El que sí se calcula es **cuánta gente se ve**: los
ratos con menos de 6 personas durante 2 s o más se anotan en cada parte (`low_visibility`).

Falta: unir detección y calibración en una sola corrida por parte (posiciones en metros y filtro de fuera de la cancha), y contar a
mano en el banco de pruebas el % de jugadoras detectadas y los cambios de identidad, que es el criterio de A4.

## Detección y calibración unidas (2026-10-11)

`src/sportsan/tracking/process.py` hace en una sola pasada por parte: movimiento de cámara, detección y seguimiento, y una
ubicación con la biblioteca por segundo; al cerrar la parte propaga la calibración y pasa el pie de cada caja a la cancha. Es
parte del paso A6 adelantada (posiciones en metros), todavía con identidades sin corregir.

Sobre el minuto de 33:20 a 34:20 de `v1.mp4`:

| Medida | Resultado |
|---|---|
| Tiempo | 338 s para 60 s de video (unas 5.6 veces su duración); el primer tiempo entero serían unas 3 h 40 min |
| Calibración | 60 ubicaciones con la biblioteca, 0 descartadas, 100 % de los cuadros calibrados |
| Personas en la cancha | 18 por cuadro (mediana) |
| Tracks | 126 en un minuto: unos 7 por persona. 30 duran 10 s o más y 38 menos de 1.5 s |
| Fuera de la cancha | En este minuto casi nadie (la banca no entra en cuadro), así que filtrar por posición no reduce los tracks aquí |
| Colores de camiseta encontrados | `#524c58` (azul apagado, 73 tracks), `#2d2321` (negro, 33) y `#878262` (amarillento, 20: la árbitra y mezclas) |

Lo que queda claro: el cuello de botella es la identidad. Siguiente mejora antes de la mesa de corrección: **unir fragmentos en
metros** (un track que termina y otro del mismo color que empieza cerca poco después son la misma jugadora), que es mucho más
fiable sobre la cancha que sobre la imagen.

## Unión de fragmentos y mesa de corrección (2026-10-11)

- `src/sportsan/tracking/stitch.py` une fragmentos sobre la cancha (mismo color, hueco de hasta 3 s, distancia alcanzable a 8 m/s) y
  se abstiene si dos candidatos compiten por el mismo hueco. En el minuto de 33:20: **126 tracks -> 86 identidades** (de 7.0 a 4.8
  por persona). Sigue siendo mucho: 38 de los tracks duran menos de 1.5 s y no se unen a nada.
- `web/app/correccion` (menú: Corrección de tracks) carga el video y una parte procesada y permite unir, partir desde un cuadro,
  descartar, poner equipo y dorsal y marcar a mano los pies donde el detector perdió a alguien. Cada persona tiene una barra de
  presencia donde se ven los huecos. Los colores de uniforme se eligen ahí (con cuentagotas sobre una jugadora) y se pueden escribir
  en `match.yaml`. Exporta `tracks_fixed_*.json`.

Piloto pendiente (lo corre la analista): 3 minutos seguidos, con eventos etiquetados, comprobación de la calibración en varios
cuadros y corrección completa de identidades, midiendo cuánto tiempo lleva. Ese tiempo decide el corte de la hoja de ruta: si
corregir una jugada cuesta más que dibujarla a mano, el tracking se queda en investigación.

## Tras el primer uso de la mesa de corrección (2026-10-11)

La analista comprobó la calibración en una parte procesada: **0.13 m de media, 0.19 m el peor punto** (4 puntos). Y encontró dos
problemas en las identidades: jugadoras claramente visibles sin ninguna caja, y uniones entre equipos (azul contra negro).

Medido sobre 30 s de `v1.mp4`: el seguidor dejaba fuera el **5.5 % de las detecciones**, y en el 55 % de los cuadros había al menos
una persona visible sin caja. El 65 % de las descartadas tenía confianza menor que 0.45, el umbral para abrir track que se había
subido al ajustar el seguidor. Las descartadas eran sobre todo jugadoras lejanas (caja a 0.73 de la altura mediana, a 6 m de
mediana del track más cercano), no duplicados.

Cambios:

- **Nada de lo que el detector ve se pierde.** Lo que el seguidor no confirma se guarda como detección suelta (657 en el minuto de
  prueba) y se une después por posición; el umbral para abrir track bajó a 0.3.
- **Color de camiseta**: mediana del torso sin los píxeles de césped (antes la media, que apagaba el azul), y la luminosidad pesa la
  mitad al comparar.
- **Dos equipos distintos nunca se unen**, si `jersey_colors` está definido. Porteras con su propio color (`own_gk`, `opp_gk`).
- **Salida del encuadre**: si un fragmento termina pegado al borde de la imagen, se toma la velocidad de su último segundo, se
  estima dónde estará (frenando con una constante de 2.5 s) y se empareja con quien entra por el borde cerca de ese punto, hasta 10 s
  después. Antes solo se unían huecos de hasta 3 s por cercanía.
- **Continuidad inmediata**: hasta 0.45 s y 1.5 m se une por posición aunque el color medido no coincida.
- La regla de duda solo cuenta a candidatos que están a la vez en la cancha (antes bloqueaba también trozos sucesivos de la misma persona).

Resultado en el minuto de 33:20: aparece entera una jugadora lejana que antes no tenía ni una caja (56.7 s seguidos, reconstruida
solo con detecciones sueltas). Las identidades de un segundo o más son unas 89, parecidas a las 86 de antes; además quedan 112 trozos
de menos de un segundo, que la mesa oculta por defecto. **La unión automática sigue lejos de una identidad por persona**: no se ha
medido cuántas uniones son erróneas, y los equipos aún no se han probado con `jersey_colors` reales.

Sobre la carga de trabajo: corregir identidades parte por parte en todo el partido (unas 40 partes) no es viable, y coincide con el
criterio de corte de esta hoja de ruta. Lo que sí es viable: (1) las preguntas de equipo (B4, C4: bloque, jugadoras tras el balón)
solo necesitan posición y equipo, no quién es cada una, así que no pasan por la mesa; (2) la identidad se corrige solo en las
jugadas elegidas.

## Trozos cortos, varias partes, balón y Strava (2026-10-12)

- **Dos cajas sobre una jugadora.** Al unir dos personas que solo coinciden donde sus cajas están a menos de 2 m, se unen sin
  aviso y queda una caja por cuadro (la de más confianza). El aviso queda para cuando están separadas.
- **Trozos cortos que encajan.** La mesa propone añadir a su jugadora los trozos de menos de un segundo que repiten una caja suya
  o caen donde ella se pierde. En el minuto de 33:20, sin correcciones y sin colores: de 201 personas a 134 y de 112 trozos cortos
  a 45 en tres pasadas (67 unidos, 105 cuadros recuperados). No se ha medido cuántas de esas uniones son erróneas.
- **Varias partes en un archivo.** Con las tres partes de 33:20 a 36:20 sin corregir: 536 personas sumadas quedan en 518 (15 y 3
  enlaces en las dos fronteras). Entre partes sin corregir se enlaza poco porque hay muchas candidatas cerca; con nombres puestos,
  el nombre manda.
- **Balón.** Marcas a mano sobre el video y posiciones de eventos etiquetados, con rectas entre posiciones a 3 s o menos. No hay
  detección. Limitación: un balón por alto queda mal ubicado (se proyecta como si estuviera en el suelo).
- **Strava.** `strava_sync` baja resumen de todas las actividades y detalle por segundo de las de fútbol. Sin probar contra una
  cuenta real (falta crear la aplicación y autorizar).

Pendiente de verificar: los términos de la API de Strava sobre mostrar datos de una atleta a terceros (cuerpo técnico) antes de
plantear la versión con todo el equipo. Con una sola atleta (la dueña de la aplicación) no aplica.

## Hipótesis de mejora: aprender de las correcciones

Idea de la analista: corregir a mano unos minutos y que un modelo corrija el resto. Sin probar. Qué podría funcionar, de menos a
más costoso:

1. **Ajustar los pesos de la unión con lo corregido.** `stitch.py` decide con umbrales puestos a mano (distancia, color, tiempo).
   Cada unión o partición hecha en la mesa es un ejemplo de "misma persona / distinta persona": con unos minutos corregidos se
   pueden ajustar esos umbrales, o entrenar un clasificador pequeño sobre los mismos datos. Barato y medible.
2. **Usar los nombres como ancla.** Una jugadora nombrada en una parte da su zona habitual y su color medido; eso sirve de
   preferencia al proponer identidades en las partes siguientes.
3. **Reidentificación por apariencia.** Un modelo que reconozca a cada jugadora por su imagen, afinado con los recortes de las
   partes corregidas. Es lo que más promete para reencontrar a quien sale y vuelve al cuadro, y lo más dudoso aquí: mismo uniforme,
   jugadoras de pocos píxeles, dorsales ilegibles y pocos minutos de ejemplos.

Cómo se sabría si ayuda: corregir dos partes, entrenar con una y contar en la otra cuántas uniones acierta y cuántas correcciones
a mano ahorra frente a la unión actual.

## Colores, partes por tramo y métricas de equipo (2026-10-14)

- **Las 42 partes del primer tiempo se procesaron sin equipos.** `jersey_colors` estaba dentro del video en `match.yaml` y
  `process` solo lo buscaba en el partido: todas las personas quedaron `unk`. Corregido en `config.py` (vale en los dos sitios).
- **El color elegido sobre el video no es el que mide el programa.** El azul elegido (`#084b9f`) quedaba a 39.2 del azul medido en
  el torso (`#5c5a72`), con el límite en 40. Con los colores medidos, en 20 s del minuto 33: 39 identidades nuestras, 39 rivales,
  4 árbitras y 2 sin equipo. Pendiente: que el cuentagotas de la app mida como `process` (torso, sin césped, en la caja).
- **Una parte por tramo de juego** por defecto (11 en el primer tiempo: media 3 min, la más larga 11 min; antes 42 de 1 min).
  Cada corte reinicia el seguidor y cambia todas las identidades.
- **Métricas de equipo sin corregir identidades**: ancho, largo, altura de línea y de bloque por tramos de 5 y 10 min de juego
  (`metrics/team_blocks.py`, `metrics/report.py`). Probadas con datos sintéticos; con datos reales, tras volver a procesar.
- **Strava**: carga por esfuerzo relativo (`suffer_score`) cuando no hay RPE; las 113 actividades desde agosto lo traen.
