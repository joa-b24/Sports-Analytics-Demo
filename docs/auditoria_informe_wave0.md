# Auditoría del informe (tarea 0.3, solo diagnóstico)

Partido: `2026_09_25_tec_ccm_vs_anahuac` (Tec CCM 11-0). Datos leídos: los 17 `tracks_fixed_*.json` (11 partes de v1, 4 de v2, 2 de v3) y `segments.csv`. No se modificó código, contrato ni datos. Los scripts de lectura están en el scratchpad de la sesión (`poss.py`, `diag.py`, `diag2.py`, `phys.py`, `dist2.py`, `perpart.py`, `passes.py`), replican línea a línea `web/lib/positions.ts` y `web/lib/physical.ts`.

## 1. Cómo se calcula cada cifra hoy

Todo sale de `tracks_fixed_*.json` (la mesa de corrección) cargado como `Oriented[]` (`lib/fixed.ts`). Nada de esto usa `src/sportsan/metrics/` (esa carpeta solo hace forma de equipo en Python: `team_shape.py`, `team_blocks.py`, `report.py`; no hay posesión, pases ni físico en Python).

| Cifra | Dónde | Fuente | Umbrales | Qué excluye |
|---|---|---|---|---|
| Posesión | `positions.ts` `ballStates` + `possessionCells` + `ballReport` | `f.ball` (manual / auto / event / interpolated) y `f.frames[].positions` | toque = jugadora más cercana a menos de `POSSESS_M` = 2 m (metros reales); disputado si una rival está a menos de 0.5 m de diferencia; el dueño se mantiene hasta `PASS_MAX_S` = 5 s sin otro toque; celdas de 0.5 s; solo dentro de tramos `juego` | (a) balón `interpolated` nunca da toque (línea 268); (b) jugadora con `source === "interpolated"` no es candidata (línea 272); (c) "sobrantes sin nombre" de un equipo que ya tiene nombres (`unnamedLeftovers`, `NAMED_TEAM_MIN` 0.5) no son candidatas; (d) equipo `unk`/`ref` no es candidato (línea 274); (e) cuadros "no seguidos": balón a más de 3 s de una marca manual/auto (`FOLLOW_S`) no cuentan tiempo; (f) disputado o sin toque en 5 s = `unassigned`, no se reparte |
| Pases / completos / cortados | `positions.ts` `passesAndTurnovers` | secuencia de toques (arriba) | dos toques consecutivos, distinto `id`, misma `team`, a menos de 5 s = pase; distinto equipo = pérdida ("cortado") | los mismos filtros de toque. Un "pase" se cuenta entre dos toques medidos aunque entre ellos haya habido un toque no marcado |
| Velocidad máxima | `physical.ts` `physical` | posiciones con nombre del equipo, por parte | ventana de 1 s centrada (`SPEED_WINDOW_S`); descarta el paso si > 36 km/h (`MAX_KMH`) | `q.source === "interpolated"` (línea 41); personas sin `player_id`; huecos > 1 s (`MAX_GAP_S`) cortan la serie |
| Más de 18 km/h | igual, `hsr_m` | suma de pasos con velocidad de ventana >= 18 km/h (`HSR_KMH`) | igual |
| Sprints | igual | rachas con ventana >= 22 km/h (`SPRINT_KMH`) durante >= 1 s (`SPRINT_MIN_S`) | igual; la racha se corta en cada hueco o parte |
| Distancia | igual, `distance_m` | suma de pasos entre muestras no interpoladas consecutivas con dt <= 1 s | igual; lo que cae en un hueco > 1 s no se suma |
| Minutos en cuadro | `players.ts` línea 105 (`p.seconds/60`) | `seconds` de `physical` | suma de dt de los pasos aceptados | igual (interpoladas, huecos > 1 s, pasos > 36 km/h) |
| Mapa de calor, nombres, forma del bloque | `positions.ts` 145/165/207, `physical.ts` 140, `report.ts` 159 | idem | | todos descartan `interpolated` |

Dónde se excluyen exactamente los datos interpolados:
- `positions.ts:101` (dirección de ataque), `:145` (mapas), `:165` (jugadoras con nombre), `:207` (sobrantes), `:268` (balón interpolado no es toque), `:272` (jugadora interpolada no es candidata), `:518`, `:628`, `:739`.
- `physical.ts:41` (series de velocidad/distancia) y `:140` (forma del bloque).
- `report.ts:159` (porcentaje de posiciones con nombre).

