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

## 4. Recomendación

1. **Ahora (sin tocar el catálogo):** calcular de forma inferida el pase progresivo con éxito/fallo por zonas y mostrarlo en
   Análisis › Rendimiento individual.
2. **Siguiente (cambio de contrato pequeño):** `rater_id` y `manual_version` opcionales; `detail` de `recovery` con tackle,
   intercepción y bloqueo.
3. **Después, solo si el cuerpo técnico los usa:** los eventos manuales `receive_under_pressure`, `carry_to_commit`,
   `run_type` y `effective_press` (cada uno con su `outcome` de tres valores). Son los que más cuestan al etiquetar: conviene
   probarlos primero en una sola pasada de un partido y medir cuánto tarda.

## 5. Pregunta abierta

¿Estas etiquetas son para los **partidos** (la app de hoy) o para las **sesiones de fuerzas básicas** (entrenamientos)? Las
de contexto (`task_type`, `constraints_code`) apuntan a lo segundo, y entonces el modelo de datos correcto es una sesión con
tareas y no un evento de partido. Eso cambia dónde se implementa.
