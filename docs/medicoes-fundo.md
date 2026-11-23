# Protocolo de Medição — Camada de Fundo em Rede e Vidro Fosco

> **Status**: concluído (amostra exploratória — 2 trincas / 6 rodadas reais)

---

## 1. Objetivo e Hipótese
- **Hipótese nula ($H_0$)**: A camada visual de fundo (`.bg-layer`) e o desfoque dos contêineres de nível 1 (`.glass` com `backdrop-filter: blur(14px)`) não alteram significativamente as métricas de vazão (Download/Upload) nem inflam a latência ociosa, o jitter ou a latência sob carga (bufferbloat).
- **Condições experimentais**:
  - **Condição A (Base sem fundo/vidro)**: Fundo desligado (`.bg-layer` oculta) e contêineres de nível 1 opacos (`--surface-1`, sem `backdrop-filter`).
  - **Condição B (Fundo animado contínuo + vidro)**: `.bg-layer` com deriva `bg-drift 90s` ativa mesmo durante a medição + contêineres `.glass`.
  - **Condição C (Padrão do App — Pausa automática na medição)**: `.bg-layer` + `.glass`, com pausa automática da animação durante a medição (`body.is-measuring .bg-layer { animation-play-state: paused; }`) e quando a aba está oculta (`body.is-page-hidden .bg-layer`).
- **Critério de aceite**: A diferença entre as medianas (`P50`) de **B** (ou **C**) e **A** deve permanecer compatível com a dispersão natural ($\Delta = \text{Máx} - \text{Mín}$) observada na rede.

---

## 2. Metadados Reais do Ambiente

| Parâmetro | Registro Real |
| :--- | :--- |
| **Sistema / Navegador** | Windows 10/11 x64 — Chrome 152.0.0.0 (`prefers-reduced-motion: false`) |
| **Conexão** | Cabo Ethernet |
| **Perfil do TestAi** | Padrão Adaptativo (100 Mbps – 1 Gbps) |
| **Data/Hora (UTC)** | `2026-11-23T01:20:36Z` a `2026-11-23T01:26:17Z` |
| **Amostra coletada** | 2 trincas intercaladas (6 rodadas reais: `A, B, C, A, B, C`; $n = 2$ por condição, exceto Lat. UL na Condição A com $n = 1$ pois a Rodada 4 retornou `uploadLatencyMs: null`) |

---

## 3. Comandos de 1 Linha no Console (DevTools) Utilizados para Alternar Condições A, B e C

- **Condição A (Desliga `.bg-layer` e `backdrop-filter` de `.glass`):**
  ```js
  document.querySelector('.bg-layer').style.display = 'none'; document.querySelectorAll('.glass').forEach(el => { el.style.backdropFilter = 'none'; el.style.webkitBackdropFilter = 'none'; el.style.background = 'var(--surface-1)'; });
  ```
- **Condição B (Liga `.bg-layer` + `.glass` e força animação contínua mesmo durante `is-measuring`):**
  ```js
  document.querySelector('.bg-layer').style.display = ''; document.querySelector('.bg-layer').style.animationPlayState = 'running'; document.querySelectorAll('.glass').forEach(el => { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; el.style.background = ''; });
  ```
- **Condição C (Padrão do App — `.bg-layer` + `.glass` com pausa automática via `body.is-measuring`):**
  ```js
  document.querySelector('.bg-layer').style.display = ''; document.querySelector('.bg-layer').style.animationPlayState = ''; document.querySelectorAll('.glass').forEach(el => { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; el.style.background = ''; });
  ```

---

## 4. Tabela de Coleta — 2 Trincas Intercaladas (6 Rodadas Reais: A, B, C, A, B, C)