Lo interpolado es mucho. `smoothing.max_fill_s = null` en todas las partes: la mesa exporta con `maxFillS = +Infinity` (`Correction.tsx:271`, `fixedExport.ts:19`), es decir, rellena huecos de cualquier largo con una recta mientras la velocidad implícita sea <= 9 m/s. Eso no es interpolación corta: en las jugadoras con nombre, la mediana de un tramo interpolado es 0.3 s, pero el p99 es 19.6 s y el máximo 145.6 s; el 6 % de los tramos dura más de 2 s y concentra 7 812 de las 12 548 s interpoladas (62 %). Los tramos largos son en realidad "no se vio a la jugadora" y encajan con la definición de extrapolado/inventado; los cortos (<= 2 s) son la aproximación aceptable. Hoy ambos se tiran por igual en las métricas físicas, y el relleno largo nunca se distingue del corto.

## 2. Posesión: descomposición por causa

### 2.1 Reproducción del número

El cálculo replicado da, con la regla actual (variante A):

| | Segundos con balón seguido | Tuya | Rival | Sin dueño | % tuya (de lo asignado) |
|---|---|---|---|---|---|
| 1.er tiempo (v1) | 1 695 | 815.5 | 434.5 | 445.0 (26 %) | 65.2 % |
| 2.º tiempo (v2+v3) | 1 592.5 | 603.5 | 847.5 | 141.5 (9 %) | 41.6 % |
| Partido | 3 287.5 | 1 419.0 | 1 282.0 | 586.5 (18 %) | 52.5 % |

Esto explica las dos cifras que la analista vio: 65-35 era solo el primer tiempo (11 partes de v1) y ~55-45 es el partido entero al sumar el segundo.

### 2.2 Causa dominante: tres partes con balón automático arrastran el segundo tiempo

Posesión por parte (variante A actual; variante E = solo equipo, ver 2.4):

| Parte | Balón | A: tuya s / rival s / sin dueño s (%tuya) | E (%tuya) |
|---|---|---|---|
| v1_14541 | manual | 23.5 / 13.5 / 10.0 (64) | 62 |
| v1_16648 | manual | 81.5 / 61.5 / 43.0 (57) | 59 |
| v1_23140 | manual | 47.5 / 36.5 / 17.5 (57) | 53 |
| v1_26910 | manual | 89.0 / 36.0 / 47.0 (71) | 72 |
| v1_33818 | manual | 17.0 / 10.5 / 11.0 (62) | 59 |
| v1_36135 | manual | 53.0 / 17.5 / 38.0 (75) | 70 |
| v1_41994 | manual | 27.0 / 8.0 / 9.5 (77) | 82 |
| v1_44071 | manual | 88.5 / 28.0 / 41.0 (76) | 64 |
| v1_52933 | manual | 249.0 / 129.5 / 120.0 (66) | 62 |
| v1_6414 | manual | 94.0 / 65.0 / 84.5 (59) | 44 |
| v1_73385 | manual | 45.5 / 28.5 / 23.5 (61) | 62 |
| v2_0_4259 | manual | 38.5 / 33.0 / 32.0 (54) | 61 |
| **v2_10870_31699** | **auto (2 110 de 6 943)** | **207.0 / 458.5 / 23.5 (31)** | 46 |
| **v2_34220_45027** | **auto (808 de 3 602)** | **127.0 / 176.0 / 25.0 (42)** | 45 |
| v2_5020_10226 | manual | 71.5 / 39.0 / 18.0 (65) | 64 |
| v3_0_6890 | manual | 90.0 / 27.0 / 35.5 (77) | 70 |
| **v3_7651_13430** | **auto (682 de 1 927)** | **69.5 / 114.0 / 7.5 (38)** | 45 |

Las 14 partes con balón marcado a mano dan 54-77 % para el equipo propio en ambos tiempos. Las 3 partes con balón del tracker (`ball_auto`) dan 31-42 %, y esas tres suman 1 252 s del segundo tiempo (79 % de sus segundos medidos). Sumando solo las partes manuales del 2.º tiempo (v2_0, v2_5020, v3_0): 200.0 s propios contra 99.0 s rivales = 67 %.

Toques medidos por fuente de balón, 2.º tiempo (regla A):

