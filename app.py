"""Vaggo — reserva de vagas de estacionamento (Flask + SQLite).

Contas:
  * motorista -> busca locais no mapa, escolhe vaga, reserva e paga.
  * empresa   -> (terceiro) cadastra e gerencia seus lotes/terrenos.
"""
import html
import os
import random
import re
import secrets
import sqlite3
import time
from datetime import timedelta
from functools import wraps
from pathlib import Path

import segno
from flask import Flask, abort, g, jsonify, request, send_from_directory, session
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

# --------------------------------------------------------------------------
# Configuração
# --------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
INSTANCE = BASE / "instance"
INSTANCE.mkdir(exist_ok=True)
DB_PATH = Path(os.environ.get("VAGGO_DB", INSTANCE / "vaggo.db"))

MAX_VAGAS = 500            # limite inicial de vagas POR LOTE
MAX_HORAS = 12             # máximo de horas por reserva
RESERVA_TTL = 10 * 60      # segundos para pagar antes da reserva cair
TIPOS = ("shopping", "terreno", "estacionamento")
PAPEIS = ("motorista", "empresa")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def chave_secreta():
    """Usa VAGGO_SECRET se existir; senão gera uma vez e guarda em instance/."""
    env = os.environ.get("VAGGO_SECRET")
    if env:
        return env
    arq = INSTANCE / "secret.key"
    if not arq.exists():
        arq.write_text(secrets.token_hex(32))
    return arq.read_text().strip()


