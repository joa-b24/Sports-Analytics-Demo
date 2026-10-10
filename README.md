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

Más contexto: `CLAUDE.md`, `docs/architecture.md`, `docs/data_contract.md`, `docs/propuesta_investigacion.md`, `docs/referencias.md`.

## Tracking
Sube el repo a Google Drive y sigue `notebooks/tracking_test.ipynb`. Para trabajar con varios agentes en paralelo: `docs/parallel_workflow.md`.
