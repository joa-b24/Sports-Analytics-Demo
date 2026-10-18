# Preguntas del cuerpo técnico y catálogo de eventos

Propuesta del 2026-10-11. Es el paso 1 de la línea B de `docs/roadmap.md`: primero se decide qué preguntas debe responder la app
y de ahí sale qué se etiqueta, no al revés.

**Estado: adoptada por la analista para la propuesta y la demo, sin revisar todavía con el cuerpo técnico.** Las 22 preguntas se
dan por buenas, con un cambio: el partido se parte en tramos de 5 o 10 minutos, no de 15. El catálogo de la sección 2 ya está en
el contrato y en la app; las preguntas de tracking siguen pendientes. Cuando el cuerpo técnico lo vea, lo que cambie se ajusta aquí
y en el contrato.

## Cómo usar este documento

1. Leer las preguntas de cada momento del juego y marcar las que de verdad se usarían para preparar un partido o un entrenamiento.
   Meta: quedarse con 3 a 5 por momento. Tachar las demás y añadir las que falten.
2. Con las elegidas, confirmar el catálogo de eventos de la sección 2: solo entra lo que alguna pregunta necesita.
3. Etiquetar un mismo tramo de 15 minutos entre dos personas y comparar. Un tipo de evento en el que no coinciden sale del catálogo.

Cada pregunta dice de dónde saldría la respuesta:

| Marca | Significa |
|---|---|
| **Hoy** | Sale de lo que ya se etiqueta |
| **Derivado** | Sale de lo que ya se etiqueta, con un cálculo nuevo; no cuesta tiempo de etiquetado |
| **Nuevo** | Necesita un evento o un dato más al etiquetar (sección 2) |
| **Tracking** | Necesita posiciones medidas; solo dentro de una jugada y de lo que la cámara ve |

## 1. Preguntas propuestas

Sirven igual para un rival ("¿cómo lo hacen ellas?") y para un partido propio ("¿cómo lo hicimos?").

### Ataque organizado

| # | Pregunta | Fuente |
|---|---|---|
| A1 | ¿Desde dónde tiran y cuántos tiros van a puerta? | Hoy (posición) + Nuevo (resultado del tiro) |
| A2 | ¿Por qué carril llegan al último tercio: izquierda, centro o derecha? | Nuevo (entrada al último tercio) |
| A3 | ¿Cuántas veces entran al área y cuántas de esas acaban en tiro? | Nuevo (entrada al área) + Derivado |
| A4 | ¿Cómo salen desde su portería: en corto o en largo, y hasta dónde llegan? | Nuevo (saque de meta) |
| A5 | ¿Cuántos centros hacen, desde qué banda y cuántos se rematan? | Nuevo (centro) |

### Transición defensiva (al perder el balón)

| # | Pregunta | Fuente |
|---|---|---|
| B1 | ¿En qué zona pierden el balón? | Hoy |
| B2 | ¿Cuántas pérdidas acaban en tiro del contrario en menos de 15 segundos? | Derivado |
| B3 | ¿Recuperan rápido tras perder (en menos de 8 segundos) o repliegan? | Derivado |
| B4 | ¿Cuántas jugadoras quedan por detrás del balón al perderlo? | Tracking |

### Defensa organizada

| # | Pregunta | Fuente |
|---|---|---|
| C1 | ¿A qué altura recuperan: campo rival, medio o propio? | Hoy |
| C2 | ¿Por qué carril les llegan más y desde dónde les tiran? | Hoy (tiros en contra) + Nuevo (entrada al último tercio del contrario) |
| C3 | ¿Dónde hacen las faltas? | Hoy |
| C4 | ¿Qué tan alto y qué tan ancho está el bloque cuando el rival tiene el balón? | Tracking |

### Transición ofensiva (al recuperar)

| # | Pregunta | Fuente |
|---|---|---|
| D1 | ¿Cuántas recuperaciones acaban en tiro propio en menos de 15 segundos? | Derivado |
| D2 | ¿Desde qué zona salen esas recuperaciones que acaban en tiro? | Derivado |
| D3 | Tras recuperar, ¿van hacia adelante o aseguran el balón? | Nuevo (primer pase tras recuperar: adelante o atrás) |

### Balón parado

| # | Pregunta | Fuente |
|---|---|---|
| E1 | ¿Cuántos córners y tiros libres a favor y en contra, y cuántos acaban en remate? | Hoy + Nuevo (resultado) |
| E2 | En los córners, ¿mandan cerrado, abierto o juegan en corto? | Nuevo (tipo de envío) |
| E3 | ¿Quién los cobra y a quién buscan? | Hoy (número de jugadora) + nota |
| E4 | En contra, ¿defienden en zona o al marcaje, y dónde dejan el hueco? | Nota libre de la analista; no se cuenta |