| Fuente | Toques propios | Toques rivales | % propios |
|---|---|---|---|
| manual | 208 | 122 | 63 % |
| auto | 600 | 1 156 | 34 % |

(1.er tiempo, manual: 547 propios y 248 rivales, 69 %). Mismo tiempo, misma jugadora, dos fuentes de balón: una da 63 %, la otra 34 %. En esas 3 partes además hay mucha gente sin revisar: v2_10870 trae 544 ids `opp` y 1 128 ids `unk` (rivales sin color asignado); v2_34220 trae 318 `opp` y 578 `unk`; v3_7651 trae 142 `opp` y 213 `unk`. Los `unk` nunca son candidatos, pero el balón del tracker suele caer cerca de ellos, así que su efecto neto es empujar el balón a "sin dueño" o a la rival más cercana medida.

Qué NO se puede concluir con los datos: si el balón automático está sesgado hacia la zona rival (la posición media del balón en esas partes coincide con la del balón manual de la misma parte: territorio 47 % auto contra 38 % manual en v2_10870), o si el problema es el equipo asignado a los `unk`/`opp` sin revisar. Las dos hipótesis son compatibles con los números; hace falta mirar el video de 3-4 instantes por parte. Además, cerca de una marca manual (<= 0.34 s) el balón automático queda a una mediana de 13 m de la marca (p90 48 m, n = 475, v2_10870): no es una comparación limpia (las marcas manuales suelen estar donde el tracker falló), pero indica que el automático falla seguido.

### 2.3 Otras causas, cuantificadas

| Causa | Cifra (regla A) | Efecto |
|---|---|---|
| Sin balón en el tramo de juego | cobertura de balón: 1.er tiempo 78.4 % (1 676 de 2 138 s de juego), 2.º tiempo 88.2 % (1 582 de 1 794 s) | lo que no está se ignora; no sesga el reparto si falta al azar |
| Balón interpolado en vez de medido | 1.er tiempo: 86.9 % de los estados son interpolados y solo 13.1 % marcados a mano (2 192); 2.º tiempo: 72.9 % interpolados, 22.8 % auto, 4.3 % manual | solo el 13-27 % de los estados puede dar toque. Los tramos largos que quedan "seguidos" son el relleno hasta 3 s entre marcas |
| Más cercana lejos (> 2 m) en estados medidos | 1.er tiempo 1 128 de 2 193 (51 %); 2.º tiempo 1 707 de 4 336 (39 %) | es la mayor fuente de "sin toque". Con balón marcado en el suelo desde un video elevado, el error de proyección de un balón en el aire es de varios metros |
| Más cercana es una jugadora interpolada | 271 (1.er t.) y 363 (2.º t.) estados | el toque se pierde, no se reasigna |
| Más cercana es un sobrante propio sin nombre | 13 (1.er t.) y 127 (2.º t.) | pocos; en 2.º tiempo hay 15-16 % de posiciones propias sin nombre en v2_10870 y v2_34220 (`named_share` 0.85 y 0.84) |
| Más cercana es `unk` | 10 en el 2.º tiempo | despreciable por esta vía |
| Balón probablemente aéreo | velocidad entre dos marcas medidas consecutivas (<= 1 s): >18 m/s en 27.5 % (1.er t., n = 40) y 15.6 % (2.º t., n = 1 899); >30 m/s en 5.0 % y 9.4 %; p99 del 2.º tiempo = 483.6 m/s (saltos del tracker) | no hay detector de balón aéreo. Un balón rápido o alto se proyecta mal; el máximo físico de un tiro es unos 30 m/s |
| Personas duplicadas / equipo mal asignado | personas por cuadro en juego: 1.er tiempo 10.1 propias, 9.5 rivales, 0.0 `unk`; 2.º tiempo 12.4 propias (más de 11), 10.7 rivales, 0.5 `unk`. Rivales a menos de 0.8 m de una propia con nombre: 2.0 % (1.er t.) y 1.7 % (2.º t.) | en el 2.º tiempo hay más de 11 "propias" por cuadro: sobran cajas o jugadoras rivales con el color de las nuestras. Con rivales sin revisar no hay forma de saber cuáles |
| Identidad en rivales | 2.º tiempo: 242 "pases" rivales, 73 de ellos con menos de 0.5 s entre toques y 242 de 242 con un extremo sin nombre | el pase rival se cuenta por cambio de `id`, y el rival no tiene nombres: un mismo jugador que cambia de fragmento de track genera un "pase". Las cifras de pases rivales no son confiables |
| Pases propios en el 2.º tiempo | 106 completados y 237 cortados (31 % de acierto) contra 143 y 78 en el 1.er tiempo (65 %) | efecto de las partes con balón automático; no es creíble para un 11-0 |
| Balón disputado | 34 (v1 manual) y 19 + 4 (v2/v3 manual) estados | menor |
| Orientación | la posesión no depende de la orientación (solo del equipo asignado); sí el territorio. En las partes de 2.º tiempo la diferencia de x media entre propias y rivales es de solo 5-9 m (umbral 4 m) | no afecta posesión; sí la dirección usada en mapas y "tercios" |

