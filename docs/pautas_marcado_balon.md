# Pautas para marcar el balón

Para quien marca el balón en la vista **Balón** de la mesa de corrección. De cómo se marque dependen la posesión, los toques, los pases y los eventos sugeridos. Regla de oro: **di lo que ves; lo que no se ve, díselo a la app en lugar de adivinar**.

## Los tres estados

| Estado | Tecla | Cuándo | Qué hace la app |
|---|---|---|---|
| **Visible** | clic en el balón | Ves el balón (o su proyección en el suelo, ver más abajo). | Marca medida. Entre dos marcas cercanas (hasta 3 s) la línea es interpolada y nunca cuenta como toque. |
| **No se ve** | `u` | El balón sigue **en juego** pero está fuera de cuadro, tapado por jugadoras o muy lejos para distinguirlo. | Se interpola entre tu marca anterior y la siguiente (aunque pasen más de 3 s), sin contacto medido. Si el tracker o un evento habían puesto puntos ahí, se reemplazan. |
| **Fuera** | `o` | El balón salió de la cancha y **el juego está detenido** (saque de banda, de meta, de esquina, falta, gol). | El balón queda quieto y sin dueño (posesión «muerta», sin crédito para ningún equipo) hasta tu siguiente marca visible. No se dibuja ni se interpola nada dentro. |

`Enter` solo pasa a la siguiente muestra sin decir nada del balón (como antes). Cada estado dura **hasta tu siguiente marca de cualquier tipo**. `Supr` quita el estado del cuadro; `Ctrl + Z` deshace cualquier marca.

### Ejemplos

- **Tiro de banda.** El balón cruza la línea: en ese cuadro pulsa `o`. Cuando la jugadora lo tiene en las manos y está por sacar, marca el balón (clic): esa marca visible cierra el «fuera».
- **Balón tapado un segundo en una pelea.** `u` en el primer cuadro sin balón; cuando reaparece, marca. La línea entre ambas marcas queda interpolada y sin toques.
- **Balón que sale de cuadro en un pase largo.** `u` al salir; marca al volver a verlo. Si en realidad sabes por dónde fue, mejor la recta (`i`).
- **Gol.** `o` al cruzar la línea de meta; la reanudación (saque de centro) cierra el estado con una marca visible.

## Balón aéreo

Un balón por el aire no está en el suelo: la cancha es un plano y la calibración solo vale para lo que toca el suelo. Si marcas el balón en el aire, el punto cae lejos de donde está de verdad y puede parecer un toque de quien pasa por debajo.

1. Marca la **proyección del balón en el suelo**: el punto de la cancha justo debajo del balón (su sombra). Si no hay sombra clara, imagina la vertical desde el balón hasta el pasto.
2. Pulsa `y` (o el botón de la flecha hacia arriba) para dar a esa marca la **bandera de aéreo**. Con la bandera, nadie «toca» el balón ahí: ni toques, ni pases, ni posesión por cercanía.
3. Si ves el trazo completo, marca solo donde sale y donde cae (o usa la recta `i`) y no marques en medio.
4. **Ajustar la sombra:** mueve la marca con un clic nuevo en el mismo cuadro (conserva la bandera) y comprueba en la cancha lateral que el punto cae por donde pasaría una pelota rasante. La sombra corre más cerca del jugador de lo que parece cuando la cámara está alta: en la duda, hazla caer entre las dos jugadoras, no sobre una.
5. Quita la bandera con `y` otra vez en la marca donde el balón vuelve a tocar el suelo.

## El punto exacto de la reanudación

El saque, el córner o la falta definen quién tiene el balón después. Tras un «fuera»:

- Marca (clic) el balón **en el punto exacto donde se reanuda**, en el primer cuadro en que se ve ahí (no antes: el estado «fuera» cubre la espera).
- Esa marca visible es la que termina el «fuera»; si la haces tarde, el tiempo hasta ella cuenta como detenido.
- En los saques de esquina y de meta el balón está quieto en su sitio un buen rato: marca el punto en cuanto se coloca.

## El comando «quieto hasta la reanudación» (`k`)

Cuando el balón espera en su sitio (saque de meta, falta, esquina) y **sí lo ves**, no hace falta marcarlo cuadro por cuadro:

1. Marca el balón donde queda.
2. Avanza hasta el cuadro de la reanudación y pulsa `k`: la app lo mantiene en ese punto de la cancha (aunque la cámara se haya movido) con una recta hasta ahí.

Si el balón salió de la cancha y quieres que no cuente ninguna posesión mientras tanto, usa `o` (fuera), no `k`: `k` sigue siendo un balón visible, que la posesión puede dar a quien esté al lado después de 4 s quieto.

## Resumen de teclas

`clic` visible · `u` no se ve · `o` fuera · `y` marca aérea · `k` quieto hasta aquí · `i` recta · `n` donde falta · `Supr` quitar · `Ctrl + Z` deshacer · `Enter` pasar la muestra.

Cómo lo leen los cálculos: `ball_states` y la bandera `aerial` van en `tracks_fixed_*.json` (no cambian el contrato de las tablas). `ballStateAt(parts, video, t)` en `web/lib/parts.ts` devuelve `"visible" | "hidden" | "out" | null`.
