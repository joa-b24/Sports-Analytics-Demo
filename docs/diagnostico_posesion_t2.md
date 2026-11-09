# Diagnóstico de la posesión del 2.º tiempo (W1, solo diagnóstico)

Partido `2026_09_25_tec_ccm_vs_anahuac`. No se tocó código, contrato ni datos de `matches/`. Scripts en el scratchpad de la sesión: `w1_classes.py`, `w1_poss.py` (+ `w1_poss.json`), `w1_conf.py`, `w1_touch.py`, `w1_lab.py`, `w1_series.py`, `w1_frames.py` (cuadros en `w1_frames/`). `w1_poss.py` reproduce línea a línea `positions.ts` (variante A = 41.6 % del 2.º tiempo, igual que la auditoría).

## 1. Clases de id y qué es `unk`

`tracks_fixed_*.json` trae `people[]` con `team` y `player_id`. `team` sale de `tracking/process` (color de torso contra `jersey_colors`; `TEAM_CODES = unk, own, opp, ref`); queda `unk` cuando el color está a más de `MAX_COLOR_DISTANCE` de todas las referencias o la segunda más cercana está a menos de `TEAM_MARGIN` (`web/lib/tracks.ts:137-138`). `unk` = persona detectada cuyo color no decide equipo (ropa blanca, sombra, bordes, público/banca) y nunca es candidata a toque. La mesa de corrección luego une pistas en "personas" (`people[].tracks`), por eso hay cientos de ids: son fragmentos, no personas.

Clases por parte (cuadros de juego; "sin interp." = sin posiciones `interpolated`). Por cuadro, con interpoladas / sin:

| Parte (balón) | ids: opp / unk / own sin nombre / own con nombre | opp por cuadro | own con nombre | own sin nombre | unk |
|---|---|---|---|---|---|
| v2_0_4259 (manual) | 92 / 3 / 2 / 11 | 9.8 / 7.6 | 9.4 / 6.8 | 0.5 / 0.1 | 0.0 |
| v2_5020_10226 (manual) | 150 / 1 / 0 / 11 | 11.0 / 8.0 | 10.6 / 8.0 | 0 | 0 |
| v3_0_6890 (manual) | 153 / 0 / 0 / 11 | 9.4 / 7.4 | 9.7 / 6.8 | 0 | 0 |
| v2_10870_31699 (auto) | 544 / 1128 / 386 / 13 | 11.0 / 8.2 | 10.8 / 6.9 | 3.1 / 1.2 | 0.7 / 0.5 |
| v2_34220_45027 (auto) | 318 / 578 / 210 / 11 | 11.4 / 8.0 | 10.4 / 6.8 | 2.9 / 1.3 | 0.8 / 0.3 |
| v3_7651_13430 (auto) | 142 / 213 / 67 / 11 | 10.2 / 8.0 | 10.3 / 7.2 | 1.8 / 0.8 | 0.2 / 0.1 |

Las "12.4 propias por cuadro" de la auditoría = 9.4-10.8 con nombre + 0.5-3.1 sin nombre (con interpoladas). Las 11 con nombre ya llegan a 10-10.8, así que lo sin nombre es excedente: la portera (camiseta naranja/roja, vista en cuadros), jugadoras nuestras sin unir a su nombre y duplicados. Solo las 3 partes automáticas tienen ese excedente; las manuales casi no.

Confusión de color crudo contra clase final (cajas en cancha y en juego, `w1_conf.py`): en TODAS las partes, 4-13 % de las cajas con color `own` terminaron en una persona `opp` (manuales 7.5 / 13.2 / 8.3 %, automáticas 4.3 / 6.4 / 7.8 %). No es un problema exclusivo de las partes automáticas.

## 2. Posesión T2 por parte y variante (`w1_poss.json`)

% propio de lo asignado (segundos propios / rivales / sin dueño). a = como hoy; b = propias solo con nombre, todo lo demás rival; c = b y cajas fuera de [0,105]x[0,68] ignoradas; d = c y sin puntos de balón automático con p < 0.97 (0.99 entre paréntesis). Los datos no traen confianza por punto en `tracks_fixed`; se cruzó `ball_auto_*.json` por cuadro (p mínima 0.90, mediana 0.98-0.996).

| Parte | Balón | a | b | c | d (p>=.97 / .99) |
|---|---|---|---|---|---|
| v2_0_4259 | manual | 53.8 | 53.8 | 53.8 | 53.8 |
| v2_5020_10226 | manual | 64.7 | 64.7 | 64.1 | 64.1 |
| v3_0_6890 | manual | 76.9 | 76.9 | 76.9 | 76.9 |
| **manual (3 partes)** | | **66.9** (200 / 99 s) | 66.9 | 66.7 | 66.7 |
| v2_10870_31699 | auto | 31.1 (207 / 458.5 s) | 28.5 | 29.1 | 33.2 / 34.1 |
| v2_34220_45027 | auto | 41.9 (127 / 176 s) | 41.0 | 41.0 | 40.7 / 48.7 |
| v3_7651_13430 | auto | 37.9 (69.5 / 114 s) | 36.5 | 36.1 | 36.7 / 39.9 |
| **auto (3 partes)** | | **35.0** | 33.1 | 33.3 | 35.5 / 37.4 |
| **T2 total** | | **41.6** | 40.0 | 40.1 | 42.8 / 45.4 |

