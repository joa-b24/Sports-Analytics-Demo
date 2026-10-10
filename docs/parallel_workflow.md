# Trabajar en paralelo con Claude Code

Hay dos formas, y se pueden combinar.

## 1. Subagentes dentro de una sesión
Los agentes están en `.claude/agents/` (`ingest-engineer`, `tracking-engineer`, `metrics-engineer`, `app-engineer`, `contract-reviewer`). En una sesión de Claude Code puedes pedir cosas como:

> "Con el agente de métricas implementa la distancia recorrida y, en paralelo, con el de app agrega la pestaña de comparación. Cuando terminen, pasa el contract-reviewer."

Cada agente trabaja solo en su carpeta; el contrato de datos es lo que los mantiene compatibles.

## 2. Sesiones separadas con `git worktree`
Cada frente en su propia carpeta y rama, sin pisarse. En PowerShell, desde la raíz del repo:

```powershell
git init
git add .
git commit -m "esqueleto del proyecto"

git worktree add ..\sa-tracking -b feat/tracking
git worktree add ..\sa-metrics  -b feat/metrics
git worktree add ..\sa-app      -b feat/app
```

En cada carpeta nueva:

```powershell
cd ..\sa-app
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python -m sportsan.mock.generate     # data/ y los videos de matches/ no vienen en git
claude
```

Notas:
- Haz `pip install -e .` **dentro de cada worktree**: una instalación editable apunta a una sola carpeta.
- Los videos y parquets están en `.gitignore`, así que no aparecen en los worktrees. Para el tracking real, trabaja con rutas absolutas o copia el segmento de prueba.
- Para integrar: `git merge feat/metrics` desde la rama principal, y corre `python -m pytest` y el `contract-reviewer` antes de seguir.
- Limpieza al terminar: `git worktree remove ..\sa-app`.

## Orden recomendado ahora
El orden vigente está en `docs/roadmap.md`. Lo que sigue es el plan anterior y queda como referencia.

1. **Tú:** corre el notebook de tracking en Colab (`notebooks/tracking_test.ipynb`) y trae el resultado.
2. **En paralelo (no depende del tracking):** `app-engineer` con el etiquetado manual de eventos y el visor de jugadas; `metrics-engineer` con las métricas que ya se pueden calcular con datos de prueba.
3. Con el resultado del notebook se decide el alcance real de las métricas de posición.
