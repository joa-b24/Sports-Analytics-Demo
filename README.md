# Analítica deportiva (MVP)

## Puesta en marcha (Windows, PowerShell, desde esta carpeta)

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python -m pytest                      # los tests de tracking se saltan si no tienes supervision (solo hace falta en Colab)
```

## App web

```powershell
cd web
npm install
npm run dev      # http://localhost:3000
```

Detalles y despliegue: `web/README.md`.

Cada partido tiene su carpeta en `matches/<match_id>/` con su `match.yaml` (equipos, sede, videos). El partido por defecto se elige en `config/project.yaml`.

**Para ubicarte en el repo: `docs/mapa_del_repo.md`** (qué hace cada archivo, desde dónde se corre cada comando, dónde se guarda cada dato).

Más contexto: `CLAUDE.md`, `docs/architecture.md`, `docs/data_contract.md`, `docs/propuesta_investigacion.md`, `docs/referencias.md`.

## Tracking
Corre en la laptop, por partes: `python -m sportsan.tracking.process` (pasos completos en `docs/mapa_del_repo.md`, sección 7.2). El cuaderno `notebooks/tracking_test.ipynb` es del pipeline antiguo de Colab y ya no se usa. Para trabajar con varios agentes en paralelo: `docs/parallel_workflow.md`.
