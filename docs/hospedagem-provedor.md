# Guia Oficial de Hospedagem Self-Hosted para Provedores (ISPs / NOC)

Este guia descreve como implantar o **TestAi** dentro da rede do provedor (**On-Net**) em poucos minutos, com identidade visual **white-label**, servidor de medição **100% em memória RAM** e compatibilidade com planos de alta velocidade, NAT Boost / Burst e diagnóstico técnico completo.

---

## 1. Visão Geral e Arquitetura

A implantação self-hosted utiliza dois contêineres leves gerados a partir de um único [`Dockerfile`](../Dockerfile) *multi-stage*:

1. **`web` (`nginx:1.27-alpine`):**
   - Serve a interface estática compilada em `/usr/share/nginx/html`.
   - No boot, [`deploy/entrypoint.sh`](../deploy/entrypoint.sh) gera dinamicamente `/config.json` a partir das variáveis de ambiente do `.env` (sem rebuild da imagem ao trocar marca ou modo).
   - Faz proxy reverso de `/api/` para o contêiner `api` com `gzip off` e buffering desativado.
2. **`api` (`node:22-alpine` — [`server/index.js`](../server/index.js)):**
   - Micro-servidor HTTP nativo em Node.js com **zero dependências de runtime**, **zero banco de dados** e **zero escrita em disco**.
   - Mantém apenas **1 MiB pré-alocado em RAM** com bytes aleatórios (`crypto.randomBytes`) para download contínuo em streaming e descarta imediatamente os chunks recebidos no upload (`/api/up`).
3. **Licenciamento comercial e white-label:**
   - Distribuído sob **Licença MIT** ([`LICENSE`](../LICENSE)), liberado para uso comercial em provedores e customização de `ISP_NAME` e `SERVER_LABEL`.

---

## 2. Requisitos de Infraestrutura e Topologia

| Recurso | Recomendação Mínima (até ~800 Mbps) | Recomendação Produção Gigabit / Multi-Gigabit |
| :--- | :--- | :--- |
| **CPU** | 2 vCPUs | 4+ vCPUs (x86_64 ou ARM64) |
| **Memória RAM** | 2 GB RAM | 2–4 GB RAM |
| **Disco** | ~1 GB livre (imagem Docker + SO; zero I/O em medições) | ~1–2 GB livres |
| **Placa de Rede (NIC)** | **1 Gbps** dedicada | **10 Gbps** (recomendada para links Gigabit e testes simultâneos) |

### Boas Práticas de Topologia (NOC)
- **Posicionamento On-Net:** instale a VM o mais próximo possível do **BNG / PPPoE / IPoE concentrador** ou da borda de saída do assinante para isolar gargalos da rede de acesso/Wi-Fi sem interferência de rotas externas.
- **Dual-Stack (IPv4 + IPv6):** publique registros DNS **`A` (IPv4)** e **`AAAA` (IPv6)** apontando para o servidor (ex.: `velocidade.seuprovedor.com.br`).
- **HTTPS Obrigatório:** navegadores modernos exigem contexto seguro (TLS) para recursos avançados e consistência de políticas CSP/HSTS; termine TLS na borda com Let's Encrypt / proxy reverso (veja a Seção 5).

---

## 3. Instalação Rápida (3 Comandos)

```bash
git clone https://github.com/JohnKa1/testai-speedtest.git && cd testai-speedtest
cp .env.example .env
docker compose up -d --build
```

Antes do terceiro comando, ajuste o `.env` com a identidade do provedor:

```dotenv
TESTAI_PORT=8080
ISP_NAME=FibraPro Telecom
SERVER_LABEL=BNG Centro 01
MEASUREMENT_MODE=commercial
PARALLEL_DOWNLOAD_STREAMS=6
PARALLEL_UPLOAD_STREAMS=4
ALLOWED_ORIGIN=*
MAX_DOWNLOAD_BYTES=104857600
```

> **Sem cache de configuração:** `/config.json` é servido com `Cache-Control: no-store`. Para alterar `ISP_NAME`, `SERVER_LABEL`, `MEASUREMENT_MODE` ou streams após editar o `.env`, basta reiniciar os contêineres com `docker compose up -d`.

---

## 4. Modo Comercial (`NAT Boost / Burst`) vs. Modo Sustentado

O TestAi suporta dois modos configuráveis via `MEASUREMENT_MODE` em tempo de execução:

