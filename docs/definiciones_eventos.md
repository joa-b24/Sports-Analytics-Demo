# Definiciones operativas de eventos desde posiciones (tarea 0.1)

Borrador del 2026-10-25. **Solo documento: no se ha tocado código, `schema.py` ni el contrato.** Define, antes de implementar,
cómo se detecta cada evento usando únicamente posiciones proyectadas: jugadoras y balón en la cancha normalizada 105 x 68 (medidas
en metros reales de la sede, `venue`), con sus banderas de calidad. Sin imagen. Todos los umbrales son iniciales y están
marcados **(a calibrar)**.

Lo que sale de aquí son **sugerencias**: nada entra a `events` sin que la analista lo acepte, corrija o descarte (igual que hoy
en `web/lib/autoEvents.ts`). Un evento sugerido y aceptado es un evento como cualquier otro.

## 0. Entradas, convenciones y banderas

**Señales** (por cuadro procesado):

| Señal | Campos | Notas |
|---|---|---|
| Jugadoras | `x, y, team, player_id?, source, on_pitch` | `source` = `auto` / `manual` / `interpolated` (ver `tracks_fixed`). Una posición `interpolated` **no es una medición**: no cuenta como candidata a tocar el balón ni para medir distancias. `player_id` es nulo si la persona no tiene nombre; la regla sigue funcionando por `track/identity` y el evento sale con `player_id` nulo. |
| Balón | `x, y, conf, source` (`manual`, `auto`, `event`, `interpolated`), `interpolated`, `extrapolated` (nueva), `z` (nueva, opcional) | Un balón `interpolated` o `extrapolated` sirve para trayectoria y para decir «iba por ahí», **nunca** para decidir un toque, un control ni dónde se detuvo. |
| Campo visual | `fov0..fov7` de `calib_*` | Una regla que dependa de «no hay nadie cerca» (balón libre, duelo ausente, ninguna rival cerca) solo es válida si la zona de 6 m alrededor del balón estaba dentro del `fov` en esos cuadros. Si no, la salida lleva `fov_partial` y confianza baja. **Fuera de cuadro no es ausente.** |
| Tramos | `segments.csv` (`juego`), `video_id`, `t_video` | Ver sección 3. |
| Orientación | `own_attacks` por video | `own` ataca a `x = 105` (convención de eventos). Se refleja antes de aplicar cualquier regla. |

**Unidades y reglas generales.** Distancias en metros reales de la sede (no en unidades de 105 x 68). Tiempo en `t_video` del
video original; las ventanas se cuentan en segundos, no en cuadros (el `stride` de proceso varía). `NaN` se respeta: si falta lo
que una regla necesita, el evento no se sugiere (no se rellena).

**Banderas de calidad que viajan con cada sugerencia** (`flags`): `ball_interp` (parte de la trayectoria es interpolada),
`ball_extrap`, `player_interp`, `fov_partial`, `from_cut` (arranca en el inicio de un segmento), `truncated` (el segmento termina
antes de poder confirmar), `unnamed` (jugadora sin nombre), `contested`. `confidence` = `high` (sin banderas), `medium` (una),
`low` (dos o más, o `fov_partial` en una regla que necesita ausencia).

**Carriles** (usados por centro, entradas y mapas). Cinco carriles a lo ancho, cada uno de 68/5 = 13.6 m, vistos desde el equipo
que ataca (mismo cálculo que `autoEvents.ts`: carril central = `|y - 34| <= 6.8`):

| Carril | `|y - 34|` |
|---|---|
| central | 0 a 6.8 |
| interior (izq./der.) | 6.8 a 20.4 |
| exterior (izq./der.) | 20.4 a 34 |

El «tercio» (3 carriles de 22.7 m) que usa hoy `laneOf` en `analysis.ts` es otra cosa; ver decisión 7.

**Tercios a lo largo (para el equipo que ataca):** último tercio `x_att >= 70`; área `x_att >= 88.5` y `|y - 34| <= 20.16`
(área grande de 16.5 x 40.32). `x_att = x` para `own`, `105 - x` para `opp`.

## 1. Estados base (de aquí se derivan los eventos)

### 1.1 Estado del balón en cada cuadro

- **`vivo`**: balón medido (no interpolado/extrapolado) dentro de la cancha (margen 0.75 m) y no en reposo.
- **`reposo`**: velocidad < 0.5 m/s durante >= 1.5 s **(a calibrar)** con posición medida.
- **`fuera`**: una posición medida a más de 0.75 m más allá de una línea (regla vigente de `autoEvents`), o ausente >= 2 s después de
  una última posición medida a <= 4 m de una línea y yendo hacia ella. En el segundo caso, `confidence` baja y `fov_partial` si
  la zona de salida no estaba en cuadro.
- **`desconocido`**: balón no visto sin ninguna de las dos condiciones anteriores (puede estar en cuadro y sin detectar, o fuera
  de cuadro). **No es `fuera` ni `muerto`.**
- **`vuelo`** (balón aéreo o pase largo): ver 1.3.

### 1.2 Toque, control y posesión