### A lo largo del partido

| # | Pregunta | Fuente |
|---|---|---|
| F1 | ¿En qué tramo del partido generan y reciben más (cada 5 o 10 minutos de juego)? | Derivado (ya hay tramos de juego marcados) |
| F2 | ¿Cambian tras el descanso o tras un gol? | Derivado |

## 2. Catálogo de eventos propuesto

Lo que hay hoy: tiro, gol, pérdida, recuperación, falta, córner, tiro libre, saque de banda, penal, pase clave y otro; cada uno con
equipo, tiempo, posición opcional, jugadora opcional y nota.

### Lo que se añadiría

| Cambio | Para qué preguntas | Cómo se marca | Coste |
|---|---|---|---|
| **Resultado del tiro**: gol, a puerta, fuera, bloqueado | A1 | Una tecla más después de «tiro». El campo `outcome` ya existe en el contrato, solo se fijan sus valores | Bajo |
| **Resultado del balón parado**: remate, despeje, sigue la jugada | E1 | Igual, sobre córner y tiro libre | Bajo |
| **Tipo de envío del córner**: cerrado, abierto, corto | E2 | Segundo dato del córner | Bajo |
| **Entrada al último tercio** (evento nuevo, con carril por la posición) | A2, C2 | Tecla nueva + clic en la cancha | Medio: son frecuentes |
| **Entrada al área** (evento nuevo) | A3 | Tecla nueva | Bajo |
| **Saque de meta** (evento nuevo): corto o largo | A4 | Tecla nueva + resultado | Bajo |
| **Centro** (evento nuevo): rematado o no | A5 | Tecla nueva + clic | Medio |
| **Primer pase tras recuperar**: adelante o atrás | D3 | Dato extra de «recuperación» | Medio: obliga a esperar al pase |

### Lo que sale gratis de lo ya etiquetado

No pide teclas nuevas, solo cálculo:

- Pérdida → tiro rival en menos de 15 s (B2) y recuperación → tiro propio en menos de 15 s (D1, D2).
- Recuperación en menos de 8 s tras una pérdida propia (B3).
- Altura de recuperación y zonas (B1, C1, C3): ya está, por tercios y carriles.
- Reparto por tramos de 5 o 10 minutos de juego y antes/después del descanso (F1, F2): usa los tramos marcados en la app.

### Lo que no se propone

- **Pases uno a uno y posesión exacta.** Etiquetar cada pase multiplica el tiempo por partido; la posesión aproximada se puede
  estimar después con el tracking.
- **Presión.** Dos personas rara vez coinciden en qué cuenta como presión; sin acuerdo, el número no vale.
- **Duelos, solo como opción** (2026-10-17). Se añadió `duel` (tecla `D`, resultado ganado o perdido, detalle aéreo o en el
  suelo) para el mapa de duelos del informe, pero no entra en el etiquetado normal: alarga mucho la pasada 1 y la duda sobre
  qué cuenta como duelo sigue. Se etiqueta solo en los partidos donde se quiere ese mapa.
- **Forma del bloque, superioridad numérica, distancia entre líneas.** Son de tracking (B4, C4).

### Antes de adoptarlo

- Medir cuánto se tarda en etiquetar un partido con el catálogo actual y con el ampliado. Si el ampliado pasa de lo que la
  analista puede sostener cada semana, se recorta empezando por los de coste medio.
- Dos personas etiquetan el mismo tramo y se compara, tipo por tipo.
- Cada gráfico nuevo muestra cuántos eventos hay detrás. Con menos de unos 10 no se saca conclusión.

## 2b. Qué preguntas responde cada sección del informe

El informe (`web/components/match/ReportTab.tsx`, cálculo en `web/lib/report.ts`) se organiza por niveles de datos
(N1 eventos, N2 balón seguido, N3 tracking revisado, N4 tracking con nombres). Hoy, con eventos (N1):

| Sección del informe | Preguntas | Nivel |
|---|---|---|
| 3. Resumen del juego (barras y tramos de 5 o 10 min) | A1 (tiros y a puerta), A2 y C2 (entradas al último tercio, total), A3, A5 (total), E1 (córners), F1 | N1 |
| 4. Mapas: tiros y portería | A1, C2 (desde dónde les tiran) | N1 |
| 4. Mapas: centros con destino | A5 | N1 |
| 4. Mapas: pérdidas y recuperaciones, 5 carriles × 3 tercios | B1, C1 | N1 |
| 4. Mapas: duelos (solo si se etiquetaron) | — (opcional) | N1 |
| 5. Transiciones | B2, B3, D1, D2 | N1 |
| 6. Balón parado | A4, E1, E2; E3 y E4 en el texto de la analista | N1 |
| 3. Posesión, pases por tercio y carril, cambios confirmados o inferidos | A2 y A4 con el balón (por dónde y desde dónde juegan), B1 con el balón (dónde les cortan) | N2 |
| 7. Patrones | A2 por 5 carriles, A4, B2, A5 por banda, B4 (pendiente, fase 3) | N1–N3 |
| 3. Red de pases y 8. toques por jugadora | E3 a lo largo del juego (quién la toca y con quién se asocia) | N4 |

