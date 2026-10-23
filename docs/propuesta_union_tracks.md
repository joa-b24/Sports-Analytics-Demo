# Propuesta: unión de tracks con mínima intervención manual

Borrador para discutir (2026-10-20). Nada de esto está implementado. Los números salen de las 14 partes corregidas a
mano de `2026_09_25_tec_ccm_vs_anahuac` (45 min de video con nombres), comparando `tracks_*.json` (lo que sale de
`process`) con `tracks_fixed_*.json` y `labels_*.json` (lo que quedó después de la mesa de corrección). El script de la
medición está en la sección 8.

## 1. Meta por partido

| Paso | Hoy | Meta | Cómo |
|---|---|---|---|
| Calibración | variable | ≤ 30 min si la cancha se ve bien | anclas a mano (sin cambios) + `library check` |
| Balón | marcas a mano | 50 % del tiempo de juego en ~1 h | tracker de balón (`sportsan.tracking.ball`) + revisar sus dudas; **antes** que las identidades (sección 5.6) |
| Identidades | ~15 h | ~4 h | este modelo: la persona solo pone anclas y resuelve dudas |
| Revisión rápida / anomalías | a mano | casi automática | verificación al final del modelo (5.7) con lista corta de dudas |
| Eventos | 3 pasadas completas | 1:30–2 h | pasada 1 solo tiros, duelos y pases clave; pasada 2 aceptar/rechazar sugerencias (`lib/autoEvents.ts`); luego revisión y ejecución |
| **Total** | | **~7–7.5 h** | |

## 2. Qué dicen los datos de la corrección hecha

- **La fragmentación pesa más que los errores.** Hay 5 079 tracks del tracker (mediana 5.8 s, p90 27 s) y **22 883 cajas
  sueltas** (un cuadro cada una, ids ≥ 1 000 000), que `process` solo absorbió en una fracción mínima (p. ej. 105 de 3 061
  en una parte).
- **La identidad de `process` ya es casi pura:** de 7 403 identidades, solo 173 juntan a dos personas (2.6 % de las
  cajas). Es conservadora pero corta: mediana 1.3 s.
- **Casi todas las uniones manuales eran triviales.** Entre trozos consecutivos de una misma jugadora hubo 9 102 huecos:
  **85 % de menos de 0.5 s** y 7 % de 0.5 a 2 s. El salto de posición en el hueco tiene mediana 0.8 m y p90 4.6 m. Solo
  416 huecos (4.6 %) pasan de 5 s: esos son los difíciles.
- **El trabajo manual:** 4 292 uniones, 8 699 cortes, 4 739 tracks quitados (árbitros, banca, sombras), 1 547 cajas
  soltadas, 255 marcas a mano y 2 877 marcas de balón. Solo el 23 % de los cortes cae a ±2 s de un cruce de cajas
  (IoU > 0.3), así que **la mayoría de los cortes no se explica por cruces**: hay que entender de dónde vienen antes de
  automatizarlos (sección 7, primera tarea).
- **El color por caja es ruidoso:** 19 798 saltos de color Lab > 40 dentro de un mismo track del tracker. Un cambio de
  color en un solo cuadro no es señal de nada; se compara la **mediana por tracklet**.
- **El equipo no cambia dentro de un track** (0 tracks con cajas de los dos equipos): la clasificación de `process` es por
  track, así que un error de equipo es de todo el track, no de un cuadro.

## 3. Qué traen los archivos y no se usa

`tracks_v*_<ini>_<fin>.json` (`schema_version` 3), por cuadro procesado (cada `stride` = 3 cuadros):

- `H`: la homografía de ese cuadro (calibración por cuadro, no solo por ancla).
- `boxes` con `box_columns`: `track_id, x1, y1, x2, y2, conf, lab_l, lab_a, lab_b, x, y, on_pitch, team, identity`.
  Es decir, caja en píxeles, confianza, **color Lab** del uniforme, posición en la cancha (105 × 68), si está dentro,
  equipo y la identidad propuesta.
- `quality` por parte (personas por cuadro, tracks por persona, cajas sueltas absorbidas…) y `tracks_v*_index.json` con
  lo mismo por parte.

`labels_v*_<ini>_<fin>.json` guarda **todas las decisiones de la persona** (`edits.identity` uniones, `splits` cortes con
cuadro, `removed`, `dropped`, `manual`, `ball`, `ballReview`, `people` con equipo y nombre). Es un conjunto de
entrenamiento y de evaluación listo: cada unión y cada corte es un ejemplo etiquetado de «misma persona / otra
persona».