### 2.4 Recalculo bajo variantes razonables

Cada variante acumula las anteriores. "Equipo solo" = toque de la jugadora más cercana de cualquier id (sin quitar sobrantes sin nombre, sin "disputado").

| Variante | 1.er t. %tuya (sin dueño) | 2.º t. %tuya (sin dueño) | Partido %tuya (sin dueño) |
|---|---|---|---|
| A. Actual (informe) | 65.2 (26.3 %) | 41.6 (8.9 %) | 52.5 (17.8 %) |
| B. Balón interpolado puede dar toque | 61.9 (18.5 %) | 43.7 (5.5 %) | 52.4 (12.2 %) |
| C. B + jugadoras interpoladas candidatas | 61.4 (19.3 %) | 45.4 (7.6 %) | 53.1 (13.6 %) |
| D. C + umbral 4 m y dueño sin tope de 5 s | 60.6 (11.9 %) | 46.8 (7.6 %) | 53.8 (9.8 %) |
| E. D + sin "disputado" y sin quitar sobrantes (equipo solo) | 60.6 (1.3 %) | 50.1 (0.0 %) | 55.5 (0.7 %) |
| F. E y se descartan estados con balón > 18 m/s | 62.3 (1.3 %) | 47.4 (0.0 %) | 55.0 (0.7 %) |
| G. A con dueño hasta 10 s | 63.1 (15.9 %) | 42.0 (5.4 %) | 52.3 (10.8 %) |
| H. B con dueño hasta 10 s | 60.7 (12.1 %) | 43.9 (4.1 %) | 52.2 (8.2 %) |
| Solo partes con balón manual (regla A) | 65.2 (26.3 %) | 67 % (3 partes) | ~65 % |

Lectura: ninguna decisión de umbrales, de incluir interpolados o de quitar aéreos mueve el partido más allá de 52-56 %; el ruido de método es de unos +-3 puntos. Incluir interpolados no cambia el reparto; sí reduce el "sin dueño" (de 18 % a 12 % con B). La brecha entre el 65 % esperable y el 52-55 % reportado viene de que 3 de las 6 partes del 2.º tiempo usan balón automático sin revisar. Con las partes revisadas a mano la posesión del 2.º tiempo sale en ~67 %, igual que el 1.er tiempo.

Primer vs segundo tiempo: las jugadoras propias del 2.º tiempo sí están verificadas (11 con nombre en casi todas las partes, `named_share` de 0.84-1.0), pero eso no corrige la posesión: la cifra depende del balón y de los rivales sin revisar, no de las nuestras.

## 3. Velocidad máxima, sprints y más de 18 km/h

Resultado por jugadora (todas las partes, solo jugadoras propias con nombre; replica `physical()`):

