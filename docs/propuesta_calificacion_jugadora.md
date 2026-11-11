# Propuesta: calificación de jugadora (borrador para decidir)

Estado: **implementada y marcada «en revisión»** (`web/lib/rating.ts`, `components/match/RatingBadge.tsx`). Sale en la ficha, en la tabla por jugadora, en el perfil comparativo y en la tabla física del Informe. Los pesos y descuentos de abajo son los que usa; el cuerpo técnico debe aprobarlos o cambiarlos. Sin posición en la plantilla, todas se califican con los pesos de medio. Las acciones buenas con consecuencia también suman (recuperación que acaba en tiro +0.3 o gol +1.0; pase clave que acaba en gol +0.5; tope +2).

## Principios
1. Una calificación de 0 a 10 por jugadora y partido, que **siempre muestra de dónde sale** (cada métrica con su aporte, y cada descuento con su momento en el video).
2. Solo cuenta lo que se midió: una métrica sin datos (`NaN`) no suma ni resta; sus pesos se reparten entre las demás y la ficha dice cuántas métricas entraron. Con menos de 4 métricas con datos no se califica.
3. Se compara contra un punto de referencia, no contra una escala inventada: **la media de las jugadoras del mismo partido que juegan en la misma línea** (portera, defensa, medio, delantera) o, cuando haya varios partidos, su propio historial. Cada métrica se convierte a puntaje z, se limita a ±2 y se lleva a 0–10 (5 = promedio).
4. Por 90 minutos cuando hay minutos; con menos de 20 min jugados no se califica.
5. Pesos por línea, editables en la configuración del análisis, y con una etiqueta de «propuesta» hasta que el cuerpo técnico los apruebe.

## Parte que suma (suma 100 por línea)

| Métrica | Fuente | Defensa | Medio | Delantera |
|---|---|---|---|---|
| Pases completados (%) | tracking | 15 | 15 | 8 |
| Pases progresivos | tracking | 12 | 14 | 8 |
| Pases clave / asistencias | eventos | 3 | 10 | 14 |
| Tiros a puerta y goles | eventos | 2 | 8 | 28 |
| Entradas al último tercio y al área | eventos | 5 | 10 | 14 |
| Recuperaciones | eventos | 18 | 12 | 6 |
| Duelos ganados (%) | eventos | 20 | 10 | 8 |
| Pérdidas (menos es mejor) | eventos | 15 | 11 | 8 |
| Distancia a alta intensidad | tracking | 5 | 7 | 5 |
| Faltas y tarjetas (menos es mejor) | eventos | 5 | 3 | 1 |

## Parte que resta: acciones de consecuencia
La nota base trata todas las pérdidas y faltas igual. Un descuento aparte pesa lo que **costó** la acción, no solo que ocurrió. Se detecta con los eventos etiquetados, por la ventana de tiempo que se configura en el análisis (hoy 15 s):

| Acción | Cómo se detecta | Descuento propuesto |
|---|---|---|
| Pérdida que acaba en gol del rival | su pérdida y un gol rival dentro de la ventana | −1.0 |
| Pérdida que acaba en tiro del rival | pérdida y tiro rival en la ventana | −0.5 |
| Pérdida que acaba en entrada al área rival | pérdida y entrada al área rival en la ventana | −0.3 |
| Falta que origina un tiro o un gol | su falta y, tras ella, tiro o gol rival en la ventana (tiro libre, penal o jugada siguiente) | −0.5 / −1.0 |
| Pérdida seguida de falta de la misma jugadora y gol (cadena) | las dos reglas anteriores juntas | se suman, con un tope de −1.5 por cadena |
| Tarjeta roja | evento de falta con detalle «roja» | −1.5 |

Reglas de este bloque:
- **Cadena a la jugadora que empieza**: en el ejemplo de Kere antes del tercer gol (pierde el balón, persigue, hace falta y de la falta cae el gol), la pérdida y la falta son suyas y la cadena entera le resta. Si otra jugadora comete la falta, esa falta es de la otra; la pérdida sigue siendo de Kere.
- Descuento máximo por partido: −3 puntos, para que una sola noche mala no hunda la nota sin ver lo demás.
- Cada descuento aparece en la ficha como una línea con su minuto y un enlace al video, para que se pueda discutir.
- **Simétrico**: las acciones con consecuencia positiva (recuperación que acaba en tiro o gol propio, pase que acaba en gol) podrían sumar de forma parecida (+0.3 a +1.0). Hay que decidirlo: sin eso la nota solo castiga.

## Decisiones que necesito de ti
1. ¿Referencia: la línea del mismo partido (propuesta) o el historial propio de la jugadora?
2. ¿Los pesos de la tabla, o los ajustas?
3. ¿Los descuentos de la tabla y el tope de −3?
4. ¿Se suman también las acciones con consecuencia positiva?
5. ¿Se muestra la nota 0–10 o solo el desglose (más honesto con pocos partidos)? Mi recomendación: nota **y** desglose, con la nota en gris si entraron menos de 6 métricas.
6. ¿La portera se califica aparte? (paradas, salidas, pase largo): hoy faltan eventos para eso.

## Ajuste del 2026-11-10 (calificaciones muy estrictas)
- Una jugadora normal de su equipo saca **6** (antes 5); z = +2 es 10 y z = −2 es 2.
- Nueva métrica «Toques» (≈10 de peso) y las pérdidas se comparan **por 100 toques** (quien toca más, pierde más).
- Bonos nuevos: gol +0.7, tiro a puerta +0.25 (el tiro de un gol no cuenta aparte), pérdida que ella misma recupera en la ventana rápida +0.3, pase clave que acaba en tiro +0.3, córner a favor +0.1 (con remate +0.4), falta a favor +0.1 (con remate +0.3), falta provocada +0.3 (falta del rival marcada con su nombre). Tope de los bonos +3.

## Ajuste del 2026-11-10 (cadenas y desglose)
- El desglose de la calificación ya no se muestra en la ficha ni en el perfil comparativo (queda el número con «en revisión»). El cálculo sigue en `ratingAdjustments` y `RatingDetail` por si se vuelve a necesitar.
- Los goles y tiros se leen como el resto de la app (`finishes`): un gol sin nombre con el tiro de una jugadora es de ella, y el tiro de un gol no suma aparte.
- La falta ahora busca su consecuencia también en el tiro libre (o penal) que el rival cobra hasta 90 s después, y el gol o remate que sale de él. Una pérdida seguida de falta propia de la misma jugadora forma una cadena con la falta: juntas restan como máximo 1.5.
- Recuperación que acaba en gol propio baja a +0.5 y en tiro a +0.2.
