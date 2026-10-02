// Régua de cobrança automática por WhatsApp (UAZAPI).
// Etapas: 1 dia antes · 1, 3 e 10 dias depois do vencimento. Um cliente recebe no máximo 1 mensagem por dia,
// listando todas as parcelas em aberto. Consulta o Asaas ao vivo: quem pagou não recebe nada.
// Só envia de verdade com REGUA_ATIVA=1; sem isso, só calcula a prévia. Envia de seg. a sáb., das 8h às 20h.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const BASE = 'https://api.asaas.com/v3', KEY = process.env.ASAAS_API_KEY, ENC = process.env.ASAAS_ENC_KEY;
const ATIVA = process.env.REGUA_ATIVA === '1';
const UAZ = (process.env.UAZAPI_URL || 'https://roniautomacoes-pro.uazapi.com').replace(/\/$/, ''), TOK = process.env.UAZAPI_TOKEN;
const DESTINO = 'regua.enc.json', MAX_POR_RODADA = 40;
if (!KEY || !ENC) { console.error('Faltam ASAAS_API_KEY/ASAAS_ENC_KEY'); process.exit(1); }

const key = await crypto.subtle.importKey('raw', Buffer.from(ENC, 'base64'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
async function cifra(obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))); return { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(new Uint8Array(ct)).toString('base64') }; }
async function decifra(p) { const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(p.iv, 'base64') }, key, Buffer.from(p.data, 'base64')); return JSON.parse(new TextDecoder().decode(pt)); }

let estado = { versao: 1, enviados: {}, porDia: {}, historico: [] };
if (existsSync(DESTINO)) { try { Object.assign(estado, await decifra(JSON.parse(readFileSync(DESTINO, 'utf8')))); } catch (e) { console.error('Estado da régua ilegível; abortando para não reenviar.'); process.exit(1); } }

// ── horário de Brasília
const brt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const HOJE = iso(brt), HORA = brt.getHours(), DOW = brt.getDay();
const NO_HORARIO = HORA >= 8 && HORA < 20 && DOW !== 0;
const dias = venc => Math.round((Date.parse(HOJE + 'T00:00:00Z') - Date.parse(venc + 'T00:00:00Z')) / 86400000); // >0 = atrasado

// ── Asaas
async function todos(p) { const out = []; let off = 0; for (let i = 0; i < 60; i++) { const s = p.includes('?') ? '&' : '?'; const r = await fetch(`${BASE}${p}${s}limit=100&offset=${off}`, { headers: { access_token: KEY, 'User-Agent': 'financeiro-lidera' } }); if (!r.ok) throw new Error(`Asaas ${p} ${r.status}`); const d = await r.json(); out.push(...(d.data || [])); if (!d.hasMore) break; off += 100; } return out; }
const [pend, venc, clientes] = await Promise.all([todos('/payments?status=PENDING'), todos('/payments?status=OVERDUE'), todos('/customers')]);
const CLI = {}; clientes.forEach(c => CLI[c.id] = c);
const abertos = pend.concat(venc).filter(p => Number(p.value) > 0);

