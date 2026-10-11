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
| A4. Detección y tracks en píxeles | YOLO + ByteTrack sobre el clip, sin homografía. Equipos por muestras de color elegidas a mano (clic en 3 a 5 jugadoras por equipo). Probar primero un detector genérico de personas a 1280 px | `src/sportsan/tracking/` (Colab, o CPU para clips cortos) | Informe por clip: % de jugadoras detectadas y nº de cambios de identidad, contados a mano en el banco |
| A5. Mesa de corrección | Sobre el video con los tracks dibujados: unir y partir tracks, borrar falsos, cambiar equipo, asignar `player_id`, marcar el balón a mano en keyframes | `web/` | Una jugada de 15 s queda corregida en un tiempo que la analista considere aceptable (se mide) |
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
Calibración, la rejilla calza ("quedó bastante bien"). Falta ponerle número a esa segunda parte: un ancla a mano en una jugada
ubicada por la biblioteca, comparada con la posición que da la biblioteca.