| Modo | Valor principal no velocímetro | Streams e janela inicial | Transparência no Modo Avançado / NOC |
| :--- | :--- | :--- | :--- |
| **`commercial`** *(padrão no Docker)* | **P90** (percentil 90) das amostras de vazão | Usa `PARALLEL_DOWNLOAD_STREAMS` e `PARALLEL_UPLOAD_STREAMS` (`1..8`), sem descartar a janela inicial de *burst* | Preserva e exibe integralmente **Download/Upload Sustentado (P50)**, **Pico**, **Ping Ocioso**, **Jitter** e **Latência sob Carga ($\Delta$)** |
| **`sustained`** *(padrão Vercel)* | **Média sustentada** de regime permanente | Concorrência do perfil escolhido e descarte de *ramp-up* inicial (`1000 ms`) | Exibe distribuição completa `Mín / P50 / Média` e telemetria sem modificação |

- Use **`commercial`** quando o provedor emprega *burst* inicial (NAT Boost / perfil PPPoE dinâmico) e deseja que o placar principal para o cliente final reflita a mesma metodologia competitiva de ferramentas como Fast.com e Speedtest, sem esconder a estabilidade real da conexão para a equipe de NOC.

---

## 5. Regras Críticas de Proxy Reverso (HTTPS Externo)

Caso exista um proxy reverso externo (Nginx, Traefik, HAProxy ou Caddy) fazendo terminação **HTTPS (Let's Encrypt)** na frente do contêiner `web` (`127.0.0.1:8080`), **desative compressão e buffering nas rotas `/api/`** para não achatar picos nem distorcer RTT/vazão:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name velocidade.seuprovedor.com.br;

    # Certificados TLS (ex.: Certbot / Let's Encrypt)
    ssl_certificate     /etc/letsencrypt/live/velocidade.seuprovedor.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/velocidade.seuprovedor.com.br/privkey.pem;

    location = /config.json {
        proxy_pass http://127.0.0.1:8080;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        gzip off;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 128m;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **Por que isso é obrigatório:** se `gzip` estiver ativo em `/api/down`, proxies podem tentar comprimir o fluxo; se `proxy_request_buffering` estiver ligado no `/api/up`, o Nginx absorve o payload em disco/RAM antes de repassar ao Node.js, mascarando a taxa real de upload do assinante.

---

## 6. Tuning Opcional de Rede no Linux (NOC)

Para servidores dedicados acima de **1 Gbps** ou alta concorrência simultânea, habilite **TCP BBR** e amplie os buffers máximos de socket criando `/etc/sysctl.d/99-testai-speedtest.conf`:

```ini
# Agendamento de pacotes e controle de congestionamento TCP BBR
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Buffers TCP para links Gigabit / 10 Gbps com BDP elevado
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
```

Aplique as configurações sem reiniciar a máquina:

```bash
sudo sysctl --system
```

---

## 7. Checklist de Validação Pós-Instalação (`curl`)

Substitua `http://localhost:8080` pelo seu domínio HTTPS de produção quando validar pela borda externa:

1. **Ping / Latência (`204 No Content`, sem cache):**
   ```bash
   curl -i http://localhost:8080/api/ping
   ```
   Confirme `HTTP/1.1 204 No Content` e `Cache-Control: no-store, no-cache, must-revalidate`.

2. **Download em RAM (`Content-Encoding: identity`, tamanho exato, sem `gzip`):**
   ```bash
   curl -sD - -o /dev/null "http://localhost:8080/api/down?bytes=1048576"
   ```
   Confirme `Content-Length: 1048576`, `Content-Type: application/octet-stream`, `Content-Encoding: identity` e ausência de `Content-Encoding: gzip`.

3. **Upload Streaming com descarte imediato:**
   ```bash
   dd if=/dev/zero bs=1M count=1 status=none | curl -s -X POST --data-binary @- http://localhost:8080/api/up
   ```
   Resposta esperada: `{"ok":true,"receivedBytes":1048576}`.

4. **Metadados White-Label, IP do cliente e `config.json` dinâmico:**
   ```bash
   curl -s http://localhost:8080/api/meta
   curl -s http://localhost:8080/config.json
   ```
   Confirme `ispName`, `serverLabel`, `clientIp` no `/api/meta` e `measurementMode` / `endpoints` coerentes em `/config.json`.