| Jugadora | Min medidos | Distancia (m) | Vel. máx (km/h) | > 18 km/h (m) | Sprints | Pasos > 36 km/h descartados | % interpolado | % de lo interpolado en huecos > 2 s |
|---|---|---|---|---|---|---|---|---|
| Paz | 52.9 | 6 884 | 32.9 | 272 | 1 | 38 | 23 | 56 |
| Quiroz | 55.6 | 6 492 | 33.2 | 628 | 7 | 31 | 18 | 62 |
| Ceci | 51.0 | 6 404 | 35.4 | 645 | 13 | 69 | 29 | 47 |
| Shu | 48.4 | 6 370 | 33.2 | 461 | 5 | 32 | 33 | 43 |
| Lelo | 54.2 | 5 891 | 29.7 | 317 | 3 | 16 | 21 | 54 |
| Zoe | 42.5 | 5 487 | 35.7 | 239 | 4 | 59 | 21 | 34 |
| Regi | 35.8 | 4 778 | 34.6 | 358 | 2 | 41 | 43 | 84 |
| Kat | 26.3 | 3 530 | 32.9 | 256 | 2 | 34 | 43 | 78 |
| Kere | 25.7 | 3 376 | 33.7 | 115 | 0 | 5 | 21 | 28 |
| Citla | 25.8 | 3 199 | 30.9 | 307 | 3 | 34 | 32 | 71 |
| Ivonne | 21.5 | 2 885 | 34.3 | 198 | 1 | 47 | 46 | 56 |
| Lya | 15.8 | 2 071 | 28.2 | 118 | 0 | 6 | 49 | 80 |
| Ita | 12.8 | 1 651 | 31.2 | 48 | 0 | 12 | 37 | 43 |
| Xime | 12.1 | 1 610 | 25.8 | 195 | 2 | 3 | 32 | 33 |
| Zoe S. | 10.1 | 856 | 31.2 | 16 | 0 | 5 | 62 | 97 |
| ZoeS | 0.1 | 6 | 11.5 | 0 | 0 | 0 | 0 | 0 |

Artefactos encontrados:

1. Máximos irreales. Hay 7 jugadoras con máximo >= 33 km/h y Zoe llega a 35.7; en fútbol femenino de élite el máximo medido ronda 30-33 km/h y en universitario es menor. Son 44 ventanas de 1 s >= 30 km/h. Ejemplos (jugadora, video, t del video, km/h de ventana, km/h del paso individual, duración de la ventana): Zoe v1 1534.5 s, 35.7 / 28.5 / 0.8 s; Ceci v1 1572.5 s, 35.4 / 32.9 / 0.6 s; Zoe v1 1992.7 s, 35.4 / 10.5 / 0.6 s; Ceci v1 1965.1 s, 34.7 / 12.5 / 0.5 s; Regi v1 2139.8 s, 34.6 / 15.8 / 0.8 s; Ivonne v1 1538.2 s, 34.3 / 31.4 / 0.6 s; Kere v2 1258.1 s, 33.7 / 17.8 / 0.5 s; Quiroz v2 1479.4 s, 33.2 / 28.3 / 0.7 s.
2. La barrera de 36 km/h solo quita el paso saltador, no la ventana. `physical.ts:71` hace `continue` sobre el paso de más de 36 km/h, pero la ventana de 1 s de los pasos vecinos incluye ese salto en `s[a]..s[b]`, así que la velocidad de ventana se infla. Los casos de arriba con paso individual bajo (10.5, 12.5, 15.8 km/h) y ventana de 34-35 km/h son saltos de track cercanos; ya hay 432 pasos de más de 36 km/h en el tracking suavizado (264 segundos distintos; ningún segundo con 3 o más jugadoras a la vez, por lo que son saltos de identidad entre parejas y no cambios de cámara), y todos contaminan sus ventanas vecinas.
3. Ventanas cortas. La ventana exige solo `span >= 0.5 s` (la mitad de 1 s); varias ventanas de 0.5-0.6 s con 35 km/h son un par de muestras de 0.1 s con un salto. Al excluir interpoladas, las ventanas cerca de un hueco se acortan y son las más ruidosas.
4. Sprints bajos. Entre 0 y 13 por jugadora (Paz 1, Kere 0, Lya 0). Un sprint exige >= 22 km/h de ventana durante 1 s sin ningún hueco: cada hueco de interpolados, aunque sea de 0.4 s, corta la racha (`sprintStart = null`). Los sprints se están subcontando por la exclusión de interpolados, y al mismo tiempo el máximo se infla por los saltos: ambos errores van en direcciones opuestas.
5. Distancia subcontada. Varias jugadoras tienen entre 18 % y 62 % de sus posiciones interpoladas; el 62 % del tiempo interpolado está en huecos de más de 2 s. Distancia por jugadora con tres criterios:

