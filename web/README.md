# App web (Next.js)

Interfaz del proyecto. Sustituye a la app de Streamlit (`app/`), que queda solo como referencia.

## Correrla en tu computadora

```powershell
cd web
npm install      # solo la primera vez
npm run dev      # abre http://localhost:3000
```

## Desplegarla (gratis, sin tarjeta)

```powershell
cd web
npx vercel --prod
```

La primera vez pide iniciar sesión (correo o GitHub) y confirmar el proyecto; acepta los valores por defecto con Enter. Al terminar imprime la URL pública.

## Secciones

| Ruta | Qué hace |
|---|---|
| `/` | Inicio y acceso a cada sección |
| `/rivales` | Partidos de rivales (análisis previo) |
| `/partidos` | Partidos propios (post-partido) |
| `/partido?id=…` | Un partido: video y etiquetado, jugadas y animación, análisis, informe imprimible |
| `/entrenamientos` | Carga por jugadora a partir del CSV de sensores |
| `/calibracion` | Calibración de cancha: puntos de referencia sobre un cuadro del video (archivo local) |
| `/datos` | Formatos esperados, importar/exportar, respaldo, datos de ejemplo |

## Dónde están los datos

En el navegador (`localStorage`), no en un servidor: cada computadora tiene su propia copia. Para moverlos o respaldarlos usa **Datos → Exportar respaldo**. Todo el acceso pasa por `lib/store.ts`; cuando haya base de datos, se cambia ese archivo y nada más.

## Video

Dos fuentes con el mismo tiempo (`t_video`, segundos del video original):

- **YouTube**: se pega el enlace en el partido. No se aloja video.
- **Archivo local**: el video original completo, sin recortar. No se sube a ningún lado y hay que volver a abrirlo en cada sesión.

Sin ninguna de las dos, un reloj manual hace de tiempo para poder probar el flujo.

## Código

- `lib/types.ts`: tipos; los eventos siguen `docs/data_contract.md`.
- `lib/stats.ts`: cálculos puros (conteos, zonas, interpolación de keyframes).
- `lib/demo.ts`: datos de ejemplo sintéticos, siempre marcados como tales.
- `components/`: cancha, reproductor, gráficos y las pestañas del partido.