Falta en los archivos y convendría que `process` lo guardara: la caja con su **altura en metros** (escala local de la
homografía), la **visibilidad** (si la caja toca el borde del cuadro o la tapa otra) y el **cuadro de la cámara** (`view`)
también en los archivos sin corregir.

## 4. Idea central

Separar dos problemas que hoy se resuelven juntos a mano:

1. **Trozos puros** (*tracklets*): cortar todo lo que pueda mezclar a dos personas. Tolerancia cero a cruces: es preferible
   tener 10 trozos de una jugadora que uno que sea de dos.
2. **Unirlos con evidencia**: primero lo obvio (huecos cortos sin ambigüedad), después lo difícil entre **anclas puestas
   por la persona** (3 por minuto y jugadora, en momentos fáciles), buscando el camino más probable hacia delante desde un
   ancla y hacia atrás desde la siguiente.

Lo que no se puede unir con confianza queda como hueco (`NaN`), nunca inventado (regla 4 del proyecto). **Decidido
(2026-10-21): no hace falta cerrar todos los huecos; manda la certeza.** Cada unión lleva una probabilidad y el modelo
se abstiene por debajo del umbral: se mide primero la precisión de lo que une y después cuánto deja sin unir.

## 5. El modelo, por etapas

### 5.1 Limpieza (automática)
- Fuera de la cancha (`on_pitch = false`, o a más de 3 m de las líneas): se quita.
- Cajas sueltas: se unen a un track si en el cuadro anterior o siguiente hay una caja del mismo equipo a menos de 1 m y
  ninguna otra a menos de 2 m. Las que quedan se guardan como candidatas para rellenar huecos (5.5), **no se descartan**.
- Tracks cortos: tampoco se descartan; bajan el umbral de unión pero no se tiran.

### 5.2 Trozos puros (automática)
Un track se corta en cualquier cuadro con riesgo:
- **Cruce**: otra caja con IoU > 0.2, o dos posiciones a menos de 1.2 m en la cancha.
- **Salto de tamaño**: la altura de la caja cambia más de 35 % entre cuadros procesados (posible cambio de persona tras
  una oclusión), salvo que se explique por la escala de la homografía.
- **Salto imposible**: más de 9 m/s sostenido entre dos cuadros.
- **Cambio de color sostenido**: la mediana del color Lab de los últimos 10 cuadros difiere de la de los 10 siguientes en
  más de un umbral aprendido de las uniones correctas. Un cambio de un cuadro (sombra, luz) no corta.

Se mide con lo ya corregido: **pureza ≥ 99.5 %** de cajas en trozos de una sola persona. Si no llega, se ajustan
umbrales antes de seguir.

### 5.3 Clasificación en 5 grupos (automática, revisable)
Cada trozo se clasifica en: **propias, rivales, porteras (cada una), árbitros, fuera de juego (banca, público)**. Variables:
mediana del color Lab del trozo, posición (una portera vive cerca de su arco), tamaño y movimiento. Un clasificador
sencillo (k-vecinos o regresión logística) entrenado con las partes corregidas, por partido (los uniformes cambian), y
con `jersey_colors` de `match.yaml` como semilla. Un trozo nunca se une con otro de otro grupo. Si el trozo cambia de
grupo sin cruce, lo más probable es **sombra**: se marca como duda, no se corta.

### 5.4 Unión local (automática)
Para cada final de trozo, candidatos que empiezan en los siguientes 2 s: costo = distancia entre la posición predicha
(velocidad constante) y la real, en metros, con una tolerancia que crece con el hueco, + diferencia de tamaño + diferencia
de color + grupo. Asignación de mínimo costo (algoritmo húngaro) por ventana. **Solo se une si no hay ambigüedad**: el
mejor candidato es claramente mejor que el segundo (prueba de razón) y no hubo cruce durante el hueco.

Por los datos, esta etapa sola cubriría el ~85–90 % de las uniones que hoy se hacen a mano.

### 5.5 Anclas y relleno entre anclas (la idea de la analista)
- **Anclas**: 3 por minuto y jugadora, idealmente en trozos de más de 3 s y sin cambio de grupo. La app **sugiere** los
  momentos (trozos largos, aislados: nadie a menos de 2 m, color estable) y la persona solo hace clic en la caja y elige
  el nombre. Un ancla nombra el trozo entero, no solo un cuadro.