| Jugadora | Actual (min) | + interpolados <= 2 s (min) | + todos los rellenos (min) |
|---|---|---|---|
| Paz | 6 884 m (52.9) | 7 425 (56.1) | 7 999 (64.4) |
| Quiroz | 6 492 (55.6) | 6 870 (57.3) | 7 468 (64.5) |
| Ceci | 6 404 (51.0) | 7 273 (55.7) | 7 931 (64.7) |
| Shu | 6 370 (48.4) | 7 566 (55.1) | 8 217 (64.4) |
| Lelo | 5 891 (54.2) | 6 425 (57.4) | 6 935 (64.9) |
| Regi | 4 778 (35.8) | 5 159 (37.6) | 6 166 (59.3) |
| Ivonne | 2 885 (21.5) | 3 562 (24.9) | 4 012 (33.7) |

   Añadir los interpolados cortos (<= 2 s) sube la distancia 5-30 %; añadir todos los rellenos la sube más y es la parte que sí es "inventada" (Regi pasa de 35.8 a 59.3 min con relleno largo). Los "minutos medidos" actuales de 50-55 para las titulares son menos que el tiempo de juego (65.5 min marcado en `segments.csv`).
6. Nombres inconsistentes: `Zoe`, `Zoe S.` y `ZoeS` aparecen como tres personas (mapas y totales se dividen).
7. Solo hay 4 goles etiquetados en `events_2026_09_25_tec_ccm_vs_anahuac.csv` (el informe `report_...json` muestra 4-0 con `match_id` antiguo `partido_2026_09_25` y texto de nombre con codificación rota); no es parte de este diagnóstico pero hace dudar de cualquier comparación contra eventos.

## 4. Minutos en cuadro y fórmula nueva de minutos jugados

Hoy ("Minutos en cuadro", `players.ts:187`) = `seconds` de `physical()`: suma de dt de pasos entre muestras no interpoladas, con huecos <= 1 s y sin pasos de más de 36 km/h. Es tiempo visto, no tiempo jugado, y se usa como denominador de "por 10 min en cuadro" (`players.ts:195-205`). Una jugadora que jugó todo el partido sale con 35-55 min porque la cámara no la veía.

Propuesta:

```
minutos_jugados(jugadora) = sum sobre cada tiempo T de
    [ fin(T) - inicio(T) ] - sum de minutos fuera de la cancha de T
```

- `inicio(T)` y `fin(T)`: primer `start` y último `end` de los tramos `tipo = juego` de ese periodo en `segments.csv` (agrupados por `period` del video en `match.yaml`); da minutos de reloj. Si se prefiere minutos de juego efectivo, sumar solo los tramos `juego`. Hay que fijarlo con la analista (hoy el informe dice "minutos de juego").
- Minutos fuera: para cada `substitution` con `player_id` = sale, desde `t_video` hasta `fin(T)`; para cada `player_in` = entra, desde `inicio(T)` hasta su `t_video`. Una jugadora que sale y vuelve a entrar suma los dos intervalos.
- Convertir `t_video` a minuto del periodo con el mismo eje que `matchTimeline` (`lib/videos.ts`), porque un tiempo puede venir en varios videos (v2 + v3).

Datos que faltan: no hay ningún evento `substitution` en el CSV (el tipo existe y `report.ts:720` los lee), ni lista de titulares. Hace falta: (1) eventos `substitution` con `player_id` (sale) y `player_in` (entra) y `t_video`; (2) 11 titulares por tiempo, que pueden salir de `formacion.json` si lo trae (no se verificó su contenido); (3) tarjetas rojas (`foul` detail red) para cortar los minutos de una expulsada; (4) acordar si los minutos van en reloj o en juego efectivo. Mientras no haya cambios etiquetados, el valor por defecto sería "todo el tiempo de ambos periodos" para todas las que aparecen con nombre, y la columna actual se renombra "Tiempo visto" y se mantiene como cobertura.

## 5. Causa más probable de la posesión errónea

Orden de probabilidad:

1. (alta) Las tres partes del 2.º tiempo con balón del tracker (`ball_auto`, 3 de 6 partes, 79 % de los segundos medidos del 2.º tiempo) dan 31-42 % de posesión propia, frente a 54-77 % en las 14 partes con balón a mano. La mezcla produce 41.6 % en el 2.º tiempo y 52.5 % en el partido. Lo apoyan: mismo tiempo, 63 % de toques propios con balón manual contra 34 % con balón automático; pases propios completados 31 % en esas partes; 13 m de mediana de diferencia contra marcas manuales cercanas.
2. (media) Rivales sin revisar en esas mismas partes (544/1 128, 318/578 y 142/213 ids `opp`/`unk`) y 12.4 propias por cuadro (más de 11): toques repartidos a rivales fantasma o duplicados. No se puede separar de (1) sin ver el video.
3. (media) El balón marcado a mano, en el suelo, no representa el balón aéreo, y 39-51 % de los estados medidos tienen a la más cercana a más de 2 m; es ruido, no sesgo, y el recálculo (variantes B-F) lo muestra: +-3 puntos.
4. (baja) Excluir interpolados: en balón, no cambia el reparto (B: 52.4 contra 52.5 %); en jugadoras, 1-2 puntos. La sospecha de la analista sobre esto sí es válida para las métricas físicas (distancia, sprints, minutos) pero no para la posesión.

