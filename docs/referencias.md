# Referencias y metodologías similares

Lista de trabajo. Los autores, títulos y años están citados de memoria: **verifica páginas, DOI y formato de cita antes de entregarla en un documento formal.**

## Cómo lo resuelven otros

| Enfoque | Qué hace | Qué exige | Relación con este proyecto |
|---|---|---|---|
| Datos de eventos (StatsBomb, Wyscout, Opta) | Personas etiquetan cada acción con posición y tiempo | Mano de obra entrenada | Es lo que hace nuestro etiquetado manual, con un catálogo reducido de 11 tipos |
| Tracking óptico profesional (TRACAB, Second Spectrum, Metrica) | Posición de las 22 jugadoras y el balón a 25 Hz | Varias cámaras fijas y calibradas, o video táctico de plano abierto | Fuera de alcance; es la referencia de calidad |
| Tracking desde video de transmisión (SoccerNet, `roboflow/sports`) | Detección + seguimiento + homografía por frame desde una sola cámara | Líneas de cancha visibles y modelos entrenados con ese tipo de imagen | Es lo que se probó en Colab; nuestra cámara y cancha difieren de los datos de entrenamiento |
| Cámaras de encuadre automático (Veo, Pixellot, Hudl Focus) | Graban panorámico y entregan un encuadre que sigue el juego | Suscripción; el panorámico completo no siempre se puede descargar | Es la fuente de nuestro video |
| Sensores (GPS, acelerómetro, frecuencia cardiaca) | Carga externa e interna por jugadora | Un dispositivo por jugadora | Sección de entrenamientos |

## Visión por computadora y tracking

- Zhang, Y. et al. (2022). *ByteTrack: Multi-Object Tracking by Associating Every Detection Box.* ECCV.
- Giancola, S., Amine, M., Dghaily, T. y Ghanem, B. (2018). *SoccerNet: A Scalable Dataset for Action Spotting in Soccer Videos.* CVPR Workshops.
- Cioppa, A. et al. (2022). *SoccerNet-Tracking: Multiple Object Tracking Dataset and Benchmark in Soccer Videos.* CVPR Workshops.
- Somers, V. et al. (2024). *SoccerNet Game State Reconstruction: End-to-End Athlete Tracking and Identification on a Minimap.* CVPR Workshops.
- Cuevas, C., Quilón, D. y García, N. (2020). *Techniques and applications for soccer video analysis: A survey.* Multimedia Tools and Applications.
- Roboflow. *sports* (repositorio): https://github.com/roboflow/sports y *supervision*: https://github.com/roboflow/supervision
- Ultralytics. *YOLO* (repositorio): https://github.com/ultralytics/ultralytics

## Métricas y modelos de juego

- Spearman, W. (2018). *Beyond Expected Goals.* MIT Sloan Sports Analytics Conference. (Control de espacio.)
- Fernández, J. y Bornn, L. (2018). *Wide Open Spaces: A statistical technique for measuring space creation in professional soccer.* MIT Sloan Sports Analytics Conference.
- Decroos, T., Bransen, L., Van Haaren, J. y Davis, J. (2019). *Actions Speak Louder than Goals: Valuing Player Actions in Soccer.* KDD.
- Pappalardo, L. et al. (2019). *A public data set of spatio-temporal match events in soccer competitions.* Scientific Data.

## Carga de entrenamiento

- Bourdon, P. C. et al. (2017). *Monitoring Athlete Training Loads: Consensus Statement.* International Journal of Sports Physiology and Performance.
- Impellizzeri, F. M., Marcora, S. M. y Coutts, A. J. (2019). *Internal and External Training Load: 15 Years On.* International Journal of Sports Physiology and Performance.

## Datos abiertos para comparar formatos

- StatsBomb Open Data: https://github.com/statsbomb/open-data
- Metrica Sports Sample Data (tracking + eventos sincronizados): https://github.com/metrica-sports/sample-data
