import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase, ref, onValue, update, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const DEVICE = "esp32_01", OFFLINE_MS = 25000, ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`);
const AJUSTES = [
  ["auto_minimo", "Começar abaixo de", 5, 95, 35, (v) => `${v}%`],
  ["auto_alvo", "Parar ao atingir", 10, 100, 60, (v) => `${v}%`],
  ["auto_duracao_s", "Tempo máximo por ciclo", 5, 120, 20, (v) => `${v} s`],
  ["auto_intervalo_min", "Intervalo entre ciclos", 5, 240, 30, dur],
  ["auto_max_dia", "Máximo de ciclos por dia", 1, 12, 6, (v) => `${v}`]
];
const FMT = { manual_duracao_s: (v) => `${v} s`, ...Object.fromEntries(AJUSTES.map((a) => [a[0], a[5]])) };
const DEF = { manual_duracao_s: 10, ...Object.fromEntries(AJUSTES.map((a) => [a[0], a[4]])) };
const PERFIS = [["Suculenta", 20, 40], ["Samambaia", 60, 80], ["Horta", 45, 65], ["Orquídea", 50, 70], ["Jardim", 35, 55]];
const RAPIDOS = [5, 10, 20, 30, 60];
const ORIGEM = { app: "Pelo app", automatico: "Automática", agenda: "Agenda", serial: "Manual" };

$("ajustes").innerHTML = AJUSTES.map(([k, rot, mn, mx, d]) => `<div class="field"><label for="${k}">${rot} <b id="${k}_v"></b></label><input type="range" id="${k}" min="${mn}" max="${mx}" value="${d}"></div>`).join("");
$("chips").innerHTML = PERFIS.map(([n, a, b]) => `<button type="button" class="chip" data-a="${a}" data-b="${b}">${n} <small>${a}-${b}%</small></button>`).join("");
$("rapidos").innerHTML = RAPIDOS.map((v) => `<button type="button" class="chip" data-v="${v}">${v} s</button>`).join("");

const el = Object.fromEntries(["status", "read", "fill", "mark", "solo", "idade", "estado", "previsao", "temp", "bomba", "ultima", "hoje", "auto", "chips", "rapidos",
  "autoEstado", "ini", "fim", "regra", "regar", "parar", "mais", "notif", "toast", "log", "chart", "chartMsg", "faixa", "resumo", "checks", "vazao", "serie", "janela"].map((i) => [i, $(i)]));
const dock = document.querySelector(".dock");

const app = initializeApp(firebaseConfig), db = getDatabase(app), auth = getAuth(app);
const node = (p) => ref(db, `dispositivos/${DEVICE}/${p}`);
const st = { sensores: {}, bomba: {}, config: {}, status: {}, hist: [], eventos: [] };
const ui = { serie: "u", janela: 3 };
let fbOnline = false, offset = 0, lastAlert = 0, lastBomba = null, dragging = false, unsubs = [], pend = {};
const now = () => Date.now() + offset, cv = (k) => st.config[k] ?? DEF[k];

const put = (e, h) => { if (e._h !== h) { e._h = h; e.innerHTML = h; } };
const say = (m) => { el.toast.textContent = m; clearTimeout(say.t); say.t = setTimeout(() => (el.toast.textContent = ""), 3500); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const send = (p, data) => update(node(p), data).catch(() => say("Falha ao enviar. Verifique a conexão."));
const flush = debounce(() => { send("config", pend); pend = {}; }, 400);
const ago = (ms) => { const m = Math.floor(ms / 60000); return m < 1 ? "agora" : m < 1440 ? `há ${dur(m)}` : `há ${Math.floor(m / 1440)} d`; };
const fmt = (ts) => new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const lista = (x) => Object.values(x.val() || {}).filter((v) => v && Number.isFinite(v.ts)).sort((a, b) => a.ts - b.ts);

async function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker?.getRegistration();
  reg ? reg.showNotification(title, { body, icon: "icon.svg", tag: "irrigacao" }) : new Notification(title, { body });
}

function tendencia(u, limite) {
  const p = st.hist.filter((x) => Number.isFinite(x.u)).slice(-15);
  if (p.length < 4) return "";
  const xs = p.map((x) => (x.ts - p[0].ts) / 60000), ys = p.map((x) => x.u), n = p.length;
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n, den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (!den) return "";
  const m = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den, h = Math.abs(m * 60).toFixed(1).replace(".", ",");
  if (m > 0.03) return `Umidade subindo, ${h} %/h`;
  if (m > -0.02) return "Umidade estável";
  if (u <= limite) return `Secando ${h} %/h`;
  return `Nível mínimo em cerca de ${dur(Math.round((u - limite) / -m))}, secando ${h} %/h`;
}

function chart() {
  const key = ui.serie, desde = now() - ui.janela * 3600000;
  const pts = st.hist.filter((p) => Number.isFinite(p[key]) && p.ts >= desde), ok = pts.length >= 2;
  el.chartMsg.hidden = ok;
  if (!ok) { put(el.chart, ""); el.faixa.textContent = ""; return; }
  const vs = pts.map((p) => p[key]), u = key === "u";
  const lo = u ? 0 : Math.floor(Math.min(...vs)) - 1, hi = u ? 100 : Math.ceil(Math.max(...vs)) + 1;
  const W = 320, H = 120, P = 6, t0 = pts[0].ts, span = Math.max(1, pts.at(-1).ts - t0);
  const x = (p) => (P + ((p.ts - t0) / span) * (W - 2 * P)).toFixed(1);
  const y = (v) => (H - P - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p)} ${y(p[key])}`).join("");
  const hl = (v, c) => `<line class="${c}" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
  const svg = `<g class="gl">${[0.25, 0.5, 0.75].map((f) => hl(lo + (hi - lo) * f, "g")).join("")}</g><path class="ar" d="${line}L${x(pts.at(-1))} ${H - P}L${x(pts[0])} ${H - P}Z"/><path class="ln" d="${line}"/>${u ? hl(cv("auto_minimo"), "lim") : ""}`;
  put(el.chart, svg);
  el.faixa.textContent = `${Math.round(Math.min(...vs))} a ${Math.round(Math.max(...vs))}${u ? "%" : " °C"} no período${u ? ". Linha tracejada: nível mínimo" : ""}`;
}

function rotulos() {
  Object.keys(FMT).forEach((k) => { $(`${k}_v`).textContent = FMT[k](+$(k).value); });
  const v = (k) => +$(k).value;
  el.regra.textContent = `Com a rega automática ligada, o ESP32 liga a bomba quando a umidade ficar abaixo de ${v("auto_minimo")}% e a mantém até ${v("auto_alvo")}%, ou por no máximo ${v("auto_duracao_s")} s. Espera ${dur(v("auto_intervalo_min"))} entre ciclos e faz até ${v("auto_max_dia")} por dia, das ${el.ini.value || "00:00"} às ${el.fim.value || "23:59"}.`;
  [...el.rapidos.children].forEach((b) => b.classList.toggle("on", +b.dataset.v === v("manual_duracao_s")));
  [...el.chips.children].forEach((b) => b.classList.toggle("on", +b.dataset.a === v("auto_minimo") && +b.dataset.b === v("auto_alvo")));
}

function condicoes() {
  const s = st.sensores, t = st.status, u = Number(s.umidade_solo), mn = cv("auto_minimo");
  const ini = st.config.auto_ini ?? "00:00", fim = st.config.auto_fim ?? "23:59";
  const d = new Date(), agora = d.getHours() * 60 + d.getMinutes();
  const m = (h) => { const [a, b] = h.split(":").map(Number); return a * 60 + b; };
  const janela = m(ini) <= m(fim) ? agora >= m(ini) && agora <= m(fim) : agora >= m(ini) || agora <= m(fim);
  const espera = Number(t.auto_espera_s) || 0, ciclos = Number(t.auto_ciclos) || 0, max = cv("auto_max_dia");
  const itens = [
    [el.auto.checked, "Rega automática ligada", el.auto.checked ? "" : "ative o interruptor"],
    [t.sensor_solo_ok !== false, "Sensor de solo com leitura", ""],
    [u < mn, "Umidade abaixo do mínimo", Number.isFinite(u) ? `${Math.round(u)}% agora, mínimo ${mn}%` : ""],
    [janela, "Dentro da janela de horário", `${ini} às ${fim}`],
    [espera === 0, "Intervalo entre ciclos cumprido", espera ? `faltam ${dur(Math.ceil(espera / 60))}` : ""],
    [ciclos < max, "Limite diário não atingido", `${ciclos} de ${max} ciclos hoje`]
  ];
  put(el.checks, itens.map(([ok, nome, det]) => `<li data-ok="${ok}"><span>${nome}</span><small>${det}</small></li>`).join(""));
}

function render() {
  const { sensores: s, bomba: b, status: t, eventos: ev } = st;
  const fresh = !!s.ultima_atualizacao && now() - s.ultima_atualizacao < OFFLINE_MS, online = fbOnline && fresh;
  el.status.className = `status ${online ? "on" : "off"}`;
  el.status.lastChild.textContent = !fbOnline ? "Sem internet" : fresh ? "ESP32 online" : "ESP32 offline";

  const limite = cv("auto_minimo"), u = Number(s.umidade_solo), tem = Number(s.temperatura), has = !!s.ultima_atualizacao && Number.isFinite(u);
  el.mark.style.left = `${limite}%`;
  if (has) {
    const baixa = u < limite;
    const restante = b.inicio && b.duracao_s ? Math.max(0, Math.ceil(b.duracao_s - (now() - b.inicio) / 1000)) : "";
    el.solo.textContent = Math.round(u);
    el.fill.style.width = `${Math.min(100, Math.max(0, u))}%`;
    el.read.dataset.nivel = baixa ? "baixo" : u < limite + 15 ? "medio" : "ok";
    el.estado.textContent = b.estado ? `Regando${restante !== "" ? `, ${restante} s restantes` : ""}` : b.comando ? "Comando enviado, aguardando o ESP32"
      : baixa ? "Abaixo do nível mínimo" : u < limite + 15 ? "Próxima do nível mínimo" : u > 85 ? "Solo saturado" : "Umidade adequada";
    el.previsao.textContent = tendencia(u, limite);
    el.idade.textContent = `atualizado há ${Math.max(0, Math.round((now() - s.ultima_atualizacao) / 1000))} s`;
    if (baixa && online && Date.now() - lastAlert > ALERT_COOLDOWN_MS) {
      lastAlert = Date.now();
      notify("Umidade baixa", `Solo em ${Math.round(u)}% (mínimo ${limite}%).` + (el.auto.checked ? " Rega automática ativa." : " Abra o app para regar."));
    }
  }
  el.temp.textContent = has && Number.isFinite(tem) ? `${tem.toFixed(1)} °C` : "--";
  el.bomba.textContent = b.estado ? "Ligada" : "Desligada";
  if (lastBomba === true && b.estado === false) notify("Rega concluída", "A bomba foi desligada.");
  lastBomba = b.estado ?? lastBomba;

  el.ultima.textContent = ev[0] ? ago(now() - ev[0].ts) : "--";
  const hoje = new Date(now()).toDateString();
  const dia = ev.filter((e) => new Date(e.ts).toDateString() === hoje), seg = dia.reduce((a, e) => a + (Number(e.dur) || 0), 0), vz = Number(st.config.vazao_ml_s) || 0;
  el.hoje.textContent = dia.length;
  el.resumo.textContent = dia.length ? `Hoje: ${dia.length} ${dia.length === 1 ? "rega" : "regas"}, ${seg} s${vz ? `, ${Math.round(seg * vz)} ml` : ""}` : "";
  if (document.activeElement !== el.vazao) el.vazao.value = vz || "";
  put(el.log, ev.slice(0, 30).map((e) => `<li><span>${ORIGEM[e.origem] || "Outra"}</span><b>${Number(e.dur) || 0} s</b><time>${fmt(e.ts)}</time></li>`).join("") || '<li class="sub">Nenhuma rega registrada.</li>');

  el.auto.checked = st.config.auto_ativo ?? st.config.modo !== "manual";
  const motivo = t.auto_motivo ? t.auto_motivo[0].toUpperCase() + t.auto_motivo.slice(1) : "Aguardando o ESP32";
  el.autoEstado.textContent = el.auto.checked ? `${motivo}${Number.isFinite(t.auto_ciclos) ? `, ${t.auto_ciclos} de ${cv("auto_max_dia")} ciclos hoje` : ""}` : "Desligada";
  if (document.activeElement !== el.ini) el.ini.value = st.config.auto_ini ?? "00:00";
  if (document.activeElement !== el.fim) el.fim.value = st.config.auto_fim ?? "23:59";
  if (!dragging) Object.keys(DEF).forEach((k) => { $(k).value = cv(k); });
  rotulos();
  condicoes();

  dock.classList.toggle("run", !!b.estado);
  el.regar.hidden = !!b.estado;
  el.parar.hidden = el.mais.hidden = !b.estado;
  el.parar.disabled = !!b.parar;
  el.mais.disabled = Number(b.estender_s) > 0;
  el.regar.disabled = !online || !!b.comando;
  el.regar.textContent = `Regar agora, ${cv("manual_duracao_s")} s`;
  chart();
}

onValue(ref(db, ".info/connected"), (x) => { fbOnline = x.val() === true; render(); });
onValue(ref(db, ".info/serverTimeOffset"), (x) => { offset = x.val() || 0; });

const semAcesso = () => say("Sem permissão para ler o banco. Verifique as regras e o usuário.");
onAuthStateChanged(auth, (user) => {
  unsubs.forEach((f) => f()); unsubs = [];
  Object.assign(st, { sensores: {}, bomba: {}, config: {}, status: {}, hist: [], eventos: [] });
  $("loginView").hidden = !!user; $("appView").hidden = !user;
  if (!user) return;
  const on = (p, fn) => onValue(p, (x) => { fn(x); render(); }, semAcesso);
  unsubs = [
    on(node("sensores"), (x) => { st.sensores = x.val() || {}; }),
    on(node("atuadores/bomba"), (x) => { st.bomba = x.val() || {}; }),
    on(node("config"), (x) => { st.config = x.val() || {}; }),
    on(node("status"), (x) => { st.status = x.val() || {}; }),
    on(query(node("historico"), limitToLast(180)), (x) => { st.hist = lista(x); }),
    on(query(node("eventos"), limitToLast(60)), (x) => { st.eventos = lista(x).reverse(); })
  ];
});

const ERROS = { "auth/invalid-credential": "E-mail ou senha incorretos.", "auth/invalid-email": "E-mail inválido.", "auth/missing-password": "Digite a senha.",
  "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco.", "auth/network-request-failed": "Sem conexão com a internet." };
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("loginMsg"), btn = $("entrar");
  msg.textContent = ""; btn.disabled = true;
  try { await signInWithEmailAndPassword(auth, $("email").value.trim(), $("senha").value); $("senha").value = ""; }
  catch (err) { msg.textContent = ERROS[err.code] || "Não foi possível entrar."; }
  btn.disabled = false;
});
$("sair").addEventListener("click", () => signOut(auth));
setInterval(render, 1000);

const queue = (o) => { Object.assign(pend, o); flush(); };
const liberar = debounce(() => { dragging = false; }, 900);
$("appView").addEventListener("input", (e) => {
  const i = e.target;
  if (i.type !== "range" || !(i.id in DEF)) return;
  dragging = true; liberar();
  const mn = $("auto_minimo"), al = $("auto_alvo"), o = { [i.id]: +i.value };
  if (i.id.startsWith("auto_") && i.id !== "auto_duracao_s" && i.id !== "auto_intervalo_min" && i.id !== "auto_max_dia" && +al.value < +mn.value + 5) { al.value = Math.min(100, +mn.value + 5); o.auto_alvo = +al.value; }
  queue(o); rotulos();
});
el.auto.addEventListener("change", () => send("config", { auto_ativo: el.auto.checked }));
el.chips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) { dragging = false; send("config", { auto_minimo: +b.dataset.a, auto_alvo: +b.dataset.b }); } });
el.rapidos.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) { dragging = false; send("config", { manual_duracao_s: +b.dataset.v }); } });
[el.ini, el.fim].forEach((i) => i.addEventListener("change", () => send("config", { auto_ini: el.ini.value || "00:00", auto_fim: el.fim.value || "23:59" })));
el.regar.addEventListener("click", () => { el.regar.disabled = true; send("atuadores/bomba", { comando: true, comando_duracao_s: cv("manual_duracao_s") }); });
el.parar.addEventListener("click", () => { el.parar.disabled = true; send("atuadores/bomba", { parar: true, comando: false }); });
el.mais.addEventListener("click", () => { el.mais.disabled = true; send("atuadores/bomba", { estender_s: 10 }); });

el.serie.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; ui.serie = b.dataset.s; [...el.serie.children].forEach((x) => x.classList.toggle("on", x === b)); chart(); });
el.janela.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; ui.janela = +b.dataset.h; [...el.janela.children].forEach((x) => x.classList.toggle("on", x === b)); chart(); });
el.vazao.addEventListener("change", () => send("config", { vazao_ml_s: Math.max(0, +el.vazao.value || 0) }));

const ABAS = ["painel", "ajustes", "registro"];
function aba(n) {
  if (!ABAS.includes(n)) n = "painel";
  document.querySelectorAll("[data-tab]").forEach((x) => { x.hidden = x.dataset.tab !== n; });
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === n));
  history.replaceState(null, "", `#${n}`);
  scrollTo(0, 0);
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) aba(b.dataset.t); });
aba(location.hash.slice(1));

const syncNotifBtn = () => { el.notif.hidden = !("Notification" in window) || Notification.permission !== "default"; };
el.notif.addEventListener("click", async () => { await Notification.requestPermission(); syncNotifBtn(); });
syncNotifBtn();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