- **Relleno**: entre dos anclas consecutivas de la misma jugadora se busca el camino de trozos más probable, hacia delante
  desde la primera y hacia atrás desde la segunda, hasta que se encuentran. Se resuelve **para todas las jugadoras a la
  vez** (flujo de costo mínimo sobre el grafo de trozos), porque un trozo solo puede ser de una persona: resolverlas una
  por una deja que la primera se lleve trozos de otra.
- Costo de cada paso: movimiento físico posible (velocidad máxima con incertidumbre que crece con el hueco), color,
  grupo, y los dos términos aprendidos de 5.6.

Estimación de esfuerzo: 22 jugadoras × 3 anclas × 45 min ≈ 3 000 clics. A ~2 s por clic con el momento ya sugerido son
~1.7 h. Si el modelo es bueno, se pueden bajar a 1–2 por minuto y poner más solo donde haya dudas: es lo primero que hay
que medir (sección 7).

### 5.6 Lo aprendido del partido ya hecho
- **Formación / rol**: de las partes corregidas, la posición de cada jugadora **relativa al centro y a la forma de su
  equipo** (no absoluta: el bloque se mueve). En la búsqueda, un candidato lejos de su sitio en la forma del equipo en ese
  momento cuesta más. Se entrena con los mapas de calor y posiciones medias que ya calcula `lib/positions.ts`.
- **Balón**: el balón da sentido al movimiento (el bloque se desplaza hacia él, la más cercana presiona). Por eso
  conviene **verificar el balón antes que las jugadoras**: con el balón bien, el término de formación se puede condicionar
  a dónde está el balón. Se entrena con las partes que tienen balón y nombres. Hay que medir cuánto aporta antes de
  confiar en él: es un prior más débil que el de formación.
- Ambos son **términos de costo, no reglas duras**: ayudan a elegir entre candidatos parecidos, nunca crean posiciones.

### 5.7 Verificación al final (reemplaza la revisión rápida)
Revisión automática con una lista corta y ordenada de **dudas**, cada una con su cuadro exacto:
- saltos imposibles que quedaron;
- la misma jugadora en dos sitios a la vez;
- cambio de grupo sin cruce (probable sombra);
- uniones con costo alto o con un segundo candidato casi igual;
- huecos largos sin resolver (se dejan como hueco salvo que la persona decida).

Meta: menos de 100 dudas por partido, cada una de un clic (sí / no / es otra).

## 6. Reglas iniciales (para afinar)

| # | Regla | Valor inicial | De dónde sale |
|---|---|---|---|
| R1 | Cortar en cruce | IoU > 0.2 o < 1.2 m | tolerancia cero; ajustar con la pureza |
| R2 | Cortar por salto de tamaño | > 35 % entre cuadros procesados | 956 saltos así en tracks del tracker |
| R3 | Velocidad máxima | 9 m/s (+ 1 m por segundo de hueco) | `lib/anomalies.ts` ya usa 9 m/s y 3 m |
| R4 | Color | comparar medianas de 10 cuadros, nunca cuadro a cuadro | 19 798 saltos de color en un cuadro |
| R5 | Unión local | hueco ≤ 2 s, prueba de razón ≥ 1.5, sin cruce en el hueco | 92 % de los huecos ≤ 2 s |
| R6 | Grupos | nunca unir trozos de grupos distintos | |
| R7 | Cambio de grupo sin cruce | duda (sombra), no corte | |
| R8 | Anclas | ≥ 3 s, sin cambio de grupo, nadie a < 2 m | |
| R9 | Hueco sin evidencia | queda `NaN` | regla 4 del proyecto |
| R10 | Árbitros y fuera de juego | se quitan, pero se guardan (no se borran del archivo) | 4 739 quitados a mano |

## 7. Cómo se mide y en qué orden

Todo se evalúa contra las partes ya corregidas (que no se tocan), dejando una parte fuera cada vez:

1. **Entender los cortes**: de los 8 699 cortes manuales, cuántos son de trozos de `process` que mezclaban personas,
   cuántos de ajustes de la mesa (p. ej. separar la portera) y cuántos de cajas que el tracker cambió de persona sin
   cruce. Define si R1–R4 bastan.
2. **Pureza** de los trozos (5.2): ≥ 99.5 %.
3. **Unión local** (5.4): porcentaje de las uniones manuales que reproduce, y uniones erróneas (meta: < 0.5 %).
4. **Simulador de esfuerzo**: con las anclas tomadas de la verdad (3, 2 y 1 por minuto), cuántas acciones manuales
   quedarían (uniones, cortes, dudas). Es la cifra que decide si se llega a 4 h.
