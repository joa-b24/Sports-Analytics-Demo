# Propuesta: etiquetas del documento de fuerzas básicas frente al catálogo actual

Escrita el 2026-11-10. **Es una propuesta: nada de esto está en `schema.py`, el contrato ni la app.** Cambiar el catálogo
de eventos exige actualizar `schema.py`, `docs/data_contract.md`, `web/lib/types.ts` y los tests en el mismo cambio, así
que antes de tocar nada hay que decidir qué entra. Aquí está el cruce y una recomendación.

## 1. Cruce con lo que ya existe

| Etiqueta del documento | Resultado propuesto | ¿Ya existe? | Cómo entraría |
|---|---|---|---|
| `shot` | a puerta / fuera / bloqueado | **Sí**: `shot` con `outcome` `on_target`, `off_target`, `blocked` | Nada que hacer |
| `duel` | suelo o aéreo; ganado o perdido | **Sí**: `duel` con `detail` `ground`/`aerial` y `outcome` `won`/`lost` | Nada que hacer |
| `defensive_action` | tackle / intercepción / bloqueo; éxito o fallo | **Parcial**: `recovery` cubre el éxito; no distingue el tipo | `detail` nuevo en `recovery` (`tackle`, `interception`, `block`) y un evento `defensive_action` solo si se quiere registrar el fallo |
| `progressive_pass_attempt` | éxito / fallo | **Se puede inferir**: `passArrows` ya marca `progressive` (gana ≥ 10 m hacia la portería rival) en los pases completados; los fallidos salen aparte como pases cortados | Inferir del tracking, no etiquetar. Umbral por zonas (ver §2) |
| `line_breaking_pass` | éxito / fallo | No | Inferible solo con tracking de las dos líneas (necesita las posiciones de rivales entre pasador y receptor); si no, etiqueta manual |
| `receive_under_pressure` | conserva / progresa / pierde | No | Etiqueta manual (evento nuevo con `outcome`); inferible a futuro con distancia al rival más cercano al recibir |
| `carry_to_commit` | éxito / neutral / fallo | No | Etiqueta manual: depende de una intención (atrae defensor y libera opción) que el tracking no ve |
| `effective_press` | gana balón / fuerza error / neutral | **Parcial**: `recovery` + `counterpress` (se infiere de pérdida y recuperación en menos de 8 s) | Evento nuevo `press` con `outcome`, o ampliar `recovery` con `detail` |
| `run_type` | apoyo / ruptura; recibió / creó espacio / neutral | No | Etiqueta manual, evento nuevo con dos campos |
| `task_type`, `constraints_code` | contexto del bloque | No aplica a partidos | Es de **entrenamiento**: va en la sesión, no en el evento |
| `rater_id` + `manual_version` | calidad de la etiqueta | No | Metadatos del evento (ver §3) |

## 2. Qué se puede calcular sin etiquetar a mano

- **Pase progresivo (intento, éxito, fallo):** ya hay base en `web/lib/positions.ts` (`passArrows`, `PROGRESSIVE_M = 10`).
  Falta contar también los **pases cortados** (hoy solo hay `completed` y `cut` agregados) como intentos fallidos, y definir
  el umbral por zona: por ejemplo 10 m desde el propio tercio, 8 m en el medio, 5 m en el último tercio.
- **Contrapresión / presión efectiva (parte):** ya se calcula la contrapresión (recupera en menos de 8 s tras perder). Lo que
  falta es «forzar error», que sí necesita etiqueta.
- **Pase que rompe línea:** con posiciones de rivales en cuadro y un criterio de «línea» (bloque medio y bloque alto), se puede
  estimar; la cobertura de cámara (ninguna cubre toda la cancha) limita cuándo es confiable. Marcar como «con tracking N3+».

## 3. Calidad de la etiqueta

`rater_id` y `manual_version` son útiles para medir acuerdo entre etiquetadores y para saber con qué manual se hizo cada
etiqueta. Propuesta mínima: dos columnas **opcionales** en el contrato de eventos (`rater_id`, `manual_version`), con valor
por defecto el de la analista y la versión del manual vigente en `docs/`. Opcionales para no romper partidos ya etiquetados.

## 4. Observaciones de la analista y diseño que resulta (2026-11-10)

