# Protocolo de Medição — Camada de Fundo em Rede e Vidro Fosco

> **Status do protocolo**: Estrutura pronta para coleta real no navegador (**coleta experimental pendente** — nenhum número sintético ou estimado é permitido neste documento).

---

## 1. Objetivo e Hipótese
- **Hipótese nula ($H_0$)**: A camada visual de fundo (`.bg-layer`) e o desfoque dos contêineres de nível 1 (`.glass` com `backdrop-filter: blur(14px)`) não alteram significativamente as métricas de vazão (Download/Upload) nem inflam a latência ociosa, o jitter ou a latência sob carga (bufferbloat).
- **Condições experimentais**:
  - **Condição A (Base sem fundo/vidro)**: Fundo desligado (`.bg-layer` oculta) e contêineres de nível 1 opacos (`--surface-1`, sem `backdrop-filter`).
  - **Condição B (Fundo animado contínuo + vidro)**: `.bg-layer` com deriva `bg-drift 90s` ativa mesmo durante a medição + contêineres `.glass`.
  - **Condição C (Padrão do App — Pausa automática na medição)**: `.bg-layer` + `.glass`, com pausa automática da animação durante a medição (`body.is-measuring .bg-layer { animation-play-state: paused; }`) e quando a aba está oculta (`body.is-page-hidden .bg-layer`).
- **Critério de aceite**: A diferença entre as medianas (`P50`) de **B** (ou **C**) e **A** deve permanecer dentro da amplitude natural ($\Delta_A = \text{Máx}_A - \text{Mín}_A$) observada nas rodadas da linha de base **A**.

---

## 2. Metadados do Ambiente de Coleta (Preencher na Execução)

| Parâmetro | Registro Real |
| :--- | :--- |
| **Aparelho / CPU / GPU** | — |
| **Sistema Operacional** | — |
| **Navegador e Versão** | — |
| **Tipo de Rede / Banda / Plano** | — |
| **Perfil de Medição TestAi** | — (`standard` recomendado) |
| **Servidor / PoP Cloudflare** | — |
| **Data e Horário da Coleta** | — |

---

## 3. Comandos de 1 Linha no Console (DevTools) para Alternar Condições A, B e C

Para executar as rodadas intercaladas (`A, B, C, A, B, C...`) na mesma aba sem recarregar a página e sem editar arquivos:

- **Ativar Condição A (Desliga `.bg-layer` e `backdrop-filter` de `.glass`):**
  ```js
  document.querySelector('.bg-layer').style.display = 'none'; document.querySelectorAll('.glass').forEach(el => { el.style.backdropFilter = 'none'; el.style.webkitBackdropFilter = 'none'; el.style.background = 'var(--surface-1)'; });
  ```
- **Ativar Condição B (Liga `.bg-layer` + `.glass` e força animação contínua mesmo durante `is-measuring`):**
  ```js
  document.querySelector('.bg-layer').style.display = ''; document.querySelector('.bg-layer').style.animationPlayState = 'running'; document.querySelectorAll('.glass').forEach(el => { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; el.style.background = ''; });
  ```
- **Ativar Condição C (Padrão do App — `.bg-layer` + `.glass` com pausa automática via `body.is-measuring`):**
  ```js
  document.querySelector('.bg-layer').style.display = ''; document.querySelector('.bg-layer').style.animationPlayState = ''; document.querySelectorAll('.glass').forEach(el => { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; el.style.background = ''; });
  ```

---

## 4. Tabela de Coleta — 10 Trincas Intercaladas (30 Rodadas: A, B, C)

| Rodada | Trinca | Condição | Download (Mbps) | Upload (Mbps) | Ping ocioso (ms) | Jitter (ms) | Lat. sob download (ms) | Lat. sob upload (ms) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | 1 | A | — | — | — | — | — | — |
| 2 | 1 | B | — | — | — | — | — | — |
| 3 | 1 | C | — | — | — | — | — | — |
| 4 | 2 | A | — | — | — | — | — | — |
| 5 | 2 | B | — | — | — | — | — | — |
| 6 | 2 | C | — | — | — | — | — | — |
| 7 | 3 | A | — | — | — | — | — | — |
| 8 | 3 | B | — | — | — | — | — | — |
| 9 | 3 | C | — | — | — | — | — | — |
| 10 | 4 | A | — | — | — | — | — | — |
| 11 | 4 | B | — | — | — | — | — | — |
| 12 | 4 | C | — | — | — | — | — | — |
| 13 | 5 | A | — | — | — | — | — | — |
| 14 | 5 | B | — | — | — | — | — | — |
| 15 | 5 | C | — | — | — | — | — | — |
| 16 | 6 | A | — | — | — | — | — | — |
| 17 | 6 | B | — | — | — | — | — | — |
| 18 | 6 | C | — | — | — | — | — | — |
| 19 | 7 | A | — | — | — | — | — | — |
| 20 | 7 | B | — | — | — | — | — | — |
| 21 | 7 | C | — | — | — | — | — | — |
| 22 | 8 | A | — | — | — | — | — | — |
| 23 | 8 | B | — | — | — | — | — | — |
| 24 | 8 | C | — | — | — | — | — | — |
| 25 | 9 | A | — | — | — | — | — | — |
| 26 | 9 | B | — | — | — | — | — | — |
| 27 | 9 | C | — | — | — | — | — | — |
| 28 | 10 | A | — | — | — | — | — | — |
| 29 | 10 | B | — | — | — | — | — | — |
| 30 | 10 | C | — | — | — | — | — | — |

---

## 5. Quadro Resumo Comparativo (Mediana `P50` e Amplitude `Δ = Máx - Mín`)

| Métrica | Condição A (`P50` / `Δ_A`) | Condição B (`P50` / `Δ_B`) | Condição C (`P50` / `Δ_C`) | Diferença `\|P50_C - P50_A\|` | Dentro de `Δ_A`? |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Download (Mbps)** | — | — | — | — | — |
| **Upload (Mbps)** | — | — | — | — | — |
| **Ping ocioso (ms)** | — | — | — | — | — |
| **Jitter ocioso (ms)** | — | — | — | — | — |
| **Latência sob download (ms)** | — | — | — | — | — |
| **Latência sob upload (ms)** | — | — | — | — | — |