Tres niveles, de menor a mayor exigencia:

1. **Toque** (instantáneo; ya existe como `touches()` en `positions.ts`). En un cuadro con balón medido, la jugadora más
   cercana con posición medida está a <= **2.0 m** **(a calibrar; hoy `POSSESS_M`)**. Si una rival está a menos de **0.5 m**
   (a calibrar) de diferencia: `contested`, no hay toque. No son candidatas las posiciones `interpolated` ni las personas sin
   nombre sobrantes (`unnamedLeftovers`).
2. **Control**. La misma jugadora (o su equipo) sostiene el toque >= **0.5 s** (a calibrar) de cuadros medidos consecutivos
   (se toleran huecos de hasta 0.3 s), con velocidad del balón < **8 m/s** (a calibrar) en la ventana y sin `contested`. Un
   balón que solo pasa cerca a 15 m/s es un toque, no un control. El control define de qué equipo es el balón.
3. **Posesión de equipo** (intervalos). Un equipo la tiene desde su primer control hasta: (a) el primer control del otro
   equipo, (b) balón `fuera`/`reposo` no recuperado por el mismo equipo (ver 2.1: el equipo que reanuda), o (c) más de **5 s**
   sin ningún control ni `vuelo` hacia una compañera (valor vigente `PASS_MAX_S`); en (c) el tramo queda **sin asignar**.

**Reglas de desempate y casos límite**

| Caso | Regla |
|---|---|
| Balón en el aire (`vuelo`) | Se entra en `vuelo` cuando, tras un toque, el balón supera **12 m/s** (a calibrar) **o** hay >= 3 m de desplazamiento con posiciones interpoladas/extrapoladas. Sin `z` no se sabe si va por alto: la posición proyectada de un balón aéreo se corre por paralaje y **no es confiable** (queda `ball_interp`). Durante el `vuelo` nadie tiene el balón; termina en el primer toque/control medido. Si hay `z`, `z > 0.5 m` también marca vuelo. |
| Balón interpolado | Nunca da toque ni control (vigente). Una pasada «por encima» de una jugadora no la hace poseedora. |
| Balón fuera | Posesión suspendida; no se asigna a nadie hasta la reanudación (2.1). La posesión posterior es del equipo que reanuda. |
| Balón no visto | `desconocido`: ni pérdida ni recuperación; la posesión se queda `sin asignar` tras 5 s. |
| Duelo / balón disputado | Jugadoras de los dos equipos a <= 0.5 m de diferencia de distancia: `contested`. Sigue la posesión previa hasta 2 s; después `sin asignar` hasta el siguiente control. |
| Portera con el balón | Cuenta como control de su equipo (pasa por la misma regla; si la portera está sin equipo definido, `unk`, no cuenta). |
| Empate exacto entre equipos | Gana quien tuvo el último control (continuidad), nunca «el más cercano» por margen < 0.5 m. |

**Salida** (tabla derivada propuesta, no el catálogo de eventos): `possession_<video>`, una fila por intervalo:
`video_id, segment_id, t_start, t_end, team (own|opp|none), first_player, last_player, kind (control|contested|loose|dead|unknown), flags`.

**Señal de entrada**: tracking proyectado + balón con `source`. **Prueba**: sintético con un balón que viaja de A (1.9 m de
distancia) a B pasando a 1 m de una rival sin tocarla (interpolado): esperado, A controla, vuelo, B controla, la rival no
aparece. Caso `contested`: dos jugadoras de equipos opuestos a 1.0 y 1.3 m: sin toque.

### 1.3 Cambio de posesión

Es el **paso de `team` en las posesiones** (A a B) con posesión de A válida (>= 1 control) y primer control de B **dentro de la
misma pieza continua de juego** (sección 3). Tipos (para el campo `how`, que va como nota/derivado, no en el catálogo):
`interception` (B toca en `vuelo`/pase de A), `duel` (había `contested`), `out` (balón fuera y reanuda B), `foul_stop`
(pausa y reanuda B), `keeper` (portera de B). No es cambio de posesión: gol (el saque de centro del otro equipo), inicio de
tiempo, ni una reanudación del mismo equipo que sacó el balón fuera.

## 2. Eventos

Para cada uno: **entrada**, **regla** (umbrales a calibrar), **salida**, **ambiguos**, **prueba**. Las pruebas comunes a todos
están en la sección 5.

### 2.1 Pérdida y recuperación

**Redefinición pedida:** `loss` es **cualquier cambio de posesión** en el que el equipo A deja de tener el balón (sale a la
banda y saca el rival, mal pase que termina en rival, duelo perdido, balón que sale por fondo, pausa que reanuda el rival).
Puede ser o no una recuperación activa del rival; **la recuperación se especifica en la revisión**. Por eso la sugerencia emite
**un solo tipo de evento, `loss`**, y no emite `recovery`.

