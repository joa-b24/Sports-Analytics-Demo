"""Cancha dibujada con Plotly (metros, 105 x 68, origen arriba a la izquierda)."""
import plotly.graph_objects as go

L, W = 105.0, 68.0
LINE = dict(color="#9aa0a6", width=1.5)


def _rect(fig, x0, y0, x1, y1):
    fig.add_shape(type="rect", x0=x0, y0=y0, x1=x1, y1=y1, line=LINE)


def pitch_figure(height: int = 520) -> go.Figure:
    fig = go.Figure()
    _rect(fig, 0, 0, L, W)
    fig.add_shape(type="line", x0=L / 2, y0=0, x1=L / 2, y1=W, line=LINE)
    fig.add_shape(type="circle", x0=L / 2 - 9.15, y0=W / 2 - 9.15, x1=L / 2 + 9.15, y1=W / 2 + 9.15, line=LINE)
    for side in (0, 1):  # áreas grande y chica
        sx = 0 if side == 0 else L
        sg = 1 if side == 0 else -1
        _rect(fig, sx, W / 2 - 20.15, sx + sg * 16.5, W / 2 + 20.15)
        _rect(fig, sx, W / 2 - 9.16, sx + sg * 5.5, W / 2 + 9.16)
    fig.update_xaxes(range=[-3, L + 3], visible=False, constrain="domain")
    fig.update_yaxes(range=[W + 3, -3], visible=False, scaleanchor="x", scaleratio=1)
    fig.update_layout(height=height, margin=dict(l=0, r=0, t=0, b=0), showlegend=True,
                      plot_bgcolor="rgba(0,0,0,0)")
    return fig