app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")
app.config.update(
    SECRET_KEY=chave_secreta(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("VAGGO_HTTPS") == "1",  # ligue em produção (HTTPS)
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    MAX_CONTENT_LENGTH=16 * 1024,
)

CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

# --------------------------------------------------------------------------
# Banco de dados
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios(
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha TEXT NOT NULL,
  papel TEXT NOT NULL CHECK(papel IN ('motorista','empresa'))
);
CREATE TABLE IF NOT EXISTS lotes(
  id INTEGER PRIMARY KEY,
  dono_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL,
  endereco TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  preco REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS vagas(
  lote_id INTEGER NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  num TEXT NOT NULL,
  tipo TEXT NOT NULL,                       -- 'comum' | 'pref' (idoso/PCD)
  status TEXT NOT NULL DEFAULT 'livre',     -- 'livre' | 'ocupada'
  PRIMARY KEY(lote_id, num)
);
CREATE TABLE IF NOT EXISTS reservas(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  lote_id INTEGER NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  vaga TEXT NOT NULL,
  horas INTEGER NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',  -- pendente | paga | concluida | cancelada
  criada REAL NOT NULL,
  expira REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_vagas_lote ON vagas(lote_id);
CREATE INDEX IF NOT EXISTS ix_res_status ON reservas(status, expira);
"""

SEED = [  # nome, tipo, endereço, x%, y%, preço/h, vagas, vagas pref
    ("Shopping Estação", "shopping", "Av. Sete de Setembro, 2775", 38, 58, 8, 36, 4),
    ("Shopping Palladium", "shopping", "Av. Pres. Kennedy, 4121", 72, 42, 10, 36, 4),
    ("Terreno do Seu João", "terreno", "Rua Mateus Leme, 900", 20, 46, 6, 12, 1),
]


def conectar():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def db():
    if "db" not in g:
        g.db = conectar()
    return g.db


@app.teardown_appcontext
def fechar_db(_exc):
    con = g.pop("db", None)
    if con is not None:
        con.close()


def posicao_livre(con):
    """Sorteia um ponto do mapa afastado dos pins existentes (melhor de 25 tentativas)."""
    usados = [(r["x"], r["y"]) for r in con.execute("SELECT x, y FROM lotes")]
    melhor, dist = (50.0, 60.0), -1.0
    for _ in range(25):
        x, y = random.uniform(8, 90), random.uniform(34, 86)  # y>=34 deixa a busca livre
        d = min(((x - a) ** 2 + (y - b) ** 2) ** 0.5 for a, b in usados) if usados else 99
        if d > dist:
            melhor, dist = (round(x, 1), round(y, 1)), d
    return melhor


def criar_lote(con, dono_id, nome, tipo, endereco, x, y, preco, n, pref, ocupacao=0.0):
    cur = con.execute(
        "INSERT INTO lotes(dono_id,nome,tipo,endereco,x,y,preco) VALUES(?,?,?,?,?,?,?)",
        (dono_id, nome, tipo, endereco, x, y, preco))
    lid, larg = cur.lastrowid, max(2, len(str(n)))
    con.executemany(
        "INSERT INTO vagas(lote_id,num,tipo,status) VALUES(?,?,?,?)",
        [(lid, f"{i + 1:0{larg}d}", "pref" if i < pref else "comum",
          "ocupada" if random.random() < ocupacao else "livre") for i in range(n)])
    return lid


def init_db():
    con = conectar()
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    if not con.execute("SELECT 1 FROM lotes LIMIT 1").fetchone():
        for nome, tipo, end, x, y, preco, n, pref in SEED:
            criar_lote(con, None, nome, tipo, end, x, y, preco, n, pref, ocupacao=0.25)
    con.commit()
    con.close()


# --------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------
def erro(msg, code=400):
    return jsonify(erro=msg), code


def corpo():
    """Corpo JSON como dict. Exigir JSON também ajuda contra CSRF por formulário."""
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def texto(d, chave, minimo, maximo):
    v = str(d.get(chave, "")).strip()
    return v if minimo <= len(v) <= maximo else None


def numero(d, chave, lo, hi, inteiro=False):
    try:
        v = float(d.get(chave))
    except (TypeError, ValueError):
        return None
    if not (lo <= v <= hi):  # também rejeita NaN
        return None
    if inteiro:
        return int(v) if v == int(v) else None
    return round(v, 2)


def usuario():
    uid = session.get("uid")
    if not uid:
        return None
    return db().execute("SELECT id, nome, email, papel FROM usuarios WHERE id=?", (uid,)).fetchone()


def publico(u):
    return {k: u[k] for k in ("id", "nome", "email", "papel")}


def exige(papel=None):
    def deco(f):
        @wraps(f)
        def wrapper(*a, **kw):
            u = usuario()
            if not u:
                return erro("Faça login para continuar.", 401)
            if papel and u["papel"] != papel:
                return erro("Você não tem permissão para isso.", 403)
            g.user = u
            return f(*a, **kw)
        return wrapper
    return deco


FALHAS = {}  # (ip, email) -> timestamps das tentativas erradas (limite simples, em memória)
DUMMY_HASH = generate_password_hash("vaggo-dummy")


def bloqueado(chave):
    agora = time.time()
    FALHAS[chave] = [t for t in FALHAS.get(chave, []) if agora - t < 300]
    return len(FALHAS[chave]) >= 5


# --------------------------------------------------------------------------
# Reservas: expiração automática
# --------------------------------------------------------------------------
def encerrar(con, r, novo_status):
    con.execute("UPDATE vagas SET status='livre' WHERE lote_id=? AND num=?", (r["lote_id"], r["vaga"]))
    con.execute("UPDATE reservas SET status=? WHERE id=?", (novo_status, r["id"]))


def limpar():
    """Pendente que passou de 10 min vira 'cancelada'; paga cujo tempo acabou vira 'concluida'.
    Nos dois casos a vaga volta a ficar livre."""
    con, agora = db(), time.time()
    vencidas = con.execute(
        "SELECT id, lote_id, vaga, status FROM reservas "
        "WHERE status IN ('pendente','paga') AND expira < ?", (agora,)).fetchall()
    for r in vencidas:
        encerrar(con, r, "cancelada" if r["status"] == "pendente" else "concluida")
    if vencidas:
        con.commit()


@app.before_request
def antes():
    if request.path.startswith(("/api/", "/pagar/")):
        limpar()


@app.after_request
def cabecalhos(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Content-Security-Policy", CSP)
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(HTTPException)
def http_erro(e):
    if request.path.startswith("/api/"):
        msgs = {404: "Não encontrado.", 405: "Método não permitido.", 413: "Requisição grande demais."}
        return jsonify(erro=msgs.get(e.code, e.name)), e.code
    return e


# --------------------------------------------------------------------------
# Autenticação
# --------------------------------------------------------------------------
def abrir_sessao(uid):
    session.clear()
    session["uid"] = uid
    session.permanent = True
    return jsonify(usuario=publico(usuario()))


@app.post("/api/cadastro")
def cadastro():
    d = corpo()
    nome = texto(d, "nome", 2, 80)
    email = str(d.get("email", "")).strip().lower()
    senha = str(d.get("senha", ""))
    papel = d.get("papel")
    if not nome:
        return erro("Informe o nome (de 2 a 80 caracteres).")
    if len(email) > 120 or not EMAIL.match(email):
        return erro("E-mail inválido.")
    if not 8 <= len(senha) <= 128:
        return erro("A senha precisa ter de 8 a 128 caracteres.")
    if papel not in PAPEIS:
        return erro("Escolha o tipo de conta.")
    try:
        con = db()
        cur = con.execute("INSERT INTO usuarios(nome,email,senha,papel) VALUES(?,?,?,?)",
                          (nome, email, generate_password_hash(senha), papel))
        con.commit()
    except sqlite3.IntegrityError:
        return erro("Este e-mail já está cadastrado.", 409)
    return abrir_sessao(cur.lastrowid)


@app.post("/api/login")
def login():
    d = corpo()
    email = str(d.get("email", "")).strip().lower()
    senha = str(d.get("senha", ""))[:128]
    chave = (request.remote_addr, email)
    if bloqueado(chave):
        return erro("Muitas tentativas. Aguarde alguns minutos.", 429)
    u = db().execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
    # compara sempre um hash, para não revelar (pelo tempo) se o e-mail existe
    ok = check_password_hash(u["senha"] if u else DUMMY_HASH, senha)
    if not (u and ok):
        FALHAS.setdefault(chave, []).append(time.time())
        return erro("E-mail ou senha incorretos.", 401)
    FALHAS.pop(chave, None)
    return abrir_sessao(u["id"])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/eu")
def eu():
    u = usuario()
    return jsonify(usuario=publico(u) if u else None,
                   config=dict(max_vagas=MAX_VAGAS, max_horas=MAX_HORAS, ttl_min=RESERVA_TTL // 60))


# --------------------------------------------------------------------------
# Locais
# --------------------------------------------------------------------------
SQL_LOTES = """
SELECT l.id, l.dono_id, l.nome, l.tipo, l.endereco, l.x, l.y, l.preco,
       COUNT(v.num) AS total,
       COALESCE(SUM(v.status = 'livre'), 0) AS livres,
       COALESCE((SELECT SUM(r.total) FROM reservas r
                 WHERE r.lote_id = l.id AND r.status IN ('paga','concluida')), 0) AS receita
FROM lotes l LEFT JOIN vagas v ON v.lote_id = l.id
"""


def consultar_lotes(where="", args=()):
    rows = db().execute(f"{SQL_LOTES} {where} GROUP BY l.id ORDER BY l.id", args).fetchall()
    return [dict(r) for r in rows]


def sem_dados_internos(l):
    return {k: v for k, v in l.items() if k not in ("dono_id", "receita")}


def meu_lote(i):
    lotes = consultar_lotes("WHERE l.id=? AND l.dono_id=?", (i, g.user["id"]))
    return lotes[0] if lotes else abort(404)


@app.get("/api/locais")
@exige()
def locais():
    q = request.args.get("q", "").lower().strip()[:60]
    return jsonify([sem_dados_internos(l) for l in consultar_lotes()
                    if q in f'{l["nome"]} {l["tipo"]} {l["endereco"]}'.lower()])


@app.get("/api/locais/<int:i>")
@exige()
def local(i):
    lotes = consultar_lotes("WHERE l.id=?", (i,))
    if not lotes:
        abort(404)
    vagas = [dict(r) for r in db().execute(
        "SELECT num AS id, tipo, status FROM vagas WHERE lote_id=? ORDER BY rowid", (i,))]
    return jsonify(sem_dados_internos(lotes[0]) | {"vagas": vagas})


@app.get("/api/meus-locais")
@exige("empresa")
def meus_locais():
    return jsonify([sem_dados_internos(l) | {"receita": l["receita"]}
                    for l in consultar_lotes("WHERE l.dono_id=?", (g.user["id"],))])


@app.post("/api/locais")
@exige("empresa")
def novo_local():
    d = corpo()
    nome = texto(d, "nome", 2, 80)
    endereco = texto(d, "endereco", 5, 160)
    tipo = d.get("tipo")
    preco = numero(d, "preco", 0.5, 500)
    n = numero(d, "vagas", 1, MAX_VAGAS, inteiro=True)
    if not nome:
        return erro("Informe o nome do local (2 a 80 caracteres).")
    if not endereco:
        return erro("Informe o endereço (5 a 160 caracteres).")
    if tipo not in TIPOS:
        return erro("Tipo de local inválido.")
    if n is None:
        return erro(f"A quantidade de vagas deve ser um número de 1 a {MAX_VAGAS}.")
    if preco is None:
        return erro("O preço por hora deve ficar entre R$ 0,50 e R$ 500,00.")
    bruto = d.get("pref")
    pref = 0 if bruto in (None, "") else numero(d, "pref", 0, n, inteiro=True)
    if pref is None:
        return erro("Vagas de idoso/PCD deve ficar entre 0 e o total de vagas.")
    con = db()
    x, y = posicao_livre(con)
    lid = criar_lote(con, g.user["id"], nome, tipo, endereco, x, y, preco, n, pref)
    con.commit()
    return jsonify(id=lid), 201


@app.patch("/api/locais/<int:i>")
@exige("empresa")
def editar_local(i):
    meu_lote(i)
    preco = numero(corpo(), "preco", 0.5, 500)
    if preco is None:
        return erro("O preço por hora deve ficar entre R$ 0,50 e R$ 500,00.")
    db().execute("UPDATE lotes SET preco=? WHERE id=?", (preco, i))
    db().commit()
    return jsonify(preco=preco)


@app.delete("/api/locais/<int:i>")
@exige("empresa")
def excluir_local(i):
    meu_lote(i)
    db().execute("DELETE FROM lotes WHERE id=?", (i,))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/locais/<int:i>/vagas/<num>/alternar")
@exige("empresa")
def alternar_vaga(i, num):
    """A empresa marca manualmente uma vaga como ocupada/livre (ex.: carro chegou sem reserva)."""
    meu_lote(i)
    con = db()
    if con.execute("SELECT 1 FROM reservas WHERE lote_id=? AND vaga=? AND status IN ('pendente','paga')",
                   (i, num)).fetchone():
        return erro("Esta vaga tem uma reserva ativa.", 409)
    cur = con.execute(
        "UPDATE vagas SET status = CASE status WHEN 'livre' THEN 'ocupada' ELSE 'livre' END "
        "WHERE lote_id=? AND num=?", (i, num))
    if cur.rowcount == 0:
        abort(404)
    con.commit()
    novo = con.execute("SELECT status FROM vagas WHERE lote_id=? AND num=?", (i, num)).fetchone()
    return jsonify(status=novo["status"])


# --------------------------------------------------------------------------
# Reservas e pagamento
# --------------------------------------------------------------------------
@app.post("/api/reservas")
@exige("motorista")
def reservar():
    d = corpo()
    lid = numero(d, "local", 1, 10 ** 9, inteiro=True)
    num = str(d.get("vaga", ""))[:10]
    horas = numero(d, "horas", 1, MAX_HORAS, inteiro=True)
    if lid is None or horas is None or not num:
        return erro("Dados da reserva inválidos.")
    con = db()
    lote = con.execute("SELECT preco FROM lotes WHERE id=?", (lid,)).fetchone()
    vaga = con.execute("SELECT tipo FROM vagas WHERE lote_id=? AND num=?", (lid, num)).fetchone()
    if not lote or not vaga:
        return erro("Vaga não encontrada.", 404)
    if vaga["tipo"] == "pref" and d.get("pref") is not True:
        return erro("Esta vaga é para idosos/PCD. Marque a opção na tela de vagas.", 403)

    # cada motorista segura no máximo uma reserva pendente por vez
    for r in con.execute("SELECT id, lote_id, vaga FROM reservas WHERE user_id=? AND status='pendente'",
                         (g.user["id"],)).fetchall():
        encerrar(con, r, "cancelada")

    # UPDATE condicional = operação atômica: só um motorista consegue pegar a vaga
    cur = con.execute("UPDATE vagas SET status='ocupada' WHERE lote_id=? AND num=? AND status='livre'",
                      (lid, num))
    if cur.rowcount == 0:
        con.commit()
        return erro("Vaga ocupada", 409)

    rid, agora = secrets.token_urlsafe(12), time.time()
    total = round(lote["preco"] * horas, 2)
    con.execute("INSERT INTO reservas(id,user_id,lote_id,vaga,horas,total,status,criada,expira) "
                "VALUES(?,?,?,?,?,?,'pendente',?,?)",
                (rid, g.user["id"], lid, num, horas, total, agora, agora + RESERVA_TTL))
    con.commit()
    link = request.host_url + "pagar/" + rid
    qr = segno.make(link).svg_inline(scale=5, dark="#0b1f4b", border=1)
    return jsonify(id=rid, link=link, total=total, restante=RESERVA_TTL, qr=qr), 201


def minha_reserva(rid):
    r = db().execute("SELECT * FROM reservas WHERE id=? AND user_id=?", (rid, g.user["id"])).fetchone()
    return r if r else abort(404)


@app.get("/api/reservas/<rid>")
@exige("motorista")
def status_reserva(rid):
    r = minha_reserva(rid)
    return jsonify(status=r["status"], restante=max(0, int(r["expira"] - time.time())))


@app.delete("/api/reservas/<rid>")
@exige("motorista")
def cancelar_reserva(rid):
    r = minha_reserva(rid)
    if r["status"] == "pendente":  # reserva já paga não pode ser cancelada por aqui
        encerrar(db(), r, "cancelada")
        db().commit()
    return jsonify(ok=True)


PAGAR_CSS = """
*{box-sizing:border-box;margin:0}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:grid;
place-items:center;padding:24px;color:#fff;background:radial-gradient(90% 60% at 10% 0%,#2f6fed55,transparent 60%),
linear-gradient(160deg,#14316f,#081738);text-align:center}
main{width:min(420px,100%);background:#ffffff14;border:1px solid #ffffff22;border-radius:28px;padding:32px 24px;
backdrop-filter:blur(12px)}
img{width:64px;height:64px;border-radius:18px;margin-bottom:12px}
h2{font-size:1.1rem;opacity:.85;font-weight:600}.tot{font-size:2.6rem;font-weight:800;margin:14px 0 4px;letter-spacing:-.02em}
p{opacity:.8}.big{font-size:1.5rem;font-weight:800;margin:10px 0}
button{font:inherit;font-weight:700;width:100%;margin-top:22px;padding:1rem;border:0;border-radius:16px;
background:#fff;color:#0b1f4b;cursor:pointer}
button:hover{background:#eef2fa}
.ok{width:76px;height:76px;margin:6px auto 10px;border-radius:50%;background:#1fa971;display:grid;place-items:center;
font-size:2.2rem}
"""


def pagina_pagamento(vaga, conteudo):
    return (f'<!doctype html><html lang="pt-BR"><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vaggo · Pagamento</title>'
            f'<style>{PAGAR_CSS}</style><body><main><img src="/logo.png" alt="Vaggo">'
            f'<h2>Vaggo · vaga {html.escape(vaga)}</h2>{conteudo}</main></body></html>')


@app.route("/pagar/<rid>", methods=["GET", "POST"])  # tela aberta pelo QR Code / link
def pagar(rid):
    con = db()
    r = con.execute("SELECT * FROM reservas WHERE id=?", (rid,)).fetchone()
    if not r:
        abort(404)
    if request.method == "POST" and r["status"] == "pendente":
        con.execute("UPDATE reservas SET status='paga', expira=? WHERE id=?",
                    (time.time() + r["horas"] * 3600, rid))
        con.commit()
        r = con.execute("SELECT * FROM reservas WHERE id=?", (rid,)).fetchone()
    if r["status"] in ("paga", "concluida"):
        conteudo = '<div class="ok">✓</div><div class="big">Pago!</div><p>Pode voltar ao Vaggo.</p>'
    elif r["status"] == "pendente":
        conteudo = (f'<p>Total</p><div class="tot">R$ {r["total"]:.2f}</div>'
                    f'<form method="post"><button>Pagar com Pix (simulado)</button></form>')
    else:
        conteudo = '<div class="big">Reserva expirada</div><p>Volte ao Vaggo e escolha a vaga novamente.</p>'
    return pagina_pagamento(r["vaga"], conteudo)


# --------------------------------------------------------------------------
# Páginas estáticas
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/logo.png")
def logo():
    """Procura a logo em static/ e, se não estiver lá, ao lado do app.py."""
    for pasta in (STATIC, BASE):
        if (pasta / "logo.png").is_file():
            return send_from_directory(pasta, "logo.png")
    abort(404)


init_db()

if __name__ == "__main__":
    # Para produção use um servidor WSGI (ex.: gunicorn) e VAGGO_DEBUG=0.
    app.run(debug=os.environ.get("VAGGO_DEBUG", "1") == "1",
            host=os.environ.get("VAGGO_HOST", "127.0.0.1"))