- **Entrada**: posesión (1.2), estado del balón, reanudaciones (2.2).
- **Regla**: ocurre `loss` del equipo A cuando A tuvo posesión (>= 1 control) y el siguiente evento de posesión confirmada es
  de B, en cualquiera de estas formas: (a) primer control de B antes de **5 s** (a calibrar) desde el último toque de A;
  (b) balón `fuera` con último toque de A y reanudación (banda/córner/saque de meta) tomada por B (el equipo de B se deduce de la
  reanudación, ver 2.2); (c) pausa (2.3) que reanuda B con tiro libre/fuera de lugar. Se **excluyen**: gol (reanuda en el
  centro), fin de tiempo, rebote del mismo equipo, y balón que A manda al área rival y recupera A.
- **Instante y lugar**: el **último toque de A** (no el momento en que B lo toma), posición del balón en ese cuadro. Si el balón de
  ese toque no es medido: no se sugiere.
- **Salida**: `type=loss, team=A, player_id` = quien tocó por última vez (si tiene nombre), `x, y, t_video, video_id, period`;
  `note` automática con la forma (`how`); `flags`; `confidence`. Si es un tiro de A (balón sale tras un tiro): la pérdida se emite
  igualmente con `how=after_shot` para que el análisis no la cuente doble como «pérdida mala».
- **Recuperación**: no se sugiere como evento. Al revisar, la analista marca en la pérdida si **el rival la recuperó**
  (intercepción, duelo, balón dividido) o **la regalamos** (salió, falta, mal pase sin disputa). Las métricas que hoy usan
  `recovery` (transiciones D1-D3, altura de recuperación, C1) se derivan de las pérdidas del **otro** equipo marcadas como
  recuperadas, más los `recovery` manuales ya existentes.
- **Ambiguos**: un duelo con ida y vuelta de <= 2 s (vigente en `autoEvents`) es una sola disputa: una pérdida del equipo que no
  se queda con el balón y un `duel` aparte (2.8); sin quedar un equipo claro, no hay pérdida. Balón en `vuelo` que ninguna
  controla en 5 s: no hay pérdida (posesión sin asignar). Balón que sale por fondo tras tiro de A y saque de meta de B: pérdida de
  A con `after_shot`.
- **Prueba**: sintéticos: (1) A controla, pasa a B (rival) a 6 m, B controla 0.6 s: una `loss` de A en el último toque de A.
  (2) A manda a la banda, 4 s de reposo fuera, reanuda B: una `loss` de A, `how=out`. (3) A y B se disputan 1.5 s y gana B: `duel`
  + `loss`. (4) Pase de A que cruza en vuelo (interpolado) por una rival sin toque y llega a A: ninguna.

### 2.2 Reanudaciones: banda, tiro libre, córner, penal, saque de meta

**Se marcan en la REANUDACIÓN**: `t_video` es el primer cuadro en que el balón detenido se mueve (> **2 m/s** durante >= 0.2 s,
a calibrar), y `x, y` es **donde estaba el balón detenido** (punto de reposo). Eso cambia respecto a la tarea actual de la
analista, que etiqueta cuando el balón sale; ver contrato.

**Detector común (`reanudación`)**: secuencia (a) el balón estaba `fuera`, o `reposo` >= 1.5 s, o `desconocido` >= 2 s dentro
de la cancha, (b) vuelve a estado `vivo` y se aleja >= **3 m** (`restartMoveM`, vigente) del punto de reposo. El punto de reposo
es la última posición **medida** antes del movimiento. Equipo: ver cada caso.

| Evento | Clasifica por la posición de reposo | Equipo | Condición extra |
|---|---|---|---|
| `throw_in` | `y <= 1.0` o `y >= 67.0` (a calibrar), precedido por `fuera` por esa línea | quien toca primero tras el saque, si no hay: el equipo contrario al último toque (`lastTouchS` = 6 s, vigente); si discrepan: `confidence=medium` y dos opciones | el balón no queda dentro de la cancha > 1 m antes del saque |
| `corner` | a <= 3.5 m de una esquina (vigente `cornerM`), precedido por `fuera` por la línea de fondo | el que ataca esa portería (orientación): `own` en `x≈105`, `opp` en `x≈0` | |
| `goal_kick` | dentro del área chica (profundidad <= 6.5 m, `|y-34| <= 10.5`, vigentes) precedido por `fuera` por esa línea | el que defiende esa portería | no es saque si la portera lo controló en juego (control sin `fuera` previo) |
| `penalty` | a <= 1.5 m del punto penal (11 m de la línea) y en reposo >= 3 s | quien patea (el que ataca esa portería) | solo una jugadora del equipo atacante a <= 6 m del balón y el resto a >= 9 m (arco/área) |
| `free_kick` | cualquier otro reposo >= 3 s dentro de la cancha tras `vivo` o pausa (2.3), no en las posiciones anteriores | el que toca primero | pausa de juego: velocidad mediana de todas las jugadoras < 1.5 m/s durante el reposo |

Tiro libre vs saque de centro: el reposo en el centro (a <= 5 m de `(52.5, 34)`) es **reanudación de centro** (inicio de
tiempo o tras gol); **no es evento del catálogo**, sirve para deducir `goal` (2.9) y para no contar cambio de posesión.

