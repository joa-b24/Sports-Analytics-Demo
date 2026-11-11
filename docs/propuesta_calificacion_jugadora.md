# Propuesta: calificación de jugadora (borrador para decidir)

Estado: **sin implementar**. Hay que aprobar las métricas y los pesos antes de escribir código.

## Principios
1. Una calificación de 0 a 10 por jugadora y partido, que **siempre muestra de dónde sale** (cada métrica con su aporte).
2. Solo cuenta lo que se midió: una métrica sin datos (`NaN`) no suma ni resta; sus pesos se reparten entre las demás y la ficha dice cuántas métricas entraron. Con menos de 4 métricas con datos no se califica.
3. Se compara contra un punto de referencia, no contra una escala inventada: **la media de las jugadoras del mismo partido que juegan en la misma línea** (portera, defensa, medio, delantera) o, cuando haya varios partidos, su propio historial. Cada métrica se convierte a puntaje z, se limita a ±2 y se lleva a 0–10 (5 = promedio).
4. Por 90 minutos cuando hay minutos; con menos de 20 min jugados no se califica.
5. Pesos por línea, editables en la configuración del análisis, y con una etiqueta de «propuesta» hasta que el cuerpo técnico los apruebe.

## Métricas y pesos (suma 100 por línea)

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

## Decisiones que necesito de ti
1. ¿Referencia: la línea del mismo partido (propuesta) o el historial propio de la jugadora?
2. ¿Los pesos de la tabla, o los ajustas?
3. ¿Se muestra la nota 0–10 o solo el desglose (más honesto con pocos partidos)? Mi recomendación: nota **y** desglose, con la nota en gris si entraron menos de 6 métricas.
4. ¿La portera se califica aparte? (paradas, salidas, pase largo): hoy faltan eventos para eso.