## 3. Cuestionarios del auxiliar (bienestar y carga)

No son preguntas sobre el juego, pero el auxiliar ya los tiene y son la fuente de dos cosas que la app hoy marca como «falta de
datos»: la carga por sesión y el bienestar.

### Antes de entrenar

| Pregunta | Respuesta |
|---|---|
| Sueño, estrés, fatiga, dolor muscular | Escala de 1 a 7 cada una |
| Horas de sueño | Número |
| Nivel de energía | Escala de 1 a 10 |
| Enfermedad | Sí / no |
| Ciclo menstrual | Sí / no |
| Estado de ánimo | Abierta |
| Molestia específica | Abierta |

### Después de entrenar

| Pregunta | Respuesta |
|---|---|
| Esfuerzo percibido (RPE) | Escala de 1 a 10 |
| Autoevaluación del rendimiento | Abierta |
| Molestias | Abierta |

### Qué permite

- **Carga de la sesión (sRPE) = RPE × minutos de la sesión.** Es justo la carga por sesión que faltaba. Con cuatro semanas
  seguidas se puede calcular la carga aguda : crónica (ACWR) por jugadora, sin depender de que el sensor dé una carga.
- **Tendencia de bienestar por jugadora**: sueño, estrés, fatiga y dolor a lo largo de las semanas, junto a su carga.
- **Avisos sencillos**: por ejemplo, dos días seguidos con fatiga alta, o dolor que sube mientras la carga sube.

### Lo que se sabe (respuestas de la analista, 2026-10-11)

| Duda | Respuesta |
|---|---|
| ¿Cómo se recoge hoy? | Google Forms, lo guarda el auxiliar. Se podría exportar como CSV, pero pedirlo depende de que aprueben el proyecto |
| ¿Se anota cuánto duró cada sesión? | No se sabe. Se puede tomar de al menos una jugadora que registre con sensor o reloj: la app usa la mediana de quienes sí la tienen en esa sesión y lo dice |
| ¿Con qué identificador responde cada jugadora? | Su nombre. Sirve mientras se escriba igual que en el archivo de sensores; la plantilla lo resolverá después |
| Sentido de las escalas | Sueño, estrés, fatiga y dolor muscular: 1 es lo mejor, 7 lo peor. Horas de sueño y energía: más es mejor (energía de 1 a 10) |
| Ciclo menstrual | Pregunta literal: «¿Te encuentras en tu periodo menstrual?», sí o no |
| ¿Quién ve las respuestas? | El auxiliar y el entrenador principal |

Queda por ver el archivo real de Google Forms: sus encabezados serán las preguntas completas y traerá marca de tiempo, así que hará
falta una conversión a las columnas de abajo (o un importador propio) cuando haya un ejemplo.

### Datos sensibles

Enfermedad, ciclo menstrual, ánimo y molestias son datos de salud de cada jugadora. Hasta que haya cuentas y permisos (fase 2 de
`docs/architecture.md`):

- No se meten en el respaldo general de la app, que se comparte entre computadoras.
- Los ve solo quien el cuerpo técnico decida (normalmente el auxiliar y la médica o fisioterapeuta), y cada jugadora debe saber
  quién los ve y para qué.
- Las respuestas abiertas se leen, no se grafican.

Lo que ya entra: el **RPE con la duración de la sesión** y las cinco escalas numéricas del cuestionario previo, como columnas del CSV de entrenamientos. Al importar, la app descarta las columnas de enfermedad, periodo menstrual, ánimo y molestias aunque vengan en el archivo.

### Formato propuesto para importar (cuando se confirme lo anterior)

Una fila por jugadora y sesión, en el mismo CSV de entrenamientos que ya lee la app:

```
date,session_id,player_id,duration_min,rpe,sleep_hours,sleep_q,stress,fatigue,soreness,energy
2026-10-12,s1,J07,90,6,7.5,5,3,4,2,7
```

`date` y `player_id` son obligatorias. Con `rpe` y `duration_min` la app calcula la carga de la sesión y, con cuatro semanas de
historial, la carga aguda : crónica por jugadora (Sesiones e Inicio). Las escalas se muestran por jugadora con su sentido correcto.
Los avisos que cruzan carga y bienestar no están construidos: hacen falta respuestas reales para decidir qué combinación avisa.