- **Salida**: `type`, `team`, `player_id` (la que toca primero, si tiene nombre), `x, y` (punto de reposo), `t_video` (reanudación),
  `period`, y para `corner`: `x_end, y_end` si se puede (primer toque posterior medido en <= 4 s).
- **Ambiguos**: balón perdido de vista que reaparece donde estaba: puede ser reanudación o solo no verse (`stoppageM` = 8 m, vigente):
  es **pausa** (2.3), no reanudación, salvo que el reposo cumpla las reglas anteriores. Penal vs tiro libre cerca del área: manda el
  punto penal. Saque de banda cerca de una esquina: manda la línea cruzada. Córner sacado en corto: el punto de reposo sigue
  siendo la esquina.
- **Prueba**: sintético por tipo (balón detenido en cada punto, jugadoras alrededor, luego movimiento). Verificación en 2.º
  tiempo: la analista revisa a ciegas una muestra de sugerencias de cada tipo (ver sección 4).

### 2.3 Falta y fuera de lugar

**Se marcan al INICIO de la pausa**, no en la reanudación. Todas las pausas de juego con reanudación por tiro libre salen
como `foul` en la sugerencia; la segunda pasada de revisión corrige `offside`, cambia el equipo o lo descarta (lesión, balón
perdido).

- **Entrada**: estado del balón, pausa, velocidad de las jugadoras.
- **Regla (pausa)**: el balón `vivo` pasa a `reposo` o `desconocido` (dentro de la cancha) y se mantiene >= **3 s**
  (a calibrar), la velocidad **mediana** de todas las jugadoras medidas (para evitar un solo cuerpo en cuadro) es < **1.5 m/s**
  (a calibrar), y la reanudación (2.2) ocurre a <= 8 m (`stoppageM`) del punto de parada y es `free_kick`/`penalty`.
- **Equipo que comete**: el contrario al que reanuda con el tiro libre. Si la reanudación no se ve (corte, 3.2): `team=unk`.
- **Instante y lugar**: `t_video` = último cuadro con balón `vivo` antes del reposo (inicio de la pausa); `x, y` = posición del
  balón en ese cuadro (no necesariamente donde ocurrió la falta; para offside coincide con el tiro libre).
- **Salida**: `foul`, `team` (el que comete), `player_id` nulo (no se infiere), `x, y, t_video`. Si la reanudación es `penalty`:
  la falta se coloca dentro del área; la analista decide `detail` (tarjeta).
- **Indicio de fuera de lugar (solo informativo, no cambia el tipo)**: cuando el último pase de A termina en pausa y al soltarlo
  una atacante estaba por delante de la penúltima defensora y del balón, y la pausa comienza en <= 3 s cerca de ella. Requiere ver
  a la penúltima defensora (`fov`, medida): si no se ve, `NaN`.
- **Ambiguos**: falta vs fuera de lugar (señal = la misma); falta vs pausa por lesión (velocidades bajas a ambos lados, **sin**
  tiro libre: no se emite); balón que se va a un lado y la cámara no lo ve (el `fov` no cubre la zona): no es pausa.
- **Prueba**: sintético: balón vivo que se detiene a los 30 s, jugadoras casi quietas 5 s, tiro libre de B a 3 m del punto de
  parada: una `foul` de A en el último cuadro vivo + un `free_kick` de B en la reanudación. Contraprueba: balón que no se ve 4 s
  con jugadoras corriendo: nada.

### 2.4 Pase y pase completo

Hoy los pases salen de `passesAndTurnovers` (dos toques seguidos) y de la pasada 4 manual (eliminada del flujo). Nueva
definición con la posesión de 1.2.

- **Entrada**: toques/controles de 1.2, trayectoria del balón.
- **Regla**: un pase es la secuencia **«A suelta el balón» a «primer toque o control de otra jugadora»**, con: último toque de A
  (jugadora A, equipo T), desplazamiento >= **3 m** (a calibrar) y velocidad máxima > **4 m/s** (a calibrar) entre los dos toques
  (así un regate o un toque corto de la misma jugadora no es pase), y el siguiente toque ocurre en <= **5 s** (`PASS_MAX_S`).
  - **Pase completo**: el siguiente toque es de una jugadora distinta del **mismo equipo**.
  - **Pase incompleto**: el siguiente toque es del otro equipo, **o** el balón sale (`fuera`) y reanuda el otro equipo (misma
    base que `loss`).
  - **Sin resultado**: balón en `vuelo` sin ningún toque en 5 s, o el segmento termina (`truncated`): no se cuenta.
- **Salida**: tabla derivada con las columnas de `PASS_COLUMNS` (`pass_id, match_id, video_id, t_video` = último toque de A,
  `period, team, from_id, to_id, outcome`) más opcionales `x, y, x_end, y_end`, `distance_m`, `forward_m`, `flags`, `confidence`.
  `from_id`/`to_id` = nombre de la plantilla o `#<identidad>` si no tiene nombre.
