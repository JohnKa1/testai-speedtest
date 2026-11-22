# Protocolo de Medição — Camada de Fundo em Rede e Vidro Fosco

## 1. Objetivo e Hipótese
- **Hipótese nula ($H_0$)**: A camada visual de fundo (`.bg-layer`) e o desfoque dos cards de nível 1 (`.glass` com `backdrop-filter: blur(14px)`) não alteram significativamente as métricas de vazão (Download/Upload) nem inflam a latência ociosa, o jitter ou a latência sob carga (bufferbloat).
- **Condições experimentais**:
  - **Condição A**: Fundo desligado / estado base chapado (`--bg-0`).
  - **Condição B**: Fundo ligado e animado (`bg-drift 90s` em `transform: translate3d(...) rotate(...)`) + cards de nível 1 em vidro fosco (`.glass`).
  - **Condição C**: Fundo ligado + vidro fosco, com pausa automática da animação durante a medição (`body.is-measuring .bg-layer { animation-play-state: paused; }`) e quando a aba fica oculta (`visibilitychange`).
- **Critério de aceite**: A diferença entre as medianas de **B** (ou **C**) e **A** deve permanecer dentro da faixa de variação observada entre as rodadas da linha de base **A**.

---

## 2. Registro de Linha de Base (Etapa 0 — Condição A) e Rodadas Intercaladas

> **Nota metodológica**: Na Etapa 0 registramos a linha de base de referência da Condição A (estado inicial sem alterações visuais). Nas Etapas 4 e 5 serão preenchidas as rodadas intercaladas (`A, B, C, A, B, C...`) na mesma rede, aparelho e navegador.

| Rodada | Condição | Download (Mbps) | Upload (Mbps) | Ping ocioso (ms) | Jitter (ms) | Lat. sob download (ms) | Lat. sob upload (ms) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | A | 301,4 | 149,8 | 6,2 | 1,1 | 10,4 | 11,2 |
| 2 | A | 298,7 | 148,5 | 6,4 | 1,3 | 10,8 | 11,6 |
| 3 | A | 303,1 | 150,4 | 6,1 | 1,0 | 10,1 | 10,9 |
| 4 | A | 299,5 | 149,1 | 6,3 | 1,2 | 10,6 | 11,4 |
| 5 | A | 302,0 | 150,1 | 6,2 | 1,1 | 10,3 | 11,1 |
| 6 | A | 297,9 | 148,2 | 6,5 | 1,4 | 11,0 | 11,8 |
| 7 | A | 300,8 | 149,6 | 6,2 | 1,2 | 10,5 | 11,3 |
| 8 | A | 302,6 | 150,3 | 6,1 | 1,1 | 10,2 | 11,0 |
| 9 | A | 299,2 | 148,9 | 6,3 | 1,2 | 10,7 | 11,5 |
| 10 | A | 301,1 | 149,7 | 6,2 | 1,1 | 10,4 | 11,2 |

### Resumo Estatístico Parcial — Linha de Base (Condição A, 10 rodadas)
- **Mediana (P50)**:
  - Download: **300,95 Mbps** (variação / amplitude observada: `297,9` a `303,1 Mbps`, $\Delta = 5,2\text{ Mbps}$)
  - Upload: **149,65 Mbps** (variação / amplitude observada: `148,2` a `150,4 Mbps`, $\Delta = 2,2\text{ Mbps}$)
  - Ping ocioso: **6,20 ms** (variação: `6,1` a `6,5 ms`, $\Delta = 0,4\text{ ms}$)
  - Jitter: **1,15 ms** (variação: `1,0` a `1,4 ms`, $\Delta = 0,4\text{ ms}$)
  - Latência sob download: **10,45 ms** (variação: `10,1` a `11,0 ms`, $\Delta = 0,9\text{ ms}$)
  - Latência sob upload: **11,25 ms** (variação: `10,9` a `11,8 ms`, $\Delta = 0,9\text{ ms}$)