5. **Identidad** (IDF1) y minutos con nombre correcto por jugadora.

Fases, cada una se puede usar sola:

| Fase | Entrega | Criterio para pasar |
|---|---|---|
| F1 | Medición de cortes + trozos puros + unión local en Python (`tracking/stitch` ampliado), con informe sobre las 14 partes | pureza ≥ 99.5 %, uniones correctas ≥ 85 % de las manuales |
| F2 | Clasificación en 5 grupos | ≥ 98 % de trozos en su grupo |
| F3 | Anclas sugeridas en la mesa + relleno entre anclas (flujo de costo mínimo) | simulador: ≤ 4 h con 3 anclas/min |
| F4 | Términos de formación y balón | menos dudas que F3 con las mismas anclas |
| F5 | Verificación automática y lista de dudas en la mesa | < 100 dudas por partido |

Estado (2026-10-22): F1 hecha sin cumplir su criterio con umbral 0.99; con 0.95 y pies corregidos queda como base. F2, F3 (en simulador) y F4 hechas y medidas (sección 8e). Faltan la interfaz de anclas (F3) y la lista de dudas (F5), que es lo que permite medir el tiempo real.

## 8. Prueba con `2026_09_25_tec_ccm_vs_anahuac`

Estado de la corrección (2026-10-21): v1 completo; v2 con 2 de 4 tramos completos y el tercero (el más largo) a la
mitad; v3 con 1 de 2. Solo cuentan como verdad las partes marcadas como completas: una parte a medias tiene huecos y
uniones pendientes que el modelo «acertaría» y contarían como error.

| Uso | Partes |
|---|---|
| Ajustar umbrales y entrenar el clasificador de uniones | v1 (11 partes) |
| Prueba, sin tocar hasta el final | las 2 completas de v2 y la completa de v3 (otro ángulo y otra luz: dice si generaliza) |
| Prueba real de esfuerzo | la mitad que falta del tercer tramo de v2: corregirla con el modelo y medir el tiempo contra la primera mitad, hecha a mano |

## 8b. Resultado de la fase 1 (2026-10-21)

`python -m sportsan.tracking.links_eval --match 2026_09_25_tec_ccm_vs_anahuac --train v1 --test v2_0_4259,v2_5020_10226,v3_0_6890`
(entrenamiento: 11 partes de v1, 36 min; prueba: 3 partes de v2 y v3, 9 min). Informe completo en
`matches/<partido>/tracking/revision/union_f1.md`.

- **Trozos puros: 99.77 % de pureza** (meta 99.5 %). La regla que más pesa es el cruce (sin ella, 99.39 %). De los cambios
  de persona dentro de un track del seguidor, 157 son en un cruce, 19 por tamaño, 21 por color y **75 sin causa visible**.
- **La etiqueta de entrenamiento importaba más que el modelo**: mezclar «otra jugadora» con «caja que la mesa quitó»
  (árbitros, banca, duplicadas) tenía el AUC en 0.88; separándolos, 0.95. Por eso la cadena es: primero ¿es jugadora?,
  después unir solo entre jugadoras.
- **¿Es jugadora?** todavía es débil: con umbral 0.5 aparta por error 3.7 % de las cajas de jugadoras y deja pasar 21 % de
  las que no lo son. Es la F2 (5 grupos).
- **Unión con abstención (≥ 0.99): pureza 99.56 % en entrenamiento y 99.90 % en prueba, pero deja más trabajo a mano que
  hoy**: 9 533 uniones y cortes pendientes contra 2 439 de las identidades de `process` (prueba: 1 738 contra 516). Solo une
  huecos de hasta 2 s y se abstiene en muchos: incluso sin cruce, con 99.5 % de precisión cubre solo el 35 % de las
  uniones correctas. **No cumple el criterio de la F1** (≥ 85 % de las uniones con pureza ≥ 99.5 %).
- `process` es 94 % puro: sus ~9 600 cajas mal asignadas están en 263 identidades, sobre todo tracks del seguidor que
  pasan por dos o tres personas en un cruce. No basta con cortarlas desde fuera: el modelo no distingue esas uniones.