- **Ambiguos**: balón interpolado entre dos toques con una rival a <= 1.5 m de la recta: `ambiguous` (puede haberse tocado y no
  verse), se cuenta como completo solo con `confidence=low`. Pase a una compañera fuera de cuadro: el siguiente toque medido
  puede ser otra (la regla solo ve toques medidos); por eso `to_id` es «la próxima en tocarla», no necesariamente la destino. Tiro:
  no es pase (se separa por 2.7). Rechace de portera o despeje: pase incompleto/completo según toque siguiente.
- **Prueba**: sintético A a B (4 m, 6 m/s): completo; A a rival: incompleto; A con regate (2 toques propios): ninguno;
  A a B con una rival a 1 m de la recta interpolada: completo `low`.

### 2.5 Entrada al último tercio y al área

- **Entrada**: posesión + trayectoria del balón.
- **Regla**: el balón cruza la línea `x_att = 70` (o la del área) hacia adelante, medido en el cuadro de cruce o con trayectoria
  medida a ambos lados (<= 2 `stride`), **con posesión vigente de T** (último control o toque de T en <= 5 s, no `contested`) y
  T conserva (siguiente toque de T en <= 5 s, vigente `entryConfirmS`; si no hay ningún toque posterior, solo el área, con
  `medium`). Histéresis: antes debe haber estado 3 m detrás de la línea (`entryHysteresisM`) y no se repite en 5 s
  (`entryCooldownS`). Se ignoran cruces dentro de una pieza `dead`.
- **Salida**: `final_third_entry` o `box_entry`, `team`, `x, y` (balón en el cruce), `t_video`, `player_id` = quien tenía el balón
  en el cruce (portadora o, si cruzó por pase, la que pasó).
- **Ambiguos**: balón aéreo que cruza (`vuelo`) sin control claro: se asigna a quien lo soltó, `medium`; balón disputado: no se
  emite. Despeje largo del rival que entra a un tercio sin posesión: no es entrada.
- **Prueba**: sintético: A conduce de `x_att=68` a 72 con control y toque posterior: una entrada; A no conserva (rival
  toca antes de 5 s): ninguna; sale y vuelve a cruzar en 3 s: una sola.

### 2.6 Centro

Definición pedida: pase o intento **desde carril exterior a carril central**.

- **Entrada**: toques, trayectoria, carriles (sección 0).
- **Regla**: toque de T con el balón (medido) en un **carril exterior** (`|y-34| >= 20.4`) del último tercio (`x_att >= 70`),
  fuera del área y no a <= 3.5 m de una esquina (eso es córner), y el balón llega en <= **4 s** (`crossMaxS`) a una posición
  (último medido antes del siguiente toque, o de toda la ventana) en el **carril central** (`|y-34| <= 6.8`), con
  desplazamiento lateral >= **10 m** (a calibrar; hoy 6 m y 4 m hacia dentro) y sin que el siguiente toque sea de la misma
  jugadora. Si no hay destino medido pero el siguiente toque lo hace una compañera o rival en carril central o área, se
  acepta con `medium` y `x_end,y_end` = esa posición.
- **Salida**: `cross`, `team`, `player_id` (quien centra), `x, y` (origen), `x_end, y_end` (destino), `t_video` = último toque
  de quien centra; `outcome` (`shot`/`cleared`/`play_on`) **no** se sugiere: se deduce de los eventos siguientes o lo pone la
  analista.
- **Ambiguos**: pase largo diagonal que cambia de banda (no termina en el carril central): no es centro. Centro desde carril
  interior (hoy lo acepta `autoEvents`): **fuera de la definición** hasta decidir (decisión 6). El destino es impreciso en balón
  aéreo (paralaje): `ball_interp` y `medium`.
- **Prueba**: sintético: toque en `(85, 4)`, balón interpolado a `(95, 33)`, toque de otra jugadora en el área: centro con destino.
  Contraprueba: pase paralelo a la banda; pase de `(85, 20)` (carril interior) al área.

### 2.7 Tiro, pase clave, gol

**Tiro** (sugerencia desde posiciones; `outcome` y `detail` casi nunca se pueden dar).

- **Regla**: tras un toque de T en el campo contrario, el balón sale a > **15 m/s** (a calibrar) durante >= 0.2 s, desde
  `x_att >= 70`, y su dirección apunta a un segmento de la línea de fondo que cubre `|y-34| <= 7` m (a calibrar: poste a poste =
  3.66 m, más margen por ruido), y termina en uno de: (a) cruza la línea de fondo (`fuera`), (b) primer toque de la portera
  contraria (`team=opp` y a <= 6 m de su línea), (c) toque de una rival antes de la línea (`blocked` candidato).
- **Salida**: `shot`, `team`, `player_id`, `x, y` (balón en el último toque), `t_video`; `outcome` sugerido: `blocked` si (c);
  `off_target`/`on_target` **solo con `low` confianza**: sin `z` y con paralaje no se sabe si el balón iba por alto. `goal_y`,
  `goal_z`: **no se calculan** (hacen falta imagen o `z`).
- **Ambiguos**: despeje largo hacia la portería sin intención; centro rematado de cabeza (cae en el mismo patrón); rebote.
  Por eso es siempre sugerencia.

**Pase clave** (`key_pass`).