**Acción defensiva y recuperación.** Una buena barrida no siempre es una recuperación: un corte que manda el balón a la
banda no gana la posesión, pero sí corta la progresión (aunque sea por un momento). Por eso conviene separar dos cosas:

- `recovery` sigue siendo «ganamos la posesión». Puede llevar un `detail` **opcional** con el tipo de acción (`tackle`,
  `interception`, `block`). Hoy `recovery` ya usa `detail` para el primer pase (adelante o atrás): habría que decidir si el
  tipo va en un campo nuevo o se redefine ese; la recomendación es un campo nuevo para no mezclar dos preguntas.
- Un evento nuevo `defensive_action` para lo que **no** gana la posesión: despeje o corte (`clearance`), bloqueo, entrada
  fallida. Con `outcome`: corta la progresión / sin efecto / falla.
- **Partidos ya marcados: no se reetiquetan.** Los campos nuevos son opcionales y vacío significa «no anotado», como en el
  resto del contrato; los análisis nuevos solo cuentan lo que tenga el dato.

**Los tres «manuales» se pueden inferir**, con la condición de la calidad del tracking: con cámara móvil el movimiento del
encuadre se confunde con movimiento de las jugadoras (un cambio de cámara parece una pérdida o un desmarque), y con toma
fija o calibración confiable se vuelve mucho más fiable. Reglas candidatas, todas sobre posiciones en la cancha:

| Etiqueta | Cómo se infiere |
|---|---|
| `receive_under_pressure` | Al recibir (primer toque tras un pase completado), la rival más cercana está a ≤ ~2 m. El resultado sale de lo que pasa después: conserva (el balón sigue con su equipo), progresa (gana metros hacia la portería rival) o pierde (cambia de equipo). |
| `carry_to_commit` | Con el balón en conducción, una rival se acerca (la distancia baja de un umbral) y la compañera de apoyo queda con más espacio que antes; el resultado es el siguiente toque. Es la regla más débil: depende de una intención. |
| `effective_press` | Una rival hace un pase **fallido** (turnover) y una jugadora nuestra estaba cerca del pasador (≤ ~4 m, a definir) en el instante del pase: «fuerza error». Si recuperamos el balón en pocos segundos: «gana el balón»; si no: neutral. Solo cuenta cuando nuestra jugadora está cerca, para no darle crédito de un error que no provocó. |
| `run_type` | Con velocidad y dirección de cada jugadora: **recibe** (corre hacia el balón y lo recibe en pocos segundos), **desmarque** o generar espacio (carrera sostenida hacia atrás de la línea rival, o que se lleva a una marcadora, sin recibir) y **transición** (se perdió el balón y la jugadora regresa rápido hacia él en los siguientes segundos). |

Lo inferido se guarda **aparte** de las etiquetas manuales (con una marca de origen `inferred` y la versión de la regla),
para poder compararlo con lo que la analista marque en una muestra y medir cuánto acierta antes de mostrarlo en Análisis.
Cada regla es una función pura sobre posiciones (`src/sportsan/metrics/` o `web/lib/`), con su prueba.

## 5. Recomendación

1. **Ahora (sin tocar el catálogo):** pase progresivo inferido con éxito y fallo por zonas, en Análisis › Rendimiento
   individual.
2. **Cambio de contrato pequeño:** `rater_id` y `manual_version` opcionales; campo opcional con el tipo de acción en
   `recovery`; evento `defensive_action` con `outcome`. Sin reetiquetar partidos viejos.
3. **Inferencia:** empezar por `effective_press` y `receive_under_pressure` (usan posiciones y estado del balón que ya
   tenemos) y por `run_type`; validar cada una contra una muestra marcada a mano de un partido de cámara fija antes de
   mostrarla. `carry_to_commit` al final.
4. Lo manual queda solo como corrección o muestra de validación.

## 6. Pregunta abierta

¿Estas etiquetas son para los **partidos** (la app de hoy) o para las **sesiones de fuerzas básicas** (entrenamientos)? Las
de contexto (`task_type`, `constraints_code`) apuntan a lo segundo, y entonces el modelo de datos correcto es una sesión con
tareas y no un evento de partido. Eso cambia dónde se implementa.