// ── regras
const ETAPAS = [{ id: 'antes', min: -1, max: 0 }, { id: 'd1', min: 1, max: 2 }, { id: 'd3', min: 3, max: 9 }, { id: 'd10', min: 10, max: 16 }];
const ORDEM = { antes: 0, d1: 1, d3: 2, d10: 3 };
const etapaDe = d => ETAPAS.find(e => d >= e.min && d <= e.max);
function fone(c) { let n = String((c && (c.mobilePhone || c.phone)) || '').replace(/\D/g, ''); if (!n) return null; if (n.length === 10 || n.length === 11) n = '55' + n; return (n.length < 12 || n.length > 13) ? null : n; }
const brl = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ddmm = s => s.slice(8, 10) + '/' + s.slice(5, 7);
function programa(desc) { const d = String(desc || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); if (d.includes('gestao de pessoas') || d.includes('lidera -')) return 'do Programa Lidera'; if (d.includes('consultoria lidera')) return 'da consultoria'; if (d.includes('self') || d.includes('segredos')) return 'do Segredos do Self-Service'; return 'do Lucro e Liberdade'; }
function saud(c) { const doc = String(c.cpfCnpj || '').replace(/\D/g, ''); const p = String(c.name || '').trim().split(/\s+/)[0] || ''; return (doc.length === 11 && p.length >= 3) ? `Oi, ${p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()}!` : 'Oi!'; }
function quando(b) { const d = dias(b.dueDate); if (d === -1) return 'vence amanhã'; if (d === 0) return 'vence hoje'; if (d === 1) return 'venceu ontem'; if (d < 0) return `vence dia ${ddmm(b.dueDate)}`; return `venceu dia ${ddmm(b.dueDate)}`; }
const link = b => b.invoiceUrl || b.bankSlipUrl || '';
// Cada mensagem sai em 4 blocos curtos, enviados em sequência, como alguém digitando.
function montar(etapa, c, bs) {
  const um = bs.length === 1, b = bs[0], tot = bs.reduce((a, x) => a + Number(x.value), 0), prog = programa(b.description), s = saud(c);
  const item = um ? `a parcela de R$ ${brl(b.value)} ${prog}` : `${bs.length} parcelas ${prog}, somando R$ ${brl(tot)}`;
  const itemDe = um ? `da parcela de R$ ${brl(b.value)} ${prog}` : `das ${bs.length} parcelas ${prog}, que somam R$ ${brl(tot)}`;
  const links = um ? link(b) : bs.map(x => `• R$ ${brl(x.value)}, ${quando(x)}` + (link(x) ? `\n${link(x)}` : '')).join('\n\n');
  if (etapa === 'antes') return [
    `${s} Tudo bem?`,
    um ? `Passando pra lembrar que ${item} ${quando(b)}.` : `Passando pra lembrar das ${item}.`,
    `${um ? 'Deixo o link' : 'Deixo os links'} pra facilitar, dá pra pagar no Pix ou no boleto:\n${links}`,
    'Se já tiver pago, pode desconsiderar 🙂'];
  if (etapa === 'd1') return [
    `${s} Tudo bem?`,
    um ? `Vi aqui que ${item} ${quando(b)} e ainda está em aberto.` : `Vi aqui que ficaram em aberto ${item}.`,
    `Na correria pode ter passado batido, então deixo ${um ? 'o link' : 'os links'} aqui:\n${links}`,
    'Se já tiver pago, me avisa que eu dou baixa 🙏'];
  if (etapa === 'd3') return [
    `${s} Tudo certo?`,
    `Ainda não identifiquei o pagamento ${itemDe}${um ? `, que ${quando(b)}` : ''}.`,
    `Se ainda não pagou, ${um ? 'o link é este' : 'os links são estes'}:\n${links}`,
    'Se já saiu, me manda o comprovante que eu dou baixa na hora. Obrigado!'];
  return [
    `${s} Tudo bem por aí?`,
    `Já faz uns dias que ${item} ${um ? 'está' : 'estão'} em aberto, e queria entender se aconteceu alguma coisa.`,
    'Se ficou apertado, me fala que a gente encontra um jeito de resolver junto, sem stress.',
    `Se foi só esquecimento, ${um ? 'o link está aqui' : 'os links estão aqui'}:\n${links}`];
}