## 6. Arreglos propuestos (sin implementar), por prioridad

1. Revisar el balón automático de las 3 partes (v2_10870_31699, v2_34220_45027, v3_7651_13430): muestreo visual de 20-30 instantes por parte; si falla, marcar o rechazar con la vista Balón y recalcular. Es lo único que cambia el número de forma material. (app-engineer / analista)
2. Mostrar la posesión por tiempo y por fuente de balón en el Informe, con el "% de estados con balón manual/automático/interpolado" y marcar en rojo si la fuente automática es > 30 % de los estados medidos. Hoy una sola cifra mezcla fuentes de calidad distinta. (`report.ts`, `positions.ts`)
3. Física: separar interpolado corto (<= 2 s) de relleno largo. Contar los cortos en distancia y sprints (la analista ya lo aceptó como aproximación); seguir excluyendo el relleno largo y reportar "metros estimados con relleno largo" aparte. Exportar un campo por posición (p. ej. `gap_s`) o recalcularlo al cargar. (`physical.ts`, `smooth.ts`/`fixedExport.ts`)
4. Física: filtrar saltos antes de la ventana, no solo el paso. Descartar la ventana entera si contiene un paso > 36 km/h o si `span < 0.8 * SPEED_WINDOW_S`; no cortar la racha de sprint por un hueco < 0.5 s; poner un tope de plausibilidad al máximo (por ejemplo, marcar > 33 km/h como "revisar"). (`physical.ts`)
5. Mínutos jugados con la fórmula de la sección 4 y renombrar la columna actual a "Tiempo visto". Pide a la analista etiquetar `substitution` y titulares. (`players.ts`, `lib/tagging.ts`)
6. Pases rivales: no contar pase cuando ambos extremos no tienen nombre o el intervalo es < 0.5 s, o dejarlos fuera hasta revisar rivales; indicar en el informe que "pases rivales" no es medido. (`positions.ts` `passesAndTurnovers`)
7. Posesión por equipo, sin identidad: si la meta es posesión a nivel equipo, usar la variante E (equipo más cercano a 4 m, sin quitar sobrantes ni "disputado") como cifra principal y la actual como "con toque claro". Reduce el sin dueño de 18 % a 0.7 %. Cambio pequeño; no cambia la conclusión de (1).
8. Pasar a `unk` a la lista de revisión: listar por parte cuántos ids `unk`/`opp` sin nombre hay y cuántas propias por cuadro pasan de 11 (señal de color mal asignado). (`lib/tracks.ts`)
9. Unificar nombres `Zoe`, `Zoe S.`, `ZoeS` en la plantilla (`config/roster.json`). (analista)
10. Opcional: un detector de balón aéreo (velocidad > 25 m/s o salto > 15 m en 0.1 s) para excluir del reparto de posesión y de los pases, y marcarlos como "balón en el aire". Con la variante F su efecto fue de +-2 puntos.

## 7. Preguntas abiertas

- ¿El balón automático (`ball_auto_*`) de las partes v2_10870, v2_34220 y v3_7651 fue revisado a mano? El código cuenta como `auto` los puntos que el tracker marcó con p >= 0.9 y que la analista no rechazó, sin exigir revisión.
- ¿Los `unk` de esas partes son rivales sin color asignado o personas fuera de la cancha? Hay 12.4 propias por cuadro en el 2.º tiempo; ¿son duplicados o rivales con el color de las nuestras?
- ¿Minutos en reloj (primer inicio a último fin de cada tiempo) o en juego efectivo (suma de tramos `juego`)? ¿Hay `formacion.json` con titulares utilizables?
- ¿Se aceptan los rellenos largos como "aproximación" para distancia, o solo los de <= 2 s? Cambia entre 5 % y 60 % de la distancia de algunas jugadoras.
- ¿Los 11 goles están etiquetados? El CSV de eventos solo tiene 4, y el informe guardado dice 4-0.