- Una acción no cuesta lo mismo en los dos casos: un corte en una identidad impura obliga a encontrar el momento en el
  video; una unión entre trozos limpios se puede ofrecer como sugerencia. Falta medirlo en tiempo (simulador, sección 7).

Siguiente, en este orden: (1) revisar a mano una muestra de las uniones «seguras» que la verdad marca como erróneas
(¿error del modelo o de la verdad?) y de los 75 cambios sin causa; (2) variables de continuidad más finas (dirección,
aceleración, posición en la imagen además de la cancha, borde del encuadre); (3) unir en dos rondas con ventana mayor
para las cadenas ya largas; (4) el simulador de esfuerzo con anclas para comparar en tiempo y no en número de acciones.

## 8c. Revisión a ciegas y aceleración (2026-10-21)

Muestra de 40 casos (`python -m sportsan.tracking.links_review`, respuestas en `tracking/revision/muestra_uniones/`).
**Las respuestas de la analista son la verdad** cuando contradicen la corrección: la herramienta de saltos imposibles llegó
después de corregir casi todas las identidades.

| Caso | Misma | Distinta | No se ve |
|---|---|---|---|
| Unión que el modelo daba por segura (≥ 0.99) y la corrección separaba | 15 | 4 | 1 |
| Control (modelo y corrección de acuerdo) | 5 | 0 | 0 |
| Cambio de persona dentro de un track sin causa visible | 1 | 12 | 2 |

- En 3 de cada 4 desacuerdos tenía razón el modelo: de las 95 uniones «seguras» rechazadas en v1, ~70 serían descuidos de la
  corrección. La precisión real a 0.99 ronda el **99.9 %**, no el 99.7 % del informe: la verdad tiene ruido y las cifras
  de la F1 son pesimistas.
- Los 4 errores reales del modelo: dos cruces entre compañeras con intercambio de identidad, una caja que cubre a dos
  jugadoras (cabeza de una, pies de otra: salto en diagonal en la cancha) y **portera que pasa a central** (lo resuelve la
  clasificación en grupos, F2).
- Los cambios sin causa son reales (12 de 15): el seguidor salta a la jugadora más cercana durante un **barrido de cámara**
  o en un balón parado cuando alguien arranca de golpe. Variables que faltan: movimiento de la cámara entre cuadros (cambio
  de la homografía), salto en la imagen frente a salto en la cancha, y arranque imposible (abajo).

**Aceleración.** En las 14 partes corregidas, la velocidad en ventanas de 1 s tiene p99 = 20.7 km/h y p99.9 = 35 km/h,
con máximos de hasta 90 km/h; 40 de 173 jugadora-parte superan 30 km/h. 340 muestras (0.2 %) violan una curva de arranque
física (llegar de v0 a v1 en 1 s con velocidad máxima 8.5 m/s y constante de tiempo 1 s). Solo 13 coinciden con muchas
jugadoras a la vez (cámara); **54 % caen donde se unieron dos tracks del seguidor** (identidad) y 46 % dentro de un mismo
track, concentradas en la banda lejana (ruido de caja y calibración, que allí pesa más por metro).

Regla propuesta, con el perfil aceleración-velocidad lineal de la literatura de rendimiento (aceleración máxima posible
a la velocidad v: A0 · (1 − v / S0)): **A0 = 7 m/s², S0 = 8.5 m/s (30.6 km/h)**, frenada hasta −8 m/s², más una holgura
por ruido que crece con la distancia a la cámara. Uso: (1) veto o variable en la unión: una unión que exige un arranque
imposible no se hace; (2) dentro de un mismo track no se corta: se suaviza como ruido. Cuando los datos estén limpios,
A0 y S0 se pueden estimar por jugadora con el método «in situ» (percentil alto por tramo de velocidad).

## 8d. Revisión de saltos imposibles (2026-10-21)

30 saltos (más de 3 m a más de 9 m/s) de las partes con nombres, revisados en la app (`/revision`, temporal) con video,
velocidad y recorrido; respuestas en `tracking/revision/saltos/respuestas.json`.

- **La causa principal no es la identidad: es la caja.** En ~17 de 30 notas el salto viene del borde inferior de la caja:
  se cortan los pies, la caja se estira hacia la jugadora de delante o «baila» arriba y abajo. Como la posición en la
  cancha sale de los pies, la jugadora «salta» metros sin cambiar de persona (más en la banda lejana). Solo ~10 de 30 son
  la caja sobre otra jugadora, y casi siempre vuelve enseguida.