- **Regla**: pase **completo** (2.4) de T cuya receptora tiene un `shot` o `goal` de T (evento etiquetado o sugerido) en <= **5 s**
  (a calibrar) desde que lo recibe, sin que otra compañera toque en medio. Lee los eventos de la tabla `events`; no infiere
  tiros del tracking por su cuenta.
- **Salida**: `key_pass`, `team`, `player_id` = pasadora, `x, y` = origen del pase, `t_video` = suelta.

**Gol** (manual, o con sugerencia).

- **Regla de sugerencia**: balón `fuera` por una línea de fondo con `|y-34| <= 3.66` (entre postes, margen 1 m a calibrar) tras un
  toque o tiro de T, y se cumple **uno de**: (a) reanudación de centro (2.2) tomada por el otro equipo en <= **120 s**
  (a calibrar, incluye celebración) con ese tiempo dentro del mismo tramo o el siguiente (ver 3); (b) agrupación: >= 6
  jugadoras de T a < 25 m del punto de gol y casi quietas (velocidad media < 2 m/s). Con (a) `high`; con solo (b) `low`. Sin
  ninguna: no se sugiere.
- **Salida**: `goal`, `team` (el que anota), `player_id` = último toque de T, `x, y` = último balón medido, `t_video`.
- **Ambiguos**: tiro por encima del larguero (misma geometría; sin `z` es indistinguible, pero no habrá reanudación de centro:
  por eso (a) es la señal buena); balón que pega en el poste y sale; gol anulado.

### 2.8 Duelo

Se mantiene como evento opcional, con el mismo catálogo.

- **Regla**: intervalo >= **0.3 s** (a calibrar) donde una jugadora de cada equipo está a <= **2.0 m** del balón y a <= **2.5 m** de
  la otra, balón con velocidad < 6 m/s, balón y jugadoras medidos. Fin: primer control (1.2) de alguien.
- **Salida**: `duel`, `team`=`own` (como hoy: se anota desde nuestro lado, o el del equipo que se sigue), `outcome` `won`/`lost`
  = si quien termina con el control es de `team`, `x, y`, `t_video` = inicio del intervalo. `detail` (`aerial`/`ground`):
  **solo con `z`** (balón por encima de 0.5 m antes del contacto); sin `z`, nulo.
- **Ambiguos**: más de dos jugadoras (se toma la dupla más cercana); jugadora sin nombre (el evento sale sin `player_id`).

## 3. Cortes de segmento

Los segmentos de juego están **unidos** en el análisis (el video entre ellos se saltó). Un segmento puede terminar en un tiro
desviado y el siguiente empezar con un córner por cobrar.

### 3.1 Reglas

1. **Continuidad.** Dos segmentos consecutivos del mismo `video_id` son continuos solo si `inicio_{n+1} - fin_n <= 0.1 s`. En
   cualquier otro caso hay un **corte**. Ninguna ventana de ninguna regla cruza un corte: los estados (posesión, vuelo,
   reposo, pase abierto) se **reinician**; no se calculan velocidades ni distancias entre el último cuadro de un segmento y el
   primero del siguiente. Tampoco entre videos.
2. **Cola del segmento (`truncated`).** Lo que quedó abierto al fin (balón en `vuelo`, pase sin receptor, pausa sin
   reanudación, posesión «viva») **no se completa** con el siguiente segmento. Un `loss`, `pass`, o `entry` que necesita lo
   posterior se emite solo si sus condiciones se cumplen **dentro** del segmento; si no, no se emite (no se marca incompleto).
   El tiro sí se puede emitir en la cola (solo necesita el movimiento del balón), con `outcome` nulo y `truncated`.
3. **Cabeza del segmento (`from_cut`).** Una reanudación (2.2) se reconoce si, al **inicio** del segmento, el balón ya está en
   reposo (o `desconocido`) en una posición característica y se mueve dentro de los primeros ~20 s **(a calibrar)**; no
   exige haber visto la salida. El equipo se deduce por orientación (córner, saque de meta) o por quien toca primero (banda,
   tiro libre); sale con `from_cut` y `medium` (o `low` en banda). Es el caso «córner por cobrar».
4. **No se une un tiro desviado con el córner siguiente** para rellenar `outcome` ni para marcar una pérdida o un pase; se
   emiten por separado cada uno con lo que se ve (decisión 8). La pérdida de A en el tiro desviado no se emite si el
   segmento termina antes de que el rival saque; el córner que empieza el siguiente segmento no genera `loss`.
5. **Posesión al inicio** (`sin asignar`) hasta el primer control; el primer control tras un corte **no es recuperación ni
   cambio** de posesión.
6. **Cambio de periodo** (`period`): ídem un corte. Los estados nunca se arrastran de un periodo al otro.

### 3.2 Prueba

Sintético de dos segmentos: el primero termina con un tiro a 2 s de la línea de fondo; el segundo empieza con balón quieto en el
arco del córner y se cobra a los 8 s. Esperado: `shot` (truncated, sin outcome), un `corner` (`from_cut`), ninguna `loss`, ninguna
posesión continua entre los dos. Segundo caso: corte de 0.05 s: continuo, se deducen pérdida y pase a través del corte.

