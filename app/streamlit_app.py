"""App de análisis (MVP). Ejecutar con:  streamlit run app/streamlit_app.py"""
import plotly.graph_objects as go
import streamlit as st

from pitch import pitch_figure
from sportsan.config import load_config, project_root
from sportsan.io import load_ball, load_events, load_tracking
from sportsan.metrics.team_shape import heatmap, team_shape
from sportsan.schema import PITCH_LENGTH_M, PITCH_WIDTH_M

st.set_page_config(page_title="Analítica deportiva", layout="wide")
cfg = load_config()
root = project_root()

source = st.sidebar.radio("Datos", ["Prueba (mock)", "Reales"])
if source == "Prueba (mock)":
    tdir = ldir = root / cfg["paths"]["mock_dir"]
else:
    tdir, ldir = root / cfg["paths"]["tracking_dir"], root / cfg["paths"]["events_dir"]


@st.cache_data
def load(tdir_: str, ldir_: str):
    tracking = load_tracking(tdir_)
    ball = load_ball(tdir_)
    try:
        events = load_events(ldir_)
    except FileNotFoundError:
        events = None
    return tracking, ball, events


try:
    tracking, ball, events = load(str(tdir), str(ldir))
except FileNotFoundError:
    if source == "Prueba (mock)":
        st.warning("No hay datos de prueba. Genera con `python -m sportsan.mock.generate`.")
    else:
        st.warning("Todavía no hay tracking real en data/tracking (se genera en el paso de tracking).")
    st.stop()

seg = st.sidebar.selectbox("Segmento", sorted(tracking["segment_id"].unique()))
team_sel = st.sidebar.selectbox("Equipo", ["own", "opp"], format_func=lambda t: "Propio" if t == "own" else "Rival")
trk = tracking[tracking["segment_id"] == seg]
bl = ball[ball["segment_id"] == seg]

tab_match, tab_shape, tab_heat, tab_events = st.tabs(["Partido", "Forma del equipo", "Mapa de calor", "Jugadas"])

with tab_match:
    frames = sorted(trk["frame"].unique())
    i = st.slider("Momento", 0, len(frames) - 1, 0)
    f = frames[i]
    fig = pitch_figure()
    colors = {"own": "#1f77b4", "opp": "#d62728", "ref": "#7f7f7f", "unk": "#bcbd22"}
    names = {"own": "Propio", "opp": "Rival", "ref": "Árbitro", "unk": "Sin equipo"}
    for team, d in trk[trk["frame"] == f].groupby("team"):
        fig.add_trace(go.Scatter(x=d["x"], y=d["y"], mode="markers+text", text=d["track_id"].astype(str),
                                 textposition="top center", name=names[team],
                                 marker=dict(size=12, color=colors[team])))
    b = bl[bl["frame"] == f]
    if len(b):
        fig.add_trace(go.Scatter(x=b["x"], y=b["y"], mode="markers", name="Balón",
                                 marker=dict(size=9, color="black", symbol="circle-open", line=dict(width=2))))
    st.plotly_chart(fig, width="stretch")

with tab_shape:
    shape = team_shape(trk, team_sel)
    c1, c2 = st.columns(2)
    for col, metric, title in ((c1, "length", "Largo del equipo (m)"), (c2, "width", "Ancho del equipo (m)")):
        fg = go.Figure(go.Scatter(x=shape["t_video"], y=shape[metric], mode="lines"))
        fg.update_layout(title=title, xaxis_title="Tiempo del video (s)", height=320, margin=dict(t=40))
        col.plotly_chart(fg, width="stretch")

with tab_heat:
    h = heatmap(trk, team_sel)
    fig = pitch_figure()
    xs = [(k + 0.5) * PITCH_LENGTH_M / h.shape[1] for k in range(h.shape[1])]
    ys = [(k + 0.5) * PITCH_WIDTH_M / h.shape[0] for k in range(h.shape[0])]
    fig.add_trace(go.Heatmap(x=xs, y=ys, z=h, opacity=0.65, colorscale="YlOrRd", showscale=False))
    st.plotly_chart(fig, width="stretch")

with tab_events:
    if events is None or events.empty:
        st.info("Aún no hay eventos etiquetados.")
    else:
        st.dataframe(events[["event_id", "t_video", "type", "team", "note"]], width="stretch")
        pick = st.selectbox("Ver jugada", events["event_id"])
        t = float(events.loc[events["event_id"] == pick, "t_video"].iloc[0])
        yt = cfg.get("youtube_id", "")
        if yt and yt != "REEMPLAZAR":
            st.video(f"https://www.youtube.com/watch?v={yt}", start_time=max(int(t) - 5, 0), end_time=int(t) + 10)
        else:
            st.caption(f"Pon tu youtube_id en config/project.yaml para ver el video. Tiempo del evento: {t:.0f} s")