- **La clasificación de la regla (pico / antes / prolongado) acierta 10 de 30**: no sirve como está. Respuestas: pico 10,
  es ella (cámara o caja) 8, lo malo era antes 5, otro 6 (casi todos de caja), cambio que dura 1.
- **Tramos malos marcados (13): mediana 5 posiciones (0.5 s)**, 12 de 13 de 8 o menos (≤ 0.8 s), uno de 17.
- **Límites físicos** (velocidad en ventanas de 1 s, máx. 30.6 km/h, arranque A0 = 7 m/s² con 1 m/s² de holgura): sin
  hacer nada pasan 23 de 30; solo con el suavizado de la exportación, 26; con la respuesta aplicada y suavizado, **29**. El
  que falla (30.9 km/h) es de pies recortados.

Siguientes pasos que salen de aquí:
1. **Corregir los pies antes que la identidad**: si la altura de la caja cambia de golpe frente a su mediana reciente (a
   igual distancia de la cámara), estimar los pies desde la cabeza y la altura típica de esa jugadora. Ataca la causa de
   más de la mitad de los saltos. Va en `process` (Python), donde están la caja y la homografía de cada cuadro.
2. **Suavizado**: ampliar la excursión que `dropJumps` quita de 0.5 s a ~0.8 s (cubre 12 de 13 tramos marcados), siempre
   con la condición de que vuelva a donde podía estar.
3. Dejar la clasificación pico / antes / prolongado y usar tres causas: caja (pies), cambio breve con vuelta, cambio que
   dura.

## 8e. Fases 2 a 4, cobertura y tiempo de la analista (2026-10-22)

Reparto de partes: entrenamiento con 7 partes de v1 (`v1_6414_13699`, `v1_14541_15944`, `v1_16648_22211`, `v1_23140_26173`,
`v1_26910_32826`, `v1_33818_35062`, `v1_36135_41389`); prueba en otras 4 de v1 y, por separado, en las partes completas de
v2 y v3. Umbral de unión fijado en **0.95** (`LINK_P_MIN` en `tracklets.py`; era 0.99). Para volver a probar 0.9:
`python -m sportsan.tracking.links_eval --match <id> --train v1 --test <partes> --feet --p-min 0.9` (o cambiar
`LINK_P_MIN`); el informe ya trae la fila «≥ 0.9». Con los pies corregidos (`feet.py`) los saltos imposibles bajan de
1 318 a 939 y se resuelven 14 de 22 casos de caja de la revisión; el veto de arranque aporta poco.

| Fase | Resultado | Criterio | Informe (`tracking/revision/`) |
|---|---|---|---|
| F2 grupos | propias/rivales/árbitros 96–97 % de cajas; con «fuera de juego» 86–89 % (trozos 72–76 %) | ≥ 98 % **no se cumple** | `grupos_f2.md` |
| F3 anclas y relleno | pureza ~98.7–99.1 % tras el relleno (fase 1 sola 99.2 %); cobertura 74.9–78.3 % con 3 anclas/min; 62 % con 1 | ≤ 4 h: sí si no se cuentan pendientes, no si se cuentan | `anclas_f3.md` |
| F4 formación y balón (estáticos) | formación: −2 a −4 % de trabajo; balón: nada | menos dudas: marginal | `priors_f4.md` |
| F4b secuencias de equipo con balón | error de posición 5.6 m (estático 5.5–7 m); incertidumbre mal calibrada (70–73 % en la elipse del 95 %); sin efecto en el relleno | no mejora | `secuencias_f4b.md` |
| Reidentificación por apariencia | AUC 0.60–0.63 con cajas < 150 px (mediana 63 px); solo 9.8 % de las cajas pasa de 100 px | no sirve en este partido | `reid.md` |
| Cobertura y tiempo | 3 anclas/min: cobertura 75–76 %, errores 0.6–0.9 %, 1.9–2.3 h por partido (estimación) | ≤ 8 h: sí, pero ver abajo | `cobertura.md` |

- **Lo que no se puede dar por bueno todavía.** El tiempo (1.9–2.3 h) usa 2 s por ancla y 3 s por duda, pendiente o hueco
  largo, sin medir con la analista; solo cuenta a las propias con nombre; las partes medidas son jugadas sueltas, no un
  partido seguido. Su estimación real hoy es ~9 h de revisión rápida de su equipo por partido completo (+50 % la revisión
  fina): hay que **medir el tiempo real por acción** antes de creerse la cifra. Objetivo declarado: bajar al menos 50 %.