// ── quem dispara hoje
const porCli = {};
for (const p of abertos) {
  const e = etapaDe(dias(p.dueDate)); if (!e) continue;
  if (estado.enviados[`${p.id}:${e.id}`]) continue;
  (porCli[p.customer] = porCli[p.customer] || []).push({ p, etapa: e.id });
}
const fila = [];
for (const [cid, gat] of Object.entries(porCli)) {
  const c = CLI[cid] || { name: '?' };
  if (estado.porDia[`${cid}:${HOJE}`]) continue;                       // já falou com ele hoje
  const etapa = gat.map(g => g.etapa).sort((a, b) => ORDEM[b] - ORDEM[a])[0];
  const ids = new Set(gat.map(g => g.p.id));
  const bs = abertos.filter(p => p.customer === cid && (ids.has(p.id) || dias(p.dueDate) >= 1)).sort((a, b) => a.dueDate < b.dueDate ? -1 : 1);
  const tel = fone(c);
  fila.push({ cid, cliente: c.name, tel, etapa, gatilhos: gat.map(g => `${g.p.id}:${g.etapa}`), ids: bs.map(b => b.id), valor: +bs.reduce((a, b) => a + Number(b.value), 0).toFixed(2), blocos: montar(etapa, c, bs), semTelefone: !tel });
}
fila.sort((a, b) => ORDEM[b.etapa] - ORDEM[a.etapa]);
console.log(`Régua: ${fila.length} cliente(s) para hoje · ${ATIVA ? 'ATIVA' : 'modo teste'} · ${NO_HORARIO ? 'dentro do horário' : 'fora do horário (8h–20h, seg–sáb)'}`);

// ── envio
const sleep = ms => new Promise(r => setTimeout(r, ms));
let enviados = 0;
if (ATIVA && NO_HORARIO && TOK) {
  for (const f of fila) {
    if (enviados >= MAX_POR_RODADA || f.semTelefone) continue;
    if (enviados > 0) await sleep((8 + Math.floor(Math.random() * 13)) * 1000);
    const reg = { data: new Date().toISOString(), cid: f.cid, cliente: f.cliente, tel: f.tel, etapa: f.etapa, ids: f.ids, valor: f.valor, auto: true };
    let saiu = 0;
    try {
      for (const bloco of f.blocos) {
        if (saiu) await sleep((3 + Math.floor(Math.random() * 4)) * 1000);   // 3 a 6 s entre blocos
        const r = await fetch(UAZ + '/send/text', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', token: TOK }, body: JSON.stringify({ number: f.tel, text: bloco }) });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 100)}`);
        saiu++;
      }
      estado.historico.unshift(Object.assign(reg, { ok: true, blocos: saiu }));
      console.log(`  ✓ ${f.etapa} · ${f.cliente} · ${saiu} blocos`);
    } catch (e) {
      estado.historico.unshift(Object.assign(reg, { ok: false, blocos: saiu, erro: String(e.message || e).slice(0, 140) }));
      console.log(`  ✗ ${f.etapa} · ${f.cliente} · parou no bloco ${saiu + 1} · ${e.message}`);
    }
    if (saiu) {   // se pelo menos um bloco saiu, não repete esta etapa (evita mensagem duplicada)
      f.gatilhos.forEach(k => estado.enviados[k] = reg.data);
      estado.porDia[`${f.cid}:${HOJE}`] = true; enviados++;
    }
  }
}
// limpeza: porDia só dos últimos 3 dias; histórico até 500
const corte = iso(new Date(brt.getTime() - 3 * 86400000));
for (const k of Object.keys(estado.porDia)) if (k.split(':').pop() < corte) delete estado.porDia[k];
estado.historico = estado.historico.slice(0, 500);
estado.ativa = ATIVA;
estado.etapas = ['1 dia antes', '1 dia depois', '3 dias depois', '10 dias depois'];
estado.previa = fila.filter(f => !estado.porDia[`${f.cid}:${HOJE}`]);
estado.ultimaRodada = new Date().toISOString();

const assinatura = Buffer.from(JSON.stringify([Object.keys(estado.enviados).length, estado.historico.length, estado.ativa, estado.previa.map(f => f.cid + f.etapa + f.valor + f.blocos.join('|'))])).toString('base64').slice(-48);
let antiga = null; try { antiga = JSON.parse(readFileSync(DESTINO, 'utf8')).assinatura; } catch {}
if (antiga === assinatura && !enviados) { console.log('Régua: nada mudou.'); process.exit(0); }
writeFileSync(DESTINO, JSON.stringify({ ...(await cifra(estado)), assinatura, geradoEm: estado.ultimaRodada }));
console.log(`Régua: estado salvo · ${enviados} enviada(s) agora · ${estado.previa.length} na prévia`);