## 4. Cómo se prueba (todos los eventos)

1. **Sintéticos (por regla, en `tests/`)**. Un caso mínimo hecho a mano con el resultado esperado, uno de contraprueba, y uno con
   cada bandera (`ball_interp`, `fov_partial`, `unnamed`, corte). Datos de `sportsan.mock.generate` o construidos a mano. La
   implementación son funciones puras sobre DataFrames (`metrics/`). Si se mantiene una copia en TypeScript para la app, un
   archivo de casos compartido (`tests/fixtures/...json`, igual que `projection_cases.json`) comprueba que ambas coinciden.
2. **Calibración de umbrales (primer tiempo de `2026_09_25_tec_ccm_vs_anahuac`)**: se ajustan los umbrales **(a calibrar)** con
   el primer tiempo. Los eventos etiquetados a mano **no son la verdad**: tienen 1-2 s de desfase y se etiquetaron con otro
   criterio (la salida del balón, no la reanudación).
3. **Verificación en el segundo tiempo (que no se usó para calibrar)** y, cuando haya, en `ccm_vs_up`. Protocolo:
   - Se corren las sugerencias con los umbrales congelados, sin mirar eventos manuales.
   - **Precisión**: la analista revisa a ciegas una muestra aleatoria por tipo (mínimo 30 por tipo frecuente, todas las de tipos
     raros) y marca *correcta / corregida (tipo, equipo, tiempo > 2 s) / falsa*.
   - **Cobertura (recall)**: la analista etiqueta **desde el video, a ciegas**, 10 minutos de juego sin ver las sugerencias, y se
     compara con tolerancia de ±2 s y ±5 m (a calibrar). Esa verdad es esa etiqueta nueva, no los eventos previos.
   - **Aceptación**: se muestra una regla como sugerencia si su precisión >= 70 % **(a calibrar)** en la muestra; con menos, se deja como
     ayuda (`Locked`/«en desarrollo») sin cifras. Las cifras que salgan de eventos sugeridos y aceptados se rotulan como tales.
4. **Cuánto se pierde por la cámara.** Cada informe de prueba da el porcentaje de sugerencias con `fov_partial`, `ball_interp`,
   `from_cut`, `unnamed`.

## 5. Comparación con el catálogo actual e impacto en el contrato (NO aplicado)

Catálogo actual (`EVENT_TYPES` en `schema.py`): `shot, goal, loss, recovery, foul, corner, free_kick, throw_in, penalty,
key_pass, other, final_third_entry, box_entry, goal_kick, cross, duel, offside, substitution`.

| # | Cambio | Dónde | Detalle exacto |
|---|---|---|---|
| 1 | `loss` = cualquier cambio de posesión | `docs/data_contract.md` (tabla de `type`, y «Qué se calcula de dónde»); `schema.py` comentario; `web/lib/analysis.ts` (`transitions`, `recoveryHeight`), `report.ts` | **Sin columna nueva.** Redefinir el texto. Se propone `EVENT_DETAILS["loss"] = ("recovered", "conceded")` (el rival la recuperó activamente / la regalamos sin disputa), opcional, puesto en la revisión. `validate_events` ya rechaza valores fuera de `EVENT_DETAILS`, así que hay que añadir la clave. `recovery` **se conserva** en `EVENT_TYPES` (datos viejos y marcado manual); las métricas que hoy leen `recovery` leen también `loss` del rival con `detail=recovered`. |
| 2 | Reanudaciones (`throw_in, free_kick, corner, penalty, goal_kick`) se marcan en la reanudación | contrato (texto) | **Sin cambio de columnas.** `t_video` = primer movimiento del balón detenido; `x, y` = punto de reposo. Los eventos etiquetados a mano con el criterio viejo (cuando salió el balón) quedan en el mismo tipo; ver decisión 4. |
| 3 | `foul` y `offside` se marcan al inicio de la pausa | contrato (texto) | **Sin cambio de columnas.** `offside` ya dice «`x, y` donde estaba ella, que es donde se cobra el tiro libre»: se matiza (`x, y` es la posición del balón al comenzar la pausa, aproximada). |
| 4 | Metadatos de las sugerencias | `events` | Columnas **opcionales** nuevas: `source` (`manual`, `suggested`, `suggested_edited`), `rule` (nombre de la regla), `confidence` (`high`/`medium`/`low`), `flags` (texto separado por comas). Entran en `OPTIONAL_EVENT_COLUMNS` y en `web/lib/types.ts`. Sin ellas el archivo sigue siendo válido. |
| 5 | Balón: `z`, `extrapolated`, `source` | `BALL_COLUMNS`/`OPTIONAL_BALL_COLUMNS`, contrato (tabla `ball_*`), `validate_ball` | `z` (float, metros, opcional, **ya aceptada**), `extrapolated` (bool: posición proyectada más allá de la última medición), `source` (`manual`/`auto`/`event`/`interpolated`, como en `tracks_fixed.ball`). `interpolated` ya existe. Un balón `interpolated` o `extrapolated` nunca da toque (regla vigente, ahora también por esquema). |
| 6 | Jugadoras: `source` | `OPTIONAL_TRACKING_COLUMNS`, contrato | `source` (`auto`/`manual`/`interpolated`) en `tracking_*.parquet` para que Python aplique la misma regla que `positions.ts`. Hoy solo existe en `tracks_fixed`. |
| 7 | Posesión por intervalos | contrato, `schema.py` (`validate_possession`) | **Tabla nueva derivada** `possession_<video>`: `video_id, segment_id, t_start, t_end, team, first_player, last_player, kind, flags`. No toca nada existente. |
| 8 | Pases desde posiciones | contrato; `PASS_COLUMNS` | **No cambia** `PASS_COLUMNS`/`validate_passes`. Archivo derivado aparte (`passes_derived_<video>`) con las mismas columnas más opcionales `x, y, x_end, y_end, distance_m, forward_m, flags, confidence`; los pases manuales (obsoletos, pasada 4 eliminada) no se mezclan. |
| 9 | Carriles | contrato / `laneOf` | Documentar los **5 carriles de 13.6 m** como definición; `laneOf` (3 tercios de ancho) y `report.ts` (cuadrículas 5 x 3) deben decir cuál usan (decisión 7). |
| 10 | `final_third_entry`, `box_entry` | opcional | `EVENT_DETAILS` añadiría `carry`/`pass` (cómo cruzó). Opcional; si no, no cambia nada. |
| 11 | `goal_y`, `goal_z`, `duel.detail=aerial` | contrato (texto) | Siguen siendo manuales o con `z`. Se documenta que sin `z` **no** se sugieren. |
| 12 | `shot.outcome` | contrato (texto) | La sugerencia solo da `blocked`; `on_target`/`off_target` con `low` o no se sugieren. |
| 13 | Cortes de segmento | contrato («Carpeta del partido»/`segments.csv`) | Texto: continuidad `<= 0.1 s`, ventanas no cruzan cortes. Sin columnas nuevas. |

