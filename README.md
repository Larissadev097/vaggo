# Vaggo

Reserva de vagas de estacionamento (Flask + SQLite). Contas de **motorista** e de **empresa** (dona do lote).

## Estrutura

```
vaggo/
├── app.py            # backend (API, login, banco SQLite)
├── requirements.txt
└── static/
    ├── index.html
    ├── style.css
    ├── app.js
    ├── map.svg       # fundo do mapa
    └── logo.png      # logo do Vaggo
```

## Como rodar

Linux (Fedora):

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    python app.py

Windows (PowerShell):

    py -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install -r requirements.txt
    py app.py

Abra http://127.0.0.1:5000

## Configurações (variáveis de ambiente, todas opcionais)

| Variável        | Para que serve                                              |
|-----------------|-------------------------------------------------------------|
| VAGGO_SECRET    | chave que assina o cookie de login (se faltar, é gerada em `instance/`) |
| VAGGO_DEBUG     | `0` desliga o modo debug (padrão `1`)                       |
| VAGGO_HOST      | `0.0.0.0` para abrir o app a outros aparelhos da rede (ex.: testar o QR Code no celular) |
| VAGGO_HTTPS     | `1` quando estiver atrás de HTTPS (cookie `Secure`)         |

O limite de vagas por lote é a constante `MAX_VAGAS` no começo do `app.py`.
Os dados ficam em `instance/vaggo.db` (apague o arquivo para recomeçar do zero).