Variantes extra sobre H1/H3 (T2 total): quien bloquea (más cercana `unk` o propia sin nombre da "sin dueño" en vez de saltarse a la rival siguiente) 42.2 %; bloquea + jugadoras interpoladas candidatas 43.5 %; umbral de 4 m 39.6 %. Ninguna sube de 45 %.

Los toques medidos (balón no interpolado a menos de 2 m de la más cercana, `w1_touch.py`): partes manuales, 172 con dueño propio/rival contra 78 (69 % propio); automáticas, la más cercana es rival (`opp`, color `opp`) en 31.3 % de los cuadros de balón, propia con nombre en 16.7 %, propia sin nombre en 3.6 %; el 46 % no tiene a nadie a menos de 2 m (igual que en manual, 43 %). Una rival con color crudo `own` solo toca el balón en 0.7 % de esos cuadros: el color crudo no es el culpable.

Cota superior del error de color: con el Lab de las cajas (`w1_lab.py`; centroides propios con nombre L~85-96, rivales L~21-35), entre las rivales que "tocan" el balón, 8-13 % en v2_10870/v2_34220 y 21 % en v3_7651 tienen color más cercano al propio que al rival (manuales: 14-29 %). Si todas fueran nuestras, T2 subiría unos 5-7 puntos, y esa fuga existe también en las partes manuales, así que no explica la brecha.

Escalón en el tiempo (`w1_series.py`, ventanas de 4 min): v2 pasa de 78 % (manual, min 4-8) a 44 % (auto, min 4-8 con el balón automático) y 29 / 28 / 29 % en los 3 siguientes; v3: 77 % (manual, min 0-4) y 38 % (auto, min 4-8). Es un cambio brusco justo donde cambia la fuente, pero también cambia la fase de juego, así que por sí solo no demuestra artefacto.

## 3. Verificación visual (15 cuadros, 5 por parte automática, repartidos en tramos de juego)

Imágenes: `scratchpad\w1_frames\<parte>_<cuadro>.jpg` (izquierda cuadro completo con balón en rojo y cajas por clase: azul claro = propia con nombre, magenta = propia sin nombre, naranja = rival, blanco = `unk`, gris = árbitro; derecha ampliación 3x del balón). Todas se miraron.

| Cuadro | Balón automático | Quién está más cerca / observación |
|---|---|---|
| v2_10870 f12871 | correcto (p 1.0) | disputa rival negra / nuestra azul; la caja azul está unida a la negra |
| f16459 | correcto (0.996) | al pie de un hombre de camisa blanca en la banda (staff), clasificado `opp`; balón en la raya, probablemente fuera |
| f21181 | correcto | propia con nombre |
| f26197 | **incorrecto** (0.979) | está sobre el "50" pintado del césped; no hay balón ahí |
| f29941 | correcto (1.0) | a un lado de una nuestra azul cuya caja está marcada `opp` (junto a una rival); toque podría ir a rival |
| v2_34220 f35060 | correcto | nuestra azul y rival pegadas, ambigua |
| f36197 | correcto | rival (dueña real) |
| f38426 | correcto | propia en la banda |
| f41927 | correcto | nadie cerca, en la banda; en el mismo cuadro 3 azules con caja `opp` |
| f43763 | **incorrecto o dudoso** (0.917) | círculo sobre el torso de una rival; en la ampliación se ve un balón en el aire más arriba |
| v3_7651 f8326 | correcto | rival (dueña real) con una portera propia sin nombre a ~1 m |
| f9292 | correcto | rival y nuestra #38 adyacentes |
| f10429 | correcto | rival (dueña real) |
| f11209 | correcto (1.0) | nuestra #7 (azul) con caja `opp` y a su lado un hombre de blanco (staff) `opp`; el toque iría a rival |
| f12556 | correcto (0.96) | nuestra en la banda; abajo, nuestra #7 `opp` y un hombre de blanco `opp` |

