# Plan de ~10 h: balón, eventos y acceso remoto temporal

Escrito el 2026-11-01. Se actualiza al avanzar (marcar con [x]).

## Punto de partida (medido en los 10 clips marcados a mano)
Modelo actual: acierta 15 % del balón en suelo y 6 % en aire (radio 15 px), deja vacío ~80 %. El balón verdadero está
entre los candidatos del top-hat en el 80 % (suelo) y 60 % (aire) de los cuadros, pero el clasificador solo le da p ≥ 0.5
en 35 % y 18 %. Cuello de botella: el clasificador (entrenado con 54 positivos). Capa 2 con el mismo clasificador:
más cobertura pero ~40 % de precisión en sus marcas seguras. Por eso la capa 1 nueva es reentrenarlo con la verdad
de los clips (validando dejando un clip fuera cada vez).

## Bloque 1 · Modelo de balón (≈ 3 h)
- [x] Verdad a mano en /revision (10 clips, 532 marcas con suelo/aire) y `ball_compare` (puntaje por clase).
- [x] Capa 2: camino óptimo sobre candidatos (`ball_track.py`).
- [ ] Clasificador mejorado: recortes de los candidatos de los 10 clips, ajuste fino con validación dejando un clip fuera.
- [ ] Capa 3: suelo vs vuelo por marca (rasgos de la geometría proyectada), vuelos con parábola en píxeles, posición
      en la cancha `NaN` si el vuelo no tiene extremo en el suelo; cruces de rectas como sugerencia (nunca certeza).
- [ ] /revision: pestaña de resultados con los tres modelos (previo, nuevo, nuevo mejorado) sobre cada clip.

## Bloque 2 · Correr el balón en todos los partidos (en la laptop, en segundo plano, ≈ 4-5 h de reloj)
- [ ] Inventario: partes de Anáhuac 2.º tiempo sin tipo y 3 sin detección; UP sin ninguna.
- [ ] Cola `python -m sportsan.tracking.ball run` por parte con el modelo mejorado; progreso en `progreso_*.log`.
- [ ] Página de estado de la cola (lee los logs) para verla desde el celular.
- Compite por CPU con el bloque 1: primero se fija el modelo, luego se lanza la cola.

## Bloque 3 · Acceso remoto temporal (≈ 2 h, en paralelo a la cola)
- [x] `proxy.ts` de Next con contraseña (cookie, 5 intentos y bloqueo 15 min); /api/run, /unzip y /rename cerradas en remoto.
- [x] Túnel de Cloudflare sin cuenta (`bash tools/remoto.sh`, URL en tools/remoto_url.txt).
- [ ] Controles táctiles: balón (tocar para marcar, botones grandes, sin teclado), eventos (aceptar/descartar), uniones.
- [ ] Prueba con el celular emulado (Chrome sin ventana) y lista de qué sí/no se expone (solo `matches/` y `weights/`).

## Bloque 4 · Eventos (≈ 2 h)
- [ ] Reglas y tests de los eventos automáticos vs sugerencias (`lib/autoEvents.ts`, `lib/eventDetect.ts`).
- [ ] Verificación en la página de eventos con táctil.

## Riesgos
- 10 h de reloj no alcanzan para todo si la cola del balón tarda más (≈ 0.4-1 s por cuadro procesado).
- El túnel expone la laptop: contraseña larga, un solo uso de sesión, apagar al terminar.