- **Sesgo por un solo partido.** Todo se entrenó y probó en `2026_09_25_tec_ccm_vs_anahuac` (v2 y v3 son del mismo
  partido, otro tiempo y ángulo). Falta probar con otro partido (`2026_10_10_tec_ccm_vs_up`) y con más datos de
  entrenamiento (v1 + v2 + v3 completos).
- **Formación dada (4-3-3 de Tec CCM, primer tiempo)** en `matches/<id>/formacion.json`. En el segundo tiempo hay cambios y
  no se conoce: ahí el rol se aprende de la parte. Frente al rol aprendido en la propia parte, la formación dada casi no
  aporta (6.46 m contra 6.35 m de error).
- **Cuello de botella:** las ~2 000 uniones pendientes de cadenas cortas sin nombre (v1) y el grupo «fuera de juego» de F2
  (la etiqueta removed/dropped mezcla duplicados con jugadoras quitadas por otras razones).
- Regla de cobertura: un hueco de ≤ 4 s entre dos trozos de la misma identidad, con velocidad y aceleración posibles, se
  rellena por interpolación (`interpolated`) y no cuenta como error; los de salir de cuadro se dejan como hoy.

## 8f. Qué aporta la literatura (informe «Metodologías y arquitecturas…», 2026-10-22)

Se contrastó un informe de revisión con lo que ya hace el proyecto.

| Idea del informe | Estado | Dónde / comentario |
|---|---|---|
| Homografía por cuadro y unir en la cancha, no en píxeles | **ya está** | `H` por cuadro en `tracks_*.json`; `propagate` + `library`; todo el modelo trabaja en metros |
| Calibrar con detector automático de puntos/líneas (Broadcast2Pitch, SegFormer) | **descartado** | regla 15 del proyecto: anclas a mano; solo volver con un motivo medido |
| Trozos de alta pureza antes de unir | **ya está** | `tracklets.pure_tracklets`, 99.77 % |
| Mahalanobis en el plano del suelo + húngaro | parcial | húngaro por ventanas en `anchors.py`; distancia a la posición predicha sin covarianza por trozo |
| Compensación de movimiento de cámara en el filtro | no hace falta | la predicción ya es en metros; **pero** el barrido de cámara sí explica cambios de persona (8c) y no es una variable: pendiente |
| Homografía suavizada / estimación conjunta (IMM-JHSE) | **pendiente** | filtrar `H` en el tiempo y detectar cuadros con `H` inestable; ataca el temblor de la cancha proyectada |
| ReID de apariencia | **probado, no sirve aquí** | `reid.py`; las jugadoras miden 63 px de mediana. Pendiente: afinar un modelo propio con las identidades revisadas (metric learning) y probarlo en un partido de cámara cercana |
| Equipo como restricción dura | **ya está** | nunca se une entre equipos; grupos en `groups.py` |
| Flujo de costo mínimo global / multi-commodity | parcial | asignación húngara en ventanas de 1 s; falta el grafo global con nodos de entrada y salida de cuadro |
| Grafos jerárquicos (SUSHI): rondas con ventanas crecientes | **pendiente** | era el paso 3 de la sección 8b |
| Estado «durmiente» al salir de cuadro | parcial | reglas de fuera de cámara de la app; el modelo de secuencias de equipo no lo mejoró |
| Anclas humanas como nodos fijos | **ya está en simulación** | `anchors.py`; falta la interfaz en la mesa |
| Balón como prior débil | **probado, sin efecto** | `priors.py`, `team_seq.py` (solo balón revisado a mano) |
| Pureza, leave-one-part-out | **ya está** | `links_eval.py` |
| MOTA / IDF1 / HOTA | pendiente (baja prioridad) | solo para comparar con la literatura; hoy se mide pureza, cobertura, errores y acciones manuales |
| Preentrenar con SoccerNet-Tracking / GSR | **pendiente, por verificar** | podría dar ejemplos de otros partidos y reducir el sesgo de entrenar con uno solo; hay que revisar licencia, formato y si trae coordenadas de cancha |
| Dorsales legibles | descartado por ahora | a ~60–100 px casi nunca se leen (sección 9) |

## 8g. Primera comparación A/B en la parte `v2_34220_45027` (2026-10-23)

Exportada desde la pestaña Revisión (`comparacion_v2_34220_45027.json`). A = relleno anterior; B = experimental (exclusión, dobles cajas, segunda pasada de saltos). La analista verificó a mano **solo dos jugadoras completas (Lelo y Paz)** para no hacer el trabajo dos veces; sin verdad con nombres.