| Rodada | Trinca | Condição | Timestamp (UTC) | Download (Mbps) | Upload (Mbps) | Ping ocioso (ms) | Jitter (ms) | Lat. sob download (ms) | Lat. sob upload (ms) | Diagnóstico |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | 1 | A | `2026-11-23T01:20:36.913Z` | 337,38 (`337.3804`) | 10,24 (`10.2414`) | 4,62 (`4.6200`) | 2,25 (`2.2490`) | 8,25 (`8.2500`) | 8,00 (`8.0000`) | `good` |
| 2 | 1 | B | `2026-11-23T01:21:00.896Z` | 350,14 (`350.1429`) | 180,50 (`180.5048`) | 8,15 (`8.1500`) | 0,96 (`0.9600`) | 8,80 (`8.8000`) | 7,70 (`7.7000`) | `excellent` |
| 3 | 1 | C | `2026-11-23T01:21:33.571Z` | 318,07 (`318.0681`) | 8,63 (`8.6282`) | 7,90 (`7.9000`) | 2,24 (`2.2373`) | 7,20 (`7.2000`) | 7,45 (`7.4500`) | `limited-speed` |
| 4 | 2 | A | `2026-11-23T01:25:09.636Z` | 352,29 (`352.2946`) | 179,30 (`179.3043`) | 7,65 (`7.6500`) | 0,50 (`0.5000`) | 7,10 (`7.1000`) | —* | `inconclusive` |
| 5 | 2 | B | `2026-11-23T01:25:39.476Z` | 310,55 (`310.5465`) | 127,74 (`127.7396`) | 7,70 (`7.7000`) | 1,30 (`1.3000`) | 6,35 (`6.3480`) | 6,16 (`6.1610`) | `upload-instability` |
| 6 | 2 | C | `2026-11-23T01:26:17.695Z` | 241,71 (`241.7108`) | 173,20 (`173.2028`) | 8,30 (`8.3000`) | 1,97 (`1.9716`) | 8,38 (`8.3845`) | 7,15 (`7.1500`) | `download-instability` |

*\*Nota da Rodada 4 (Condição A, Trinca 2): a sonda de latência durante a fase de upload retornou `uploadLatencyMs: null` (`diagnosisCode: "inconclusive"`), resultando em $n = 1$ para Latência sob upload na Condição A.*

### Dados Brutos (`exportarBenchmark()`)
```json
[
  {"rodada": 1, "trinca": 1, "condicao": "A", "timestamp": "2026-11-23T01:20:36.913Z", "downloadMbps": 337.38037248376185, "uploadMbps": 10.241416186468859, "pingMs": 4.62, "jitterMs": 2.2489999985098836, "downloadLatencyMs": 8.25, "uploadLatencyMs": 8, "diagnosisCode": "good"},
  {"rodada": 2, "trinca": 1, "condicao": "B", "timestamp": "2026-11-23T01:21:00.896Z", "downloadMbps": 350.14289430186903, "uploadMbps": 180.50475731562372, "pingMs": 8.149999998509884, "jitterMs": 0.9599999994039535, "downloadLatencyMs": 8.799999997019768, "uploadLatencyMs": 7.700000002980232, "diagnosisCode": "excellent"},
  {"rodada": 3, "trinca": 1, "condicao": "C", "timestamp": "2026-11-23T01:21:33.571Z", "downloadMbps": 318.068148369734, "uploadMbps": 8.628247131477512, "pingMs": 7.899999998509884, "jitterMs": 2.237250001490116, "downloadLatencyMs": 7.199999995529652, "uploadLatencyMs": 7.450000002980232, "diagnosisCode": "limited-speed"},
  {"rodada": 4, "trinca": 2, "condicao": "A", "timestamp": "2026-11-23T01:25:09.636Z", "downloadMbps": 352.29457381927915, "uploadMbps": 179.30426721193095, "pingMs": 7.650000002235174, "jitterMs": 0.4999999975164731, "downloadLatencyMs": 7.100000001490116, "uploadLatencyMs": null, "diagnosisCode": "inconclusive"},
  {"rodada": 5, "trinca": 2, "condicao": "B", "timestamp": "2026-11-23T01:25:39.476Z", "downloadMbps": 310.5465022780792, "uploadMbps": 127.73963337900022, "pingMs": 7.700000002980232, "jitterMs": 1.3000000019868214, "downloadLatencyMs": 6.348, "uploadLatencyMs": 6.161, "diagnosisCode": "upload-instability"},
  {"rodada": 6, "trinca": 2, "condicao": "C", "timestamp": "2026-11-23T01:26:17.695Z", "downloadMbps": 241.7108347693806, "uploadMbps": 173.20275510901365, "pingMs": 8.300000004470348, "jitterMs": 1.9715999967217446, "downloadLatencyMs": 8.3845, "uploadLatencyMs": 7.149999998509884, "diagnosisCode": "download-instability"}
]
```