Nada de lo anterior toca `EVENT_TYPES` salvo, si se decide, eliminar `recovery` en el futuro (no se propone ahora). Después de
aplicar cualquiera de estos cambios: `schema.py`, contrato y tests en el mismo cambio, `python -m pytest`, y revisión del
`contract-reviewer`.

## 6. Decisiones para la analista (máx. 10)

1. **¿Quitamos `recovery` de lo que se sugiere y la dejamos solo en la revisión de `loss`?** Recomendación: **sí** (la sugerencia
   emite solo `loss`; `recovery` queda en el catálogo para datos viejos), con `loss.detail = recovered | conceded` puesto al revisar.
2. **Control de balón: ¿2.0 m y 0.5 s, o más estricto (1.5 m)?** Recomendación: empezar con **2.0 m / 0.5 s** (el 2.0 m ya es
   `POSSESS_M`), medir contra la revisión y bajar si hay muchos falsos toques.
3. **Balón aéreo sin `z`: ¿lo tratamos como `vuelo` sin dueña (nadie lo tiene) o intentamos asignarlo?** Recomendación: **sin dueña**;
   el siguiente toque medido cierra el pase. Pide `z` solo cuando haya cómo medirlo.
4. **Reanudaciones en la reanudación, no en la salida: ¿y los eventos que ya etiquetó a mano con el criterio de la salida?**
   Recomendación: **no migrarlos**; documentar el cambio y comparar sugerencias solo contra revisión nueva, no contra esos eventos.
5. **Falta y fuera de lugar: ¿todo sale como `foul` y la segunda pasada corrige?** Recomendación: **sí**, y añadir un indicio de
   fuera de lugar solo como nota (`NaN` si no se ve a la penúltima defensora).
6. **Centro: ¿solo de carril exterior a central, o también desde el interior (como hoy en `autoEvents.ts`)?** Recomendación:
   **exterior a central** como dice la definición; los de interior se emiten como `other` con nota o se ignoran hasta ver cuántos
   son.
7. **Carriles: ¿adoptamos 5 carriles de 13.6 m en todo (`laneOf` hoy usa 3 tercios de ancho)?** Recomendación: **sí, 5 carriles**,
   y las agrupaciones izquierda/centro/derecha del informe se derivan de ellos (exterior + interior = izquierda o derecha).
8. **Cortes de segmento: ¿unir un tiro desviado con el córner del segmento siguiente?** Recomendación: **no**; cada uno se
   emite con lo que se ve y el tiro queda sin `outcome`. La analista lo completa en la revisión.
9. **Gol: ¿exigir reanudación de centro en <= 120 s para sugerirlo?** Recomendación: **sí**; sin esa señal no se sugiere (solo
   manual). El caso «tiro por encima» queda así excluido sin necesitar `z`.
10. **Umbral de aceptación de una regla (precisión >= 70 % en el 2.º tiempo y en una muestra a ciegas) y quién revisa.**
    Recomendación: **70 %**; revisa la analista sin ver los eventos manuales; las reglas que no lleguen quedan como «en desarrollo» y
    no muestran cifras.
