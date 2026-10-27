# Playground de balón: formatos de trabajo

Archivos de trabajo (no son parte del contrato de datos ni pasan por `validate_*`). Viven en `matches/<id>/tracking/`.

## `ball_samples_<video>.json` (lo escribe la pestaña Playground)

```json
{
  "kind": "ball_samples",
  "video_id": "v2",
  "fps": 29.97,
  "samples": [
    {"t_video": 1234.567, "px": [812.0, 455.5], "aerial": false, "shadow_px": null},
    {"t_video": 1301.2,   "px": [640.0, 300.0], "aerial": true,  "shadow_px": [652.0, 410.0]}
  ],
  "negatives": [{"t_video": 1500.0}]
}
```

- `t_video`: segundos en el video original (nunca editado); el cuadro es `round(t_video * fps_del_archivo)`. Si `fps` del JSON difiere del del video, manda el del video (aviso).
- `px`: centro del balón en píxeles del cuadro completo (origen arriba a la izquierda), no una posición en la cancha. En un balón por alto es el balón, no su sombra.
- `aerial`: el balón va por el aire. `shadow_px`: dónde cae su sombra/proyección (opcional); se usa como negativo difícil.
- `negatives`: cuadros donde no hay balón visible; todo candidato de ese cuadro es negativo.
- Se rechazan (ValueError con la posición) `kind` distinto, tiempos negativos o no numéricos, `px` que no sea `[x, y]` finito. Los negativos duplicados se unen.

## Entrenar

```
python -m sportsan.tracking.ball train --match <id> --samples matches/<id>/tracking/ball_samples_<video>.json [--exclude-aerial] [--holdout 0.2] [--out weights/mi_modelo.pt] [--epochs 12] [--seed 0]
```

- Entrena SOLO con ese archivo. Menos de 100 muestras utilizables: avisa y entrena igual.
- Reserva (`--holdout`, por defecto 20 %) por bloques de 2 s (muestras vecinas no quedan a ambos lados), con semilla fija.
- Guarda `weights/ball_model_<video>_<fecha>.pt` y `<mismo nombre>.json` (antecedentes: sha256 del archivo de muestras, cuántas muestras/aéreas/negativos, tiempos reservados y validación). Nunca escribe `weights/ball_model.pt` ni sobrescribe un modelo existente.
- Validación (en `samples.validation` del modelo), a p >= 0.5 y p >= 0.90: por cuadro se toma el candidato de mayor p; acierto = a <= 15 px de `px`. Reporta `precision` (aciertos / predicciones, contando las de cuadros negativos), `recall`, error mediano y p90 en píxeles y en metros (solo si hay partes `tracks_*` con H para ese video; en un balón aéreo el error en metros es el de la proyección marcada), separado en `ground`, `aerial` y `all`.
- Progreso con % y ETA en consola y en `tracking/revision/progreso_train_<video>.log` (cuadros, épocas, validación).
- Límite conocido: el movimiento (diferencia con el cuadro anterior) usa la H de las partes si existen; si no, supone cámara quieta. Con cámara que se mueve y sin partes, el canal de movimiento se parece menos al de `run`.

### `ball_metrics_<video>.json` (al terminar train, si hubo reserva)

`{"kind":"ball_metrics","video_id","trained_at","model_file","n_train","n_val","threshold":0.5,"ground":{"n","precision","recall","error_px_median"},"aerial":{...}}`. `n_train`/`n_val` cuentan muestras con balón; precision = aciertos / predicciones con p>=0.5 en los cuadros con balón de esa clase (None si no hubo predicciones; los falsos en cuadros negativos solo entran en la precisión global del modelo .json).

## `ball_auto_<parte>.json` (salida de `ball run`)

```
python -m sportsan.tracking.ball run --match <id> --part tracks_v2_<ini>_<fin>.json --model weights/ball_model_v2_<fecha>.pt [--force]
```

No sobrescribe una salida existente sin `--force`. Campos añadidos a los ya conocidos: `generated` (fecha ISO), `model_file` (ruta del modelo usado; `model` ya trae sus antecedentes).

Cada punto de `frames` es `{"frame","px","py","p","flags":[...]}`. Los puntos dudosos se MARCAN, no se borran:

- `jump`: velocidad en metros reales > 30 m/s contra todos sus vecinos medibles (anterior y siguiente a <= 3 s). Un salto que se queda (despeje) no se marca.
- `in_player_box`: dentro de la caja de una persona (jugadora o árbitro; la parte no distingue) pero fuera de la zona de los pies. Sin H o sin cajas en el cuadro no se marca nada.

`quality` suma `flagged`, `flagged_jump`, `flagged_in_player_box`. Quien consuma el archivo decide si ignora los marcados; los antiguos no traen `flags` (tratar como `[]`).