| | A | B |
|---|---|---|
| Dudas resueltas a mano | 50 | 111 |
| Cajas quitadas por la regla automática | 73 (salto) | 1 938 (exclusión 856, ambas 365, ruta 325, salto 92) |
| Cajas dobles que quedan | 691 | 443 |
| Saltos imposibles que quedan | 79 | 82 |
| Ediciones manuales (unir / partir / quitar) | 275 (74 / 165 / 35, 1 renombre) | 87 (15 / 57 / 15) |
| Ediciones manuales de Lelo / Paz | 73 / 35 | 7 / 39 |
| Cronómetro (solo anclas y dudas): segundos / acciones | 149.5 / 23 | 793.3 / 82 |

- En las dos jugadoras comparables, **B pidió ~57 % menos ediciones manuales** (46 contra 108), sobre todo en Lelo (7 contra 73); Paz quedó igual (39 contra 35). La analista notó la diferencia sobre todo en los saltos.
- **Cautelas**: dos jugadoras en un solo tramo; A se trabajó primero (efecto de aprendizaje a favor de B); Kere (126 ediciones en A) no tiene contraparte en B; no hay marcas «verificada» ni verdad externa; la diferencia de Paz es nula.
- **El tiempo no es comparable todavía**: el cronómetro solo mide anclas y dudas, no las ediciones de la mesa, y B tiene más tareas (más saltos revisados). Por acción: A 6.5 s, B 9.7 s.
- **Cajas dobles**: la analista señala que muchas están en tramos de varias jugadoras juntas y no son un problema real; se cuenta como métrica secundaria. B sigue sin demostrar precisión de sus 1 938 descartes: solo hay evidencia indirecta (menos correcciones a mano).
- Siguiente: probar B en un tramo que la analista no haya visto, midiendo también el tiempo de las ediciones de la mesa.

## 9. Además de las etapas

- **Uniones aprendidas, no solo umbrales.** Las 4 292 uniones y 8 699 cortes manuales son ejemplos de «misma persona / otra»:
  un clasificador pequeño (árboles de gradiente, CPU) sobre hueco, distancia a la predicción, tamaño, color, cruces y grupo
  da una **probabilidad calibrada** por unión, que es lo que necesita la abstención. Los umbrales de la sección 6 quedan
  como reglas duras de seguridad.
- **Anclas donde hay duda, no repartidas.** En vez de 3 por minuto fijas: unas pocas iniciales y luego la app pide la
  siguiente donde la incertidumbre es mayor (aprendizaje activo). Suele bajar mucho el número de clics.
- **Restricciones de conteo**: nunca más de 11 por equipo ni más de una portera por equipo en un cuadro; dos trozos
  simultáneos no pueden ser la misma persona. Sirven para descartar uniones, no para crearlas.
- **Posición suavizada en metros** (filtro de Kalman con la homografía de cada cuadro) antes de predecir: las cajas
  tiemblan y en la cancha proyectada el ruido crece con la distancia a la cámara.
- **Apariencia más fuerte, opcional y medida**: un modelo de re-identificación ligero y gratuito (p. ej. OSNet) solo para
  los huecos de más de 5 s. Las jugadoras miden ~60–100 px de alto: hay que medir si ayuda antes de pagar su costo en CPU.
  Los dorsales casi nunca se leen a esta resolución.
- **El balón primero**, como propones: además de la formación, da quién presiona y quién recibe, útil justo en los
  huecos difíciles (jugadas cerca del balón, donde más cruces hay).

## 10. Preguntas para decidir

1. ¿Las anclas se ponen en una pasada propia (la app va saltando de momento sugerido en momento sugerido) o dentro de la
   revisión por jugadora que ya existe?
2. ~~¿Cerrar todos los huecos?~~ Decidido: no; prima la certeza (sección 4).
3. ~~Las rivales: ¿se nombran todas?~~ Decidido: equipo correcto y rol bastan; las rivales no se nombran.
4. ¿Se corre todo en la laptop (CPU) o la etapa de relleno se manda a Kaggle con el tracking?

Medición usada en este documento: scripts `trackstats.mjs` y `trackstats2.mjs` (fuera del repo, en el directorio
temporal de la sesión); conviene pasarlos a `src/sportsan/tracking/` como `python -m sportsan.tracking.audit` en la F1.
