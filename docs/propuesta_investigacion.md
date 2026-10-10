# Analítica de fútbol accesible para equipos universitarios a partir de video y sensores

**Propuesta de investigación y desarrollo**

Responsable: [COMPLETAR: nombre, programa, correo] · Equipo: [COMPLETAR] · Fecha: octubre de 2026

## Resumen

Los equipos universitarios graban sus partidos y usan sensores en los entrenamientos, pero casi nunca convierten ese material en información para decidir. Las herramientas profesionales cuestan más de lo que un programa universitario puede pagar y suponen cámaras e instalaciones que no tenemos. Este proyecto construye una herramienta gratuita y abierta que cubre el ciclo completo del cuerpo técnico: preparar al rival, revisar los partidos propios y seguir la carga de entrenamiento.

Ya existe un prototipo funcional. Lo que se solicita son recursos para resolver la parte que hoy no funciona: obtener automáticamente la posición de las jugadoras a partir del video de una cámara de encuadre automático.

## Problema

1. **El análisis del rival se hace a ojo.** Se ve el video y se toman notas sueltas; no queda un registro comparable entre partidos ni un informe con formato fijo.
2. **Los datos están dispersos.** Video en YouTube, sensores en la plataforma del fabricante, notas en papel.
3. **El tracking automático disponible no sirve con nuestro video.** Los modelos abiertos se entrenaron con transmisiones profesionales. Nuestra cámara sigue el juego con un encuadre que cambia todo el tiempo, y la cancha comparte terreno con otras canchas cuyas líneas quedan dentro de la imagen.

## Qué existe hoy

| Componente | Estado |
|---|---|
| App web (Next.js) con secciones de rivales, partidos propios, entrenamientos y datos | Funciona |
| Etiquetado manual de eventos sobre el video (11 tipos, posición en cancha, atajos de teclado) | Funciona |
| Visor de jugadas sincronizado con el video (YouTube o archivo local) | Funciona |
| Animación de cancha por keyframes, sincronizada con el clip | Funciona; las posiciones se colocan a mano |
| Gráficos: comparación por tipo de evento, mapa de tiros, zonas de recuperación y pérdida | Funciona |
| Informe de rival o post-partido imprimible | Funciona |
| Carga de entrenamientos desde CSV de sensores | Funciona; falta probarlo con el archivo real del sensor |
| Contrato de datos y pipeline de ingesta (descarga, segmentación en tramos de juego) | Funciona; un partido segmentado en 13 tramos de juego |
| Pipeline de tracking (detección, seguimiento, equipos, homografía) | Escrito y probado con modelos simulados; **la prueba con video real no dio posiciones utilizables** |

## Resultado de la prueba piloto de tracking

Se corrió el pipeline sobre un segmento real del partido en Google Colab.

- Resultado: [COMPLETAR con lo observado: por ejemplo, porcentaje de frames con calibración aceptada, qué se veía mal en el video de diagnóstico].
- Hipótesis sobre la causa (sin verificar todavía): la calidad del video, y las líneas amarillas de otras canchas que el modelo de puntos de referencia confunde con los límites de la cancha real.
- Diagnóstico pendiente: el pipeline guarda, por cada frame, cuántos puntos de la cancha se detectaron y por qué se rechazó la calibración. Con esa tabla se puede separar si falla la detección de jugadoras, la de la cancha o la clasificación de equipos.

Este resultado negativo es el punto de partida de la investigación: delimita qué parte del problema está resuelta por herramientas existentes y cuál no.

## Preguntas de investigación

1. ¿Qué precisión de posición (en metros) se puede alcanzar con una sola cámara de encuadre automático en una cancha con líneas de varios deportes?
2. ¿Cuántas imágenes etiquetadas de nuestras propias canchas hacen falta para adaptar los modelos abiertos de detección de cancha y de jugadoras?
3. ¿Cuánto trabajo manual de validación requiere una jugada de 15 segundos para ser utilizable, y cómo se compara con dibujarla a mano?
4. ¿Qué indicadores obtenidos solo del etiquetado manual le resultan útiles al cuerpo técnico para preparar un partido?

## Metodología

**Fase 1. Herramienta de análisis manual (hecha).** Etiquetado, jugadas, informe y entrenamientos. Entrega valor sin depender del tracking.

**Fase 2. Uso real y evaluación.** El cuerpo técnico usa la herramienta en [COMPLETAR: número] partidos. Se mide el tiempo de etiquetado por partido, la concordancia entre dos personas que etiquetan el mismo tramo y qué partes del informe se usan.

**Fase 3. Tracking adaptado a nuestra cámara.**
- Diagnóstico del piloto con las tablas de calibración.
- Etiquetado de un conjunto propio de imágenes (puntos de la cancha y jugadoras) y reentrenamiento de los modelos abiertos.
- Evaluación contra posiciones medidas a mano en una muestra de frames. Criterio de éxito: [COMPLETAR, por ejemplo error mediano menor a 2 m en al menos 70 % de los frames].
- Alternativa si no se alcanza: grabar con una cámara fija de plano abierto, que elimina el encuadre cambiante.

**Fase 4. Integración.** Las posiciones validadas alimentan la animación de cancha y las métricas de posición (forma del equipo, mapas de calor, distancia), declarando siempre qué parte de la cancha estaba en cuadro.

## Recursos solicitados

| Recurso | Para qué | Cantidad / monto |
|---|---|---|
| Cómputo con GPU | Reentrenar modelos y procesar partidos completos (los planes gratuitos se cortan a media corrida) | [COMPLETAR] |
| Acceso al video panorámico completo o una cámara fija de plano abierto | Eliminar la principal fuente de error del tracking | [COMPLETAR] |
| Horas de etiquetado (estudiantes) | Conjunto de imágenes propio y eventos de los partidos | [COMPLETAR] |
| Acceso a los datos de los sensores de entrenamiento | Sección de entrenamientos con datos reales | [COMPLETAR] |
| Asesoría (visión por computadora, ciencias del deporte) | Validar el método y los indicadores | [COMPLETAR] |

## Cronograma

| Periodo | Actividad |
|---|---|
| [COMPLETAR] | Fase 2: uso con el cuerpo técnico y diagnóstico del piloto |
| [COMPLETAR] | Fase 3: conjunto de datos propio y reentrenamiento |
| [COMPLETAR] | Fase 3: evaluación; decisión sobre la cámara fija |
| [COMPLETAR] | Fase 4: integración y reporte final |

## Riesgos

| Riesgo | Qué se hace |
|---|---|
| El tracking no alcanza la precisión necesaria con esta cámara | La herramienta manual sigue entregando valor; se documenta el límite y se prueba la cámara fija |
| El etiquetado manual toma demasiado tiempo | Catálogo corto de eventos y atajos de teclado; se mide en la fase 2 |
| Datos de jugadoras (video, sensores) | Uso interno del equipo, con consentimiento; no se publican datos personales [COMPLETAR según la política de la institución] |

## Entregables

1. App desplegada y su código.
2. Documentación técnica y contrato de datos.
3. Conjunto de imágenes etiquetadas de nuestras canchas.
4. Reporte con la precisión alcanzada por el tracking y los resultados de uso con el cuerpo técnico.

## Referencias

Ver `docs/referencias.md`.