Conteo: balón en su lugar 13 de 15 (87 %); 2 falsos (el número pintado, y un balón aéreo). De los 11 cuadros decidibles, dueña real: ~5 propia, ~5 rival, 1 disputada, es decir ~50 %, no 31-42 %, pero la muestra es chica. Cajas `opp` que en realidad no son rivales: 5 de 15 cuadros muestran una jugadora nuestra de azul con caja `opp` (f29941, f41927, f11209, f12556, f43763, incluso el #7 aparece como `opp` en dos cuadros), y 4 cuadros muestran personal de banca/árbitro de camisa blanca o chaleco amarillo clasificado `opp` o `own` (f16459, f11209, f12556, f8326). No se vieron rivales con caja `own` con nombre (las con nombre están bien).

Contra marcas manuales (v2_10870): de 204 pares marca manual / punto automático a menos de 0.35 s, mediana 20.7 m, 61 % a más de 10 m y solo 28 % a menos de 3 m. Esto es sesgado a lugares donde la analista corrigió, pero confirma que el tracker falla seguido. Saltos de balón automático consecutivos (<= 0.5 s): 7.2 % superan 30 m/s (imposible), p90 = 27 m/s.

## 4. Conclusión

Ninguna hipótesis por sí sola explica el 42 %:

- H1 (equipo mal asignado): real pero chica. Cambia el T2 entre -1.6 y +3 puntos con las reglas posibles; el error de color con cota superior ~5-7 puntos existe igual en las partes manuales. Hay personas ajenas (banca, staff) y nuestras jugadoras (#7) con caja `opp`, y 3 propias sin nombre por cuadro, pero eso solo mueve unos puntos.
- H3 (criterio de más cercana): descartada como causa grande. Umbral 2 vs 4 m, bloqueo por `unk`, interpoladas, dentro de la cancha: 39.6-43.5 %. Un defecto real, menor: hoy las propias sin nombre y `unk` se saltan (`unnamedLeftovers` y `team` desconocido), así que el toque pasa a una rival más lejana (hasta 2 m) en vez de quedar sin dueño.
- H2 (balón automático): es el único factor que cambia por parte de forma sistemática (2 de 15 falsos a mano, 61 % lejos de las marcas manuales, 7 % de saltos imposibles, escalón al cambiar la fuente) pero no hay evidencia de que sesgue a favor de rivales: los falsos vistos (número pintado, balón aéreo) no cayeron cerca de rivales ni de nuestras. Filtrar por confianza (d) sube solo 1-4 puntos porque los falsos tienen p alta (0.979).
- Explicación más probable de la brecha: mezcla. (1) Las 3 partes manuales (550 s, inicio del 2.º tiempo y arranque del v3) son una muestra distinta y más corta que las automáticas (1 252 s): con un 11-0 puede haber tramos con mucha posesión rival; no se puede validar sin etiquetas T2 (no hay eventos de pase, tiro o gol del T2 en el CSV; solo 11 eventos en v3_0_6890 y 4 en v2_0). (2) Un 13 % de falsos más 5-7 puntos de color más ~2 de criterio dan una cota realista de 45-50 % para el T2, no 65 %. En conclusión, el 42 % está subestimado por unos 5-9 puntos (color, balón falso, personal ajeno), pero la brecha de 25-30 puntos contra las partes manuales no se explica solo por esos artefactos; el resto queda como incertidumbre y no se puede resolver mirando tracking.

## 5. Arreglo mínimo (sin implementar) y test

1. `web/lib/positions.ts` (`ballStates` / candidatas): para un equipo con nombres verificados (`named_share` > 0.5), tratar toda persona sin nombre de ese equipo como "no equipo propio" pero que bloquee, en lugar de saltarla: si la más cercana a 2 m es sin nombre o `unk`, el estado es `unassigned`. Cambio de ~3 líneas; el T2 pasa de 41.6 a 42.2 (efecto pequeño pero elimina el sesgo hacia la rival siguiente).
2. Descartar del balón automático los puntos con salto > 30 m/s a ambos vecinos (en `tracking/ball.py` al escribir `ball_auto_*.json`, y como respaldo en `lib/parts.ts`), y marcar para revisión los puntos dentro de la caja de un árbitro/persona `ref` o `unk`. Los falsos de p alta (número pintado, balón aéreo) no los toma un umbral de confianza.
3. Informe: mostrar posesión por fuente de balón (manual / auto) y avisar cuando la mayor parte de los segundos medidos sean automáticos y sin revisar (`report.ts`), como ya pide la auditoría §6.2. Es lo que evita presentar 42 % como un resultado.
4. Equipo: en la mesa de corrección listar las cajas `opp` cuyo color Lab está más cerca del propio (cola de revisión, 8-13 % de los toques rivales).

Test que lo cubriría (`web/lib/positions.test.mjs` o en `tests/` si pasa a Python): partido sintético de 20 s con balón fijo en (50, 34); propia con nombre a 5 m, rival a 1.5 m y una persona `unk` sin nombre a 0.5 m. Esperado hoy: toque rival; esperado tras el arreglo: `unassigned` (sin dueño). Segundo caso: balón con una racha de 3 puntos automáticos que saltan 50 m en 0.1 s entre dos puntos de un mismo lado; esperado: esos puntos no generan toque ni segundos de posesión.