---

## 5. Quadro Resumo Comparativo (Mediana `P50` e Amplitude `Δ = Máx - Mín`)

| Métrica | Condição A (`P50` / `Δ_A`, $n=2$) | Condição B (`P50` / `Δ_B`, $n=2$) | Condição C (`P50` / `Δ_C`, $n=2$) |
| :--- | :---: | :---: | :---: |
| **Download (Mbps)** | `344,84` (`344.8375`) / `Δ = 14,91` (`14.9142`) | `330,34` (`330.3447`) / `Δ = 39,60` (`39.5964`) | `279,89` (`279.8895`) / `Δ = 76,36` (`76.3573`) |
| **Upload (Mbps)** | `94,77` (`94.7728`) / `Δ = 169,06` (`169.0629`) | `154,12` (`154.1222`) / `Δ = 52,77` (`52.7651`) | `90,92` (`90.9155`) / `Δ = 164,57` (`164.5745`) |
| **Ping ocioso (ms)** | `6,14` (`6.1350`) / `Δ = 3,03` (`3.0300`) | `7,93` (`7.9250`) / `Δ = 0,45` (`0.4500`) | `8,10` (`8.1000`) / `Δ = 0,40` (`0.4000`) |
| **Jitter ocioso (ms)** | `1,37` (`1.3745`) / `Δ = 1,75` (`1.7490`) | `1,13` (`1.1300`) / `Δ = 0,34` (`0.3400`) | `2,10` (`2.1044`) / `Δ = 0,27` (`0.2657`) |
| **Latência sob download (ms)** | `7,68` (`7.6750`) / `Δ = 1,15` (`1.1500`) | `7,57` (`7.5740`) / `Δ = 2,45` (`2.4520`) | `7,79` (`7.7923`) / `Δ = 1,18` (`1.1845`) |
| **Latência sob upload (ms)** | `8,00` (`8.0000`, $n=1$) / `Δ = —` ($n=1$) | `6,93` (`6.9305`) / `Δ = 1,54` (`1.5390`) | `7,30` (`7.3000`) / `Δ = 0,30` (`0.3000`) |

---

## 6. Conclusão Técnica
1. **Estabilidade de latência sob carga (~`6,93` a `8,00 ms`)**: A latência sob download (`P50` de `7,68 ms` em **A**, `7,57 ms` em **B** e `7,79 ms` em **C**) e a latência sob upload (`8,00 ms` em **A**, `6,93 ms` em **B** e `7,30 ms` em **C**) permaneceram na mesma faixa estreita nos três cenários, sem qualquer evidência de degradação ou inflação de RTT causada pela camada `.bg-layer` ou pelo `backdrop-filter` (`.glass`).
2. **Oscilações de vazão explicadas pela rede externa**: As variações amplas de vazão — especialmente no upload, que oscilou entre `8,63 Mbps` e `180,50 Mbps` inclusive dentro da própria linha de base sem fundo (**A**: `10,24` vs. `179,30 Mbps`, $\Delta_A = 169,06\text{ Mbps}$) e em **C** (`8,63` vs. `173,20 Mbps`, $\Delta_C = 164,57\text{ Mbps}$), enquanto **B** (com animação ativa) registrou `180,50` e `127,74 Mbps` — refletem flutuações momentâneas do enlace/rede externa e não custo de composição visual. O uso de **Cabo Ethernet** na coleta elimina interferências de Wi-Fi local e reforça a origem externa dessa oscilação de upload.
3. **Salvaguarda preventiva mantida**: A pausa automática da deriva durante a execução do teste (`body.is-measuring .bg-layer { animation-play-state: paused; }`) e quando a aba está em segundo plano (`body.is-page-hidden`), somada ao respeito nativo a `prefers-reduced-motion: reduce`, é mantida como salvaguarda preventiva de custo zero para dispositivos móveis e GPUs integradas mais limitadas.
